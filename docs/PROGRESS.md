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

## Phase 1 — Domain Model (pure logic, no UI) — IN PROGRESS

Target files (one at a time):

- [ ] `frontend/src/domain/shared/ids.js` — UUID generation
- [ ] `frontend/src/domain/shared/dates.js` — date helpers
- [ ] `frontend/src/domain/product/productValidation.js` — name/photo rule
- [ ] `frontend/src/domain/product/productFactory.js` — create/update product objects
- [ ] `frontend/src/domain/pricing/costCalculations.js` — latest/average cost
- [ ] `frontend/src/domain/pricing/marginCalculations.js` — margin + suggested price
- [ ] `frontend/src/domain/stock/stockEventFactory.js` — build ADD/REMOVE events
- [ ] `frontend/src/domain/stock/stockOperations.js` — apply events to quantity, over-removal check
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
