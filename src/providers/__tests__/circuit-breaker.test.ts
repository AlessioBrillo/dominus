import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  CircuitBreaker,
  DEFAULT_CIRCUIT_BREAKER,
  USPTO_CIRCUIT_BREAKER,
  EUIPO_CIRCUIT_BREAKER,
  RDAP_CIRCUIT_BREAKER,
} from '../circuit-breaker.js';

describe('CircuitBreaker', () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    breaker = new CircuitBreaker();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('initial state', () => {
    it('starts closed', () => {
      expect(breaker.state).toBe('closed');
    });

    it('allows requests when closed', () => {
      expect(breaker.allow()).toBe(true);
    });
  });

  describe('onFailure', () => {
    it('opens circuit after failureThreshold failures', () => {
      const threshold = DEFAULT_CIRCUIT_BREAKER.failureThreshold;
      for (let i = 0; i < threshold - 1; i++) {
        breaker.onFailure();
        expect(breaker.state).toBe('closed');
      }
      breaker.onFailure();
      expect(breaker.state).toBe('open');
    });

    it('does not allow requests when open', () => {
      const threshold = DEFAULT_CIRCUIT_BREAKER.failureThreshold;
      for (let i = 0; i < threshold; i++) {
        breaker.onFailure();
      }
      expect(breaker.allow()).toBe(false);
    });

    it('resets failure count after window expires', () => {
      breaker.onFailure();
      breaker.onFailure();
      vi.advanceTimersByTime(60_001);
      breaker.onFailure();
      expect(breaker.state).toBe('closed');
    });

    it('transitions half-open to open on failure', () => {
      const threshold = DEFAULT_CIRCUIT_BREAKER.failureThreshold;
      for (let i = 0; i < threshold; i++) {
        breaker.onFailure();
      }
      vi.advanceTimersByTime(120_001);
      expect(breaker.allow()).toBe(true);
      expect(breaker.state).toBe('half-open');

      breaker.onFailure();
      expect(breaker.state).toBe('open');
    });
  });

  describe('onSuccess', () => {
    it('closes the circuit', () => {
      const threshold = DEFAULT_CIRCUIT_BREAKER.failureThreshold;
      for (let i = 0; i < threshold; i++) {
        breaker.onFailure();
      }
      expect(breaker.state).toBe('open');

      breaker.onSuccess();
      expect(breaker.state).toBe('closed');
      expect(breaker.allow()).toBe(true);
    });

    it('resets failure count', () => {
      breaker.onFailure();
      breaker.onFailure();

      breaker.onSuccess();
      breaker.onFailure();
      expect(breaker.state).toBe('closed');
    });

    it('closes a half-open circuit', () => {
      const threshold = DEFAULT_CIRCUIT_BREAKER.failureThreshold;
      for (let i = 0; i < threshold; i++) {
        breaker.onFailure();
      }
      vi.advanceTimersByTime(120_001);
      expect(breaker.allow()).toBe(true);
      expect(breaker.state).toBe('half-open');

      breaker.onSuccess();
      expect(breaker.state).toBe('closed');
    });
  });

  describe('half-open state', () => {
    it('transitions from open to half-open after cooldown', () => {
      const threshold = DEFAULT_CIRCUIT_BREAKER.failureThreshold;
      for (let i = 0; i < threshold; i++) {
        breaker.onFailure();
      }
      expect(breaker.allow()).toBe(false);

      vi.advanceTimersByTime(120_001);
      expect(breaker.allow()).toBe(true);
      expect(breaker.state).toBe('half-open');
    });

    it('allows only one request in half-open state', () => {
      const threshold = DEFAULT_CIRCUIT_BREAKER.failureThreshold;
      for (let i = 0; i < threshold; i++) {
        breaker.onFailure();
      }
      vi.advanceTimersByTime(120_001);
      expect(breaker.allow()).toBe(true);
      expect(breaker.state).toBe('half-open');
    });
  });

  describe('cooldownMs', () => {
    it('returns the configured cooldown', () => {
      expect(breaker.cooldownMs).toBe(DEFAULT_CIRCUIT_BREAKER.cooldownMs);
    });
  });

  describe('reset', () => {
    it('resets to closed state', () => {
      const threshold = DEFAULT_CIRCUIT_BREAKER.failureThreshold;
      for (let i = 0; i < threshold; i++) {
        breaker.onFailure();
      }
      expect(breaker.state).toBe('open');

      breaker.reset();
      expect(breaker.state).toBe('closed');
      expect(breaker.allow()).toBe(true);
    });
  });

  describe('policy constants', () => {
    it('has default policy', () => {
      expect(DEFAULT_CIRCUIT_BREAKER.failureThreshold).toBe(5);
      expect(DEFAULT_CIRCUIT_BREAKER.windowMs).toBe(60_000);
      expect(DEFAULT_CIRCUIT_BREAKER.cooldownMs).toBe(120_000);
    });

    it('has USPTO policy', () => {
      expect(USPTO_CIRCUIT_BREAKER.failureThreshold).toBe(3);
      expect(USPTO_CIRCUIT_BREAKER.windowMs).toBe(30_000);
      expect(USPTO_CIRCUIT_BREAKER.cooldownMs).toBe(60_000);
    });

    it('has EUIPO policy', () => {
      expect(EUIPO_CIRCUIT_BREAKER.failureThreshold).toBe(4);
      expect(EUIPO_CIRCUIT_BREAKER.windowMs).toBe(60_000);
      expect(EUIPO_CIRCUIT_BREAKER.cooldownMs).toBe(120_000);
    });

    it('has RDAP policy', () => {
      expect(RDAP_CIRCUIT_BREAKER.failureThreshold).toBe(10);
      expect(RDAP_CIRCUIT_BREAKER.windowMs).toBe(60_000);
      expect(RDAP_CIRCUIT_BREAKER.cooldownMs).toBe(30_000);
    });
  });

  describe('with custom policy', () => {
    it('uses custom failure threshold', () => {
      const custom = new CircuitBreaker({ failureThreshold: 1 });
      custom.onFailure();
      expect(custom.state).toBe('open');
    });

    it('uses custom cooldown', () => {
      const custom = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 5_000 });
      custom.onFailure();
      expect(custom.state).toBe('open');

      vi.advanceTimersByTime(5_001);
      expect(custom.allow()).toBe(true);
      expect(custom.state).toBe('half-open');
    });

    it('uses custom window for failure count reset', () => {
      const custom = new CircuitBreaker({ failureThreshold: 3, windowMs: 10_000 });
      custom.onFailure();
      custom.onFailure();
      vi.advanceTimersByTime(10_001);
      custom.onFailure();
      expect(custom.state).toBe('closed');
    });
  });
});
