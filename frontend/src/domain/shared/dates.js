// Date/time helpers — the domain's one and only representation of dates.
//
// CONTRACT: every date-related field on a domain entity is a plain ISO 8601
// STRING, never a `Date` object. `Date` objects are constructed transiently
// inside these helpers when a calculation needs one, and immediately
// converted back. This keeps:
//   - IndexedDB serialization predictable (Dexie stores what you give it —
//     a stray `Date` object behaves differently from a string across
//     structured-clone boundaries and browser versions)
//   - MongoDB documents predictable (no BSON Date vs. ISO-string ambiguity
//     to reason about at the sync boundary)
//   - JSON export trivial (PRD §36 — it's already a string)
//   - Comparisons trivial (ISO 8601 strings sort correctly as plain strings)
//
// Two DIFFERENT kinds of date value exist in the domain and must not be
// confused:
//
//   DATE-ONLY   e.g. StockEvent.purchaseDate, Product.latestPurchaseDate
//               Format: "YYYY-MM-DD"            (no time, no timezone)
//               Represents a calendar day, deliberately independent of
//               timezone — "09 Aug 2026" means the same thing on every
//               device, unlike an instant in time. PRD §12 shows purchase
//               date rendered as a plain calendar date ("08 Aug 2026").
//
//   TIMESTAMP   e.g. StockEvent.recordedAt, createdAt, updatedAt
//               Format: full ISO 8601 UTC instant,
//               e.g. "2026-08-09T09:42:31.123Z"
//               Represents a specific moment, used for audit ordering and
//               sync's last-write-wins comparison (PRD §32).
//
// Mixing these up is exactly the kind of bug that looks fine in testing
// (same timezone as the developer) and then quietly shifts a purchase date
// by a day for a user in a different timezone. The functions below are
// named and typed distinctly on purpose so that mistake requires actively
// ignoring the function name.

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// A reasonably strict ISO 8601 UTC-instant pattern: requires the
// milliseconds and the trailing 'Z'. This matches exactly what
// `timestampNow()` below produces, so anything we generate ourselves is
// always valid against this same pattern.
const TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * The current instant, as a timestamp string.
 * Use for `recordedAt`, `createdAt`, `updatedAt`, and any other field that
 * represents "when did this actually happen," not "which calendar day."
 *
 * @returns {string} e.g. "2026-08-09T09:42:31.123Z"
 */
export function timestampNow() {
  return new Date().toISOString();
}

/**
 * Today's calendar date, as a date-only string, in the LOCAL timezone of
 * the device calling this function.
 *
 * This is deliberately local-time, not UTC: PRD §12 says purchaseDate
 * "defaults to today," and "today" for a shop owner means their own
 * calendar day, not UTC's. Using UTC here would make the default wrong for
 * roughly half the world for part of every day.
 *
 * @returns {string} e.g. "2026-08-09"
 */
export function todayDateOnly() {
  return dateToDateOnly(new Date());
}

/**
 * Convert a `Date` object to a date-only string, using that Date's local
 * calendar day (year/month/day as the JS runtime's local timezone sees
 * them) — not its UTC day.
 *
 * @param {Date} date
 * @returns {string} e.g. "2026-08-09"
 */
export function dateToDateOnly(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new TypeError('dateToDateOnly requires a valid Date object');
  }
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Is this a well-formed date-only string ("YYYY-MM-DD") representing a
 * real calendar date (rejects e.g. "2026-02-30")?
 *
 * @param {*} value
 * @returns {boolean}
 */
export function isValidDateOnly(value) {
  if (typeof value !== 'string' || !DATE_ONLY_PATTERN.test(value)) {
    return false;
  }
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  // Guards against e.g. "2026-02-30" silently overflowing to March 2nd —
  // if the components don't round-trip, the input wasn't a real date.
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

/**
 * Is this a well-formed timestamp string, matching what `timestampNow()`
 * produces (full ISO 8601 UTC instant with milliseconds and 'Z')?
 *
 * @param {*} value
 * @returns {boolean}
 */
export function isValidTimestamp(value) {
  if (typeof value !== 'string' || !TIMESTAMP_PATTERN.test(value)) {
    return false;
  }
  return !Number.isNaN(new Date(value).getTime());
}

/**
 * Compare two date-only strings or two timestamp strings.
 *
 * Because both formats are ISO 8601 with fixed-width, zero-padded fields,
 * plain string comparison already sorts correctly — this wrapper exists so
 * call sites read clearly (`compareDates(a, b) < 0` rather than a bare
 * string `<`) and so invalid input fails loudly instead of silently
 * comparing garbage.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} negative if a < b, 0 if equal, positive if a > b
 */
export function compareDates(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') {
    throw new TypeError('compareDates requires two date strings');
  }
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Is timestamp/date-only string `a` strictly before `b`?
 * Works for either format as long as both arguments are the same format.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function isBefore(a, b) {
  return compareDates(a, b) < 0;
}

/**
 * Is timestamp/date-only string `a` strictly after `b`?
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function isAfter(a, b) {
  return compareDates(a, b) > 0;
}

/**
 * Format a date-only string for human display, per the PRD's example
 * rendering ("08 Aug 2026" — PRD §12).
 *
 * Deliberately locale-fixed (not using device locale) so history/exports
 * look the same regardless of device settings, matching every worked
 * example in the PRD. If localized display is wanted later, that's a
 * presentation-layer decision, not a change to this domain helper.
 *
 * @param {string} dateOnly e.g. "2026-08-09"
 * @returns {string} e.g. "09 Aug 2026"
 */
export function formatDateOnlyForDisplay(dateOnly) {
  if (!isValidDateOnly(dateOnly)) {
    throw new TypeError(`Invalid date-only string: ${dateOnly}`);
  }
  const [year, month, day] = dateOnly.split('-').map(Number);
  const monthNames = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
  ];
  return `${String(day).padStart(2, '0')} ${monthNames[month - 1]} ${year}`;
}

/**
 * Format a timestamp string for human display, per the PRD's example
 * rendering ("09 Aug 2026, 3:42 PM" / "3:42 PM" — PRD §12, §13).
 *
 * Uses the LOCAL timezone for display (a timestamp is a real instant, and
 * showing it in the viewer's local time is correct and expected — unlike
 * date-only values, there's no "which timezone's calendar day" ambiguity
 * here because we're displaying a clock time, not deriving a calendar day).
 *
 * @param {string} timestamp e.g. "2026-08-09T09:42:31.123Z"
 * @returns {string} e.g. "09 Aug 2026, 3:12 PM"
 */
export function formatTimestampForDisplay(timestamp) {
  if (!isValidTimestamp(timestamp)) {
    throw new TypeError(`Invalid timestamp string: ${timestamp}`);
  }
  const date = new Date(timestamp);
  const datePart = formatDateOnlyForDisplay(dateToDateOnly(date));

  let hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const period = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12;
  if (hours === 0) hours = 12;

  return `${datePart}, ${hours}:${minutes} ${period}`;
}
