import pino from 'pino';

export interface LogContext {
  correlationId?: string;
  serverId?: string;
  method?: string;
  transport?: string;
  [key: string]: unknown;
}

const isDevelopment = process.env.NODE_ENV !== 'production';

/**
 * Custom error serializer that properly captures error details
 */
function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      type: error.constructor.name,
      message: error.message,
      stack: error.stack,
      ...(error.cause ? { cause: serializeError(error.cause) } : {}),
      // Capture any additional properties on the error
      ...Object.fromEntries(
        Object.entries(error).filter(([key]) => !['message', 'stack', 'name'].includes(key))
      ),
    };
  }
  if (typeof error === 'object' && error !== null) {
    return error as Record<string, unknown>;
  }
  return { value: String(error) };
}

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: isDevelopment
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      }
    : undefined,
  serializers: {
    error: serializeError,
    err: serializeError,
  },
  formatters: {
    level: (label) => {
      return { level: label.toUpperCase() };
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  base: {
    service: 'mcp-gateway',
    version: process.env.npm_package_version || '1.0.0',
  },
});

/**
 * Create a child logger with additional context
 */
export function createChildLogger(context: LogContext): pino.Logger {
  return logger.child(context);
}

/**
 * Generate a unique correlation ID for request tracing
 */
export function generateCorrelationId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

export type Logger = pino.Logger;
