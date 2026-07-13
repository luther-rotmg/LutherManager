/**
 * AES-256-GCM decryption for HWID-bound marketplace script delivery.
 *
 * The server encrypts each script with a key derived from:
 *   HMAC-SHA256(SCRIPT_RUNTIME_SECRET, "${userId}:${hwid}")
 *
 * This module derives the same key and decrypts the payload back to
 * a plain UTF-8 source string — all in memory, nothing written to disk.
 */
import { createDecipheriv, createHmac } from 'crypto';
import { SCRIPT_RUNTIME_SECRET } from '../constants/RuntimeSecret.js';

export interface ScriptRuntimePayload {
  iv: string;         // base64, 12 bytes
  ciphertext: string; // base64
  tag: string;        // base64, 16 bytes
}

/**
 * Derive the per-user AES-256-GCM key.
 * Returns 32 bytes (HMAC-SHA256 output).
 */
function deriveKey(userId: string, hwid: string): Buffer {
  return createHmac('sha256', SCRIPT_RUNTIME_SECRET)
    .update(`${userId}:${hwid}`)
    .digest();
}

/**
 * Decrypt an HWID-bound encrypted script payload.
 * Returns the plaintext .mjs source code as a string.
 *
 * Throws if the auth tag fails (tampered ciphertext or wrong user/hwid).
 */
export function decryptScript(
  payload: ScriptRuntimePayload,
  userId: string,
  hwid: string,
): string {
  const key = deriveKey(userId, hwid);
  const iv = Buffer.from(payload.iv, 'base64');
  const ciphertext = Buffer.from(payload.ciphertext, 'base64');
  const tag = Buffer.from(payload.tag, 'base64');

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf8');
}
