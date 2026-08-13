import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  TransactionBuilder,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';
import { rpc } from '@stellar/stellar-sdk';
import {
  Adapter,
  ProtocolMetadata,
  RiskFactor,
  RiskFactorMap,
  RiskFactorType,
  RiskScoreResult,
} from '@stenion/core';

// ---------------------------------------------------------------------------
// Mainnet wiring
//
// Addresses come from Blend's own deploy config (blend-utils/mainnet.contracts.json),
// cross-checked against docs.blend.capital/mainnet-deployments — not a third-party
// indexer. We target the flagship "Fixed" V2 pool (XLM:USDC) only for v1: it holds
// the most liquidity and is the simplest to reason about. Blend's factory deploys
// one contract per market, so multi-pool aggregation is deliberately deferred.
// ---------------------------------------------------------------------------

const NETWORK_PASSPHRASE = Networks.PUBLIC;

/** Public, key-less Soroban mainnet RPC (Stellar docs "Providers" list). Overridable for self-hosting. */
const DEFAULT_RPC_URL = 'https://mainnet.sorobanrpc.com';

/** Public Horizon — needed for admin-account signer/activity data, which Soroban RPC does not expose. */
const DEFAULT_HORIZON_URL = 'https://horizon.stellar.org';

/** Blend V2 "Fixed" pool (XLM:USDC). */
const FIXED_POOL_V2 = 'CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD';

// Fixed-point scalars from blend-contracts-v2/pool/src/constants.rs.
const SCALAR_7 = 10n ** 7n; // c_factor, l_factor, util, max_util
const SCALAR_12 = 10n ** 12n; // d_rate, b_rate (ReserveV2 rate decimals)

// ---------------------------------------------------------------------------
// Raw on-chain shape (adapter-specific, per the Adapter<TRawData> contract)
// ---------------------------------------------------------------------------

export interface BlendReserveRaw {
  asset: string;
  /** ReserveConfig, 7-decimal fixed point unless noted */
  config: {
    decimals: number;
    cFactor: bigint;
    lFactor: bigint;
    util: bigint;
    maxUtil: bigint;
    enabled: boolean;
  };
  /** ReserveData */
  data: {
    dRate: bigint; // 12-dec: bTokens/dTokens -> underlying
    bRate: bigint;
    bSupply: bigint; // supply shares
    dSupply: bigint; // debt shares
  };
  /** Oracle reading for this asset, or null if the oracle returned no price. */
  price: {
    value: bigint; // fixed point, `oracleDecimals` places
    timestamp: number; // unix seconds
  } | null;
}

export interface BlendAdminRaw {
  /** admin address from the pool's PoolConfig */
  address: string;
  /** true when the admin is a contract (C…) rather than a keypair account (G…) */
  isContract: boolean;
  /** null when admin is a contract (Horizon has no account entry for it) */
  account: {
    highThreshold: number;
    signerCount: number;
    /** operations on the admin account within the activity window */
    recentOps: number;
    activityWindowDays: number;
  } | null;
}

export interface BlendRawData {
  poolId: string;
  oracleId: string;
  oracleDecimals: number;
  /** pool status: 0 active, higher = increasingly frozen (see Blend docs) */
  status: number;
  admin: BlendAdminRaw;
  reserves: BlendReserveRaw[];
  fetchedAt: number; // unix seconds, from chain-adjacent clock
}

// Shapes as they come back from scValToNative on the corresponding #[contracttype]
// structs — u32 fields decode to number, i128/u64 to bigint, Address to string.
interface ReserveConfigNative {
  decimals: number | bigint;
  c_factor: number | bigint;
  l_factor: number | bigint;
  util: number | bigint;
  max_util: number | bigint;
  enabled?: boolean;
}
interface ReserveDataNative {
  d_rate: number | bigint;
  b_rate: number | bigint;
  b_supply: number | bigint;
  d_supply: number | bigint;
}
interface PoolConfigNative {
  oracle: string;
  status: number | bigint;
  admin?: string;
}
interface PriceDataNative {
  price: number | bigint;
  timestamp: number | bigint;
}
interface HorizonAccount {
  thresholds?: { high_threshold?: number };
  signers?: unknown[];
}
interface HorizonOps {
  _embedded?: { records?: { created_at: string }[] };
}

// ---------------------------------------------------------------------------
// RPC helpers
// ---------------------------------------------------------------------------

function persistentContractDataKey(contractId: string, key: xdr.ScVal): xdr.LedgerKey {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(contractId).toScAddress(),
      key,
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
}

/** Read a pool's contract *instance* storage (holds Config, Admin, etc.) into a name->ScVal map. */
async function readInstanceStorage(
  server: rpc.Server,
  contractId: string,
): Promise<Map<string, xdr.ScVal>> {
  const key = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(contractId).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
  const resp = await server.getLedgerEntries(key);
  if (resp.entries.length === 0) {
    throw new Error(`Blend: no instance entry for contract ${contractId}`);
  }
  const instance = resp.entries[0].val.contractData().val().instance();
  const storage = instance.storage() ?? [];
  const out = new Map<string, xdr.ScVal>();
  for (const entry of storage) {
    const name = scValToNative(entry.key());
    if (typeof name === 'string') out.set(name, entry.val());
  }
  return out;
}

/** Read one reserve's ResConfig + ResData persistent entries and normalize field names. */
async function readReserve(
  server: rpc.Server,
  poolId: string,
  asset: string,
): Promise<Omit<BlendReserveRaw, 'price'>> {
  const configKey = persistentContractDataKey(
    poolId,
    xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('ResConfig'), new Address(asset).toScVal()]),
  );
  const dataKey = persistentContractDataKey(
    poolId,
    xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('ResData'), new Address(asset).toScVal()]),
  );

  const resp = await server.getLedgerEntries(configKey, dataKey);
  let config: ReserveConfigNative | undefined;
  let data: ReserveDataNative | undefined;
  for (const entry of resp.entries) {
    const native = scValToNative(entry.val.contractData().val()) as Record<string, unknown>;
    // ResData is the only one carrying b_rate; use it to disambiguate the two entries.
    if ('b_rate' in native) data = native as unknown as ReserveDataNative;
    else if ('c_factor' in native) config = native as unknown as ReserveConfigNative;
  }
  if (!config || !data) {
    throw new Error(`Blend: missing ResConfig/ResData for asset ${asset} in pool ${poolId}`);
  }

  return {
    asset,
    config: {
      decimals: Number(config.decimals),
      cFactor: BigInt(config.c_factor),
      lFactor: BigInt(config.l_factor),
      util: BigInt(config.util),
      maxUtil: BigInt(config.max_util),
      enabled: config.enabled !== false,
    },
    data: {
      dRate: BigInt(data.d_rate),
      bRate: BigInt(data.b_rate),
      bSupply: BigInt(data.b_supply),
      dSupply: BigInt(data.d_supply),
    },
  };
}

/** Simulate a read-only contract call and return the decoded native result. */
async function readContract(
  server: rpc.Server,
  contractId: string,
  method: string,
  ...args: xdr.ScVal[]
): Promise<unknown> {
  // Simulation is side-effect-free and unsigned; a throwaway source account is fine.
  const source = new Account(Keypair.random().publicKey(), '0');
  const tx = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`Blend: simulation of ${method} on ${contractId} failed: ${sim.error}`);
  }
  const retval = sim.result?.retval;
  if (!retval) throw new Error(`Blend: ${method} on ${contractId} returned no value`);
  return scValToNative(retval);
}

/** Oracle asset argument: Asset::Stellar(Address). */
function stellarAssetArg(asset: string): xdr.ScVal {
  return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('Stellar'), new Address(asset).toScVal()]);
}

async function readOraclePrice(
  server: rpc.Server,
  oracleId: string,
  asset: string,
): Promise<BlendReserveRaw['price']> {
  const native = (await readContract(
    server,
    oracleId,
    'lastprice',
    stellarAssetArg(asset),
  )) as PriceDataNative | null;
  // lastprice returns Option<PriceData>; None decodes to null/undefined.
  if (!native || native.price === undefined) return null;
  return {
    value: BigInt(native.price),
    timestamp: Number(native.timestamp),
  };
}

async function fetchAdmin(horizonUrl: string, address: string): Promise<BlendAdminRaw> {
  const isContract = address.startsWith('C');
  if (isContract) {
    // Contract-governed admin: Horizon has no account entry to introspect. We record
    // the fact honestly rather than fabricating signer/activity data for it.
    return { address, isContract: true, account: null };
  }

  const windowDays = 30;
  const acctResp = await fetch(`${horizonUrl}/accounts/${address}`);
  if (!acctResp.ok) {
    throw new Error(
      `Blend: Horizon account fetch for admin ${address} failed (${acctResp.status})`,
    );
  }
  const acct = (await acctResp.json()) as HorizonAccount;

  const opsResp = await fetch(`${horizonUrl}/accounts/${address}/operations?order=desc&limit=200`);
  if (!opsResp.ok) {
    throw new Error(`Blend: Horizon ops fetch for admin ${address} failed (${opsResp.status})`);
  }
  const opsBody = (await opsResp.json()) as HorizonOps;
  const records = opsBody?._embedded?.records ?? [];
  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const recentOps = records.filter((r) => {
    const t = Date.parse(r.created_at);
    return Number.isFinite(t) && t >= cutoff;
  }).length;

  return {
    address,
    isContract: false,
    account: {
      highThreshold: Number(acct.thresholds?.high_threshold ?? 0),
      signerCount: Array.isArray(acct.signers) ? acct.signers.length : 0,
      recentOps,
      activityWindowDays: windowDays,
    },
  };
}

// ---------------------------------------------------------------------------
// Scoring helpers
// ---------------------------------------------------------------------------

const clamp = (n: number, lo = 0, hi = 100): number => Math.max(lo, Math.min(hi, n));

/** Map v from [a,b] linearly onto [0,100], clamped. Descending if a>b. */
function lerp01(v: number, a: number, b: number): number {
  if (a === b) return v >= a ? 100 : 0;
  return clamp(((v - a) / (b - a)) * 100);
}

/** Underlying supplied/borrowed for a reserve, in human units (asset decimals applied). */
function reserveTotals(r: BlendReserveRaw): { supplied: number; borrowed: number } {
  const denom = Number(SCALAR_12) * 10 ** r.config.decimals;
  const supplied = Number(r.data.bSupply * r.data.bRate) / denom;
  const borrowed = Number(r.data.dSupply * r.data.dRate) / denom;
  return { supplied, borrowed };
}

/** USD value of supplied liquidity for a reserve, or null if no price. */
function suppliedUsd(r: BlendReserveRaw, oracleDecimals: number): number | null {
  if (!r.price) return null;
  const { supplied } = reserveTotals(r);
  const priceFloat = Number(r.price.value) / 10 ** oracleDecimals;
  return supplied * priceFloat;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface BlendAdapterOptions {
  rpcUrl?: string;
  horizonUrl?: string;
  poolId?: string;
}

export class BlendAdapter implements Adapter<BlendRawData> {
  readonly metadata: ProtocolMetadata = {
    id: 'blend',
    name: 'Blend',
    chain: 'stellar',
  };

  private readonly rpcUrl: string;
  private readonly horizonUrl: string;
  private readonly poolId: string;

  constructor(opts: BlendAdapterOptions = {}) {
    this.rpcUrl = opts.rpcUrl ?? DEFAULT_RPC_URL;
    this.horizonUrl = opts.horizonUrl ?? DEFAULT_HORIZON_URL;
    this.poolId = opts.poolId ?? FIXED_POOL_V2;
  }

  async fetchRawData(): Promise<BlendRawData> {
    const server = new rpc.Server(this.rpcUrl);

    // Pool instance storage → Config (oracle, status) and Admin.
    const instance = await readInstanceStorage(server, this.poolId);
    const configScv = instance.get('Config');
    const adminScv = instance.get('Admin');
    if (!configScv) throw new Error(`Blend: pool ${this.poolId} has no Config in instance storage`);
    const poolConfig = scValToNative(configScv) as PoolConfigNative;
    const oracleId: string = poolConfig.oracle;
    const status = Number(poolConfig.status);
    const adminAddress: string = adminScv
      ? (scValToNative(adminScv) as string)
      : (poolConfig.admin ?? '');

    // Reserve list is a public read method on the V2 pool.
    const reserveList = (await readContract(server, this.poolId, 'get_reserve_list')) as string[];
    if (!Array.isArray(reserveList) || reserveList.length === 0) {
      throw new Error(`Blend: pool ${this.poolId} returned an empty reserve list`);
    }

    const oracleDecimals = Number(await readContract(server, oracleId, 'decimals'));

    const reserves: BlendReserveRaw[] = [];
    for (const asset of reserveList) {
      const base = await readReserve(server, this.poolId, asset);
      const price = await readOraclePrice(server, oracleId, asset);
      reserves.push({ ...base, price });
    }

    const admin = await fetchAdmin(this.horizonUrl, adminAddress);

    return {
      poolId: this.poolId,
      oracleId,
      oracleDecimals,
      status,
      admin,
      reserves,
      fetchedAt: Math.floor(Date.now() / 1000),
    };
  }

  async computeRiskFactors(raw: BlendRawData): Promise<RiskFactorMap> {
    return {
      [RiskFactorType.CollateralSafety]: this.collateralSafety(raw),
      [RiskFactorType.OracleSafety]: this.oracleSafety(raw),
      [RiskFactorType.AdminKeySafety]: this.adminKeySafety(raw),
      [RiskFactorType.LiquiditySafety]: this.liquiditySafety(raw),
      [RiskFactorType.UtilizationSafety]: this.utilizationSafety(raw),
    };
  }

  // Concentration of supplied value across reserves, via a normalized HHI.
  // Rationale: a pool whose value sits in one asset is far more exposed to a
  // single de-peg/liquidation cascade than a balanced one. HHI = Σ(share²);
  // for n reserves it ranges [1/n, 1]. We map 1/n → 100 (safest, even split)
  // and 1 → 0 (all in one asset). Pure on-chain supplied USD, no assumptions.
  private collateralSafety(raw: BlendRawData): RiskFactor {
    const weight = 0.2;
    const values = raw.reserves
      .map((r) => suppliedUsd(r, raw.oracleDecimals))
      .filter((v): v is number => v !== null && v > 0);

    if (values.length === 0) {
      return {
        value: 0,
        weight,
        detail: 'no priced supplied value available to assess concentration',
      };
    }
    const n = values.length;
    if (n === 1) {
      return { value: 0, weight, detail: 'single priced reserve — fully concentrated' };
    }
    const total = values.reduce((a, b) => a + b, 0);
    const hhi = values.reduce((acc, v) => acc + (v / total) ** 2, 0);
    const minHhi = 1 / n;
    const value = clamp(((1 - hhi) / (1 - minHhi)) * 100);
    const topShare = Math.max(...values) / total;
    return {
      value: Math.round(value),
      weight,
      detail: `top reserve holds ${(topShare * 100).toFixed(0)}% of supplied value across ${n} reserves (HHI ${hhi.toFixed(2)})`,
    };
  }

  // Worst-case oracle staleness across reserves. Blend prices carry a publish
  // timestamp; a stale price is what lets bad debt accrue undetected. Fresh
  // (< 10 min) → 100, degrading linearly to 0 at 60 min. Thresholds are a
  // conservative v1 heuristic; ideally we'd read the oracle's own resolution.
  private oracleSafety(raw: BlendRawData): RiskFactor {
    const weight = 0.25;
    const fresh = 10 * 60;
    const dead = 60 * 60;

    const ages = raw.reserves.map((r) => (r.price ? raw.fetchedAt - r.price.timestamp : null));
    if (ages.some((a) => a === null)) {
      return { value: 0, weight, detail: 'at least one reserve has no oracle price' };
    }
    const worst = Math.max(...(ages as number[]));
    const value = lerp01(worst, dead, fresh); // dead→0, fresh→100
    return {
      value: Math.round(value),
      weight,
      detail: `worst oracle price age ${Math.max(0, worst)}s (fresh<${fresh}s, stale>${dead}s)`,
    };
  }

  // Admin key posture from Horizon. A single hot key that can reconfigure the
  // pool is the sharpest centralization risk; multisig/high-threshold is safer.
  // Recent admin-account activity ("AdminKeyActivity") lowers safety further —
  // an actively-used admin key is a live lever. Contract-governed admins can't
  // be introspected via Horizon, so they get a flagged neutral baseline.
  private adminKeySafety(raw: BlendRawData): RiskFactor {
    const weight = 0.2;
    const a = raw.admin;

    if (a.isContract || a.account === null) {
      return {
        value: 60,
        weight,
        detail: `admin is a contract (${a.address.slice(0, 6)}…) — not introspectable via Horizon; neutral baseline`,
      };
    }

    const { highThreshold, signerCount, recentOps, activityWindowDays } = a.account;
    // Structure: multisig (>1 signer AND high threshold >1) is materially safer
    // than a lone master key.
    const multisig = signerCount > 1 && highThreshold > 1;
    const base = multisig ? 90 : 40;
    // Activity: each recent op shaves safety, capped so structure still dominates.
    const activityPenalty = Math.min(30, recentOps * 3);
    const value = clamp(base - activityPenalty);
    return {
      value: Math.round(value),
      weight,
      detail: `${multisig ? 'multisig' : 'single-key'} admin (${signerCount} signer(s), high-threshold ${highThreshold}), ${recentOps} op(s) in ${activityWindowDays}d`,
    };
  }

  // Free liquidity as a share of supplied value (1 − utilization), worst reserve.
  // This is the withdrawal/liquidation cushion: how much can leave before the
  // pool is drained. Distinct from utilizationSpike below, which measures
  // proximity to the *protocol-configured* cap rather than absolute headroom.
  private liquiditySafety(raw: BlendRawData): RiskFactor {
    const weight = 0.15;
    let worstRatio = 1;
    let worstAsset = '';
    for (const r of raw.reserves) {
      const { supplied, borrowed } = reserveTotals(r);
      if (supplied <= 0) continue;
      const free = clamp(((supplied - borrowed) / supplied) * 100);
      if (free <= worstRatio * 100) {
        worstRatio = free / 100;
        worstAsset = r.asset;
      }
    }
    return {
      value: Math.round(worstRatio * 100),
      weight,
      detail: `worst reserve (${worstAsset.slice(0, 6)}…) has ${(worstRatio * 100).toFixed(0)}% of supply as free liquidity`,
    };
  }

  // Proximity of live utilization to the reserve's configured max_util cap.
  // Blend throttles/pauses borrowing as utilization nears max_util, so nearing
  // it is a concrete stress signal. headroom = (max_util − util)/max_util,
  // worst reserve wins. util here is computed live (borrowed/supplied), not the
  // config's target field.
  private utilizationSafety(raw: BlendRawData): RiskFactor {
    const weight = 0.2;
    let worst = 100;
    let worstAsset = '';
    let worstUtil = 0;
    let worstCap = 0;
    for (const r of raw.reserves) {
      const { supplied, borrowed } = reserveTotals(r);
      if (supplied <= 0) continue;
      const util = borrowed / supplied;
      const cap = Number(r.config.maxUtil) / Number(SCALAR_7);
      if (cap <= 0) continue;
      const headroom = clamp(((cap - util) / cap) * 100);
      if (headroom <= worst) {
        worst = headroom;
        worstAsset = r.asset;
        worstUtil = util;
        worstCap = cap;
      }
    }
    return {
      value: Math.round(worst),
      weight,
      detail: `worst reserve (${worstAsset.slice(0, 6)}…) at ${(worstUtil * 100).toFixed(0)}% util vs ${(worstCap * 100).toFixed(0)}% cap`,
    };
  }

  // Weighted mean of the factors, renormalizing over whichever are non-null so
  // a missing factor doesn't silently drag the score toward zero. Higher = safer.
  score(factors: RiskFactorMap): RiskScoreResult {
    let weighted = 0;
    let totalWeight = 0;
    for (const factor of Object.values(factors)) {
      if (!factor) continue;
      weighted += factor.value * factor.weight;
      totalWeight += factor.weight;
    }
    const score = totalWeight === 0 ? 0 : Math.round(weighted / totalWeight);
    return { score, factors, computedAt: new Date() };
  }
}

export const blendAdapter = new BlendAdapter();
