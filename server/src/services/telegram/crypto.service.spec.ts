import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, beforeEach } from 'vitest';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { TelegramCryptoService } from 'src/services/telegram/crypto.service.js';

describe(TelegramCryptoService.name, () => {
  let sut: TelegramCryptoService;
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tg-crypto-'));
    sut = new TelegramCryptoService(LoggingRepository.create({}));
  });

  it('roundtrips a small buffer', () => {
    const vaultKey = randomBytes(32);
    const plaintext = Buffer.from('hello immich telegram storage');
    const envelope = sut.encryptBuffer(plaintext, vaultKey);
    expect(sut.decryptBuffer(envelope, vaultKey)).toEqual(plaintext);
  });

  it('roundtrips a multi-chunk buffer', { timeout: 30_000 }, () => {
    const vaultKey = randomBytes(32);
    const plaintext = randomBytes(3 * 1024 * 1024 + 7);
    const envelope = sut.encryptBuffer(plaintext, vaultKey);
    expect(sut.decryptBuffer(envelope, vaultKey)).toEqual(plaintext);
  });

  it('rejects a tampered envelope', () => {
    const vaultKey = randomBytes(32);
    const envelope = sut.encryptBuffer(Buffer.from('secret'), vaultKey);
    envelope[envelope.length - 1] ^= 0xff;
    expect(() => sut.decryptBuffer(envelope, vaultKey)).toThrow();
  });

  it('rejects a wrong key', () => {
    const envelope = sut.encryptBuffer(Buffer.from('secret'), randomBytes(32));
    expect(() => sut.decryptBuffer(envelope, randomBytes(32))).toThrow();
  });

  it('rejects a truncated envelope', () => {
    const vaultKey = randomBytes(32);
    const envelope = sut.encryptBuffer(randomBytes(5 * 1024 * 1024), vaultKey);
    expect(() => sut.decryptBuffer(envelope.subarray(0, envelope.length - 100), vaultKey)).toThrow();
  });

  it('roundtrips through file paths', { timeout: 30_000 }, async () => {
    const vaultKey = randomBytes(32);
    const plaintext = randomBytes(2 * 1024 * 1024 + 123);
    const source = join(dir, 'source.bin');
    const target = join(dir, 'target.bin');
    const restored = join(dir, 'restored.bin');
    await writeFile(source, plaintext);

    await sut.encryptFile(source, target, vaultKey);
    await sut.decryptFile(target, restored, vaultKey);
    expect(await readFile(restored)).toEqual(plaintext);
  });

  it('generates and validates vault keys', () => {
    const hex = sut.generateVaultKey();
    expect(hex).toHaveLength(64);
    expect(sut.parseVaultKey(hex)).toHaveLength(32);
    expect(() => sut.parseVaultKey('abc')).toThrow();
  });
});
