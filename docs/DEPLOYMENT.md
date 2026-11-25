# ShopStock: deployment

How to deploy ShopStock to production, and how to check that it works.

**Every origin in this document is a placeholder.** The real frontend and backend
origins are deployment-specific values that only you have; the examples use
`https://shop.example.com` (frontend) and `https://api.example.com` (backend), which
are not real. **No secret appears here, and none should ever be committed.**

What this does and does not establish: the repository's tests, the production build
and `npm run verify:build` prove the code and the build artifact. They do **not**
prove a deployment. Only the smoke test in section 12, run against your real
deployment, does, and its result must be recorded separately from the local checks
(see `docs/ROLLOUT_READINESS.md`).

## 1. Architecture

```
Browser (installed PWA or tab)
   │   static files
   ▼
Frontend            Vercel (a static single-page app)
   │   HTTPS, cross-origin, `Authorization: Bearer` header (no cookies)
   ▼
Backend API         Node.js + Express, on a Node host (any; see 3)
   │   TLS
   ▼
MongoDB             a replica set (MongoDB Atlas qualifies; see 4)
```

- The frontend and backend are **different origins**. The browser enforces CORS between
  them, so the backend must list the frontend's exact origin (section 7).
- The app is offline-first: it works from its local database and queues changes. The
  backend is only needed to sign in and to sync.
- Authentication uses a bearer token sent in a header, not cookies, so there are no
  `SameSite` or cookie-domain settings to get right.

## 2. Frontend deployment target: Vercel

Create a Vercel project from this repository with:

| Setting | Value |
|---|---|
| Root Directory | `frontend` |
| Install Command | `npm ci` |
| Build Command | `npm run build` |
| Output Directory | `dist` |
| Environment variable (Production) | `VITE_API_BASE_URL`, the backend's HTTPS origin (section 6) |

`frontend/vercel.json` holds the one rewrite a single-page app needs, sending every
path to `index.html`, so that reloading or opening a deep link such as
`/products/abc` works. It adds nothing else. Vercel serves real files (the service
worker, the manifest, the icons, the hashed assets) before applying the rewrite. This
is Vercel's documented behavior for Vite single-page apps; it has **not** been
verified here, so the smoke test checks it (step 8).

## 3. Backend deployment target

The repository does not name a backend host, and these instructions do not depend on
one. The backend is a long-running Node process:

| | |
|---|---|
| Install | `npm ci` (in `backend/`) |
| Start | `npm start` (runs `node server.js`) |
| Port | The host's `PORT` variable. If it is not set, the server listens on 4000. |
| Node | Tested on Node 22. |
| Health check | `GET /api/health`. No authentication. Returns `{"status":"ok","db":"connected"}`; it reports the database state but stays 200 if the database is down, so it measures that the process is up, not that Mongo is reachable. |

The server **refuses to start**, with a message naming the variable and never its
value, if a required variable is missing or invalid (section 5), or if it cannot reach
MongoDB within 10 seconds. A platform that restarts a crashed process will therefore
keep retrying until the configuration is right.

## 4. MongoDB

- It **must be a replica set** (or a sharded cluster). Every stock change is written
  inside a MongoDB transaction (the stock event, the product quantity and, for a
  reversal, the original event must succeed or fail together), and MongoDB only runs
  transactions on a replica set. **MongoDB Atlas clusters are replica sets.** A
  standalone `mongod` is not: stock writes would fail on it.
- Use a dedicated database user with read and write access to this one database, and
  restrict network access to your backend host where the platform allows it.
- `MONGODB_URI` is the connection string, for example
  `mongodb+srv://<user>:<password>@<cluster-host>/<database>?retryWrites=true&w=majority`
  (placeholders only).

## 5. Environment variables

**Backend, runtime.** Read when the server starts; a change needs a restart.

| Variable | Required | Value |
|---|---|---|
| `MONGODB_URI` | yes | The MongoDB connection string (section 4). |
| `JWT_ACCESS_SECRET` | yes | A long random secret. **In production it must be at least 32 characters and must not be a `change-me…` placeholder**, or the server refuses to start. Generate one with `node -p "crypto.randomBytes(48).toString('base64url')"`. |
| `JWT_ACCESS_EXPIRES_IN` | yes | How long an access token lives, for example `15m`. |
| `REFRESH_TOKEN_EXPIRES_IN_DAYS` | yes | A positive number of days, for example `90`. |
| `SEED_USERNAME` | yes | The shop account's username (section 9). |
| `SEED_PASSWORD` | yes | The shop account's password (section 9). Use a strong one; the server does not check it. |
| `CORS_ORIGIN` | yes | The frontend's exact origin(s) (section 7). |
| `NODE_ENV` | set it | Set to `production`. This is what turns on the `JWT_ACCESS_SECRET` checks above. |
| `PORT` | no | Usually supplied by the host. A whole number above 0. |
| `TRUST_PROXY` | no | The number of reverse proxies in front of the server (section 8). Leave it unset or blank for none. |
| `CLOUDINARY_*` | no | Leave blank. |

**Frontend, build time.** Vite inlines the value when the app is **built**. Changing it
means rebuilding and redeploying; it is not read at run time.

| Variable | Required | Value |
|---|---|---|
| `VITE_API_BASE_URL` | **yes, for a production build** | The backend's HTTPS origin (section 6). |

Copy `backend/.env.example` and `frontend/.env.example` for the full, commented lists.
Never commit a real `.env` file; `.env`, `.env.local` and `.env.*.local` are ignored.

## 6. Frontend configuration

`VITE_API_BASE_URL` is the origin of the API: requests go to
`${VITE_API_BASE_URL}/api/...`. The rules live in one place,
`frontend/src/config/apiBaseUrl.js`, and are enforced when the app is built.

| Build | Command | `VITE_API_BASE_URL` |
|---|---|---|
| **Production** | `npm run build` (what Vercel runs) | **Required.** `https://` only. An origin only: no path, query string or credentials. Not `localhost` or any loopback address. A trailing slash is accepted and removed. **The build fails** with a clear message otherwise. |
| **Preview** | `npm run build:preview` | The explicit way to build against a local or `http://` backend, for example `http://localhost:4000`. Optional; unset means the same origin. **Do not deploy a preview build.** |
| **Development** | `npm run dev` | Optional; unset means the same origin. There is no dev proxy, so for a local backend set `http://localhost:4000` and list the dev server's origin in the backend's `CORS_ORIGIN`. |

An unrecognized build mode gets the production rules, so it is never a way around the
check. The check runs only for `vite build`; the dev server and the test runner need
no configuration. It is a build-time check on purpose: the app is offline-first and
must still open if something is wrong, so nothing validates the value in the browser.

To check a finished build:

```bash
cd frontend
npm run verify:build                 # builds into a temporary directory and verifies it
npm run verify:build -- --dist dist  # verifies an existing build (VITE_API_BASE_URL must be
                                     # set to the value it was built with)
```

It checks the manifest, the icons it names (present, real PNGs, the declared sizes),
the touch icon and favicon, the service worker and its precache, that the configured
API origin is in the bundle, and that no loopback origin such as
`http://localhost:4000` is baked in. It looks for loopback **origins**, not the bare
words, because third-party code contains harmless text such as `/localhost|127\.0\.0\.1/`.
With no `VITE_API_BASE_URL` set it uses a made-up `https://api.shopstock.invalid` and
says so: that verifies the build contract, not your configuration. It checks the
artifact only, never a deployment, and never writes to `dist/` unless you point it
there.

## 7. CORS

`CORS_ORIGIN` is an allow-list of exact origins, comma-separated:

- Each entry is exactly `scheme://host[:port]`: no path, **no trailing slash**, **no
  wildcard**. A bad entry stops the server at startup.
- It must contain the origin the app is **served from**, exactly: `https://shop.example.com`
  and `https://www.shop.example.com` are different origins.
- Do not widen it to make something work. If the app cannot reach the API, the cause is
  almost always `VITE_API_BASE_URL` or this list, and a wildcard would only hide it.
- **Vercel preview deployments** each get their own origin, which is not in the list, so
  they cannot call the production API. That is deliberate. Test against the production
  origin, or add one specific preview origin to a non-production backend.

A browser that is blocked by CORS, a missing API base and being offline all show the
same message in the app ("Can't reach the server. Check your connection and try
again."). If you see it with a working connection, check the console and network tabs
first.

Check the headers without a browser (replace the placeholders):

```bash
curl -si -X OPTIONS https://api.example.com/api/auth/login \
  -H "Origin: https://shop.example.com" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: content-type,authorization"
# expect: Access-Control-Allow-Origin: https://shop.example.com

curl -si -X OPTIONS https://api.example.com/api/auth/login \
  -H "Origin: https://not-your-site.example" \
  -H "Access-Control-Request-Method: POST"
# expect: no Access-Control-Allow-Origin header
```

## 8. `TRUST_PROXY`

Login and token refresh are rate limited per client address: 10 attempts per 15
minutes. Behind a hosting platform's reverse proxy, the server sees the proxy's
address for every request, so **with `TRUST_PROXY` unset everyone shares one limit**
(it was demonstrated: requests from 40 different clients were limited together after
10), and one person's failed logins, or a burst of devices refreshing their sessions,
can lock everyone out. `TRUST_PROXY` fixes this by telling the server how many proxies to
believe.

- **Unset or blank:** nothing is trusted. This is the behavior before the setting
  existed, and it is right when the server is reached directly.
- **A whole number, 0 or more:** the number of proxies between the internet and the
  server. Anything else (`true`, a negative or fractional number, a list) stops the
  server at startup.
- **Do not guess the number.** It depends on your host: use the number of proxies its
  documentation says sit in front of your service. Too low and clients are still counted
  together. **Too high and a client can invent its own address** by sending an
  `X-Forwarded-For` header, which defeats the limit.

To check it after deploying (this locks your own address out of login for 15 minutes,
so use a throwaway moment, and expect `400` because the body is empty):

```bash
for i in $(seq 1 12); do
  curl -s -o /dev/null -w "%{http_code} " -X POST https://api.example.com/api/auth/login \
    -H "content-type: application/json" -H "X-Forwarded-For: 192.0.2.$i" -d '{}'
done; echo
# correct:    400 400 400 400 400 400 400 400 400 400 429 429
#             (your real address is counted; the forged header is ignored)
# too high:   all 400, never 429  (the forged addresses are being believed)
```

Then, from a different network (a phone on mobile data), try one login while the first is
locked out. **Correct:** it is answered normally (not `429`). **`TRUST_PROXY` unset or too
low:** it is `429` as well, because everyone shares one bucket.

## 9. Seeding the shop account

There is no registration. The single shop account is created once, by the seed script:

```bash
cd backend
# with the production MONGODB_URI, SEED_USERNAME and SEED_PASSWORD set in the environment
npm run seed
```

It can be run from a machine that can reach the production database, or from the host's
shell. It is safe to run again: if the account exists it reports that and changes
nothing. It prints the username, never the password.

## 10. Deployment order

1. **MongoDB** (an Atlas replica set), and a database user.
2. **Decide the two origins**, ideally stable ones (custom domains): the frontend's
   (`https://shop.example.com`) and the backend's (`https://api.example.com`). Each needs
   the other's. If you must use generated URLs, deploy the frontend project first just to
   learn its production URL.
3. **Backend**: set every variable in section 5 (with `CORS_ORIGIN` as the frontend's
   origin and `NODE_ENV=production`), deploy, and check `/api/health` (HTTPS).
4. **Seed** the account (section 9).
5. **Frontend**: set `VITE_API_BASE_URL` to the backend's origin and deploy. A build with a
   missing or invalid value fails; fix the variable, do not work around it.
6. If the frontend's real origin turned out different from what you put in `CORS_ORIGIN`,
   correct it and restart the backend.
7. Set `TRUST_PROXY` to the right number for your host and run the check in section 8.
8. Run the smoke test (section 12).

## 11. HTTPS

Use HTTPS for both origins. A page served over HTTPS cannot call an `http://` API (the
browser blocks it as mixed content), and service workers, and therefore offline use and
installing the app, only work on a secure origin. The production build refuses an
`http://` API origin for this reason. Vercel and most Node hosts provide TLS certificates
for you.

## 12. Production smoke test

Run it against the **real** deployment in a desktop browser with DevTools open (Console and
Network), then on a phone. Record the date, the two origins, the browser, and what you saw.

| # | Do | Expect |
|---|---|---|
| 1 | Open the frontend URL | The sign-in screen. |
| 2 | Sign in with the seeded account | The dashboard. (There is no registration.) |
| 3 | Reload | Still signed in. |
| 4 | Add a product | It opens the product page. |
| 5 | Add stock, then remove some | The quantity updates immediately. |
| 6 | Look at the history | Both entries are listed. |
| 7 | Reload | The same quantity. |
| 8 | Open a deep link directly (for example the product page's URL) in a new tab, then press reload | The page loads, not a 404. This is the Vercel rewrite. |
| 9 | Go offline (DevTools "Offline"), add stock | The quantity changes at once, and the sync status reads "Offline" ("Changes are saved on this device and will sync later"). |
| 10 | Go back online | The offline status clears (it may read "Pending" briefly) and the change reaches the server: check the Network tab for a successful `PUT /api/stock-events/…`. |
| 11 | Sign out, then sign in again | Your data is still there. |

While doing this, confirm:

- **Network:** every `/api/` request goes to your backend's origin, and none to
  `localhost` or to the frontend's own origin.
- **Console:** no CORS errors, no red errors.
- **Screen:** no raw error text, stack traces or `[object Object]`.
- **PWA:** `/manifest.webmanifest` and the icons under `/icons/` load (200, `image/png`);
  DevTools, Application, Manifest shows the icons with no warnings; the service worker is
  activated. Installing from the browser menu works.

Not covered by this procedure, and not verified by the repository's own checks: physical
iOS and Android devices, a screen reader, the soft keyboard, cold-start delays on a free
host, and the service-worker update flow.
