import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { toDeviceLabel } from '../../src/models/User.js';

describe('toDeviceLabel', () => {
  test('returns the trimmed User-Agent string as-is when short', () => {
    assert.equal(toDeviceLabel('Mozilla/5.0 (Test)'), 'Mozilla/5.0 (Test)');
  });

  test('trims leading/trailing whitespace', () => {
    assert.equal(toDeviceLabel('   Mozilla/5.0 (Test)   '), 'Mozilla/5.0 (Test)');
  });

  test('returns a fallback label when the header is missing', () => {
    assert.equal(toDeviceLabel(undefined), 'Unknown device');
    assert.equal(toDeviceLabel(null), 'Unknown device');
  });

  test('returns a fallback label when the header is empty or whitespace-only', () => {
    assert.equal(toDeviceLabel(''), 'Unknown device');
    assert.equal(toDeviceLabel('   '), 'Unknown device');
  });

  test('truncates a User-Agent longer than 200 characters', () => {
    const longUA = 'A'.repeat(500);
    const result = toDeviceLabel(longUA);
    assert.equal(result.length, 200);
    assert.equal(result, 'A'.repeat(200));
  });

  test('does not truncate a User-Agent exactly at the 200-character boundary', () => {
    const exactUA = 'B'.repeat(200);
    assert.equal(toDeviceLabel(exactUA), exactUA);
  });
});
