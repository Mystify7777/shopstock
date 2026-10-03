# ShopStock

A lightweight, offline-first inventory management application for small physical
shops. Built to replace a paper stock register — not to become a POS, ERP, or
accounting system.

See `docs/PRD.md` and `docs/BUILD_BRIEF.md` for the full product specification,
and `docs/ARCHITECTURE.md` for the technical design this codebase follows.

## Project layout

```
shopstock/
├── frontend/     React + Vite PWA (offline-first, IndexedDB-backed)
├── backend/      Node + Express + MongoDB API
├── shared/       Constants shared conceptually across both apps
└── docs/         Product and architecture documentation
```

## Status

Scaffold stage. Domain logic, UI, and backend are being built incrementally,
one module at a time. See `docs/PROGRESS.md` for what's implemented so far.

## Getting started (once dependencies are filled in)

```bash
# Frontend
cd frontend
npm install
npm run dev

# Backend
cd backend
npm install
npm run dev
```

Environment variables are documented in `backend/.env.example`.

## Verifying changes

From the repository root, after installing both packages' dependencies:

```bash
npm run verify
```

This runs, in order, and stops at the first failure:

1. `verify:frontend` — the frontend test suite (`vitest run`)
2. `verify:backend` — the backend test suite (`node --test`)
3. `verify:build` — the frontend production build (`vite build`)
4. `verify:diff` — `git diff --check` (whitespace errors)

Each stage can also be run on its own (`npm run verify:frontend`, etc.). The
root `package.json` only orchestrates these commands: it has no dependencies,
does not use npm workspaces, and the two packages keep owning their own. The
backend has no build step, so none is run. The backend integration tests use
`mongodb-memory-server`, which needs a MongoDB binary. `npm test` in `backend/`
first runs a `pretest` step (`backend/tests/helpers/ensureMongoBinary.js`) that
downloads and caches it once, in a single process, before the parallel test
files start (the first run needs access to `fastdl.mongodb.org`; later runs
need no network). If it cannot be obtained, the run stops immediately with a
clear message instead of hanging.
