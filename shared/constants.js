// Shared constants referenced by both frontend domain logic and (where
// relevant) backend seed scripts. Kept dependency-free plain JS/JSDoc so it
// can be imported from either app without a build step.
//
// These are DEFAULTS, not restrictions — PRD §6/§7: users can rename,
// archive, and create their own units/categories/locations/tags. This file
// only seeds a new account with sensible starting points.

export const DEFAULT_UNITS = [
  'Piece',
  'Packet',
  'Box',
  'Bottle',
  'Dozen',
  'Kg',
  'g',
  'Litre',
  'ml'
];

export const DEFAULT_CATEGORIES = [
  'Groceries',
  'Snacks',
  'Beverages',
  'Personal Care',
  'Cleaning',
  'Stationery',
  'Other'
];

export const DEFAULT_LOCATIONS = [
  'Counter',
  'Shelf A1',
  'Shelf A2',
  'Back Room',
  'Other'
];

// Fallback labels used when a product's classification reference has been
// removed (PRD §7, §8, §10).
export const UNCATEGORIZED_LABEL = 'Uncategorized';
export const UNSPECIFIED_LOCATION_LABEL = 'Location unspecified';

// Global defaults, overridable per-product (PRD §20, §22).
export const DEFAULT_MARGIN_PERCENT = 20;
export const DEFAULT_LOW_STOCK_THRESHOLD = 5;

// Search behavior (PRD §23).
export const SEARCH_DEBOUNCE_MS = 450;

// Undo toast duration (PRD §14).
export const UNDO_TOAST_DURATION_MS = 5000;

// Stock status labels (PRD §22).
export const STOCK_STATUS = {
  NORMAL: 'Normal',
  LOW: 'Low Stock',
  OUT: 'Out of Stock'
};

// Stock event types (PRD §11).
export const STOCK_EVENT_TYPE = {
  ADD: 'ADD',
  REMOVE: 'REMOVE'
};

// NOTE: Sync/transport status constants (pending/syncing/done/failed) are
// intentionally NOT defined here. Per docs/ARCHITECTURE.md, SyncQueueEntry
// is the only place sync state is tracked — StockEvent, ProductChangeEvent,
// and Product itself never carry a sync status. Those constants belong
// alongside the sync queue implementation in data/sync/, not in shared
// domain-agnostic constants, to avoid inviting the sync-state-on-events
// mistake this file previously (and briefly) encouraged.
