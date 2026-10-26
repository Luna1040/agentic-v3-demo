/**
 * Client turn ids are idempotency keys, not credentials: the server only uses them to
 * replay an already accepted turn instead of charging for it twice. `crypto.randomUUID()`
 * is restricted to secure contexts, so plain-HTTP origins (a LAN host name or an IP)
 * need a capability-checked fallback. Keep this module dependency-free: it runs inside
 * the browser bundle and in plain Node tests.
 */
export interface ClientTurnIdCrypto {
  randomUUID?: () => string;
  getRandomValues?: <T extends Uint8Array>(array: T) => T;
}

let fallbackSequence = 0;

function fallbackId(): string {
  // Math.random is not a security primitive, but combined with the clock and a
  // per-module sequence it still makes an accidental duplicate key practically
  // impossible for the non-authenticating, per-session purpose of this id.
  fallbackSequence = (fallbackSequence + 1) % 0x1000000;
  const now = Date.now().toString(36);
  const clock = typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? Math.floor(performance.now() * 1000).toString(36)
    : '';
  const entropy = Math.floor(Math.random() * 0x100000000).toString(36)
    + Math.floor(Math.random() * 0x100000000).toString(36);
  // The server accepts at most 100 characters for this field; stay far below that.
  return `ctid-${now}-${clock}-${fallbackSequence.toString(36)}-${entropy}`;
}

function uuidFromBytes(bytes: Uint8Array): string {
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createClientTurnId(): string {
  const source = globalThis.crypto as ClientTurnIdCrypto | undefined;
  if (source && typeof source.randomUUID === 'function') {
    try {
      // Bind the receiver: a test double or a host polyfill may rely on `this`.
      const value = source.randomUUID.call(source);
      if (typeof value === 'string' && value.length > 0) return value;
    } catch {
      // A present-but-failing implementation must not prevent sending.
    }
  }
  if (source && typeof source.getRandomValues === 'function') {
    try {
      const bytes = new Uint8Array(16);
      const filled = source.getRandomValues(bytes);
      return uuidFromBytes(filled instanceof Uint8Array && filled.byteLength === 16 ? filled : bytes);
    } catch {
      // Fall through to the non-crypto fallback.
    }
  }
  return fallbackId();
}
