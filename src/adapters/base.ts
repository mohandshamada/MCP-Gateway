import { EventEmitter } from 'events';
import type { ServerConfig } from '../utils/config-loader.js';
import { createChildLogger, type Logger } from '../utils/logger.js';

/**
 * Health status for an adapter
 */
export enum AdapterHealth {
  Healthy = 'healthy',
  Unhealthy = 'unhealthy',
  Starting = 'starting',
  Stopped = 'stopped',
}

/**
 * MCP Tool definition
 */
export interface MCPTool {
  name: string;
  description?: string;
  inputSchema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

/**
 * MCP Resource definition
 */
export interface MCPResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

/**
 * MCP Prompt definition
 */
export interface MCPPrompt {
  name: string;
  description?: string;
  arguments?: Array<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
}

/**
 * Server capabilities from initialize response
 */
export interface ServerCapabilities {
  tools?: MCPTool[];
  resources?: MCPResource[];
  prompts?: MCPPrompt[];
  serverInfo?: {
    name: string;
    version: string;
  };
}

/**
 * JSON-RPC request format
 */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: unknown;
}

/**
 * JSON-RPC response format
 */
export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

/**
 * JSON-RPC notification format
 */
export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

/**
 * Adapter statistics
 */
export interface AdapterStats {
  requestCount: number;
  errorCount: number;
  lastRequestTime?: Date;
  lastErrorTime?: Date;
  avgResponseTime: number;
  uptime: number;
}

/**
 * Abstract base class for MCP server adapters
 */
export abstract class BaseAdapter extends EventEmitter {
  protected readonly config: ServerConfig;
  protected readonly logger: Logger;
  protected health: AdapterHealth = AdapterHealth.Stopped;
  protected capabilities: ServerCapabilities | null = null;
  protected retryCount: number = 0;
  protected startTime: Date | null = null;
  protected stats: AdapterStats = {
    requestCount: 0,
    errorCount: 0,
    avgResponseTime: 0,
    uptime: 0,
  };

  private pendingRequests: Map<string | number, {
    resolve: (value: JsonRpcResponse) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
    startTime: number;
  }> = new Map();

  private nextRequestId: number = 1;

  /**
   * Retry state management (Issue #3: Retry Logic)
   */
  private retryState = {
    count: 0,
    maxRetries: 3,
    baseDelay: 1000, // 1 second
    maxDelay: 30000, // 30 seconds
    nextRetryTime: 0,
  };

  /**
   * Retry configuration (can be overridden per adapter)
   */
  protected retryConfig = {
    enabled: true,
    maxRetries: 3,
    baseDelay: 1000,
    maxDelay: 30000,
    jitterFraction: 0.1, // Add 10% random jitter
  };

  /**
   * Circuit breaker states (Issue #8: Circuit Breaker)
   */
  private circuitBreakerState: 'closed' | 'open' | 'half-open' = 'closed';

  /**
   * Circuit breaker configuration
   * - closed: Normal operation, all requests allowed
   * - open: Too many failures, requests rejected
   * - half-open: Timeout reached, testing recovery
   */
  private circuitBreakerConfig = {
    failureThreshold: 5,        // Consecutive failures before opening
    successThreshold: 2,        // Successful requests before closing from half-open
    timeout: 30000,             // Milliseconds before half-open attempt
    volumeThreshold: 10,        // Min requests before circuit can open
  };

  /**
   * Circuit breaker statistics
   */
  private circuitBreakerStats = {
    consecutiveFailures: 0,
    consecutiveSuccesses: 0,
    totalRequests: 0,
    lastStateChange: new Date(),
    lastOpenTime: 0,
  };

  constructor(config: ServerConfig) {
    super();
    this.config = config;
    this.logger = createChildLogger({
      serverId: config.id,
      transport: config.transport,
    });
  }

  /**
   * Get the server ID
   */
  get id(): string {
    return this.config.id;
  }

  /**
   * Get the current health status
   */
  getHealth(): AdapterHealth {
    return this.health;
  }

  /**
   * Get the server capabilities
   */
  getCapabilities(): ServerCapabilities | null {
    return this.capabilities;
  }

  /**
   * Get adapter statistics
   */
  getStats(): AdapterStats {
    return {
      ...this.stats,
      uptime: this.startTime ? Date.now() - this.startTime.getTime() : 0,
    };
  }

  /**
   * Get the server configuration
   */
  getConfig(): ServerConfig {
    return { ...this.config };
  }

  /**
   * Start the adapter and establish connection
   */
  abstract start(): Promise<void>;

  /**
   * Stop the adapter and clean up resources
   */
  abstract stop(): Promise<void>;

  /**
   * Check if the connection is alive
   */
  abstract isConnected(): boolean;

  /**
   * Send raw message to the server
   */
  protected abstract sendRaw(message: string): Promise<void>;

  /**
   * Generate a unique request ID
   */
  protected generateRequestId(): number {
    return this.nextRequestId++;
  }

  /**
   * Send a JSON-RPC request and wait for response
   * Includes circuit breaker checks for resilience
   */
  async sendRequest(method: string, params?: unknown): Promise<JsonRpcResponse> {
    // Circuit breaker check
    if (this.isCircuitBreakerOpen()) {
      this.recordFailure();
      this.logger.warn(
        {
          method,
          circuitState: this.circuitBreakerState,
        },
        'Request rejected: circuit breaker is open'
      );
      return {
        jsonrpc: '2.0',
        id: this.generateRequestId(),
        error: {
          code: -32603,
          message: 'Circuit breaker is open',
          data: {
            reason: 'Server is experiencing failures, requests rejected to prevent cascading failure',
            circuitBreakerStatus: this.getCircuitBreakerStatus(),
          },
        },
      };
    }

    const id = this.generateRequestId();
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    const timeout = this.config.timeout || 60000;

    return new Promise((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this.pendingRequests.delete(id);
        this.stats.errorCount++;
        this.stats.lastErrorTime = new Date();
        this.recordFailure(); // Track for circuit breaker
        reject(new Error(`Request timeout after ${timeout}ms for method: ${method}`));
      }, timeout);

      this.pendingRequests.set(id, {
        resolve,
        reject,
        timeout: timeoutHandle,
        startTime: Date.now(),
      });

      this.sendRaw(JSON.stringify(request) + '\n').catch((error) => {
        clearTimeout(timeoutHandle);
        this.pendingRequests.delete(id);
        this.stats.errorCount++;
        this.stats.lastErrorTime = new Date();
        this.recordFailure(); // Track for circuit breaker
        reject(error);
      });
    });
  }

  /**
   * Send a JSON-RPC notification (no response expected)
   */
  async sendNotification(method: string, params?: unknown): Promise<void> {
    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      params,
    };

    await this.sendRaw(JSON.stringify(notification) + '\n');
  }

  /**
   * Handle incoming message from the server
   */
  protected handleMessage(data: string): void {
    try {
      const message = JSON.parse(data);

      // Check if it's a response to a pending request
      if ('id' in message && message.id !== null) {
        const pending = this.pendingRequests.get(message.id);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pendingRequests.delete(message.id);

          // Update stats
          this.stats.requestCount++;
          this.stats.lastRequestTime = new Date();
          const responseTime = Date.now() - pending.startTime;
          this.stats.avgResponseTime =
            (this.stats.avgResponseTime * (this.stats.requestCount - 1) + responseTime) /
            this.stats.requestCount;

          if (message.error) {
            this.stats.errorCount++;
            this.stats.lastErrorTime = new Date();
            this.recordFailure(); // Track for circuit breaker
          } else {
            this.recordSuccess(); // Track for circuit breaker
          }

          pending.resolve(message as JsonRpcResponse);
          return;
        }
      }

      // It's a notification from the server
      if ('method' in message) {
        this.emit('notification', message);
      }
    } catch (error) {
      this.logger.error({ error, data }, 'Failed to parse message');
    }
  }

  /**
   * Initialize the MCP connection
   */
  async initialize(): Promise<ServerCapabilities> {
    this.logger.info('Initializing MCP connection');

    const response = await this.sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: {
        name: 'mcp-gateway',
        version: '1.0.0',
      },
    });

    if (response.error) {
      throw new Error(`Initialize failed: ${response.error.message}`);
    }

    const result = response.result as {
      protocolVersion: string;
      capabilities: {
        tools?: Record<string, unknown>;
        resources?: Record<string, unknown>;
        prompts?: Record<string, unknown>;
      };
      serverInfo?: {
        name: string;
        version: string;
      };
    };

    // Send initialized notification
    await this.sendNotification('notifications/initialized');

    // Fetch capabilities
    const capabilities: ServerCapabilities = {
      serverInfo: result.serverInfo,
    };

    // Fetch tools if supported
    if (result.capabilities.tools) {
      try {
        const toolsResponse = await this.sendRequest('tools/list');
        if (!toolsResponse.error && toolsResponse.result) {
          const toolsResult = toolsResponse.result as { tools: MCPTool[] };
          capabilities.tools = toolsResult.tools;
        }
      } catch (error) {
        this.logger.warn({ error }, 'Failed to fetch tools');
      }
    }

    // Fetch resources if supported
    if (result.capabilities.resources) {
      try {
        const resourcesResponse = await this.sendRequest('resources/list');
        if (!resourcesResponse.error && resourcesResponse.result) {
          const resourcesResult = resourcesResponse.result as { resources: MCPResource[] };
          capabilities.resources = resourcesResult.resources;
        }
      } catch (error) {
        this.logger.warn({ error }, 'Failed to fetch resources');
      }
    }

    // Fetch prompts if supported
    if (result.capabilities.prompts) {
      try {
        const promptsResponse = await this.sendRequest('prompts/list');
        if (!promptsResponse.error && promptsResponse.result) {
          const promptsResult = promptsResponse.result as { prompts: MCPPrompt[] };
          capabilities.prompts = promptsResult.prompts;
        }
      } catch (error) {
        this.logger.warn({ error }, 'Failed to fetch prompts');
      }
    }

    this.capabilities = capabilities;
    this.logger.info(
      {
        tools: capabilities.tools?.length || 0,
        resources: capabilities.resources?.length || 0,
        prompts: capabilities.prompts?.length || 0,
      },
      'MCP connection initialized'
    );

    return capabilities;
  }

  /**
   * Call a tool on the server
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<JsonRpcResponse> {
    return this.sendRequest('tools/call', { name, arguments: args });
  }

  /**
   * Read a resource from the server
   */
  async readResource(uri: string): Promise<JsonRpcResponse> {
    return this.sendRequest('resources/read', { uri });
  }

  /**
   * Get a prompt from the server
   */
  async getPrompt(name: string, args?: Record<string, unknown>): Promise<JsonRpcResponse> {
    return this.sendRequest('prompts/get', { name, arguments: args });
  }

  /**
   * Handle adapter error
   */
  protected handleError(error: Error): void {
    this.logger.error({ error }, 'Adapter error');
    this.health = AdapterHealth.Unhealthy;
    this.emit('error', error);
  }

  // =====================================================
  // Issue #3: Retry Logic with Exponential Backoff
  // =====================================================

  /**
   * Calculate exponential backoff delay with jitter
   * Formula: baseDelay * (2 ^ retryCount) + random jitter
   * @returns Delay in milliseconds, capped at maxDelay
   */
  private getBackoffDelay(): number {
    if (!this.retryConfig.enabled) {
      return 0;
    }

    // Exponential: 1s, 2s, 4s, 8s, 16s, 30s (max)
    const exponentialDelay = this.retryConfig.baseDelay *
      Math.pow(2, this.retryState.count);

    // Add random jitter (up to 10% of base delay)
    const jitter = Math.random() * (this.retryConfig.baseDelay * this.retryConfig.jitterFraction);

    // Calculate final delay, capped at max
    const totalDelay = exponentialDelay + jitter;
    const cappedDelay = Math.min(totalDelay, this.retryConfig.maxDelay);

    return Math.round(cappedDelay);
  }

  /**
   * Reset retry counter on successful operation
   */
  protected resetRetryState(): void {
    if (this.retryState.count > 0) {
      this.logger.debug(
        { previousRetryCount: this.retryState.count },
        'Retry state reset after successful operation'
      );
    }

    this.retryState = {
      count: 0,
      maxRetries: this.config.maxRetries || 3,
      baseDelay: this.retryConfig.baseDelay,
      maxDelay: this.retryConfig.maxDelay,
      nextRetryTime: 0,
    };
  }

  /**
   * Handle crash with automatic retry using exponential backoff
   * This method is called when the adapter encounters a fatal error
   *
   * Behavior:
   * - Retry with exponential backoff up to maxRetries times
   * - Each retry waits longer (1s, 2s, 4s, 8s, etc.)
   * - Give up after maxRetries and mark as unhealthy
   */
  protected async handleCrash(reason: string = 'unknown'): Promise<void> {
    this.health = AdapterHealth.Unhealthy;

    const maxRetries = this.retryConfig.maxRetries;

    if (this.retryState.count >= maxRetries) {
      this.logger.error(
        {
          maxRetries,
          attempts: this.retryState.count,
          reason,
        },
        `Adapter crashed: Maximum retries (${maxRetries}) exceeded, giving up`
      );
      this.emit('unhealthy', this.config.id);
      return;
    }

    // Calculate delay before retry
    const delay = this.getBackoffDelay();
    this.retryState.count++;
    this.retryState.nextRetryTime = Date.now() + delay;

    this.logger.warn(
      {
        retryCount: this.retryState.count,
        maxRetries,
        delayMs: delay,
        nextRetryTime: new Date(this.retryState.nextRetryTime).toISOString(),
        reason,
      },
      `Adapter crashed, scheduling retry #${this.retryState.count} after ${delay}ms`
    );

    // Schedule the retry
    setTimeout(() => {
      this.retryStart().catch((error) => {
        this.logger.error(
          {
            error: error instanceof Error ? error.message : String(error),
            retryCount: this.retryState.count,
          },
          'Retry start failed'
        );
        // Trigger another crash handling to continue retry loop
        this.handleCrash(`retry ${this.retryState.count} failed`);
      });
    }, delay);
  }

  /**
   * Start adapter with built-in error handling for retries
   * Private method used internally for retry mechanism
   */
  private async retryStart(): Promise<void> {
    try {
      this.logger.debug(
        { retryCount: this.retryState.count },
        'Attempting to start adapter'
      );
      await this.start();
      this.logger.info(
        { retryCount: this.retryState.count },
        'Adapter successfully started after retry'
      );
      this.resetRetryState();
    } catch (error) {
      this.logger.warn(
        {
          error: error instanceof Error ? error.message : String(error),
          retryCount: this.retryState.count,
        },
        'Retry start failed, will attempt again'
      );
      await this.handleCrash(`start failed on retry ${this.retryState.count}`);
    }
  }

  /**
   * Get current retry state (for monitoring/debugging)
   */
  getRetryState(): {
    count: number;
    maxRetries: number;
    baseDelay: number;
    maxDelay: number;
    nextRetryTime: number;
  } {
    return { ...this.retryState };
  }

  // =====================================================
  // Issue #8: Circuit Breaker Pattern
  // =====================================================

  /**
   * Check if request should be rejected due to open circuit
   *
   * States:
   * - Closed: Normal, requests pass through
   * - Open: Failing, requests rejected with error
   * - HalfOpen: After timeout, accepting limited requests to test recovery
   */
  private isCircuitBreakerOpen(): boolean {
    if (this.circuitBreakerState === 'closed') {
      return false; // Normal operation
    }

    if (this.circuitBreakerState === 'open') {
      // Check if timeout has elapsed for half-open attempt
      const timeSinceOpen = Date.now() - this.circuitBreakerStats.lastStateChange.getTime();
      if (timeSinceOpen >= this.circuitBreakerConfig.timeout) {
        this.logger.info(
          {
            timeSinceOpenMs: timeSinceOpen,
            timeoutMs: this.circuitBreakerConfig.timeout,
          },
          'Circuit breaker: timeout reached, attempting recovery (half-open state)'
        );
        this.circuitBreakerState = 'half-open';
        this.circuitBreakerStats.consecutiveSuccesses = 0;
        return false; // Allow request through
      }
      return true; // Still open, reject
    }

    // Half-open: allow requests through for testing
    return false;
  }

  /**
   * Record successful request
   * Used to track recovery and close circuit when stable
   */
  private recordSuccess(): void {
    this.circuitBreakerStats.totalRequests++;
    this.circuitBreakerStats.consecutiveFailures = 0;
    this.circuitBreakerStats.consecutiveSuccesses++;

    if (this.circuitBreakerState === 'half-open') {
      if (
        this.circuitBreakerStats.consecutiveSuccesses >=
        this.circuitBreakerConfig.successThreshold
      ) {
        this.logger.info(
          {
            consecutiveSuccesses: this.circuitBreakerStats.consecutiveSuccesses,
            threshold: this.circuitBreakerConfig.successThreshold,
          },
          'Circuit breaker: recovered successfully, closing circuit'
        );
        this.circuitBreakerState = 'closed';
        this.circuitBreakerStats.lastStateChange = new Date();
      }
    }
  }

  /**
   * Record failed request
   * Tracks failures and opens circuit when threshold exceeded
   */
  private recordFailure(): void {
    this.circuitBreakerStats.totalRequests++;
    this.circuitBreakerStats.consecutiveFailures++;
    this.circuitBreakerStats.consecutiveSuccesses = 0;

    // Only open circuit if minimum volume threshold met
    const volumeThresholdMet =
      this.circuitBreakerStats.totalRequests >= this.circuitBreakerConfig.volumeThreshold;

    const failureThresholdExceeded =
      this.circuitBreakerStats.consecutiveFailures >=
      this.circuitBreakerConfig.failureThreshold;

    if (volumeThresholdMet && failureThresholdExceeded) {
      if (this.circuitBreakerState !== 'open') {
        this.logger.error(
          {
            consecutiveFailures: this.circuitBreakerStats.consecutiveFailures,
            failureThreshold: this.circuitBreakerConfig.failureThreshold,
            totalRequests: this.circuitBreakerStats.totalRequests,
            volumeThreshold: this.circuitBreakerConfig.volumeThreshold,
          },
          'Circuit breaker: opening (too many failures)'
        );
        this.circuitBreakerState = 'open';
        this.circuitBreakerStats.lastStateChange = new Date();
        this.circuitBreakerStats.lastOpenTime = Date.now();
        this.health = AdapterHealth.Unhealthy;
      }
    }
  }

  /**
   * Get circuit breaker status for monitoring
   */
  getCircuitBreakerStatus(): {
    state: string;
    stats: {
      consecutiveFailures: number;
      consecutiveSuccesses: number;
      totalRequests: number;
      lastStateChange: Date;
    };
    config: {
      failureThreshold: number;
      successThreshold: number;
      timeout: number;
    };
  } {
    return {
      state: this.circuitBreakerState,
      stats: {
        consecutiveFailures: this.circuitBreakerStats.consecutiveFailures,
        consecutiveSuccesses: this.circuitBreakerStats.consecutiveSuccesses,
        totalRequests: this.circuitBreakerStats.totalRequests,
        lastStateChange: this.circuitBreakerStats.lastStateChange,
      },
      config: {
        failureThreshold: this.circuitBreakerConfig.failureThreshold,
        successThreshold: this.circuitBreakerConfig.successThreshold,
        timeout: this.circuitBreakerConfig.timeout,
      },
    };
  }

  /**
   * Cancel all pending requests
   */
  protected cancelPendingRequests(reason: string): void {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(reason));
      this.pendingRequests.delete(id);
    }
  }
}
