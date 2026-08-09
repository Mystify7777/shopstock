// Cost calculations — pure projections over stock-ADDITION events.
//
// Scope, deliberately narrow: this file computes latest/average known cost
// from a list of stock events already in hand. It does NOT:
//   - read from IndexedDB, MongoDB, or any repository
//   - know that "StockEvent" is stored anywhere in particular
//   - mutate Product or create any event
//   - decide selling price or margin (that's domain/pricing/marginCalculations.js)
//
// Callers (services/repositories) are responsible for fetching a product's
// stock events and passing the relevant ones in. This function only
// depends on each event exposing: { type, quantity, costPerUnit,
// purchaseDate, recordedAt }.
//
// PRD §17 — worked example this implementation is built to match exactly:
//   20 × ₹50
//   10 × ₹55
//    5 × unknown cost
//   latestCost        = ₹55
//   averageKnownCost  = ₹51.67   (= (20×50 + 10×55) / 30)
//   knownCostQuantity = 30
//   totalQuantity     = 35
//
// The 5 unknown-cost units are excluded from the average entirely — they
// are not treated as ₹0, not backfilled with an estimate, and not silently
// dropped from `totalQuantity`. Estimating unknown cost using the latest
// known cost (PRD §18) is a DIFFERENT, explicitly-labelled operation left
// to a separate function (estimateCostForUnknownStock, below) — this file
// never blurs "recorded" and "estimated" together.
//
// Terminology note (carried over from docs/ARCHITECTURE.md): "average
// known cost" is a practical shop-management figure, not an accounting
// inventory-valuation method. This is a straightforward average over
// recorded-cost ADD events, not FIFO/LIFO/weighted-average-cost accounting.

import { isAfter } from '../shared/dates.js';

const STOCK_EVENT_TYPE_ADD = 'ADD';

/**
 * Is this event a stock addition that carries a recorded cost?
 * REMOVE events and cost-less ADD events (cost cleared or never entered,
 * per PRD §11.1) are excluded from every calculation in this file.
 *
 * @param {object} event
 * @returns {boolean}
 */
function isCostBearingAddition(event) {
  return (
    event &&
    event.type === STOCK_EVENT_TYPE_ADD &&
    typeof event.costPerUnit === 'number' &&
    Number.isFinite(event.costPerUnit) &&
    typeof event.quantity === 'number' &&
    Number.isFinite(event.quantity) &&
    event.quantity > 0
  );
}

/**
 * Sum of quantities across ALL stock-addition events, regardless of
 * whether cost was recorded. Used as `totalQuantity` in the projection —
 * distinct from `knownCostQuantity`, which only counts cost-bearing
 * additions.
 *
 * @param {object[]} additionEvents ADD-type stock events.
 * @returns {number}
 */
function sumAdditionQuantity(additionEvents) {
  return additionEvents.reduce((total, event) => {
    if (
      event &&
      event.type === STOCK_EVENT_TYPE_ADD &&
      typeof event.quantity === 'number' &&
      Number.isFinite(event.quantity)
    ) {
      return total + event.quantity;
    }
    return total;
  }, 0);
}

/**
 * The most recently recorded cost among cost-bearing addition events.
 *
 * "Most recent" is determined by `recordedAt` (when the addition was
 * entered into ShopStock), not by the event's position in the input array
 * or by `purchaseDate`. This matters because purchaseDate is user-editable
 * and backdatable (PRD §12), so two events with the same purchaseDate — or
 * a later purchaseDate entered after an earlier one — must still resolve
 * to "whichever was actually recorded most recently" for this figure to
 * mean what PRD §17 says it means ("Latest cost"). Callers must not rely
 * on array order.
 *
 * @param {object[]} costBearingEvents Already-filtered cost-bearing ADD events.
 * @returns {number|null} The latest known cost, or null if there are none.
 */
function findLatestCost(costBearingEvents) {
  if (costBearingEvents.length === 0) {
    return null;
  }
  let latest = costBearingEvents[0];
  for (const event of costBearingEvents.slice(1)) {
    if (isAfter(event.recordedAt, latest.recordedAt)) {
      latest = event;
    }
  }
  return latest.costPerUnit;
}

/**
 * Compute the cost projection for a product from its stock-addition
 * events.
 *
 * @param {object[]} stockEvents All stock events for a product (ADD and
 *   REMOVE both allowed in the input — REMOVE events are simply ignored
 *   here, since cost is only ever recorded on additions).
 * @returns {{
 *   latestCost: number|null,
 *   averageKnownCost: number|null,
 *   knownCostQuantity: number,
 *   totalQuantity: number
 * }}
 *   latestCost         — most recently recorded cost per unit, or null if
 *                         no addition has ever had a recorded cost.
 *   averageKnownCost    — quantity-weighted average cost across only the
 *                         cost-bearing additions, or null if there are none.
 *                         Never includes unknown-cost units in the divisor.
 *   knownCostQuantity   — total units added with a recorded cost.
 *   totalQuantity       — total units added, known-cost or not. Compare
 *                         against knownCostQuantity to tell a caller "this
 *                         average is based on N of M units" (PRD §17's UI
 *                         guidance).
 */
export function calculateCostProjection(stockEvents) {
  const events = Array.isArray(stockEvents) ? stockEvents : [];
  const additionEvents = events.filter((e) => e && e.type === STOCK_EVENT_TYPE_ADD);
  const costBearingEvents = additionEvents.filter(isCostBearingAddition);

  const totalQuantity = sumAdditionQuantity(additionEvents);
  const knownCostQuantity = costBearingEvents.reduce((sum, e) => sum + e.quantity, 0);

  const latestCost = findLatestCost(costBearingEvents);

  let averageKnownCost = null;
  if (knownCostQuantity > 0) {
    const totalKnownCostValue = costBearingEvents.reduce(
      (sum, e) => sum + e.quantity * e.costPerUnit,
      0
    );
    averageKnownCost = totalKnownCostValue / knownCostQuantity;
  }

  return {
    latestCost,
    averageKnownCost,
    knownCostQuantity,
    totalQuantity
  };
}

/**
 * Is the average-known-cost figure based on only PART of the current
 * inventory? True whenever some added units have no recorded cost.
 *
 * Used to drive the PRD §17 UI guidance: "Average cost: ₹51.67 — Based on
 * 30 of 35 units with recorded cost."
 *
 * @param {{ knownCostQuantity: number, totalQuantity: number }} projection
 *   The result of calculateCostProjection().
 * @returns {boolean}
 */
export function isCostProjectionPartial(projection) {
  if (!projection || typeof projection !== 'object') {
    return false;
  }
  return projection.totalQuantity > projection.knownCostQuantity;
}

/**
 * Estimate a cost for unknown-cost stock, using the latest known cost as
 * the estimate (PRD §18).
 *
 * This is a SEPARATE, explicitly-labelled operation from
 * calculateCostProjection() on purpose — the PRD is explicit that an
 * estimate must never be silently represented as a recorded historical
 * fact. Any caller using this value MUST label it as an estimate in the
 * UI; this function's return shape forces that by never calling the value
 * "cost" alone.
 *
 * @param {{ latestCost: number|null }} projection The result of
 *   calculateCostProjection().
 * @returns {{ estimatedCostPerUnit: number|null, isEstimate: true }}
 *   estimatedCostPerUnit is null if there is no known cost to estimate
 *   from at all (i.e. no addition has ever recorded a cost).
 */
export function estimateCostForUnknownStock(projection) {
  const latestCost =
    projection && typeof projection.latestCost === 'number' ? projection.latestCost : null;
  return {
    estimatedCostPerUnit: latestCost,
    isEstimate: true
  };
}
