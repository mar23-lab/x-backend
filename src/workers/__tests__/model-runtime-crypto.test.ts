// model-runtime-crypto.test.ts · Wave C · the encryption-at-rest primitive for customer provider keys.
// Proves the security-critical properties: round-trip, per-encryption IV uniqueness (GCM safety),
// tamper-detection (auth tag), fixed-length masking, and fail-closed behavior on a missing/malformed key.

import { describe, it, expect } from 'vitest';
import {
  encryptCredential,
  decryptCredential,
  lastFour,
  renderMaskedCredential,
  isEncryptionConfigured,
} from '../lib/model-runtime-crypto';

// A deterministic, valid 32-byte (AES-256) base64 key for the tests.
const KEY = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff)));

describe('model-runtime-crypto', () => {
  it('round-trips a credential (encrypt → decrypt returns the original plaintext)', async () => {
    const plaintext = JSON.stringify({ api_key: 'sk-ant-api03-SECRET-abcd1234' });
    const sealed = await encryptCredential(KEY, plaintext);
    expect(await decryptCredential(KEY, sealed)).toBe(plaintext);
  });

  it('uses a fresh IV per encryption — same plaintext yields different iv AND different ciphertext', async () => {
    const pt = 'the-same-secret';
    const a = await encryptCredential(KEY, pt);
    const b = await encryptCredential(KEY, pt);
    expect(a.iv).not.toBe(b.iv); // GCM is catastrophically broken by IV reuse
    expect(a.ciphertext).not.toBe(b.ciphertext); // semantic security: identical plaintext ≠ identical ciphertext
    // both still decrypt to the same plaintext
    expect(await decryptCredential(KEY, a)).toBe(pt);
    expect(await decryptCredential(KEY, b)).toBe(pt);
  });

  it('detects tampering — a modified ciphertext fails the GCM auth tag', async () => {
    const sealed = await encryptCredential(KEY, 'secret');
    const tampered = { ...sealed, ciphertext: sealed.ciphertext.slice(0, -4) + (sealed.ciphertext.endsWith('AAAA') ? 'BBBB' : 'AAAA') };
    await expect(decryptCredential(KEY, tampered)).rejects.toBeTruthy();
  });

  it('a DIFFERENT key cannot decrypt — confidentiality holds across keys', async () => {
    const sealed = await encryptCredential(KEY, 'secret');
    const otherKey = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => (i * 11 + 5) & 0xff)));
    await expect(decryptCredential(otherKey, sealed)).rejects.toBeTruthy();
  });

  it('fails closed on a missing / malformed / wrong-length master key (never silently succeeds)', async () => {
    await expect(encryptCredential(undefined, 'x')).rejects.toThrow(/not configured/);
    await expect(encryptCredential('', 'x')).rejects.toThrow(/not configured/);
    await expect(encryptCredential('not-base64!!!', 'x')).rejects.toBeTruthy();
    await expect(encryptCredential(btoa('short'), 'x')).rejects.toThrow(/32 bytes/);
    expect(await isEncryptionConfigured(KEY)).toBe(true);
    expect(await isEncryptionConfigured(undefined)).toBe(false);
    expect(await isEncryptionConfigured(btoa('short'))).toBe(false);
  });

  it('masks to a fixed four-dot prefix + last4, and null when there is no credential', () => {
    expect(lastFour('sk-ant-api03-SECRET-abcd1234')).toBe('1234');
    expect(lastFour('abc')).toBe('abc'); // short secrets are not padded
    expect(renderMaskedCredential('1234')).toBe('····1234');
    expect(renderMaskedCredential(null)).toBeNull();
    expect(renderMaskedCredential('')).toBeNull();
    // the mask length is fixed (does not leak the real key length)
    expect(renderMaskedCredential('9999')).toHaveLength('····9999'.length);
  });
});
