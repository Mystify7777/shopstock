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
`docs/ARCHITECTURE.md`, "AMENDMENT... `appliedQuantity` must travel across
every persistence boundary"). Everything else —
the materialized-quantity model, the event/sync-state separation, the
metadata conflict semantics, the photo storage abstraction, the migration
mandate, and the reversal correctness fixes — is implemented, tested, and
documented consistently between code and architecture doc.

## Resolved architecture questions (formerly open, now closed in Phase 2)

- **Where does `appliedQuantity` live between commit and reversal?**
  RESOLVED, then AMENDED after further review before repository work
  began. Original decision: persist it as a commit-time column on the
  Dexie `stockEvents` table (`data/db/schema.js`), separate from the
  domain `StockEvent` shape. Review caught that this only specified the
  LOCAL persistence boundary — the sync payload and MongoDB schema were
  left unspecified, which reopens the exact inventory-inflation bug
  `appliedQuantity` exists to prevent, just relocated to "device B
  receives this event via sync and can't correctly reverse it." Corrected
  statement: `appliedQuantity` is commit-time persistence metadata that
  must travel across EVERY persistence boundary that can serve a later
  reversal — local Dexie row, sync queue payload, AND remote MongoDB
  document, all three. It remains absent from exactly one place: the
  domain `StockEvent` shape itself. Full reasoning in
  `docs/ARCHITECTURE.md` under "AMENDMENT (caught in review before
  repository implementation began)." Local round-trip verified in
  `tests/data/db/schema.test.js`; the sync-payload and MongoDB inclusion
  still need their own repository/sync tests once those layers exist (see
  2.2/2.3 below — now written as binding requirements, not suggestions).

## Phase 2 — Local persistence + minimal UI — ✅ COMPLETE

Sequencing per pre-Phase-2 discussion: persistence must be proven
trustworthy before any UI consumes it. Order: (1) Dexie schema + migration
harness, (2) repository contracts, (3) repository tests, (4) only then the
first minimal product screen. All four completed in that order; no step
was started before the previous one closed.

### 2.1 — Dexie schema + migration harness ✅

- [x] `frontend/src/data/db/schema.js` — `db.version(1)` matching
      `docs/ARCHITECTURE.md`'s documented schema, plus the two additions
      that only became concrete once real repository queries were being
      designed: `reversalOf` indexed on `stockEvents` (fast "find this
      event's reversal" lookup) and the resolved `appliedQuantity` column
      (unindexed — read alongside the row, never queried by value).
      `createDatabase()` returns a fresh, unopened Dexie instance; callers
      (repositories, tests) control when `.open()` happens.
- [x] `frontend/tests/setup/fake-indexeddb.js` + `vite.config.js`
      `setupFiles` entry — installs `fake-indexeddb/auto` globally so
      Dexie-backed tests can run under Node/Vitest. Pure domain tests are
      unaffected (they never touch IndexedDB).
- [x] `frontend/tests/data/db/schema.test.js` — the harness test
      `docs/ARCHITECTURE.md` requires before shipping the first real
      `version(1)`: confirms the DB opens, confirms `db.verno === 1`,
      confirms the exact table list matches what's documented, and does a
      representative seed-and-read round trip through EVERY table
      (products including an indexed-column query, stockEvents including
      both the `appliedQuantity` round-trip and an indexed `reversalOf`
      query, productChangeEvents, categories/locations/tags/units,
      photos as a blob-shaped record, syncQueue confirming auto-increment
      `localId` ordering and a `status` query, session as a single-row
      key/value store) plus a clean-isolation check that a fresh database
      has no leftover data between test runs.
      Tested: 14 test cases, 14 passing (`tests/data/db/schema.test.js`).
      Full suite now 375 tests (361 domain + 14 data layer), all passing,
      confirmed with zero regressions to the existing domain suite after
      adding the global `fake-indexeddb` setup file.

      Corrected mid-2.1: `vite.config.js`'s vitest `include` pattern
      originally only matched `tests/**/*.test.js`, silently excluding
      nine co-located domain test files under `src/domain/**` (278
      tests). `npm test` was reporting 97/97 green while 278 real tests
      never ran. Fixed to `{src,tests}/**/*.test.js` (later widened again
      to `.test.{js,jsx}` in 2.4 for component tests). All 375 tests
      confirmed passing once actually collected — the domain code was
      sound throughout, only the harness was blind to most of it.

### 2.2 — Repository contracts + implementation ✅

Two requirements were BINDING (not suggestions) on this milestone, per
the architecture amendment and the atomicity section in
`docs/ARCHITECTURE.md` ("Stock-event commit atomicity"):

1. Every `syncQueue` payload built for a `stockEvent` entity MUST include
   `appliedQuantity` alongside the domain event fields — never the domain
   event alone.
2. A stock-event commit (event write + product quantity update + sync
   queue entry) MUST be a single atomic Dexie transaction, not three
   independent writes, with an explicit repository test proving full
   rollback on partial failure.

Both requirements held throughout implementation; no shortcut was taken
on either.

- [x] `frontend/src/data/repositories/productRepository.js` —
      `getById`, `list`, `create`, `update`. `update(product, changeEvents)`
      accepts already-constructed `ProductChangeEvent` records from the
      service layer (repository does not diff products or decide which
      events should exist) and persists product + change events + both
      corresponding sync entries in one Dexie transaction. Repository-
      level invariant: `product.quantity` must exactly match the
      currently stored quantity, or the write is rejected — quantity
      mutation is exclusively `stockEventRepository`'s path. No `archive()`
      method: archiving is `update()` with `{ archived: true }`,
      constructed at the service layer like any other edit.
      Contract review resolved several non-obvious points before any code
      was written: `ProductChangeEvent` persistence ownership (repository,
      not a separate `productChangeEventRepository`), whether Product
      creation produces change events (no — explicit V1 scope decision,
      not a derived invariant), and critically, `clientId` semantics —
      `entityId` identifies the target entity, `clientId` identifies one
      sync mutation and must be freshly generated per `Product` upsert
      (never reused from `entityId`), while `ProductChangeEvent` inserts
      safely use `clientId === entityId` since each event is exactly one
      immutable mutation. This distinction was wrong in an earlier draft
      of `docs/ARCHITECTURE.md` (which said "products upserted by
      `clientId`") and was corrected as part of this milestone.
      Tested: 40 tests, including atomic rollback proofs (not just error
      assertions) for both `create()` and `update()`.
- [x] `frontend/src/data/repositories/classificationRepository.js` —
      `getById`, `list`, `create`, `update`, parameterized by
      `entityType` (`'category' | 'location' | 'tag' | 'unit'`), covering
      all four classification tables with one implementation since they
      share the same shape and the same deletion-fallback orchestration
      pattern already owned by `classificationDeletion.js`. `entityType`
      validated before any DB access. `isDefault` deliberately NOT
      enforced by the repository — archiving/renaming a default
      classification is allowed; any UI-level warning about that is a
      service/UI concern, not a persistence-layer rule. No `updatedAt` /
      LWW mechanism — classifications don't have one in the current
      schema, and adding one was explicitly deferred as a Phase 6
      sync-engine decision rather than expanded here.
      Tested: 38 tests, including atomic rollback proofs for both
      `create()` and `update()`.
- [x] `frontend/src/data/repositories/stockEventRepository.js` — the
      most structurally complex repository in the codebase. `getById`,
      `getByProductId`, `commit(...)`, `commitReversal(...)`. Both commit
      methods take object arguments (not positional) and receive
      `nextQuantity`/`appliedQuantity` already computed by the service via
      domain `applyStockEvent()` — the repository never calls
      `applyStockEvent()` itself. Instead it re-reads the product's
      current quantity inside the transaction and verifies it against a
      caller-supplied `expectedCurrentQuantity`, catching stale reads
      without duplicating domain math. `commit()` is a 3-table
      transaction (`stockEvents`, `products`, `syncQueue`); `commitReversal()`
      is also 3 tables but 4 logical writes (new reversal event insert,
      `reversedBy` patch on the original event via `stockEvents.put()`,
      product quantity update, two sync entries), all atomic.
      `commitReversal()` re-checks `storedOriginal.reversedBy === null`
      (strictly `null`, not `null`-or-`undefined` — corrected during
      review) and `reversalEvent.reversalOf === originalEventId` before
      writing, both inside the transaction, so a concurrent reversal
      attempt or a caller-assembled mismatch is caught rather than
      trusted. `appliedQuantity` is included in the `stockEvent` sync
      payload on every commit, per the binding requirement above.
      Tested: 44 tests, including rollback proofs at every individual
      write position in both `commit()` and `commitReversal()` (not just
      "the last write fails") and a clamped-over-removal-then-reversal
      integration test proving the reversal restores the true applied
      quantity, not the originally requested one.

### 2.3 — Repository integration review ✅

Audit-only pass confirming the three repositories above have no callers
yet and no existing code violates their contracts — expected at this
point in the build, since the service layer and all UI directories were
still `.gitkeep` placeholders. No changes required; the milestone's own
content (repository tests) had already been completed alongside 2.2
rather than as a separate step, consistent with this project's practice
of shipping tests with implementation rather than after it.

### 2.4 — First minimal product screen ✅

Product list, create product, edit product — repository-backed through a
real service layer, with domain validation
(`productValidation.js`/`productFactory.js`) remaining the sole source of
truth for what's a valid write. No mocked repository or fake data layer
anywhere in the real path.

- [x] `frontend/src/services/productService.js` — `listProducts`,
      `getProduct`, `createProduct`, `updateProduct`. Orchestrates domain
      `createProduct()`/`updateProduct()` then, for updates, diffs old vs.
      new product across the closed tracked-field set (`name`,
      `categoryId`→`'category'`, `locationIds`→`'location'`,
      `tagIds`→`'tags'`, `sellingPrice`, `archived`) to construct zero or
      more `ProductChangeEvent` records before calling
      `productRepository.update()`. No `ProductChangeEvent` factory
      exists in the domain layer (confirmed by inspection, not assumed),
      so the service constructs these inline with `generateId()` /
      `timestampNow()`. Array-valued tracked fields compared via
      `JSON.stringify` — order-sensitive, since nothing in the domain
      model or PRD establishes `locationIds`/`tagIds` as unordered sets.
      Does not import Dexie directly; receives an already-constructed
      `productRepository`.
      Tested: 16 tests against a real repository backed by
      `fake-indexeddb` (not mocked) — the service→repository→Dexie path
      is exercised for real here, including per-tracked-field event
      generation, zero-event non-tracked edits (e.g. `notes`-only), and
      confirmation that quantity cannot be changed through this path.
- [x] `frontend/src/contexts/AppContext.jsx` — composition root context.
      One `createContext`/`AppProvider`/`useAppContext`, not a DI
      framework. Services are constructed once in `main.jsx` and passed
      down; no component or page constructs its own database, repository,
      or service.
- [x] `frontend/src/main.jsx` — rewritten as the actual composition root:
      `createDatabase()` → `createProductRepository(db)` →
      `createProductService(productRepository)` → `<AppProvider>`.
- [x] `frontend/src/pages/ProductListPage.jsx` — loading / empty /
      populated states, Add Product navigation, row-tap navigation to
      edit, and a low-stock indicator that calls the existing domain
      `classifyStockStatus()`/`needsAttention()` directly — no
      low-stock logic duplicated in the component.
- [x] `frontend/src/pages/ProductFormPage.jsx` — single component for
      both create and edit, distinguished by route `:id` presence.
      Fields deliberately limited to `name` + `notes` to prove the full
      vertical slice without requiring classification pickers, photo
      upload, or pricing fields (those are later phases). Handles four
      failure modes explicitly, all corrected during review rather than
      present from the first draft: product-not-found on edit (was
      previously an infinite loading spinner if `getProduct()` resolved
      `undefined`), `getProduct()` rejection (was an unhandled rejection),
      and `createProduct()`/`updateProduct()` rejection (was also an
      unhandled rejection, and `saving` could get stuck `true`) — all now
      surfaced as local, page-scoped error states with `saving` guaranteed
      to reset on both success and failure paths.
- [x] `frontend/src/App.jsx` — minimal `react-router-dom` routing:
      `/products`, `/products/new`, `/products/:id/edit`, plus a default
      redirect. No route beyond what this slice needs.
- [x] Component testing infrastructure added: `@testing-library/react`,
      `@testing-library/jest-dom`, `jsdom`. `vite.config.js` uses
      `environmentMatchGlobs` so `src/pages/**`/`src/components/**` run
      under `jsdom` while domain/repository/service tests stay on the
      faster `node` environment — no global switch to jsdom.
      `tests/setup/jest-dom.js` is guarded on `typeof document` so it's a
      no-op under `node`, and explicitly wires `@testing-library/react`'s
      `cleanup()` via `afterEach` — required because this project doesn't
      use Vitest's `globals: true` mode, so neither jest-dom's matcher
      extension nor RTL's auto-cleanup happen for free the way they would
      under Jest defaults. The missing-cleanup gap was caught by an actual
      test failure (DOM leaking across tests in the same file) during
      this milestone, not anticipated in advance.
      Tested: `ProductListPage.test.jsx` (8 tests: loading, empty,
      populated, Add Product navigation, row navigation, list-load
      rejection, low-stock indicator present, low-stock indicator absent
      for normal stock) and `ProductFormPage.test.jsx` (9 tests: create
      rendering, valid creation, validation-error rendering, edit
      loading, valid edit, product-not-found, load rejection, create
      rejection, update rejection). `productService` is mocked at the
      `AppContext` boundary in these — the real service→repository→Dexie
      path is `productService.test.js`'s job, not these.

Full suite at Phase 2 close: **19 test files, 530 tests, 0 failures.**

## Phase 3 — Stock operations UI — ✅ COMPLETE

Smallest complete vertical slice proving real stock operations end-to-end
through the UI, preserving every Phase 2 repository contract untouched:
`stockEventRepository.js`, `productRepository.js`, `applyStockEvent.js`,
`reversal.js`, and `schema.js` were not modified anywhere in this phase.

Contract review resolved two points that were genuinely undocumented
before this phase, rather than guessed at:

1. **Reversal-after-subsequent-mutation (Option B, locked).** No existing
   domain file addressed what happens when reversing an ADD whose
   `appliedQuantity` can no longer be fully removed because later stock
   mutations have reduced current quantity below it. Resolved as: the
   reversal must be BLOCKED before commit, never silently clamped — a
   clamped reversal would produce a partial reversal while presenting it
   as a full one. Implemented with zero new domain code: once
   `createReversalEvent()` builds a reversal event, its `type` is already
   `'REMOVE'` whenever the original was an ADD, so the existing, unmodified
   `wouldOverRemove()` already answers the exact question generically
   ("would this REMOVE-typed event exceed current quantity?"). The guard
   lives entirely in `stockEventService.reverseEvent()`, called before
   `applyStockEvent()`/`commitReversal()` — same placement pattern already
   established for `canBeReversed()`'s two-layer check (service-level
   fast-fail, repository-level authoritative re-check inside the
   transaction).
2. **`wouldOverRemove()` missing-product handling.** Initially proposed to
   return `false` for a nonexistent product — rejected on review, since
   that conflates "safe to proceed" with "unknown, product doesn't exist."
   A boolean return type has no room for a third state, so this method
   throws the existing `ProductNotFoundError` (imported from
   `productRepository.js`, not a new error type) rather than silently
   reporting an operation as safe when it isn't evaluable at all.

- [x] `frontend/src/services/stockEventService.js` — `getHistory`,
      `getLatestKnownCost`, `wouldOverRemove`, `addStock`, `removeStock`,
      `reverseEvent`. Loads the current product INTERNALLY in every method
      that needs it — callers never pass a Product object. Captures
      `expectedCurrentQuantity` from that internal read and passes it
      UNCHANGED to `stockEventRepository.commit()`/`commitReversal()`,
      which remains the sole authoritative concurrency guard (this
      service's own preflight checks, like `wouldOverRemove()`, are
      explicitly documented as advisory only — time can pass between a
      preflight check and an eventual commit). Error semantics kept
      consistent with the already-established `productService.js`
      convention: domain/input validation failures and the reversal
      insufficient-stock guard return via `{ event: null, errors: [...] }`;
      repository/concurrency throws (`QuantityConsistencyError`,
      `ProductNotFoundError`, `AlreadyReversedError`,
      `StockEventNotFoundError`, `ReversalReferenceError`) are NOT caught
      here and propagate uncaught to the caller, exactly like
      `productService.js` already does for `productRepository` throws.
      `getLatestKnownCost()` is a thin wrapper around the existing
      `calculateCostProjection()` (PRD §11.1's cost-per-unit prefill) —
      no new pricing abstraction introduced.
      Tested: 21 tests against real `stockEventRepository` +
      `productRepository`, backed by `fake-indexeddb`, no mocking —
      including the two tests this phase treated as non-negotiable: a
      clamped-original reversal restoring the persisted `appliedQuantity`
      (not the originally requested `quantity` — the project's own
      documented near-miss, re-verified here at the service layer) and the
      Option B insufficient-stock block, which asserts the original event
      remains unreversed, product quantity is unchanged, no new stock
      event exists, and no new `syncQueue` entry was created for the
      blocked attempt — not merely that the call rejected.
- [x] `frontend/src/pages/ProductDetailPage.jsx` — new route `/products/:id`,
      now the Product Detail + Stock Operations page. `/products/:id/edit`
      remains exclusively for metadata editing (unchanged from Phase 2.4).
      `productService.getProduct()` and `stockEventService.getHistory()`
      are called independently, each with its own loading/error state — no
      combined `getProductDetail()` abstraction was introduced. Add Stock
      form (quantity, cost-per-unit prefilled from `getLatestKnownCost()`,
      purchase date, comment), Remove Stock form with the PRD §12
      over-removal Cancel/Continue confirmation, a stock history list
      showing each entry's comment or the literal "No justification
      provided" fallback (PRD §13, never invented), a "Reverse this
      action" control shown only when `canBeReversed()` — direct domain
      call for pure display, same convention `ProductListPage` already
      established for `classifyStockStatus()` — and a ~5-second local undo
      banner implemented as `useState` + `setTimeout` (no toast library).
      Undo and historical reversal are the SAME operation
      (`stockEventService.reverseEvent(eventId)`) — no separate undo
      service or domain path, per `reversal.js`'s own documented design.
      Corrected during review: the mount-time async loaders originally
      checked a plain closure `cancelled` flag only once, before their
      `await` began — meaningless once the call was already in flight,
      since the loader functions had no way to observe it. Fixed by
      threading an `isCancelledRef` (`{ current: boolean }`) into
      `loadProduct()`/`loadHistory()`, checked immediately before every
      state update that follows their internal `await`; the six other call
      sites (after `addStock`/`removeStock`/`reverseEvent`) call these
      loaders with no ref argument, so the guard is a no-op there,
      preserving their existing behavior exactly.
      Tested: 16 tests, `productService`/`stockEventService` mocked at the
      `AppContext` boundary — loading/error states for product and history
      independently, Add Stock submission and cost prefill, Remove Stock
      with and without the over-removal warning (including Cancel not
      calling `removeStock()`), Undo calling `reverseEvent()` with the
      just-committed event id, per-entry "Reverse this action," an
      already-reversed entry rendering no reverse control, the
      reversal-blocked error message rendering inline, and a
      `wouldOverRemove()` `ProductNotFoundError` throw surfacing as an
      inline error rather than silently proceeding as if the operation
      were safe.
- [x] `frontend/src/contexts/AppContext.jsx` — JSDoc updated;
      `frontend/src/main.jsx` — composition root now also constructs
      `stockEventRepository`/`stockEventService` and provides both
      services; `frontend/src/App.jsx` — added the `/products/:id` route;
      `frontend/src/pages/ProductListPage.jsx` — row navigation retargeted
      from `/products/:id/edit` to `/products/:id`, with its test file's
      route probe and assertion updated to match.

Two review-driven housekeeping corrections, both behavior-preserving: the
`ProductDetailPage.jsx` async-cleanup fix described above, and one
`stockEventService.test.js` rename (the stale-`expectedCurrentQuantity`
test's name previously implied the condition was triggered through the
service; it actually calls `stockEventRepository.commit()` directly with a
hand-constructed stale value, which the corrected name now states).

Full suite at Phase 3 close: **21 test files, 567 tests, 0 failures.**

## Phase 4 — Search — ✅ COMPLETE (4A/4B/4C/4D)

### 4A — Core Search

- [x] `frontend/src/domain/search/productSearch.js` (new) — pure domain
      module, no React/Dexie/browser imports. Exports `searchProducts()`
      and `isEmptyQuery()`. `SearchableProduct` shape (built by the
      service, never the domain): `{ product, name, notes, category,
      tags[], locations[] }` — transient, never persisted.
      Exact-match detection: deterministic normalized-string equality
      (trim/collapse whitespace/lowercase) across all five searchable
      fields including `notes`. Fuzzy matching: Fuse.js, weighted keys
      `{ name: 3, category: 2, tags: 2, locations: 2, notes: 1 }`,
      `ignoreLocation: true`.
- [x] `frontend/src/services/productService.js` — `searchProducts(query)`
      added: empty/whitespace query short-circuits with no repository
      calls; resolves `categoryId`/`locationIds[]`/`tagIds[]` to display
      names via `classificationRepository.list(type, { includeArchived:
      true })`; dangling references resolve to empty/omitted rather than
      throwing. `classificationRepository` made a **required** constructor
      dependency (`TypeError` if missing — no compatibility fallback).
- [x] `frontend/src/hooks/useDebouncedValue.js` (new) — generic debounce
      hook, not search-specific.
- [x] `frontend/src/pages/ProductListPage.jsx` — search input, debounced
      ~450ms, falls back to the pre-existing `listProducts()` flow
      unchanged when the query is empty.

Corrective pass (caught in review before checkpoint): exact-match
detection extended to include `notes` (an earlier draft excluded it —
wrong, since exactness and relevance-weighting are separate concerns);
removed unused `includeScore: true`; corrected the `ignoreLocation`
comment; added a dangling-location-reference test; fixed a fake-timer
cleanup leak in `useDebouncedValue.test.js` (now uses `afterEach`); added
a 449ms/450ms debounce boundary test.

### 4B — Related Results

- [x] `frontend/src/domain/search/productSearch.js` — added
      `deriveRelated()` / `buildRelatedMetadataPool()` /
      `countSharedValues()`. Relatedness is an **aggregate** metadata pool
      (category/tags/locations unioned across ALL of `matches`), not a
      per-candidate similarity score. Deterministic four-tier ranking:
      shared category (boolean priority) → shared-tag count →
      shared-location count → stable original order. `matches`/`related`
      fully disjoint. `hasExactMatch === true` or `matches.length === 0`
      → `related = []`.
- [x] `frontend/src/pages/ProductListPage.jsx` — "Related products"
      section, shown only when `!hasExactMatch && related.length > 0`,
      reusing the existing row renderer (navigation/low-stock identical).
- No second Fuse instance introduced. `productService.js` genuinely
  unchanged this phase — no service tests added, per contract.

### 4C — Search Filters

- [x] `frontend/src/services/productService.js` — added `applyFilters()`:
      ID-based (not name-based) filtering against `Product.categoryId`
      (single-select) / `locationIds` / `tagIds` (multi-select, OR within
      a group, AND across groups). Filters are applied to the active
      product list **before** the searchable projection is built and
      before Fuse runs — `productSearch.js` needed zero changes.
      `searchProductsUseCase(query, filters = {})` extended with a
      filters-only bypass (empty query + active filters) that returns the
      **same** `{ matches, related, hasExactMatch }` shape rather than a
      second result contract.
- [x] `frontend/src/pages/ProductListPage.jsx` — native `<select>`
      (category) + checkboxes (locations/tags) inside a `<fieldset>`,
      "Clear filters" button. Filter *options* load once on mount from
      `classificationRepository.list()` (defaults to
      `includeArchived: false` — no special-casing needed); selecting a
      filter never re-triggers that load (dedicated regression test).
- [x] `frontend/src/contexts/AppContext.jsx` / `frontend/src/main.jsx` —
      `classificationRepository` added to the `AppProvider` services
      shape so the page can read filter options.
- Because filters narrow the candidate set upstream of `matches`, related
  results are automatically filter-consistent too — no second filtering
  pass, confirmed by a dedicated test (a same-category product outside an
  active location filter never appears in `related`).
- `productSearch.js` confirmed byte-identical to its Phase 4B checkpoint
  throughout this phase.

Corrective note (self-caught, not a design defect): an incorrect test
assertion for the new `searchProducts(query, filters)` signature threw
before a pre-existing fake-timer test's own `vi.useRealTimers()` cleanup
ran, leaking fake timers into 18 subsequent tests in
`ProductListPage.test.jsx` and hanging their `waitFor()` calls — the same
class of bug the 4A corrective pass had already fixed once in
`useDebouncedValue.test.js`, but this file had never received the
equivalent guard. Fixed the assertion and added a file-level
`afterEach(() => vi.useRealTimers())` safety net.

### 4D — Voice Search

- [x] `frontend/src/hooks/useSpeechRecognition.js` (new) — the one place
      in the codebase that touches the Web Speech API directly. Owns
      capability detection (`window.SpeechRecognition ||
      window.webkitSpeechRecognition`), a strict `idle → listening →
      (idle | error)` lifecycle, single-utterance recognition
      (`continuous: false`, `interimResults: false`), human-readable error
      mapping (never raw browser error codes), user-stop vs.
      recognition-error disambiguation, and unmount cleanup via
      `abort()`.
- [x] `frontend/src/pages/ProductListPage.jsx` — mic button rendered only
      when `isSupported`; a final transcript calls the **same**
      `setQuery()` the text input uses — no parallel voice-query state,
      no second search pipeline. Absent entirely (not disabled) on
      unsupported browsers.
- Voice search is a pure input adapter: `productSearch.js` and
  `productService.js` both confirmed byte-identical to their prior
  checkpoints throughout this phase.
- New files use LF line endings (the project's documented target),
  diverging intentionally from the legacy CRLF convention still present
  elsewhere in the repo (flagged explicitly, not silently resolved either
  way).

Full suite at Phase 4 close: **24 test files, 689 tests, 0 failures.**

## Phase 5 — Backend (Express + MongoDB + auth) — ✅ COMPLETE (5A–5G)

### 5A — Backend Foundation ✅ COMPLETE

Files:
- `backend/src/config/env.js` (new) — required-variable presence
  validation (`validateEnv()`) + typed config loading (`loadConfig()`).
  Fails loud (`process.exit(1)`) at startup if any of `MONGODB_URI`,
  `JWT_ACCESS_SECRET`, `JWT_ACCESS_EXPIRES_IN`,
  `REFRESH_TOKEN_EXPIRES_IN_DAYS`, `SEED_USERNAME`, `SEED_PASSWORD`,
  `CORS_ORIGIN` is missing or blank, rather than discovering a missing
  secret on the first request that needs it.
- `backend/src/config/db.js` (new) — Mongoose connection lifecycle
  (`connectDb`, `disconnectDb`, `connectionState`). Does not itself
  enforce replica-set topology — that failure surfaces later, at the
  first stock-event transaction attempt (Phase 5E) — but the requirement
  is documented explicitly in `backend/README.md`. **Bug found and fixed
  during this slice, via actually running the code, not just reading
  it:** an unreachable `MONGODB_URI` hung for 25+ seconds with no error
  surfaced at all (Mongoose's own default `serverSelectionTimeoutMS` is
  30s, and observed behavior exceeded even that in this environment) —
  directly contradicting this phase's "fail loud at startup" principle.
  Fixed by explicitly setting `serverSelectionTimeoutMS: 10000` (default,
  overridable) in `connectDb()`; re-verified `server.js` now exits(1)
  with a clear message in ~10s against a genuinely unreachable host.
- `backend/src/middleware/AppError.js` (new) — the locked nine-code error
  vocabulary (`VALIDATION_ERROR`, `UNAUTHORIZED`, `FORBIDDEN`,
  `NOT_FOUND`, `CONFLICT`, `QUANTITY_CONSISTENCY_CONFLICT`,
  `ALREADY_REVERSED`, `DUPLICATE_ENTITY`, `INTERNAL_ERROR`) as a frozen
  object + an `AppError` class that throws if constructed with a code
  outside that set.
- `backend/src/middleware/errorHandler.js` (new) — centralized Express
  error middleware producing the single `{ error: { code, message } }`
  response shape on every endpoint. Non-`AppError` exceptions are logged
  server-side in full but reported to the client as a generic
  `INTERNAL_ERROR` — the real exception text/stack is never sent in a
  response body.
- `backend/src/app.js` (new) — Express app assembly (`createApp()`),
  deliberately separate from `server.js` so tests can exercise real
  routes/middleware via `supertest` without binding a port or requiring
  a live MongoDB connection. Includes `GET /api/health` (no auth;
  reports HTTP-server-up and Mongo-connection-state as two separate
  facts, never collapsed into one boolean, so a disconnected DB doesn't
  itself fail the health check).
- `backend/server.js` (rewritten) — real boot entrypoint: load/validate
  env → connect to MongoDB → build the app → listen. Domain routers are
  not mounted yet (added incrementally from 5B onward).
- `backend/tests/config/env.test.js`, `tests/config/db.test.js`,
  `tests/middleware/AppError.test.js`, `tests/app.test.js` (new) — 25
  tests total, all Mongo-free (or Mongo-connection-failure-only, which
  needs no real MongoDB instance), all **genuinely executed** in this
  session via `node --test`.
- `backend/tests/helpers/testDb.js` (new) — shared `MongoMemoryReplSet`
  connect/clear/disconnect helper for every Mongo-dependent test from
  Phase 5C onward. **Written but not yet executed successfully** — see
  the sandbox note below.
- `backend/README.md` (new) — documents the MongoDB replica-set
  requirement for local dev (transactions cannot run against a
  standalone `mongod`), the Atlas production target, and the test
  strategy.
- `backend/package.json` — added `mongodb-memory-server` and `supertest`
  as dev dependencies. **Fixed a genuine pre-existing defect**: the
  declared `"test": "node --test tests/"` script fails outright
  (`MODULE_NOT_FOUND`) on this Node version when given a bare directory
  path — reproduced and confirmed before changing it. Fixed to
  `"test": "node --test"` (Node's own documented default recursive
  discovery), verified working.

**Sandbox network limitation (flagged explicitly, not silently routed
around):** this development sandbox's outbound network allowlist does
not include `fastdl.mongodb.org`, which `mongodb-memory-server` needs to
download its MongoDB binary. Confirmed via a direct smoke test
(`DownloadError`, HTTP 403) before writing any Mongo-dependent code, and
confirmed again against the actual `tests/helpers/testDb.js` module.
**Every test written in this Phase 5A slice that requires a MongoDB
connection has NOT been executed in this session** — only the tests that
need no real MongoDB instance (env validation, database-connection-
failure behavior, AppError, app.js/health/error-handling/CORS via
supertest) have a genuine, verified pass in this environment.
Anything from Phase 5C onward that needs `MongoMemoryReplSet` must be run
for real (locally, or in an environment with the necessary network
access) before its completion gate can be honestly claimed as passing —
this is a standing caveat for the rest of Phase 5, not just this slice.

Test count this slice: **37/37 passing (no real MongoDB instance
required)**; backend total test files: 4 (`env.test.js`, `db.test.js`,
`AppError.test.js`, `app.test.js`) + 1 unexecuted helper module
(`testDb.js`, no test file of its own yet — it's consumed by future test
files, not tested standalone).

#### 5A corrective pass (post-review)

Three issues raised in review, all addressed:

1. **Real bug fixed:** `AppError`'s vocabulary check used `code in
   ERROR_CODES`, which follows the prototype chain — `new
   AppError('toString', ...)` incorrectly passed validation (since
   `'toString' in {}` is `true` via `Object.prototype`), later producing
   `status: undefined`. Fixed to `Object.hasOwn(ERROR_CODES, code)` (an
   own-property check). Verified the fix is meaningful, not decorative,
   by confirming the new regression test genuinely fails against the old
   `in`-based code before the fix and passes after it.
2. **Validation gap closed:** `validateEnv()` previously only checked
   *presence* for `REFRESH_TOKEN_EXPIRES_IN_DAYS`/`PORT`, so values like
   `banana`, `0`, or `-90` passed validation and silently became `NaN`
   or an invalid value downstream. `validateEnv()` now also validates
   `REFRESH_TOKEN_EXPIRES_IN_DAYS` as finite + positive, and `PORT` (when
   present — it remains optional) as a finite positive integer, returning
   a new `invalid: string[]` array alongside `missing: string[]`.
   `loadConfig()`'s failure message now reports both missing and invalid
   variables together.
3. **Documentation inconsistency corrected:** this section previously
   stated "23 Mongo-free tests" in one place and "25/25 passing" in
   another — a genuine contradiction, not just a stale number. Both are
   now correctly reconciled to **37**, the true post-corrective-pass
   count.

Corrective-pass diff scope: `src/middleware/AppError.js`,
`src/config/env.js`, `tests/middleware/AppError.test.js`,
`tests/config/env.test.js`, this `PROGRESS.md` section. **No other
Phase 5A file changed. No frontend file changed. No Phase 5B work
started.** Full backend suite re-run: 37/37 passing. Frontend suite
re-run: 689/689 passing, unaffected. `MongoMemoryReplSet`
sandbox-network caveat is unchanged and still applies.
### 5B — Authentication ✅ COMPLETE AND FULLY VERIFIED

Files:
- `backend/src/models/User.js` (new) — `User` Mongoose model. **`_id`
  strategy verified against `ARCHITECTURE.md` before implementing, not
  assumed** (a correction made after initial review): standard MongoDB
  `ObjectId`, not the `entityId`-as-`_id` convention every other
  collection uses — that convention is stated in `ARCHITECTURE.md`'s
  MongoDB schema section as serving sync/dedup for client-originated
  entities, and `User` is server-created via the seed script only, never
  synced, never referenced by `entityId`. Located by unique `username`
  instead. `refreshTokens[]`: `{ tokenHash, deviceLabel, createdAt,
  expiresAt, revoked }` — `tokenHash` is SHA-256 (not bcrypt — bcrypt's
  cost is right for a low-entropy password, wrong for an
  already-high-entropy random token), `expiresAt` explicit per-entry
  (opaque tokens aren't self-describing like a JWT). Exports
  `toDeviceLabel()`, a pure helper bounding a raw `User-Agent` header to
  200 chars with a fallback for missing/empty headers.
- `backend/src/services/tokenService.js` (new) — pure token mechanics:
  `generateRefreshToken()` (256-bit random, hex), `hashRefreshToken()`
  (SHA-256), `computeRefreshTokenExpiry()`, `signAccessToken()`/
  `verifyAccessToken()` (JWT, minimal `{ sub }` payload only — no
  username/role claims, since there's exactly one user and no roles).
- `backend/src/services/authService.js` (new) — `login`, `refresh`,
  `logout`, `changePassword`. Key behaviors:
  - **Login**: bcrypt-compares against a dummy hash even for an unknown
    username, so "unknown username" and "wrong password" have a similar
    timing profile; returns the identical `AppError` for both (no
    username enumeration).
  - **Refresh rotation — locked lifecycle**: the OLD token entry is
    **removed outright**, not revoked-and-kept (no growing graveyard).
    **Concurrency contract**: two concurrent `refresh()` calls presenting
    the same old token — exactly one succeeds, the other gets 401. This
    falls directly out of `findOneAndUpdate()`'s filter including the
    exact `tokenHash` being consumed: MongoDB serializes writes to the
    same document, so the losing concurrent request's identical filter
    no longer matches after the winner's `$pull` commits, and
    `findOneAndUpdate` returns `null` for it — no separate locking
    primitive needed. (Verified by careful reasoning about MongoDB's
    single-document write serialization guarantees; **not yet verified
    by actually running the concurrency test** — see the sandbox caveat
    below.)
  - **Logout**: no access token required (locked, reversing my own
    initial proposal after review). Idempotent — always `200 { success:
    true }`, whether the token existed, was already revoked, or expired;
    never an oracle for token validity.
  - **Password change**: verifies `currentPassword`, updates the hash
    AND clears `refreshTokens` to `[]` in one `$set` update — no
    observable window where the password changed but old sessions
    remain valid. Issues no replacement tokens; the user must log in
    again, including on the device that made the request.
- `backend/src/middleware/requireAuth.js` (new) — stateless access-token
  verification middleware; attaches `req.user = { id }`; never logs the
  Authorization header or token, on success or failure.
- `backend/src/middleware/authRateLimiter.js` (new) — isolated
  `express-rate-limit` config (10 requests / 15 minutes / IP — an
  explicitly-flagged reasonable default, not a researched number),
  applied to `/login` and `/refresh` only, not `/logout` or `/password`.
- `backend/src/controllers/authController.js` (new) — thin
  request/response wrappers; input presence/type validation happens here
  (and correctly throws before ever touching `authService`/Mongo for a
  malformed request — confirmed by the fast, Mongo-free validation
  tests).
- `backend/src/routes/authRoutes.js` (new) — `POST /login`, `POST
  /refresh` (both rate-limited), `POST /logout` (not rate-limited, no
  auth required), `PATCH /password` (behind `requireAuth`, not
  rate-limited — different abuse profile per the locked contract).
- `backend/src/app.js` — extended to build `authService` and mount
  `createAuthRouter()` at `/api/auth`; `createApp()`'s options now
  include the JWT/refresh-token config, all still flowing in as explicit
  parameters (no direct `process.env` reads inside `app.js`, consistent
  with `config/env.js`'s testability design).
- `backend/server.js` — passes the new JWT/refresh-token config through
  to `createApp()`.
- `backend/tests/models/User.test.js`, `tests/services/tokenService.test.js`,
  `tests/middleware/requireAuth.test.js`, `tests/authRoutes.test.js` (new)
  — all Mongo-free, all **genuinely executed**.
- `backend/tests/services/authService.test.js` (new) — the real
  login/refresh/logout/password-change behavior, **including the
  critical concurrent-refresh test**. Mongo-dependent; **written but
  NOT executed in this session** — confirmed to parse and import
  correctly, and confirmed to fail at exactly the expected point
  (`MongoMemoryReplSet` binary download) when actually run, not at any
  earlier syntax/logic error.

**Real bug found and fixed during this slice, via actually running the
Mongo-free route tests, not just reading them:** the newly-added
Mongo-free `authRoutes.test.js` tests were each taking 10+ seconds
(correctly passing, but for the wrong reason) because Mongoose's default
command buffering waited its full timeout before erroring, since that
test file never calls `connectDb()` (deliberately — it only exercises
validation-before-any-DB-call paths and 401 behavior). Fixed by setting
`mongoose.set('bufferCommands', false)` at the top of that specific test
file, mirroring the same fail-fast principle `config/db.js`'s
`connectDb()` already applies for the real connected case. Full suite
time for the Mongo-free tests dropped from ~30s to ~600ms for the
affected file, with identical pass/fail outcomes — confirming the slowness
was pure overhead, not a hidden correctness dependency on the delay.

**Sandbox test-run finding (new since 5A, worth stating precisely):**
running the full suite via plain `node --test`/`npm test` in this
sandbox now correctly **exits 1** (not a false green), because
`authService.test.js`'s `before(connectTestDb)` hook hangs attempting
the `MongoMemoryReplSet` binary download, times out, and Node's test
runner correctly marks every test in that file as `cancelledByParent` —
accurate, honest reporting of a genuinely blocked dependency, not a
bug to suppress. **The trustworthy signal in this sandbox is obtained by
running every test file except `tests/services/authService.test.js`**:
confirmed **74/74 passing, 0 cancelled, ~2.5s**, by temporarily removing
that one file from discovery and restoring it immediately after.
`authService.test.js` itself (18 tests, including the concurrent-refresh
test) needs to be run for real, outside this sandbox, before Phase 5B's
completion gate can be honestly claimed as fully passing — the same
standing caveat as 5A, now applying to a second file.

Test count this slice: **74 new/updated Mongo-free tests passing**
(6 User/toDeviceLabel + 13 tokenService + 7 requireAuth + 11 authRoutes,
plus pre-existing 5A tests re-confirmed) **+ 18 Mongo-dependent tests in
authService.test.js, written but unverified in this sandbox.** Frontend:
689/689, unaffected.

#### 5B corrective pass (post-review)

Two required fixes and two recommended corrections, all addressed:

1. **Required fix — refresh rotation made genuinely atomic.** The
   original implementation performed `findOneAndUpdate()` with `$pull`
   followed by a *separate* `updateOne()` with `$push` — two round
   trips, correctly preventing double-consumption of the old token (the
   `$pull`'s match/no-match outcome was already race-safe), but leaving
   a real window where the old token was gone and the new one wasn't
   yet persisted. **Fixed** by replacing both calls with a single
   `findOneAndUpdate()` using a MongoDB aggregation-pipeline update
   (`$set` with `$filter` + `$concatArrays`, computed in one expression)
   — the entire remove-old/add-new state transition now happens in
   exactly one atomic document write. The query filter (matching only a
   still-present, non-revoked, unexpired token) continues to provide the
   same concurrency guarantee as before, now correctly backing a
   genuinely atomic operation rather than the first half of a two-step
   one. The existing concurrent-refresh test in `authService.test.js`
   is unchanged in intent (two concurrent calls, same old token, exactly
   one succeeds) and still the anchor test for this behavior — still
   unverified in this sandbox for the same standing reason.
2. **Required fix — seed workflow implemented.**
   `backend/src/scripts/seed.js` (new) + `npm run seed` (new
   `package.json` script). Split into `seedUser()` (testable core logic,
   takes explicit `{ username, password }`, requires an already-active
   Mongoose connection, never calls `process.exit`) and a CLI entrypoint
   wrapper (loads real config via `loadConfig()`, connects/disconnects,
   translates outcomes to process exit codes) — the same separation
   already established by `config/env.js`'s `validateEnv()`/
   `loadConfig()` split, for the identical reason: core logic needs to
   be unit-testable without killing the test process. Idempotent:
   returns `{ created: false, ... }` and does nothing if the username
   already exists; never resets an existing password on re-run; never
   creates a duplicate. `backend/tests/scripts/seed.test.js` (new, 5
   tests) — Mongo-dependent, same standing sandbox caveat as
   `authService.test.js`, confirmed to parse/import correctly and fail
   at exactly the expected binary-download point when actually run.
3. **Recommended correction — rate-limit error code.** `AppError`'s
   locked vocabulary extended from 9 to **10** codes: added
   `RATE_LIMITED` (429), previously the rate limiter incorrectly reused
   `VALIDATION_ERROR` (400) for a 429 response — a genuine mislabeling,
   not a style preference, since a rate-limited request's body may be
   perfectly well-formed. `authRateLimiter.js` updated to use the new
   code; `AppError.test.js` updated for the vocabulary-size and
   status-mapping assertions; a new Mongo-free test in
   `authRoutes.test.js` genuinely exceeds the configured limit (11
   sequential requests against one shared app instance, since
   `express-rate-limit`'s counter is per-instance) and confirms both the
   `429` status and the `RATE_LIMITED` code — **executed, passing**.
4. **Recommended correction — narrowed the logout query.**
   `authService.js`'s `logout()` previously used `User.updateOne({},
   ...)`, matching the collection's first document unconditionally —
   harmless today (exactly one seeded user) but an imprecise query that
   only happened to work by coincidence, not something to leave as
   "fine for now." Narrowed to `User.updateOne({ 'refreshTokens.tokenHash':
   tokenHash }, ...)`. Idempotent/non-oracle logout behavior is
   unaffected — a `$pull` against no matching document remains a
   harmless no-op, and the caller still always receives `{ success: true
   }`.
5. **Checked, not changed** — `backend/.env.example` was verified to
   already document every variable in `env.js`'s `REQUIRED_VARS` list
   (cross-checked field-by-field), with sensible section comments; `.env`
   is confirmed gitignored at the repo root (`*.env` with an explicit
   `!*.env.example` exception). No edit was needed; reporting this as
   verified-and-already-satisfied rather than making an unnecessary
   change.

Corrective-pass diff scope: `src/services/authService.js` (rotation +
logout), `src/middleware/AppError.js` (new code), `src/middleware/
authRateLimiter.js` (code fix), `src/scripts/seed.js` (new), `package.json`
(new `seed` script), `tests/middleware/AppError.test.js` (updated),
`tests/authRoutes.test.js` (new rate-limit test), `tests/scripts/
seed.test.js` (new). **No other file changed. No frontend file changed.
No Phase 5C work started.**

Re-run after the corrective pass: Mongo-free suite (isolating the two
Mongo-dependent files the same way as before) — **75/75 passing, 0
cancelled, ~2.5s.** Frontend: 689/689, unaffected. The two Mongo-dependent
files (`authService.test.js`, now 18 tests; `seed.test.js`, new, 5 tests)
remained confirmed-to-parse-and-fail-at-the-expected-point only at that
point — see the full local verification below, which resolves this.

#### Full local verification (outside the sandbox) — ✅ CONFIRMED GREEN

Run by the project owner on their own machine, with real network access
to `fastdl.mongodb.org` (which this development sandbox cannot reach —
see the standing limitation noted throughout this Phase 5B entry).

**Result: 103 tests, 26 suites, 103 pass, 0 fail, 0 cancelled, 0
skipped.** This is the first time the complete backend suite — including
every `MongoMemoryReplSet`-dependent test — has actually executed
end-to-end. It genuinely, not just by careful reasoning, confirms:

- The atomic refresh-rotation rewrite (single `findOneAndUpdate()` with
  an aggregation-pipeline `$set`/`$filter`/`$concatArrays` update) behaves
  correctly against a real MongoDB replica set.
- **The concurrent-refresh test passes**: two simultaneous `refresh()`
  calls presenting the same old token — exactly one succeeds, the other
  receives 401 — the single most important test in this phase, now
  observed passing, not just argued through in code comments.
- `seedUser()`'s idempotency (no duplicate creation, no password reset on
  re-run) holds against real persistence.
- Every other Mongo-dependent case in `authService.test.js` (login,
  logout, password change, session-invalidation-on-password-change, all
  the failure-path rejections) passes against real data.

The standing "written but unverified in this sandbox" caveat that has
applied to Mongo-dependent tests since Phase 5A is now **resolved for
every test that exists as of the end of Phase 5B**. It will still apply
to any *new* Mongo-dependent tests written in Phase 5C onward, in this
same development sandbox, until they are likewise confirmed on a machine
with real network access — this is a per-slice caveat, not a one-time
gap that stays permanently closed.

**A genuine file-delivery gap was found and fixed along the way, worth
recording:** the output-delivery process during this phase only included
files with *new* changes in each specific pass (5A, 5B, 5B-corrective),
rather than the complete current state of `backend/` — so `app.js`
(which received its auth-router-mounting edit during the original 5B
pass, not the corrective pass) and `models/User.js` and
`services/tokenService.js` were never actually re-delivered after their
initial inclusion, and did not make it into the committed local
repository. This surfaced as `ERR_MODULE_NOT_FOUND` and every auth route
404ing locally, despite the sandbox's own copy being correct throughout
— confirmed by inspection before any fix was made, per the instruction
not to modify tests or re-architect anything to chase the symptom.
Resolved by delivering the complete, current `backend/src/` and
`backend/tests/` file sets in one batch rather than an incremental diff.
**Going forward, output batches for this project should default to the
complete current file set for any directory touched, not an
incremental-changes-only list**, to avoid this class of gap recurring in
Phase 5C.

### 5C — Classification Persistence — ✅ COMPLETE AND FULLY VERIFIED

Implements server-side CRUD + archive for `Category`/`Location`/`Tag`/`Unit`,
per the authorized Phase 5C contract (four explicit public resource paths,
shared internal model/service/controller/router infrastructure, no
`/api/classifications/:type` generic endpoint).

**Files added:**
- `src/models/classificationModel.js` — one schema factory producing four
  separate Mongoose models/collections (`Category`/`categories`,
  `Location`/`locations`, `Tag`/`tags`, `Unit`/`units`), all sharing the
  identical persisted shape (`_id: String`, `ownerId`, `name`, `archived`,
  `isDefault`, `updatedAt`) and the `{ ownerId: 1, archived: 1 }` index.
- `src/services/classificationService.js` — the real logic, shared across
  all four resources via one factory bound to a model. Owns: ownership
  scoping on every query/write; the locked URL-vs-body `id` identity rule
  (body `id` absent or matching the URL → allowed; mismatched → rejected
  with `VALIDATION_ERROR`); server-set `ownerId`/`updatedAt` on every
  write, never client-controlled; field validation (`name` trimmed
  non-empty string, `archived`/`isDefault` boolean if present) — capped
  deliberately to what the authorization specified, nothing added
  speculatively.
- `src/controllers/classificationController.js` — thin request/response
  wrapper, mirrors `authController.js`'s style.
- `src/routes/classificationRouterFactory.js` (shared `GET /` + `PUT /:id`
  wiring behind `requireAuth`) plus four explicit routers
  (`categoryRoutes.js`, `locationRoutes.js`, `tagRoutes.js`,
  `unitRoutes.js`) — each a few lines binding the shared factory to one
  model, keeping the four public paths explicit while not duplicating the
  actual routing logic four times.
- `src/app.js` — mounts the four routers at `/api/categories`,
  `/api/locations`, `/api/tags`, `/api/units`, before `notFoundHandler`/
  `errorHandler`.
- `tests/categoryRoutes.test.js`, `tests/locationRoutes.test.js`,
  `tests/tagRoutes.test.js`, `tests/unitRoutes.test.js` — 21 tests each
  (84 total), `node --test` + `MongoMemoryReplSet` + `supertest`, covering
  every case in the Phase 5C authorization's Listing/Upsert/Validation/
  Ownership sections. **Placed flat in `tests/`, not under a `tests/
  routes/` subdirectory** — see the file-placement note below; this
  matches the one existing precedent (`authRoutes.test.js`) rather than
  inventing a new nesting convention for router tests specifically.

### The cross-owner upsert collision — the one genuinely tricky part of this slice

Flagged during review as the place a naively-written `findOneAndUpdate(...,
{ upsert: true })` could quietly do the wrong thing: if the update filter
matches on `_id` alone, an attacker/bug submitting another owner's existing
`entityId` would silently overwrite that owner's document.

**Resolution:** the filter matches on `{ _id: urlId, ownerId }` together,
never `_id` alone. If `urlId` already exists under a *different* owner,
this filter matches nothing — so Mongo's upsert attempts an **insert**
with that `_id`, which collides with the existing document and throws a
duplicate-key error (code `11000`) rather than silently overwriting or
silently no-oping. `classificationService.js` catches that specific error
and translates it into an explicit `CONFLICT` (409). Tests prove: (a) the
victim's document is unchanged, (b) exactly one document exists for that
`_id` afterward (`countDocuments === 1`, added during review — the
original test only checked the *content* was unchanged, not that no
second document existed), and (c) two owners choosing two genuinely
*different* ids never interfere with each other (a test that was
initially titled as if it proved same-id coexistence across owners — it
did not, and could not, since `_id` is a globally unique Mongo primary
key; caught in review and renamed/re-commented rather than left
misleading).

### A test that was written, then disproven, then removed — worth recording

A test asserting that a bare JSON primitive body (e.g. a raw string) would
reach `classificationService` and fail with `VALIDATION_ERROR` was added
during the review-response pass, based on reasoning about the code rather
than observing the real pipeline. When actually run against the real
Express app, `express.json()`'s default `strict: true` mode rejects a
bare JSON primitive **at the body-parser layer**, before Express routing
— the real observed response was `500 INTERNAL_ERROR`, not `400
VALIDATION_ERROR`, and the request never reached the service at all. The
test was deleted rather than "fixed" to match the wrong behavior; its one
legitimate assertion (error-message consistency) was merged into the
adjacent array-payload test, which **does** verifiably reach the service
(confirmed by direct execution, not inference). The
`classificationService.js` code change that motivated the deleted test
(not coercing non-object payloads to `{}` before validating) was kept —
it's still correct for the service's own internal consistency and for any
future non-HTTP caller — but its comment was corrected to state plainly
that a bare-primitive HTTP request can't reach this path today, rather
than implying it could.

### File-placement correction: flat `tests/`, not `tests/routes/`

The four test files were initially delivered under a `tests/routes/`
subdirectory, invented without checking the actual existing convention
first. The only real precedent — `src/routes/authRoutes.js` →
`tests/authRoutes.test.js` — places router-level tests **flat**, not
mirrored under a `tests/<subdir>/` structure the way `config/`,
`middleware/`, `models/`, `services/`, and `scripts/` are. This surfaced
as import-path failures (`../helpers/testDb.js` etc. resolved from the
wrong depth) when the project owner ran the suite locally. Fixed by
deleting `tests/routes/` and placing the four files flat in `tests/`,
with imports corrected to match (`./helpers/testDb.js`, `../src/app.js`,
etc.) — decided by checking the one real existing precedent rather than
guessing, and confirmed by an actual local run reaching the `before()`
hook (only stopping at the expected Mongo-binary-download point) rather
than failing on `ERR_MODULE_NOT_FOUND` as it had before the fix.

### Full local verification (outside the sandbox) — ✅ CONFIRMED GREEN

Run by the project owner on their own machine, with real network access to
`fastdl.mongodb.org`. **All backend tests pass**, including all 84 new
Phase 5C classification tests — this is the first real, not just
reasoned-through, confirmation of the cross-owner collision handling, the
identity-rule enforcement, and the upsert idempotency behavior against a
genuine MongoDB replica set.

Mongo-free baseline (confirmable in-sandbox throughout this phase, and
reconfirmed after every edit): **75/75 passing, unaffected.** Frontend:
**689/689, unaffected** — Phase 5C touched no frontend files.

The standing "written but unverified in this sandbox" caveat is now
resolved for every test that exists as of the end of Phase 5C. Per the
Phase 5B entry's own note, this is a per-slice caveat — it will apply
again to whatever new Mongo-dependent tests Phase 5D writes, until those
are likewise confirmed for real.

### 5D — Product Persistence — ✅ COMPLETE AND FULLY VERIFIED

Server-side CRUD for `Product`, scoped deliberately narrower than the
original phase sketch after a mid-implementation architectural correction
(see below).

**The scope correction, worth recording in full because it's the most
important thing about this phase:** the first draft of 5D implemented
Product persistence AND server-side generation of `ProductChangeEvent`s
via a diff between the incoming payload and the previously stored
document, committed together in one transaction. This was **reverted
before completion** once review established that `ProductChangeEvent.id`
is client-generated (same `entityId`-as-`_id` convention as everything
else in this project) and that the client's own `productService.js`
already constructs fully-formed `ProductChangeEvent` objects, as a
**separate sync operation** (`entityType: 'productChangeEvent'`, distinct
from `entityType: 'product'`), before either ever reaches the server. A
server that independently diffs and invents its own change events would
create a second, competing authority for the exact historical record the
client already owns — precisely the category of mistake this project's
`entityId`/`clientId` philosophy exists to prevent. The unfinished
diffing code was discarded outright, not patched into correctness.
**ProductChangeEvent persistence is deferred to its own later slice**
(renumbered 5F in the revised roadmap below) that will accept
already-constructed event payloads with their client-assigned identity
preserved, not synthesize new ones.

**Files:**
- `src/models/productModel.js` — `entityId`-as-`_id`, mirrors
  `productFactory.js`'s field shape plus server-owned `ownerId`/
  `updatedAt`. `quantity` is persisted (it's the materialized value) but
  is never settable through this endpoint — see below.
- `src/services/productService.js` — the quantity-rejection invariant
  (`quantity` in the payload, under any value including `0`/`null`,
  checked by property presence via `Object.hasOwn()`, not truthiness →
  `VALIDATION_ERROR`, new products default to `quantity: 0` server-side)
  and the changeEvents-rejection invariant (a `changeEvents` key in the
  payload, including an empty array, → `VALIDATION_ERROR`) — both added
  as explicit, tested guards, not just comments, after review pointed
  out the first delivery only documented the changeEvents boundary
  without actually enforcing it. Identity validation (PRD §4.1: name or
  photoRef required) is checked against the **effective post-patch
  state** (existing + payload merged), not the payload in isolation, so
  a photoRef-only update to an already-named product isn't wrongly
  rejected. Same `{_id, ownerId}` cross-owner-collision → `CONFLICT`
  pattern as `classificationService.js`. Single-document upsert, no
  session/transaction — correctly, since there's no second collection to
  coordinate with once `ProductChangeEvent` was removed from scope.
- `src/controllers/productController.js`, `src/routes/productRoutes.js`
  — thin, matching the established pattern.
- `tests/productRoutes.test.js` — 48 tests: listing, creation, the
  quantity invariant (including presence-not-truthiness for
  `quantity: 0`/`null`, and an update-time rejection verified to cause
  no partial write), the changeEvents invariant (create, update, and an
  empty array specifically — proving presence-not-emptiness — plus a
  test confirming a rejected multi-field update leaves every field
  untouched, not just the one the illegal payload happened to mention),
  patch semantics, identity validation on partial updates, field
  validation, ownership isolation, and two explicit assertions that
  `productChangeEvents` stays empty across both creation and updates to
  tracked-looking fields.

**Verified locally by the project owner, full backend suite passing.**
Mongo-free baseline held at 75/75 throughout; frontend untouched.

**Endpoints:** `GET /api/products` (`?includeArchived=true`),
`PUT /api/products/:id`. No `GET /:id`, no `DELETE` — archive-only, same
as classifications.

---

### 5E — Stock Events and Controlled Quantity Mutation — ✅ COMPLETE AND FULLY VERIFIED

Implements the **only legitimate backend path for changing
`Product.quantity`**. `PUT /api/products/:id` (Phase 5D) permanently
rejects `quantity` in its payload; this phase is where that authority
actually lives.

**Investigation-first discipline, per the phase's own instruction:** Pass
1 was investigation-only (no code), inspecting `stockEventFactory.js`,
`applyStockEvent.js`, `reversal.js`, `stockEventRepository.js`'s commit
transaction, and `ARCHITECTURE.md`'s sync/idempotency sections before any
contract was proposed. This surfaced a real architectural tension worth
recording: the client's own sync queue emits a `stockEvent` insert AND a
*separate* `product` upsert (with the resulting quantity, under a fresh
`clientId`) as two independent sync operations. Locked resolution: the
server computes quantity itself, authoritatively, mirroring
`applyStockEvent()` — it does not trust a client-supplied quantity via
any path, including a `product` sync entry. Reconciling the client's
separately-queued `product` quantity upsert against this authoritative
server-computed value is explicitly a **Phase 6 sync-contract concern**,
not weakened into this phase.

**Locked transaction ordering** (`stockEventService.js`'s `processEvent()`,
one Mongoose session per request):

```
1. idempotency check       -- existing StockEvent for {_id, ownerId}?
                               YES -> return immediately, no mutation.
2. load owned Product      -- {_id: productId, ownerId}. Missing -> NOT_FOUND.
3. expectedCurrentQuantity check -- mismatch -> QUANTITY_CONSISTENCY_CONFLICT.
4. reversal validation, if reversalOf present (see below)
5. compute appliedQuantity + nextQuantity (mirrors applyStockEvent.js exactly)
6. insert StockEvent
7. update Product.quantity  -- matchedCount checked explicitly
8. if reversal, patch original.reversedBy -- matchedCount checked explicitly
```

**Why idempotency runs first, before the concurrency check — the
retry-breaking bug this ordering exists to prevent:** a successful
request advances `product.quantity` away from whatever
`expectedCurrentQuantity` the client sent. If the client's response is
lost and it retries with the same event id and the now-stale
`expectedCurrentQuantity`, checking concurrency before idempotency would
reject a request whose effects already fully committed — punishing
exactly the retry behavior a reliable client is supposed to perform.
Explicitly tested: a retry carrying its original `expectedCurrentQuantity`
against a product whose real quantity has already moved succeeds as a
no-op, not a `409`.

**Reversal validation — three separate invariants, two of them added
during a second review pass after the first delivery only implemented
one:**
1. **Quantity equals the original's stored `appliedQuantity`** — server-
   derived authority, not trusted from the client. This is what prevents
   a reversal from restoring the *originally requested* quantity of an
   over-removal instead of what actually applied (e.g. `REMOVE 10` on a
   stock of `4` clamps to `appliedQuantity: 4`; a reversal claiming
   `quantity: 10` would manufacture 6 units of inventory that were never
   actually removed — rejected with `VALIDATION_ERROR`).
2. **Opposite event type** (added after review) — reversing an `ADD`
   must submit `REMOVE` and vice versa. Quantity-matching alone is not
   sufficient: a same-type "reversal" with a matching quantity would
   silently *double* the original movement instead of undoing it. This
   was the more dangerous of the two gaps found in review, since it
   directly manufactures/destroys inventory rather than merely
   misattributing it.
3. **Same product as the original event** (added after review) — a
   reversal targeting a different product than the event it claims to
   reverse would mutate the wrong product's inventory while marking the
   unrelated original as reversed, corrupting the historical relationship
   between the two events.

**Hardening pass, applied after a second review round:** the two
`updateOne` writes (Product quantity, original event's `reversedBy`) now
explicitly check `matchedCount === 1` and throw `NOT_FOUND` rather than
silently trusting that a write inside the transaction necessarily matched
a document, since inventory-mutation code should fail loudly on an
unexpected zero-match write rather than assume correctness because an
earlier read happened to succeed. Also tightened
`originalEvent.reversedBy !== null` to `!= null`, so the already-reversed
check catches `undefined` as well as `null` even though the schema's
default makes this a belt-and-suspenders change under normal operation.

**Files:**
- `src/models/stockEventModel.js` — `entityId`-as-`_id` doubles as the
  idempotency key for this insert-only collection (no separate
  `clientId` field, matching `ARCHITECTURE.md`'s confirmed "server
  rejects/ignores duplicate clientId" contract — for an insert-only
  collection keyed by entityId, existence-by-id already answers that).
  Stores `appliedQuantity` (commit-time-only persistence metadata, never
  part of the domain `StockEvent` shape, and never client-writable — see
  validation below).
- `src/services/stockEventValidation.js` — pure shape/static-field
  validation only, no DB access (everything requiring a lookup lives in
  the transactional service). Went through one full review-correction
  round: the first delivery's `isValidIsoDateTime()` relied on
  `new Date()`'s permissiveness, which accepts freeform strings like
  `"September 2, 2026"` and silently rolls impossible calendar dates
  like `"2026-02-31"` over to `"2026-03-03"` instead of rejecting them.
  Fixed by porting the client's own `dates.js` validators directly
  (exact anchored-pattern match plus, for date-only values, a
  `Date.UTC()` round-trip check) rather than inventing a second,
  possibly-different strictness level. Also tightened `costPerUnit`/
  `purchaseDate` rejection on `REMOVE` events from "rejects a meaningful
  non-null value" to "rejects the key's presence at all, including an
  explicit `null`" — the locked contract's literal wording.
- `src/services/stockEventService.js` — the transactional core; see
  above.
- `src/controllers/stockEventController.js`, `src/routes/stockEventRoutes.js`
  — thin. `GET /api/stock-events` (`?productId=`, `?includeReversed=`),
  `PUT /api/stock-events/:id`. No separate reversal endpoint — a
  reversal is submitted through the same `PUT /:id`, distinguished only
  by `reversalOf` being present, mirroring `reversal.js`'s own domain
  philosophy that reversal is not a separate operation from an ordinary
  stock event.
- `tests/stockEventRoutes.test.js` — 29 tests: basic ADD/REMOVE
  processing including the over-removal clamp, optimistic concurrency,
  idempotency (including the exact stale-`expectedCurrentQuantity`-retry
  scenario), ownership isolation, cross-owner id collision, all three
  reversal invariants (including both directions of the same-type
  rejection, tested separately since a single test could pass against a
  broken ternary that only rejects one direction), validation, listing,
  and **two forced mid-transaction failure tests** — one breaks the
  Product quantity update after the StockEvent insert has already
  "succeeded," the other breaks the `reversedBy` patch specifically —
  each proving genuine rollback (event count and quantity completely
  unchanged) rather than assuming Mongo transactions work because the
  driver documentation said something reassuring.

**Verified locally by the project owner, full backend suite passing
(263/263).** Mongo-free baseline held at 75/75 throughout every pass;
frontend untouched.

---

### 5F — ProductChangeEvent Persistence — ✅ COMPLETE AND FULLY VERIFIED

Renumbered per the Phase 5D scope correction (see 5D's entry above):
`ProductChangeEvent` persistence, originally sketched as part of 5D, is
its own slice here, accepting already-constructed client-generated event
payloads rather than deriving them server-side.

**The scope boundary this phase exists to hold:** the client already
builds complete `ProductChangeEvent` objects locally
(`productService.js`'s `buildChangeEvents()`, comparing old/new Product
state against `TRACKED_FIELD_MAP`) as a separate sync operation
(`entityType: 'productChangeEvent'`) before either it or the corresponding
`product` sync entry reaches the server. This endpoint's job is strictly
to **persist** that already-decided history, ownership-scoped and
idempotent — never to independently diff, infer, or reconstruct what
changed. An early draft of Phase 5D had briefly explored server-side
diffing before this boundary was locked; 5F holds that line rather than
reopening it.

**Product lookup is validation-only, not a mutation trigger:**
`PUT /api/product-change-events/:id` verifies the referenced Product
exists and is owned by the caller (`NOT_FOUND` if not — "doesn't exist"
and "exists under a different owner" are indistinguishable responses,
consistent with every other cross-owner boundary in this project) but
this lookup **never** mutates the Product, never compares `oldValue`/
`newValue` against the Product's actual current field values, and never
recomputes or second-guesses the change being recorded. The Product
lookup exists solely to answer "is this a legitimate reference the caller
is allowed to see," nothing more.

**Idempotency check runs before the Product lookup — the same
retry-safety reasoning as 5E's ordering, deliberately reused rather than
re-derived:** if the idempotency check ran second, a retry of an event
whose first attempt already succeeded — but whose referenced Product has
since been deleted by an unrelated later action — would incorrectly fail
with `NOT_FOUND` instead of returning the already-persisted event as a
no-op. (Archival alone does not trigger this: the lookup filters only on
`{_id, ownerId}`, not `archived`, so an archived-but-not-deleted Product
still satisfies it.) Explicitly tested: the referenced Product is deleted
*after* a successful first write, then a retry with the same event id is
confirmed to still succeed as a no-op, proving the ordering rather than
merely asserting it.

**`accepted` — insert-only in this phase, not yet updatable:**
`accepted` is always server-set to `true` at insert time. The endpoint
rejects any client-supplied `accepted` key at all — including an explicit
`accepted: true` that happens to match what the server would have set —
using the same presence-based (`Object.hasOwn()`, not truthiness) guard
pattern as `Product.quantity` (5D) and `StockEvent.appliedQuantity` (5E).
No update path exists for `accepted` yet. Later-arriving-but-earlier-
timestamped LWW conflict resolution, which could someday need to flip an
already-inserted event's `accepted` to `false`, is explicitly deferred to
**Phase 6** — this phase does not build toward it speculatively.
(`ARCHITECTURE.md`'s MongoDB-schema description of `productChangeEvents`
was found, during the Phase 5G hardening pass below, to have described
this as if the update path already existed; corrected there.)

**Timestamp validation:** `ProductChangeEvent.timestamp` reuses
`stockEventValidation.js`'s exported date/timestamp validators directly
(the client's own ported `dates.js` logic) rather than a second
implementation — same reasoning as 5E: a bare `new Date()` check would
silently accept malformed input and roll over impossible calendar dates.

**Files:**
- `src/models/productChangeEventModel.js` — `entityId`-as-`_id`,
  insert-only, ownership-scoped, `accepted` defaults `true` at the schema
  level (mirroring the service's own default, not a second source of
  truth for it).
- `src/services/productChangeEventValidation.js` — shape validation only;
  re-exports/reuses `stockEventValidation.js`'s timestamp validators
  rather than duplicating them.
- `src/services/productChangeEventService.js` — idempotency check, then
  ownership-scoped Product existence check (validation-only, per above),
  then insert.
- `src/controllers/productChangeEventController.js`,
  `src/routes/productChangeEventRoutes.js` — thin, `requireAuth`-gated,
  `GET /api/product-change-events` (`?productId=`) + `PUT /:id`.
- `tests/productChangeEventRoutes.test.js` — 22 tests: basic persistence,
  ownership isolation, cross-owner id collision (`CONFLICT`), the
  idempotency-survives-deleted-Product retry test described above,
  `accepted`-presence rejection (including the `accepted: true` case),
  timestamp validation, listing.

**Verified locally by the project owner, full backend suite passing
(285/285).** Mongo-free baseline held at 75/75 throughout; frontend
untouched (24 files, 689 tests, unaffected — no frontend files touched in
5C–5F).

---

### 5G — Hardening / Integration Verification — ✅ COMPLETE

**Explicit scope discipline, stated by the project owner and carried into
this entry verbatim because it's the reason this phase is small:** *"We
should not manufacture a 'hardening phase' full of random refactors
because the roadmap happens to have a letter left."* 5G's job was to
verify the claims made across Phases 5A–5F against the actual repository
state — not to add new endpoints, resources, or speculative tests.

**Pass 1 — fresh inspection, no assumptions carried over from prior
session summaries.** Re-cloned the repository fresh, re-ran and
re-confirmed both test baselines directly rather than trusting any
document's stated numbers: **75/75 Mongo-free** (confirmable in-sandbox)
and, separately, the **285/285 full-suite result the project owner had
already confirmed locally, with real network access** — the sandbox
itself did not and cannot run the Mongo-dependent suite (`fastdl.mongodb.org`
returns `403` at the egress proxy, the same standing limitation noted in
every phase since 5A). Inspected, file by file: every mounted route and
its auth boundary, the ownership-isolation pattern at every service,
the error vocabulary and its HTTP mapping against each locked contract,
every use (and non-use) of a Mongoose transaction, timestamp-validation
consistency, and cross-owner/auth-required test coverage across all
seven resource test files.

**Findings, categorized:**

*Blocking correctness/security issues:* none found. No auth bypass, no
cross-owner leak, no silent quantity/history corruption, no error-code
misuse anywhere in the actual code.

*Confirmed hardening gaps (the only three items 5G actually touched):*
1. This file (`PROGRESS.md`) had not been updated when the 5F commit
   landed — it still read "5F–5G — NOT STARTED" with a stale pre-5F test
   count. Fixed by this very entry and the 5F entry above it.
2. `ARCHITECTURE.md`'s `productChangeEvents` schema-section bullet
   described `accepted` as already having an update path ("the one
   exception to events-never-mutated"), which doesn't match the actual
   5F implementation (insert-only, no update path, LWW deferred to Phase
   6). Corrected, and a Phase 5F binding-pattern subsection was added
   alongside the existing 5C/5D/5E ones, documenting the validation-only
   Product lookup and the idempotency-before-lookup ordering as the
   intentional retry guarantees they are, not implementation accidents.
3. `DUPLICATE_ENTITY` existed in the locked error vocabulary
   (`AppError.js`) with a full status mapping but had zero use sites
   anywhere in the codebase — every actual duplicate/cross-owner-
   collision path already correctly threw `CONFLICT`. Removed rather
   than left as an unexplained dead member of a "closed, locked" set;
   `AppError.test.js` updated to assert the resulting nine-code
   vocabulary. If a future phase needs a distinct duplicate-entity
   semantic, it should be reintroduced deliberately, with a real use site
   from the start, not resurrected by guessing what the unused constant
   "probably meant."

*Documentation drift:* the two items above are the only instances found;
no further drift located in `ARCHITECTURE.md`'s other Phase 5 sections
(5C/5D/5E's binding-pattern write-ups were checked line-by-line against
the actual code and match closely).

*Explicitly verified as correct, not touched:* ownership isolation
(`{_id, ownerId}` filter pattern, universal across all four
client-generated-`entityId` services); transaction scoping (5E's
`stockEventService.js` remains the sole session/transaction user in the
entire backend, confirmed by grep, not assumed); error-envelope
consistency (`{error:{code,message}}`, one central `errorHandler.js`,
`Object.hasOwn()` used throughout, not `in`); the insert-only enforcement
model for `StockEvent`/`ProductChangeEvent` (zero stray `update`/
`updateMany` calls outside the two documented exceptions in
`stockEventService.js`); cross-owner and auth-required test coverage,
present and consistent across all seven resource test files; the
frontend/backend timestamp validator parity (`stockEventValidation.js`'s
logic compared directly against `dates.js` and confirmed to be a genuine
port, not a re-derivation).

**Files touched:**
- `backend/src/middleware/AppError.js` — `DUPLICATE_ENTITY` removed from
  `ERROR_CODES` and `DEFAULT_STATUS_BY_CODE`; header comment updated to
  record the removal and why, consistent with this project's practice of
  logging corrections rather than silently rewriting history.
- `backend/tests/middleware/AppError.test.js` — removed the
  `DUPLICATE_ENTITY` status assertion; updated the vocabulary-count test
  to the resulting nine codes.
- `docs/ARCHITECTURE.md` — corrected `productChangeEvents.accepted`
  description; added the Phase 5F binding-pattern subsection.
- `docs/PROGRESS.md` — this entry, plus the 5F entry above it.

**No endpoints, resources, indexes, or transactions were added or
changed. No speculative tests were added** — Pass 1's coverage audit
found no genuine gaps in cross-owner or auth-required test coverage, so
nothing else was in scope.

**Verification:** Mongo-free suite re-run after the `AppError.js` change,
still **75/75, 0 failures**. Mongo-dependent test files were checked by
inspection (grep) for any `DUPLICATE_ENTITY` reference — none found — and
remain unverified-in-sandbox per the standing limitation; genuine
pass/fail confirmation for those requires the project owner running
locally, same as every phase since 5A.

## Phase 6 — Sync engine — NOT STARTED
## Phase 7 — Dashboard + classification management UI — NOT STARTED
## Phase 8 — Export + PWA polish + hardening — NOT STARTED

---

## Assumptions in effect (see ARCHITECTURE.md for detail)

1. Average known cost = all-time recorded-cost additions.
2. Reversal events are themselves reversible.
3. Photos: IndexedDB blob locally, free-tier object storage on sync.
