import { spawn, ChildProcess } from 'child_process';
import { BaseAdapter, AdapterHealth } from './base.js';
import type { ServerConfig } from '../utils/config-loader.js';
import { validateEnvironmentVariables, logEnvironmentSafely } from '../utils/config-loader.js';

/**
 * Adapter for MCP servers running as child processes via stdio
 */
export class StdioAdapter extends BaseAdapter {
  private process: ChildProcess | null = null;
  private messageBuffer: string = '';
  private isStarting: boolean = false;

  constructor(config: ServerConfig) {
    super(config);
    
    if (config.transport !== 'stdio') {
      throw new Error(`StdioAdapter requires transport 'stdio', got '${config.transport}'`);
    }
    
    if (!config.command) {
      throw new Error('StdioAdapter requires a command');
    }
  }

  /**
   * Check if the process is connected and running
   */
  isConnected(): boolean {
    return this.process !== null && 
           !this.process.killed && 
           this.process.exitCode === null;
  }

  /**
   * Start the child process
   */
  async start(): Promise<void> {
    if (this.isStarting) {
      this.logger.warn('Adapter is already starting');
      return;
    }

    if (this.isConnected()) {
      this.logger.warn('Adapter is already connected');
      return;
    }

    this.isStarting = true;
    this.health = AdapterHealth.Starting;

    try {
      await this.spawnProcess();

      // Issue #2: Timeout handling for initialization
      const initTimeout = this.config.timeout || 60000;
      const initPromise = this.initialize();
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Initialization timeout after ${initTimeout}ms`)), initTimeout)
      );

      await Promise.race([initPromise, timeoutPromise]);

      this.health = AdapterHealth.Healthy;
      this.startTime = new Date();
      this.retryCount = 0;
      this.resetRetryState(); // Issue #3: Reset retry state on successful start
      this.emit('connected', this.config.id);

      this.logger.info('Stdio adapter started successfully');
    } catch (error) {
      this.health = AdapterHealth.Unhealthy;
      this.logger.error({ error }, 'Failed to start stdio adapter');

      // Issue #2: Kill process if initialization fails
      if (this.process && !this.process.killed) {
        this.logger.warn('Killing stuck process due to initialization failure');
        this.process.kill('SIGKILL');
        this.process = null;
      }

      throw error;
    } finally {
      this.isStarting = false;
    }
  }

  /**
   * Spawn the child process
   */
  private async spawnProcess(): Promise<void> {
    return new Promise((resolve, reject) => {
      const command = this.config.command!;
      const args = this.config.args || [];

      // Issue #7: Validate and safely log environment variables
      let validatedEnv: Record<string, string> = {};
      if (this.config.env) {
        try {
          validatedEnv = validateEnvironmentVariables(this.config.env);
          this.logger.debug(
            { env: logEnvironmentSafely(validatedEnv) },
            'Validated environment variables'
          );
        } catch (error) {
          this.logger.error(
            { error: error instanceof Error ? error.message : String(error) },
            'Environment variable validation failed'
          );
          reject(error);
          return;
        }
      }

      const env = {
        ...process.env,
        ...validatedEnv,
      };

      this.logger.info({ command, args }, 'Spawning child process');

      this.process = spawn(command, args, {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
      });

      // Set up stdout handler for JSON-RPC messages
      this.process.stdout!.on('data', (data: Buffer) => {
        this.handleStdout(data);
      });

      // Set up stderr handler for logging
      this.process.stderr!.on('data', (data: Buffer) => {
        const message = data.toString().trim();
        if (message) {
          this.logger.warn({ stderr: message }, 'Child process stderr');
        }
      });

      // Handle process exit
      this.process.on('exit', (code, signal) => {
        this.logger.warn({ code, signal }, 'Child process exited');
        this.cancelPendingRequests('Process exited');
        
        if (this.health === AdapterHealth.Healthy) {
          // Unexpected exit, try to recover
          this.handleCrash().catch((error) => {
            this.logger.error({ error }, 'Failed to handle crash');
          });
        }
      });

      // Handle process error
      this.process.on('error', (error) => {
        this.logger.error({ error }, 'Child process error');
        reject(error);
      });

      // Handle spawn event
      this.process.on('spawn', () => {
        this.logger.info('Child process spawned');
        // Give the process a moment to initialize
        setTimeout(resolve, 100);
      });

      // Timeout for spawn
      const timeout = setTimeout(() => {
        reject(new Error('Process spawn timeout'));
      }, 10000);

      this.process.once('spawn', () => {
        clearTimeout(timeout);
      });
    });
  }

  /**
   * Handle stdout data from the child process
   */
  private handleStdout(data: Buffer): void {
    this.messageBuffer += data.toString();

    // Process complete messages (newline-delimited JSON)
    const lines = this.messageBuffer.split('\n');
    
    // Keep the last incomplete line in the buffer
    this.messageBuffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) {
        this.handleMessage(trimmed);
      }
    }
  }

  /**
   * Send raw message to the child process
   */
  protected async sendRaw(message: string): Promise<void> {
    if (!this.isConnected()) {
      throw new Error('Process is not connected');
    }

    return new Promise((resolve, reject) => {
      this.process!.stdin!.write(message, (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Stop the child process
   */
  async stop(): Promise<void> {
    if (!this.process) {
      return;
    }

    this.logger.info('Stopping stdio adapter');
    this.health = AdapterHealth.Stopped;

    // Cancel pending requests
    this.cancelPendingRequests('Adapter stopped');

    // Try graceful shutdown first
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        if (this.process && !this.process.killed) {
          this.logger.warn('Forcefully killing child process');
          this.process.kill('SIGKILL');
        }
        resolve();
      }, 5000);

      if (this.process && !this.process.killed) {
        this.process.once('exit', () => {
          clearTimeout(timeout);
          resolve();
        });

        // Send SIGTERM for graceful shutdown
        this.process.kill('SIGTERM');
      } else {
        clearTimeout(timeout);
        resolve();
      }

      this.process = null;
    });
  }

  /**
   * Restart the adapter
   */
  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }
}
