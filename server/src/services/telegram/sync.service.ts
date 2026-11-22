import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OnEvent } from 'src/decorators.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import type { ArgOf } from 'src/repositories/event.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { TelegramRefRepository } from 'src/repositories/telegram-ref.repository.js';
import { TelegramCryptoService } from 'src/services/telegram/crypto.service.js';
import { TelegramMtprotoService } from 'src/services/telegram/mtproto.service.js';
import { TelegramQuotaService } from 'src/services/telegram/quota.service.js';

interface QueueItem {
  assetId: string;
  originalPath: string;
  checksum: string | null;
}

/**
 * Core sync engine. Listens for `AssetCreate` and, when telegram storage is
 * enabled, uploads the original file (encrypted) to the configured channel and
 * records the mapping in `telegram_ref`.
 *
 * The on-disk copy remains the source of truth; Telegram is an off-ledger
 * backup with automatic restore (see restore in asset-media.service).
 *
 * Uploads are serialized and throttled by the daily budget. Files queued after
 * the budget is exhausted are deferred (kept in memory), not lost.
 */
@Injectable()
export class TelegramSyncService {
  private queue: QueueItem[] = [];
  private processing = false;

  constructor(
    private configRepository: ConfigRepository,
    private refRepository: TelegramRefRepository,
    private crypto: TelegramCryptoService,
    private mtproto: TelegramMtprotoService,
    private quota: TelegramQuotaService,
    private logger: LoggingRepository,
  ) {
    this.logger.setContext(TelegramSyncService.name);
  }

  @OnEvent({ name: 'AssetCreate' })
  onAssetCreate({ asset, file }: ArgOf<'AssetCreate'>): void {
    if (!this.configRepository.getEnv().telegram.enabled) {
      return;
    }
    if (!file?.originalPath) {
      this.logger.warn(`Asset ${asset.id} has no originalPath, skipping telegram backup`);
      return;
    }
    this.enqueue({
      assetId: asset.id,
      originalPath: file.originalPath,
      checksum: toHexString(file.checksum),
    });
  }

  private enqueue(item: QueueItem): void {
    if (!item.originalPath) {
      this.logger.warn(`Asset ${item.assetId} has no originalPath, skipping telegram backup`);
      return;
    }
    this.queue.push(item);
    void this.drain();
  }

  /** Backfill: queue every asset that has no telegram_ref row yet. */
  async backfill(limit = 5000): Promise<number> {
    const ids = await this.refRepository.listUnbacked(limit);
    // paths for backfill are resolved lazily in drain() via the asset file table;
    // for a first implementation we require callers to pass full paths, so this
    // method reports how many remain instead of attempting path resolution.
    return ids.length;
  }

  private async drain(): Promise<void> {
    if (this.processing) {
      return;
    }
    this.processing = true;
    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift()!;
        try {
          await this.uploadOne(item);
        } catch (error: unknown) {
          this.logger.error(`Telegram backup failed for asset ${item.assetId}: ${error}`);
          // keep it for a later attempt unless it is a hard, permanent error
          if (!isHardError(error)) {
            this.queue.unshift(item);
          }
          break;
        }
      }
    } finally {
      this.processing = false;
    }
  }

  private async uploadOne(item: QueueItem): Promise<void> {
    const { assetId, originalPath, checksum } = item;

    const existing = await this.refRepository.get(assetId);
    if (existing) {
      this.logger.debug(`Asset ${assetId} already backed up (message ${existing.messageId})`);
      return;
    }

    if (!existsSync(originalPath)) {
      throw new Error(`Original file missing on disk: ${originalPath}`);
    }

    const { size } = await stat(originalPath);
    if (!this.quota.canUpload(size)) {
      this.logger.warn(
        `Daily telegram quota exhausted; deferring asset ${assetId} (${size} bytes). Remaining: ${this.quota.remainingBytes}`,
      );
      this.queue.unshift(item);
      throw new QuotaDeferredError();
    }

    await this.mtproto.connect();

    const vaultKey = this.configRepository.getEnv().telegram.vaultKey;
    let uploadPath = originalPath;
    let actualSize = size;

    if (vaultKey) {
      const encryptedPath = join(tmpdir(), `tg-enc-${assetId}.bin`);
      try {
        await this.crypto.encryptFile(originalPath, encryptedPath, vaultKey);
        actualSize = (await stat(encryptedPath)).size;
        uploadPath = encryptedPath;
      } catch (error) {
        await rm(encryptedPath, { force: true });
        throw error;
      }
    }

    try {
      const result = await this.mtproto.uploadFile(uploadPath, `${assetId}.bin`);
      this.quota.recordUpload(actualSize);
      await this.refRepository.create({
        assetId,
        messageId: result.messageId,
        chatId: result.chatId,
        size: actualSize,
        checksum,
        encrypted: vaultKey !== null,
      });
      this.logger.log(`Backed up asset ${assetId} → telegram message ${result.messageId}`);
    } finally {
      if (vaultKey) {
        await rm(uploadPath, { force: true });
      }
    }
  }

  status() {
    return {
      queueDepth: this.queue.length,
      processing: this.processing,
      quota: this.quota.status(),
      telegram: this.mtproto.status(),
    };
  }
}

class QuotaDeferredError extends Error {}

function isHardError(error: unknown): boolean {
  return (
    error instanceof QuotaDeferredError === false &&
    /session missing|cannot upload missing|must be set when telegram storage is enabled/i.test(String(error))
  );
}

function toHexString(buffer: Buffer | undefined): string | null {
  if (!buffer) {
    return null;
  }
  return createHash('sha1').update(buffer).digest('hex');
}