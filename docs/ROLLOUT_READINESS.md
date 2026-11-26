# ShopStock: rollout readiness (R10 Phase 3b)

**Written:** 2026-11-23, after R10 Phase 3a, on `master` at `cc36fe0` plus the notice cleanup.
**Updated** for the production deployment hardening change: sections 1.1, 1.2, 2, 3, 4 (G4 and G6) and 6.

## What this document is, and is not

This is an **evidence record and a controlled-deployment recommendation**. It
separates four things that are easy to blur:

1. what has been **verified**, and how, and where that evidence stops;
2. what has **not** been verified;
3. the **known product gaps** that a deployment must disclose;
4. a **decision**, for the owner to accept or change.

It is **not** a V1 certification. ShopStock is not V1 complete (see sections 4
and 6), and nothing here should be read as saying it is.

## 1. Decision (a recommendation; the owner decides)

| Use | Recommendation |
|---|---|
| **Controlled technical pilot**: the owner alone, one device, disposable data, to exercise a real backend, a real phone and the PWA | **Conditional GO** (conditions in section 1.1) |
| **Replacing the paper register with real stock** | **NO-GO** until the exit criteria in section 1.2 are met |

Why the second is NO-GO, in one line each, each sourced in section 4:

- A new device or cleared browser starts **empty**, and there is **no export**, so
  there is no way to restore or take data out (G1, G3).
- A product cannot be given a **selling price, location, category, unit,
  threshold or photo**, so the PRD's central question ("what did it cost, what do
  we sell it for, and where is it?") cannot be answered through the UI (G2).
- The last-write-wins work (Phase 6E) is in the repository but its acceptance is
  **unverified** (G5).

### 1.1 Conditions for the controlled technical pilot

- Data is **disposable**. Losing the browser's local data must be acceptable.
- One device. A second device would start empty (G1).
- The backend is served over **HTTPS** (service workers and installable PWAs
  require a secure context) with a real MongoDB, every variable in
  `backend/.env.example` set, and the seed script run once (`npm run seed`).
- `CORS_ORIGIN` lists the exact origin the app is served from: `scheme://host[:port]`,
  no trailing slash, no path, no wildcard.
- The frontend is built with `VITE_API_BASE_URL` set to the backend's **HTTPS**
  origin. A production build requires it and fails without it; "same origin" applies
  only to development and preview builds (`docs/DEPLOYMENT.md`, section 6).
- The backend runs with `NODE_ENV=production` and a real `JWT_ACCESS_SECRET` (at least
  32 characters, not a placeholder), and `TRUST_PROXY` is set to the right number for
  the host, which is **not guessed** (`docs/DEPLOYMENT.md`, section 8).
- The pilot's purpose is to produce the evidence in section 3: the real-phone
  check (appendix A), the PWA behavior, sync against a real server, and
  concurrent edits (Phase 6E).

### 1.2 Exit criteria for real use (each is its own scoped work, not part of R10)

1. Pull / initial sync and reconciliation (G1, issue #39).
2. Product form completeness, at least classification, selling price and
   location (G2).
3. At least JSON export, so there is a backup path (G3).
4. Phase 6E reconciled against its acceptance criteria (G5).
5. Installation of the PWA confirmed on real devices (G4: the icon assets now exist).
6. The real-phone checks in appendix A passed on iOS and Android.

## 2. Verified, and how

| Area | Result | Method | Where the evidence stops |
|---|---|---|---|
| Frontend tests | **101 files, 2569 tests pass** | Vitest (jsdom), run on the final tree | jsdom has no layout; geometry is covered separately below |
| Frontend build | A production build **fails** unless `VITE_API_BASE_URL` is a valid HTTPS origin (missing, `http://`, a path, `localhost` and loopback addresses are all refused); with one it is clean, and a trailing slash is removed. `npm run verify:build` checks the manifest, the icons it names (present, real PNGs, declared sizes), the service worker and its precache, the API origin in the bundle, and that no loopback origin is baked in | `vite build`; `npm run verify:build`; real builds in the test suite | Checks the build **artifact** only. Installing the app and a real host are not verified (G4) |
| Whitespace and line endings | `git diff --check` clean; no CRLF in changed files | git, and a byte check | |
| Backend, database-free tests | **154 tests, 37 suites, 0 fail** (13 files, including `app.test.js`) | `node --test` on the files that need no database | The full backend suite was **not run** (section 3) |
| Deployment-path rehearsal (local) | A production-mode backend, a real MongoDB 7 replica set, the production frontend build on a **different origin** with browser CORS **enforced**, and the 14-step smoke test all pass: sign-in, reload, create a product, add and remove stock, history, reload, an offline change queued and then delivered to the server, sign-out and sign-in, plus the manifest, icons and an active service worker. With a real proxy hop and clients on separate addresses, login limiting is shared with `TRUST_PROXY` unset and per client with it set to 1 | A local script against locally started services | **Not a deployment.** No Vercel, backend host, Atlas, real HTTPS or hosting proxy; see section 3 |
| Serverless backend entry (local) | `backend/index.js` runs on a real server against a real MongoDB 7 replica set, behind a local gateway that mimics the Vercel Services routing (same origin; `/api/*` to the API, a rewrite to `index.html` for other paths). The 14-step smoke test passes. The connection is opened by the first request and reused; with MongoDB down, health stays 200 (`db: disconnected`) and other routes answer the generic 500 after the 10-second wait; the next request after MongoDB returns, and after a drop and return, works with no restart; no credential or username reached the log | A local script against locally started services; 26 database-free tests with an injected connection | **Not Vercel.** The gateway is not Vercel's router; see section 3 |
| Browser audit | 24 screens and states, no horizontal overflow, no interactive target under 44px (inline text links excepted), no duplicate ids, one `h1` per screen, no console errors | Headless Chromium 153; screens and data created through the real UI; viewports 320, 375, 768, 1280 and 667×375 | The API was **stubbed** (login, refresh and sync writes); no real backend |
| Accessibility (automated) | No axe-core violations at rest (WCAG 2 A and AA, best-practice) | axe-core on each screen and state | Automated rules cover only part of WCAG; no screen reader was used |
| Real 200% text | No overflow, targets still 44px or larger, no axe violations; the crash fallback is flat and unclipped | Chromium started with `--blink-settings=defaultFontSize=32` | See the methodology note in appendix B |
| Touch and tap behavior | Save submits on a real touch tap with a 150ms hold, at 375 and 320 wide, including long and unbroken product names; a slow mouse click also works | Chromium touch events over the DevTools protocol | An emulated phone with no soft keyboard (section 3) |
| Visual consistency | No hard-coded colors outside the tokens; every custom property in use is defined; every transition uses a duration token; reduced motion collapses all durations | Static scan of the stylesheets | 29 defined tokens are unused (cleanup, not a defect) |
| Scope integrity of the redesign | R1 to R9 changed presentation files and one layout hook; no backend, domain, data, sync, auth, service or route file | `git diff` against the commit before R1 | Six existing tests were edited for presentation changes; none had a behavioral assertion weakened |

### Defects the audit found, and their status

| Defect | Status |
|---|---|
| The open "Add Stock" button was unreadable on hover or press (1.3:1, then 1:1) | **Fixed** in R10 Phase 1 (8.01:1 in every state) |
| The Add form's Save button sat partly under the fixed stock-action bar (42% of its target reachable) | **Fixed** in R10 Phase 2 (100% reachable); real-phone check still open |
| Bespoke `.form-errors` and `.over-remove-warning` looks | **Fixed** in R10 Phase 3a: they are now the shared notice |

## 3. Not verified

- **A real iOS and a real Android phone with the soft keyboard.** This was deferred
  by the owner and is the only explicit evidence gap in Phase 2. Reopen Phase 2
  only if a real-device test shows a failure. The checklist is appendix A.
- **A real backend.** The browser audit stubbed the API. Sync against a real
  server, with a real MongoDB, was not exercised in R10.
- **The full backend suite.** The tests that need a database could not run in
  the audit environment (it cannot download the MongoDB binary). The last full
  run the owner reported, 285 tests at the end of Phase 5F, predates later
  backend tests (for example `syncEndToEnd` and `productLwwConcurrency`, added in
  the Phase 6G commits of 2026-09-29 and 2026-09-30), so it is not a current
  count.
- **Phase 6E acceptance** (G5).
- **Continuous integration.** There is none (G6).
- **A real offline session** (airplane mode) was not exercised in R10.
- **PWA installation on a real device, and the service-worker update flow.** The
  icon assets now exist and the local build verification checks them (G4), but
  installing the app and updating it are unverified.
- **Vercel Services itself (Beta):** that Vercel accepts `vercel.json` (including the
  explicit `entrypoint` and the frontend service's rewrite), runs `backend/index.js` as a
  function, builds the Vite service and routes as documented. The local gateway above only
  imitates the routing.
- **Anything about a real deployment:** Vercel (including its single-page-app
  rewrite), the backend host, MongoDB Atlas, real HTTPS, production CORS against the
  real origins, cold starts, and the right `TRUST_PROXY` value for the host. The
  deployed smoke test (`docs/DEPLOYMENT.md`, section 12) has not been run. The local
  rehearsal above is evidence that the architecture works, not that a deployment does.
- **A screen reader** (VoiceOver, TalkBack or NVDA), and real-device performance
  or search timing with a realistic number of products.
- **Lighthouse scores** have not been recorded.

## 4. Known product gaps (the disclosure list)

Sources are the project's own record in `docs/PROGRESS.md` (the 7I risks) unless
stated. Each needs an owner decision on scheduling; none is fixed by R10.

| # | Gap | Consequence |
|---|---|---|
| **G1** | **No pull or reconciliation (issue #39).** The app only sends changes to the server and never fetches them. | A second phone or family member's device starts empty. Clearing browser storage loses local data the server holds but the app cannot restore. This conflicts with the intent of PRD §34 to §35. |
| **G2** | **The product form is name and notes only.** Nothing yet assigns classifications, unit, selling price, margin, low-stock threshold, photo or initial quantity. | Categories, locations and tags can be created but never assigned. Every new product shows as out of stock until stock is added. No price or profit totals are possible. |
| **G3** | **No export.** Phase 8 is not started, and JSON and CSV export are V1 requirements (PRD §36). | Together with G1 there is no backup or restore path. |
| **G4** | **PWA assets are present; installation is unverified.** The icon assets now exist (`icon-192`, `icon-512`, `icon-512-maskable`, `apple-touch-icon`, `favicon.ico`). The manifest declares the 192 and 512 icons and the service worker precaches them; the local build verification checks that. The maskable icon exists but the manifest does not reference it yet. | Installing the app on a real device, and the service-worker update flow, are **not verified**. This row does not say the PWA works. |
| **G5** | **Phase 6E is unreconciled.** The last-write-wins code and commits labeled 6E to 6G are in the repository, but whether 6E-2, 6E-3, 6F and 6G met their acceptance criteria was not verified. | Concurrent edits on two devices may not behave as designed. Needs its own reconciliation pass. |
| **G6** | **No CI.** Deployment configuration is now documented (`docs/DEPLOYMENT.md`) and guarded: a production build fails without a valid HTTPS `VITE_API_BASE_URL`, `frontend/vercel.json` carries the single-page-app rewrite, and the backend has `TRUST_PROXY` and production `JWT_ACCESS_SECRET` checks. But nothing runs the tests or builds automatically, and the Vercel rewrite, production CORS and the right `TRUST_PROXY` value are unverified on a real deployment. | Releases are manual. The build guard runs wherever the app is built; the rest runs only when someone runs it. |
| **G7** | **On a serverless host the login and refresh rate limit is per instance.** Its counters are in memory, so each instance counts for itself. | Weaker protection against deliberately spread password guessing than on a single long-lived server. Use a long random shop password until a shared store is added. See `docs/DEPLOYMENT.md`, section 14. |

Lower priority and recorded in `docs/PROGRESS.md`: header and content columns do
not align on wide screens (N-06); classification rows have no consistent shape
(N-08); an explicit dark-mode decision is outstanding.

### Changes the redesign made that the owner should know about

These are deliberate presentation decisions, not defects:

- The dashboard's "Low stock (3 left)" sentence became the quantity plus a
  "Low Stock" badge.
- The product page shows quantity as a large figure, not "Quantity: 10".
- Product List filters are collapsed behind a disclosure (one extra tap).
- With the Remove form open, "Add Stock" in the action bar stays solid blue next
  to Save.
- Stock-form errors and the over-removal warning now carry the left accent edge
  that every other notice already had.

### Plain-language text for the deployment gate

> ShopStock is a pilot build. It works offline on one device and sends changes to
> the server, but it does **not** yet restore data onto a new device, does not
> export or back up your data, and cannot yet record a product's selling price,
> location or category. Treat the data in it as disposable. Do not use it to
> replace your stock register.

## 5. PRD V1 success criteria (preliminary)

PRD §42 lists 13 things a shop owner should be able to do. This mapping is
**preliminary**: it comes from `docs/PROGRESS.md` and what the R10 audit
observed, not from usability testing.

| # | Criterion | Status | Basis |
|---|---|---|---|
| 1 | Add a product in under a minute | **Partial** | Quick by name, observed in the audit; the form is name and notes only (G2) |
| 2 | Find an existing product quickly | **Implemented, not timed** | Search is built and unit-tested; not timed with realistic data |
| 3 | Add or remove stock in a few interactions | **Met** | Observed in the browser: open the form, type a quantity, Save |
| 4 | Understand current stock immediately | **Met** | Quantity figure and status badge observed on every screen |
| 5 | See where the product is stored | **Not met** | Locations cannot be assigned to products (G2) |
| 6 | Understand its cost and selling price | **Partial** | Cost can be recorded when adding stock; selling price cannot be set (G2) |
| 7 | See expected profit | **Not met** | No price entry, so no profit totals (G2) |
| 8 | Correct accidental stock changes | **Met** | Undo toast and "Reverse this action" observed; reversal is unit-tested |
| 9 | Review what happened and when | **Partial** | Stock history verified in the browser; the product change history screen was not checked in R10 |
| 10 | Keep working without internet | **Designed and tested; not re-run in R10** | Offline-first architecture with unit and integration tests; no airplane-mode session in this audit |
| 11 | Recover synchronization later | **Partial** | Outbound queue exists; no inbound pull (G1); LWW unreconciled (G5) |
| 12 | Export their data | **Not met** | Phase 8 not started (G3) |
| 13 | Create their own categories, locations, tags and units | **Partial** | Create, rename, archive and remove all work in the UI; none can be assigned to a product (G2) |

## 6. Open work, to be scoped separately

Not part of R10, and each needs an owner decision:

1. Pull / initial sync and reconciliation (G1, issue #39).
2. A product-form completeness phase (G2).
3. An early JSON export, then CSV (G3).
4. Phase 6E reconciliation (G5).
5. PWA installation on real devices, `theme-color`, the maskable icon in the manifest, and the service-worker update flow (G4).
6. CI, and running the deployed smoke test against the real deployment (G6).
7. The real-device checks (appendix A), and a real-backend pilot run.

## Appendix A: real-phone checklist

Run on at least one iOS and one Android phone, with the soft keyboard:

1. Open a short product and tap **Add Stock**. Save should sit fully above the
   action bar.
2. Tap **Quantity** so the keyboard opens, type a number, then tap **Save**. It
   should submit on the **first** tap.
3. Repeat on the **Remove** form, and again with a long product name that wraps in
   the header.

If any step fails, record exactly what happens before changing code.

## Appendix B: methodology notes

- **200% text.** Some R9 and R10 checks first used a root `font-size: 200%`
  override. That does not trigger rem-based media queries (such as the 36rem
  stock-bar threshold), so it did not reproduce a real 200% setting. They were
  rerun with Chromium's default font size set to 32px (`--blink-settings=defaultFontSize=32`),
  and the results in section 2 are from that rerun. At a real 200% the stock-action
  bar sits in the page, so the Save overlap cannot occur there.
- **Emulation.** The audit used headless Chromium, with touch emulated over the
  DevTools protocol. A "phone" there is still desktop Chromium with no soft
  keyboard, which is why appendix A exists.
- **Findings that were not defects.** An axe contrast hit during the first audit
  was a measurement taken mid-transition; at rest the contrast was 8.01:1. The
  "multiple primary actions" counts were class counts, not visible buttons.
