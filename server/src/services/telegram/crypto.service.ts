import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { TG_ENC_CONSTANTS } from 'src/config/telegram.config.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';

/**
 * File encryption for Telegram storage.
 *
 * Format is our own (NOT TDENC2-compatible):
 *   header  = magic(7) | version(1) | salt(32) | chunkSize(4 LE) | ivPrefix(4) | plaintextLength(8 LE)
 *   payload = for each chunk i: AES-256-GCM(plaintext_chunk, iv = ivPrefix(4) | counter(8 BE))
 *             ciphertext is followed by a 16 byte auth tag.
 *
 * The per-file key is derived from the vault key with HKDF-SHA256 and a random
 * per-file salt, so a leaked file key cannot decrypt other files.
 */
@Injectable()
export class TelegramCryptoService {
  constructor(private logger: LoggingRepository) {
    this.logger.setContext(TelegramCryptoService.name);
  }

  /** Generate a fresh 32 byte vault key (hex encoded) for TELEGRAM_VAULT_KEY. */
  generateVaultKey(): string {
    return randomBytes(TG_ENC_CONSTANTS.KEY_SIZE).toString('hex');
  }

  parseVaultKey(value: string): Buffer {
    const key = Buffer.from(value, 'hex');
    if (key.length !== TG_ENC_CONSTANTS.KEY_SIZE) {
      throw new Error(
        `TELEGRAM_VAULT_KEY must be ${TG_ENC_CONSTANTS.KEY_SIZE} bytes hex (${TG_ENC_CONSTANTS.KEY_SIZE * 2} chars), got ${key.length} bytes`,
      );
    }
    return key;
  }

  private deriveFileKey(vaultKey: Buffer, salt: Buffer): Buffer {
    return Buffer.from(
      hkdfSync('sha256', vaultKey, salt, Buffer.from('immich-telegram:file-key:v1'), TG_ENC_CONSTANTS.KEY_SIZE),
    );
  }

  private chunkIv(ivPrefix: Buffer, index: number): Buffer {
    const iv = Buffer.alloc(TG_ENC_CONSTANTS.IV_SIZE);
    ivPrefix.copy(iv, 0);
    iv.writeBigUInt64BE(BigInt(index), 4);
    return iv;
  }

  private chunkAad(salt: Buffer, index: number, plaintextLength: number): Buffer {
    return Buffer.concat([
      Buffer.from(TG_ENC_CONSTANTS.MAGIC),
      Buffer.from([TG_ENC_CONSTANTS.VERSION]),
      salt,
      Buffer.from(`${index}:${plaintextLength}`),
    ]);
  }

  /** Encrypt a whole buffer. Header is prefixed, chunks follow with their tags. */
  encryptBuffer(plaintext: Buffer, vaultKey: Buffer): Buffer {
    const { MAGIC, VERSION, CHUNK_SIZE, IV_SIZE, AUTH_TAG_SIZE } = TG_ENC_CONSTANTS;
    const salt = randomBytes(32);
    const ivPrefix = randomBytes(IV_SIZE - 8);
    const fileKey = this.deriveFileKey(vaultKey, salt);

    const header = Buffer.alloc(MAGIC.length + 1 + 32 + 4 + ivPrefix.length + 8);
    let offset = 0;
    header.write(MAGIC, offset, 'ascii');
    offset += MAGIC.length;
    header.writeUInt8(VERSION, offset);
    offset += 1;
    salt.copy(header, offset);
    offset += 32;
    header.writeUInt32LE(CHUNK_SIZE, offset);
    offset += 4;
    ivPrefix.copy(header, offset);
    offset += ivPrefix.length;
    header.writeBigUInt64LE(BigInt(plaintext.length), offset);

    const parts: Buffer[] = [header];
    const chunkCount = Math.ceil(plaintext.length / CHUNK_SIZE);
    for (let i = 0; i < chunkCount; i++) {
      const start = i * CHUNK_SIZE;
      const chunk = plaintext.subarray(start, Math.min(start + CHUNK_SIZE, plaintext.length));
      const cipher = createCipheriv(TG_ENC_CONSTANTS.CIPHER, fileKey, this.chunkIv(ivPrefix, i), {
        authTagLength: AUTH_TAG_SIZE,
      });
      cipher.setAAD(this.chunkAad(salt, i, chunk.length));
      const encrypted = Buffer.concat([cipher.update(chunk), cipher.final()]);
      parts.push(Buffer.concat([encrypted, cipher.getAuthTag()]));
    }

    return Buffer.concat(parts);
  }

  /** Decrypt a payload produced by encryptBuffer. Throws on tampering or truncation. */
  decryptBuffer(envelope: Buffer, vaultKey: Buffer): Buffer {
    const { MAGIC, VERSION, IV_SIZE, AUTH_TAG_SIZE } = TG_ENC_CONSTANTS;
    const headerLength = MAGIC.length + 1 + 32 + 4 + (IV_SIZE - 8) + 8;
    if (envelope.length < headerLength) {
      throw new Error('Telegram envelope is truncated');
    }
    if (envelope.subarray(0, MAGIC.length).toString('ascii') !== MAGIC) {
      throw new Error('Telegram envelope has an invalid magic');
    }
    if (envelope.readUInt8(MAGIC.length) !== VERSION) {
      throw new Error('Unsupported telegram envelope version');
    }

    let offset = MAGIC.length + 1;
    const salt = Buffer.from(envelope.subarray(offset, offset + 32));
    offset += 32;
    const chunkSize = envelope.readUInt32LE(offset);
    offset += 4;
    const ivPrefix = Buffer.from(envelope.subarray(offset, offset + IV_SIZE - 8));
    offset = headerLength - 8;
    const plaintextLength = Number(envelope.readBigUInt64LE(offset));

    const fileKey = this.deriveFileKey(vaultKey, salt);
    const chunkCount = Math.ceil(plaintextLength / chunkSize);
    const parts: Buffer[] = [];
    let cursor = headerLength;

    for (let i = 0; i < chunkCount; i++) {
      const thisPlainLength = Math.min(chunkSize, plaintextLength - i * chunkSize);
      const recordLength = thisPlainLength + AUTH_TAG_SIZE;
      if (cursor + recordLength > envelope.length) {
        throw new Error(`Telegram envelope is truncated at chunk ${i}`);
      }
      const record = envelope.subarray(cursor, cursor + recordLength);
      cursor += recordLength;

      const tag = record.subarray(record.length - AUTH_TAG_SIZE);
      const body = record.subarray(0, record.length - AUTH_TAG_SIZE);
      const decipher = createDecipheriv(TG_ENC_CONSTANTS.CIPHER, fileKey, this.chunkIv(ivPrefix, i), {
        authTagLength: AUTH_TAG_SIZE,
      });
      decipher.setAAD(this.chunkAad(salt, i, thisPlainLength));
      decipher.setAuthTag(tag);
      parts.push(Buffer.concat([decipher.update(body), decipher.final()]));
    }

    if (cursor !== envelope.length) {
      throw new Error('Telegram envelope has trailing bytes');
    }

    const plaintext = Buffer.concat(parts);
    if (plaintext.length !== plaintextLength) {
      throw new Error('Telegram envelope length mismatch');
    }
    return plaintext;
  }

  /** Encrypt a file on disk to another path. Returns the encrypted byte count. */
  async encryptFile(sourcePath: string, targetPath: string, vaultKey: Buffer): Promise<number> {
    const { size } = await stat(sourcePath);
    const write = createWriteStream(targetPath);
    let written = 0;

    const read = createReadStream(sourcePath, { highWaterMark: TG_ENC_CONSTANTS.CHUNK_SIZE });
    const salt = randomBytes(32);
    const ivPrefix = randomBytes(TG_ENC_CONSTANTS.IV_SIZE - 8);
    const fileKey = this.deriveFileKey(vaultKey, salt);

    const header = Buffer.alloc(TG_ENC_CONSTANTS.MAGIC.length + 1 + 32 + 4 + ivPrefix.length + 8);
    let offset = 0;
    header.write(TG_ENC_CONSTANTS.MAGIC, offset, 'ascii');
    offset += TG_ENC_CONSTANTS.MAGIC.length;
    header.writeUInt8(TG_ENC_CONSTANTS.VERSION, offset);
    offset += 1;
    salt.copy(header, offset);
    offset += 32;
    header.writeUInt32LE(TG_ENC_CONSTANTS.CHUNK_SIZE, offset);
    offset += 4;
    ivPrefix.copy(header, offset);
    offset += ivPrefix.length;
    header.writeBigUInt64LE(BigInt(size), offset);

    write.write(header);
    written += header.length;

    let index = 0;
    for await (const chunk of read) {
      const plain = chunk as Buffer;
      const cipher = createCipheriv(TG_ENC_CONSTANTS.CIPHER, fileKey, this.chunkIv(ivPrefix, index), {
        authTagLength: TG_ENC_CONSTANTS.AUTH_TAG_SIZE,
      });
      cipher.setAAD(this.chunkAad(salt, index, plain.length));
      const record = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
      write.write(record);
      written += record.length;
      index++;
    }

    await new Promise<void>((resolve, reject) => {
      write.end((error?: Error | null) => (error ? reject(error) : resolve()));
    });

    return written;
  }

  /** Decrypt a file on disk to another path. Verifies every chunk before writing. */
  async decryptFile(sourcePath: string, targetPath: string, vaultKey: Buffer): Promise<number> {
    const { size } = await stat(sourcePath);
    if (size > 512 * 1024 * 1024) {
      throw new Error('Encrypted file too large for in-memory envelope decryption');
    }
    const envelope = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      createReadStream(sourcePath)
        .on('data', (chunk) => chunks.push(chunk as Buffer))
        .on('error', reject)
        .on('end', () => resolve(Buffer.concat(chunks)));
    });
    const plaintext = this.decryptBuffer(envelope, vaultKey);
    await pipeline(async function* () {
      yield plaintext;
    }, createWriteStream(targetPath));
    return plaintext.length;
  }

  /** Constant-time compare used by integrity checks. */
  equals(a: Buffer, b: Buffer): boolean {
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
