# ShopStock — Build Progress

Tracking implementation against the phase plan. Update this file whenever a
file is completed, so any session can pick up exactly where the last left
off.

## Phase 0 — Scaffold ✅

- [x] Folder structure (frontend, backend, shared, docs)
- [x] Root README, .gitignore
- [x] docs/PRD.md, docs/BUILD_BRIEF.md (copied from source)
- [x] docs/ARCHITECTURE.md
- [x] frontend/package.json, vite.config.js, index.html
- [x] backend/package.json, server.js skeleton, .env.example
- [x] shared/constants.js (default units/categories/locations, config)

## Phase 0.5 — Architecture correction pass ✅

Review caught several places the original scaffold risked two competing
sources of truth. All corrected in `docs/ARCHITECTURE.md` before any domain
code was written:

- [x] Removed `syncStatus` from `StockEvent`/`ProductChangeEvent` — sync
      state now lives only in `SyncQueueEntry`.
- [x] `Product.quantity` formalized as materialized state derived from the
      `StockEvent` stream (event stream is authoritative on disagreement).
- [x] Metadata conflict semantics formalized: event = "what was attempted,"
      `Product[field]` = "what's currently accepted."
- [x] `PhotoStorage` interface introduced — no provider (Cloudinary etc.)
      hardwired into domain/sync code.
- [x] Dexie schema migrations made mandatory from `version(1)` onward, with
      a test-harness requirement before Phase 2's first real schema ships.
- [x] Clarified "average known cost" is a shop metric, not accounting
      inventory valuation (no FIFO/LIFO/weighted-average-cost).

## Phase 1 — Domain Model (pure logic, no UI) — IN PROGRESS

Target files (one at a time):

- [ ] `frontend/src/domain/shared/ids.js` — UUID generation
- [ ] `frontend/src/domain/shared/dates.js` — date helpers
- [ ] `frontend/src/domain/product/productValidation.js` — name/photo rule
- [ ] `frontend/src/domain/product/productFactory.js` — create/update product objects
- [ ] `frontend/src/domain/pricing/costCalculations.js` — latest/average cost
- [ ] `frontend/src/domain/pricing/marginCalculations.js` — margin + suggested price
- [ ] `frontend/src/domain/stock/stockEventFactory.js` — build ADD/REMOVE events
- [ ] `frontend/src/domain/stock/applyStockEvent.js` — THE single function allowed to
      compute next `Product.quantity` from (currentQuantity, event); over-removal check
- [ ] `frontend/src/domain/stock/recomputeQuantityFromEvents.js` — full replay of a
      product's event stream, for reconciliation after sync (Phase 3/6)
- [ ] `frontend/src/domain/stock/reversal.js` — reversal/undo logic
- [ ] `frontend/src/domain/classification/lowStock.js` — Normal/Low/Out status
- [ ] `frontend/src/domain/classification/classificationDeletion.js` — fallback rules
- [ ] Vitest config + tests for each of the above

## Phase 2 — Local persistence + minimal UI — NOT STARTED
## Phase 3 — Stock operations UI — NOT STARTED
## Phase 4 — Search — NOT STARTED
## Phase 5 — Backend (Express + MongoDB + auth) — NOT STARTED
## Phase 6 — Sync engine — NOT STARTED
## Phase 7 — Dashboard + classification management UI — NOT STARTED
## Phase 8 — Export + PWA polish + hardening — NOT STARTED

---

## Assumptions in effect (see ARCHITECTURE.md for detail)

1. Average known cost = all-time recorded-cost additions.
2. Reversal events are themselves reversible.
3. Photos: IndexedDB blob locally, free-tier object storage on sync.
