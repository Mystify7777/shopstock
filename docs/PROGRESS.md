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

- [x] Removed leftover `SYNC_STATUS` constant from `shared/constants.js`
      (caught during Phase 1 kickoff review — it contradicted the Phase 0.5
      decision that only `SyncQueueEntry` tracks sync state; a comment now
      marks its intentional absence so it isn't accidentally re-added).

## Phase 1 — Domain Model (pure logic, no UI) — IN PROGRESS

Target files (one at a time):

- [x] `frontend/src/domain/shared/ids.js` — UUID generation (uuid v4, via
      the `uuid` package v11). Tested: 12 test cases, 12 passing
      (`tests/domain/shared/ids.test.js`) — uniqueness across 10k
      generations, UUID v4 shape, and `isValidId` edge cases (empty,
      whitespace, null, undefined, number, object, array).
- [x] `frontend/src/domain/shared/dates.js` — ISO-8601-string domain
      representation, with an explicit split between date-only values
      (`"YYYY-MM-DD"`, local calendar day — `purchaseDate`,
      `latestPurchaseDate`) and timestamps (full UTC instant with
      milliseconds — `recordedAt`, `createdAt`, `updatedAt`). No `Date`
      objects cross into/out of these helpers; only ISO strings do.
      Tested: 36 test cases, 36 passing
      (`tests/domain/shared/dates.test.js`) — includes invalid-calendar-day
      rejection (`2026-02-30`, `2026-02-29` non-leap-year), format
      boundaries (midnight/noon 12-hour formatting, month-index off-by-one
      traps), and string-comparison correctness across year/month
      boundaries. Verified passing under three different `TZ` settings
      (`America/Los_Angeles`, `Asia/Kolkata`, `Pacific/Kiritimati`) to
      confirm the date-only/timestamp split is genuinely timezone-safe,
      not just correct in the container's default UTC.
- [x] `frontend/src/domain/product/productValidation.js` — the PRD §4.1
      identity rule (name OR photo required, both empty is invalid) plus
      structural invariants (quantity/threshold non-negative, margin
      finite, locationIds/tagIds are arrays, id shape). Deliberately does
      NOT validate UI/form state, referenced-id existence, or photo-capture
      mechanics — those belong to the UI layer or repositories, not domain.
      Tested: 35 test cases, 35 passing
      (`tests/domain/product/productValidation.test.js`) — covers all
      three valid identity combinations (name-only, photo-only, both),
      whitespace-only name/photo treated as absent, zero and decimal
      quantity accepted, negative margin accepted (loss-leader pricing is
      legitimate), null threshold/margin accepted (means "use global
      default"), and multiple simultaneous errors accumulating rather than
      short-circuiting at the first one.
- [x] `frontend/src/domain/product/productFactory.js` — `createProduct()`
      builds a new product with every field explicitly defaulted (never
      `undefined`: `quantity: 0`, `archived: false`, `locationIds: []`,
      `tagIds: []`, nullable fields default to `null`). `updateProduct()`
      applies a strict PATCH (omitted key = untouched; explicit `null`/`0`/
      `false`/`''` = applied as given, never treated as "missing"). `id`,
      `createdAt`, and `quantity` are locked fields — `updateProduct()`
      throws (not silently ignores) if a patch touches any of them, since
      quantity may only be set at creation or via `applyStockEvent.js`
      (docs/ARCHITECTURE.md). The factory does not decide when
      `ProductChangeEvent`s should be created — that's service-layer
      orchestration, out of scope here by design.
      Tested: 38 test cases, 38 passing
      (`tests/domain/product/productFactory.test.js`) — covers default
      completeness (no field ever `undefined`), patch-vs-merge semantics
      (explicit `null`/`0`/`false`/`''` distinguished from omission),
      `updatedAt` strictly increasing on every patch, immutability of the
      original object, re-validation surfacing new errors after a patch,
      and the quantity lock specifically (rejects 37, rejects the
      product's own current value, rejects 0 — inclusion in the patch is
      itself the error, independent of the value). Full suite (121 tests
      across 4 files) run three times back-to-back with no flakiness.
- [x] `frontend/src/domain/pricing/costCalculations.js` — pure projection
      over stock-addition events only (REMOVE events ignored entirely —
      this file computes cost, not stock level). `calculateCostProjection()`
      returns `{ latestCost, averageKnownCost, knownCostQuantity,
      totalQuantity }`. "Latest" is resolved by `recordedAt`, explicitly
      NOT by array position or `purchaseDate` (backdated/out-of-order
      entries must still resolve correctly). Unknown-cost units are
      excluded from `averageKnownCost`'s divisor entirely — never treated
      as ₹0, never backfilled. `estimateCostForUnknownStock()` is a
      separate, explicitly-labelled function (`{ estimatedCostPerUnit,
      isEstimate: true }`) per PRD §18, so an estimate can never be
      silently returned where a recorded fact was expected. No IndexedDB/
      MongoDB/Product knowledge; consumes plain event objects only.
      Tested: 18 test cases, 18 passing
      (`tests/domain/pricing/costCalculations.test.js`) — reproduces the
      PRD §17 worked example exactly (20×₹50, 10×₹55, 5×unknown →
      latestCost ₹55, averageKnownCost ₹51.67, 30 of 35 units), proves
      "latest" is determined by `recordedAt` even when events are fed
      out of array order and even when `purchaseDate` would suggest a
      different answer, confirms REMOVE events and zero-quantity events
      are excluded, confirms a recorded cost of ₹0 (e.g. a free sample) is
      treated as known-cost rather than unknown, and confirms the input
      array/events are never mutated. Full suite now 139 tests, all
      passing.
- [x] `frontend/src/domain/pricing/marginCalculations.js` — three
      deliberately separate functions: `resolveMargin(global, override)`
      (override wins if a finite number, including 0 or negative;
      null/undefined falls back to global), `calculateSuggestedSellingPrice
      (cost, marginPercent)` (solves `price = cost / (1 - margin/100)`;
      returns `{ suggestedPrice: null, reason }` at margin === 100%
      (division by zero) and margin > 100% (meaningless), otherwise a
      valid price — including for negative margins, which produce a
      below-cost price for deliberate loss-leader pricing), and
      `calculateActualMargin(cost, sellingPrice)` (solves the inverse,
      `margin = (price - cost) / price × 100`; returns `{ marginPercent:
      null, reason }` only when sellingPrice is exactly 0). Uses GROSS
      MARGIN (percentage of selling price) throughout, never markup
      (percentage of cost) — the file's header comment states this
      explicitly since the two are easily confused and disagree
      numerically on identical inputs. Neither function knows or decides
      which cost figure (averageKnownCost vs. an explicit estimate) it's
      being handed — that choice stays with the caller.
      Tested: 24 test cases, 24 passing
      (`tests/domain/pricing/marginCalculations.test.js`) — reproduces the
      PRD §20 worked example exactly (cost ₹80, 20% margin → ₹100),
      explicitly proves the result is NOT the markup-style answer (₹96),
      round-trips `calculateSuggestedSellingPrice` →
      `calculateActualMargin` back to the original margin across nine
      values from -20% to 99%, and covers both margin boundary cases
      (exactly 100% and above 100%) plus the sellingPrice === 0 boundary
      on the inverse function. Full suite now 163 tests, all passing.
- [x] `frontend/src/domain/stock/stockEventFactory.js` —
      `createAddStockEvent()` and `createRemoveStockEvent()`. Enforces:
      `recordedAt` is ALWAYS factory-generated and never reads a caller-
      supplied value (proven by a test that attempts to inject a fake
      `recordedAt` and confirms it's ignored — this matters because
      `costCalculations.js`'s "latest known cost" already depends on
      `recordedAt` being trustworthy); `purchaseDate` defaults to today
      but is only ever accepted on ADD (REMOVE has no purchaseDate
      parameter at all — a call-site error, not a silent no-op, if
      attempted); cost is recorded exactly as given, never looked up or
      defaulted by the factory itself (prefilling a form field is a UI
      concern per PRD §11.1); an absent/empty/whitespace-only comment
      always normalizes to `null`, never to the literal string "No
      justification provided" (that phrase is display text the UI adds
      later, not stored fake user input); REMOVE construction does not
      check or warn about removing more than available stock (PRD §12 —
      that's a caller/UI decision made before construction, using
      `Product.quantity`); neither function touches `Product.quantity`.
      Tested: 40 test cases, 40 passing
      (`tests/domain/stock/stockEventFactory.test.js`). Full suite now
      203 tests, all passing.
- [x] `frontend/src/domain/stock/applyStockEvent.js` — the sole writer of
      the next `Product.quantity`. `applyStockEvent(currentQuantity,
      event)` → `nextQuantity`. ADD adds; REMOVE subtracts and is CLAMPED
      AT 0 rather than going negative or being rejected — this resolves a
      real tension between PRD §12 (over-removal must be *allowed* after a
      warning) and `productValidation.js` (quantity can never be negative):
      the `StockEvent` itself is recorded exactly as requested (e.g.
      `quantity: 8` even if only 5 were available) and is never mutated to
      fit; only the materialized `Product.quantity` is floored at 0. The
      warning itself is not this function's concern — a separate,
      side-effect-free `wouldOverRemove(currentQuantity, event)` exists
      purely to drive that UI prompt before construction/application, and
      has no effect on what `applyStockEvent()` does. Full reasoning
      recorded in `docs/ARCHITECTURE.md` under "The over-removal
      reconciliation." This function throws (does not silently tolerate)
      on a malformed event or a negative starting quantity, since either
      reaching this point indicates an upstream bug, not a case to handle
      gracefully.
      Tested: 23 test cases, 23 passing
      (`tests/domain/stock/applyStockEvent.test.js`) — covers ordinary
      ADD/REMOVE, the exact clamping scenario from the discussion (current
      5, remove 8 → 0), confirms the event itself is never mutated to
      reflect the clamped amount, confirms no negative result is possible
      across a matrix of current/removal combinations including decimals,
      and a combined-flow test demonstrating `wouldOverRemove()` +
      `applyStockEvent()` used together as the UI/service layer is
      expected to use them. Full suite now 226 tests, all passing.
- [x] `frontend/src/domain/stock/recomputeQuantityFromEvents.js` — full
      replay of a product's event history, built on `applyStockEvent()`
      (no duplicated arithmetic). Two decisions locked in per discussion:
      (1) replay ALWAYS starts from 0, never from the current
      `Product.quantity` — an already-corrupted materialized value must
      not contaminate the reconciliation meant to fix it; the function
      signature itself only accepts an events array, with no
      initial-quantity parameter, so this can't quietly regress later.
      (2) replay preserves the SUPPLIED array order and never sorts by
      `recordedAt` or anything else — quantity is order-sensitive in a way
      cost isn't, because REMOVE clamps at zero
      (`applyStockEvent.js`/`docs/ARCHITECTURE.md`): the same three events
      in a different order produce a different final quantity (10 vs. 7 in
      the ADD-5/REMOVE-8/ADD-10 vs. ADD-10/ADD-5/REMOVE-8 example), so
      silently normalizing order would silently change the answer. This
      file also does not special-case `reversalOf`/`reversedBy` — a
      reversal event is applied as an ordinary ADD/REMOVE at its array
      position; interpreting reversal semantics is reversal.js's job, not
      this reducer's.
      Tested: 20 test cases, 20 passing
      (`tests/domain/stock/recomputeQuantityFromEvents.test.js`) — covers
      all cases discussed: empty list, pure ADD/REMOVE sequences, decimals,
      exact-removal-to-zero, over-removal clamping mid-sequence, a
      subsequent ADD correctly starting from the clamped zero rather than
      a leaked negative, the two order-sensitivity worked examples proven
      to diverge, an explicit proof that `recordedAt` ordering is ignored
      in favor of array order, a structural check that the function has
      exactly one parameter (guards against a future regression
      reintroducing a starting-quantity parameter), determinism across
      repeated calls, non-mutation of both events and the input array, and
      `TypeError` propagation (not silent skipping) for a malformed event
      found mid-list. Full suite now 246 tests, all passing.
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