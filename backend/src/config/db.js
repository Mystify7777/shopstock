// MongoDB connection lifecycle, via Mongoose.
//
// Locked contract note (Phase 5 completion gate item): stock-event commits
// require a multi-document transaction, which requires the connected
// MongoDB deployment to be a replica set (a standalone mongod cannot open
// a session transaction at all). This module does not itself enforce or
// verify replica-set topology -- Mongoose's connection succeeds against a
// standalone instance too, and the failure would only surface later, when
// stockEventService.js's transaction actually attempts to open a session.
// The replica-set requirement is instead documented operationally (see
// backend/README.md) as a precondition for local development and as the
// reason MongoDB Atlas -- a replica set by default -- is the production
// target (PRD §41, .env.example).

import mongoose from 'mongoose';

/**
 * Connect to MongoDB. Resolves once the connection is established;
 * rejects (does not process.exit itself) on failure, so the caller
 * (server.js) decides how to react -- keeping this module reusable from
 * both the real server entrypoint and from test setup, where a failed
 * connection should throw/reject rather than kill the test process.
 *
 * serverSelectionTimeoutMS is set explicitly (Mongoose's own default is
 * 30s, and depending on network conditions a genuinely unreachable host
 * can appear to hang well past that) -- a misconfigured MONGODB_URI must
 * fail loudly and reasonably quickly at startup, not hang indefinitely,
 * per this project's own "fail loud at startup" principle. Confirmed by
 * direct testing during Phase 5A: without this option, connecting to an
 * intentionally-unreachable host did not surface any error within 25+
 * seconds.
 *
 * @param {string} uri
 * @param {{ serverSelectionTimeoutMS?: number }} [options]
 * @returns {Promise<typeof mongoose>}
 */
export async function connectDb(uri, options = {}) {
  // bufferCommands: false -- fail fast on a query issued before the
  // connection is actually established, rather than silently queuing it.
  // Correct for a server process: we want startup failures to be loud,
  // not deferred into a mysterious hang on the first request.
  mongoose.set('bufferCommands', false);
  return mongoose.connect(uri, {
    serverSelectionTimeoutMS: options.serverSelectionTimeoutMS ?? 10000
  });
}

/**
 * Disconnect from MongoDB. Used by test teardown and graceful shutdown.
 *
 * @returns {Promise<void>}
 */
export async function disconnectDb() {
  await mongoose.disconnect();
}

/**
 * Current Mongoose connection readyState, translated to a plain string
 * for the health endpoint -- avoids leaking Mongoose's internal numeric
 * enum into an HTTP response.
 *
 * @returns {'disconnected' | 'connected' | 'connecting' | 'disconnecting' | 'unknown'}
 */
export function connectionState() {
  const states = {
    0: 'disconnected',
    1: 'connected',
    2: 'connecting',
    3: 'disconnecting'
  };
  return states[mongoose.connection.readyState] || 'unknown';
}
