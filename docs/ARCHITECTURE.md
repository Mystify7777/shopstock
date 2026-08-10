# ShopStock — Architecture

This document is the technical companion to `PRD.md` and `BUILD_BRIEF.md`. It
records the concrete decisions made while translating the spec into code, and
the assumptions made where the spec was silent.

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
                                     'tags' | 'sellingPrice' | ...)
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

**OPEN ARCHITECTURE QUESTION, not yet resolved — where does `appliedQuantity`
live between commit and reversal?** At commit time, `applyStockEvent()`'s
return value is available to whatever called it and `appliedQuantity` can
be captured immediately. But `reversal.js` also has to work for the PRD §15
case — reversing an event from history, potentially much later, possibly
after the app has been closed and reopened, possibly on a different device
entirely after sync. In that case there is no `applyStockEvent()` return
value sitting in memory to reuse; `appliedQuantity` has to be recovered
from *somewhere persisted*.

For an unclamped event this is trivial (`appliedQuantity = event.quantity`
is definitely safe, since the enforced invariant means it's never larger).
The only case that needs real storage is a clamped over-removal. Two
candidate designs, deliberately NOT decided here:

1. Persist `appliedQuantity` as commit-time metadata alongside the event
   (a sibling record/column, not a field on the immutable `StockEvent`
   itself — e.g. something like a `StockEventCommit` table keyed by event
   id), written once at commit time, read at reversal time.
2. Recompute it on demand at reversal time by replaying
   `recomputeQuantityFromEvents()` over the events strictly before the one
   being reversed, to reconstruct what `currentQuantity` was at that
   moment, then deriving `min(event.quantity, thatQuantity)`.

Option 1 is cheaper to read but adds a new persisted concept. Option 2
needs no new storage but is more expensive and depends on having the full,
correctly-ordered event history available locally at reversal time (true
today, but worth re-checking once sync can deliver partial histories).
This decision is deferred to Phase 2/3, when the repository and sync
design make the storage tradeoffs concrete — it should not be guessed at
here in the domain layer. Tracked in `docs/PROGRESS.md` as open work.

A `ProductChangeEvent` records **"a device attempted to set field X to
value Y at time T."** It is a historical fact and never changes once
written — including the losing side of a conflict.

`Product[field]` records **"the currently accepted value."** It is the
*result* of applying LWW across whatever `ProductChangeEvent`s exist for
that field, not a separate opinion that happens to usually agree with them.

So: every metadata write always produces a `ProductChangeEvent`. The
`accepted` flag on that event says whether it was the one that ended up
determining `Product[field]` at write time. If a later sync reveals an
earlier-clock-but-later-arriving write should have won, the sync layer
updates `Product[field]` and may flip `accepted` flags accordingly — but it
does not delete or edit the losing event's `oldValue`/`newValue`. See PRD
§32: "the earlier change should remain represented in product-change
history."

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

## IndexedDB schema (Dexie)

```js
db.version(1).stores({
  products:             'id, name, categoryId, archived, updatedAt',
  stockEvents:          'id, productId, recordedAt',
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
  functions are tested against.

## MongoDB schema

Mirrors the domain model closely. Single-tenant (one shop account), so no
`shopId` partitioning in v1. `clientId` (the same id generated on-device) is
the stable identity used for idempotent upserts/inserts.

- `products` — upserted by `clientId`, last-write-wins per field via
  `updatedAt` comparison done in the sync controller. Stored `quantity` is
  the materialized value — server does not independently derive it from
  `stockEvents` on every read, but a reconciliation job/endpoint may
  recompute it from the event collection if drift is ever suspected.
- `stockEvents` — insert-only. Server rejects/ignores duplicate `clientId`.
  No `syncStatus`-equivalent field server-side either; a document existing
  in this collection simply means it has synced.
- `productChangeEvents` — insert-only, same dedup strategy. Carries
  `accepted` (see "Metadata conflict semantics") which *can* be updated
  after the fact if a later-arriving-but-earlier-timestamped write changes
  which record is authoritative — this is the one exception to "events are
  never mutated," and it's narrowly scoped to this single boolean flag.
- `categories` / `locations` / `tags` / `units` — upserted by `clientId`.
- `users` — single document in v1, holds bcrypt hash + refresh token records.

## Sync model

`SyncQueueEntry` is the **only** place sync/transport state is tracked.
Domain tables (`stockEvents`, `productChangeEvents`, `products`, etc.) never
carry a `syncStatus` field themselves — see "Events vs. sync state" above.

```
SyncQueueEntry
  localId       auto-increment (local only, never synced)
  entityType     'stockEvent' | 'productChangeEvent' | 'product' |
                  'category' | 'location' | 'tag' | 'unit'
  entityId        string (the clientId of the affected record)
  operation        'insert' | 'upsert'
  payload           the data to send
  clientId          string (idempotency key — same as entityId for inserts)
  attempts          number
  status             'pending' | 'syncing' | 'done' | 'failed'
  createdAt          ISO datetime
  lastError           string | null
```

Two mutation shapes, matching PRD §31/§32:

1. **Additive** (`StockEvent`, `ProductChangeEvent`): queued with
   `operation: 'insert'`. Deduplicated server-side by `clientId` so
   re-delivery is a no-op — this is what makes the queue safe to retry
   after a dropped response.
2. **State** (`Product`, `Category`, `Location`, `Tag`, `Unit`): queued with
   `operation: 'upsert'`, carrying `updatedAt`. Server applies last-write-wins
   by comparing `updatedAt` timestamps. A write that loses the comparison is
   *not* discarded — the client that lost still has a `ProductChangeEvent`
   recording what it tried to set (with `accepted: false`), per PRD §32
   ("the earlier change should remain represented in product-change
   history").

The sync engine drains the queue in order, retries with backoff on failure,
and marks entries `done` only after a confirmed server response. Querying
"has event X synced yet" is answered by looking up its `syncQueue` entry by
`entityId`, not by reading a field on the event itself.

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
- Frontend keeps the JWT in memory only. The refresh token is stored in
  IndexedDB (`session` table) rather than `localStorage` — avoids XSS-read
  exposure and keeps it alongside the rest of the offline-capable state.
- A "trusted device" is simply a device holding a valid, unrevoked refresh
  token. It does not need to contact the server to keep working offline —
  only the *next sync attempt* will discover if the token was revoked.
- Password change → server revokes all refresh tokens → every device's next
  sync attempt gets 401 → frontend prompts re-login before further sync,
  per PRD §35. Local data and offline usage remain available regardless.

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
