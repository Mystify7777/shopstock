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
  quantity               number          (decimal-capable)
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
  syncStatus                'pending' | 'synced' | 'failed'

ProductChangeEvent
  id                      string
  productId                string
  field                    string  ('name' | 'category' | 'location' |
                                     'tags' | 'sellingPrice' | ...)
  oldValue                 any
  newValue                 any
  timestamp                 string (ISO datetime)
  syncStatus                 'pending' | 'synced' | 'failed'

Category / Location / Tag / Unit
  id, name, archived, isDefault

User (backend only)
  id, username, passwordHash, refreshTokens: [{ tokenHash, deviceLabel,
  createdAt, revoked }]
```

### Why cost/margin fields are derived, not stored

PRD §17 and §20 are explicit that the average cost and margin are
*calculated*, and that the selling price is the only authoritative,
manually-controlled value. Storing derived numbers invites drift between the
stored value and the event history that should produce it. Domain functions
recompute them from `StockEvent[]` on read; if this becomes a performance
issue at scale we can memoize per-product, but correctness comes first.

## IndexedDB schema (Dexie)

```js
db.version(1).stores({
  products:             'id, name, categoryId, archived, updatedAt',
  stockEvents:          'id, productId, recordedAt, syncStatus',
  productChangeEvents:  'id, productId, timestamp, syncStatus',
  categories:            'id, archived',
  locations:              'id, archived',
  tags:                    'id, archived',
  units:                    'id, archived',
  photos:                    'id',                 // blob store, keyed by photoRef
  syncQueue:                  '++localId, entityType, entityId, status, createdAt',
  session:                     'key'                // single-row trusted-device token
});
```

Compound/secondary indexes are deliberately minimal at v1 — Dexie table
scans over a small shop's inventory (hundreds, not millions, of products)
are fast enough. We will add indexes only if profiling says so (Rule 2:
no abstraction without a concrete reason).

## MongoDB schema

Mirrors the domain model closely. Single-tenant (one shop account), so no
`shopId` partitioning in v1. `clientId` (the same id generated on-device) is
the stable identity used for idempotent upserts/inserts.

- `products` — upserted by `clientId`, last-write-wins per field via
  `updatedAt` comparison done in the sync controller.
- `stockEvents` — insert-only. Server rejects/ignores duplicate `clientId`.
- `productChangeEvents` — insert-only, same dedup strategy.
- `categories` / `locations` / `tags` / `units` — upserted by `clientId`.
- `users` — single document in v1, holds bcrypt hash + refresh token records.

## Sync model

Two mutation shapes, matching PRD §31/§32:

1. **Additive** (`StockEvent`, `ProductChangeEvent`): queued as inserts.
   Deduplicated server-side by `clientId` so re-delivery is a no-op —
   this is what makes the queue safe to retry after a dropped response.
2. **State** (`Product`, `Category`, `Location`, `Tag`, `Unit`): queued as
   upserts carrying `updatedAt`. Server applies last-write-wins by comparing
   `updatedAt` timestamps. A write that loses the comparison is *not*
   discarded — the client that lost still has a `ProductChangeEvent`
   recording what it tried to set, per PRD §32 ("the earlier change should
   remain represented in product-change history").

`syncQueue` entries: `{ localId, entityType, entityId, operation, payload,
clientId, attempts, status, createdAt, lastError }`. The sync engine drains
the queue in order, retries with backoff on failure, and marks entries
`done` only after a confirmed server response.

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
   example in PRD §17 directly.
2. **Reversals are themselves reversible.** Keeps the mental model uniform
   ("every event can be reversed") rather than adding a special case.
3. **Photos**: compressed blob stored locally in IndexedDB (`photos` table)
   for offline-first use; on sync, uploaded to a free-tier object storage
   service (e.g. Cloudinary) rather than embedded in MongoDB documents, to
   keep documents small and stay within the zero-cost target (PRD §40).
   Only a reference URL is stored server-side once uploaded.

## Testing strategy

- `frontend/tests/domain/` — pure unit tests for domain logic (Vitest).
  No DOM, no IndexedDB, no network — these should run in milliseconds.
- Repository/sync/integration tests come later (Phase 6+) once there's a
  real IndexedDB (fake-indexeddb in test env) and API to test against.
- Backend tests live in `backend/tests/`, using an in-memory or ephemeral
  MongoDB instance.

## Build phases

See `docs/PROGRESS.md` for the live phase checklist.
