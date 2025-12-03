import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  initializeRateLimiter,
  getRateLimiterStats,
  shutdownRateLimiter,
} from '../src/api/rate-limiter.js';

describe('Rate Limiter', () => {
  beforeEach(() => {
    // Reset the rate limiter before each test
    shutdownRateLimiter();
  });

  afterEach(() => {
    // Clean up after each test
    shutdownRateLimiter();
  });

  describe('initialization', () => {
    it('initializes with provided config', () => {
      initializeRateLimiter({ windowMs: 30000, maxRequests: 50 });

      const stats = getRateLimiterStats();
      expect(stats).not.toBeNull();
      expect(stats?.windowMs).toBe(30000);
      expect(stats?.maxRequests).toBe(50);
      expect(stats?.activeClients).toBe(0);
    });

    it('returns null stats when not initialized', () => {
      const stats = getRateLimiterStats();
      expect(stats).toBeNull();
    });

    it('re-initializes when called again', () => {
      initializeRateLimiter({ windowMs: 10000, maxRequests: 10 });
      initializeRateLimiter({ windowMs: 20000, maxRequests: 20 });

      const stats = getRateLimiterStats();
      expect(stats?.windowMs).toBe(20000);
      expect(stats?.maxRequests).toBe(20);
    });
  });

  describe('shutdown', () => {
    it('cleans up after shutdown', () => {
      initializeRateLimiter({ windowMs: 10000, maxRequests: 10 });
      shutdownRateLimiter();

      const stats = getRateLimiterStats();
      expect(stats).toBeNull();
    });

    it('handles shutdown when not initialized', () => {
      // Should not throw
      expect(() => shutdownRateLimiter()).not.toThrow();
    });
  });
});
