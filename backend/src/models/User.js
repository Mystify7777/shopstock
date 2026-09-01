// User model -- single seeded account in v1 (Phase 5B locked contract).
//
// _id strategy: standard MongoDB ObjectId, NOT the entityId-as-_id
// convention used by every other collection (products, stockEvents,
// classifications). That convention exists specifically to support
// sync/dedup for client-originated entities created via the frontend's
// generateId() -- User is server-created exclusively via the seed
// script, never synced from a client, and never referenced by entityId
// anywhere in the sync protocol (verified against ARCHITECTURE.md's
// MongoDB schema section before locking this, not assumed). The user is
// located by its unique `username`, not by a known _id value.
//
// Refresh token hashing: SHA-256, not bcrypt. Bcrypt's deliberate
// computational cost is the right tool for a low-entropy, user-chosen
// password; a refresh token is a 256-bit cryptographically random value
// generated server-side, and hashing it with bcrypt would add cost with
// no corresponding security benefit while also being slower to look up.
// SHA-256 is a standard, appropriate choice for hashing an
// already-high-entropy secret for deterministic lookup.
//
// Rotation lifecycle (locked): on refresh, the OLD token entry is
// REMOVED (not left behind with revoked: true) and a new entry is added,
// in one atomic update -- no growing graveyard of revoked entries. The
// `revoked` flag exists for logout and password-change, where an entry
// legitimately needs to be marked invalid without necessarily being
// pruned in the same operation, and for the rare case a $pull filter
// needs an already-revoked-but-not-yet-cleaned-up entry to still fail a
// concurrent match cleanly.

import mongoose from 'mongoose';

const MAX_DEVICE_LABEL_LENGTH = 200;

/**
 * Trim and bound a raw User-Agent string into a safe device label. Never
 * stores an arbitrarily large raw header. No fingerprinting beyond this
 * simple truncated label -- no IP capture, no parsed browser/OS
 * detection.
 *
 * @param {string|undefined|null} rawUserAgent
 * @returns {string}
 */
export function toDeviceLabel(rawUserAgent) {
  if (!rawUserAgent) return 'Unknown device';
  const trimmed = rawUserAgent.trim();
  if (trimmed.length === 0) return 'Unknown device';
  return trimmed.length > MAX_DEVICE_LABEL_LENGTH
    ? trimmed.slice(0, MAX_DEVICE_LABEL_LENGTH)
    : trimmed;
}

const refreshTokenSchema = new mongoose.Schema(
  {
    tokenHash: { type: String, required: true },
    deviceLabel: { type: String, required: true },
    createdAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
    revoked: { type: Boolean, required: true, default: false }
  },
  { _id: false }
);

const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  passwordHash: { type: String, required: true },
  refreshTokens: { type: [refreshTokenSchema], default: [] }
});

export const User = mongoose.model('User', userSchema);
