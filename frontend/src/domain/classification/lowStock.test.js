import { describe, it, expect } from 'vitest';
import {
  classifyStockStatus,
  resolveLowStockThreshold,
  needsAttention,
  STOCK_STATUS
} from '../../../src/domain/classification/lowStock.js';

describe('resolveLowStockThreshold', () => {
  it('uses the product override when one is set', () => {
    expect(resolveLowStockThreshold(5, 10)).toBe(10);
  });

  it('falls back to the global default when override is null', () => {
    expect(resolveLowStockThreshold(5, null)).toBe(5);
  });

  it('falls back to the global default when override is undefined', () => {
    expect(resolveLowStockThreshold(5, undefined)).toBe(5);
  });

  it('allows an override of exactly 0 (product wants to be warned only at zero) rather than treating it as absent', () => {
    expect(resolveLowStockThreshold(5, 0)).toBe(0);
  });

  it('throws if globalDefaultThreshold is not a finite non-negative number', () => {
    expect(() => resolveLowStockThreshold(NaN, null)).toThrow(TypeError);
    expect(() => resolveLowStockThreshold(-1, null)).toThrow(TypeError);
    expect(() => resolveLowStockThreshold('5', null)).toThrow(TypeError);
  });

  it('ignores a negative override and falls back to the global default', () => {
    expect(resolveLowStockThreshold(5, -3)).toBe(5);
  });
});

describe('classifyStockStatus — basic thresholds (PRD §22 example: default 5, override 10)', () => {
  it('is NORMAL when quantity is above the effective threshold', () => {
    const status = classifyStockStatus({
      quantity: 20,
      globalDefaultThreshold: 5,
      productThresholdOverride: null
    });
    expect(status).toBe(STOCK_STATUS.NORMAL);
  });

  it('is LOW when quantity is at or below the effective threshold (using global default)', () => {
    const status = classifyStockStatus({
      quantity: 5,
      globalDefaultThreshold: 5,
      productThresholdOverride: null
    });
    expect(status).toBe(STOCK_STATUS.LOW);
  });

  it('is LOW when quantity is below the effective threshold (using global default)', () => {
    const status = classifyStockStatus({
      quantity: 3,
      globalDefaultThreshold: 5,
      productThresholdOverride: null
    });
    expect(status).toBe(STOCK_STATUS.LOW);
  });

  it('uses the product override instead of the global default when set (PRD §22 example: override 10)', () => {
    const status = classifyStockStatus({
      quantity: 8,
      globalDefaultThreshold: 5,
      productThresholdOverride: 10
    });
    // 8 <= 10 (override), so LOW even though 8 > 5 (global default).
    expect(status).toBe(STOCK_STATUS.LOW);
  });

  it('is NORMAL when quantity exceeds the product override even though it would be LOW under the global default', () => {
    const status = classifyStockStatus({
      quantity: 6,
      globalDefaultThreshold: 10,
      productThresholdOverride: 2
    });
    // 6 > 2 (override) -> NORMAL, even though 6 < 10 (global default).
    expect(status).toBe(STOCK_STATUS.NORMAL);
  });
});

describe('classifyStockStatus — out of stock', () => {
  it('is OUT at exactly zero quantity', () => {
    const status = classifyStockStatus({
      quantity: 0,
      globalDefaultThreshold: 5,
      productThresholdOverride: null
    });
    expect(status).toBe(STOCK_STATUS.OUT);
  });

  it('is OUT at zero even when the effective threshold is also 0', () => {
    const status = classifyStockStatus({
      quantity: 0,
      globalDefaultThreshold: 0,
      productThresholdOverride: null
    });
    expect(status).toBe(STOCK_STATUS.OUT);
  });

  it('OUT takes priority even when lowStockDisabled is true', () => {
    const status = classifyStockStatus({
      quantity: 0,
      globalDefaultThreshold: 5,
      productThresholdOverride: null,
      lowStockDisabled: true
    });
    // Muting the LOW warning must not also mute OUT — "nothing left" is a
    // more absolute fact than "running low."
    expect(status).toBe(STOCK_STATUS.OUT);
  });
});

describe('classifyStockStatus — lowStockDisabled', () => {
  it('is NORMAL (not LOW) when disabled, even at a quantity that would otherwise be LOW', () => {
    const status = classifyStockStatus({
      quantity: 2,
      globalDefaultThreshold: 5,
      productThresholdOverride: null,
      lowStockDisabled: true
    });
    expect(status).toBe(STOCK_STATUS.NORMAL);
  });

  it('is still NORMAL when disabled and genuinely above threshold (no behavior change in that case)', () => {
    const status = classifyStockStatus({
      quantity: 50,
      globalDefaultThreshold: 5,
      productThresholdOverride: null,
      lowStockDisabled: true
    });
    expect(status).toBe(STOCK_STATUS.NORMAL);
  });

  it('defaults lowStockDisabled to false when omitted', () => {
    const status = classifyStockStatus({
      quantity: 2,
      globalDefaultThreshold: 5,
      productThresholdOverride: null
    });
    expect(status).toBe(STOCK_STATUS.LOW);
  });
});

describe('classifyStockStatus — decimal quantities (PRD §6)', () => {
  it('classifies a decimal quantity against a whole-number threshold correctly', () => {
    const status = classifyStockStatus({
      quantity: 4.5,
      globalDefaultThreshold: 5,
      productThresholdOverride: null
    });
    expect(status).toBe(STOCK_STATUS.LOW);
  });

  it('classifies a decimal quantity against a decimal threshold correctly', () => {
    const status = classifyStockStatus({
      quantity: 2.5,
      globalDefaultThreshold: 5,
      productThresholdOverride: 2.5
    });
    expect(status).toBe(STOCK_STATUS.LOW);
  });

  it('a tiny positive decimal quantity is LOW, not OUT', () => {
    const status = classifyStockStatus({
      quantity: 0.1,
      globalDefaultThreshold: 5,
      productThresholdOverride: null
    });
    expect(status).toBe(STOCK_STATUS.LOW);
  });
});

describe('classifyStockStatus — boundary exactness', () => {
  it('quantity exactly equal to threshold is LOW, not NORMAL (inclusive boundary)', () => {
    const status = classifyStockStatus({
      quantity: 10,
      globalDefaultThreshold: 10,
      productThresholdOverride: null
    });
    expect(status).toBe(STOCK_STATUS.LOW);
  });

  it('quantity one unit above threshold is NORMAL', () => {
    const status = classifyStockStatus({
      quantity: 11,
      globalDefaultThreshold: 10,
      productThresholdOverride: null
    });
    expect(status).toBe(STOCK_STATUS.NORMAL);
  });
});

describe('classifyStockStatus — validation', () => {
  it('throws on a negative quantity', () => {
    expect(() =>
      classifyStockStatus({ quantity: -1, globalDefaultThreshold: 5, productThresholdOverride: null })
    ).toThrow(TypeError);
  });

  it('throws on a non-finite quantity', () => {
    expect(() =>
      classifyStockStatus({ quantity: NaN, globalDefaultThreshold: 5, productThresholdOverride: null })
    ).toThrow(TypeError);
    expect(() =>
      classifyStockStatus({
        quantity: Infinity,
        globalDefaultThreshold: 5,
        productThresholdOverride: null
      })
    ).toThrow(TypeError);
  });

  it('throws on a non-numeric quantity', () => {
    expect(() =>
      classifyStockStatus({ quantity: 'five', globalDefaultThreshold: 5, productThresholdOverride: null })
    ).toThrow(TypeError);
  });
});

describe('needsAttention', () => {
  it('is true for LOW', () => {
    expect(needsAttention(STOCK_STATUS.LOW)).toBe(true);
  });

  it('is true for OUT', () => {
    expect(needsAttention(STOCK_STATUS.OUT)).toBe(true);
  });

  it('is false for NORMAL', () => {
    expect(needsAttention(STOCK_STATUS.NORMAL)).toBe(false);
  });

  it('is false for an unrecognized status string', () => {
    expect(needsAttention('Something Else')).toBe(false);
  });
});
