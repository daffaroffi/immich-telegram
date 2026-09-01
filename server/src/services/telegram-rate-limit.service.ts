import { Injectable, Logger } from '@nestjs/common';

interface RateLimitState {
  uploadSemaphore: number;
  downloadSemaphore: number;
  lastUploadTime: Date;
  lastDownloadTime: Date;
  floodWaitUntil: Date | null;
}

interface RetryConfig {
  maxRetries: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  floodWaitMultiplier: number;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseBackoffMs: 1000,
  maxBackoffMs: 30000,
  floodWaitMultiplier: 1.5,
};

/**
 * Rate Limit Service for Telegram MTProto API
 * Handles FLOOD_WAIT errors and implements semaphore-based concurrency control
 */
@Injectable()
export class TelegramRateLimitService {
  private readonly logger = new Logger(TelegramRateLimitService.name);
  private state: RateLimitState;
  private retryConfig: RetryConfig;

  constructor() {
    this.retryConfig = DEFAULT_RETRY_CONFIG;
    this.state = {
      uploadSemaphore: parseInt(process.env.TELEGRAM_MAX_CONCURRENT_UPLOADS || '4', 10),
      downloadSemaphore: parseInt(process.env.TELEGRAM_MAX_CONCURRENT_DOWNLOADS || '8', 10),
      lastUploadTime: new Date(0),
      lastDownloadTime: new Date(0),
      floodWaitUntil: null,
    };
  }

  /**
   * Wait for upload slot availability
   */
  async waitForUploadSlot(): Promise<void> {
    // Check flood wait
    if (this.state.floodWaitUntil && this.state.floodWaitUntil > new Date()) {
      const waitMs = this.state.floodWaitUntil.getTime() - Date.now();
      this.logger.warn(`FLOOD_WAIT: Waiting ${waitMs}ms before next operation`);
      await this.sleep(waitMs);
    }

    // Wait for semaphore
    while (this.state.uploadSemaphore <= 0) {
      this.logger.debug('Upload slot unavailable, waiting...');
      await this.sleep(100);
    }

    this.state.uploadSemaphore--;
    this.state.lastUploadTime = new Date();
  }

  /**
   * Release upload slot
   */
  releaseUploadSlot(): void {
    this.state.uploadSemaphore++;
  }

  /**
   * Wait for download slot availability
   */
  async waitForDownloadSlot(): Promise<void> {
    // Check flood wait
    if (this.state.floodWaitUntil && this.state.floodWaitUntil > new Date()) {
      const waitMs = this.state.floodWaitUntil.getTime() - Date.now();
      this.logger.warn(`FLOOD_WAIT: Waiting ${waitMs}ms before next operation`);
      await this.sleep(waitMs);
    }

    // Wait for semaphore
    while (this.state.downloadSemaphore <= 0) {
      this.logger.debug('Download slot unavailable, waiting...');
      await this.sleep(100);
    }

    this.state.downloadSemaphore--;
    this.state.lastDownloadTime = new Date();
  }

  /**
   * Release download slot
   */
  releaseDownloadSlot(): void {
    this.state.downloadSemaphore++;
  }

  /**
   * Handle FLOOD_WAIT error from Telegram
   */
  handleFloodWait(seconds: number): void {
    const waitUntil = new Date();
    waitUntil.setSeconds(waitUntil.getSeconds() + seconds);
    this.state.floodWaitUntil = waitUntil;
    this.logger.warn(`FLOOD_WAIT: Telegram rate limit hit, waiting ${seconds} seconds`);
  }

  /**
   * Parse FLOOD_WAIT error message
   */
  parseFloodWaitError(error: string): number | null {
    const match = error.match(/FLOOD_WAIT[_ ](\d+)/);
    if (match) {
      return parseInt(match[1], 10);
    }
    return null;
  }

  /**
   * Execute function with retry logic
   */
  async withRetry<T>(fn: () => Promise<T>, operation: string = 'operation'): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.retryConfig.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error as Error;
        const errorMessage = lastError.message;

        // Check for FLOOD_WAIT
        const floodWaitSeconds = this.parseFloodWaitError(errorMessage);
        if (floodWaitSeconds) {
          this.handleFloodWait(floodWaitSeconds);
          continue;
        }

        // Check for other retryable errors
        if (this.isRetryableError(errorMessage)) {
          if (attempt < this.retryConfig.maxRetries) {
            const backoffMs = this.calculateBackoff(attempt);
            this.logger.warn(
              `${operation} failed (attempt ${attempt + 1}/${this.retryConfig.maxRetries + 1}), retrying in ${backoffMs}ms`,
            );
            await this.sleep(backoffMs);
            continue;
          }
        }

        // Non-retryable error or max retries reached
        throw lastError;
      }
    }

    throw lastError || new Error(`${operation} failed after ${this.retryConfig.maxRetries} retries`);
  }

  private isRetryableError(errorMessage: string): boolean {
    const retryablePatterns = [
      'NETWORK_ERROR',
      'TIMEOUT',
      ' CONNECTION',
      'ECONNRESET',
      'ECONNREFUSED',
      'ETIMEDOUT',
    ];

    return retryablePatterns.some((pattern) => errorMessage.includes(pattern));
  }

  private calculateBackoff(attempt: number): number {
    const backoff = this.retryConfig.baseBackoffMs * Math.pow(2, attempt);
    return Math.min(backoff, this.retryConfig.maxBackoffMs);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Get current rate limit status
   */
  getStatus(): {
    uploadSlotsAvailable: number;
    downloadSlotsAvailable: number;
    isFloodWait: boolean;
    floodWaitUntil: Date | null;
  } {
    return {
      uploadSlotsAvailable: this.state.uploadSemaphore,
      downloadSlotsAvailable: this.state.downloadSemaphore,
      isFloodWait: this.state.floodWaitUntil !== null && this.state.floodWaitUntil > new Date(),
      floodWaitUntil: this.state.floodWaitUntil,
    };
  }
}
