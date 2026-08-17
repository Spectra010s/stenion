-- Protocol identity: logo, the scored contract, and the protocol's own links.
--
-- Why these live in the database rather than a table in the frontend: they are
-- adapter metadata, exactly like `name`, `chain` and `adapter` already in this
-- table, and they arrive by the same route (ProtocolMetadata -> upsertProtocol).
-- A lookup keyed by slug in the dashboard would have to be edited every time an
-- adapter is added, by someone editing a different package than the one they
-- just wrote — which is how such tables go stale. One source, one write path.
--
-- All four are NULLABLE and stay that way. Each is a genuinely optional fact:
--   logo        — the protocol publishes no usable mark (the dashboard renders a
--                 deliberate initials tile; see CONTRIBUTING.md). Not a gap.
--   contract_id — reserved for a future adapter that scores something other than
--                 a single addressable contract. Both shipped adapters set it.
--   site_url    — a protocol with no front page.
--   docs_url    — a protocol that publishes no documentation. Common.
-- A dead link is worse than an absent one, so "unknown" must be representable.
-- There is deliberately NO placeholder/default: a default logo path would point
-- at a file that does not exist and 404 on every row that forgot to set one.
--
-- NOT NULL is also wrong for a second reason: this migration runs against the
-- one shared Neon database while `main` may still be running an indexer that
-- upserts without these columns (the same live-writer hazard 0002 documents at
-- length). Nullable columns let that writer keep succeeding; it simply leaves
-- them NULL until main is promoted.
--
-- `logo` holds a ROOT-RELATIVE PATH into the dashboard's own public/ tree
-- ('/assets/protocols/blend.svg'), never a URL on the protocol's CDN. Hotlinked
-- marks break when a protocol reorganises its assets, and the 404 shifts layout.
-- The consequence is a real coupling and worth stating plainly: this column's
-- value is only meaningful against a dashboard build that ships the matching
-- file, so removing an asset means clearing the column in the same change.
--
-- `contract_id` is the raw Soroban C-address, NOT an explorer URL. Which
-- explorer to send a reader to is a Stenion presentation choice that belongs in
-- the dashboard (app/lib/explorer.ts), in one place — not a string every adapter
-- repeats and no one can change afterwards without touching every adapter.
--
-- Three columns rather than one `links jsonb`: unlike `risk_scores.factors`,
-- this is not an open taxonomy that grows on every adapter. It is a short fixed
-- set whose members each mean something specific and are published as typed
-- fields on the public API, so the schema should say so. Adding `github_url`
-- later is a one-line migration, and that is the right price.
ALTER TABLE protocols
  ADD COLUMN IF NOT EXISTS logo        text,
  ADD COLUMN IF NOT EXISTS contract_id text,
  ADD COLUMN IF NOT EXISTS site_url    text,
  ADD COLUMN IF NOT EXISTS docs_url    text;
