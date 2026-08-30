// useSpeechRecognition -- the ONE place in this codebase that touches the
// browser's Web Speech API directly (mirrors how frontend/src/data/db/
// schema.js is the one place Dexie is touched, and productSearch.js is
// deliberately browser/React-independent).
//
// This hook is an INPUT ADAPTER ONLY (Phase 4D locked contract). It owns:
//   - capability detection (SpeechRecognition / webkitSpeechRecognition)
//   - the listening lifecycle (start/stop, single-utterance only)
//   - error -> human-readable message mapping
//   - safe cleanup on unmount
//
// It does NOT know about search, query state, debouncing, or the product
// domain in any way. The caller supplies an onResult(transcript) callback
// and decides what to do with the (already trimmed, already non-empty)
// transcript -- in practice, ProductListPage passes it straight into the
// existing setQuery().

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Map a SpeechRecognitionErrorEvent's `error` code to a short,
 * human-readable message. Never surfaces raw browser error codes to the
 * user (Phase 4D locked contract).
 *
 * @param {string} errorCode
 * @returns {string}
 */
function toReadableErrorMessage(errorCode) {
  switch (errorCode) {
    case 'no-speech':
      return "Couldn't hear anything. Try again.";
    case 'not-allowed':
    case 'service-not-allowed':
      return 'Microphone access was denied.';
    case 'network':
      return "Voice search isn't available right now.";
    default:
      return "Voice search couldn't start. Try again.";
  }
}

/**
 * @param {(transcript: string) => void} onResult Called with the trimmed,
 *   non-empty final transcript. Never called for an empty/whitespace-only
 *   result (Phase 4D locked contract: "if the resulting transcript is
 *   empty, do not overwrite the existing query" -- enforced here by
 *   simply not invoking the callback at all in that case, so the caller
 *   never has to guard against an empty string itself).
 * @returns {{
 *   isSupported: boolean,
 *   isListening: boolean,
 *   error: string|null,
 *   start: () => void,
 *   stop: () => void
 * }}
 */
export function useSpeechRecognition(onResult) {
  const SpeechRecognitionCtor =
    typeof window !== 'undefined'
      ? window.SpeechRecognition || window.webkitSpeechRecognition
      : undefined;

  const isSupported = Boolean(SpeechRecognitionCtor);

  const [isListening, setIsListening] = useState(false);
  const [error, setError] = useState(null);

  // Holds the live recognition instance across renders without causing
  // re-renders itself. Also doubles as the "is a recognition instance
  // currently active" guard, independent of React's isListening state
  // update timing, so start() called twice in quick succession can never
  // create two simultaneous instances (Phase 4D locked contract).
  const recognitionRef = useRef(null);

  // Tracks whether the component is still mounted so an in-flight
  // recognition callback (result/error/end firing after unmount) never
  // calls setState on an unmounted component.
  const isMountedRef = useRef(true);

  // Distinguishes "the user tapped the mic again to cancel" from "the
  // browser ended recognition on its own after a final result" -- both
  // fire the recognition's own `onend` event, but only the former must
  // be treated as silent cancellation rather than anything error-like.
  const userStoppedRef = useRef(false);

  // Always call the latest onResult without needing it in effect/callback
  // dependency arrays (it may be a fresh function identity on every
  // ProductListPage render).
  const onResultRef = useRef(onResult);
  useEffect(() => {
    onResultRef.current = onResult;
  }, [onResult]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      // Lifecycle cleanup on unmount (Phase 4D locked contract): stop any
      // in-flight recognition and drop the reference so it cannot linger
      // or fire further callbacks. abort() (rather than stop()) discards
      // any in-progress result immediately -- correct for unmount, where
      // there is no one left to receive a transcript.
      if (recognitionRef.current) {
        userStoppedRef.current = true;
        recognitionRef.current.abort();
        recognitionRef.current = null;
      }
    };
  }, []);

  const stop = useCallback(() => {
    if (!recognitionRef.current) return;
    userStoppedRef.current = true;
    recognitionRef.current.stop();
    // isListening/recognitionRef are cleared in the onend handler below,
    // once the browser actually confirms recognition has ended -- not
    // optimistically here -- so isListening always reflects the real
    // underlying recognition state.
  }, []);

  const start = useCallback(() => {
    if (!isSupported) return;
    // Calling start while already listening is a no-op (Phase 4D locked
    // contract) -- recognitionRef.current is the source of truth for
    // "an instance is active," independent of React state batching.
    if (recognitionRef.current) return;

    const recognition = new SpeechRecognitionCtor();
    recognition.continuous = false;
    recognition.interimResults = false;

    userStoppedRef.current = false;
    recognitionRef.current = recognition;
    setError(null);

    recognition.onstart = () => {
      if (!isMountedRef.current) return;
      setIsListening(true);
    };

    recognition.onresult = (event) => {
      const transcript = event.results?.[0]?.[0]?.transcript ?? '';
      const trimmed = transcript.trim();
      // Empty transcript never overwrites the existing query (Phase 4D
      // locked contract) -- simply skip invoking the callback.
      if (trimmed.length > 0) {
        onResultRef.current?.(trimmed);
      }
    };

    recognition.onerror = (event) => {
      if (!isMountedRef.current) return;
      // A user-initiated stop() can itself surface as an 'aborted' error
      // in some browsers -- that is cancellation, not a real error, and
      // must never be shown to the user (Phase 4D locked contract).
      if (userStoppedRef.current && event.error === 'aborted') {
        return;
      }
      setError(toReadableErrorMessage(event.error));
    };

    recognition.onend = () => {
      recognitionRef.current = null;
      if (!isMountedRef.current) return;
      setIsListening(false);
      // Do NOT auto-restart here under any circumstance (Phase 4D locked
      // contract: no automatic restart loops, no retry loops) -- onend
      // firing (for any reason: final result, user stop, or error) always
      // simply returns to idle.
    };

    recognition.start();
  }, [isSupported, SpeechRecognitionCtor]);

  return { isSupported, isListening, error, start, stop };
}
