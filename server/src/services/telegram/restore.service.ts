import { Injectable } from '@nestjs/common';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { TelegramRefRepository } from 'src/repositories/telegram-ref.repository.js';
import { TelegramCryptoService } from 'src/services/telegram/crypto.service.js';
import { TelegramMtprotoService } from 'src/services/telegram/mtproto.service.js';

/**
 * Restore path for telegram-backed assets.
 *
 * The on-disk copy is still the source of truth; this service only runs when
 * that copy has gone missing (manual deletion, lost volume, disk failure) and a
 * telegram_ref row exists. It downloads the stored envelope, decrypts it and
 * writes the file back to the path Immich expects.
 *
 * Deliberately independent of BaseService so it can be wired into the HTTP
 * layer without extending the already very long base constructor.
 */
@Injectable()
export class TelegramRestoreService {
  constructor(
    private configRepository: ConfigRepository,
    private refRepository: TelegramRefRepository,
    private crypto: TelegramCryptoService,
    private mtproto: TelegramMtprotoService,
    private logger: LoggingRepository,
  ) {
    this.logger.setContext(TelegramRestoreService.name);
  }

  private get enabled(): boolean {
    return this.configRepository.getEnv().telegram.enabled;
  }

  /**
   * Ensure `path` exists locally, restoring it from Telegram when it does not.
   * Returns true when the file is present after the call.
   */
  async ensureAvailable(assetId: string, path: string): Promise<boolean> {
    if (existsSync(path)) {
      return true;
    }
    if (!this.enabled) {
      return false;
    }

    const ref = await this.refRepository.get(assetId);
    if (!ref) {
      return false;
    }

    const vaultKey = this.configRepository.getEnv().telegram.vaultKey;
    if (ref.encrypted && !vaultKey) {
      this.logger.error(`Asset ${assetId} is encrypted but TELEGRAM_VAULT_KEY is not set; cannot restore`);
      return false;
    }

    this.logger.warn(`Original file missing on disk, restoring ${assetId} from telegram`);

    const stagingPath = ref.encrypted ? `${path}.tgrestore` : path;
    try {
      await this.mtproto.downloadFile(ref.messageId, stagingPath);
      if (ref.encrypted) {
        await this.crypto.decryptFile(stagingPath, path, vaultKey!);
      }
      this.logger.log(`Restored ${assetId} from telegram message ${ref.messageId}`);
      return true;
    } catch (error: unknown) {
      this.logger.error(`Failed to restore ${assetId} from telegram: ${error}`);
      return false;
    } finally {
      if (ref.encrypted) {
        await rm(stagingPath, { force: true });
      }
    }
  }
}
