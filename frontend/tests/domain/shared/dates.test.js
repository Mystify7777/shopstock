import { describe, it, expect } from 'vitest';
import {
  timestampNow,
  todayDateOnly,
  dateToDateOnly,
  isValidDateOnly,
  isValidTimestamp,
  compareDates,
  isBefore,
  isAfter,
  formatDateOnlyForDisplay,
  formatTimestampForDisplay
} from '../../../src/domain/shared/dates.js';

describe('timestampNow', () => {
  it('returns a valid timestamp string', () => {
    const ts = timestampNow();
    expect(isValidTimestamp(ts)).toBe(true);
  });

  it('returns a value close to the actual current time', () => {
    const before = Date.now();
    const ts = timestampNow();
    const after = Date.now();
    const parsed = new Date(ts).getTime();
    expect(parsed).toBeGreaterThanOrEqual(before);
    expect(parsed).toBeLessThanOrEqual(after);
  });
});

describe('todayDateOnly', () => {
  it('returns a valid date-only string', () => {
    expect(isValidDateOnly(todayDateOnly())).toBe(true);
  });

  it('matches dateToDateOnly(new Date()) at call time', () => {
    // Not a perfect guarantee (a test could run across midnight), but
    // deterministically correct for any normal test run.
    expect(todayDateOnly()).toBe(dateToDateOnly(new Date()));
  });
});

describe('dateToDateOnly', () => {
  it('extracts the local calendar date from a Date object', () => {
    const d = new Date(2026, 7, 9); // JS months are 0-indexed: 7 = August
    expect(dateToDateOnly(d)).toBe('2026-08-09');
  });

  it('zero-pads single-digit months and days', () => {
    const d = new Date(2026, 0, 5); // Jan 5
    expect(dateToDateOnly(d)).toBe('2026-01-05');
  });

  it('throws on a non-Date input', () => {
    expect(() => dateToDateOnly('2026-08-09')).toThrow(TypeError);
  });

  it('throws on an invalid Date object', () => {
    expect(() => dateToDateOnly(new Date('not-a-date'))).toThrow(TypeError);
  });
});

describe('isValidDateOnly', () => {
  it('accepts a well-formed date', () => {
    expect(isValidDateOnly('2026-08-09')).toBe(true);
  });

  it('accepts a leap-day date in a leap year', () => {
    expect(isValidDateOnly('2024-02-29')).toBe(true);
  });

  it('rejects a leap-day date in a non-leap year', () => {
    expect(isValidDateOnly('2026-02-29')).toBe(false);
  });

  it('rejects an out-of-range day (month overflow trap)', () => {
    // Naive Date parsing would silently roll this over to March 2nd.
    expect(isValidDateOnly('2026-02-30')).toBe(false);
  });

  it('rejects an out-of-range month', () => {
    expect(isValidDateOnly('2026-13-01')).toBe(false);
  });

  it('rejects a value with a time component', () => {
    expect(isValidDateOnly('2026-08-09T00:00:00.000Z')).toBe(false);
  });

  it('rejects a non-padded date', () => {
    expect(isValidDateOnly('2026-8-9')).toBe(false);
  });

  it('rejects null, undefined, numbers', () => {
    expect(isValidDateOnly(null)).toBe(false);
    expect(isValidDateOnly(undefined)).toBe(false);
    expect(isValidDateOnly(20260809)).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(isValidDateOnly('')).toBe(false);
  });
});

describe('isValidTimestamp', () => {
  it('accepts a well-formed timestamp', () => {
    expect(isValidTimestamp('2026-08-09T09:42:31.123Z')).toBe(true);
  });

  it('accepts a freshly generated timestampNow()', () => {
    expect(isValidTimestamp(timestampNow())).toBe(true);
  });

  it('rejects a date-only string', () => {
    expect(isValidTimestamp('2026-08-09')).toBe(false);
  });

  it('rejects a timestamp missing milliseconds', () => {
    expect(isValidTimestamp('2026-08-09T09:42:31Z')).toBe(false);
  });

  it('rejects a timestamp missing the trailing Z', () => {
    expect(isValidTimestamp('2026-08-09T09:42:31.123')).toBe(false);
  });

  it('rejects garbage input', () => {
    expect(isValidTimestamp('not-a-timestamp')).toBe(false);
    expect(isValidTimestamp(null)).toBe(false);
    expect(isValidTimestamp(undefined)).toBe(false);
  });
});

describe('compareDates / isBefore / isAfter', () => {
  it('compares two date-only strings correctly', () => {
    expect(compareDates('2026-08-08', '2026-08-09')).toBeLessThan(0);
    expect(compareDates('2026-08-09', '2026-08-08')).toBeGreaterThan(0);
    expect(compareDates('2026-08-09', '2026-08-09')).toBe(0);
  });

  it('compares two timestamp strings correctly', () => {
    const earlier = '2026-08-09T09:42:31.123Z';
    const later = '2026-08-09T15:42:31.123Z';
    expect(compareDates(earlier, later)).toBeLessThan(0);
    expect(isBefore(earlier, later)).toBe(true);
    expect(isAfter(later, earlier)).toBe(true);
    expect(isBefore(later, earlier)).toBe(false);
  });

  it('handles year and month boundaries correctly (string sort validity check)', () => {
    expect(isBefore('2025-12-31', '2026-01-01')).toBe(true);
    expect(isBefore('2026-01-31', '2026-02-01')).toBe(true);
  });

  it('throws when comparing non-string values', () => {
    expect(() => compareDates(new Date(), '2026-08-09')).toThrow(TypeError);
    expect(() => compareDates('2026-08-09', null)).toThrow(TypeError);
  });
});

describe('formatDateOnlyForDisplay', () => {
  it('formats per the PRD example ("09 Aug 2026")', () => {
    expect(formatDateOnlyForDisplay('2026-08-09')).toBe('09 Aug 2026');
  });

  it('formats a single-digit day with zero-padding', () => {
    expect(formatDateOnlyForDisplay('2026-01-05')).toBe('05 Jan 2026');
  });

  it('formats December correctly (month index boundary)', () => {
    expect(formatDateOnlyForDisplay('2026-12-25')).toBe('25 Dec 2026');
  });

  it('throws on an invalid date-only string', () => {
    expect(() => formatDateOnlyForDisplay('2026-02-30')).toThrow(TypeError);
    expect(() => formatDateOnlyForDisplay('not-a-date')).toThrow(TypeError);
  });
});

describe('formatTimestampForDisplay', () => {
  it('formats an afternoon timestamp in 12-hour clock with AM/PM', () => {
    // 15:42 local -> 3:42 PM, matching the PRD §12 worked example shape.
    const d = new Date(2026, 7, 9, 15, 42, 0, 0);
    const ts = d.toISOString();
    const result = formatTimestampForDisplay(ts);
    expect(result).toMatch(/^09 Aug 2026, \d{1,2}:\d{2} (AM|PM)$/);
  });

  it('formats midnight as 12:00 AM, not 0:00 AM', () => {
    const d = new Date(2026, 7, 9, 0, 5, 0, 0);
    const result = formatTimestampForDisplay(d.toISOString());
    expect(result).toContain('12:05 AM');
  });

  it('formats noon as 12:00 PM, not 0:00 PM', () => {
    const d = new Date(2026, 7, 9, 12, 0, 0, 0);
    const result = formatTimestampForDisplay(d.toISOString());
    expect(result).toContain('12:00 PM');
  });

  it('zero-pads minutes', () => {
    const d = new Date(2026, 7, 9, 9, 5, 0, 0);
    const result = formatTimestampForDisplay(d.toISOString());
    expect(result).toMatch(/:05 (AM|PM)$/);
  });

  it('throws on an invalid timestamp', () => {
    expect(() => formatTimestampForDisplay('2026-08-09')).toThrow(TypeError);
    expect(() => formatTimestampForDisplay('garbage')).toThrow(TypeError);
  });
});
