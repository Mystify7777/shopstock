#!/usr/bin/env node
// Seed script -- creates the single initial ShopStock account from
// SEED_USERNAME/SEED_PASSWORD. Run explicitly via `npm run seed`, NEVER
// automatically on server boot (locked contract: account creation is
// exclusively this seed mechanism, no public registration endpoint
// exists anywhere in this application).
//
// Idempotent by design: if a user with SEED_USERNAME already exists,
// this does nothing and exits successfully -- it does NOT reset the
// existing password, and does NOT create a duplicate. Re-running this
// script against an already-seeded database is always safe.
//
// SECURITY: never logs the raw password, at any point, on any path.
//
// Split into seedUser() (the testable core logic, taking explicit
// username/password rather than reading process.env, and NOT calling
// process.exit()) and the CLI entrypoint below it (which loads real
// config, connects/disconnects, and translates outcomes into process
// exit codes) -- the same separation already established by
// config/env.js's validateEnv()/loadConfig() split, for the same
// reason: the core logic needs to be unit-testable without killing the
// test process.

import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { loadConfig } from '../config/env.js';
import { connectDb, disconnectDb } from '../config/db.js';
import { User } from '../models/User.js';

const BCRYPT_SALT_ROUNDS = 10;

/**
 * Idempotently create the single seeded user if it doesn't already
 * exist. Requires an active Mongoose connection -- does not connect or
 * disconnect itself, so it can be exercised directly against a test
 * database without going through the CLI entrypoint's env-loading/
 * process-exit machinery.
 *
 * @param {{ username: string, password: string }} params
 * @returns {Promise<{ created: boolean, username: string }>} `created`
 *   is false when the user already existed (idempotent no-op).
 */
export async function seedUser({ username, password }) {
  const existing = await User.findOne({ username });
  if (existing) {
    return { created: false, username };
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);
  await User.create({ username, passwordHash, refreshTokens: [] });
  return { created: true, username };
}

async function runCli() {
  const config = loadConfig(); // exits the process on missing required vars

  try {
    await connectDb(config.mongodbUri);
  } catch (err) {
    console.error('[ShopStock seed] Failed to connect to MongoDB:', err.message);
    process.exitCode = 1;
    return;
  }

  try {
    const result = await seedUser({ username: config.seedUsername, password: config.seedPassword });
    if (result.created) {
      console.log(`[ShopStock seed] Created user "${result.username}".`);
    } else {
      console.log(`[ShopStock seed] User "${result.username}" already exists -- nothing to do.`);
    }
  } catch (err) {
    console.error('[ShopStock seed] Failed to seed user:', err.message);
    process.exitCode = 1;
  } finally {
    await disconnectDb();
  }
}

// Only run the CLI entrypoint when this file is executed directly (e.g.
// `npm run seed`), not when seedUser() is imported for testing.
if (import.meta.url === `file://${process.argv[1]}`) {
  runCli();
}

