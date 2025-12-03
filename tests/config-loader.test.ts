import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GatewayConfigSchema, ServerConfigSchema, loadAuthTokens } from '../src/utils/config-loader.js';

describe('ServerConfigSchema', () => {
  it('validates a valid stdio server config', () => {
    const config = {
      id: 'test-server',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-test'],
    };

    const result = ServerConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.id).toBe('test-server');
      expect(result.data.transport).toBe('stdio');
      expect(result.data.enabled).toBe(true);
      expect(result.data.lazyLoad).toBe(false);
      expect(result.data.timeout).toBe(60000);
      expect(result.data.maxRetries).toBe(3);
    }
  });

  it('validates a valid sse server config', () => {
    const config = {
      id: 'remote-server',
      transport: 'sse',
      url: 'https://example.com/sse',
    };

    const result = ServerConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.id).toBe('remote-server');
      expect(result.data.transport).toBe('sse');
      expect(result.data.url).toBe('https://example.com/sse');
    }
  });

  it('rejects stdio config without command', () => {
    const config = {
      id: 'test-server',
      transport: 'stdio',
    };

    const result = ServerConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  it('rejects sse config without url', () => {
    const config = {
      id: 'test-server',
      transport: 'sse',
    };

    const result = ServerConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  it('rejects invalid server ID format', () => {
    const config = {
      id: '123-invalid', // Must start with letter
      transport: 'stdio',
      command: 'test',
    };

    const result = ServerConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  it('accepts server ID with valid characters', () => {
    const config = {
      id: 'my_server-123',
      transport: 'stdio',
      command: 'test',
    };

    const result = ServerConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });
});

describe('GatewayConfigSchema', () => {
  it('validates minimal gateway config', () => {
    const config = {
      gateway: {},
      auth: {},
      servers: [],
    };

    const result = GatewayConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.gateway.host).toBe('127.0.0.1');
      expect(result.data.gateway.port).toBe(3000);
      expect(result.data.auth.enabled).toBe(true);
      expect(result.data.auth.tokens).toEqual([]);
      expect(result.data.settings.sessionTimeout).toBe(3600000);
      expect(result.data.settings.enableRateLimiting).toBe(true);
    }
  });

  it('validates full gateway config', () => {
    const config = {
      gateway: {
        host: '0.0.0.0',
        port: 8080,
        name: 'Test Gateway',
        version: '2.0.0',
      },
      auth: {
        enabled: true,
        tokens: ['token1', 'token2'],
      },
      servers: [
        {
          id: 'test',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', 'test'],
        },
      ],
      settings: {
        requestTimeout: 30000,
        enableHealthChecks: false,
        sessionTimeout: 7200000,
        enableRateLimiting: false,
      },
    };

    const result = GatewayConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.gateway.host).toBe('0.0.0.0');
      expect(result.data.gateway.port).toBe(8080);
      expect(result.data.auth.tokens).toHaveLength(2);
      expect(result.data.servers).toHaveLength(1);
      expect(result.data.settings.sessionTimeout).toBe(7200000);
      expect(result.data.settings.enableRateLimiting).toBe(false);
    }
  });

  it('allows empty tokens array', () => {
    const config = {
      gateway: {},
      auth: { enabled: false, tokens: [] },
      servers: [],
    };

    const result = GatewayConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  it('validates rate limit settings', () => {
    const config = {
      gateway: {},
      auth: {},
      servers: [],
      settings: {
        rateLimit: {
          windowMs: 30000,
          maxRequests: 50,
        },
      },
    };

    const result = GatewayConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.settings.rateLimit.windowMs).toBe(30000);
      expect(result.data.settings.rateLimit.maxRequests).toBe(50);
    }
  });
});

describe('loadAuthTokens', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('loads tokens from config', () => {
    const config = {
      gateway: { host: '127.0.0.1', port: 3000, name: 'Test', version: '1.0.0' },
      auth: { enabled: true, tokens: ['token1', 'token2'] },
      servers: [],
      settings: {
        requestTimeout: 60000,
        enableHealthChecks: true,
        healthCheckInterval: 30000,
        enableHotReload: true,
        sessionTimeout: 3600000,
        enableRateLimiting: true,
        rateLimit: { windowMs: 60000, maxRequests: 100 },
      },
    };

    const tokens = loadAuthTokens(config);
    expect(tokens).toEqual(['token1', 'token2']);
  });

  it('loads tokens from MCP_GATEWAY_TOKEN env var', () => {
    process.env.MCP_GATEWAY_TOKEN = 'env-token';

    const config = {
      gateway: { host: '127.0.0.1', port: 3000, name: 'Test', version: '1.0.0' },
      auth: { enabled: true, tokens: [] },
      servers: [],
      settings: {
        requestTimeout: 60000,
        enableHealthChecks: true,
        healthCheckInterval: 30000,
        enableHotReload: true,
        sessionTimeout: 3600000,
        enableRateLimiting: true,
        rateLimit: { windowMs: 60000, maxRequests: 100 },
      },
    };

    const tokens = loadAuthTokens(config);
    expect(tokens).toContain('env-token');
  });

  it('loads tokens from MCP_GATEWAY_TOKENS env var (comma-separated)', () => {
    process.env.MCP_GATEWAY_TOKENS = 'env1, env2, env3';

    const config = {
      gateway: { host: '127.0.0.1', port: 3000, name: 'Test', version: '1.0.0' },
      auth: { enabled: true, tokens: [] },
      servers: [],
      settings: {
        requestTimeout: 60000,
        enableHealthChecks: true,
        healthCheckInterval: 30000,
        enableHotReload: true,
        sessionTimeout: 3600000,
        enableRateLimiting: true,
        rateLimit: { windowMs: 60000, maxRequests: 100 },
      },
    };

    const tokens = loadAuthTokens(config);
    expect(tokens).toContain('env1');
    expect(tokens).toContain('env2');
    expect(tokens).toContain('env3');
  });

  it('deduplicates tokens from all sources', () => {
    process.env.MCP_GATEWAY_TOKEN = 'shared';
    process.env.MCP_GATEWAY_TOKENS = 'env1, shared';

    const config = {
      gateway: { host: '127.0.0.1', port: 3000, name: 'Test', version: '1.0.0' },
      auth: { enabled: true, tokens: ['shared', 'config1'] },
      servers: [],
      settings: {
        requestTimeout: 60000,
        enableHealthChecks: true,
        healthCheckInterval: 30000,
        enableHotReload: true,
        sessionTimeout: 3600000,
        enableRateLimiting: true,
        rateLimit: { windowMs: 60000, maxRequests: 100 },
      },
    };

    const tokens = loadAuthTokens(config);
    const sharedCount = tokens.filter((t) => t === 'shared').length;
    expect(sharedCount).toBe(1);
    expect(tokens).toHaveLength(3); // shared, config1, env1
  });
});
