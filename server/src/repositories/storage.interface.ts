import { Readable, Writable } from 'node:stream';
import { CrawlOptionsDto, WalkOptionsDto } from 'src/dtos/library.dto';
import { Dirent } from 'node:fs';
import { ReadOptionsWithBuffer } from 'node:fs';

export interface ImmichReadStream {
  stream: Readable;
  type?: string;
  disposition?: string | string[];
  length?: number;
}

export interface ImmichZipStream extends ImmichReadStream {
  addFile: (inputPath: string, filename: string) => void;
  finalize: () => Promise<void>;
}

export interface DiskUsage {
  available: number;
  free: number;
  total: number;
}

export interface IStorageProvider {
  // Core I/O
  createWriteStream(filepath: string): Writable;
  createReadStream(filepath: string): Promise<ImmichReadStream>;
  readFile(filepath: string): Promise<Buffer>;
  readFileSlice(filepath: string, options: ReadOptionsWithBuffer<Buffer>): Promise<Buffer>;
  createFile(filepath: string, buffer: Buffer): Promise<void>;
  createOrOverwriteFile(filepath: string, buffer: Buffer): Promise<void>;
  overwriteFile(filepath: string, buffer: Buffer): Promise<void>;
  unlink(filepath: string): Promise<void>;
  rename(source: string, target: string): Promise<void>;
  stat(filepath: string): Promise<{ size: number; mtime: Date; isFile(): boolean; isDirectory(): boolean }>;
  readdir(folder: string): Promise<string[]>;
  readdirWithTypes(folder: string): Promise<Dirent[]>;
  checkFileExists(filepath: string): Promise<boolean>;
  copyFile(source: string, target: string): Promise<void>;
  utimes(filepath: string, atime: Date, mtime: Date): Promise<void>;
  mkdirSync(filepath: string): void;
  realpath(filepath: string): Promise<string>;

  // Advanced
  crawl(options: CrawlOptionsDto): Promise<string[]>;
  walk(options: WalkOptionsDto): AsyncGenerator<string[]>;
  checkDiskUsage(folder: string): Promise<DiskUsage>;
  removeEmptyDirs(directory: string, self?: boolean): Promise<void>;

  // Compression
  createZipStream(): ImmichZipStream;
}
