# Stenion Public API

**Free, public, read-only risk data for Stellar/Soroban DeFi lending protocols.**

Three `GET` endpoints, no authentication, no API key, CORS open to any origin. If you are building a
wallet, an aggregator, or a dashboard and you want a live safety number for a protocol your users
are about to interact with, this is the whole surface area.

The scored examples below were captured from the live production API, not written from the type
definitions. Their responses are verbatim bodies from a snapshot taken at
**2026-08-20T11:05–11:10Z**; the numbers move every ~5 minutes, the shapes do not. The coverage
example was captured with `curl` from the built route on **2026-08-21T22:15Z**, backed by a fresh
local database, before that new endpoint had a production URL to call. Recapture it against
production after promotion.

---

## Base URL

```
https://stenion.vercel.app/api/v1
```

There is no separate API host and no sandbox. The production API is the only API, and it serves the
same data the [registry](https://stenion.vercel.app/registry) renders — the site's own pages and
these routes read the same store, so what you get and what we show cannot drift apart.

### Versioning, and whether we will break you

Every public path carries a version segment. There are **no unversioned paths** — `/api/protocols`
and `/api/protocol/:id` existed briefly during the move to `/v1` and now `404`.

The policy, stated plainly because "will you break my integration" is the only versioning question
that actually matters:

- **Additive changes stay on `v1`.** A new field in a response — a sixth `*Safety` factor, another
  piece of protocol metadata, a new component inside a factor — ships on `v1`. It cannot break a
  client that ignores fields it does not recognise, so **parse defensively and tolerate unknown
  fields**. That is the one thing we ask of you in return.
- **Breaking changes get a `v2`.** Renaming a field, removing one, changing a type, changing what an
  existing value _means_, or restructuring the envelope — all of it goes to a new version path.
  `v1` keeps serving its existing contract until it is deliberately retired, which would be
  announced, not silent.

**A methodology change is not an API change.** If we change a formula, a threshold, or a weight,
`safetyScore` is still a 0–100 number meaning the same thing, so the contract holds and the version
does not move. What moves is `methodologyVersion` in the response body — see
[The score](#the-score). A change to the factor _taxonomy_, though — renaming or removing one of the
five factors — is breaking, and would be a `v2`.

---

## Two commitments

**The public registry data is free, and stays free.** The score, the factor breakdown, the history,
and these endpoints are public and unmetered beyond the rate limit below. Stenion's paid tiers add
capability — private tooling, faster refresh, visibility placement — and they never gate access to
anything that is already public, and never change a score. The ranked registry is sorted purely on
`safetyScore` with no paid exceptions. This is a project rule enforced in code and review, not a
launch promise.

**Nothing here is an endorsement.** A `safetyScore` is analysis of on-chain state, not a
recommendation, a rating, an audit, or financial advice. Protocol names, logos, links, and contract
ids appear as the subject's own properties. Displaying a protocol does not imply endorsement,
partnership, or any relationship between Stenion and that protocol — in either direction — and
integrating this API does not create one either.

---

## Quick start

```bash
# every protocol, ranked
curl https://stenion.vercel.app/api/v1/protocols

# protocols Stenion assessed and deliberately does not score
curl https://stenion.vercel.app/api/v1/coverage

# one protocol, with factors and run history
curl https://stenion.vercel.app/api/v1/protocol/blend
```

---

## GET /api/v1/protocols

The leaderboard: every protocol Stenion tracks, with its latest score. Ranked by `safetyScore`
descending, with never-scored protocols last.

**Request**

```bash
curl https://stenion.vercel.app/api/v1/protocols
```

**Response** `200 OK`

```json
{
  "protocols": [
    {
      "id": "blend",
      "name": "Blend",
      "chain": "stellar",
      "logo": "/assets/protocols/blend.svg",
      "deployedOn": null,
      "safetyScore": 53,
      "computedAt": "2026-08-20T11:05:05.600Z",
      "lastRunAt": "2026-08-20T11:05:02.641Z",
      "lastRunStatus": "ok"
    },
    {
      "id": "kinetic",
      "name": "Kinetic",
      "chain": "stellar",
      "logo": "/assets/protocols/kinetic.png",
      "deployedOn": null,
      "safetyScore": 27,
      "computedAt": "2026-08-20T11:05:15.167Z",
      "lastRunAt": "2026-08-20T11:05:10.083Z",
      "lastRunStatus": "ok"
    },
    {
      "id": "yieldblox",
      "name": "YieldBlox",
      "chain": "stellar",
      "logo": null,
      "deployedOn": {
        "host": "Blend",
        "label": "Blend V2 pool"
      },
      "safetyScore": 24,
      "computedAt": "2026-08-20T11:05:09.897Z",
      "lastRunAt": "2026-08-20T11:05:05.786Z",
      "lastRunStatus": "ok"
    }
  ]
}
```

| Field           | Type                     | Notes                                                                                                                                                                        |
| --------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`            | string                   | Stable identifier, **case-sensitive**, used as the path segment on the detail endpoint.                                                                                      |
| `name`          | string                   | Display name.                                                                                                                                                                |
| `chain`         | string                   | Currently always `"stellar"`.                                                                                                                                                |
| `logo`          | string or null           | Root-relative path to a mark **Stenion hosts** — prefix with the base host. `null` is a normal state, not a broken image.                                                    |
| `deployedOn`    | object or null           | **Present when this entry is not an independent protocol** — see [Not every entry is a protocol](#not-every-entry-is-a-protocol). `null` means it runs on its own contracts. |
| `safetyScore`   | number or null           | 0–100, higher = safer. From the latest **`ok`** run. `null` means never successfully scored — not "zero", not "unsafe".                                                      |
| `computedAt`    | string or null           | ISO 8601 UTC. When that score was computed. `null` if and only if `safetyScore` is `null`.                                                                                   |
| `lastRunAt`     | string or null           | ISO 8601 UTC. The most recent run of **any** status. See [Staleness](#staleness-is-your-problem-too).                                                                        |
| `lastRunStatus` | `"ok"`, `"failed"`, null | Status of that most recent run. `null` means the protocol has never been run at all.                                                                                         |

The board deliberately carries no `contractId`, `site`, or `docs` — those are verification detail
nobody acts on from a list, and repeating them on every row of every fetch is waste. They live on
the detail response. `deployedOn` is the exception, and for the opposite reason: it is not detail
you look up after deciding to care, it is part of what the row _is_, and a reader who scans the
board and leaves has to have seen it.

---

## GET /api/v1/coverage

Protocols and markets Stenion has assessed and deliberately does not score. This is a separate,
unranked contract: an entry here is a coverage decision, never a failed run or a low score.

**Request**

```bash
curl https://stenion.vercel.app/api/v1/coverage
```

**Response** `200 OK`

> The first entry is shown below for readability. The live response returns every current entry in
> the `coverage` array; this object is verbatim from the live route capture.

```json
{
  "coverage": [
    {
      "id": "templar",
      "name": "Templar",
      "status": "off-chain-state",
      "logo": null,
      "links": {
        "site": null,
        "docs": null
      },
      "contractId": null,
      "summary": "A NEAR-based protocol whose reserves, balances and positions live on NEAR — the only contract it runs on Soroban is a price oracle.",
      "reason": [
        "Templar is a NEAR-based chain-abstraction protocol — it calls its product “Cypher Lending” — and its lending market state lives on NEAR, not on Stellar. Reserves, supply and borrow balances, utilization and collateral positions are all read through NEAR RPC. Stellar’s role is as a wallet and collateral entry point via NEAR’s MPC signing, not as the ledger the lending market runs on.",
        "The only native-Soroban contract Templar ships is a price oracle. That is one of the five factors Stenion scores; the other four are on another chain. An adapter faithful to what Templar actually is would have to read NEAR, and Stenion’s adapters read trustless Stellar infrastructure and nothing else — that rule is the pitch rather than an implementation detail, so bending it for one protocol would quietly change what every other score means.",
        "This is a decision about where the data lives, not a judgment about Templar. It could be represented only if Stenion’s model expanded to read another chain, which ROADMAP.md keeps explicitly out of scope."
      ],
      "verify": "Follow Templar’s own documentation for where lending state is held, then confirm it against the chain: the Soroban contract it publishes on Stellar exposes an oracle interface (price reads), with no reserve, supply/borrow or position storage. There is no Soroban contract to call get_reserves_list, or any equivalent, against.",
      "asOf": null
    }
  ]
}
```

| Field        | Type                 | Notes                                                                                                             |
| ------------ | -------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `id`         | string               | Stable, case-sensitive coverage identifier; also the path segment on `/coverage/<id>`.                            |
| `name`       | string               | Display name.                                                                                                     |
| `status`     | string               | Machine-readable coverage category. New categories may be added on `v1`; existing values are not renamed on `v1`. |
| `logo`       | string or null       | Root-relative self-hosted mark, or `null`.                                                                        |
| `links`      | object               | The protocol's verified `site` and `docs`, each string or `null`.                                                 |
| `contractId` | string or null       | Full Soroban address only when one was recorded; otherwise `null`.                                                |
| `summary`    | string               | One-sentence coverage summary.                                                                                    |
| `reason`     | string[]             | Protocol-specific evidence and reasoning. Quoted measurements remain text, not a numeric score.                   |
| `verify`     | string               | How an integrator or reader can independently check the decision.                                                 |
| `asOf`       | `YYYY-MM-DD` or null | Date of a measurement-backed reason. `null` means the decision is structural or no dated check is claimed.        |

There is deliberately **no `safetyScore` key and no JSON numeric value anywhere in this
response**. Identifiers, dates, and evidence strings can contain digits; none is a value a client
could mistake for a score. The full evidence ships in the list, so there is no separate
`GET /api/v1/coverage/:id` endpoint.

The route reads the live leaderboard only to apply the same self-healing dedupe as the registry. A
protocol that has become scorable cannot appear in both responses. `GET /api/v1/protocols` is
unchanged byte-for-byte.

---

## Not every entry is a protocol

Some entries are **individual markets running another protocol's contracts**, not protocols in their
own right. The YieldBlox entry (`yieldblox`) is one: it is a DAO-managed pool on Blend V2, running
Blend's pool contract byte-for-byte, and Stenion scores it with the same adapter it uses for Blend's
own pool.

Such an entry carries a non-null `deployedOn` on **both** endpoints — verbatim from the
`yieldblox` entry in the leaderboard capture above:

```json
"deployedOn": {
  "host": "Blend",
  "label": "Blend V2 pool"
}
```

| Field   | Type   | Notes                                                                               |
| ------- | ------ | ----------------------------------------------------------------------------------- |
| `host`  | string | The host protocol's **display name**, e.g. `"Blend"`. Not an `id`, and not a link.  |
| `label` | string | Short label naming the deployment, e.g. `"Blend V2 pool"`. Safe to render verbatim. |

`null` means the entry runs on its own contracts. It never means "unknown" — we do not register an
entry without knowing which.

**If you display protocol names, display this beside them.** Not a style preference: without it your
users read a list of markets as a list of protocols, which is a claim about the ecosystem that isn't
true. Rendering `label` verbatim next to the name is enough.

**`host` is deliberately not a protocol id and links to nothing.** Stenion's `blend` entry is itself
one Blend market, so pointing at it would say this pool runs on _that entry_ rather than on Blend's
contract. If you want the host's own entry, you are looking for a relationship this API does not
assert.

**Each such entry is scored independently, on its own on-chain state.** Sharing contract code is not
sharing a score: `deployedOn` markets are ranked on their own reserves, oracle configuration and
admin like any other entry, and the two live Blend pools currently differ by 30 points. Do not infer
one entry's risk from its host's.

---

## GET /api/v1/protocol/:id

One protocol: metadata, the current score, the full factor breakdown, and recent run history.

**Request**

```bash
curl https://stenion.vercel.app/api/v1/protocol/blend
```

**Response** `200 OK`

> `history` is truncated to 3 entries below for readability. The live response returns up to **50**
> rows, newest first. Everything else is verbatim.

```json
{
  "id": "blend",
  "name": "Blend",
  "chain": "stellar",
  "adapter": "BlendAdapter",
  "logo": "/assets/protocols/blend.svg",
  "contractId": "CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD",
  "site": "https://www.blend.capital",
  "docs": "https://docs.blend.capital",
  "deployedOn": null,
  "safetyScore": 53,
  "computedAt": "2026-08-20T11:10:07.254Z",
  "factors": {
    "oracleSafety": {
      "value": 99,
      "detail": "all 3 reserves score the same — 307s old (fresh<300s, dead>900s); all reserves have a deviation bound",
      "weight": 0.25,
      "components": [
        {
          "id": "priceFreshness",
          "label": "Price freshness",
          "value": 99,
          "detail": "all 3 reserves score the same — 307s old (fresh<300s, dead>900s); anchored to the aggregator's own resolution and max_age (900s)"
        },
        {
          "id": "deviationBound",
          "label": "Deviation bound",
          "value": 100,
          "detail": "all 3 reserves score the same — CAS3J7… bounded at 60% per 300s step; CCW67T… bounded at 20% per 300s step; CDTKPW… bounded at 20% per 300s step"
        },
        {
          "id": "priceAges",
          "label": "Price age by feed (not scored)",
          "value": null,
          "detail": "Other:XLM 307s, Other:USDC 307s, Other:EURC 307s — all 3 within the protocol's own 900s staleness limit. Reported, not graded: priceFreshness already scores the worst of these."
        },
        {
          "id": "deviationTightness",
          "label": "Bound tightness (not scored)",
          "value": null,
          "detail": "per-reserve max_dev: CAS3J7… 60%, CCW67T… 20%, CDTKPW… 20%. Measured against the previous upstream record, so this bounds movement per publish interval. Reported, not graded — see METHODOLOGY.md §2."
        }
      ]
    },
    "adminKeySafety": {
      "value": 40,
      "detail": "single-key admin (1 signer(s), high-threshold 0), 0 op(s) in 30d",
      "weight": 0.2
    },
    "liquiditySafety": {
      "value": 23,
      "detail": "worst reserve (CCW67T…) has 23% of supply as free liquidity",
      "weight": 0.15
    },
    "collateralSafety": {
      "value": 68,
      "detail": "top reserve holds 67% of supplied value across 3 reserves (HHI 0.55)",
      "weight": 0.2
    },
    "utilizationSafety": {
      "value": 14,
      "detail": "worst reserve (CCW67T…) at 77% util vs 90% cap",
      "weight": 0.2
    }
  },
  "methodologyVersion": 1,
  "lastRunAt": "2026-08-20T11:10:04.814Z",
  "lastRunStatus": "ok",
  "history": [
    {
      "status": "ok",
      "safetyScore": 53,
      "methodologyVersion": 1,
      "computedAt": "2026-08-20T11:10:07.254Z",
      "runAt": "2026-08-20T11:10:04.814Z"
    },
    {
      "status": "ok",
      "safetyScore": 53,
      "methodologyVersion": 1,
      "computedAt": "2026-08-20T11:05:05.600Z",
      "runAt": "2026-08-20T11:05:02.641Z"
    },
    {
      "status": "ok",
      "safetyScore": 53,
      "methodologyVersion": 1,
      "computedAt": "2026-08-20T11:00:09.773Z",
      "runAt": "2026-08-20T11:00:07.298Z"
    }
  ]
}
```

| Field                         | Type           | Notes                                                                                                                      |
| ----------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `id`, `name`, `chain`, `logo` |                | Same as the leaderboard.                                                                                                   |
| `adapter`                     | string         | Which Stenion adapter produced the score. Informational.                                                                   |
| `contractId`                  | string or null | The Soroban contract the score was derived from. A raw `C…` address, deliberately **not** an explorer URL — pick your own. |
| `site`, `docs`                | string or null | The protocol's own links. Listed as its properties, not as a recommendation.                                               |
| `deployedOn`                  | object or null | Same as the leaderboard. See [Not every entry is a protocol](#not-every-entry-is-a-protocol).                              |
| `safetyScore`, `computedAt`   |                | Latest **`ok`** run. Both `null` if never successfully scored.                                                             |
| `factors`                     | object or null | The five-factor breakdown, or `null` if never scored. See below.                                                           |
| `methodologyVersion`          | number or null | Which rulebook version the current score was computed under.                                                               |
| `lastRunAt`, `lastRunStatus`  |                | Newest run of any status. See [Staleness](#staleness-is-your-problem-too).                                                 |
| `history`                     | array          | Up to 50 recent runs, newest first. **A discriminated union — see below.**                                                 |

### The `factors` object

Five keys, always all five present, defined once as a shared taxonomy so they mean the same thing
for every protocol: `collateralSafety`, `oracleSafety`, `adminKeySafety`, `liquiditySafety`,
`utilizationSafety`.

Each is either a factor object or `null` (the factor genuinely does not apply to that protocol —
render "N/A", do not treat it as zero).

| Field        | Type            | Notes                                                                                    |
| ------------ | --------------- | ---------------------------------------------------------------------------------------- |
| `value`      | number          | 0–100, **higher = safer** — the same direction as the overall score.                     |
| `weight`     | number          | This factor's share of the overall score. Weights of all non-`null` factors sum to 1.    |
| `detail`     | string          | Human-readable, includes the raw on-chain figure it came from. Safe to surface directly. |
| `components` | array, optional | Sub-signals behind `value`. Absent on a factor computed from a single signal.            |

A component with a non-`null` `value` is a scored sub-signal that fed the parent. A component with
`value: null` is a **disclosure** — a real on-chain quantity published deliberately ungraded,
because scoring it would invent comparability the underlying data does not support. Its `detail`
carries the figure. Treat `components` as additive: it may gain entries on `v1`.

Every factor name ends in `*Safety`, and every one is 0–100 higher-is-safer. There is no factor
anywhere in this API where a bigger number is worse.

---

## History rows are a discriminated union — read this one

This is the single most likely thing to get wrong, so it gets its own section.

`history[]` entries are **not** a uniform shape with nullable fields. They are a union discriminated
on `status`:

- an **`ok`** row carries `safetyScore`, `methodologyVersion`, `computedAt`, and `runAt`.
- a **`failed`** row carries `error` and `runAt`, and **does not have a `safetyScore` key at all** —
  not `null`, not `0`. The key is absent.

That absence is deliberate. A failed run is a **gap in our data**, never a score of zero, and giving
it a `safetyScore: 0` would let a pipeline outage render as a protocol suddenly becoming maximally
dangerous.

```ts
type HistoryEntry =
  | {
      status: 'ok';
      safetyScore: number;
      methodologyVersion: number;
      computedAt: string;
      runAt: string;
    }
  | {
      status: 'failed';
      error: string;
      runAt: string;
    };
```

A `failed` row looks like this. **This example is constructed from the schema, not captured live** —
no production run has ever failed, so there is no real one to show you. The shape is enforced by a
database `CHECK` constraint and pinned by tests, but we are not going to present a fabricated body
as a live capture:

```json
{
  "status": "failed",
  "error": "Blend: simulation of lastprice failed",
  "runAt": "2026-08-19T13:20:04.336Z"
}
```

**Do this** — branch on `status` and let a failure be a gap:

```ts
for (const entry of detail.history) {
  if (entry.status === 'ok') {
    plot(entry.runAt, entry.safetyScore);
  } else {
    markGap(entry.runAt, entry.error);
  }
}
```

**Not this** — it silently plots a zero for every failed run, drawing a cliff that never happened:

```ts
// WRONG
for (const entry of detail.history) {
  plot(entry.runAt, entry.safetyScore ?? 0);
}
```

`error` is our own message, and it is meant to be readable. It describes **our** failure to read the
chain — an RPC timeout, a decode error — and says nothing about the protocol's safety. Do not
surface it as a risk signal.

---

## Staleness is your problem too

Stenion re-scores every ~5 minutes. Runs can fail. The API is built to be honest about that rather
than to paper over it, which means you get two independent pieces of information:

- **`safetyScore` / `computedAt`** — the last score we computed **successfully**.
- **`lastRunAt` / `lastRunStatus`** — the most recent run attempt, of **any** outcome.

When `lastRunStatus` is `"ok"`, these agree and there is nothing to think about.

**When `lastRunStatus` is `"failed"`, the score you are holding is still real, but our data is older
than it looks.** It is the last one we successfully computed — at `computedAt` — and we have since
tried and failed to refresh it. The gap between `computedAt` and now is how stale the number
actually is, and `lastRunAt` tells you we were still trying.

```ts
const stale = detail.lastRunStatus === 'failed';
const scoreAgeMs = detail.computedAt ? Date.now() - Date.parse(detail.computedAt) : null;
```

We think an integrator should surface that to their own users rather than absorb it silently — a
safety number that quietly stopped updating is worse than one labelled as stale, because a user acts
on it either way. Our own registry does this: a failed run gets a pill, a caption, and both
timestamps on the protocol page.

One deliberate detail worth copying: **never colour a staleness marker with the score bands.**
Green/amber/red mean risk level here. Painting a pipeline fault amber reports our outage as a verdict
on the protocol.

`safetyScore: null` together with `lastRunStatus: "failed"` means we have **never** had a good score
for that protocol. Render it as unknown. It is not a zero.

---

## The score

`safetyScore` is **0 to 100, higher is safer**. It is a weighted mean of the five factors, each of
which is also 0–100 higher-is-safer.

How each factor is computed — every formula, threshold, and weight — is in the
[Methodology](METHODOLOGY.md), which is the public, challengeable rulebook and the source of truth.
It is deliberately not restated here, so that this page cannot drift from it.

`methodologyVersion` is stamped onto every score at the moment it is computed, and history rows
carry their own. **Scores computed under different methodology versions are not comparable.** If you
chart history, treat a change in `methodologyVersion` between adjacent points as a discontinuity in
the rules, not a real move in risk. History is never backfilled — we label the break rather than
hide it. The current version is `1`.

---

## Caching

All three `/v1` read routes are served through a CDN. The two scored routes — `/v1/protocols` and
`/v1/protocol/:id` — use a TTL computed per response from the data in the body rather than a fixed
constant. The reason is directly relevant to you: a fixed TTL would serve a body claiming "the last
run succeeded at T" for some seconds after a later run had already failed — the cache would be lying
in exactly the field that exists to stop us lying about freshness.

**The guarantee, on those two routes: a cached response can hide a newer indexer run by at most 10
seconds.**

`GET /api/v1/coverage` is the deliberate exception, and says so rather than quietly differing. Its
body carries no `lastRunAt` — there is no run behind a coverage decision — and its records change
only when we deploy, so there is no freshness field for a cache to mask and nothing in the body to
derive a deadline from. It uses a fixed one-hour shared-cache TTL instead.

What you will actually observe on a `200`:

```http
Cache-Control: public, max-age=0
Age: 3
X-Vercel-Cache: HIT
```

The `s-maxage` directive that drives the TTL is consumed by the CDN and does not reach you, so do
not look for it. `Age` is how long the copy you received has been sitting in the cache — subtract it
from `Date` if you want the true age of the response. `max-age=0` is intentional: private browser
caches are deliberately kept out, so a copy's real age never exceeds what `Age` reports. There is no
`stale-while-revalidate`, also intentional — it works by serving a body past its deadline, which is
the exact masking described above.

Errors, `404`s, and `429`s are `no-store`.

**Polling advice:** scored data changes every ~5 minutes, so polling those routes faster than that
buys you nothing but cache hits. Once a minute is generous. Coverage records normally change only
on deploy and use a one-hour shared-cache TTL, so polling `/coverage` more than hourly is wasteful.
Note that the cache key includes the query string, so adding `?t=<random>` to defeat the cache does
not get you fresher data — it just guarantees a cache miss and pushes you toward the rate limit.

---

## Rate limits

**60 requests per minute per client, with a burst of 60**, as a token bucket.

The important and slightly unusual property: **only cache misses count.** The limiter runs inside
the function, and the CDN only invokes the function on a miss. So the documented limit is not a cap
on how many requests you may make — a client polling a cached endpoint can exceed it all day and
never be refused, because we never see those requests. What it bites is the client that defeats the
cache, where every request is a database query.

Clients are identified by IP. **Behind a shared NAT you share a bucket** with everyone else on that
address — survivable in practice because NAT'd browser traffic overwhelmingly hits the CDN. We store
a salted hash of the address, never the address itself; this is a limiter, not an access log.

The limiter **fails open**. If its own machinery breaks, requests are allowed rather than refused — a
broken guard rail must not become a broken API.

### 429 Too Many Requests

A real refusal, captured live:

```http
HTTP/1.1 429 Too Many Requests
Content-Type: application/json; charset=utf-8
Retry-After: 2
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1787145533
Cache-Control: no-store
Access-Control-Allow-Origin: *
```

```json
{
  "error": "Too many requests. This endpoint is rate limited per client; retry after the wait in the Retry-After header.",
  "retryAfter": 2
}
```

| Header                  | Meaning                                                                        |
| ----------------------- | ------------------------------------------------------------------------------ |
| `Retry-After`           | **Seconds** to wait. This is the one to back off on.                           |
| `X-RateLimit-Limit`     | The sustained per-minute allowance.                                            |
| `X-RateLimit-Remaining` | Always `0` — this header only ships on a refusal.                              |
| `X-RateLimit-Reset`     | **Unix epoch seconds**, the GitHub convention — an absolute time, not a delta. |

`retryAfter` in the body carries the same seconds value as the `Retry-After` header, for clients that
find it easier to read the body.

**How to back off:**

```ts
async function get(url: string): Promise<Response> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url);
    if (res.status !== 429) return res;
    const wait = Number(res.headers.get('retry-after') ?? 1);
    await new Promise((resolve) => setTimeout(resolve, wait * 1000));
  }
  throw new Error('stenion: still rate limited after 5 attempts');
}
```

Honour `Retry-After` rather than retrying immediately or on a fixed schedule — the value is computed
from your actual token balance, so it is the shortest correct wait.

**These headers are absent on a `200`.** That is deliberate, not an oversight: a `200` is
shared-cached and served to many clients, so an `X-RateLimit-Remaining` baked into one would be a
single client's balance, frozen and replayed to everybody — a number wrong for every reader,
including the one it came from. You learn your standing the one time it matters, which is when you
are refused.

---

## Errors

Every error a consumer can hit, with the real body.

### 404 Not Found — unknown protocol id

```bash
curl https://stenion.vercel.app/api/v1/protocol/does-not-exist
```

```json
{ "error": "Protocol not found", "id": "does-not-exist" }
```

The id you asked for is echoed back. Ids are **case-sensitive** — `/protocol/BLEND` is a `404`, and
that is the most common cause of an unexpected one.

A `404` is `no-store` and never cached, on purpose: a protocol added in the next cycle would
otherwise keep 404ing out of a shared cache after it went live.

### 429 Too Many Requests

See [Rate limits](#rate-limits) above.

### 500 Internal Server Error

```json
{ "error": "Internal server error" }
```

Deliberately generic — the underlying error is logged server-side and never leaked. Never cached, so
a `500` cannot outlive the outage that caused it. Retry with backoff.

### 405 Method Not Allowed

All three routes are `GET` (plus `HEAD` and `OPTIONS`) only. Any other method returns `405` with an
empty body.

### Two rough edges, stated rather than hidden

- **`GET /api/v1/protocol` with no id returns an HTML `404`, not JSON.** No route matches, so the
  site's own not-found page is served. If you build the URL by concatenation, guard against an empty
  id — a JSON parse of that response will throw something unhelpful.
- **A `404` from a path that matches no route at all** (`/api/v2/protocols`, the removed
  `/api/protocols`) is likewise HTML. JSON error bodies come from paths that matched a route.

So: **branch on `res.status` before parsing, not the other way round.**

```ts
const res = await fetch('https://stenion.vercel.app/api/v1/protocol/blend');
if (!res.ok) {
  // A 404/429/500 from a matched route is JSON; anything else may be HTML.
  throw new Error(`stenion: ${res.status}`);
}
const detail = await res.json();
```

---

## CORS

All three read routes send `Access-Control-Allow-Origin: *` and answer the preflight, so browser
clients on any origin can call them directly — no proxy needed. Allowed methods are `GET, OPTIONS`;
the only allowed request header is `content-type`. Preflights are cached for a day.

The data is public, read-only, and payment-blind, so `*` is the correct policy here rather than a
shortcut.

---

## Not in this API

Stated so you do not go looking:

- **No pagination, filtering, or sort parameters.** Two protocols are tracked today; the leaderboard
  is one small response and returns everything, already ranked. If the set grows enough to need
  paging, that is an additive change and would arrive on `v1` with a documented default.
- **No historical range query.** `history` is the most recent 50 runs, fixed. There is no `?from=`
  or `?limit=`.
- **No factor history.** History rows carry the overall score, not the factor breakdown. The factors
  are stored, so this could be added additively — open an issue if you need it.
- **No webhooks or streaming.** Poll.
- **No authentication.** There is nothing to authenticate; it is all public.

---

## Questions, bugs, and disputes

Stenion is open source — the route handlers behind this document are
[`dashboard/app/api/v1/`](dashboard/app/api/v1/), and if the code and this page ever disagree, that
is a bug worth an issue.

If you are a protocol being scored and think a threshold is wrong,
[`METHODOLOGY.md`](METHODOLOGY.md) is the rulebook and it tells you how to dispute it. Payment is not
a route to a better number, and never will be.
