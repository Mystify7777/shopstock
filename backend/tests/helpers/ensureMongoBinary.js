// Make sure the MongoDB binary used by mongodb-memory-server is on disk
// BEFORE any test file starts. Runs automatically as npm's `pretest` step.
//
// Why: `node --test` runs test files in parallel processes, and eleven of
// them start their own in-memory replica set (see testDb.js). On a machine
// where the binary is not cached yet, they all try to download it at the
// same moment. mongodb-memory-server arbitrates that with a lockfile, but
// under contention (notably on Windows) two processes can both believe they
// hold it; the one that finishes second then fails with
//   "Cannot unlock file ...<version>.lock, because it is not locked by this process"
// inside its `before` hook, which cancels every test in that file.
//
// Downloading once, here, in a single process, removes the race: when the
// binary is already cached the library never takes the download lock at
// all, so every parallel test process just finds it.
//
// Fails fast with a clear message if the binary cannot be obtained (for
// example no network access to fastdl.mongodb.org), instead of letting
// every Mongo-backed test file hang and time out.
//
// To run only the tests that need no database without this step, call
// `node --test` directly on those files.

import { MongoBinary } from 'mongodb-memory-server';

try {
  const binaryPath = await MongoBinary.getPath();
  console.log(`[ShopStock tests] MongoDB test binary ready: ${binaryPath}`);
} catch (error) {
  console.error(
    [
      '[ShopStock tests] Could not obtain the MongoDB binary the integration tests need.',
      `  ${error instanceof Error ? error.message : String(error)}`,
      '  The first run downloads it (needs access to fastdl.mongodb.org) and caches it,',
      '  after which no network is needed. Fix the connection and run the tests again.'
    ].join('\n')
  );
  process.exit(1);
}
