# ShopStock backend

Express + MongoDB (via Mongoose) backend for ShopStock. See
`../docs/ARCHITECTURE.md` and `../docs/PROGRESS.md` for the full,
authoritative architecture and phase history — this file covers only what
you need to actually run the server locally.

## Setup

```bash
cp .env.example .env
# fill in real values in .env
npm install
```

## Required: MongoDB must be a replica set

Committing a stock event (Phase 5E) requires a multi-document MongoDB
transaction (inserting the `StockEvent` and updating `Product.quantity`
must succeed or fail together). **MongoDB transactions require the
connected deployment to be a replica set** — a standalone `mongod`
instance cannot open a session transaction at all, and the failure will
not surface until the first stock-event write is attempted, not at
connection time.

**Local development — pick one:**

- Run `mongod` as a single-node replica set:
  ```bash
  mongod --replSet rs0 --dbpath /path/to/your/data/dir
  # in a separate shell, once, the first time:
  mongosh --eval "rs.initiate()"
  ```
- Or use a replica-set-configured MongoDB Docker image (e.g.
  `mongo` official image with `--replSet rs0` plus the same one-time
  `rs.initiate()` step).

**Production target:** MongoDB Atlas (see `.env.example` /
`docs/PRD.md` §41). Atlas clusters are replica sets by default,
including the free tier — no additional action needed there.

## Tests

```bash
npm test
```

Backend tests use Node's built-in test runner (`node --test`, not
Vitest — deliberately distinct from the frontend's tooling) and
`mongodb-memory-server`'s `MongoMemoryReplSet` for any test that touches
MongoDB, giving every test — including transaction-path tests — a real,
ephemeral, replica-set-capable instance with no external Docker
dependency required just to run the suite.

**Note on this repository's current CI/sandbox environment:** some
development environments restrict outbound network access to a fixed
allowlist of domains. `mongodb-memory-server` downloads its MongoDB
binary from `fastdl.mongodb.org` on first use; if that domain is not
reachable, any test requiring `MongoMemoryReplSet` will fail with a
`DownloadError`, not a test assertion failure — this is an environment
limitation, not a code defect. Tests that don't touch MongoDB (e.g.
`tests/config/env.test.js`, `tests/middleware/AppError.test.js`,
`tests/app.test.js`'s non-DB-dependent cases) are unaffected and should
be treated as the reliable signal in such an environment.

This is a sandbox-specific limitation, not a general one — on a machine
with normal outbound network access, the full suite (including every
`MongoMemoryReplSet`-dependent test) runs and passes with no special
configuration. Confirmed through the end of Phase 5C.
