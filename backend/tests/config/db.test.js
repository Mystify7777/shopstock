import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { connectDb, connectionState } from '../../src/config/db.js';

describe('connectDb', () => {
  test('rejects (does not hang) when the target host is unreachable, within a bounded time', async () => {
    // Port 1 is a reserved, essentially-guaranteed-unbound port -- this
    // deterministically exercises the "cannot reach the server" path
    // without depending on any real MongoDB instance being available in
    // this environment. A short serverSelectionTimeoutMS is passed
    // explicitly so this test itself stays fast; the default (10s) is
    // what server.js actually uses.
    const start = Date.now();
    await assert.rejects(
      () => connectDb('mongodb://127.0.0.1:1/nonexistent', { serverSelectionTimeoutMS: 500 }),
      /ECONNREFUSED|connect/i
    );
    const elapsed = Date.now() - start;
    // Generous upper bound -- this just confirms it fails in roughly the
    // configured timeout window, not that it hangs for 30s+ (Mongoose's
    // own default), which was the real defect this option fixes.
    assert.ok(elapsed < 5000, `expected connectDb to fail well under 5s, took ${elapsed}ms`);
  });
});

describe('connectionState', () => {
  test('reports "disconnected" when no connection has been established', () => {
    // Note: this test's correctness depends on no earlier test in this
    // file (or file order) having left an open connection -- connectDb's
    // rejection above does not leave a lingering "connecting" state for
    // an unreachable host once Mongoose gives up, but this is worth
    // stating explicitly rather than assuming silently.
    assert.equal(connectionState(), 'disconnected');
  });
});
