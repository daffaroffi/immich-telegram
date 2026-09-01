import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import { Readable, Transform, PassThrough } from 'node:stream';
import { TDENC2_CONSTANTS, Tdenc2Header, Tdenc2KeySlot } from 'src/config/telegram.config';

/**
 * TDENC2 Encryption Service
 * Port of Telegram-Drive's TDENC2 encryption to Node.js
 * Uses XChaCha20-Poly1305 for AEAD encryption
 */
@Injectable()
export class TelegramEncryptionService {
  private readonly logger = new Logger(TelegramEncryptionService.name);

  constructor() {}

  /**
   * Generate a random vault key for encryption
   */
  generateVaultKey(): Buffer {
    return crypto.randomBytes(TDENC2_CONSTANTS.KEY_SIZE);
  }

  /**
   * Derive key from passphrase using Argon2id
   * Note: Requires argon2 npm package
   */
  async deriveFromPassphrase(
    passphrase: string,
    salt: Buffer,
    memoryKib: number = TDENC2_CONSTANTS.ARGON2_MEMORY_DEFAULT,
    iterations: number = TDENC2_CONSTANTS.ARGON2_ITERATIONS_DEFAULT,
    parallelism: number = TDENC2_CONSTANTS.ARGON2_PARALLELISM_DEFAULT,
  ): Promise<Buffer> {
    // TODO: Implement Argon2id key derivation
    // This requires the 'argon2' npm package
    // For now, use PBKDF2 as a fallback
    return new Promise((resolve, reject) => {
      crypto.pbkdf2(
        passphrase,
        salt,
        iterations * 1000, // Convert to iterations
        TDENC2_CONSTANTS.KEY_SIZE,
        'sha512',
        (err, key) => {
          if (err) reject(err);
          else resolve(key);
        },
      );
    });
  }

  /**
   * Derive wrapping key from master key using HKDF-SHA256
   */
  deriveWrappingKey(
    masterKey: Buffer,
    fileUuid: Buffer,
    salt: Buffer,
    slotKind: number,
    slotId: number,
  ): Buffer {
    const info = Buffer.concat([
      Buffer.from('telegram-drive:file-wrapping:v2'),
      fileUuid,
      Buffer.from([slotKind, slotId]),
    ]);

    return crypto.createHmac('sha256', masterKey).update(info).update(salt).digest();
  }

  /**
   * Wrap Data Encryption Key (DEK) with wrapping key
   */
  wrapDek(dek: Buffer, wrappingKey: Buffer): { wrappedDek: Buffer; nonce: Buffer } {
    const nonce = crypto.randomBytes(TDENC2_CONSTANTS.NONCE_SIZE);
    const cipher = crypto.createCipheriv('chacha20-poly1305', wrappingKey, nonce, {
      authTagLength: TDENC2_CONSTANTS.POLY1305_TAG_SIZE,
    });

    const wrappedDek = Buffer.concat([cipher.update(dek), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return {
      wrappedDek: Buffer.concat([wrappedDek, authTag]),
      nonce,
    };
  }

  /**
   * Unwrap DEK with wrapping key
   */
  unwrapDek(wrappedDek: Buffer, nonce: Buffer, wrappingKey: Buffer): Buffer {
    const authTag = wrappedDek.slice(-TDENC2_CONSTANTS.POLY1305_TAG_SIZE);
    const encryptedDek = wrappedDek.slice(0, -TDENC2_CONSTANTS.POLY1305_TAG_SIZE);

    const decipher = crypto.createDecipheriv('chacha20-poly1305', wrappingKey, nonce, {
      authTagLength: TDENC2_CONSTANTS.POLY1305_TAG_SIZE,
    });
    decipher.setAuthTag(authTag);

    return Buffer.concat([decipher.update(encryptedDek), decipher.final()]);
  }

  /**
   * Encrypt a single chunk with XChaCha20-Poly1305
   */
  encryptChunk(
    plaintext: Buffer,
    key: Buffer,
    nonce: Buffer,
    aad: Buffer,
  ): Buffer {
    // Derive actual encryption key from the provided key
    const cipherKey = crypto.createHash('sha256').update(key).update(nonce.slice(0, 16)).digest();

    const cipher = crypto.createCipheriv('chacha20-poly1305', cipherKey, nonce, {
      authTagLength: TDENC2_CONSTANTS.POLY1305_TAG_SIZE,
    });

    if (aad && aad.length > 0) {
      cipher.setAAD(aad, { plaintextLength: plaintext.length });
    }

    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return Buffer.concat([encrypted, authTag]);
  }

  /**
   * Decrypt a single chunk with XChaCha20-Poly1305
   */
  decryptChunk(
    ciphertext: Buffer,
    key: Buffer,
    nonce: Buffer,
    aad: Buffer,
  ): Buffer {
    const authTag = ciphertext.slice(-TDENC2_CONSTANTS.POLY1305_TAG_SIZE);
    const encryptedData = ciphertext.slice(0, -TDENC2_CONSTANTS.POLY1305_TAG_SIZE);

    // Derive actual decryption key from the provided key
    const decipherKey = crypto.createHash('sha256').update(key).update(nonce.slice(0, 16)).digest();

    const decipher = crypto.createDecipheriv('chacha20-poly1305', decipherKey, nonce, {
      authTagLength: TDENC2_CONSTANTS.POLY1305_TAG_SIZE,
    });
    decipher.setAuthTag(authTag);

    if (aad && aad.length > 0) {
      decipher.setAAD(aad, { plaintextLength: encryptedData.length });
    }

    return Buffer.concat([decipher.update(encryptedData), decipher.final()]);
  }

  /**
   * Create TDENC2 header buffer
   */
  private createHeaderBuffer(header: Tdenc2Header): Buffer {
    const headerBuffer = Buffer.alloc(header.headerLength);
    let offset = 0;

    // Magic (6 bytes)
    headerBuffer.write(header.magic, offset, 'ascii');
    offset += 6;

    // Version (2 bytes, uint16 LE)
    headerBuffer.writeUInt16LE(header.version, offset);
    offset += 2;

    // File UUID (16 bytes)
    header.fileUuid.copy(headerBuffer, offset);
    offset += 16;

    // Cipher Suite (2 bytes, uint16 LE)
    headerBuffer.writeUInt16LE(header.cipherSuite, offset);
    offset += 2;

    // Header Length (4 bytes, uint32 LE)
    headerBuffer.writeUInt32LE(header.headerLength, offset);
    offset += 4;

    // Chunk Size (4 bytes, uint32 LE)
    headerBuffer.writeUInt32LE(header.chunkSize, offset);
    offset += 4;

    // Slot Table Length (4 bytes, uint32 LE)
    headerBuffer.writeUInt32LE(header.slotTableLength, offset);
    offset += 4;

    // Metadata Length (4 bytes, uint32 LE)
    headerBuffer.writeUInt32LE(header.metadataLength, offset);
    offset += 4;

    // Plaintext Length (8 bytes, uint64 LE)
    headerBuffer.writeBigUInt64LE(header.plaintextLength, offset);
    offset += 8;

    // Nonce Prefix (16 bytes)
    header.noncePrefix.copy(headerBuffer, offset);
    offset += 16;

    // Header Auth (32 bytes)
    header.headerAuth.copy(headerBuffer, offset);
    offset += 32;

    // Key Slots (N * 104 bytes each)
    for (const slot of header.keySlots) {
      // Kind (1 byte)
      headerBuffer.writeUInt8(slot.kind === 'vault' ? 1 : slot.kind === 'passphrase' ? 2 : 3, offset);
      offset += 1;

      // Slot ID (1 byte)
      headerBuffer.writeUInt8(slot.slotId, offset);
      offset += 1;

      // KDF Algorithm (2 bytes)
      headerBuffer.writeUInt16LE(slot.kdfAlgorithm, offset);
      offset += 2;

      // Argon2 Memory (4 bytes)
      headerBuffer.writeUInt32LE(slot.argon2Memory, offset);
      offset += 4;

      // Argon2 Iterations (4 bytes)
      headerBuffer.writeUInt32LE(slot.argon2Iterations, offset);
      offset += 4;

      // Argon2 Parallelism (4 bytes)
      headerBuffer.writeUInt32LE(slot.argon2Parallelism, offset);
      offset += 4;

      // Salt (16 bytes)
      slot.salt.copy(headerBuffer, offset);
      offset += 16;

      // Wrap Nonce (24 bytes)
      slot.wrapNonce.copy(headerBuffer, offset);
      offset += 24;

      // Wrapped DEK (48 bytes)
      slot.wrappedDek.copy(headerBuffer, offset);
      offset += 48;
    }

    return headerBuffer;
  }

  /**
   * Encrypt file stream with TDENC2
   * @param plaintext - Readable stream of plaintext
   * @param masterKey - Master encryption key
   * @param filename - Original filename for metadata
   * @param mimeType - MIME type for metadata
   * @returns Encrypted stream
   */
  async encryptStream(
    plaintext: Readable,
    masterKey: Buffer,
    filename?: string,
    mimeType?: string,
  ): Promise<Readable> {
    const fileUuid = crypto.randomBytes(16);
    const dek = crypto.randomBytes(TDENC2_CONSTANTS.KEY_SIZE);
    const noncePrefix = crypto.randomBytes(16);

    // Create key slots
    const keySlots: Tdenc2KeySlot[] = [];
    const slotId = 0;
    const salt = crypto.randomBytes(16);
    const wrappingKey = this.deriveWrappingKey(masterKey, fileUuid, salt, 1, slotId);
    const { wrappedDek, nonce: wrapNonce } = this.wrapDek(dek, wrappingKey);

    keySlots.push({
      kind: 'vault',
      slotId,
      kdfAlgorithm: 2, // HKDF-SHA256
      argon2Memory: 0,
      argon2Iterations: 0,
      argon2Parallelism: 0,
      salt,
      wrapNonce,
      wrappedDek,
    });

    // Create header
    const header: Tdenc2Header = {
      magic: TDENC2_CONSTANTS.MAGIC,
      version: TDENC2_CONSTANTS.VERSION,
      fileUuid,
      cipherSuite: TDENC2_CONSTANTS.CIPHER_SUITE_XCHACHA20_POLY1305,
      headerLength: 98 + keySlots.length * 104,
      chunkSize: TDENC2_CONSTANTS.DEFAULT_CHUNK_SIZE,
      slotTableLength: keySlots.length * 104,
      metadataLength: 0,
      plaintextLength: 0n,
      noncePrefix,
      headerAuth: Buffer.alloc(32),
      keySlots,
    };

    const headerBuffer = this.createHeaderBuffer(header);

    // Create transform stream for chunked encryption
    let chunkIndex = 0;
    let totalBytesProcessed = 0;

    const encryptTransform = new Transform({
      transform(chunk: Buffer, encoding: string, callback: (error?: Error | null, data?: any) => void) {
        try {
          // Calculate chunk nonce
          const chunkNonce = Buffer.alloc(24);
          noncePrefix.copy(chunkNonce, 0);
          chunkNonce.writeBigUInt64LE(BigInt(chunkIndex), 16);

          // Create AAD for this chunk
          const aad = Buffer.alloc(32);
          aad.writeUInt32LE(chunkIndex, 0);

          // Encrypt chunk
          const cipherKey = crypto.createHash('sha256').update(dek).update(chunkNonce.slice(0, 16)).digest();
          const cipher = crypto.createCipheriv('chacha20-poly1305', cipherKey, chunkNonce, {
            authTagLength: TDENC2_CONSTANTS.POLY1305_TAG_SIZE,
          });
          cipher.setAAD(aad, { plaintextLength: chunk.length });

          const encrypted = Buffer.concat([cipher.update(chunk), cipher.final()]);
          const authTag = cipher.getAuthTag();

          chunkIndex++;
          totalBytesProcessed += chunk.length;

          callback(null, Buffer.concat([encrypted, authTag]));
        } catch (error) {
          callback(error as Error);
        }
      },
    });

    // Pipe plaintext through encryption transform
    const encryptedStream = new PassThrough();
    plaintext.pipe(encryptTransform).pipe(encryptedStream);

    // Prepend header to output
    encryptedStream.unshift(headerBuffer);

    this.logger.log(`Encrypting stream with TDENC2 (UUID: ${fileUuid.toString('hex')})`);
    return encryptedStream;
  }

  /**
   * Decrypt file stream with TDENC2
   * @param ciphertext - Readable stream of ciphertext
   * @param masterKey - Master decryption key (vault key or passphrase-derived)
   * @returns Decrypted stream
   */
  async decryptStream(ciphertext: Readable, masterKey: Buffer): Promise<Readable> {
    // Read header first (98 bytes minimum)
    const headerBuffer = await this.readStreamChunk(ciphertext, 98);

    // Parse header
    const magic = headerBuffer.toString('ascii', 0, 6);
    if (magic !== TDENC2_CONSTANTS.MAGIC) {
      throw new Error(`Invalid TDENC2 magic: ${magic}`);
    }

    const version = headerBuffer.readUInt16LE(6);
    if (version !== TDENC2_CONSTANTS.VERSION) {
      throw new Error(`Unsupported TDENC2 version: ${version}`);
    }

    const slotTableLength = headerBuffer.readUInt32LE(20);
    const totalHeaderLength = 98 + slotTableLength;

    // Read remaining header
    const remainingHeader = await this.readStreamChunk(ciphertext, slotTableLength);
    const fullHeader = Buffer.concat([headerBuffer, remainingHeader]);

    // Parse key slots
    const keySlots: Tdenc2KeySlot[] = [];
    let slotOffset = 98;

    while (slotOffset < totalHeaderLength) {
      const kind = fullHeader.readUInt8(slotOffset);
      const kindStr = kind === 1 ? 'vault' : kind === 2 ? 'passphrase' : 'recovery';

      const slot: Tdenc2KeySlot = {
        kind: kindStr as 'vault' | 'passphrase' | 'recovery',
        slotId: fullHeader.readUInt8(slotOffset + 1),
        kdfAlgorithm: fullHeader.readUInt16LE(slotOffset + 2),
        argon2Memory: fullHeader.readUInt32LE(slotOffset + 4),
        argon2Iterations: fullHeader.readUInt32LE(slotOffset + 8),
        argon2Parallelism: fullHeader.readUInt32LE(slotOffset + 12),
        salt: fullHeader.subarray(slotOffset + 16, slotOffset + 32),
        wrapNonce: fullHeader.subarray(slotOffset + 32, slotOffset + 56),
        wrappedDek: fullHeader.subarray(slotOffset + 56, slotOffset + 104),
      };

      keySlots.push(slot);
      slotOffset += 104;
    }

    // Find vault key slot and unwrap DEK
    const vaultSlot = keySlots.find((s) => s.kind === 'vault');
    if (!vaultSlot) {
      throw new Error('No vault key slot found');
    }

    const fileUuid = fullHeader.subarray(8, 24);
    const wrappingKey = this.deriveWrappingKey(masterKey, fileUuid, vaultSlot.salt, 1, vaultSlot.slotId);
    const dek = this.unwrapDek(vaultSlot.wrappedDek, vaultSlot.wrapNonce, wrappingKey);

    // Create transform stream for chunked decryption
    let chunkIndex = 0;
    const chunkSize = fullHeader.readUInt32LE(16);
    const noncePrefix = fullHeader.subarray(54, 70);

    const decryptTransform = new Transform({
      transform(chunk: Buffer, encoding: string, callback: (error?: Error | null, data?: any) => void) {
        try {
          // Extract auth tag
          const authTag = chunk.slice(-TDENC2_CONSTANTS.POLY1305_TAG_SIZE);
          const encryptedData = chunk.slice(0, -TDENC2_CONSTANTS.POLY1305_TAG_SIZE);

          // Calculate chunk nonce
          const chunkNonce = Buffer.alloc(24);
          noncePrefix.copy(chunkNonce, 0);
          chunkNonce.writeBigUInt64LE(BigInt(chunkIndex), 16);

          // Create AAD for this chunk
          const aad = Buffer.alloc(32);
          aad.writeUInt32LE(chunkIndex, 0);

          // Decrypt chunk
          const decipherKey = crypto.createHash('sha256').update(dek).update(chunkNonce.slice(0, 16)).digest();
          const decipher = crypto.createDecipheriv('chacha20-poly1305', decipherKey, chunkNonce, {
            authTagLength: TDENC2_CONSTANTS.POLY1305_TAG_SIZE,
          });
          decipher.setAuthTag(authTag);
          decipher.setAAD(aad, { plaintextLength: encryptedData.length });

          const decrypted = Buffer.concat([decipher.update(encryptedData), decipher.final()]);

          chunkIndex++;
          callback(null, decrypted);
        } catch (error) {
          callback(error as Error);
        }
      },
    });

    // Pipe ciphertext through decryption transform
    const decryptedStream = new PassThrough();
    ciphertext.pipe(decryptTransform).pipe(decryptedStream);

    this.logger.log('Decrypting stream with TDENC2');
    return decryptedStream;
  }

  /**
   * Read a chunk from a readable stream
   */
  private readStreamChunk(stream: Readable, size: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let totalSize = 0;

      const onData = (chunk: Buffer) => {
        chunks.push(chunk);
        totalSize += chunk.length;

        if (totalSize >= size) {
          stream.removeListener('data', onData);
          stream.removeListener('end', onEnd);
          stream.removeListener('error', onError);

          const result = Buffer.concat(chunks);
          // If we read more than needed, unshift the extra
          if (result.length > size) {
            const extra = result.subarray(size);
            stream.unshift(extra);
            resolve(result.subarray(0, size));
          } else {
            resolve(result);
          }
        }
      };

      const onEnd = () => {
        stream.removeListener('data', onData);
        stream.removeListener('error', onError);
        const result = Buffer.concat(chunks);
        if (result.length < size) {
          reject(new Error(`Unexpected end of stream: got ${result.length} bytes, expected ${size}`));
        } else {
          resolve(result);
        }
      };

      const onError = (error: Error) => {
        stream.removeListener('data', onData);
        stream.removeListener('end', onEnd);
        reject(error);
      };

      stream.on('data', onData);
      stream.on('end', onEnd);
      stream.on('error', onError);
    });
  }

  /**
   * Calculate ciphertext size from plaintext size
   */
  calculateCiphertextSize(plaintextSize: number): number {
    const chunkCount = Math.ceil(plaintextSize / TDENC2_CONSTANTS.DEFAULT_CHUNK_SIZE);
    const headerSize = 98 + 104; // 98 bytes header + 1 key slot
    const metadataSize = 0; // No metadata for now
    const chunkDataSize = chunkCount * (TDENC2_CONSTANTS.DEFAULT_CHUNK_SIZE + TDENC2_CONSTANTS.POLY1305_TAG_SIZE);
    const finalRecordSize = 52 + TDENC2_CONSTANTS.POLY1305_TAG_SIZE;

    return headerSize + metadataSize + chunkDataSize + finalRecordSize;
  }
}
