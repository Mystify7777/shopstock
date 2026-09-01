// NOT EXECUTED IN THIS SANDBOX -- see backend/README.md and
// docs/PROGRESS.md's Phase 5B entry. Requires a real MongoDB connection
// via tests/helpers/testDb.js's MongoMemoryReplSet, which cannot
// download its binary in this development sandbox. Confirmed to parse
// and import correctly.

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../helpers/testDb.js';
import { User } from '../../src/models/User.js';
import { seedUser } from '../../src/scripts/seed.js';

describe('seedUser', () => {
  before(connectTestDb);
  after(disconnectTestDb);
  beforeEach(clearTestDb);

  test('creates the user when none exists', async () => {
    const result = await seedUser({ username: 'shopowner', password: 'initial-password' });
    assert.equal(result.created, true);
    assert.equal(result.username, 'shopowner');

    const user = await User.findOne({ username: 'shopowner' });
    assert.ok(user);
  });

  test('the stored password is hashed, not the raw password', async () => {
    await seedUser({ username: 'shopowner', password: 'initial-password' });
    const user = await User.findOne({ username: 'shopowner' });
    assert.notEqual(user.passwordHash, 'initial-password');
    const matches = await bcrypt.compare('initial-password', user.passwordHash);
    assert.equal(matches, true);
  });

  test('is idempotent -- running it again when the user already exists does nothing', async () => {
    await seedUser({ username: 'shopowner', password: 'initial-password' });
    const result = await seedUser({ username: 'shopowner', password: 'a-different-password' });
    assert.equal(result.created, false);

    const users = await User.find({ username: 'shopowner' });
    assert.equal(users.length, 1, 'must not create a duplicate');
  });

  test('re-running does NOT reset an existing password', async () => {
    await seedUser({ username: 'shopowner', password: 'initial-password' });
    await seedUser({ username: 'shopowner', password: 'a-completely-different-password' });

    const user = await User.findOne({ username: 'shopowner' });
    const originalStillMatches = await bcrypt.compare('initial-password', user.passwordHash);
    const newPasswordMatches = await bcrypt.compare('a-completely-different-password', user.passwordHash);
    assert.equal(originalStillMatches, true, 'the original password must still work');
    assert.equal(newPasswordMatches, false, 'the second call\'s password must NOT have been applied');
  });

  test('the newly-created user has an empty refreshTokens array', async () => {
    await seedUser({ username: 'shopowner', password: 'initial-password' });
    const user = await User.findOne({ username: 'shopowner' });
    assert.deepEqual(user.refreshTokens, []);
  });
});
