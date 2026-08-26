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
// Types and values are imported separately, deliberately. Node's native type
// stripping is syntactic — it cannot tell that `Adapter` is an interface, so a
// combined `import { Adapter, freshnessWindow }` survives into the running
// module and then fails to resolve against @stenion/core's CommonJS output,
// which has no runtime `Adapter` export. Keep type-only names under
// `import type`.
import {
  PoolOperation,
  RiskFactorType,
  describePriceAges,
  describeWorst,
  excludedComponent,
  freshnessWindow,
  scoreFactors,
  sizeReserves,
  toOperationalState,
  worstReserves,
} from '@stenion/core';
import type {
  Adapter,
  ExcludedReserve,
  OperationalOrigin,
  OperationalState,
  ProtocolDeployment,
  ProtocolLinks,
  ProtocolMetadata,
  WorstReserves,
  RiskFactor,
  RiskFactorMap,
  RiskScoreResult,
} from '@stenion/core';

// ---------------------------------------------------------------------------
// Mainnet wiring
//
// Addresses come from Blend's own deploy config (blend-utils/mainnet.contracts.json),
// cross-checked against docs.blend.capital/mainnet-deployments — not a third-party
// indexer.
//
// ONE ENGINE, MANY POOLS. Blend's factory deploys one contract per market, and
// every market runs the SAME pool wasm — verified rather than assumed: the Fixed
// V2 and YieldBlox V2 pools report the identical code hash
// (a41fc53d6753b6c04eb15b021c55052366a4c8e0e21bc72700f461264ec1350e), and the V2
// pool factory's `is_pool` returns true for both. So the read interface, the
// instance-storage keys and the fixed-point scalars below hold for every pool,
// and a second Blend market needs no new scoring code — only a new BlendPool
// entry. Same rule that moved `scoreFactors` into @stenion/core, applied to pool
// targeting: nothing per-pool is allowed to be logic.
//
// This is multi-pool TARGETING, not aggregation. Each pool is scored and ranked
// as its own registry entry from its own reserves, oracle and admin; pools are
// never summed into a single Blend number. Summing would hide exactly the
// per-market differences the score exists to show — the two live pools sit 30
// points apart on the same contract code.
// ---------------------------------------------------------------------------

const NETWORK_PASSPHRASE = Networks.PUBLIC;

/** Public, key-less Soroban mainnet RPC (Stellar docs "Providers" list). Overridable for self-hosting. */
const DEFAULT_RPC_URL = 'https://mainnet.sorobanrpc.com';

/** Public Horizon — needed for admin-account signer/activity data, which Soroban RPC does not expose. */
const DEFAULT_HORIZON_URL = 'https://horizon.stellar.org';

/**
 * One Blend market this adapter can be pointed at.
 *
 * Everything here is IDENTITY — the slug, the display name, the pool contract,
 * the mark and the links. Deliberately nothing here is a threshold, a weight or
 * a formula: a field on this type that changed how a factor is computed would be
 * a per-pool rulebook, which METHODOLOGY.md ground rule 1 forbids. Adding a pool
 * must stay a data change.
 */
export interface BlendPool {
  /** registry slug — `protocols.id`, the public URL, and the API path segment */
  id: string;
  /** display name */
  name: string;
  /** the pool contract this entry is scored from */
  poolId: string;
  /** self-hosted mark, or omitted when the market publishes none (see ProtocolMetadata.logo) */
  logo?: string;
  links?: ProtocolLinks;
  /**
   * Set on every pool that is not the protocol's own flagship entry, so a reader
   * can tell a community market running Blend's contracts from Blend itself.
   * This is the field that stops a second Blend pool reading as a second
   * protocol — see ProtocolDeployment.
   */
  deployedOn?: ProtocolDeployment;
}

/**
 * Blend V2 "Fixed" pool (XLM:USDC:EURC) — Blend's flagship market and this
 * adapter's default target. Its on-chain pool `Name` is "Fixed"; the entry is
 * called "Blend" because it is the reference deployment of the protocol itself.
 */
export const BLEND_FIXED_V2: BlendPool = {
  id: 'blend',
  name: 'Blend',
  poolId: 'CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD',
  // Self-hosted copy of Blend's own mark, never a hotlink to their CDN.
  logo: '/assets/protocols/blend.svg',
  links: {
    site: 'https://www.blend.capital',
    docs: 'https://docs.blend.capital',
  },
};

/**
 * The YieldBlox pool on Blend V2 — a DAO-managed market, NOT an independent
 * protocol. Its on-chain pool `Name` is "YieldBlox", its admin is a Soroban
 * Governor contract rather than a keypair, and YieldBlox's own site describes it
 * as "a community-run DeFi lending protocol on the Stellar network, built on
 * Blend". It is scored as its own entry because its reserves, oracle aggregator
 * and admin are all its own — and carries `deployedOn` because its contract code
 * is not. Their own wording says the same thing this entry's label does, which is
 * the best evidence available that the label is not our interpretation.
 *
 * `logo` is a self-hosted copy of their own mark, taken from the 512x512
 * `icon-512.png` their web manifest publishes — never a hotlink. PNG rather than
 * SVG because they ship no vector mark: the site is a SvelteKit build whose only
 * inline SVGs are 24x24 `currentColor` UI glyphs, and its icon set is raster
 * throughout. That is the documented fallback (CONTRIBUTING.md, "The logo
 * asset"), same as Kinetic's.
 *
 * It clears the dark-tile check: the mark is a green glyph (#38af4a) on a fully
 * transparent field — sampled corners are alpha 0 and its opaque pixels average
 * luminance 147 — so nothing vanishes into the tile's #0a0816. Borrowing Blend's
 * mark, had none been available, would have been the worst option on the list:
 * it would assert precisely the identity this entry exists to deny.
 *
 * No `docs`: yieldblox.xyz publishes no documentation link, and a dead link is
 * worse than an absent one.
 */
export const BLEND_YIELDBLOX_V2: BlendPool = {
  id: 'yieldblox',
  name: 'YieldBlox',
  poolId: 'CCCCIQSDILITHMM7PBSLVDT5MISSY7R26MNZXCX4H7J5JQ5FPIYOGYFS',
  logo: '/assets/protocols/yieldblox.png',
  links: {
    // Their canonical URL (rel=canonical resolves to the www host), not the
    // yieldblox.finance placeholder this entry originally shipped with.
    site: 'https://www.yieldblox.xyz',
  },
  deployedOn: {
    host: 'Blend',
    label: 'Blend V2 pool',
  },
};

/**
 * The Etherfuse pool on Blend V2 — a market run by Etherfuse, NOT an independent
 * protocol and not Blend's own. Its on-chain pool `Name` is "Etherfuse" and it
 * runs the same pool wasm (`a41fc53d…`) as the two entries above, so it is a
 * config entry and no new scoring code.
 *
 * WHICH DEPLOYMENT THIS IS, because there are three. Blend's V2 factory deployed
 * a pool named "Etherfuse" three times — `CALRF5I2…` (2025-11-21), `CADR6Q2U…`
 * and this one (both 2025-11-24). The other two are abandoned: read on
 * 2026-08-26 both hold **exactly 0 supplied and 0 borrowed across all five
 * reserves** and sit at `PoolConfig.status` 6 (Setup — never opened), while this
 * one held $133,523.47 supplied at status 1 (Active). The choice was made from
 * those balances, not from reward-zone membership — though this is also the only
 * one of the three in Blend's backstop reward zone.
 *
 * WHY THE NAME AND LINK ARE NOT A GUESS. Three of its five reserves are
 * Etherfuse's own tokenized-bond assets — CETES, USTRY and TESOURO, all issued
 * by `GCRYUGD5…` — and that issuer account's Horizon `home_domain` is
 * `etherfuse.com`, whose SEP-1 `stellar.toml` names `ORG_URL =
 * "https://etherfuse.com"` and lists the same issuer under `ACCOUNTS`. So the
 * link is chain-attested rather than a domain that merely matches the pool name.
 * `docs` is their published API documentation, verified by fetching it.
 *
 * NO `logo`, deliberately, and this is the documented designed state rather than
 * a gap (CONTRIBUTING.md, "The logo asset"): Etherfuse publishes only a 708×130
 * WORDMARK (`/logo-white.svg`, `/logo-black.svg`) and no square icon mark — no
 * `icon.svg`, no `apple-touch-icon`, nothing but a 256×256 `.ico`. A 5.4:1
 * wordmark in the 40px square tile renders as an illegible sliver, and cropping
 * or redrawing it to fit is exactly what that section forbids. The initials tile
 * stands.
 */
export const BLEND_ETHERFUSE_V2: BlendPool = {
  id: 'etherfuse',
  name: 'Etherfuse',
  poolId: 'CDMAVJPFXPADND3YRL4BSM3AKZWCTFMX27GLLXCML3PD62HEQS5FPVAI',
  links: {
    site: 'https://etherfuse.com',
    docs: 'https://docs.etherfuse.com',
  },
  deployedOn: {
    host: 'Blend',
    label: 'Blend V2 pool',
  },
};

/**
 * Every Blend market Stenion scores, in registration order.
 *
 * The indexer iterates this rather than naming pools one by one, so adding a
 * market is one entry here and nothing else — there is no second target list to
 * keep in step, which is how such lists come apart.
 */
export const BLEND_POOLS: readonly BlendPool[] = [
  BLEND_FIXED_V2,
  BLEND_YIELDBLOX_V2,
  BLEND_ETHERFUSE_V2,
];

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
  /**
   * This asset's entry in the oracle aggregator's own `asset_configs()`, or
   * null if the aggregator has no entry for it (in which case it cannot be
   * priced at all — `price` will also be null).
   */
  priceConfig: {
    /** the upstream asset the aggregator maps this reserve to, e.g. "Other:XLM" */
    upstreamAsset: string;
    /** index into BlendRawData.oracleConfig.oracles */
    oracleIndex: number;
    /**
     * Max single-step price deviation the aggregator will accept for this
     * asset, as a whole percent. 0 (or >= 100) disables the check entirely —
     * see `oracleSafety` and METHODOLOGY.md §2.
     */
    maxDev: number;
  } | null;
}

/** The oracle aggregator's own published configuration (all public reads). */
export interface BlendOracleConfigRaw {
  /** `max_age()` — seconds; a price older than this is refused outright */
  maxAge: number;
  /**
   * Assets the aggregator prices as the unit of account: its `Base` plus any
   * `BaseAssets`. `lastprice` short-circuits these to exactly 1.0 at the current
   * ledger time without consulting any upstream feed (see the contract's
   * `lastprice`), so they have no oracle price to grade — `oracleSafety`
   * excludes them rather than scoring them as unbounded.
   */
  baseAssets: string[];
  /** `oracles()` — the upstream feeds the aggregator reads */
  oracles: {
    index: number;
    address: string;
    /** upstream publish interval in seconds */
    resolution: number;
    decimals: number;
  }[];
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
  /**
   * PoolConfig `min_collateral` — the smallest collateral value a position may
   * hold and still borrow, in the ORACLE's base-asset denomination (so divide by
   * 10^oracleDecimals to get USD; the Fixed V2 pool's oracle bases on
   * `Other:USD` at 7 decimals, making the live value of 50000000 exactly $5.00).
   *
   * Read because it is Blend's OWN dust guard: it is set where liquidating a
   * position stops being economically worthwhile, which is the same question
   * §4/§5's minimum-size filter asks. Kept raw rather than pre-divided so the
   * fixture records what the chain actually said.
   *
   * 0n when the pool declares none — a real state, not a missing read.
   */
  minCollateral: bigint;
  admin: BlendAdminRaw;
  oracleConfig: BlendOracleConfigRaw;
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
  /** optional because a pool predating V2's dust guard simply has no such field */
  min_collateral?: number | bigint;
}
interface PriceDataNative {
  price: number | bigint;
  timestamp: number | bigint;
}
/** oracle-aggregator `OracleConfig` (its struct, not the pool's PoolConfig). */
interface OracleConfigNative {
  address: string;
  index: number | bigint;
  resolution: number | bigint;
  decimals: number | bigint;
}
/** oracle-aggregator `AssetConfig`; `asset` decodes to ['Stellar'|'Other', value]. */
interface AssetConfigNative {
  asset: unknown;
  oracle_index: number | bigint;
  max_dev: number | bigint;
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

// ---------------------------------------------------------------------------
// Pool status -> shared operational state
//
// `PoolConfig.status` is a u32 with seven meanings, and this table is the whole
// mapping. It was built by reading the contract, not the docs: the public
// documentation names the states (Setup / Active / On-Ice / Frozen) but publishes
// no numeric mapping, and a web search returns a partial and partly wrong one.
// The two functions that define every value are in blend-contracts-v2:
//
//   pool/src/pool/status.rs   execute_set_pool_status (admin) and
//                             execute_update_pool_status (permissionless)
//   pool/src/pool/pool.rs     require_action_allowed, which is the gate itself:
//
//     if (status > 1 && (action == 4 || action == 9))       // Borrow, DeleteLiquidationAuction
//     || (status > 3 && (action == 2 || action == 0))       // SupplyCollateral, Supply
//     { panic!(InvalidPoolStatus) }
//
// RequestType numbering is from pool/src/pool/actions.rs: 0 Supply, 1 Withdraw,
// 2 SupplyCollateral, 3 WithdrawCollateral, 4 Borrow, 5 Repay, 6-8 auction fills,
// 9 DeleteLiquidationAuction.
//
// TWO THINGS THAT FALL OUT OF THAT GATE, both load-bearing here:
//
// 1. **Blend never blocks withdrawals, repayments or liquidation fills at any
//    status.** Only action 9 — *cancelling* an in-flight liquidation auction — is
//    blocked, which is a wind-down-safely posture rather than a restriction on
//    users. So no Blend status can produce `ExitDisabled`, and that is a fact
//    about Blend rather than a gap in this table. K2's pause does block exits,
//    which is exactly why the shared representation is built on which operations
//    are blocked instead of on either protocol's own vocabulary.
// 2. **Even/odd is nearly an origin signal and is not one.** 0/2/4 are settable
//    only by the admin and 1/5 only by the permissionless backstop path, but 3 is
//    settable by both (`execute_set_pool_status` accepts 0, 2, 3 and 4). Reading
//    parity as "who did this" would therefore be right six times in seven and
//    wrong on the one value where it matters most, so status 3 reports
//    `indeterminate`.
//
// Status 6 (Setup) is the pool's state at deployment, before its configuration
// is timelocked (`config.rs` requires a timelock only when `status != 6`). It
// supersedes everything: the permissionless update path panics rather than
// moving a Setup pool. Every Setup pool found in the 2026-08-22 factory survey
// (issue #65) held exactly $0.00 and is excluded by the market-size floor
// regardless — this row exists so that if one is ever pointed at, it reads as
// "never opened" rather than as a market that restricted its users.
interface BlendStatusMeaning {
  /** Blend's own name for the state, as its documentation uses it */
  name: string;
  blocked: readonly PoolOperation[];
  origin: OperationalOrigin;
  neverOpened?: true;
  /**
   * Set on the RESTRICTED states the backstop's own update path can produce (3
   * and 5), never on status 1.
   *
   * Deliberately a flag rather than `origin === 'protocol'`, which is what it
   * was first written as and which was wrong on live data: status 1 is also
   * permissionless, but it is the state the backstop sets when it is HEALTHY.
   * Deriving the note from origin appended "the backstop can set this when
   * deposits fall below the threshold" to the Blend Fixed pool's perfectly
   * ordinary Active reading — a stress explanation attached to a healthy pool.
   */
  backstopDriven?: true;
  /** what a user can still do, phrased for someone deciding whether to care */
  effect: string;
}

const BLEND_POOL_STATUS: Record<number, BlendStatusMeaning> = {
  0: {
    name: 'Admin Active',
    blocked: [],
    origin: 'admin',
    effect: 'all operations available',
  },
  1: {
    name: 'Active',
    blocked: [],
    origin: 'protocol',
    effect: 'all operations available',
  },
  2: {
    name: 'Admin On-Ice',
    blocked: [PoolOperation.Borrow],
    origin: 'admin',
    effect: 'borrowing is disabled; supplying, withdrawing and repaying still work',
  },
  3: {
    name: 'On-Ice',
    blocked: [PoolOperation.Borrow],
    origin: 'indeterminate',
    backstopDriven: true,
    effect: 'borrowing is disabled; supplying, withdrawing and repaying still work',
  },
  4: {
    name: 'Admin Frozen',
    blocked: [PoolOperation.Supply, PoolOperation.Borrow],
    origin: 'admin',
    effect: 'borrowing and supplying are disabled; withdrawals and repayments still work',
  },
  5: {
    name: 'Frozen',
    blocked: [PoolOperation.Supply, PoolOperation.Borrow],
    origin: 'protocol',
    backstopDriven: true,
    effect: 'borrowing and supplying are disabled; withdrawals and repayments still work',
  },
  6: {
    name: 'Setup',
    blocked: [PoolOperation.Supply, PoolOperation.Borrow],
    origin: 'indeterminate',
    neverOpened: true,
    effect: 'the pool has never been opened — borrowing and supplying are disabled',
  },
};

/**
 * How a RESTRICTED status could have come about, appended to the detail of the
 * two values (3 and 5) the backstop's own update path can impose.
 *
 * Not status 1: that is permissionless too, but it is what the backstop sets
 * when it is healthy, so this clause would read as a stress warning on a pool
 * with nothing wrong with it. See BlendStatusMeaning.backstopDriven.
 *
 * The update path sets 3 and 5 off two readable conditions: the pool's backstop deposits falling under
 * the required threshold, or `q4w_pct` — the share of backstop capital queued
 * for withdrawal — crossing 30%/60%/75%. Naming the mechanism is worth a clause
 * because "On-Ice" alone reads as a choice somebody made, and for these values it
 * may well not be.
 *
 * Stated as what the mechanism *can* do, not as a diagnosis of what happened:
 * this adapter does not read backstop data, so it cannot say which condition
 * fired, and pretending otherwise would be a fabricated finding.
 */
const BACKSTOP_DRIVEN =
  " Blend's backstop can impose this restriction on its own — when the pool's " +
  'backstop deposits fall below the required threshold, or when a large share of ' +
  'them is queued for withdrawal — and it can also be set deliberately. Which ' +
  'happened here is not readable from the status alone.';

/** Read one reserve's ResConfig + ResData persistent entries and normalize field names. */
async function readReserve(
  server: rpc.Server,
  poolId: string,
  asset: string,
): Promise<Omit<BlendReserveRaw, 'price' | 'priceConfig'>> {
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

/** Simulate a read-only contract call and return the raw ScVal result. */
async function readContractScv(
  server: rpc.Server,
  contractId: string,
  method: string,
  ...args: xdr.ScVal[]
): Promise<xdr.ScVal> {
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
  return retval;
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

// ---------------------------------------------------------------------------
// The oracle-legibility precondition
//
// METHODOLOGY.md §2, "The oracle-legibility precondition". `oracleSafety` grades
// two things, and BOTH anchors are parameters the pool's own price path has to
// publish: the freshness window comes from `oracles()[i].resolution` and
// `max_age()`, and the deviation bound from per-asset `max_dev` in
// `asset_configs()`. Those three reads are Blend's oracle-aggregator interface —
// they are not in SEP-40, which defines no staleness tolerance and no deviation
// bound at all.
//
// Not every Blend V2 pool runs an aggregator. Four live ones do not (issue #69,
// probed 2026-08-26 by reading each oracle's contract spec out of its wasm):
// Orbit's bridge oracle, Forex's proxy, Spectra PTs' deterministic zero-coupon
// pricer and Solv's SEP-40 feed registry. They are four DIFFERENT contracts with
// four different wasm hashes — not one "non-aggregator shape" — and they agree
// on exactly one thing: none of them answers any of the three reads below.
//
// WHY THIS IS A HARD PRECONDITION AND NOT A FALLBACK. There is no weaker anchor
// to fall back to, only fabricated ones:
//
//   - The nearest candidate is SEP-40's `resolution()`, a publish interval
//     rather than a staleness tolerance. Solv publishes `resolution() = 43200`
//     (12 hours, and owner-mutable via `set_resolution`). Fed to
//     `freshnessWindow` with no `max_age` it yields {fresh: 43200, dead: 86400},
//     because STALE_CEILING_SECONDS clamps `dead` and not `fresh`. Solv's
//     genuinely stale feeds — measured at 10,285s and 21,739s old on 2026-08-26
//     — would both publish priceFreshness 100.
//   - Two of the four price off the ledger clock, so freshness is 100 BY
//     CONSTRUCTION and can never be anything else. Spectra's oracle computes a
//     bond accretion (its `lastprice` ignores the asset argument outright), and
//     Orbit's dominant reserve — 99.5% of that pool's value — returns exactly
//     1.0 at current ledger time touching no upstream contract. On an aggregator
//     §2b excludes such base assets; Orbit's bridge publishes no `base()`, so
//     there is nothing to detect them with.
//
// A fabricated 100 is worse than a fabricated 0, and ground rule 4 forbids both.
// So the pool is not scored at all — published instead through
// dashboard/app/lib/coverage.ts as `oracle-not-gradable`, the same shape the
// market-size floor uses one level up.
// ---------------------------------------------------------------------------

/**
 * The three reads METHODOLOGY.md §2 grades `oracleSafety` against.
 *
 * Deliberately the grading reads only. `decimals()` and `lastprice()` are NOT
 * here: the other four factors need exactly those two and nothing else
 * (`suppliedUsd` prices reserves for §1 and for §4/§5's size filter), and every
 * oracle behind a V2 pool answers both. This precondition is about the two
 * anchors §2 needs, not about whether a pool can be read at all.
 */
export const ORACLE_GRADING_READS = ['max_age', 'oracles', 'asset_configs'] as const;

export type OracleGradingRead = (typeof ORACLE_GRADING_READS)[number];

/** Which of the §2 grading reads this oracle actually answered. */
export type OracleGradingReads = Record<OracleGradingRead, boolean>;

/**
 * Does this failure mean the contract has no such function, as opposed to
 * anything else that can go wrong on the way to it?
 *
 * The distinction is load-bearing and is the reason this is a named function
 * rather than a bare catch. "This oracle publishes no `max_age`" is a permanent
 * property of the deployed contract and a verdict on scorability. A timeout, a
 * 429 from the shared public RPC, or a malformed response is a transient RUN
 * failure. Treating the second as the first would let one bad five-minute cycle
 * declare a pool ungradable; treating the first as the second would retry a
 * call that can never succeed until the cycle budget ran out.
 *
 * Matched on both halves of what the host actually returns — the error code and
 * the diagnostic phrase, plus the method name — so a message that merely
 * contains the word "MissingValue" for some other reason does not qualify.
 * Sample, captured from mainnet on 2026-08-26:
 *
 *   HostError: Error(WasmVm, MissingValue)
 *   … topics:[error, Error(WasmVm, MissingValue)], data:["trying to invoke
 *   non-existent contract function", max_age]
 */
export function isMissingContractFunction(error: unknown, method: string): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('Error(WasmVm, MissingValue)') &&
    message.includes('trying to invoke non-existent contract function') &&
    message.includes(method)
  );
}

/**
 * The precondition itself: null when this oracle can be graded, and the run's
 * failure message when it cannot.
 *
 * A MESSAGE RATHER THAN A SCORE, deliberately, and rather than an Error subclass
 * — the indexer records `error.message` on a failed run, and a subclass's `name`
 * is a runtime identifier the dashboard's bundler would rename in production
 * (see ProtocolMetadata.adapterRef for the bug that rule comes from).
 *
 * It names every missing read rather than only the first, because "this oracle
 * is not an aggregator" is one fact and reporting it one method per cycle would
 * make it look like three separate problems.
 */
export function oracleNotGradable(oracleId: string, answered: OracleGradingReads): string | null {
  const missing = ORACLE_GRADING_READS.filter((read) => !answered[read]);
  if (missing.length === 0) return null;
  return (
    `Blend: oracle ${oracleId} publishes no ${missing.join('(), no ')}(), so this pool ` +
    'fails the oracle-legibility precondition (METHODOLOGY.md §2) and is not scorable — ' +
    'oracleSafety has no on-chain anchor for either price staleness or deviation, and ' +
    'inventing one would publish a confident number from no data. Such a market belongs ' +
    'in coverage.ts as `oracle-not-gradable`, not in BLEND_POOLS.'
  );
}

/** Sentinel for a grading read the contract does not implement. */
const ABSENT = Symbol('absent');

/**
 * Run one §2 grading read, turning "no such function" into ABSENT and letting
 * every other failure escape as the run failure it is. See
 * `isMissingContractFunction` for why those two must not be conflated.
 */
async function gradingRead<T>(
  method: OracleGradingRead,
  run: () => Promise<T>,
): Promise<T | typeof ABSENT> {
  try {
    return await run();
  } catch (error) {
    if (isMissingContractFunction(error, method)) return ABSENT;
    throw error;
  }
}

/**
 * Read the oracle aggregator's own published config: the upstream feeds it
 * reads (`oracles()`) and the age beyond which it refuses a price (`max_age()`).
 *
 * These are the anchors `oracleSafety` grades freshness against — the
 * aggregator's numbers, not Stenion constants.
 *
 * `max_age()` and `oracles()` are passed in already-read rather than fetched
 * here, because they are two of the three reads the oracle-legibility
 * precondition probes: fetching them here as well would either double the RPC
 * calls or make the precondition unable to say which read was missing.
 */
async function readOracleConfig(
  server: rpc.Server,
  oracleId: string,
  maxAgeNative: unknown,
  oraclesNative: unknown,
): Promise<BlendOracleConfigRaw> {
  const maxAge = Number(maxAgeNative as number | bigint);
  const oracles = oraclesNative as OracleConfigNative[];
  if (!Array.isArray(oracles) || oracles.length === 0) {
    throw new Error(`Blend: oracle ${oracleId} returned an empty oracles() list`);
  }

  // `base()` is a public read; the `BaseAssets` list has no getter, so it comes
  // from instance storage. Older aggregator deployments have no BaseAssets key
  // at all — the contract treats that as an empty list, and so do we.
  const baseAssets = new Set<string>();
  const base = (await readContract(server, oracleId, 'base')) as unknown;
  if (Array.isArray(base) && base[0] === 'Stellar' && typeof base[1] === 'string') {
    baseAssets.add(base[1]);
  }
  const instance = await readInstanceStorage(server, oracleId);
  const baseAssetsScv = instance.get('BaseAssets');
  if (baseAssetsScv) {
    for (const entry of (scValToNative(baseAssetsScv) as unknown[]) ?? []) {
      if (Array.isArray(entry) && entry[0] === 'Stellar' && typeof entry[1] === 'string') {
        baseAssets.add(entry[1]);
      }
    }
  }

  return {
    maxAge,
    baseAssets: [...baseAssets],
    oracles: oracles.map((o) => ({
      index: Number(o.index),
      address: o.address,
      resolution: Number(o.resolution),
      decimals: Number(o.decimals),
    })),
  };
}

/**
 * Decode `asset_configs()` keyed by reserve address.
 *
 * Decoded from the raw ScVal map rather than via `scValToNative` on the whole
 * value: the map's keys are `Asset` enum vecs, and letting the SDK coerce those
 * into JS object keys would make us depend on its stringification of a
 * non-string key. Decoding each key on its own keeps the mapping explicit.
 *
 * Takes the already-read ScVal rather than fetching, for the same reason
 * `readOracleConfig` does: `asset_configs` is one of the three reads the
 * oracle-legibility precondition probes.
 */
function decodeAssetConfigs(
  scv: xdr.ScVal,
): Map<string, NonNullable<BlendReserveRaw['priceConfig']>> {
  const out = new Map<string, NonNullable<BlendReserveRaw['priceConfig']>>();
  for (const entry of scv.map() ?? []) {
    const key = scValToNative(entry.key()) as unknown;
    // Reserve keys are Asset::Stellar(Address) -> ['Stellar', 'C…'].
    if (!Array.isArray(key) || key[0] !== 'Stellar' || typeof key[1] !== 'string') continue;
    const cfg = scValToNative(entry.val()) as AssetConfigNative;
    const upstream = cfg.asset;
    out.set(key[1], {
      upstreamAsset: Array.isArray(upstream) ? `${upstream[0]}:${upstream[1]}` : 'unknown',
      oracleIndex: Number(cfg.oracle_index),
      maxDev: Number(cfg.max_dev),
    });
  }
  return out;
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

/** First 6 chars of a contract address, for detail strings. */
const shortAsset = (a: string): string => `${a.slice(0, 6)}…`;

/**
 * Is the aggregator's deviation check actually active for this asset?
 *
 * Mirrors the contract's own condition in oracle-aggregator/src/price_data.rs:
 * `if config.max_dev > 0 && config.max_dev < 100`. Outside that range the check
 * is skipped entirely and the aggregator just returns the latest price, however
 * far it moved.
 */
const deviationBounded = (maxDevPercent: number): boolean =>
  maxDevPercent > 0 && maxDevPercent < 100;

/**
 * Score every reserve on one sub-signal and keep the worst — and every reserve
 * tied with it. The selection rule and the phrasing both live in core
 * (`worstReserves`/`describeWorst`) so the two adapters cannot drift into
 * describing the same situation differently.
 *
 * Blend is the clearest case for reporting ties: all reserves are priced from a
 * single aggregator publish round, so their ages are identical and they always
 * tie. Naming one of them was pure iteration order.
 */
function worstBy(
  reserves: BlendReserveRaw[],
  score: (r: BlendReserveRaw) => { score: number; note: string },
): WorstReserves {
  return worstReserves(reserves.map((r) => ({ asset: r.asset, ...score(r) })));
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
  /**
   * Which market to score. Defaults to Blend's flagship Fixed V2 pool.
   *
   * A whole BlendPool rather than a bare `poolId`, deliberately: target and
   * identity have to move together. A lone pool-id knob lets an instance read
   * one pool while publishing another pool's slug, name and links — the same
   * class of bug as `adapter: "w"`, and harder to catch, because every field
   * involved stays individually plausible.
   */
  pool?: BlendPool;
}

export class BlendAdapter implements Adapter<BlendRawData> {
  /**
   * Built in the constructor rather than as a field initialiser because every
   * identity field has to describe the pool THIS INSTANCE scores, not a module
   * default. `contractId` is the sharp one: an adapter pointed at a second pool
   * that published an explorer link to the first would attach a wrong number to
   * a real address, which is worse than no link at all. It is set from
   * `this.poolId`, the same value `fetchRawData` reads, so the two cannot drift.
   *
   * `adapterRef` is the one field every pool shares, and that is correct rather
   * than a gap: both entries genuinely are produced by this class, so both rows
   * point a reader at this file. It stays a string literal — never
   * `this.constructor.name`; see ProtocolMetadata.adapterRef.
   */
  readonly metadata: ProtocolMetadata;

  private readonly rpcUrl: string;
  private readonly horizonUrl: string;
  private readonly poolId: string;

  constructor(opts: BlendAdapterOptions = {}) {
    this.rpcUrl = opts.rpcUrl ?? DEFAULT_RPC_URL;
    this.horizonUrl = opts.horizonUrl ?? DEFAULT_HORIZON_URL;
    const pool = opts.pool ?? BLEND_FIXED_V2;
    this.poolId = pool.poolId;

    this.metadata = {
      id: pool.id,
      name: pool.name,
      chain: 'stellar',
      // Literal, not this.constructor.name — see ProtocolMetadata.adapterRef.
      adapterRef: 'BlendAdapter',
      contractId: this.poolId,
      // Spread, so a pool with no mark / no links / no deployment note leaves the
      // key ABSENT rather than set to undefined. Identical to TypeScript, not to
      // a reader of a serialized metadata object — and `upsertProtocol` maps
      // either to NULL, so nothing downstream is asked to tell them apart.
      ...(pool.logo === undefined ? {} : { logo: pool.logo }),
      ...(pool.links === undefined ? {} : { links: pool.links }),
      ...(pool.deployedOn === undefined ? {} : { deployedOn: pool.deployedOn }),
    };
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
    const minCollateral =
      poolConfig.min_collateral === undefined ? 0n : BigInt(poolConfig.min_collateral);
    const adminAddress: string = adminScv
      ? (scValToNative(adminScv) as string)
      : (poolConfig.admin ?? '');

    // Reserve list is a public read method on the V2 pool.
    const reserveList = (await readContract(server, this.poolId, 'get_reserve_list')) as string[];
    if (!Array.isArray(reserveList) || reserveList.length === 0) {
      throw new Error(`Blend: pool ${this.poolId} returned an empty reserve list`);
    }

    const oracleDecimals = Number(await readContract(server, oracleId, 'decimals'));

    // The oracle-legibility precondition (METHODOLOGY.md §2). Probed BEFORE
    // anything is built from these reads, so a pool whose oracle cannot be
    // graded fails as one clean, explanatory run failure naming every missing
    // read — rather than as a raw `HostError: Error(WasmVm, MissingValue)` from
    // whichever call happened to go first.
    //
    // No extra RPC in the happy path: an aggregator answers all three, and these
    // are the same three calls the adapter always made.
    const maxAgeNative = await gradingRead('max_age', () =>
      readContract(server, oracleId, 'max_age'),
    );
    const oraclesNative = await gradingRead('oracles', () =>
      readContract(server, oracleId, 'oracles'),
    );
    const assetConfigsScv = await gradingRead('asset_configs', () =>
      readContractScv(server, oracleId, 'asset_configs'),
    );
    const notGradable = oracleNotGradable(oracleId, {
      max_age: maxAgeNative !== ABSENT,
      oracles: oraclesNative !== ABSENT,
      asset_configs: assetConfigsScv !== ABSENT,
    });
    if (notGradable) throw new Error(notGradable);

    // Past the precondition, none of the three can still be ABSENT — that is
    // exactly what `oracleNotGradable` returning null means. The cast records
    // the invariant the compiler cannot carry across the throw above; the other
    // two are already `unknown` and are narrowed inside readOracleConfig.
    const oracleConfig = await readOracleConfig(server, oracleId, maxAgeNative, oraclesNative);
    const assetConfigs = decodeAssetConfigs(assetConfigsScv as xdr.ScVal);

    const reserves: BlendReserveRaw[] = [];
    for (const asset of reserveList) {
      const base = await readReserve(server, this.poolId, asset);
      const price = await readOraclePrice(server, oracleId, asset);
      reserves.push({ ...base, price, priceConfig: assetConfigs.get(asset) ?? null });
    }

    const admin = await fetchAdmin(this.horizonUrl, adminAddress);

    return {
      poolId: this.poolId,
      oracleId,
      oracleDecimals,
      status,
      minCollateral,
      admin,
      oracleConfig,
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

  /**
   * `PoolConfig.status` → the shared operational state. Not scored; see
   * BLEND_POOL_STATUS above for the mapping and where it came from.
   *
   * Blend gates at the POOL level only — `require_action_allowed` reads
   * `self.config.status` and nothing per-reserve — so there is exactly one
   * reading here and no `mostRestrictive` reduction to do. (K2 does gate per
   * reserve, which is why that helper exists.)
   *
   * An unrecognised status is reported as unrecognised rather than guessed at.
   * Values outside 0-6 cannot be produced by the deployed contract — both setter
   * paths reject them — so reaching this branch means the pool is running code
   * this mapping was not read from, and the honest output is to say so, name the
   * number, and claim nothing about what it blocks. `blocked: []` here is not
   * "nothing is restricted": the level is unknowable, and `detail` says exactly
   * that rather than letting an empty list read as a clean bill of health.
   */
  operationalState(raw: BlendRawData): OperationalState {
    const asOf = new Date(raw.fetchedAt * 1000);
    const source = `PoolConfig.status = ${raw.status}`;
    const meaning = BLEND_POOL_STATUS[raw.status];

    if (!meaning) {
      return toOperationalState({
        blocked: [],
        neverOpened: false,
        source,
        origin: 'indeterminate',
        detail:
          `pool reports status ${raw.status}, which is not one of Blend V2's seven ` +
          'defined values (0-6) — what it restricts cannot be determined from the ' +
          'contract this mapping was read from, so nothing is claimed about it',
        asOf,
      });
    }

    const backstop = meaning.backstopDriven ? BACKSTOP_DRIVEN : '';
    return toOperationalState({
      blocked: meaning.blocked,
      neverOpened: meaning.neverOpened ?? false,
      source,
      origin: meaning.origin,
      detail: `pool status ${raw.status} (${meaning.name}) — ${meaning.effect}.${backstop}`,
      asOf,
    });
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

  // Can this pool's prices be trusted? Two things must both hold: the price is
  // current, AND a single update can't move it arbitrarily far. An age-only
  // oracle factor scores a fresh-but-manipulated price 100 — exactly the
  // YieldBlox failure mode. See METHODOLOGY.md §2.
  //
  // Both sub-signals take the worst reserve, and the factor takes the binding
  // constraint (the lower of the two) — a bounded stale price and a fresh
  // unbounded price are both untrustworthy, for different reasons.
  private oracleSafety(raw: BlendRawData): RiskFactor {
    const weight = 0.25;

    // Base assets are the aggregator's unit of account: `lastprice` returns a
    // hardcoded 1.0 at the current ledger time for them, never reading an
    // upstream feed. There is no oracle price to grade, so they are excluded
    // from both sub-signals — scoring them 0 for "no deviation bound" would be
    // measuring the absence of a mechanism that doesn't apply. (Their peg
    // holding is a real risk, but it is a collateral/peg question, not an
    // oracle-robustness one — see METHODOLOGY.md §2.)
    const baseAssets = new Set(raw.oracleConfig.baseAssets);
    const graded = raw.reserves.filter((r) => !baseAssets.has(r.asset));
    const excluded = raw.reserves.length - graded.length;
    if (graded.length === 0) {
      return {
        value: 0,
        weight,
        detail: 'every reserve is an oracle base asset — no oracle-derived price to assess',
      };
    }

    // Freshness anchors are the aggregator's own: `resolution` is how often the
    // upstream feed publishes (a price younger than that is as fresh as the feed
    // can be), `max_age` is the age at which the aggregator itself refuses the
    // price. The STALE_CEILING cap is the one unvalidated judgment call here.
    const worstFresh = worstBy(graded, (r) => {
      if (!r.price) return { score: 0, note: 'no oracle price' };
      const age = Math.max(0, raw.fetchedAt - r.price.timestamp);
      const resolution = raw.oracleConfig.oracles[r.priceConfig?.oracleIndex ?? 0]?.resolution ?? 0;
      const { fresh, dead } = freshnessWindow(resolution, raw.oracleConfig.maxAge);
      return {
        score: lerp01(age, dead, fresh),
        note: `${age}s old (fresh<${fresh}s, dead>${dead}s)`,
      };
    });

    // The deviation bound is scored as a binary: is a bound configured at all?
    // `max_dev` of 0 (or >= 100) disables the aggregator's check outright — see
    // oracle-aggregator/src/price_data.rs — which is what permits an unbounded
    // single-step move. Its *tightness* is disclosed below but deliberately not
    // graded; see METHODOLOGY.md §2 on why.
    const worstBound = worstBy(graded, (r) => {
      const dev = r.priceConfig?.maxDev;
      if (dev === undefined)
        return { score: 0, note: 'no aggregator entry — asset cannot be priced' };
      return deviationBounded(dev)
        ? {
            score: 100,
            note: `bounded at ${dev}% per ${raw.oracleConfig.oracles[r.priceConfig!.oracleIndex]?.resolution ?? '?'}s step`,
          }
        : { score: 0, note: `max_dev ${dev} — deviation check disabled` };
    });

    const value = Math.min(worstFresh.score, worstBound.score);
    const bounds = graded
      .map((r) => `${shortAsset(r.asset)} ${r.priceConfig ? `${r.priceConfig.maxDev}%` : 'n/a'}`)
      .join(', ');
    const excludedNote =
      excluded > 0 ? ` ${excluded} base asset(s) excluded — priced 1:1, not oracle-derived.` : '';

    return {
      value: Math.round(value),
      weight,
      detail:
        worstBound.score === 0
          ? describeWorst(worstBound)
          : `${describeWorst(worstFresh)}; all reserves have a deviation bound`,
      components: [
        {
          id: 'priceFreshness',
          label: 'Price freshness',
          value: Math.round(worstFresh.score),
          detail: `${describeWorst(worstFresh)}; anchored to the aggregator's own resolution and max_age (${raw.oracleConfig.maxAge}s)`,
        },
        {
          id: 'deviationBound',
          label: 'Deviation bound',
          value: Math.round(worstBound.score),
          detail: describeWorst(worstBound),
        },
        {
          id: 'priceAges',
          label: 'Price age by feed (not scored)',
          value: null,
          // Blend's reserves are priced in one aggregator round, so these ages
          // are normally identical and this disclosure is unremarkable. It is
          // published anyway, on the same rule as every protocol: the value of
          // showing per-feed ages is that a divergence becomes visible when one
          // appears, and a disclosure that only exists where we already expect
          // trouble is one nobody can check against a healthy baseline.
          detail: describePriceAges(
            graded.map((r) => ({
              asset: r.asset,
              feed: r.priceConfig?.upstreamAsset ?? null,
              ageSeconds: r.price ? Math.max(0, raw.fetchedAt - r.price.timestamp) : null,
            })),
            raw.oracleConfig.maxAge,
          ),
        },
        {
          id: 'deviationTightness',
          label: 'Bound tightness (not scored)',
          value: null,
          detail: `per-reserve max_dev: ${bounds}.${excludedNote} Measured against the previous upstream record, so this bounds movement per publish interval. Reported, not graded — see METHODOLOGY.md §2.`,
        },
      ],
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
  //
  // Reserves below the shared minimum size are excluded before selection — see
  // reserveSizing() and METHODOLOGY.md §4 — and disclosed rather than dropped.
  private liquiditySafety(raw: BlendRawData): RiskFactor {
    const weight = 0.15;
    const sizing = this.reserveSizing(raw);
    const excluded: ExcludedReserve[] = [];
    let worstRatio = 1;
    let worstAsset = '';
    let measured = 0;
    for (const [i, r] of raw.reserves.entries()) {
      const { supplied, borrowed } = reserveTotals(r);
      if (supplied <= 0) continue;
      const free = clamp(((supplied - borrowed) / supplied) * 100);
      // The size filter sits AHEAD of `measured++` on purpose: a pool where it
      // excludes everything then falls through to the can't-assess branch below
      // rather than reaching a separate path that could report the seed value.
      if (!sizing[i].scored) {
        excluded.push({ asset: r.asset, ...sizing[i], wouldHaveScored: Math.round(free) });
        continue;
      }
      measured++;
      if (free <= worstRatio * 100) {
        worstRatio = free / 100;
        worstAsset = r.asset;
      }
    }
    const components = excludedComponent(excluded, 'free liquidity');
    // METHODOLOGY.md §4 is a minimum over the reserves with supplied > 0. With
    // none, that minimum is undefined — NOT 100. Reporting the accumulator's
    // seed here would publish "maximally safe" derived from no data at all,
    // which ground rule 4 forbids; 0 (can't assess) matches collateralSafety's
    // treatment of the same situation.
    if (measured === 0) {
      return {
        value: 0,
        weight,
        detail:
          excluded.length > 0
            ? `every reserve with supplied value is below the minimum scorable size — free liquidity cannot be assessed`
            : 'no reserve has any supplied value — free liquidity cannot be assessed',
        ...components,
      };
    }
    return {
      value: Math.round(worstRatio * 100),
      weight,
      detail: `worst reserve (${worstAsset.slice(0, 6)}…) has ${(worstRatio * 100).toFixed(0)}% of supply as free liquidity`,
      ...components,
    };
  }

  // Proximity of live utilization to the reserve's configured max_util cap.
  // Blend throttles/pauses borrowing as utilization nears max_util, so nearing
  // it is a concrete stress signal. headroom = (max_util − util)/max_util,
  // worst reserve wins. util here is computed live (borrowed/supplied), not the
  // config's target field.
  private utilizationSafety(raw: BlendRawData): RiskFactor {
    const weight = 0.2;
    const sizing = this.reserveSizing(raw);
    const excluded: ExcludedReserve[] = [];
    let worst = 100;
    let worstAsset = '';
    let worstUtil = 0;
    let worstCap = 0;
    // Two independent reasons a reserve is skipped, counted separately so the
    // "nothing to measure" case can say which one applied. They are genuinely
    // different findings: an empty pool is not the same problem as a pool whose
    // reserves hold real debt but declare no utilization ceiling.
    let withSupply = 0;
    let withCap = 0;
    for (const [i, r] of raw.reserves.entries()) {
      const { supplied, borrowed } = reserveTotals(r);
      if (supplied <= 0) continue;
      const util = borrowed / supplied;
      const cap = Number(r.config.maxUtil) / Number(SCALAR_7);
      // Ahead of `withSupply++` for the same reason as in liquiditySafety, and
      // so the no-cap message counts reserves this factor would actually have
      // scored rather than ones it had already set aside as too small.
      if (!sizing[i].scored) {
        excluded.push({
          asset: r.asset,
          ...sizing[i],
          wouldHaveScored: cap > 0 ? Math.round(clamp(((cap - util) / cap) * 100)) : null,
        });
        continue;
      }
      withSupply++;
      if (cap <= 0) continue;
      withCap++;
      const headroom = clamp(((cap - util) / cap) * 100);
      if (headroom <= worst) {
        worst = headroom;
        worstAsset = r.asset;
        worstUtil = util;
        worstCap = cap;
      }
    }
    const components = excludedComponent(excluded, 'utilization headroom');
    // METHODOLOGY.md §5 is a minimum over reserves with supplied > 0 AND
    // cap > 0. With none, that minimum is undefined — not the seed value of
    // 100. See the note in liquiditySafety.
    if (withCap === 0) {
      let detail: string;
      if (withSupply > 0) {
        detail = `no reserve has a configured utilization cap (max_util) — headroom cannot be assessed across ${withSupply} supplied reserve(s)`;
      } else if (excluded.length > 0) {
        detail = `every reserve with supplied value is below the minimum scorable size — utilization headroom cannot be assessed`;
      } else {
        detail = 'no reserve has any supplied value — utilization headroom cannot be assessed';
      }
      return { value: 0, weight, detail, ...components };
    }
    return {
      value: Math.round(worst),
      weight,
      detail: `worst reserve (${worstAsset.slice(0, 6)}…) at ${(worstUtil * 100).toFixed(0)}% util vs ${(worstCap * 100).toFixed(0)}% cap`,
      ...components,
    };
  }

  /**
   * The §4/§5 minimum-size filter, resolved for this pool.
   *
   * The rule is shared (core's `sizeReserves`); what is per-protocol is only
   * where its absolute leg is read from — Blend's own `min_collateral`, divided
   * out of the oracle's base-asset decimals into USD. Exactly the anchoring
   * pattern §5's `cap` uses.
   */
  private reserveSizing(raw: BlendRawData) {
    const minPositionUsd =
      raw.minCollateral > 0n ? Number(raw.minCollateral) / 10 ** raw.oracleDecimals : null;
    return sizeReserves(
      raw.reserves.map((r) => suppliedUsd(r, raw.oracleDecimals)),
      minPositionUsd,
    );
  }

  // Delegates to the shared rulebook in @stenion/core. The weighted mean is not
  // per-protocol (METHODOLOGY.md ground rule 1), so it must not be reimplemented
  // here — this method exists only to satisfy the Adapter interface.
  score(factors: RiskFactorMap): RiskScoreResult {
    return scoreFactors(factors);
  }
}

/** Blend's flagship Fixed V2 pool, ready to use. */
export const blendAdapter = new BlendAdapter();
