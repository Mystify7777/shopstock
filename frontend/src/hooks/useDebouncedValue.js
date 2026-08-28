// useDebouncedValue -- generic UI hook, not search-specific.
//
// Returns a debounced copy of `value`: it only updates once `value` has
// stayed unchanged for `delayMs` milliseconds. Search is this hook's first
// consumer, but nothing about its name or implementation is search-
// flavored -- any future feature needing "wait until the user stops
// typing/changing something" can reuse it directly.
//
// Pure with respect to React state/timing: it does not know what it is
// debouncing, does not call any service, and has no side effects beyond
// its own internal timer.

import { useEffect, useState } from 'react';

/**
 * @param {*} value    The value to debounce.
 * @param {number} delayMs How long the value must remain unchanged before
 *   the debounced copy updates.
 * @returns {*} The debounced value.
 */
export function useDebouncedValue(value, delayMs) {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedValue(value);
    }, delayMs);

    return () => {
      clearTimeout(timer);
    };
  }, [value, delayMs]);

  return debouncedValue;
}
