// Shared MongoMemoryReplSet test-database helper.
//
// Locked test strategy (Phase 5 contract): every backend test that
// touches MongoDB -- including transaction-path tests -- runs against a
// real, ephemeral, replica-set-capable mongodb-memory-server instance,
// not a mocked driver and not a permanent external database.
//
// IMPORTANT (flagged explicitly, not silently glossed over): this module
// has NOT been executed successfully in the sandbox this Phase 5A slice
// was authored in. mongodb-memory-server downloads its MongoDB binary
// from fastdl.mongodb.org on first use, and that domain is outside this
// sandbox's network allowlist -- confirmed via a direct smoke test that
// failed with a DownloadError (403), not a code defect. This module's
// logic is written to the documented mongodb-memory-server/Mongoose API
// and follows the same shape as this project's frontend fake-indexeddb
// test setup, but it needs to be run for real (locally, or in an
// environment with network access to fastdl.mongodb.org) before being
// trusted the same way the frontend's 689-test baseline is trusted.

import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';

let replSet;

/**
 * Start an in-memory, single-node MongoDB replica set and connect
 * Mongoose to it. Call once per test file, in a top-level `before`/
 * `beforeEach` hook.
 *
 * @returns {Promise<void>}
 */
export async function connectTestDb() {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const uri = replSet.getUri();
  mongoose.set('bufferCommands', false);
  await mongoose.connect(uri);
}

/**
 * Drop every collection, without dropping the database or disconnecting
 * -- for use between individual tests within a file, so each test starts
 * from a clean slate without paying the cost of a full replica-set
 * restart per test.
 *
 * @returns {Promise<void>}
 */
export async function clearTestDb() {
  const collections = await mongoose.connection.db.collections();
  await Promise.all(collections.map((collection) => collection.deleteMany({})));
}

/**
 * Disconnect Mongoose and stop the in-memory replica set. Call once per
 * test file, in a top-level `after` hook.
 *
 * @returns {Promise<void>}
 */
export async function disconnectTestDb() {
  await mongoose.disconnect();
  if (replSet) {
    await replSet.stop();
    replSet = undefined;
  }
}
