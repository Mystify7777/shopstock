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

## Phase 1 — Domain Model (pure logic, no UI) — ✅ COMPLETE

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
      event)` → `{ nextQuantity, appliedQuantity }` (see "UPDATE after
      review" below for why this is an object, not a bare number). ADD
      adds; REMOVE subtracts and is CLAMPED AT 0 rather than going
      negative or being rejected — this resolves a real tension between
      PRD §12 (over-removal must be *allowed* after a warning) and
      `productValidation.js` (quantity can never be negative): the
      `StockEvent` itself is recorded exactly as requested (e.g.
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
      UPDATE after review: initially returned a bare `nextQuantity`
      number. Review of `reversal.js` surfaced a real bug this shape
      enabled — reversing a clamped over-removal would blindly re-add the
      event's *requested* quantity, manufacturing inventory that never
      existed (quantity 5, REMOVE 8 → clamped 0 → naive reversal → 8, not
      back to 5). Fixed by returning `{ nextQuantity, appliedQuantity }`:
      `appliedQuantity` is the TRUE effect on inventory (`event.quantity`
      for ADD; `min(event.quantity, currentQuantity)` for REMOVE), only
      knowable at the exact moment of applying against a specific
      `currentQuantity`, and threaded through to `reversal.js` by whatever
      commits the event. Full corrected reasoning in
      `docs/ARCHITECTURE.md`, "Reversal and `appliedQuantity`."
      Tested: 28 test cases, 28 passing
      (`tests/domain/stock/applyStockEvent.test.js`) — covers ordinary
      ADD/REMOVE, the exact clamping scenario (current 5, remove 8 →
      nextQuantity 0), confirms `appliedQuantity` equals the requested
      quantity when unclamped and the true smaller amount when clamped,
      confirms `appliedQuantity === currentQuantity - nextQuantity`
      always holds in the clamped case, confirms the event itself is
      never mutated, confirms `nextQuantity` is never negative and
      `appliedQuantity` never exceeds what was available across a matrix
      of combinations including decimals, and a combined-flow test
      demonstrating `wouldOverRemove()` + `applyStockEvent()` used
      together with `appliedQuantity` explicitly retained for a possible
      later reversal.
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
      (3) UPDATE after review: non-array `events` input (`null`,
      `undefined`, or any non-array) now THROWS a `TypeError` rather than
      silently being treated as an empty history. An empty array (`[]`)
      remains valid and returns 0 — but "no data provided" and "genuinely
      empty history" are different situations for a reconciliation
      mechanism, and conflating them risked hiding a repository bug behind
      a quiet 0. This matches `applyStockEvent()`'s existing strictness on
      malformed input.
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
- [x] `frontend/src/domain/stock/reversal.js` — `createReversalEvent(originalEvent,
      appliedQuantity)` is the ONE function used by both PRD §14
      (5-second undo toast) and §15 (historical reversal from any point in
      history) — there is no separate "undo" concept in the domain; the
      difference between the two is purely *when* a UI caller invokes the
      same function, which this file has no notion of (no timer, no
      elapsed-time logic). Builds a compensating event (opposite type,
      `quantity` set to `appliedQuantity`, `reversalOf` set) plus a narrow
      patch (`{ reversedBy }`) for the original — the ONLY field ever
      added to an existing event record, mirroring the
      `ProductChangeEvent.accepted` exception already established in
      ARCHITECTURE.md. A reversal of an ADD never invents cost/
      purchaseDate even though those fields exist on ADD events in
      general, since a reversal isn't a real new purchase.
      `canBeReversed()` returns false once `reversedBy` is set, which is
      what keeps the reference graph a clean singly-linked chain rather
      than letting two competing reversals attach to one original — per
      the "reversals are themselves reversible" assumption, undoing an
      already-reversed event means reversing *the reversal*, a distinct,
      always-permitted call, not a second attempt on the original.
      BUG FOUND AND FIXED before this file was considered done: the first
      version reversed `originalEvent.quantity` directly (the *requested*
      amount). Review caught that this silently manufactures inventory
      when the original event was a clamped over-removal — quantity 5,
      REMOVE 8 → clamped to 0 → naive reversal adds back 8 → 8, a net +3
      units that were never real. `createReversalEvent()` now REQUIRES an
      explicit `appliedQuantity` parameter (the true effect captured from
      `applyStockEvent()`'s return value at the moment the original event
      was committed) and reverses that instead. Missing/invalid
      `appliedQuantity` is now a rejected input, same as any other
      malformed-input case. See `docs/ARCHITECTURE.md`, "Reversal and
      `appliedQuantity`," for the full corrected reasoning.
      Tested: 40 test cases, 40 passing (`tests/domain/stock/reversal.test.js`)
      — covers ADD↔REMOVE type-flipping, the narrow originalPatch shape,
      fresh id/recordedAt on the reversal (never copied from the
      original), the already-reversed rejection, a full second-order
      reversal chain (original → reversal₁ → reversal₂) verifying the
      pointers stay a simple chain and reversal₂ correctly points back at
      reversal₁ (not the original), an explicit check that no
      undo-vs-reversal flag exists anywhere on the produced event, and a
      dedicated "THE OVER-REMOVAL REVERSAL FIX" section directly
      reproducing the bug-report scenario end-to-end: quantity 5 → REMOVE
      8 → clamped 0 → reverse → back to EXACTLY 5, not 8 — plus a
      regression guard proving unclamped reversals still restore the
      exact original quantity, and rejection tests for a missing/zero/
      negative/non-numeric `appliedQuantity`.
      SECOND FIX after further review: `createReversalEvent()` validated
      `appliedQuantity` was positive/finite but did NOT check
      `appliedQuantity <= originalEvent.quantity` — so a buggy or
      untrusted caller could pass e.g. `appliedQuantity: 100` against an
      event that only ever requested 8, producing an oversized reversal.
      `applyStockEvent()` itself guarantees its own output never exceeds
      the requested quantity, but `reversal.js` is a separate public
      domain boundary and must not simply trust that callers upheld the
      invariant on their own. Now enforces `0 < appliedQuantity <=
      originalEvent.quantity` explicitly, with a dedicated rejection
      message. 7 new tests added covering: reject-when-greater-than
      (including a "just barely greater" decimal case), accept-when-equal
      (ordinary case), accept-when-less (clamped case), decimal boundaries
      both sides, and a test named for the exact vulnerability this closes
      (a caller claiming 100 units applied against an 8-unit event is
      rejected outright). Also confirmed, per review, that no
      `calculateAppliedQuantity()` export was ever actually added to
      `applyStockEvent.js` despite earlier summary text claiming
      otherwise — `applyStockEvent()` already returns `appliedQuantity`
      directly, so a second function computing the same thing
      independently would only create a second place for the two to
      drift; deliberately NOT adding it without a real caller.
      Full suite now 298 tests, all passing.
- [x] `frontend/src/domain/classification/lowStock.js` — `classifyStockStatus()`
      returns `'Normal' | 'Low Stock' | 'Out of Stock'` (PRD §22). Two
      rules worth flagging: (1) the threshold BOUNDARY is inclusive —
      `quantity === effectiveThreshold` is LOW, not NORMAL (a shop owner
      with a threshold of 10 wants the warning to trigger AT 10, not only
      strictly below it); (2) `lowStockDisabled` suppresses LOW but NEVER
      suppresses OUT — quantity `<= 0` is always OUT regardless of the
      disabled flag, since "I muted the low-stock nudge for this
      slow-moving item" is a different, less absolute statement than
      "there is genuinely nothing left." `resolveLowStockThreshold()`
      mirrors `marginCalculations.js`'s override-wins-else-global-default
      pattern but is kept as its own independently-named function rather
      than sharing code with `resolveMargin()`, since margin and
      stock-level configuration aren't actually related concepts despite
      the resolution shape being identical. `needsAttention()` is a small
      convenience boolean for dashboard counting (PRD §28/§29) so callers
      don't need to compare status strings directly.
      Tested: 29 test cases, 29 passing
      (`tests/domain/classification/lowStock.test.js`) — covers the PRD
      §22 worked example (default 5, override 10) in both directions
      (override raising AND lowering effective sensitivity vs. the
      global default), the OUT-overrides-disabled rule explicitly, the
      inclusive-boundary case (quantity exactly at threshold is LOW),
      decimal quantities/thresholds, and negative/non-finite/non-numeric
      quantity rejection. Full suite now 327 tests, all passing.
- [x] `frontend/src/domain/classification/classificationDeletion.js` —
      three DISTINCT fallback functions rather than one generic
      type-switched helper, matching the genuinely different semantics per
      PRD §7/§8/§10: `applyCategoryDeletionFallback` (single reference →
      `null`, displayed as "Uncategorized" by the UI layer — this file
      never writes that label string itself), `applyLocationDeletionFallback`
      and `applyTagDeletionFallback` (array references → the specific id
      filtered out, every other reference untouched, no fallback value
      substituted for tags). `findProductsUsing{Category,Location,Tag}()`
      return PRODUCTS, not reference occurrences — a product with a
      duplicated reference in its own array is still counted once.
      `previewClassificationDeletion()` is the single function a
      service/UI layer needs to build the PRD §10/§11 confirmation screen:
      returns `affectedCount`, the original `affectedProducts` (for
      display), and `updatedProducts` (what they'd look like after the
      fallback) — WITHOUT deleting, archiving, or persisting anything.
      This module has no delete-product concept at all (confirmed by a
      test that imports the module and asserts no export name matches
      delete/removeProduct), matching Build Brief §11's requirement that
      the system never cascade-deletes products without explicit,
      separate confirmation — that confirmation and any resulting
      deletion belongs entirely to the service/UI layer, not here.
      Tested: 34 test cases, 34 passing
      (`tests/domain/classification/classificationDeletion.test.js`) —
      covers all 12 cases from the pre-implementation review: each
      fallback type individually, multi-reference preservation, no-op on
      unaffected products, multi-product counting, zero-affected as a
      valid result, non-mutation of both original products and their
      arrays (including an object-identity check that an untouched
      array is literally the same reference, not just equal), rejection
      of an unknown classification type and of a missing/empty id (thrown,
      never silently guessed), confirmation that no product is physically
      removed, affectedCount always matching affectedProducts.length, and
      the duplicate-reference-doesn't-inflate-the-count case in both
      directions (counting once, and fully clearing all duplicate
      occurrences on removal rather than leaving one behind).
      Full suite now 361 tests, all passing.
- [ ] Vitest config + tests for each of the above

## Phase 1 completion gate

All ten domain files are implemented and individually tested (361 tests
across 12 files). Before Phase 2 begins, this section tracks the
cross-cutting verification pass — confirming the suite runs cleanly as a
whole, not just file-by-file — plus a short completion review, per the
decision to treat "Phase 1 done" as a gate rather than a checklist of
individually-green files.

- [x] Formal `vitest.config.js` — checked: test config currently lives as
      a `test` block inside `vite.config.js`, not a separate file. Kept as
      is rather than splitting it out — it has correctly driven all 361
      tests across 12 files throughout Phase 1 with no issues, and adding
      a separate config file with no functional difference would be
      exactly the kind of unnecessary abstraction Build Brief Rule 2 warns
      against. Revisit only if a real need arises (e.g. divergent
      frontend-build vs. test-run config needs).
- [x] Full suite run from a clean `npm install` — done with a genuinely
      clean environment (`node_modules` AND `package-lock.json` both
      removed, not just `node_modules`). Result: 361/361 passing, 12/12
      files, 3.93s. No skipped or pending tests. Vitest runs test files in
      parallel by default, so this run also incidentally confirms no
      test-order dependency exists between files.
- [x] Phase 1 completion review — re-read `docs/ARCHITECTURE.md` end to
      end against the implemented files. Verified each key documented
      decision is both present and substantively explained (not just
      mentioned once): materialized `Product.quantity` (1 dedicated
      section), `syncStatus` removed from events (7 references, every one
      correctly explaining the field's *absence*, none reintroducing it —
      checked individually), `ProductChangeEvent.accepted` conflict
      semantics (8 references), `PhotoStorage` provider abstraction (6
      references), mandatory Dexie migrations from `version(1)` (4
      references), and the `appliedQuantity` reversal split (16
      references, reflecting how much that decision evolved through
      review). No contradictions found between what the doc describes and
      what the code actually does.

**Phase 1 status: complete.** 10 domain files, 361 tests, 0 skipped, all
passing from a clean install. One deliberately-open item carries forward
into Phase 2 rather than being resolved prematurely: where `appliedQuantity`
is persisted between an event's commit and a later reversal (see below and
`docs/ARCHITECTURE.md`, "OPEN ARCHITECTURE QUESTION"). Everything else —
the materialized-quantity model, the event/sync-state separation, the
metadata conflict semantics, the photo storage abstraction, the migration
mandate, and the reversal correctness fixes — is implemented, tested, and
documented consistently between code and architecture doc.

## Open architecture questions carried into Phase 2

- **Where does `appliedQuantity` live between commit and reversal?**
  Trivial for unclamped events (`appliedQuantity = event.quantity` is
  always safe, since `reversal.js` now enforces that as an upper bound
  anyway). Needs a real decision for clamped over-removals reversed later
  from history (PRD §15), potentially after app restart or on a different
  device post-sync — no `applyStockEvent()` return value is sitting in
  memory to reuse at that point. Two candidate designs recorded in
  `docs/ARCHITECTURE.md` under "Reversal and `appliedQuantity`": (1)
  persist it as commit-time metadata alongside the event (a sibling
  record, not a field on the immutable `StockEvent` itself), or (2)
  recompute it on demand via `recomputeQuantityFromEvents()` over the
  events strictly before the one being reversed. Deliberately NOT decided
  in the domain layer — deferred until the Phase 2/3 repository and sync
  design make the storage tradeoffs concrete.

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
