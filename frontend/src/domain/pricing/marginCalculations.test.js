import { describe, it, expect } from 'vitest';
import {
  resolveMargin,
  calculateSuggestedSellingPrice,
  calculateActualMargin
} from '../../../src/domain/pricing/marginCalculations.js';

describe('resolveMargin', () => {
  it('uses the product override when one is set', () => {
    expect(resolveMargin(20, 25)).toBe(25);
  });

  it('falls back to the global default when override is null', () => {
    expect(resolveMargin(20, null)).toBe(20);
  });

  it('falls back to the global default when override is undefined', () => {
    expect(resolveMargin(20, undefined)).toBe(20);
  });

  it('allows a negative override (loss-leader) rather than treating it as absent', () => {
    expect(resolveMargin(20, -10)).toBe(-10);
  });

  it('allows an override of exactly 0 rather than treating it as absent', () => {
    expect(resolveMargin(20, 0)).toBe(0);
  });

  it('throws if globalDefaultMargin is not a finite number', () => {
    expect(() => resolveMargin(NaN, null)).toThrow(TypeError);
    expect(() => resolveMargin('20', null)).toThrow(TypeError);
  });
});

describe('calculateSuggestedSellingPrice — matches PRD §20 worked example', () => {
  it('cost ₹80 at 20% margin suggests ₹100 exactly', () => {
    const { suggestedPrice, reason } = calculateSuggestedSellingPrice(80, 20);
    expect(reason).toBeNull();
    expect(suggestedPrice).toBeCloseTo(100, 6);
  });

  it('is gross margin (on price), NOT markup (on cost) — the two disagree and this must match margin', () => {
    // Cost 80, price 100: margin = 20%, markup = 25%. Confirms the
    // function solves for margin-on-price, not markup-on-cost, by
    // checking it does NOT reproduce the markup-based answer.
    const marginResult = calculateSuggestedSellingPrice(80, 20);
    const markupWouldGive = 80 * 1.2; // = 96, the (wrong, markup-style) answer
    expect(marginResult.suggestedPrice).not.toBeCloseTo(markupWouldGive, 2);
    expect(marginResult.suggestedPrice).toBeCloseTo(100, 6);
  });

  it('keeps suggested-price and actual-margin calculations internally consistent when PRD §21\'s margin is unspecified', () => {
    // PRD §21 shows cost ₹60 and a suggested price of ₹72 without stating
    // the margin used in that particular example, so we can't assert
    // ₹60 → ₹72 directly. What we CAN assert is that our formula is
    // self-consistent: solving suggested price at some margin and then
    // recomputing actual margin from that price must return the same
    // margin we started with.
    const { suggestedPrice } = calculateSuggestedSellingPrice(60, 20);
    const { marginPercent } = calculateActualMargin(60, suggestedPrice);
    expect(marginPercent).toBeCloseTo(20, 6);
  });

  it('produces a lower-than-cost price for a negative margin (loss-leader)', () => {
    const { suggestedPrice, reason } = calculateSuggestedSellingPrice(100, -10);
    expect(reason).toBeNull();
    expect(suggestedPrice).toBeLessThan(100);
    expect(suggestedPrice).toBeCloseTo(90.909, 2);
  });

  it('returns price equal to cost at 0% margin', () => {
    const { suggestedPrice } = calculateSuggestedSellingPrice(50, 0);
    expect(suggestedPrice).toBeCloseTo(50, 6);
  });

  it('returns null with a reason at exactly 100% margin (division by zero)', () => {
    const { suggestedPrice, reason } = calculateSuggestedSellingPrice(80, 100);
    expect(suggestedPrice).toBeNull();
    expect(reason).toMatch(/100%/);
  });

  it('returns null with a reason above 100% margin', () => {
    const { suggestedPrice, reason } = calculateSuggestedSellingPrice(80, 150);
    expect(suggestedPrice).toBeNull();
    expect(reason).toBeTruthy();
  });

  it('handles margin just under 100% with a very large but finite price', () => {
    const { suggestedPrice, reason } = calculateSuggestedSellingPrice(10, 99);
    expect(reason).toBeNull();
    expect(suggestedPrice).toBeCloseTo(1000, 2);
    expect(Number.isFinite(suggestedPrice)).toBe(true);
  });

  it('throws on a non-finite cost', () => {
    expect(() => calculateSuggestedSellingPrice(NaN, 20)).toThrow(TypeError);
    expect(() => calculateSuggestedSellingPrice(Infinity, 20)).toThrow(TypeError);
  });

  it('throws on a non-finite margin', () => {
    expect(() => calculateSuggestedSellingPrice(80, NaN)).toThrow(TypeError);
  });
});

describe('calculateActualMargin — after a price is manually set (PRD §20)', () => {
  it('cost ₹80, price ₹100 → 20% margin (not 25% markup)', () => {
    const { marginPercent, reason } = calculateActualMargin(80, 100);
    expect(reason).toBeNull();
    expect(marginPercent).toBeCloseTo(20, 6);
  });

  it('round-trips with calculateSuggestedSellingPrice for a range of margins', () => {
    for (const margin of [-20, -5, 0, 10, 20, 33.33, 50, 75, 99]) {
      const { suggestedPrice } = calculateSuggestedSellingPrice(80, margin);
      const { marginPercent } = calculateActualMargin(80, suggestedPrice);
      expect(marginPercent).toBeCloseTo(margin, 6);
    }
  });

  it('produces a negative margin when selling below cost', () => {
    const { marginPercent, reason } = calculateActualMargin(100, 90);
    expect(reason).toBeNull();
    // (90 - 100) / 90 * 100 = -11.111...
    expect(marginPercent).toBeCloseTo(-11.111, 2);
  });

  it('produces a margin approaching 100% as cost approaches 0', () => {
    const { marginPercent } = calculateActualMargin(1, 100);
    expect(marginPercent).toBeCloseTo(99, 1);
  });

  it('produces 0% margin when selling exactly at cost', () => {
    const { marginPercent } = calculateActualMargin(50, 50);
    expect(marginPercent).toBeCloseTo(0, 6);
  });

  it('returns null with a reason when selling price is ₹0', () => {
    const { marginPercent, reason } = calculateActualMargin(50, 0);
    expect(marginPercent).toBeNull();
    expect(reason).toMatch(/₹0|zero/i);
  });

  it('throws on a non-finite cost or sellingPrice', () => {
    expect(() => calculateActualMargin(NaN, 100)).toThrow(TypeError);
    expect(() => calculateActualMargin(80, NaN)).toThrow(TypeError);
  });
});

describe('margin vs markup — explicit worked contrast', () => {
  it('cost ₹80 / price ₹100 is 20% margin and 25% markup — this file only ever produces the margin figure', () => {
    const { marginPercent } = calculateActualMargin(80, 100);
    const markup = ((100 - 80) / 80) * 100;
    expect(marginPercent).toBeCloseTo(20, 6);
    expect(markup).toBeCloseTo(25, 6);
    expect(marginPercent).not.toBeCloseTo(markup, 1);
  });
});
