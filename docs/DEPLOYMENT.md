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

**On Vercel** the backend runs as a serverless function through `backend/index.js` rather
than `server.js`; see section 13. `npm start` / `server.js` is for a host that runs one
long-lived process.

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

On Vercel with one project for both, follow section 13 instead of steps 2 to 6.

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

## 13. Vercel Services: frontend and backend in one project

Vercel Services deploys both apps as one Vercel project on **one domain**. Vercel labels it
**Beta** (available on all plans). The API is then **same-origin** with the frontend, so
there is no cross-origin traffic and no CORS preflight to get right. Two separate projects
remain the fallback (end of this section).

### What is in the repository

- **`vercel.json` (repository root)** defines the two services and routes to them:
  `/api/*` goes to the backend, every other path to the frontend, the catch-all last.
  It starts from the file Vercel's import screen suggests, with two additions:
  - the backend names its entry, `index.js`, explicitly, because `backend/` also holds
    `server.js`, which listens on a port and exports nothing;
  - the frontend service has a rewrite sending any non-file path to `/index.html`, so a
    deep link survives a reload. (`frontend/vercel.json` does the same for a standalone
    frontend project; it is not relied on here.)

  If Vercel rejects either addition, delete it: what remains is exactly Vercel's own
  suggestion. The effect would be a missing entry (the backend would not start) or deep
  links that 404, and the smoke test would show which.
- **`backend/index.js`** default-exports the Express app that Vercel runs as a function
  (`backend/src/serverless.js`). It reads the environment on the first request, opens the
  MongoDB connection on demand and reuses it, keeps the pool small (10), and answers a
  missing or invalid setting with the standard 500 and a log line naming the variables,
  never their values. It never calls `process.exit`. Everything else is the same app.
- Vercel forwards the original path, so the backend receives `/api/auth/login` and its
  routes, which already start with `/api`, match with no change.

### Importing the project

Import the repository, leave the preset on **Services** and the root directory on `./`,
and do **not** use "Import single project" (that creates the separate projects). Add the
variables below before the first deploy.

### Environment variables

Services share **one list per project**: there is no per-service setting. What separates
them is the name (only `VITE_*` values reach the browser bundle; the backend reads the
rest at runtime) and the **environment** each variable is scoped to.

| Variable | Value | Environments | Sensitive |
|---|---|---|---|
| `VITE_API_BASE_URL` | The site's own origin, `https://<your-project-domain>` (explicit, even though it is the same site) | Production **and** Preview | No |
| `MONGODB_URI` | The Atlas connection string, with a database name (see below) | **Production only** | Yes |
| `JWT_ACCESS_SECRET` | A generated secret, at least 32 characters (section 5) | **Production only** | Yes |
| `SEED_PASSWORD` | The shop account's password | **Production only** | Yes |
| `SEED_USERNAME` | The shop account's username | Production only | No |
| `NODE_ENV` | `production` | Production only | No |
| `JWT_ACCESS_EXPIRES_IN` | `15m` | Production only | No |
| `REFRESH_TOKEN_EXPIRES_IN_DAYS` | `90` | Production only | No |
| `CORS_ORIGIN` | The same origin as `VITE_API_BASE_URL`. Same-origin requests do not use CORS, but the server will not start without a valid value | Production only | No |
| `TRUST_PROXY` | `1` (see below) | Production only | No |

The backend secrets are scoped to Production on purpose. If a Preview deployment had them,
every branch's code would run against the production database. A Preview deployment then
builds (it needs `VITE_API_BASE_URL`, or the build guard stops it) but its API refuses to
start for lack of variables, which is safe. Give previews a separate test database if you
ever want them to work.

The project's name decides its domain, usually `<name>.vercel.app`, but Vercel adds a suffix
if that is taken. Read the real domain after creating the project and set both URL variables
from it. **Decide your final domain before entering real data**: the app's local data lives
per origin, and there is no inbound sync yet (G1), so moving to another domain later starts
empty.

### The MongoDB connection string

- **Include a database name** in the path, for example
  `mongodb://<user>:<password>@<host>:27017,…/shopstock?ssl=true&replicaSet=<set>&authSource=admin`.
  Without one the driver uses a database called `test`. The seed script uses the same string.
- **Use the real password**, URL-encoded if it has special characters, with no `<` `>`.
- A `replicaSet=` parameter in the string confirms a replica set, which stock writes need.
- **Atlas Network Access.** Vercel Functions use changing outbound addresses, so Atlas has to
  accept connections from anywhere (`0.0.0.0/0`) unless the project uses Vercel's **Static IPs**,
  a Pro or Enterprise plan feature. With `0.0.0.0/0` only the credentials stand between the
  internet and the database, so use a long random password and a dedicated database user with
  read and write access to this one database only, not the default administrator.

### `TRUST_PROXY` on Vercel

Vercel sets `X-Forwarded-For` to the visitor's public address and replaces any value the
client sent, so one trusted hop is expected to be right: `TRUST_PROXY=1`. That is the
documented behavior, not something this repository has observed on a deployment. Run the
check in section 8 after deploying: `400 … 400 429 429` is correct, all `400` means the number
is too high.

### After the first deploy

1. Seed the account once, from your machine, with the production environment (section 9).
2. `GET https://<your-domain>/api/health` returns `{"status":"ok","db":"connected"}`. The very
   first request after a quiet period may be slow: the instance starts and connects.
3. Run the smoke test (section 12). Step 8, reloading a deep link, checks the frontend
   rewrite.

### Fallback: two projects

If Services does not work out, import the same repository twice, once with Root Directory
`frontend` and once with `backend` (a Vercel Express project, which has to pick `index.js`
as its entry rather than `server.js`; this has not been verified), then
set `VITE_API_BASE_URL` to the backend project's origin and `CORS_ORIGIN` to the frontend's.
The rest of this document applies as written. Cross-origin means CORS is enforced, and the
backend project does not need a `vercel.json`.

### What has and has not been checked

Checked in the repository's tests and a local rehearsal: the serverless app's connection
handling, its error behavior, `TRUST_PROXY` through the wrapper, and that `vercel.json` and
the backend entry agree. **Not checked, because it needs Vercel itself:** that Vercel accepts
this `vercel.json` (including the `entrypoint` and the frontend rewrite), runs
`backend/index.js` as intended, builds the Vite service, and routes as documented; Atlas from
Vercel; the real `TRUST_PROXY` value; cold-start times.

## 14. Known limitations on a serverless host

- **The login and refresh rate limit is per instance.** Its counters live in memory, so each
  running instance counts for itself, and a new instance starts at zero. With low traffic there
  is usually one warm instance and it behaves like a normal limit, but it is not a reliable
  defence against someone deliberately spreading attempts. A shared store would fix it. Until
  then, use a long random password for the shop account.
- **Cold starts.** The first request to a cold instance also opens the database connection,
  which can take a few seconds. A failed attempt answers 500 and the next request retries, and
  a connection that dropped is reopened the same way (both were exercised against a real
  MongoDB). While MongoDB is unreachable, a request waits up to 10 seconds before it fails; if
  the host's own function time limit is shorter, the host's timeout is what the client sees.
- **One pool per instance** (10 connections), so several instances can open several pools.
  This is small for an Atlas free cluster, but it is not unlimited.
- **Services is Beta.** Vercel may change it.
- **Plan terms.** Vercel's Hobby plan has been described as for personal, non-commercial use.
  Check its current terms against how the shop will use this.
- **The seed password is not checked.** The server rejects a placeholder `JWT_ACCESS_SECRET`
  in production, but not a placeholder `SEED_PASSWORD`. Choose a strong one.
