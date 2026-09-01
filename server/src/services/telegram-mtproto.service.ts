import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigRepository } from 'src/repositories/config.repository';
import { LoggingRepository } from 'src/repositories/logging.repository';
import {
  TelegramStorageConfig,
  TelegramAccountConfig,
  DEFAULT_TELEGRAM_CONFIG,
} from 'src/config/telegram.config';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

// Gramjs imports - these will be available after installing the package
// For now, we use dynamic imports to avoid build errors if gramjs is not installed
let Api: any;
let TelegramClient: any;
let gramSessions: any;
let gramLogger: any;

/**
 * Telegram MTProto Client Service
 * Handles connection to Telegram servers via MTProto protocol
 * Uses gramjs library for Node.js MTProto implementation
 */
@Injectable()
export class TelegramMtprotoService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramMtprotoService.name);
  private config: TelegramStorageConfig = DEFAULT_TELEGRAM_CONFIG;
  private connected = false;
  private currentAccountIndex = 0;
  private clients: Map<string, any> = new Map();

  constructor(
    private configRepository: ConfigRepository,
    private loggingRepository: LoggingRepository,
  ) {
    this.loggingRepository.setContext(TelegramMtprotoService.name);
    this.loadConfig();
  }

  async onModuleInit() {
    // Load gramjs dynamically
    try {
      const gramjs = await import('telegram');

      Api = gramjs.Api;
      TelegramClient = gramjs.TelegramClient;
      gramSessions = gramjs.sessions;
      gramLogger = gramjs.Logger;

      this.logger.log('Gramjs library loaded successfully');
    } catch (error) {
      this.logger.warn('Gramjs library not available, Telegram storage disabled');
      this.config.enabled = false;
      return;
    }

    if (this.config.enabled) {
      await this.initialize();
    }
  }

  async onModuleDestroy() {
    await this.disconnect();
  }

  private loadConfig(): void {
    // Load Telegram config from environment variables
    const apiId = parseInt(process.env.TELEGRAM_API_ID || '0', 10);
    const apiHash = process.env.TELEGRAM_API_HASH || '';
    const chatId = process.env.TELEGRAM_CHAT_ID || '';
    const sessionPath = process.env.TELEGRAM_SESSION_PATH || '/config/telegram.session';

    if (apiId && apiHash && chatId) {
      this.config = {
        ...DEFAULT_TELEGRAM_CONFIG,
        enabled: process.env.TELEGRAM_STORAGE_ENABLED === 'true',
        accounts: [
          {
            id: 'primary',
            apiId,
            apiHash,
            sessionPath,
            chatId: BigInt(chatId),
            label: 'Primary Account',
          },
        ],
        encryptionEnabled: process.env.TELEGRAM_ENCRYPTION_ENABLED !== 'false',
        cacheSizeMb: parseInt(process.env.TELEGRAM_CACHE_SIZE_MB || '5120', 10),
        cacheTtlHours: parseInt(process.env.TELEGRAM_CACHE_TTL_HOURS || '168', 10),
        concurrentUploads: parseInt(process.env.TELEGRAM_MAX_CONCURRENT_UPLOADS || '4', 10),
        concurrentDownloads: parseInt(process.env.TELEGRAM_MAX_CONCURRENT_DOWNLOADS || '8', 10),
        uploadDelayMs: parseInt(process.env.TELEGRAM_UPLOAD_DELAY_MS || '1000', 10),
      };

      // Load additional accounts if configured
      this.loadAdditionalAccounts();

      this.logger.log(`Telegram MTProto config loaded. Enabled: ${this.config.enabled}`);
    }
  }

  private loadAdditionalAccounts(): void {
    const accountsStr = process.env.TELEGRAM_ACCOUNTS;
    if (!accountsStr) return;

    const accountIds = accountsStr.split(',').map((a) => a.trim());
    for (const accountId of accountIds) {
      if (accountId === 'primary') continue;

      const apiId = parseInt(process.env[`TELEGRAM_${accountId.toUpperCase()}_API_ID`] || '0', 10);
      const apiHash = process.env[`TELEGRAM_${accountId.toUpperCase()}_API_HASH`] || '';
      const sessionPath = process.env[`TELEGRAM_${accountId.toUpperCase()}_SESSION`] || `/config/session-${accountId}`;
      const chatId = process.env[`TELEGRAM_${accountId.toUpperCase()}_CHAT_ID`] || '';

      if (apiId && apiHash && chatId) {
        this.config.accounts.push({
          id: accountId,
          apiId,
          apiHash,
          sessionPath,
          chatId: BigInt(chatId),
          label: `${accountId.charAt(0).toUpperCase() + accountId.slice(1)} Account`,
        });
      }
    }
  }

  /**
   * Initialize connection to Telegram using gramjs
   */
  async initialize(): Promise<void> {
    if (!this.config.enabled) {
      this.logger.warn('Telegram storage is disabled');
      return;
    }

    if (!TelegramClient || !gramSessions) {
      this.logger.error('Gramjs library not loaded');
      return;
    }

    try {
      this.logger.log('Initializing Telegram MTProto connections...');

      for (const account of this.config.accounts) {
        await this.connectAccount(account);
      }

      this.connected = true;
      this.logger.log(`Telegram MTProto connection established for ${this.config.accounts.length} account(s)`);
    } catch (error) {
      this.logger.error('Failed to initialize Telegram MTProto connection', error);
      throw error;
    }
  }

  private async connectAccount(account: TelegramAccountConfig): Promise<void> {
    try {
      const sessionDir = path.dirname(account.sessionPath);
      await fs.mkdir(sessionDir, { recursive: true });

      const session = new gramSessions.StoreSession(account.sessionPath);
      const client = new TelegramClient(
        session,
        account.apiId,
        account.apiHash,
        {
          connectionRetries: 5,
          retryDelay: 1000,
          autoReconnect: true,
          useIPV6: false,
          logLevel: gramLogger.WARNING,
        }
      );

      // Check if already authorized
      await client.connect();
      const me = await client.getMe();

      if (me) {
        this.logger.log(`Connected to Telegram as ${me.firstName} (${me.id})`);
        this.clients.set(account.id, client);
      } else {
        this.logger.warn(`Account ${account.label} not authorized, skipping`);
        await client.disconnect();
      }
    } catch (error) {
      this.logger.error(`Failed to connect account ${account.label}: ${error}`);
    }
  }

  /**
   * Get client for current account
   */
  private getClient(accountId?: string): any {
    const id = accountId || this.getCurrentAccount()?.id;
    if (!id) {
      throw new Error('No Telegram account configured');
    }

    const client = this.clients.get(id);
    if (!client) {
      throw new Error(`No client found for account ${id}`);
    }

    return client;
  }

  /**
   * Get current account for operations
   * Supports round-robin rotation for rate limiting
   */
  getCurrentAccount(): TelegramAccountConfig | undefined {
    return this.config.accounts[this.currentAccountIndex];
  }

  /**
   * Rotate to next account (for rate limiting)
   * Skips accounts that are rate-limited or disconnected
   */
  rotateAccount(): void {
    if (this.config.accounts.length <= 1) return;

    const startIndex = this.currentAccountIndex;
    let attempts = 0;

    do {
      this.currentAccountIndex = (this.currentAccountIndex + 1) % this.config.accounts.length;
      const account = this.getCurrentAccount();

      // Check if account has a connected client
      if (account && this.clients.has(account.id)) {
        this.logger.debug(`Rotated to account: ${account.label}`);
        return;
      }

      attempts++;
    } while (attempts < this.config.accounts.length);

    this.logger.warn('All accounts unavailable, keeping current index');
  }

  /**
   * Get all accounts with their status
   */
  getAccountsStatus(): Array<{ id: string; label: string; status: 'connected' | 'disconnected'; rateLimitRemaining: number }> {
    return this.config.accounts.map((account) => ({
      id: account.id,
      label: account.label,
      status: this.clients.has(account.id) ? 'connected' as const : 'disconnected' as const,
      rateLimitRemaining: 50, // Placeholder - actual rate limit tracking would need API
    }));
  }

  /**
   * Upload file to Telegram
   * @param fileBuffer - File content
   * @param filename - Original filename
   * @param chatId - Target chat ID
   * @returns Telegram file info
   */
  async uploadFile(
    fileBuffer: Buffer,
    filename: string,
    chatId?: bigint,
  ): Promise<{ messageId: number; fileId: string; fileSize: number }> {
    const account = this.getCurrentAccount();
    if (!account) {
      throw new Error('No Telegram account configured');
    }

    const client = this.getClient(account.id);
    const targetChatId = chatId || account.chatId;

    this.logger.log(`Uploading file ${filename} (${fileBuffer.length} bytes) to chat ${targetChatId}`);

    try {
      // Upload file to Telegram
      const uploadedFile = await client.uploadFile({
        file: fileBuffer,
        workers: 1,
      });

      // Send message with file
      const result = await client.sendMessage(targetChatId.toString(), {
        file: uploadedFile,
        forceDocument: true,
        attributes: [
          new Api.DocumentAttributeFilename({
            fileName: filename,
          }),
        ],
      });

      this.logger.log(`Uploaded ${filename} to Telegram (message_id: ${result.id})`);

      return {
        messageId: result.id,
        fileId: `file_${result.id}`,
        fileSize: fileBuffer.length,
      };
    } catch (error) {
      this.logger.error(`Failed to upload ${filename}: ${error}`);
      throw error;
    }
  }

  /**
   * Download file from Telegram
   * @param messageId - Telegram message ID
   * @param chatId - Source chat ID
   * @returns File buffer
   */
  async downloadFile(messageId: number, chatId?: bigint): Promise<Buffer> {
    const account = this.getCurrentAccount();
    if (!account) {
      throw new Error('No Telegram account configured');
    }

    const client = this.getClient(account.id);
    const targetChatId = chatId || account.chatId;

    this.logger.log(`Downloading message ${messageId} from chat ${targetChatId}`);

    try {
      // Get message
      const messages = await client.getMessages(targetChatId.toString(), {
        ids: [messageId],
      });

      if (!messages || messages.length === 0 || !messages[0].media) {
        throw new Error(`Message ${messageId} not found or has no media`);
      }

      const message = messages[0];

      // Download media
      const buffer = await client.downloadMedia(message);

      this.logger.log(`Downloaded message ${messageId} (${buffer.length} bytes)`);

      return buffer;
    } catch (error) {
      this.logger.error(`Failed to download message ${messageId}: ${error}`);
      throw error;
    }
  }

  /**
   * Download file as stream (for large files)
   * @param messageId - Telegram message ID
   * @param chatId - Source chat ID
   * @returns Readable stream
   */
  async downloadFileStream(messageId: number, chatId?: bigint): Promise<NodeJS.ReadableStream> {
    const account = this.getCurrentAccount();
    if (!account) {
      throw new Error('No Telegram account configured');
    }

    const client = this.getClient(account.id);
    const targetChatId = chatId || account.chatId;

    this.logger.log(`Streaming download for message ${messageId} from chat ${targetChatId}`);

    try {
      // Get message
      const messages = await client.getMessages(targetChatId.toString(), {
        ids: [messageId],
      });

      if (!messages || messages.length === 0 || !messages[0].media) {
        throw new Error(`Message ${messageId} not found or has no media`);
      }

      const message = messages[0];

      // Use iterDownload for streaming
      const stream = client.iterDownload(message.media, {
        chunkSize: 1024 * 1024, // 1MB chunks
      });

      return stream;
    } catch (error) {
      this.logger.error(`Failed to stream message ${messageId}: ${error}`);
      throw error;
    }
  }

  /**
   * Delete message from Telegram
   * @param messageId - Telegram message ID
   * @param chatId - Source chat ID
   */
  async deleteMessage(messageId: number, chatId?: bigint): Promise<void> {
    const account = this.getCurrentAccount();
    if (!account) {
      throw new Error('No Telegram account configured');
    }

    const client = this.getClient(account.id);
    const targetChatId = chatId || account.chatId;

    this.logger.log(`Deleting message ${messageId} from chat ${targetChatId}`);

    try {
      await client.deleteMessages(targetChatId.toString(), [messageId]);
      this.logger.log(`Deleted message ${messageId}`);
    } catch (error) {
      this.logger.error(`Failed to delete message ${messageId}: ${error}`);
      throw error;
    }
  }

  /**
   * Disconnect all clients
   */
  async disconnect(): Promise<void> {
    for (const [id, client] of this.clients.entries()) {
      try {
        await client.disconnect();
        this.logger.log(`Disconnected client ${id}`);
      } catch (error) {
        this.logger.warn(`Failed to disconnect client ${id}: ${error}`);
      }
    }
    this.clients.clear();
    this.connected = false;
  }

  /**
   * Check if service is connected
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Get service status
   */
  getStatus(): { enabled: boolean; connected: boolean; accountCount: number } {
    return {
      enabled: this.config.enabled,
      connected: this.connected,
      accountCount: this.config.accounts.length,
    };
  }
}
