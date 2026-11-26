// The ShopStock API as a serverless function (Vercel runs an Express app as one
// function, on instances that are reused for a while and then thrown away).
//
// server.js is for a host that runs one long-lived process: it connects to MongoDB,
// then listens on a port, and exits if either fails. None of that fits a function:
// there is no port to listen on, no "startup" to fail, and process.exit() would kill
// the instance on every request. This module wraps the same createApp() instead:
//
//   - the environment is read, and the app built, on the first request, and a bad
//     environment answers with the standard 500 (and a log line naming the variables)
//     instead of exiting;
//   - the MongoDB connection is opened on demand and reused while the instance lives.
//     db.js sets bufferCommands to false, so a query before the connection is ready
//     fails: every request therefore waits for the connection first. Requests that
//     arrive together share one connection attempt, and a failed attempt is retried by
//     the next request rather than remembered;
//   - the connection pool is small, so many instances cannot exhaust the database's
//     connection limit.
//
// Nothing else changes: the routes, auth, rate limiting and error shapes are the ones
// createApp() already builds. One thing does differ from a long-lived server, and is
// worth knowing: the auth rate limiter keeps its counters in memory, so each instance
// counts for itself (docs/DEPLOYMENT.md, "Known limitations on a serverless host").

import express from 'express';
import { createApp } from './app.js';
import { connectDb, connectionState } from './config/db.js';
import { readConfig } from './config/env.js';
import { errorHandler } from './middleware/errorHandler.js';

// Small on purpose. A pool is per instance, and instances multiply under load.
export const SERVERLESS_MAX_POOL_SIZE = 10;

const HEALTH_PATH = '/api/health';

// Driver errors can echo parts of a connection string. Log what happened, never a credential.
function redact(text, uri) {
  const withoutUri = uri ? String(text).split(uri).join('<MONGODB_URI>') : String(text);
  return withoutUri.replace(/\/\/[^/\s@]+:[^/\s@]*@/g, '//<credentials>@');
}

/**
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   connect?: (uri: string, options: { maxPoolSize: number }) => Promise<unknown>,
 *   isConnected?: () => boolean,
 *   buildApp?: typeof createApp,
 *   maxPoolSize?: number
 * }} [deps] All optional; the defaults are the real thing. They exist so tests can run this without a database.
 * @returns {import('express').Express}
 */
export function createServerlessApp({
  env = process.env,
  connect = connectDb,
  isConnected = () => connectionState() === 'connected',
  buildApp = createApp,
  maxPoolSize = SERVERLESS_MAX_POOL_SIZE
} = {}) {
  let config = null;
  let inner = null;
  let connecting = null;

  // Read the environment and build the real app once it is valid. Throws (names only)
  // when it is not, and tries again on the next request.
  function getInner() {
    if (inner) return inner;
    const candidate = readConfig(env);
    inner = buildApp({
      corsOrigin: candidate.corsOrigins,
      trustProxy: candidate.trustProxy,
      jwtAccessSecret: candidate.jwtAccessSecret,
      jwtAccessExpiresIn: candidate.jwtAccessExpiresIn,
      refreshTokenExpiresInDays: candidate.refreshTokenExpiresInDays
    });
    config = candidate;
    return inner;
  }

  async function ensureDb() {
    if (isConnected()) return;
    // One attempt at a time, shared by every request that arrives meanwhile; cleared
    // when it settles, so a failure is retried by the next request and a dropped
    // connection is reopened.
    connecting ??= Promise.resolve(connect(config.mongodbUri, { maxPoolSize })).finally(() => {
      connecting = null;
    });
    try {
      await connecting;
    } catch (error) {
      // A fresh Error, not the driver's: the response and the log must not carry its raw text.
      throw new Error(`Could not connect to MongoDB: ${redact(`${error?.name ?? 'Error'}: ${error?.message ?? ''}`, config.mongodbUri)}`);
    }
  }

  const app = express();

  app.use(async (req, res, next) => {
    try {
      const target = getInner();
      if (req.path === HEALTH_PATH) {
        // The health check reports the database state and never fails because of it
        // (see createApp), so it tries to connect but ignores a failure.
        await ensureDb().catch(() => {});
      } else if (req.method !== 'OPTIONS') {
        // A CORS preflight needs no database, so it does not wait for one.
        await ensureDb();
      }
      target(req, res, next);
    } catch (error) {
      next(error);
    }
  });

  // Same JSON envelope and logging as the rest of the API; the client sees "Something went wrong."
  app.use(errorHandler);

  return app;
}
