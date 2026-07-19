/**
 * Shared secret for per-user AES-256-GCM script key derivation.
 *
 * IMPORTANT: This value MUST match SCRIPT_RUNTIME_SECRET in the server's .env.
 * Change both before deploying to production — rebuild the client after changing.
 *
 * Key derivation: HMAC-SHA256(SCRIPT_RUNTIME_SECRET, "${userId}:${hwid}")
 * The resulting 32-byte key is unique to each user on each machine.
 */
export const SCRIPT_RUNTIME_SECRET = 'luther-script-runtime-dev-key-2024';
