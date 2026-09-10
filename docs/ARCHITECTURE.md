# ShopStock — Architecture

This document is the technical companion to `PRD.md` and `BUILD_BRIEF.md`. It
records the concrete decisions made while translating the spec into code, and
the assumptions made where the spec was silent.
Note on phase numbering: this document's and `PROGRESS.md`'s phase
numbers reflect how the project actually sequenced (Phase 4 = Search),
which diverges from `BUILD_BRIEF.md` §39's original suggested sequence
(where Search is listed as Phase 5, Synchronization as Phase 6). The two
numbering schemes are not meant to be cross-referenced 1:1 — treat
`PROGRESS.md`'s phase list as authoritative for "what's actually been
built and in what order."

## Layering (frontend)

```
UI (components/pages)
  ↓ calls
services/            — orchestrates domain + repositories; the only layer
                        that talks to both. Components never import
                        repositories or db/ directly.
  ↓ calls
domain/               — pure functions/classes. No React, no IndexedDB, no
                        fetch. Fully unit-testable in isolation.
data/repositories/    — CRUD + query methods per entity, backed by db/.
data/db/              — Dexie (IndexedDB) schema + low-level access.
data/sync/            — sync queue + sync engine, talks to api/.
api/                  — thin HTTP client wrapping fetch to the backend.
auth/                 — session/token storage, trusted-device logic.
```

Rule of thumb: if a file needs to know about IndexedDB *and* about margin
math, it's in the wrong place. Split it.

## Domain model

```
Product
  id                    string (client-generated UUID, stable across sync)
  name                  string | null
  photoRef               string | null   (points to a locally stored blob)
  quantity               number          (decimal-capable — MATERIALIZED, see below)
  unitId                 string
  lowStockThreshold      number | null   (null = use global default)
  lowStockDisabled       boolean
  categoryId             string | null
  locationIds            string[]
  tagIds                 string[]
  sellingPrice           number | null
  marginOverride         number | null   (percent, null = use global default)
  latestPurchaseDate     string | null   (ISO date)
  notes                  string | null
  createdAt              string (ISO datetime)
  updatedAt              string (ISO datetime)
  archived                boolean

  # NOT stored — derived by domain functions from StockEvent history:
  #   latestKnownCost, averageKnownCost, currentMargin, suggestedSellingPrice,
  #   stockStatus (Normal/Low/Out)

StockEvent
  id                     string (client-generated UUID)
  productId               string
  type                    'ADD' | 'REMOVE'
  quantity                number (always positive; type determines direction)
  costPerUnit             number | null   (only meaningful for ADD)
  purchaseDate             string | null  (ISO date, only for ADD)
  recordedAt               string (ISO datetime, immutable, auto)
  comment                  string | null
  reversalOf               string | null  (id of the event this reverses)
  reversedBy               string | null  (id of the event that reversed this)

  # No syncStatus field — see "Events vs. sync state" below.

ProductChangeEvent
  id                      string
  productId                string
  field                    string  ('name' | 'category' | 'location' |
                                     'tags' | 'sellingPrice' | 'archived')
                             # This is the CLOSED set of ProductChangeEvent-
                             # tracked fields, per PRD §16 / Build Brief §21
                             # ("Name, Category, Location, Tags, Selling
                             # price"), plus 'archived' (explicit decision —
                             # archived is a Product field and a metadata
                             # transition like any other, so it is tracked
                             # the same way even though it is not itself
                             # named in PRD §16/§21's list). See "Tracked
                             # vs. non-tracked Product fields" below for the
                             # distinction this enables.
  oldValue                 any
  newValue                 any
  timestamp                 string (ISO datetime)
  accepted                  boolean  (true = this write is the currently
                                        accepted value on Product; false =
                                        this write lost an LWW conflict —
                                        see "Metadata conflict semantics")

  # No syncStatus field here either.

Category / Location / Tag / Unit
  id, name, archived, isDefault

User (backend only)
  id, username, passwordHash, refreshTokens: [{ tokenHash, deviceLabel,
  createdAt, revoked }]
```

### Events vs. sync state — kept strictly separate

`StockEvent` and `ProductChangeEvent` represent **domain truth**: something
that happened, permanently. Whether that record has made it to the server
yet is **transport state**, not domain state, and doesn't belong on the
event itself.

That transport state lives entirely in `SyncQueueEntry` (see "IndexedDB
schema" below). A `StockEvent` is written once and never mutated again to
add a `syncStatus` field — sync progress is tracked by whether a
corresponding `syncQueue` entry still exists and what its `status` is. This
keeps the event tables genuinely append-only/immutable, which is what Rule 6
("never destroy history to make a correction") and the reversal model both
depend on.

### `Product.quantity` — materialized state, not a second source of truth

The event stream (`StockEvent[]` for a product) is the **authoritative**
record of stock movement. `Product.quantity` is a **materialized
projection** of that stream, kept on the product document purely so reads
(product list, dashboard, low-stock checks) don't need to replay the full
event history on every render.

Concretely:

- `Product.quantity` is only ever written by one function:
  `domain/stock/applyStockEvent.js`, which takes the product's current
  quantity and a new event and returns the next quantity. Nothing else is
  permitted to set `quantity` directly.
- If the materialized value and the event stream ever disagree, **the event
  stream wins**. A `recomputeQuantityFromEvents(productId)` domain function
  will exist (Phase 3) purely for this reconciliation case — e.g. after a
  sync pulls down events this device didn't have — and repositories should
  call it after any bulk/sync write to a product's event history, not only
  on local mutations.
- This distinction must be explicit in code comments wherever `quantity` is
  written, not just in this doc.

**The over-removal reconciliation.** PRD §12 requires that a user be
*allowed* to remove more stock than is currently available, after a
warning — the operation must not be silently blocked. Separately,
`productValidation.js` enforces that `Product.quantity` can never be
negative, which is a genuine structural invariant (a negative on-shelf
count is meaningless and would break every display/comparison downstream).
These only conflict if the event and the materialized quantity are assumed
to tell the same story — they don't have to:

- The `StockEvent` itself is recorded **exactly as it happened** — if the
  user removed 8 units, the event says `quantity: 8`, permanently,
  regardless of how many were actually available. The event is never
  mutated, annotated, or reduced to fit.
- `Product.quantity` (the materialized projection) is **clamped at 0** by
  `applyStockEvent.js` — `next = max(0, current - event.quantity)`. The
  shop's on-shelf count stops at the floor; it does not go negative.
- The over-removal *warning* itself ("Only 5 units are available. Remove 8
  anyway?") is a UI/service-layer decision made **before** the event is
  constructed and applied — `applyStockEvent.js` has no warning branch and
  never rejects an over-removal; a separate, side-effect-free question
  function (`wouldOverRemove(currentQuantity, event)`) exists purely to
  drive that UI prompt, and calling it (or not) has no effect on what
  `applyStockEvent()` does.

Net effect: no negative `Product.quantity` ever, no loss of the historical
removal event, no silent rejection of a user-confirmed action. A future
reconciliation/audit view could compare "units removed per history" against
"units the shelf actually had" and surface any resulting discrepancy — but
that's a reporting concern, not something `applyStockEvent.js` or the event
itself needs to resolve.

**Reversal and `appliedQuantity` (see `domain/stock/applyStockEvent.js` and
`domain/stock/reversal.js`).** An earlier version of this document argued
that reversing a clamped over-removal should add back the event's full
*requested* quantity (e.g. quantity 5, remove 8 → clamped to 0; reverse →
add 8 back → 8). Review caught that this is wrong: it manufactures
inventory that never existed. The requested quantity (8) and the quantity
that actually left the shelf (5, since only 5 were available) are
genuinely different numbers under clamping, and a reversal must undo the
latter, not the former — otherwise pressing "Undo" immediately after a
warned-and-confirmed over-removal would net +3 units out of nowhere.

The fix: `applyStockEvent()` returns `{ nextQuantity, appliedQuantity }`
instead of a bare number. `appliedQuantity` equals `event.quantity` for
ADD (never clamped) and `min(event.quantity, currentQuantity)` for REMOVE
(equal to the requested amount unless clamped). This value is only
knowable at the exact moment an event is applied against a specific
`currentQuantity` — it cannot be recovered from the event alone, since the
event is immutable and only ever records what was *requested*. So whatever
commits a stock event (a repository or service, in Phase 2/3) must retain
`appliedQuantity` alongside the event's id at commit time, and supply it
explicitly when that event is later reversed:
`createReversalEvent(originalEvent, appliedQuantity)`. The reversal event's
own `quantity` is set to `appliedQuantity`, not `originalEvent.quantity`.

Worked example, corrected: quantity 5, REMOVE 8 → `nextQuantity` 0,
`appliedQuantity` 5 (not 8). Reversing that REMOVE with
`appliedQuantity: 5` produces an ADD of 5, restoring quantity to exactly
5 — the true pre-removal state, not 8. The original `StockEvent` still
honestly records `quantity: 8` (the full requested amount) forever;
`appliedQuantity` is never written onto it.

`createReversalEvent()` enforces `0 < appliedQuantity <= originalEvent.quantity`
itself — it does not trust a caller to have upheld that invariant.
`applyStockEvent()` guarantees it on its own output, but `reversal.js` is a
separate public domain boundary; a caller passing an inflated
`appliedQuantity` (whether from a bug or from untrusted data) is rejected
outright rather than silently producing an oversized reversal.

**RESOLVED (Phase 2, `data/db/schema.js`) — where `appliedQuantity` lives
between commit and reversal.** At commit time, `applyStockEvent()`'s return
value is available to whatever called it and `appliedQuantity` can be
captured immediately. But `reversal.js` also has to work for the PRD §15
case — reversing an event from history, potentially much later, possibly
after the app has been closed and reopened, possibly on a different device
entirely after sync. In that case there is no `applyStockEvent()` return
value sitting in memory to reuse; `appliedQuantity` has to be recovered
from *somewhere persisted*.

For an unclamped event this is trivial (`appliedQuantity = event.quantity`
is definitely safe, since the enforced invariant means it's never larger).
The only case that needs real storage is a clamped over-removal. Two
candidate designs were considered:

1. Persist `appliedQuantity` as commit-time metadata alongside the event.
2. Recompute it on demand at reversal time by replaying
   `recomputeQuantityFromEvents()` over the events strictly before the one
   being reversed, to reconstruct what `currentQuantity` was at that
   moment, then deriving `min(event.quantity, thatQuantity)`.

**Decision: option 1.** Implemented as an `appliedQuantity` column on the
Dexie `stockEvents` table itself — NOT as a field on the domain
`StockEvent` shape (`stockEventFactory.js` never produces this field; a
domain `StockEvent` object is exactly the shape that file defines, full
stop). The repository layer writes `appliedQuantity` alongside the rest of
the event fields when it persists a commit, having captured it from
`applyStockEvent()`'s return value at that moment. Reading it back later
(for a PRD §15 historical reversal) is then a single indexed row read, not
a full-history replay.

Why option 1 over option 2: option 2's correctness depends on having the
complete, correctly-ordered event history for that product available
locally at reversal time — true today, but not guaranteed once sync can
deliver partial histories to a device, and replaying is strictly more
expensive for no benefit once we're persisting locally anyway. Option 1 is
deterministic, cheap to read, and doesn't introduce that dependency.

`appliedQuantity` remains a repository/storage-layer concept, not a domain
one — the boundary that made this decision safe to defer past Phase 1 is
exactly the boundary that's preserved now: domain code (stockEventFactory.js,
applyStockEvent.js, reversal.js) still only ever deals with the domain
`StockEvent` shape and explicit `appliedQuantity` parameters; only the
repository (Phase 2, upcoming) is responsible for reading/writing the
extra persisted column.

**AMENDMENT (caught in review before repository implementation began) —
`appliedQuantity` must travel across every persistence boundary that can
serve a later reversal, not just the local one.** The resolution above
justified persisting `appliedQuantity` partly by the PRD §15 scenario of
reversing an event "possibly on a different device entirely after sync" —
but only specified the local Dexie column, leaving the sync payload and
MongoDB schema silently unspecified. That's a real gap: if
`appliedQuantity` isn't included in what gets synced, a device that
receives a stock event via sync (rather than having created it locally)
has no way to correctly reverse a clamped over-removal it didn't witness —
reopening the exact inventory-inflation bug this value exists to prevent,
just moved from "single device, no persistence" to "multi-device, no
sync." Concretely:

```
Device A: REMOVE 8, only 5 available
  applyStockEvent()  -> nextQuantity 0, appliedQuantity 5
  Dexie stockEvents row: { quantity: 8, appliedQuantity: 5, ... }
  syncQueue payload for this row: MUST include appliedQuantity: 5
       |
       v (sync)
  MongoDB stockEvents document: MUST include appliedQuantity: 5
       |
       v (sync)
Device B: receives the event, including appliedQuantity: 5
  Device B's Dexie stockEvents row: { quantity: 8, appliedQuantity: 5, ... }
  Device B can now correctly reverse this event -> restores to 5, not 8
```

So the corrected, general statement of the decision is: **`appliedQuantity`
is commit-time persistence metadata, stored alongside a stock event at
EVERY persistence boundary that must support later reversal** — local
Dexie row, sync queue payload, and remote MongoDB document, all three,
not just the first. It remains absent from exactly one place: the domain
`StockEvent` shape itself (`stockEventFactory.js`'s output). This is
reflected in the MongoDB schema and sync model sections below, and must be
covered by an explicit repository test once `stockEventRepository.js` and
the sync queue exist — a test asserting the queued payload for a stock
event includes `appliedQuantity`, not just that the local Dexie write did.

A `ProductChangeEvent` records **"a device attempted to set field X to
value Y at time T."** It is a historical fact and never changes once
written — including the losing side of a conflict.

`Product[field]` records **"the currently accepted value."** It is the
*result* of applying LWW across whatever `ProductChangeEvent`s exist for
that field, not a separate opinion that happens to usually agree with them.

So: every write to a *tracked* field always produces a `ProductChangeEvent`
(see "Tracked vs. non-tracked Product fields" immediately below — this is
narrower than "every metadata write," which was ambiguous in earlier
drafts of this document). The `accepted` flag on that event says whether
it was the one that ended up determining `Product[field]` at write time.
If a later sync reveals an earlier-clock-but-later-arriving write should
have won, the sync layer updates `Product[field]` and may flip `accepted`
flags accordingly — but it does not delete or edit the losing event's
`oldValue`/`newValue`. See PRD §32: "the earlier change should remain
represented in product-change history."

### Tracked vs. non-tracked Product fields

Two distinct concepts, previously conflated under the single phrase
"metadata write":

- **Product metadata mutation** — any write to any `Product` field via the
  domain's `updateProduct()`. This includes every field on `Product`:
  `name`, `notes`, `marginOverride`, `latestPurchaseDate`, `archived`,
  everything.
- **ProductChangeEvent-tracked field mutation** — a mutation that touches
  one of the fields in the closed `field` union above: `name`, `category`,
  `location`, `tags`, `sellingPrice`, `archived`. Only these produce
  `ProductChangeEvent` records.

A Product metadata mutation that touches only non-tracked fields (e.g. a
`notes`-only edit, or a `marginOverride`-only edit) is legitimate and
**produces zero `ProductChangeEvent` records** — this is not a gap or an
omission, it is the correct behavior for fields PRD §16 / Build Brief §21
do not name as requiring change-history tracking. A repository or service
that received an empty `changeEvents` array for such an edit is behaving
correctly, not skipping a required step.

### Product creation and ProductChangeEvent (V1 scope decision)

Initial Product creation does not generate `ProductChangeEvent` records.
This is an explicit V1 scope decision based on the absence of any
documented creation-event requirement in the PRD or Build Brief — it is
not a derived architectural invariant, and a future version could revisit
it if a "product was created" audit entry becomes a requirement. A
`ProductChangeEvent`'s `oldValue`/`newValue` shape describes a *transition
from* a prior accepted value; a newly created product has no prior
accepted value to transition from, which is the underlying reason this
reads naturally as out of scope rather than an oversight.

### Atomicity of Product state mutations and their ProductChangeEvents

A `Product` state mutation and every `ProductChangeEvent` it produces
(zero or more, per "Tracked vs. non-tracked" above) are committed in a
single Dexie transaction, together with their corresponding `syncQueue`
entries. This applies the same reasoning already established for stock
commits (see "Stock-event commit atomicity" below): `Product[field]` is
defined as the *derived result* of applying LWW across its
`ProductChangeEvent`s, so a `Product` row must never be persisted without
the event(s) that justify its tracked-field values, and neither may exist
in the sync queue without the other. All writes in the transaction succeed
together or fail together; there is no code path where the `products` row
updates but a corresponding tracked-field `ProductChangeEvent` silently
does not, or vice versa.

### Why cost/margin fields are derived, not stored

PRD §17 and §20 are explicit that the average cost and margin are
*calculated*, and that the selling price is the only authoritative,
manually-controlled value. Storing derived numbers invites drift between the
stored value and the event history that should produce it. Domain functions
recompute them from `StockEvent[]` on read; if this becomes a performance
issue at scale we can memoize per-product, but correctness comes first.

**Terminology note:** "average known cost" here is a practical
shop-management figure, not an accounting inventory-valuation method. We
are explicitly *not* implementing FIFO, LIFO, or weighted-average-cost
accounting — just "what have I generally been paying," per PRD §17. If a
future requirement needs real inventory accounting, that's a distinct
feature, not an extension of this calculation.

## Search, related results, filters, and voice input (Phase 4)

These four sub-phases share one governing rule, established in 4A and
never broken across 4B/4C/4D: **`frontend/src/domain/search/
productSearch.js` is the only place fuzzy-matching logic lives, and it
stays browser/React/Dexie-independent.** Everything added in 4B/4C/4D was
designed specifically to avoid needing a second Fuse instance, a second
search pipeline, or any change to that file's public contract unless the
matching semantics themselves were what changed (only true for 4B).

### Related results are an aggregate pool, not per-candidate scoring

4B's relatedness model derives one shared metadata pool — categories,
tags, and locations unioned across ALL of `matches` together — rather
than scoring each candidate against its single closest match. This was
an explicit, deliberate rejection of the more "sophisticated"-sounding
per-candidate approach: it keeps the ranking fully deterministic (no
Fuse scores involved), keeps the whole related-results computation inside
one pure function (`deriveRelated()`), and avoids building anything that
could be mistaken for a recommendation engine. Ranking is a strict
four-tier ordinal comparison — shared category (boolean) → shared-tag
count → shared-location count → stable original order — never a weighted
numeric formula.

### Filters apply to `Product[]`, upstream of the searchable projection

4C's classification filters (category/location/tag) are applied to the
raw, ID-bearing `Product[]` list — comparing `product.categoryId`/
`locationIds`/`tagIds` directly — **before** `productService.js` builds
the transient `SearchableProduct` projection and before Fuse ever runs.
This was chosen over filtering resolved display names (fragile against
renames and archived/active name collisions) and over filtering `matches`
after the fact (would desynchronize `hasExactMatch` from what the UI
shows, and would need `deriveRelated()`'s aggregate pool re-derived from
a since-filtered set). Because filters shrink the candidate array itself,
related results are automatically filter-consistent as a structural
consequence — not a second filtering pass bolted onto `deriveRelated()`.

### Voice search is an input adapter, not a second search path

4D's `frontend/src/hooks/useSpeechRecognition.js` is the one place in the
codebase that touches the Web Speech API directly — the same "one place
owns this browser concern" pattern already used for Dexie
(`data/db/schema.js`). It has no knowledge of search, filters, or the
product domain at all: it exposes a final, trimmed transcript, and
`ProductListPage.jsx` feeds that transcript into the exact same
`setQuery()` the text input already calls. There is deliberately no
separate voice-query state, no separate debounce path, and no
voice-aware branch anywhere in `productService.js` or `productSearch.js`.

## IndexedDB schema (Dexie)

```js
db.version(1).stores({
  products:             'id, name, categoryId, archived, updatedAt',
  stockEvents:          'id, productId, recordedAt, reversalOf',
  productChangeEvents:  'id, productId, timestamp',
  categories:            'id, archived',
  locations:              'id, archived',
  tags:                    'id, archived',
  units:                    'id, archived',
  photos:                    'id',                 // blob store, keyed by photoRef
  syncQueue:                  '++localId, entityType, entityId, status, createdAt',
  session:                     'key'                // single-row trusted-device token
});
```

`stockEvents` rows also carry an `appliedQuantity` column, unindexed
(never queried by value, only read alongside the rest of the row) — see
"RESOLVED... where `appliedQuantity` lives between commit and reversal"
below for why. `reversalOf` is indexed to make "find the reversal event
for event X" a fast lookup rather than a full table scan.

Note `stockEvents`/`productChangeEvents` no longer index `syncStatus` —
that field doesn't exist on them (see "Events vs. sync state" above). Sync
progress is queried from `syncQueue` instead, joined by `entityId` when
needed.

Compound/secondary indexes are deliberately minimal at v1 — Dexie table
scans over a small shop's inventory (hundreds, not millions, of products)
are fast enough. We will add indexes only if profiling says so (Rule 2:
no abstraction without a concrete reason).

### Schema migrations are mandatory from day one

IndexedDB will hold a real shop's real data, potentially months of stock
history, on a single phone with no automatic backup. Losing or corrupting it
during a schema change is not an acceptable failure mode. So, starting from
the very first Dexie store definition:

- Every schema change is a new `db.version(n)` block, never an edit to an
  existing `version()` call. `version(1)` above is permanent once shipped.
- Each version bump that changes stored shape (not just adding an index)
  includes an `.upgrade(tx => ...)` migration function, even if that
  function currently does nothing but exists as a placeholder — this keeps
  the pattern consistent so nobody forgets to add one when it's actually
  needed.
- Migrations live in `frontend/src/data/db/schema.js` with one clearly
  version-numbered block per change, plus a comment describing *why* the
  version changed.
- Before Phase 2 ships the first real `db.version(1)`, we write a short test
  that opens the DB, seeds representative rows, and confirms the schema
  matches expectations — this becomes the harness later versions' upgrade
  functions are tested against. DONE: see
  `frontend/tests/data/db/schema.test.js`.

## Stock-event commit atomicity (repository contract, binding before `stockEventRepository.js` is written)

Committing a stock event is not one write — it is three, and they must
succeed or fail together:

```
transaction
├── stockEvents.put({ ...domainEvent, appliedQuantity })
├── products.put({ ...product, quantity: nextQuantity })
└── syncQueue.add({ entityType: 'stockEvent', payload: { ...domainEvent, appliedQuantity }, ... })
```

If these are three independent writes rather than one Dexie transaction,
a failure partway through produces exactly the kind of silent corruption
Phase 1 was built to prevent one layer up — e.g. the event is saved but
the product's materialized quantity is never updated, so the UI shows
stale stock; or the event and quantity are both saved but the sync queue
entry is lost, so the event never leaves the device and a reversal
performed on another device later has no idea this removal ever happened.

`stockEventRepository.js`'s commit function MUST wrap all three writes in
a single Dexie transaction (`db.transaction('rw', db.stockEvents,
db.products, db.syncQueue, async () => { ... })`), and repository tests
must include a case that simulates a failure partway through (e.g. the
product write rejecting) and asserts that NONE of the three writes were
left in place — not just that the whole operation returned an error.

The same requirement applies to reversal commits (event write + product
quantity update + original event's `reversedBy` patch + sync queue entry
for the reversal, and — since sync must carry `appliedQuantity` per the
amendment above — the reversal's own sync payload needs no
`appliedQuantity` of its own if it is itself unclamped, but any reversal
of a REMOVE built from a prior clamped `appliedQuantity` still carries the
same requirement forward if it is later reversed again, per reversal.js's
"reversals are themselves reversible" design).

## MongoDB schema

Mirrors the domain model closely. Single-tenant (one shop account), so no
`shopId` partitioning in v1. Documents are keyed by `entityId` — the
stable identity of the target entity (e.g. `Product.id`) — not by
`clientId`. See "entityId vs. clientId" below for why these must not be
conflated: `clientId` identifies one sync mutation attempt and is not
safe as a document key for entities that can be upserted more than once.

- `products` — upserted by `entityId`, last-write-wins per field via
  `updatedAt` comparison done in the sync controller. Stored `quantity` is
  the materialized value — server does not independently derive it from
  `stockEvents` on every read, but a reconciliation job/endpoint may
  recompute it from the event collection if drift is ever suspected.
- `stockEvents` — insert-only. Server rejects/ignores duplicate `clientId`.
  No `syncStatus`-equivalent field server-side either; a document existing
  in this collection simply means it has synced. Also stores
  `appliedQuantity` alongside the domain event fields (see "AMENDMENT...
  `appliedQuantity` must travel across every persistence boundary," above)
  — this is NOT optional or best-effort: without it, a device that
  receives this event via sync (rather than having created it locally)
  has no way to correctly reverse it later if it was a clamped
  over-removal, which reopens the exact inventory-inflation bug that
  `appliedQuantity` exists to prevent. Mongo's copy of a `stockEvents`
  document is therefore not a pure mirror of the domain `StockEvent`
  shape — it's the domain fields plus this one piece of commit-time
  persistence metadata, exactly matching what the local Dexie row stores.
- `productChangeEvents` — insert-only, same dedup strategy. Carries
  `accepted` (see "Metadata conflict semantics"), which is intended to
  represent whether a given write is the currently-authoritative value on
  its Product versus one that lost a later-arriving-but-earlier-timestamped
  LWW conflict. **As implemented in Phase 5F, this field is insert-only,
  not yet updatable:** the server always sets `accepted: true` at insert
  time, and the endpoint rejects any client-supplied `accepted` key at
  all (including an explicit `accepted: true` matching what the server
  would set), using the same presence-based rejection pattern as
  `Product.quantity` and `StockEvent.appliedQuantity`. No code path
  currently updates an already-inserted event's `accepted` value. The
  LWW-driven mutation described above — flipping an earlier write's
  `accepted` to `false` once a later-timestamped write for the same
  field arrives — is deferred to **Phase 6**, where it would become the
  one narrowly-scoped exception to "events are never mutated." Until
  then, do not read this bullet as describing current behavior.
- `categories` / `locations` / `tags` / `units` — upserted by `entityId`,
  for the same reason as `products` above. Implemented in Phase 5C via one
  shared schema factory (`classificationModel.js`) producing four separate
  models/collections with the identical shape (`_id`/`ownerId`/`name`/
  `archived`/`isDefault`/`updatedAt`), rather than four duplicated schemas
  or one polymorphic collection with a `type` discriminator.
- `users` — single document in v1, holds bcrypt hash + refresh token records.

### Ownership-scoped upsert safety (binding pattern, established Phase 5C)

Any entity that is (a) upserted by a client-generated `entityId` and (b)
scoped to an owner must guard against a specific failure mode: an update
filter that matches on `_id` alone (ignoring `ownerId`) would let one
owner silently overwrite another owner's document simply by submitting
that document's `entityId`.

**The fix:** the update filter must match on `{ _id: entityId, ownerId }`
together, never `_id` alone. If `entityId` already exists under a
*different* owner, this filter matches nothing — so Mongo's upsert
attempts an **insert** with that `_id`, which collides with the existing
document and throws a duplicate-key error (Mongo code `11000`) rather than
silently overwriting or silently no-oping. The service layer catches that
specific error and translates it into an explicit `CONFLICT` (409)
response — never a generic 500, never a silent success.

This is not specific to classifications. **The same pattern is binding for
`products` in Phase 5D and any other client-generated-`entityId` +
ownership-scoped collection added later.**

### URL-vs-body identity rule (binding pattern, established Phase 5C)

For any `PUT /:id` upsert endpoint, the persisted `_id` always comes from
the URL parameter, never from the request body. If the body includes an
`id` field:

- absent → allowed, no `id` required in the body
- matches the URL `id` → allowed
- disagrees with the URL `id` → rejected with `VALIDATION_ERROR`

Silently ignoring a mismatched body `id` was considered and rejected: it
would mask a real client or sync bug rather than surfacing it. This rule
applies to any future `PUT /:id`-style upsert endpoint (Product, Phase 5D)
for the same reason.

### Server-side quantity mutation transaction (binding pattern, established Phase 5E)

`Product.quantity` has exactly one backend-controlled mutation path:
`PUT /api/stock-events/:id`. The generic Product endpoint (`PUT
/api/products/:id`, Phase 5D) permanently and unconditionally rejects a
`quantity` key in its payload — checked by property presence via
`Object.hasOwn()`, not truthiness, so `quantity: 0` is rejected exactly
like any other value.

The server computes quantity itself, authoritatively — it does not trust
a client-supplied resulting quantity via any path. This is a deliberate
resolution of a real tension: the client's own sync queue emits a
`stockEvent` insert AND a separate `product` upsert (carrying the
resulting quantity) as two independent sync operations. Reconciling that
separately-queued client-computed quantity against the server's
authoritative value is a Phase 6 sync-contract concern; Phase 5E does not
weaken the Product-endpoint quantity boundary to accommodate it.

**Transaction ordering is binding, not incidental — reordering these
steps reopens a specific retry-breaking bug:**

```
1. idempotency check       -- existing StockEvent for {_id, ownerId}?
                               YES -> return immediately, no mutation.
2. load owned Product      -- {_id: productId, ownerId}. Missing -> NOT_FOUND.
3. expectedCurrentQuantity check -- mismatch -> QUANTITY_CONSISTENCY_CONFLICT.
4. reversal validation, if reversalOf present (see below)
5. compute appliedQuantity + nextQuantity
6. insert StockEvent
7. update Product.quantity
8. if reversal, patch original.reversedBy
```

Idempotency must run **before** the concurrency check. A successful
request advances `product.quantity` away from whatever
`expectedCurrentQuantity` the client sent; if the client retries with the
same event id and its now-stale `expectedCurrentQuantity` after a lost
response, checking concurrency first would reject a request whose effects
already fully committed — rejecting the exact retry behavior a reliable
client is supposed to perform.

**Reversal requires three separate server-side invariants, not merely
"the original exists and isn't already reversed":**

1. `payload.quantity === originalEvent.appliedQuantity` — server-derived
   authority; the client's submitted quantity is validated against, never
   trusted over, the original's persisted `appliedQuantity`. This is what
   prevents a reversal of a clamped over-removal from restoring the
   originally *requested* quantity rather than what actually applied.
2. `payload.type` is the opposite of `originalEvent.type` (`ADD` reverses
   to `REMOVE` and vice versa). Quantity-matching alone is insufficient —
   a same-type "reversal" with a matching quantity would double the
   original movement instead of undoing it.
3. `payload.productId === originalEvent.productId` — a reversal targeting
   a different product than the event it claims to reverse would mutate
   the wrong product's inventory while marking the unrelated original as
   reversed.

Writes inside the transaction (`Product.quantity`, `reversedBy`) check
`matchedCount === 1` explicitly rather than assuming a write matched a
document because an earlier read inside the same transaction succeeded —
inventory-mutation code fails loudly on an unexpected zero-match write
rather than silently trusting it.

`appliedQuantity` is exclusively server-computed at commit time; a
`changeEvents`-style rejection guard applies here too — a request body
containing `appliedQuantity` (any value, including a value that happens
to match what the server would have computed) is rejected with
`VALIDATION_ERROR`, never silently accepted or overwritten.

### ProductChangeEvent persistence is validation-only (binding pattern, established Phase 5F)

`PUT /api/product-change-events/:id` accepts an already-fully-constructed
event from the client — the client builds `ProductChangeEvent` objects
itself (comparing old/new Product state locally) and submits them as a
separate sync operation from the corresponding `product` upsert. This
endpoint's Product lookup exists **strictly to verify** that the
referenced Product exists and is owned by the caller (`NOT_FOUND`
otherwise, indistinguishable from "doesn't exist," consistent with every
other cross-owner boundary in this project). It is binding that this
lookup never goes further than that: it must not mutate the Product,
must not compare the event's `oldValue`/`newValue` against the Product's
actual current field values, and must not recompute or second-guess the
change being recorded. A server that infers, diffs, or reconstructs a
client-owned historical decision is the specific failure mode an earlier
Phase 5D draft fell into (see that phase's own note above) and re-opening
it here — even narrowly, even "just to double-check" — is out of scope
for any future change to this endpoint unless explicitly re-litigated.

**Idempotency check runs before the Product lookup**, for the same
retry-safety reason as Phase 5E's stock-event ordering: if the Product
lookup ran first, a retry of an event whose first attempt already
succeeded — but whose referenced Product has since been deleted by an
unrelated later action — would incorrectly fail with `NOT_FOUND` instead
of returning the already-persisted event as a no-op. (An archived Product
still exists and is still returned by this lookup — the lookup filters
only on `{_id, ownerId}`, not `archived` — so archival alone does not
trigger this scenario; only actual deletion does.)
This is proven, not merely asserted, by a test that deletes the
referenced Product after a successful first write and confirms a retry
with the same event id still succeeds as a no-op.

## Sync model

`SyncQueueEntry` is the **only** place sync/transport state is tracked.
Domain tables (`stockEvents`, `productChangeEvents`, `products`, etc.) never
carry a `syncStatus` field themselves — see "Events vs. sync state" above.

```
SyncQueueEntry
  localId       auto-increment (local only, never synced)
  entityType     'stockEvent' | 'productChangeEvent' | 'product' |
                  'category' | 'location' | 'tag' | 'unit'
  entityId        string (stable identity of the target entity, e.g.
                    Product.id — see "entityId vs. clientId" below)
  operation        'insert' | 'upsert'
  payload           the data to send
  clientId          string (unique identity of THIS mutation/sync
                    operation — see "entityId vs. clientId" below)
  attempts          number
  status             'pending' | 'syncing' | 'done' | 'failed'
  createdAt          ISO datetime
  lastError           string | null
```

### `entityId` vs. `clientId`

These are two different identities and must not be conflated:

- **`entityId`** — the stable identity of the *target entity* being
  synchronized. For a `Product` mutation, `entityId = product.id`, always,
  regardless of how many times that product is subsequently mutated. This
  is what the server upserts/inserts against as the document key.
- **`clientId`** — the unique identity of *this particular sync mutation*
  (this one queue entry / one sync attempt). Its job is retry-safety: if
  the same queue entry is redelivered after a dropped response, the
  server recognizes the same `clientId` and treats it as a no-op rather
  than reapplying the mutation.

For **insert-only, additive entities** (`StockEvent`, `ProductChangeEvent`),
one event record represents exactly one mutation and is never re-enqueued
to represent a different mutation, so `clientId = entityId = event.id` is
correct and safe.

For **state/upsert entities** (`Product`, `Category`, `Location`, `Tag`,
`Unit`), the same entity can legitimately be mutated multiple times —
e.g. a `Product` renamed, then re-priced, then archived, produces three
separate `syncQueue` entries, all with `entityId = product.id` but each
needing its own **freshly generated `clientId`**. Reusing `product.id` as
`clientId` across these three entries would be wrong: it would let the
server's idempotency check mistake the second and third mutations for
retries of the first, silently dropping real changes. So for `upsert`
operations, `clientId` must be generated fresh per queue entry (via the
same `generateId()` helper used elsewhere), never copied from `entityId`.

Two mutation shapes, matching PRD §31/§32:

1. **Additive** (`StockEvent`, `ProductChangeEvent`): queued with
   `operation: 'insert'`, `clientId = entityId = event.id`. Deduplicated
   server-side by `clientId` so re-delivery is a no-op — this is what
   makes the queue safe to retry after a dropped response. For a
   `stockEvent` entry specifically, the queued `payload` is the domain
   event fields PLUS `appliedQuantity` PLUS `expectedCurrentQuantity` —
   never the domain event alone. Both are storage-layer fields, absent
   from the domain `StockEvent` shape itself:
   - `appliedQuantity` is a hard requirement, not an optimization: a
     `stockEvent` synced without it leaves any device that later
     receives it via sync unable to correctly reverse a clamped
     over-removal, silently reintroducing the inventory-inflation bug
     `appliedQuantity` exists to prevent (see the "AMENDMENT" in the
     `Product.quantity` section above).
   - `expectedCurrentQuantity` is the `Product.quantity` value the
     operation was actually committed against, captured once at commit
     time and never recomputed — the Phase 5 backend's
     `PUT /api/stock-events/:id` requires it on every request, and a
     retry must resend the exact originally-captured value (see
     "Phase 6A — sync wire-contract repair" below).
   The repository that builds this queue entry is responsible for
   including both fields every time, and repository tests must assert
   this explicitly — confirmed as a real, previously-missing gap during
   Phase 6 Pass 1 and fixed in Phase 6A.
2. **State** (`Product`, `Category`, `Location`, `Tag`, `Unit`): queued
   with `operation: 'upsert'`, `entityId = <entity>.id`, `clientId` freshly
   generated per entry (see "entityId vs. clientId" above — never reused
   from `entityId`), carrying `updatedAt`. Server applies last-write-wins
   by comparing `updatedAt` timestamps, upserting by `entityId`. A write
   that loses the comparison is *not* discarded — the client that lost
   still has a `ProductChangeEvent` recording what it tried to set (with
   `accepted: false`), per PRD §32 ("the earlier change should remain
   represented in product-change history"). **This LWW comparison and the
   `accepted: false` write-back are design intent, not yet built** — see
   the Phase 5F entry in `PROGRESS.md` and "Phase 6A" below for the
   current, verified state of `accepted`.

**The sync engine itself — the component that would drain this queue in
order, retry with backoff on failure, and mark entries `done` after a
confirmed server response — does not exist yet.** This paragraph
describes the intended eventual behavior, confirmed absent by a direct
repository search during Phase 6 Pass 1 (no queue processor, no retry
logic, no `status` transition anywhere in the codebase — every queue
entry is written once as `pending` and never touched again). Do not read
this section as describing current behavior. Querying "has event X synced
yet" would eventually be answered by looking up its `syncQueue` entry by
`entityId`, not by reading a field on the event itself — but nothing
currently performs that query either.

### Sync wire-request translation — `syncRequest.js` (Phase 6A)

Before a queue entry can be sent anywhere, its local representation must
be translated into a request the Phase 5 backend will actually accept.
Phase 6 Pass 1's audit found — and Phase 6A fixed — three real mismatches
between what repositories queue locally and what each backend endpoint's
validator requires:

| entityType | queued locally | backend requires/rejects |
|---|---|---|
| `product` | includes `quantity` | rejects `quantity` by presence, always (`assertNoQuantityInPayload`) |
| `stockEvent` | includes `appliedQuantity`; was missing `expectedCurrentQuantity` | rejects `appliedQuantity` by presence, always (`assertNoAppliedQuantityInPayload`); requires `expectedCurrentQuantity` |
| `productChangeEvent` | includes `accepted: true` | rejects `accepted` by presence, always, including `true` (`assertNoAcceptedInPayload`) |

The fix is deliberately **not** to change what repositories persist
locally — `quantity`, `appliedQuantity`, and `accepted` all remain in the
queue entry's `payload` exactly as before, because local reversal
correctness and local audit display both need them. Instead,
`frontend/src/data/sync/syncRequest.js` exports one pure function:

```js
createSyncRequest(entry) → { method, path, body }
```

It owns entity-type routing, HTTP method mapping, endpoint-path
construction (always keyed by `entityId`, never `clientId`), and
wire-payload serialization — stripping exactly the three fields above for
their respective entity types, passing classification payloads through
unchanged (confirmed to already match their backend contract, no
stripping needed), and leaving `expectedCurrentQuantity` untouched so a
retry resends the exact value captured at commit time rather than a
freshly-read one. It does not execute HTTP requests, drain the queue,
retry, or make any conflict-resolution decision — those remain later
Phase 6 passes. It never mutates the queue entry or its payload; it only
reads and returns a new object.

**Reversal convergence note (Phase 6B0):** a reversal `stockEvent` queue
entry needs no special handling beyond the above — it carries
`reversalOf` like any other field, unstripped, and the backend's
`PUT /api/stock-events/:id` transaction (see "StockEvent transaction
ordering" above) derives and persists the original event's `reversedBy`
from that field server-side, atomically with the reversal event's own
insert. This was verified end-to-end from source, not assumed; see
`docs/PROGRESS.md`'s Phase 6B0 entry for the full trace. No separate
queue-entry type or client-side `reversedBy` synchronization exists or is
needed.

## Photo storage — provider abstraction

The PRD's zero-cost target (§40) and the architecture's use of a specific
example provider (Cloudinary) are two different concerns and shouldn't be
coupled. The domain layer and sync engine must never import a specific
storage SDK directly.

```
domain/ and data/sync/
        ↓ depends on (interface only)
PhotoStorage                      — abstract interface:
  save(localPhotoId, blob)          store a photo, return a reference
  getUrl(remoteRef)                  resolve a reference to a fetchable URL
  delete(remoteRef)

data/photos/
  LocalPhotoRepository.js           — IndexedDB blob store (`photos` table)
  RemotePhotoStorage.js             — interface above, implemented by:
    providers/CloudinaryPhotoStorage.js   (or whatever we pick later)
```

The sync engine only ever calls the `PhotoStorage` interface. Swapping
Cloudinary for another free-tier provider (or a self-hosted option) later
means writing one new file under `providers/`, not touching sync or domain
code. `docs/ARCHITECTURE.md`'s earlier mention of Cloudinary is an example
of a possible provider, not a hard dependency.

## Authentication

- Backend issues a short-lived JWT (access) + a long-lived opaque refresh
  token (stored hashed, server-side, revocable, one row per trusted device).
  **Confirmed against source (Phase 6B1): access token expiry 15 minutes,
  refresh token expiry 90 days (shipped `.env.example` defaults); refresh
  rotation is one-time-use — every successful `/refresh` call atomically
  removes the presented token and issues a new one, so the previous
  refresh token is immediately dead once rotated.**
- Frontend keeps the JWT in memory only. The refresh token is stored in
  IndexedDB (`session` table) rather than `localStorage` — avoids XSS-read
  exposure and keeps it alongside the rest of the offline-capable state.
  **This storage-location design is intent, not yet implemented or
  verified against frontend code — `frontend/src/auth/` and the `session`
  table are both still empty/unused as of Phase 6B1. Treat this bullet as
  the plan for Phase 6B2 to lock, not as a currently-built fact.**
- A "trusted device" is simply a device holding a valid, unrevoked refresh
  token. It does not need to contact the server to keep working offline —
  only the *next sync attempt* will discover if the token was revoked.
- **Password change and token invalidation timing (corrected, Phase
  6B1):** password change revokes all refresh tokens immediately, in one
  atomic update. It does **not** invalidate any access token already
  issued before the change — `requireAuth` verifies access tokens
  statelessly (JWT signature/expiry only, confirmed zero database reads
  per ordinary request), so a device holding a still-valid access token
  may continue making authenticated requests normally for up to the
  remainder of that token's 15-minute window, entirely unaffected by the
  password change. The password change only becomes observable to that
  device once its access token expires and it attempts to refresh: the
  refresh call fails against the now-revoked/removed refresh token
  (`401 UNAUTHORIZED`), and at that point the frontend must require
  re-login before any further sync, per PRD §35. Local data and offline
  usage remain available throughout, regardless of this token state.

## Assumptions made where the spec was silent

These were flagged before building and we're proceeding with them by
default; revisit any of them at any time:

1. **Average known cost** is computed across *all-time* recorded-cost stock
   additions (not just currently in-stock units) — matches the worked
   example in PRD §17 directly. This is a practical shop metric, not
   accounting inventory valuation (no FIFO/LIFO/weighted-average-cost).
2. **Reversals are themselves reversible.** Keeps the mental model uniform
   ("every event can be reversed") rather than adding a special case.
3. **Photos**: compressed blob stored locally in IndexedDB (`photos` table)
   for offline-first use; on sync, uploaded via a `PhotoStorage` interface
   to a free-tier object storage provider (see "Photo storage — provider
   abstraction"), rather than embedded in MongoDB documents, to keep
   documents small and stay within the zero-cost target (PRD §40). Only a
   reference URL is stored server-side once uploaded. The specific provider
   is an implementation detail behind the interface, not an architectural
   commitment.
4. **Multi-select tag filters combine as OR within the group** (any
   selected tag matches), mirroring the same OR-within-group treatment
   used for multi-select location filters. The PRD's own filter example
   (§25) only ever shows one tag selected at a time, so there's no direct
   textual basis either way — this was reasoned by consistency with
   locations rather than cited directly, and is the one Phase 4C
   semantic decision without a PRD citation behind it.
5. **Voice search uses `continuous: false` and `interimResults: false`**
   — single-utterance recognition, final transcript only. The PRD's
   sketch (`🔍 Search` / `🎤`) doesn't specify either behavior; this was
   read as the simplest interpretation of "voice input should populate
   the normal search field" as one discrete action, rather than a
   live-transcription UX the spec never describes.

## Phase 0.5 — architecture correction log

Before Phase 1 implementation began, a review pass caught several places
where the initial design risked two competing sources of truth. Corrections
made, all reflected in the sections above:

1. Removed `syncStatus` from `StockEvent`/`ProductChangeEvent` — sync state
   now lives exclusively in `SyncQueueEntry`, keeping event tables genuinely
   immutable.
2. Made `Product.quantity` explicitly a materialized projection of the
   `StockEvent` stream, owned by exactly one function
   (`domain/stock/applyStockEvent.js`), never written directly elsewhere.
3. Formalized metadata conflict semantics: `ProductChangeEvent` = "what was
   attempted," `Product[field]` = "what's currently accepted" — distinct
   concepts, not two copies of the same fact.
4. Introduced the `PhotoStorage` interface so no specific provider (e.g.
   Cloudinary) is hardwired into domain or sync code.
5. Made Dexie schema migrations mandatory from `version(1)` onward, with a
   test harness requirement before Phase 2 ships the first real schema.

No PRD requirements changed — this was purely tightening the technical
design underneath them, per Build Brief Rule 10 (changes to *product*
requirements need explicit identification; this is an implementation-detail
correction, not a product-requirements change).

## Testing strategy

- `frontend/tests/domain/` — pure unit tests for domain logic (Vitest).
  No DOM, no IndexedDB, no network — these should run in milliseconds.
- Repository/sync/integration tests come later (Phase 6+) once there's a
  real IndexedDB (fake-indexeddb in test env) and API to test against.
- Backend tests live in `backend/tests/`, using an in-memory or ephemeral
  MongoDB instance.

## Build phases

See `docs/PROGRESS.md` for the live phase checklist.
