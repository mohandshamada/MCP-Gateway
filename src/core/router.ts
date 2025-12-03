import { getRegistry, type Registry } from './registry.js';
import {
  type JsonRpcResponse,
  type MCPTool,
  type MCPResource,
  type MCPPrompt,
  AdapterHealth,
} from '../adapters/index.js';
import { createChildLogger, generateCorrelationId, type Logger } from '../utils/logger.js';

/**
 * Namespace separator used in tool/resource/prompt names
 */
export const NAMESPACE_SEPARATOR = '__';

/**
 * Parsed namespaced name
 */
export interface ParsedName {
  serverId: string;
  originalName: string;
}

/**
 * Namespaced tool definition
 */
export interface NamespacedTool extends MCPTool {
  _serverId: string;
  _originalName: string;
}

/**
 * Namespaced resource definition
 */
export interface NamespacedResource extends MCPResource {
  _serverId: string;
  _originalUri: string;
}

/**
 * Namespaced prompt definition
 */
export interface NamespacedPrompt extends MCPPrompt {
  _serverId: string;
  _originalName: string;
}

/**
 * Router handles namespace management and request routing
 */
export class Router {
  private readonly registry: Registry;
  private readonly log: Logger;

  constructor(registry?: Registry) {
    this.registry = registry || getRegistry();
    this.log = createChildLogger({ component: 'router' });
  }

  /**
   * Create a namespaced name
   */
  createNamespacedName(serverId: string, name: string): string {
    return `${serverId}${NAMESPACE_SEPARATOR}${name}`;
  }

  /**
   * Parse a namespaced name
   */
  parseNamespacedName(namespacedName: string): ParsedName | null {
    const separatorIndex = namespacedName.indexOf(NAMESPACE_SEPARATOR);
    if (separatorIndex === -1) {
      return null;
    }

    const serverId = namespacedName.substring(0, separatorIndex);
    const originalName = namespacedName.substring(separatorIndex + NAMESPACE_SEPARATOR.length);

    if (!serverId || !originalName) {
      return null;
    }

    return { serverId, originalName };
  }

  /**
   * Create a namespaced URI for resources
   */
  createNamespacedUri(serverId: string, uri: string): string {
    // For URIs, we prefix with the server ID using a scheme-like format
    return `${serverId}://${uri}`;
  }

  /**
   * Parse a namespaced URI
   */
  parseNamespacedUri(namespacedUri: string): ParsedName | null {
    const match = namespacedUri.match(/^([a-zA-Z][a-zA-Z0-9_-]*):\/\/(.+)$/);
    if (!match) {
      return null;
    }

    return {
      serverId: match[1],
      originalName: match[2],
    };
  }

  /**
   * Get all namespaced tools from all healthy servers
   */
  getNamespacedTools(): NamespacedTool[] {
    const { tools } = this.registry.getMergedCapabilities();

    return tools.map(({ serverId, tool }) => ({
      ...tool,
      name: this.createNamespacedName(serverId, tool.name),
      _serverId: serverId,
      _originalName: tool.name,
    }));
  }

  /**
   * Get all namespaced resources from all healthy servers
   */
  getNamespacedResources(): NamespacedResource[] {
    const { resources } = this.registry.getMergedCapabilities();

    return resources.map(({ serverId, resource }) => ({
      ...resource,
      uri: this.createNamespacedUri(serverId, resource.uri),
      _serverId: serverId,
      _originalUri: resource.uri,
    }));
  }

  /**
   * Get all namespaced prompts from all healthy servers
   */
  getNamespacedPrompts(): NamespacedPrompt[] {
    const { prompts } = this.registry.getMergedCapabilities();

    return prompts.map(({ serverId, prompt }) => ({
      ...prompt,
      name: this.createNamespacedName(serverId, prompt.name),
      _serverId: serverId,
      _originalName: prompt.name,
    }));
  }

  /**
   * Route a tool call to the appropriate server
   */
  async routeToolCall(
    namespacedName: string,
    args: Record<string, unknown>
  ): Promise<JsonRpcResponse> {
    const correlationId = generateCorrelationId();
    const log = this.log.child({ correlationId, tool: namespacedName });

    log.info({ args }, 'Routing tool call');

    const parsed = this.parseNamespacedName(namespacedName);
    if (!parsed) {
      log.warn('Invalid namespaced tool name');
      return {
        jsonrpc: '2.0',
        id: 0,
        error: {
          code: -32602,
          message: `Invalid tool name format: ${namespacedName}. Expected format: serverId${NAMESPACE_SEPARATOR}toolName`,
        },
      };
    }

    const { serverId, originalName } = parsed;

    try {
      const adapter = await this.registry.getAdapterEnsureStarted(serverId);

      if (adapter.getHealth() !== AdapterHealth.Healthy) {
        log.warn({ serverId }, 'Target server is not healthy');
        return {
          jsonrpc: '2.0',
          id: 0,
          error: {
            code: -32000,
            message: `Server '${serverId}' is not healthy`,
          },
        };
      }

      log.debug({ serverId, originalName }, 'Forwarding tool call');
      const response = await adapter.callTool(originalName, args);

      log.info({ serverId, hasError: !!response.error }, 'Tool call completed');
      return response;
    } catch (error) {
      log.error({ error, serverId }, 'Tool call failed');
      return {
        jsonrpc: '2.0',
        id: 0,
        error: {
          code: -32000,
          message: error instanceof Error ? error.message : 'Unknown error',
          data: { correlationId },
        },
      };
    }
  }

  /**
   * Route a resource read to the appropriate server
   */
  async routeResourceRead(namespacedUri: string): Promise<JsonRpcResponse> {
    const correlationId = generateCorrelationId();
    const log = this.log.child({ correlationId, resource: namespacedUri });

    log.info('Routing resource read');

    const parsed = this.parseNamespacedUri(namespacedUri);
    if (!parsed) {
      log.warn('Invalid namespaced resource URI');
      return {
        jsonrpc: '2.0',
        id: 0,
        error: {
          code: -32602,
          message: `Invalid resource URI format: ${namespacedUri}. Expected format: serverId://originalUri`,
        },
      };
    }

    const { serverId, originalName: originalUri } = parsed;

    try {
      const adapter = await this.registry.getAdapterEnsureStarted(serverId);

      if (adapter.getHealth() !== AdapterHealth.Healthy) {
        log.warn({ serverId }, 'Target server is not healthy');
        return {
          jsonrpc: '2.0',
          id: 0,
          error: {
            code: -32000,
            message: `Server '${serverId}' is not healthy`,
          },
        };
      }

      log.debug({ serverId, originalUri }, 'Forwarding resource read');
      const response = await adapter.readResource(originalUri);

      log.info({ serverId, hasError: !!response.error }, 'Resource read completed');
      return response;
    } catch (error) {
      log.error({ error, serverId }, 'Resource read failed');
      return {
        jsonrpc: '2.0',
        id: 0,
        error: {
          code: -32000,
          message: error instanceof Error ? error.message : 'Unknown error',
          data: { correlationId },
        },
      };
    }
  }

  /**
   * Route a prompt get to the appropriate server
   */
  async routePromptGet(
    namespacedName: string,
    args?: Record<string, unknown>
  ): Promise<JsonRpcResponse> {
    const correlationId = generateCorrelationId();
    const log = this.log.child({ correlationId, prompt: namespacedName });

    log.info({ args }, 'Routing prompt get');

    const parsed = this.parseNamespacedName(namespacedName);
    if (!parsed) {
      log.warn('Invalid namespaced prompt name');
      return {
        jsonrpc: '2.0',
        id: 0,
        error: {
          code: -32602,
          message: `Invalid prompt name format: ${namespacedName}. Expected format: serverId${NAMESPACE_SEPARATOR}promptName`,
        },
      };
    }

    const { serverId, originalName } = parsed;

    try {
      const adapter = await this.registry.getAdapterEnsureStarted(serverId);

      if (adapter.getHealth() !== AdapterHealth.Healthy) {
        log.warn({ serverId }, 'Target server is not healthy');
        return {
          jsonrpc: '2.0',
          id: 0,
          error: {
            code: -32000,
            message: `Server '${serverId}' is not healthy`,
          },
        };
      }

      log.debug({ serverId, originalName }, 'Forwarding prompt get');
      const response = await adapter.getPrompt(originalName, args);

      log.info({ serverId, hasError: !!response.error }, 'Prompt get completed');
      return response;
    } catch (error) {
      log.error({ error, serverId }, 'Prompt get failed');
      return {
        jsonrpc: '2.0',
        id: 0,
        error: {
          code: -32000,
          message: error instanceof Error ? error.message : 'Unknown error',
          data: { correlationId },
        },
      };
    }
  }

  /**
   * Route a generic request to a specific server
   */
  async routeRequest(
    serverId: string,
    method: string,
    params?: unknown
  ): Promise<JsonRpcResponse> {
    const correlationId = generateCorrelationId();
    const log = this.log.child({ correlationId, serverId, method });

    log.info({ params }, 'Routing request');

    try {
      const adapter = await this.registry.getAdapterEnsureStarted(serverId);

      if (adapter.getHealth() !== AdapterHealth.Healthy) {
        log.warn('Target server is not healthy');
        return {
          jsonrpc: '2.0',
          id: 0,
          error: {
            code: -32000,
            message: `Server '${serverId}' is not healthy`,
          },
        };
      }

      const response = await adapter.sendRequest(method, params);

      log.info({ hasError: !!response.error }, 'Request completed');
      return response;
    } catch (error) {
      log.error({ error }, 'Request failed');
      return {
        jsonrpc: '2.0',
        id: 0,
        error: {
          code: -32000,
          message: error instanceof Error ? error.message : 'Unknown error',
          data: { correlationId },
        },
      };
    }
  }
}

// Singleton instance
let routerInstance: Router | null = null;

export function getRouter(): Router {
  if (!routerInstance) {
    routerInstance = new Router();
  }
  return routerInstance;
}

export function resetRouter(): void {
  routerInstance = null;
}
