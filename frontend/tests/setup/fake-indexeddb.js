// Vitest global setup: installs a fake IndexedDB implementation so
// Dexie-backed tests (tests/data/**) can run under Node, which has no
// real IndexedDB. Pure domain tests (tests/domain/**) never touch
// IndexedDB and are unaffected by this being present.
//
// `fake-indexeddb/auto` self-installs onto `globalThis.indexedDB` /
// `globalThis.IDBKeyRange` as a side effect of being imported — there is
// nothing else to configure here.
import 'fake-indexeddb/auto';
