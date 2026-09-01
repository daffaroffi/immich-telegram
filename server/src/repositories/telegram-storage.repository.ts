import { Injectable, Logger } from '@nestjs/common';
import { Readable, Writable, PassThrough } from 'node:stream';
import { CrawlOptionsDto, WalkOptionsDto } from 'src/dtos/library.dto';
import { Dirent } from 'node:fs';
import { ReadOptionsWithBuffer } from 'node:fs';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { TelegramMtprotoService } from 'src/services/telegram-mtproto.service';
import { TelegramCacheService } from 'src/services/telegram-cache.service';
import { TelegramEncryptionService } from 'src/services/telegram-encryption.service';
import { TelegramRateLimitService } from 'src/services/telegram-rate-limit.service';
import {
  ImmichReadStream,
  ImmichZipStream,
  DiskUsage,
  IStorageProvider,
} from 'src/repositories/storage.interface';

/**
 * Telegram Storage Repository
 * Implements storage operations using Telegram Cloud Storage via MTProto
 */
@Injectable()
export class TelegramStorageRepository implements IStorageProvider {
  private readonly logger = new Logger(TelegramStorageRepository.name);

  constructor(
    private loggingRepository: LoggingRepository,
    private telegramMtproto: TelegramMtprotoService,
    private telegramCache: TelegramCacheService,
    private telegramEncryption: TelegramEncryptionService,
    private telegramRateLimit: TelegramRateLimitService,
  ) {
    this.loggingRepository.setContext(TelegramStorageRepository.name);
  }

  /**
   * Create a writable stream that uploads to Telegram
   */
  createWriteStream(filepath: string): Writable {
    const passThrough = new PassThrough();

    // Handle stream data
    const chunks: Buffer[] = [];
    passThrough.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });

    passThrough.on('end', async () => {
      try {
        const buffer = Buffer.concat(chunks);
        await this.uploadToTelegram(filepath, buffer);
      } catch (error) {
        this.logger.error(`Failed to upload ${filepath} to Telegram`, error);
        passThrough.destroy(error as Error);
      }
    });

    return passThrough;
  }

  /**
   * Create a readable stream from Telegram
   */
  async createReadStream(filepath: string): Promise<ImmichReadStream> {
    // Check cache first
    const cached = await this.telegramCache.get(filepath);
    if (cached) {
      return {
        stream: Readable.from(cached),
        length: cached.length,
      };
    }

    // Download from Telegram
    await this.telegramRateLimit.waitForDownloadSlot();
    try {
      // TODO: Get message ID from database based on filepath
      const messageId = 0; // Placeholder
      const buffer = await this.telegramMtproto.downloadFile(messageId);

      // Cache the result
      await this.telegramCache.set(filepath, buffer);

      return {
        stream: Readable.from(buffer),
        length: buffer.length,
      };
    } finally {
      this.telegramRateLimit.releaseDownloadSlot();
    }
  }

  /**
   * Read entire file into buffer
   */
  async readFile(filepath: string): Promise<Buffer> {
    const cached = await this.telegramCache.get(filepath);
    if (cached) {
      return cached;
    }

    // TODO: Download from Telegram and cache
    return Buffer.alloc(0);
  }

  /**
   * Read file slice
   */
  async readFileSlice(filepath: string, options: ReadOptionsWithBuffer<Buffer>): Promise<Buffer> {
    // For Telegram, we need to download the entire file
    // The options are passed to readFile for compatibility
    return this.readFile(filepath);
  }

  /**
   * Create file from buffer
   */
  async createFile(filepath: string, buffer: Buffer): Promise<void> {
    await this.uploadToTelegram(filepath, buffer);
  }

  /**
   * Create or overwrite file
   */
  async createOrOverwriteFile(filepath: string, buffer: Buffer): Promise<void> {
    // Check if file exists and delete first
    try {
      await this.unlink(filepath);
    } catch {
      // File doesn't exist, that's fine
    }
    await this.uploadToTelegram(filepath, buffer);
  }

  /**
   * Overwrite existing file
   */
  async overwriteFile(filepath: string, buffer: Buffer): Promise<void> {
    await this.createOrOverwriteFile(filepath, buffer);
  }

  /**
   * Delete file from Telegram
   */
  async unlink(filepath: string): Promise<void> {
    try {
      // TODO: Get message ID from database
      const messageId = 0; // Placeholder
      await this.telegramMtproto.deleteMessage(messageId);
      this.logger.log(`Deleted file from Telegram: ${filepath}`);
    } catch (error) {
      this.logger.warn(`Failed to delete file ${filepath}: ${error}`);
    }
  }

  /**
   * Rename file (move to new location)
   */
  async rename(source: string, target: string): Promise<void> {
    // Telegram doesn't support rename, so we download and re-upload
    const buffer = await this.readFile(source);
    await this.unlink(source);
    await this.createFile(target, buffer);
  }

  /**
   * Get file stats
   */
  async stat(filepath: string): Promise<{ size: number; mtime: Date; isFile(): boolean; isDirectory(): boolean }> {
    // TODO: Get from database
    return {
      size: 0,
      mtime: new Date(),
      isFile: () => true,
      isDirectory: () => false,
    };
  }

  /**
   * List directory contents
   */
  async readdir(folder: string): Promise<string[]> {
    // TODO: List files in Telegram channel/folder
    return [];
  }

  /**
   * List directory with types
   */
  async readdirWithTypes(folder: string): Promise<Dirent[]> {
    // TODO: List files with types
    return [];
  }

  /**
   * Check if file exists
   */
  async checkFileExists(filepath: string): Promise<boolean> {
    // TODO: Check in database
    return false;
  }

  /**
   * Copy file
   */
  async copyFile(source: string, target: string): Promise<void> {
    const buffer = await this.readFile(source);
    await this.createFile(target, buffer);
  }

  /**
   * Update file timestamps
   */
  async utimes(filepath: string, atime: Date, mtime: Date): Promise<void> {
    // Telegram doesn't support utimes, so this is a no-op
    this.logger.debug(`utimes called for ${filepath} (no-op in Telegram storage)`);
  }

  /**
   * Create directory synchronously
   */
  mkdirSync(filepath: string): void {
    // Telegram channels are flat, so this is a no-op
    this.logger.debug(`mkdirSync called for ${filepath} (no-op in Telegram storage)`);
  }

  /**
   * Get real path
   */
  async realpath(filepath: string): Promise<string> {
    // In Telegram storage, the filepath is the "real" path
    return filepath;
  }

  /**
   * Crawl directory for files
   */
  async crawl(options: CrawlOptionsDto): Promise<string[]> {
    // TODO: List all files in Telegram channel
    return [];
  }

  /**
   * Walk directory tree
   */
  async *walk(options: WalkOptionsDto): AsyncGenerator<string[]> {
    // TODO: Walk Telegram channel
    yield [];
  }

  /**
   * Check disk usage (not applicable for Telegram)
   */
  async checkDiskUsage(folder: string): Promise<DiskUsage> {
    // Telegram provides unlimited storage
    return {
      available: Number.MAX_SAFE_INTEGER,
      free: Number.MAX_SAFE_INTEGER,
      total: Number.MAX_SAFE_INTEGER,
    };
  }

  /**
   * Remove empty directories (not applicable for Telegram)
   */
  async removeEmptyDirs(directory: string, self: boolean = false): Promise<void> {
    // Telegram doesn't have directories, so this is a no-op
  }

  /**
   * Create ZIP stream
   */
  createZipStream(): ImmichZipStream {
    // TODO: Implement ZIP stream for Telegram
    const passThrough = new PassThrough();
    const files: { input: string; filename: string }[] = [];

    const addFile = (input: string, filename: string) => {
      files.push({ input, filename });
    };

    const finalize = async () => {
      // TODO: Create ZIP archive from Telegram files
      passThrough.end();
    };

    return {
      stream: passThrough,
      addFile,
      finalize,
    };
  }

  /**
   * Upload file to Telegram with encryption
   */
  private async uploadToTelegram(filepath: string, buffer: Buffer): Promise<void> {
    await this.telegramRateLimit.waitForUploadSlot();
    try {
      // Encrypt if enabled
      let dataToUpload = buffer;
      // TODO: Check if encryption is enabled and encrypt

      // Upload to Telegram
      const result = await this.telegramMtproto.uploadFile(dataToUpload, filepath);

      // TODO: Store message_id in database

      this.logger.log(`Uploaded ${filepath} to Telegram (message_id: ${result.messageId})`);
    } finally {
      this.telegramRateLimit.releaseUploadSlot();
    }
  }
}
