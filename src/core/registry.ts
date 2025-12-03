import { EventEmitter } from 'events';
import {
  BaseAdapter,
  AdapterHealth,
  StdioAdapter,
  SSEAdapter,
  type ServerCapabilities,
  type AdapterStats,
} from '../adapters/index.js';
import type { ServerConfig } from '../utils/config-loader.js';
import { logger, createChildLogger, type Logger } from '../utils/logger.js';

/**
 * Server entry in the registry
 */
export interface RegistryEntry {
  config: ServerConfig;
  adapter: BaseAdapter;
  health: AdapterHealth;
  capabilities: ServerCapabilities | null;
  stats: AdapterStats;
  lastHealthCheck?: Date;
}

/**
 * Registry status summary
 */
export interface RegistryStatus {
  totalServers: number;
  healthyServers: number;
  unhealthyServers: number;
  startingServers: number;
  stoppedServers: number;
  servers: Array<{
    id: string;
    transport: string;
    health: AdapterHealth;
    tools: number;
    resources: number;
    prompts: number;
    stats: AdapterStats;
  }>;
}

/**
 * Health transition record for tracking state changes
 */
interface HealthTransition {
  state: AdapterHealth;
  timestamp: Date;
  previousState?: AdapterHealth;
}

/**
 * Registry manages all MCP server adapters
 */
export class Registry extends EventEmitter {
  private readonly adapters: Map<string, BaseAdapter> = new Map();
  private readonly log: Logger;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private isShuttingDown: boolean = false;

  // Issue #5: Track health state transitions for graceful degradation
  private healthTransitions: Map<string, HealthTransition[]> = new Map();

  constructor() {
    super();
    this.log = createChildLogger({ component: 'registry' });
  }

  /**
   * Register a new server
   */
  async registerServer(config: ServerConfig): Promise<BaseAdapter> {
    if (this.adapters.has(config.id)) {
      throw new Error(`Server with ID '${config.id}' is already registered`);
    }

    this.log.info({ serverId: config.id, transport: config.transport }, 'Registering server');

    const adapter = this.createAdapter(config);

    // Set up event listeners
    adapter.on('connected', (id: string) => {
      this.emit('server:connected', id);
    });

    adapter.on('error', (error: Error) => {
      this.log.error({ error, serverId: config.id }, 'Server adapter error');
      this.emit('server:error', config.id, error);
    });

    adapter.on('unhealthy', (id: string) => {
      this.log.warn({ serverId: id }, 'Server marked as unhealthy');
      this.emit('server:unhealthy', id);
    });

    adapter.on('notification', (notification: unknown) => {
      this.emit('server:notification', config.id, notification);
    });

    this.adapters.set(config.id, adapter);

    // Start the adapter unless lazy loading is enabled
    if (!config.lazyLoad && config.enabled !== false) {
      try {
        await adapter.start();
      } catch (error) {
        this.log.error({ error, serverId: config.id }, 'Failed to start server on registration');
        // Don't throw - the server is registered but unhealthy
      }
    }

    this.emit('server:registered', config.id);
    return adapter;
  }

  /**
   * Create an adapter based on transport type
   */
  private createAdapter(config: ServerConfig): BaseAdapter {
    switch (config.transport) {
      case 'stdio':
        return new StdioAdapter(config);
      case 'sse':
        return new SSEAdapter(config);
      default:
        throw new Error(`Unknown transport type: ${config.transport}`);
    }
  }

  /**
   * Unregister and stop a server
   */
  async unregisterServer(serverId: string): Promise<void> {
    const adapter = this.adapters.get(serverId);
    if (!adapter) {
      throw new Error(`Server with ID '${serverId}' is not registered`);
    }

    this.log.info({ serverId }, 'Unregistering server');

    await adapter.stop();
    this.adapters.delete(serverId);

    this.emit('server:unregistered', serverId);
  }

  /**
   * Get an adapter by ID
   */
  getAdapter(serverId: string): BaseAdapter | undefined {
    return this.adapters.get(serverId);
  }

  /**
   * Get an adapter by ID, starting it if needed (lazy loading)
   */
  async getAdapterEnsureStarted(serverId: string): Promise<BaseAdapter> {
    const adapter = this.adapters.get(serverId);
    if (!adapter) {
      throw new Error(`Server '${serverId}' not found`);
    }

    if (!adapter.isConnected()) {
      this.log.info({ serverId }, 'Starting lazy-loaded adapter');
      await adapter.start();
    }

    return adapter;
  }

  /**
   * Check if a server is registered
   */
  hasServer(serverId: string): boolean {
    return this.adapters.has(serverId);
  }

  /**
   * Get all registered server IDs
   */
  getServerIds(): string[] {
    return Array.from(this.adapters.keys());
  }

  /**
   * Get all registered adapters
   */
  getAllAdapters(): Map<string, BaseAdapter> {
    return new Map(this.adapters);
  }

  /**
   * Get registry status
   */
  getStatus(): RegistryStatus {
    const servers = Array.from(this.adapters.entries()).map(([id, adapter]) => {
      const capabilities = adapter.getCapabilities();
      return {
        id,
        transport: adapter.getConfig().transport,
        health: adapter.getHealth(),
        tools: capabilities?.tools?.length || 0,
        resources: capabilities?.resources?.length || 0,
        prompts: capabilities?.prompts?.length || 0,
        stats: adapter.getStats(),
      };
    });

    const healthCounts = servers.reduce(
      (acc, server) => {
        switch (server.health) {
          case AdapterHealth.Healthy:
            acc.healthy++;
            break;
          case AdapterHealth.Unhealthy:
            acc.unhealthy++;
            break;
          case AdapterHealth.Starting:
            acc.starting++;
            break;
          case AdapterHealth.Stopped:
            acc.stopped++;
            break;
        }
        return acc;
      },
      { healthy: 0, unhealthy: 0, starting: 0, stopped: 0 }
    );

    return {
      totalServers: servers.length,
      healthyServers: healthCounts.healthy,
      unhealthyServers: healthCounts.unhealthy,
      startingServers: healthCounts.starting,
      stoppedServers: healthCounts.stopped,
      servers,
    };
  }

  /**
   * Get merged capabilities from all healthy servers
   */
  getMergedCapabilities(): {
    tools: Array<{ serverId: string; tool: NonNullable<ServerCapabilities['tools']>[0] }>;
    resources: Array<{ serverId: string; resource: NonNullable<ServerCapabilities['resources']>[0] }>;
    prompts: Array<{ serverId: string; prompt: NonNullable<ServerCapabilities['prompts']>[0] }>;
  } {
    const tools: Array<{ serverId: string; tool: NonNullable<ServerCapabilities['tools']>[0] }> = [];
    const resources: Array<{ serverId: string; resource: NonNullable<ServerCapabilities['resources']>[0] }> = [];
    const prompts: Array<{ serverId: string; prompt: NonNullable<ServerCapabilities['prompts']>[0] }> = [];

    for (const [serverId, adapter] of this.adapters) {
      if (adapter.getHealth() !== AdapterHealth.Healthy) {
        continue;
      }

      const capabilities = adapter.getCapabilities();
      if (!capabilities) {
        continue;
      }

      if (capabilities.tools) {
        for (const tool of capabilities.tools) {
          tools.push({ serverId, tool });
        }
      }

      if (capabilities.resources) {
        for (const resource of capabilities.resources) {
          resources.push({ serverId, resource });
        }
      }

      if (capabilities.prompts) {
        for (const prompt of capabilities.prompts) {
          prompts.push({ serverId, prompt });
        }
      }
    }

    return { tools, resources, prompts };
  }

  /**
   * Start health checks for all servers
   */
  startHealthChecks(intervalMs: number = 30000): void {
    if (this.healthCheckInterval) {
      return;
    }

    this.log.info({ intervalMs }, 'Starting health checks');

    this.healthCheckInterval = setInterval(() => {
      this.performHealthChecks().catch((error) => {
        this.log.error({ error }, 'Health check failed');
      });
    }, intervalMs);
  }

  /**
   * Stop health checks
   */
  stopHealthChecks(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
      this.log.info('Health checks stopped');
    }
  }

  /**
   * Perform health checks on all servers
   * Issue #5: Track health state transitions for graceful degradation
   */
  private async performHealthChecks(): Promise<void> {
    for (const [serverId, adapter] of this.adapters) {
      const previousHealth = adapter.getHealth();

      if (previousHealth === AdapterHealth.Stopped) {
        continue;
      }

      let currentHealth = previousHealth;

      try {
        if (!adapter.isConnected()) {
          this.log.warn({ serverId }, 'Health check: adapter not connected');
          currentHealth = AdapterHealth.Unhealthy;
        } else {
          // Send a ping request
          const response = await adapter.sendRequest('ping');
          if (response.error) {
            this.log.warn({ serverId, error: response.error }, 'Health check failed');
            currentHealth = AdapterHealth.Unhealthy;
          } else {
            currentHealth = AdapterHealth.Healthy;
          }
        }
      } catch (error) {
        this.log.warn({ serverId, error }, 'Health check error');
        currentHealth = AdapterHealth.Unhealthy;
      }

      // Issue #5: Track health transitions
      if (previousHealth !== currentHealth) {
        this.trackHealthTransition(serverId, currentHealth, previousHealth);
      }
    }
  }

  /**
   * Issue #5: Track health state transition
   */
  private trackHealthTransition(
    serverId: string,
    state: AdapterHealth,
    previousState?: AdapterHealth
  ): void {
    if (!this.healthTransitions.has(serverId)) {
      this.healthTransitions.set(serverId, []);
    }

    const transitions = this.healthTransitions.get(serverId)!;
    transitions.push({
      state,
      timestamp: new Date(),
      previousState,
    });

    // Keep only last 100 transitions per server
    if (transitions.length > 100) {
      transitions.shift();
    }

    this.log.info(
      {
        serverId,
        previousState,
        newState: state,
        transitionCount: transitions.length,
      },
      'Health state transition recorded'
    );

    // Emit event for subscribers
    this.emit('server:health-changed', serverId, state, previousState);
  }

  /**
   * Issue #5: Get health transition history for a server
   */
  getHealthTransitions(serverId: string): HealthTransition[] {
    return this.healthTransitions.get(serverId) || [];
  }

  /**
   * Register multiple servers from config
   */
  async registerServers(configs: ServerConfig[]): Promise<void> {
    const results = await Promise.allSettled(
      configs.map((config) => this.registerServer(config))
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const config = configs[i];
      
      if (result.status === 'rejected') {
        this.log.error(
          { serverId: config.id, error: result.reason },
          'Failed to register server'
        );
      }
    }
  }

  /**
   * Shutdown all servers
   */
  async shutdown(): Promise<void> {
    if (this.isShuttingDown) {
      return;
    }

    this.isShuttingDown = true;
    this.log.info('Shutting down registry');

    this.stopHealthChecks();

    const shutdownPromises = Array.from(this.adapters.entries()).map(
      async ([serverId, adapter]) => {
        try {
          await adapter.stop();
          this.log.info({ serverId }, 'Server stopped');
        } catch (error) {
          this.log.error({ serverId, error }, 'Error stopping server');
        }
      }
    );

    await Promise.all(shutdownPromises);
    this.adapters.clear();

    this.log.info('Registry shutdown complete');
    this.emit('shutdown');
  }
}

// Singleton instance
let registryInstance: Registry | null = null;

export function getRegistry(): Registry {
  if (!registryInstance) {
    registryInstance = new Registry();
  }
  return registryInstance;
}

export function resetRegistry(): void {
  if (registryInstance) {
    registryInstance.shutdown().catch((error) => {
      logger.error({ error }, 'Error resetting registry');
    });
    registryInstance = null;
  }
}
