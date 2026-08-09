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
