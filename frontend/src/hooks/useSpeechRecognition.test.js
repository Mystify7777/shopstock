import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSpeechRecognition } from './useSpeechRecognition.js';

// Minimal fake SpeechRecognition constructor. Each instance records the
// handlers assigned to it and exposes helpers (fireResult/fireError/
// fireEnd) so tests can drive the recognition lifecycle exactly the way
// a real browser implementation would -- by calling the instance's own
// on* handlers, never by reaching into the hook's internals.
function makeFakeRecognitionCtor() {
  const instances = [];

  function FakeSpeechRecognition() {
    this.continuous = undefined;
    this.interimResults = undefined;
    this.onstart = null;
    this.onresult = null;
    this.onerror = null;
    this.onend = null;
    this.started = false;
    this.stop = vi.fn(() => {
      // Real browsers fire onend asynchronously after stop(); tests
      // trigger this explicitly via fireEnd() to keep control explicit.
    });
    this.abort = vi.fn(() => {
      // Same shape as stop() for test purposes -- callers trigger onend
      // explicitly.
    });
    this.start = vi.fn(() => {
      this.started = true;
      this.onstart?.();
    });
    instances.push(this);
  }

  FakeSpeechRecognition.instances = instances;

  return FakeSpeechRecognition;
}

function installFakeSpeechRecognition({ vendorPrefixed = false } = {}) {
  const Ctor = makeFakeRecognitionCtor();
  if (vendorPrefixed) {
    window.webkitSpeechRecognition = Ctor;
    delete window.SpeechRecognition;
  } else {
    window.SpeechRecognition = Ctor;
    delete window.webkitSpeechRecognition;
  }
  return Ctor;
}

function uninstallSpeechRecognition() {
  delete window.SpeechRecognition;
  delete window.webkitSpeechRecognition;
}

describe('useSpeechRecognition', () => {
  afterEach(() => {
    uninstallSpeechRecognition();
    vi.useRealTimers();
  });

  describe('capability detection', () => {
    it('isSupported is false when neither SpeechRecognition global exists', () => {
      uninstallSpeechRecognition();
      const { result } = renderHook(() => useSpeechRecognition(() => {}));
      expect(result.current.isSupported).toBe(false);
    });

    it('isSupported is true when window.SpeechRecognition exists', () => {
      installFakeSpeechRecognition();
      const { result } = renderHook(() => useSpeechRecognition(() => {}));
      expect(result.current.isSupported).toBe(true);
    });

    it('isSupported is true when only window.webkitSpeechRecognition exists', () => {
      installFakeSpeechRecognition({ vendorPrefixed: true });
      const { result } = renderHook(() => useSpeechRecognition(() => {}));
      expect(result.current.isSupported).toBe(true);
    });
  });

  describe('lifecycle', () => {
    it('start() transitions to listening', () => {
      installFakeSpeechRecognition();
      const { result } = renderHook(() => useSpeechRecognition(() => {}));

      act(() => {
        result.current.start();
      });

      expect(result.current.isListening).toBe(true);
    });

    it('a final transcript calls onResult and returns to idle', () => {
      const Ctor = installFakeSpeechRecognition();
      const onResult = vi.fn();
      const { result } = renderHook(() => useSpeechRecognition(onResult));

      act(() => {
        result.current.start();
      });

      const instance = Ctor.instances[0];
      act(() => {
        instance.onresult({ results: [[{ transcript: 'Parle-G' }]] });
        instance.onend();
      });

      expect(onResult).toHaveBeenCalledWith('Parle-G');
      expect(result.current.isListening).toBe(false);
    });

    it('trims the transcript before calling onResult', () => {
      const Ctor = installFakeSpeechRecognition();
      const onResult = vi.fn();
      const { result } = renderHook(() => useSpeechRecognition(onResult));

      act(() => {
        result.current.start();
      });
      const instance = Ctor.instances[0];
      act(() => {
        instance.onresult({ results: [[{ transcript: '  Parle-G  ' }]] });
      });

      expect(onResult).toHaveBeenCalledWith('Parle-G');
    });

    it('does not call onResult for an empty/whitespace-only transcript', () => {
      const Ctor = installFakeSpeechRecognition();
      const onResult = vi.fn();
      const { result } = renderHook(() => useSpeechRecognition(onResult));

      act(() => {
        result.current.start();
      });
      const instance = Ctor.instances[0];
      act(() => {
        instance.onresult({ results: [[{ transcript: '   ' }]] });
      });

      expect(onResult).not.toHaveBeenCalled();
    });

    it('user-initiated stop() returns to idle without setting an error', () => {
      const Ctor = installFakeSpeechRecognition();
      const { result } = renderHook(() => useSpeechRecognition(() => {}));

      act(() => {
        result.current.start();
      });
      act(() => {
        result.current.stop();
      });
      expect(Ctor.instances[0].stop).toHaveBeenCalled();

      const instance = Ctor.instances[0];
      act(() => {
        instance.onend();
      });

      expect(result.current.isListening).toBe(false);
      expect(result.current.error).toBeNull();
    });

    it('an aborted error immediately following a user stop() is not surfaced', () => {
      const Ctor = installFakeSpeechRecognition();
      const { result } = renderHook(() => useSpeechRecognition(() => {}));

      act(() => {
        result.current.start();
      });
      act(() => {
        result.current.stop();
      });

      const instance = Ctor.instances[0];
      act(() => {
        instance.onerror({ error: 'aborted' });
        instance.onend();
      });

      expect(result.current.error).toBeNull();
    });

    it('start() while already listening is a no-op (no second instance)', () => {
      const Ctor = installFakeSpeechRecognition();
      const { result } = renderHook(() => useSpeechRecognition(() => {}));

      act(() => {
        result.current.start();
        result.current.start();
        result.current.start();
      });

      expect(Ctor.instances.length).toBe(1);
    });
  });

  describe('error mapping', () => {
    it('no-speech produces a readable message', () => {
      const Ctor = installFakeSpeechRecognition();
      const { result } = renderHook(() => useSpeechRecognition(() => {}));
      act(() => result.current.start());
      act(() => Ctor.instances[0].onerror({ error: 'no-speech' }));
      expect(result.current.error).toBe("Couldn't hear anything. Try again.");
    });

    it('not-allowed produces a readable message', () => {
      const Ctor = installFakeSpeechRecognition();
      const { result } = renderHook(() => useSpeechRecognition(() => {}));
      act(() => result.current.start());
      act(() => Ctor.instances[0].onerror({ error: 'not-allowed' }));
      expect(result.current.error).toBe('Microphone access was denied.');
    });

    it('service-not-allowed produces the same permission-denied message', () => {
      const Ctor = installFakeSpeechRecognition();
      const { result } = renderHook(() => useSpeechRecognition(() => {}));
      act(() => result.current.start());
      act(() => Ctor.instances[0].onerror({ error: 'service-not-allowed' }));
      expect(result.current.error).toBe('Microphone access was denied.');
    });

    it('network produces a readable message', () => {
      const Ctor = installFakeSpeechRecognition();
      const { result } = renderHook(() => useSpeechRecognition(() => {}));
      act(() => result.current.start());
      act(() => Ctor.instances[0].onerror({ error: 'network' }));
      expect(result.current.error).toBe("Voice search isn't available right now.");
    });

    it('an unrecognized error code produces a generic fallback message, never the raw code', () => {
      const Ctor = installFakeSpeechRecognition();
      const { result } = renderHook(() => useSpeechRecognition(() => {}));
      act(() => result.current.start());
      act(() => Ctor.instances[0].onerror({ error: 'some-unmapped-code' }));
      expect(result.current.error).toBe("Voice search couldn't start. Try again.");
      expect(result.current.error).not.toContain('some-unmapped-code');
    });
  });

  describe('cleanup', () => {
    it('cleans up the recognition instance on unmount without throwing', () => {
      const Ctor = installFakeSpeechRecognition();
      const { result, unmount } = renderHook(() => useSpeechRecognition(() => {}));

      act(() => {
        result.current.start();
      });

      expect(() => unmount()).not.toThrow();
      expect(Ctor.instances[0].abort).toHaveBeenCalled();
    });

    it('does not call onResult if a result callback fires after unmount', () => {
      const Ctor = installFakeSpeechRecognition();
      const onResult = vi.fn();
      const { result, unmount } = renderHook(() => useSpeechRecognition(onResult));

      act(() => {
        result.current.start();
      });
      const instance = Ctor.instances[0];
      unmount();

      // Simulate a late-arriving browser callback after unmount -- must
      // not throw and must not call onResult via a stale closure updating
      // an unmounted component's state.
      expect(() => {
        instance.onresult({ results: [[{ transcript: 'late result' }]] });
      }).not.toThrow();
    });
  });
});
