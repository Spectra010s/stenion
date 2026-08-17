// Where Stenion sends a reader who wants to check a contract for themselves.
//
// This is the ONE place the explorer is chosen. Adapters publish a raw
// `contractId` (a C-address) and nothing more — deliberately, so switching
// explorers, or adding a per-network one, is an edit here rather than a string
// hunt across every adapter in the repo.
//
// Pure string building, no runtime deps: safe to import from a client component.

/**
 * stellar.expert is the explorer with real Soroban contract support — it renders
 * contract storage, invocations and the code hash, which is what someone
 * checking a score behind a factor actually needs. Horizon-era explorers mostly
 * show classic accounts and payments and would 404 or show nothing useful here.
 */
const STELLAR_EXPERT = 'https://stellar.expert/explorer';

/**
 * Mainnet only, matching `Chain = 'stellar'` in @stenion/core and the fact that
 * every adapter's default RPC is mainnet. When a testnet chain is added, this
 * takes the network as an argument rather than growing a second constant.
 */
const NETWORK = 'public';

/** Explorer page for a Soroban contract, e.g. a Blend pool or a Kinetic router. */
export function contractExplorerUrl(contractId: string): string {
  return `${STELLAR_EXPERT}/${NETWORK}/contract/${encodeURIComponent(contractId)}`;
}

/**
 * Shorten a 56-character C-address for display: `CAJJZSGM…OSSYBXBD`.
 *
 * Display only — the full value stays in the link target and in the API
 * response, so nothing is lost, and a reader can still eyeball the head and
 * tail against another source. Anything shorter than a full address plus
 * ellipsis is returned unchanged rather than being padded into a fake shape.
 */
export function shortenContractId(contractId: string, head = 8, tail = 8): string {
  if (contractId.length <= head + tail + 1) return contractId;
  return `${contractId.slice(0, head)}…${contractId.slice(-tail)}`;
}
