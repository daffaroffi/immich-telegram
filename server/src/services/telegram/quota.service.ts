import { Injectable } from '@nestjs/common';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';

/**
 * Per-day upload budget (Telegram default: 2 GB/day per account).
 *
 * Tracks bytes uploaded today in-memory only; a restart resets the counter,
 * which is acceptable because the invariant guarded here is "do not exceed a
 * rolling daily budget", and the risk surface is at most one partial day.
 * Persisted accounting can be added later if multi-day backfills need it.
 */
@Injectable()
export class TelegramQuotaService {
  private day: string | null = null;
  private bytesUploaded = 0;

  constructor(
    private configRepository: ConfigRepository,
    private logger: LoggingRepository,
  ) {
    this.logger.setContext(TelegramQuotaService.name);
  }

  private get limitBytes(): number {
    return this.configRepository.getEnv().telegram.dailyUploadLimitMb * 1024 * 1024;
  }

  private rolloverIfNeeded(): void {
    const today = this.todayKey();
    if (this.day !== today) {
      this.day = today;
      this.bytesUploaded = 0;
    }
  }

  private todayKey(): string {
    // server local day (UTC+7 deployment is handled by the environment clock)
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  get usedBytes(): number {
    this.rolloverIfNeeded();
    return this.bytesUploaded;
  }

  get remainingBytes(): number {
    this.rolloverIfNeeded();
    return Math.max(0, this.limitBytes - this.bytesUploaded);
  }

  /** Whether a single file of `size` bytes fits within today's remaining budget. */
  canUpload(size: number): boolean {
    this.rolloverIfNeeded();
    return this.bytesUploaded + size <= this.limitBytes;
  }

  /** Register `size` bytes as uploaded, asserting the budget was not exceeded. */
  recordUpload(size: number): void {
    this.rolloverIfNeeded();
    if (this.bytesUploaded + size > this.limitBytes) {
      throw new Error('Telegram daily upload limit would be exceeded');
    }
    this.bytesUploaded += size;
  }

  status() {
    return {
      limitBytes: this.limitBytes,
      usedBytes: this.usedBytes,
      remainingBytes: this.remainingBytes,
      day: this.day,
    };
  }
}