import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import type { TelegramStorageConfig } from 'src/config/telegram.config.js';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/* eslint-disable @typescript-eslint/no-explicit-any */
type GramJsModule = any;

export interface TelegramUploadResult {
  messageId: number;
  chatId: bigint;
  size: number;
  fileId: string;
}

/**
 * Minimal MTProto client for Telegram storage.
 *
 * Uses gramjs (`telegram` package) with a persisted StringSession so the
 * server can run headless. Login is a one-off interactive CLI step:
 * `immich telegram:login` writes the session file used here.
 */
@Injectable()
export class TelegramMtprotoService implements OnModuleInit, OnModuleDestroy {
  private client: any = null;
  private gramjs: GramJsModule = null;
  private connecting: Promise<void> | null = null;

  constructor(
    private configRepository: ConfigRepository,
    private logger: LoggingRepository,
  ) {
    this.logger.setContext(TelegramMtprotoService.name);
  }

  private get config(): TelegramStorageConfig {
    return this.configRepository.getEnv().telegram;
  }

  private async loadGramjs(): Promise<GramJsModule> {
    if (!this.gramjs) {
      // dynamic import keeps gramjs out of the hot startup path and out of
      // any worker that does not need it
      this.gramjs = await import('telegram');
    }
    return this.gramjs;
  }

  async onModuleInit(): Promise<void> {
    if (!this.config.enabled) {
      this.logger.debug('Telegram storage disabled');
      return;
    }
    try {
      await this.connect();
    } catch (error: unknown) {
      this.logger.error(`Telegram storage could not connect at startup: ${error}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.disconnect();
  }

  get isEnabled(): boolean {
    return this.config.enabled;
  }

  get isConnected(): boolean {
    return this.client !== null;
  }

  private assertConfigured(): TelegramStorageConfig {
    const config = this.config;
    if (!config.apiId || !config.apiHash) {
      throw new Error('TELEGRAM_API_ID and TELEGRAM_API_HASH must be set when telegram storage is enabled');
    }
    if (config.chatId === 0n) {
      throw new Error('TELEGRAM_CHAT_ID must be set when telegram storage is enabled');
    }
    return config;
  }

  private async readSession(): Promise<string> {
    const config = this.assertConfigured();
    const session = await readFile(config.sessionPath, 'utf8').catch(() => null);
    if (!session) {
      throw new Error(
        `Telegram session missing at ${config.sessionPath}. Run the interactive login once to create it.`,
      );
    }
    return session.trim();
  }

  async connect(): Promise<void> {
    if (this.client || this.connecting) {
      return this.connecting ?? undefined;
    }

    this.connecting = (async () => {
      const config = this.assertConfigured();
      const gramjs = await this.loadGramjs();
      const session = new gramjs.sessions.StringSession(await this.readSession());

      const client = new gramjs.TelegramClient(session, config.apiId, config.apiHash, {
        connectionRetries: 5,
        autoReconnect: true,
        useWSS: false,
      });

      client.setLogLevel('error');
      await client.connect();

      if (!(await client.checkAuthorization())) {
        throw new Error('Stored Telegram session is no longer authorized. Re-run the interactive login.');
      }

      this.client = client;
      this.logger.log(`Connected to Telegram (chat ${config.chatId})`);
    })();

    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.disconnect().catch(() => {});
      this.client = null;
    }
  }

  private async ensureClient(): Promise<any> {
    if (!this.client) {
      await this.connect();
    }
    return this.client;
  }

  /**
   * Interactive login helper used by the `telegram:login` CLI command.
   * Not called during normal server operation.
   */
  async interactiveLogin(phone: () => Promise<string>, code: () => Promise<string>, password?: () => Promise<string>) {
    const config = this.assertConfigured();
    const gramjs = await this.loadGramjs();
    const session = new gramjs.sessions.StringSession();

    const client = new gramjs.TelegramClient(session, config.apiId, config.apiHash, { connectionRetries: 5 });
    client.setLogLevel('error');
    await client.start({
      phoneNumber: phone,
      password: password,
      phoneCode: code,
      onError: (error: Error) => this.logger.error(`Login error: ${error.message}`),
    });

    const sessionString = session.save();
    await mkdir(dirname(config.sessionPath), { recursive: true });
    await writeFile(config.sessionPath, sessionString, { mode: 0o600 });

    await client.disconnect();
    this.logger.log(`Telegram session saved to ${config.sessionPath}`);
    return config.sessionPath;
  }

  /** Upload a file from disk and return the Telegram message reference. */
  async uploadFile(filePath: string, fileName: string): Promise<TelegramUploadResult> {
    const config = this.assertConfigured();
    if (!existsSync(filePath)) {
      throw new Error(`Cannot upload missing file: ${filePath}`);
    }

    const client = await this.ensureClient();
    const gramjs = await this.loadGramjs();

    const uploaded = await client.uploadFile({
      file: createReadStream(filePath),
      workers: 1,
    });

    const result = await client.sendMessage(config.chatId.toString(), {
      file: uploaded,
      forceDocument: true,
      attributes: [new gramjs.Api.DocumentAttributeFilename({ fileName })],
    });

    const messageId = Number(result.id);
    this.logger.log(`Uploaded ${fileName} to Telegram (message ${messageId})`);

    return {
      messageId,
      chatId: config.chatId,
      size: uploaded.size ?? 0,
      fileId: `tg:${config.chatId}:${messageId}`,
    };
  }

  /** Download a previously uploaded file into a local path. */
  async downloadFile(messageId: number, targetPath: string): Promise<number> {
    const config = this.assertConfigured();
    const client = await this.ensureClient();

    const messages = await client.getMessages(config.chatId.toString(), { ids: [messageId] });
    const message = messages?.[0];
    if (!message?.media) {
      throw new Error(`Telegram message ${messageId} has no media`);
    }

    await mkdir(dirname(targetPath), { recursive: true });
    const buffer = await client.downloadMedia(message);
    if (!Buffer.isBuffer(buffer)) {
      throw new Error(`Telegram download for message ${messageId} did not return a buffer`);
    }

    await writeFile(targetPath, buffer);
    this.logger.log(`Downloaded message ${messageId} to ${targetPath} (${buffer.length} bytes)`);
    return buffer.length;
  }

  /** Delete a stored file (used by restore/cleanup and verification). */
  async deleteMessage(messageId: number): Promise<void> {
    const config = this.assertConfigured();
    const client = await this.ensureClient();
    await client.deleteMessages(config.chatId.toString(), [messageId], { revoke: true });
  }

  /** Connection details for the admin status endpoint. */
  status() {
    const config = this.config;
    return {
      enabled: config.enabled,
      connected: this.isConnected,
      chatId: config.chatId.toString(),
      sessionPath: config.sessionPath,
      dailyUploadLimitMb: config.dailyUploadLimitMb,
    };
  }
}
