import { Injectable, Logger } from '@nestjs/common';
import { ConfigRepository } from 'src/repositories/config.repository';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

interface CacheEntry {
  key: string;
  filePath: string;
  size: number;
  lastAccessed: Date;
  hitCount: number;
  data?: Buffer; // In-memory storage for small files
}

interface CacheStats {
  memoryCache: {
    sizeMb: number;
    entries: number;
    hitRate: number;
  };
  diskCache: {
    sizeMb: number;
    entries: number;
    hitRate: number;
  };
  totalSizeMb: number;
}

/**
 * Two-tier Cache Service for Telegram Storage
 * - In-memory LRU cache for hot files (< 100MB)
 * - Local disk cache for warm files
 */
@Injectable()
export class TelegramCacheService {
  private readonly logger = new Logger(TelegramCacheService.name);
  private memoryCache: Map<string, CacheEntry> = new Map();
  private diskCache: Map<string, CacheEntry> = new Map();
  private cacheDir: string;

  private maxMemorySizeMb: number;
  private maxDiskSizeMb: number;
  private cacheTtlHours: number;
  private totalMemoryHits = 0;
  private totalMemoryMisses = 0;
  private totalDiskHits = 0;
  private totalDiskMisses = 0;

  constructor(private configRepository: ConfigRepository) {
    this.maxMemorySizeMb = parseInt(process.env.TELEGRAM_CACHE_SIZE_MB || '512', 10);
    this.maxDiskSizeMb = parseInt(process.env.TELEGRAM_CACHE_SIZE_MB || '5120', 10);
    this.cacheTtlHours = parseInt(process.env.TELEGRAM_CACHE_TTL_HOURS || '168', 10);
    this.cacheDir = process.env.TELEGRAM_CACHE_DIR || '/cache/telegram';

    // Ensure cache directory exists
    this.ensureCacheDir();
  }

  private async ensureCacheDir(): Promise<void> {
    try {
      await fs.mkdir(this.cacheDir, { recursive: true });
      await fs.mkdir(path.join(this.cacheDir, 'memory'), { recursive: true });
      await fs.mkdir(path.join(this.cacheDir, 'disk'), { recursive: true });
    } catch (error) {
      this.logger.warn(`Failed to create cache directory: ${error}`);
    }
  }

  /**
   * Get file from cache
   */
  async get(key: string): Promise<Buffer | null> {
    // Check memory cache first
    const memoryEntry = this.memoryCache.get(key);
    if (memoryEntry) {
      memoryEntry.lastAccessed = new Date();
      memoryEntry.hitCount++;
      this.totalMemoryHits++;
      this.logger.debug(`Cache HIT (memory): ${key}`);

      // Return data from memory
      if (memoryEntry.data) {
        return memoryEntry.data;
      }

      // Fallback to disk if data not in memory
      return this.readFromDisk(memoryEntry.filePath);
    }

    this.totalMemoryMisses++;

    // Check disk cache
    const diskEntry = this.diskCache.get(key);
    if (diskEntry) {
      diskEntry.lastAccessed = new Date();
      diskEntry.hitCount++;
      this.totalDiskHits++;
      this.logger.debug(`Cache HIT (disk): ${key}`);

      return this.readFromDisk(diskEntry.filePath);
    }

    this.totalDiskMisses++;
    this.logger.debug(`Cache MISS: ${key}`);
    return null;
  }

  /**
   * Store file in cache
   */
  async set(key: string, value: Buffer, ttlHours?: number): Promise<void> {
    const sizeMb = value.length / (1024 * 1024);
    const ttl = ttlHours || this.cacheTtlHours;

    // Decide cache tier based on size
    if (sizeMb < 100) {
      // Small files go to memory cache
      await this.setMemoryCache(key, value, sizeMb);
    } else {
      // Large files go to disk cache
      await this.setDiskCache(key, value, sizeMb);
    }
  }

  private async setMemoryCache(key: string, value: Buffer, sizeMb: number): Promise<void> {
    // Evict if needed
    while (this.getMemoryCacheSizeMb() + sizeMb > this.maxMemorySizeMb) {
      this.evictOldestMemoryEntry();
    }

    const entry: CacheEntry = {
      key,
      filePath: path.join(this.cacheDir, 'memory', this.sanitizeKey(key)),
      size: value.length,
      lastAccessed: new Date(),
      hitCount: 0,
      data: value, // Store data in memory
    };

    this.memoryCache.set(key, entry);
    this.logger.debug(`Cached in memory: ${key} (${sizeMb.toFixed(2)} MB)`);
  }

  private async setDiskCache(key: string, value: Buffer, sizeMb: number): Promise<void> {
    // Evict if needed
    while (this.getDiskCacheSizeMb() + sizeMb > this.maxDiskSizeMb) {
      this.evictOldestDiskEntry();
    }

    const filePath = path.join(this.cacheDir, 'disk', this.sanitizeKey(key));
    const entry: CacheEntry = {
      key,
      filePath,
      size: value.length,
      lastAccessed: new Date(),
      hitCount: 0,
    };

    // Write to disk
    await this.writeToDisk(filePath, value);

    this.diskCache.set(key, entry);
    this.logger.debug(`Cached on disk: ${key} (${sizeMb.toFixed(2)} MB)`);
  }

  private async readFromDisk(filePath: string): Promise<Buffer | null> {
    try {
      return await fs.readFile(filePath);
    } catch (error) {
      this.logger.warn(`Failed to read cache file ${filePath}: ${error}`);
      return null;
    }
  }

  private async writeToDisk(filePath: string, data: Buffer): Promise<void> {
    try {
      const dir = path.dirname(filePath);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(filePath, data);
    } catch (error) {
      this.logger.warn(`Failed to write cache file ${filePath}: ${error}`);
    }
  }

  private sanitizeKey(key: string): string {
    // Replace path separators and special characters
    return key.replace(/[\/\\:]/g, '_').replace(/[^a-zA-Z0-9_.-]/g, '');
  }

  private getMemoryCacheSizeMb(): number {
    let total = 0;
    for (const entry of this.memoryCache.values()) {
      total += entry.size;
    }
    return total / (1024 * 1024);
  }

  private getDiskCacheSizeMb(): number {
    let total = 0;
    for (const entry of this.diskCache.values()) {
      total += entry.size;
    }
    return total / (1024 * 1024);
  }

  private evictOldestMemoryEntry(): void {
    let oldestKey: string | null = null;
    let oldestDate = new Date();

    for (const [key, entry] of this.memoryCache.entries()) {
      if (entry.lastAccessed < oldestDate) {
        oldestDate = entry.lastAccessed;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.memoryCache.delete(oldestKey);
      this.logger.debug(`Evicted from memory cache: ${oldestKey}`);
    }
  }

  private evictOldestDiskEntry(): void {
    let oldestKey: string | null = null;
    let oldestDate = new Date();

    for (const [key, entry] of this.diskCache.entries()) {
      if (entry.lastAccessed < oldestDate) {
        oldestDate = entry.lastAccessed;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      const entry = this.diskCache.get(oldestKey);
      if (entry) {
        // Delete file from disk
        fs.unlink(entry.filePath).catch(() => {});
      }
      this.diskCache.delete(oldestKey);
      this.logger.debug(`Evicted from disk cache: ${oldestKey}`);
    }
  }

  /**
   * Clear cache entries older than specified hours
   */
  async clear(olderThanHours?: number): Promise<{ cleared: number; freedBytes: number }> {
    const cutoff = new Date();
    cutoff.setHours(cutoff.getHours() - (olderThanHours || this.cacheTtlHours));

    let cleared = 0;
    let freedBytes = 0;

    // Clear memory cache
    for (const [key, entry] of this.memoryCache.entries()) {
      if (entry.lastAccessed < cutoff) {
        freedBytes += entry.size;
        this.memoryCache.delete(key);
        cleared++;
      }
    }

    // Clear disk cache
    for (const [key, entry] of this.diskCache.entries()) {
      if (entry.lastAccessed < cutoff) {
        freedBytes += entry.size;
        // Delete file from disk
        fs.unlink(entry.filePath).catch(() => {});
        this.diskCache.delete(key);
        cleared++;
      }
    }

    this.logger.log(`Cleared ${cleared} cache entries, freed ${(freedBytes / 1024 / 1024).toFixed(2)} MB`);
    return { cleared, freedBytes };
  }

  /**
   * Get cache statistics
   */
  getStats(): CacheStats {
    const memorySizeMb = this.getMemoryCacheSizeMb();
    const diskSizeMb = this.getDiskCacheSizeMb();
    const totalMemoryRequests = this.totalMemoryHits + this.totalMemoryMisses;
    const totalDiskRequests = this.totalDiskHits + this.totalDiskMisses;

    return {
      memoryCache: {
        sizeMb: Math.round(memorySizeMb * 100) / 100,
        entries: this.memoryCache.size,
        hitRate: totalMemoryRequests > 0 ? this.totalMemoryHits / totalMemoryRequests : 0,
      },
      diskCache: {
        sizeMb: Math.round(diskSizeMb * 100) / 100,
        entries: this.diskCache.size,
        hitRate: totalDiskRequests > 0 ? this.totalDiskHits / totalDiskRequests : 0,
      },
      totalSizeMb: Math.round((memorySizeMb + diskSizeMb) * 100) / 100,
    };
  }
}
