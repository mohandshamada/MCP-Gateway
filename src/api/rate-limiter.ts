import type { FastifyRequest, FastifyReply, HookHandlerDoneFunction } from 'fastify';
import { createChildLogger, type Logger } from '../utils/logger.js';

/**
 * Rate limiter configuration
 */
export interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
}

/**
 * Rate limit entry for tracking requests
 */
interface RateLimitEntry {
  count: number;
  resetTime: number;
}

/**
 * Simple in-memory rate limiter
 */
class RateLimiter {
  private readonly store: Map<string, RateLimitEntry> = new Map();
  private readonly windowMs: number;
  private readonly maxRequests: number;
  private readonly log: Logger;
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(config: RateLimitConfig) {
    this.windowMs = config.windowMs;
    this.maxRequests = config.maxRequests;
    this.log = createChildLogger({ component: 'rate-limiter' });

    // Clean up expired entries periodically
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, this.windowMs);
  }

  /**
   * Check if a request should be allowed
   */
  isAllowed(key: string): { allowed: boolean; remaining: number; resetTime: number } {
    const now = Date.now();
    const entry = this.store.get(key);

    if (!entry || now >= entry.resetTime) {
      // New window
      const resetTime = now + this.windowMs;
      this.store.set(key, { count: 1, resetTime });
      return { allowed: true, remaining: this.maxRequests - 1, resetTime };
    }

    if (entry.count >= this.maxRequests) {
      // Rate limit exceeded
      return { allowed: false, remaining: 0, resetTime: entry.resetTime };
    }

    // Increment counter
    entry.count++;
    return { allowed: true, remaining: this.maxRequests - entry.count, resetTime: entry.resetTime };
  }

  /**
   * Clean up expired entries
   */
  private cleanup(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, entry] of this.store) {
      if (now >= entry.resetTime) {
        this.store.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      this.log.debug({ cleaned }, 'Cleaned up expired rate limit entries');
    }
  }

  /**
   * Get current statistics
   */
  getStats(): { activeClients: number; windowMs: number; maxRequests: number } {
    return {
      activeClients: this.store.size,
      windowMs: this.windowMs,
      maxRequests: this.maxRequests,
    };
  }

  /**
   * Shutdown the rate limiter
   */
  shutdown(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.store.clear();
  }
}

// Singleton instance
let rateLimiterInstance: RateLimiter | null = null;

/**
 * Initialize the rate limiter
 */
export function initializeRateLimiter(config: RateLimitConfig): void {
  if (rateLimiterInstance) {
    rateLimiterInstance.shutdown();
  }
  rateLimiterInstance = new RateLimiter(config);
}

/**
 * Get rate limiter statistics
 */
export function getRateLimiterStats(): { activeClients: number; windowMs: number; maxRequests: number } | null {
  return rateLimiterInstance?.getStats() ?? null;
}

/**
 * Shutdown the rate limiter
 */
export function shutdownRateLimiter(): void {
  if (rateLimiterInstance) {
    rateLimiterInstance.shutdown();
    rateLimiterInstance = null;
  }
}

/**
 * Extract client identifier from request
 */
function getClientKey(request: FastifyRequest): string {
  // Use a combination of IP and authorization token for better tracking
  const ip = request.ip || 'unknown';
  const token = request.headers.authorization?.substring(0, 20) || 'no-token';
  return `${ip}:${token}`;
}

/**
 * Rate limiting middleware
 */
export function rateLimitMiddleware(
  request: FastifyRequest,
  reply: FastifyReply,
  done: HookHandlerDoneFunction
): void {
  if (!rateLimiterInstance) {
    done();
    return;
  }

  // Skip rate limiting for health checks
  if (request.url === '/admin/health') {
    done();
    return;
  }

  const key = getClientKey(request);
  const { allowed, remaining, resetTime } = rateLimiterInstance.isAllowed(key);

  // Set rate limit headers
  reply.header('X-RateLimit-Limit', rateLimiterInstance.getStats().maxRequests);
  reply.header('X-RateLimit-Remaining', remaining);
  reply.header('X-RateLimit-Reset', Math.ceil(resetTime / 1000));

  if (!allowed) {
    const retryAfter = Math.ceil((resetTime - Date.now()) / 1000);
    reply.header('Retry-After', retryAfter);
    reply.status(429).send({
      error: 'Too Many Requests',
      message: `Rate limit exceeded. Try again in ${retryAfter} seconds.`,
      retryAfter,
    });
    return;
  }

  done();
}
