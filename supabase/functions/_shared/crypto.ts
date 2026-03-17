// supabase/functions/_shared/crypto.ts
// AES-256-GCM encryption/decryption for sensitive API keys stored in DB.
// Uses Web Crypto API (Deno native). Key from ENCRYPTION_KEY env var (base64).

const ENCRYPTED_PREFIX = "enc:";
const IV_LENGTH = 12; // 96-bit IV for AES-GCM (NIST recommended)

let _cryptoKey: CryptoKey | null = null;

async function getKey(): Promise<CryptoKey> {
  if (_cryptoKey) return _cryptoKey;
  const b64 = Deno.env.get("ENCRYPTION_KEY");
  if (!b64) throw new Error("ENCRYPTION_KEY env var not configured");
  const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  if (raw.length !== 32) {
    throw new Error("ENCRYPTION_KEY must be 256 bits (32 bytes) base64-encoded");
  }
  _cryptoKey = await crypto.subtle.importKey(
    "raw",
    raw,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
  return _cryptoKey;
}

/**
 * Encrypt a plaintext string.
 * Returns "enc:<base64(iv + ciphertext + tag)>".
 * IV is 12 random bytes prepended to the ciphertext.
 */
export async function encrypt(plaintext: string): Promise<string> {
  const key = await getKey();
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoded,
  );
  // Concatenate iv + ciphertext (includes GCM auth tag)
  const combined = new Uint8Array(IV_LENGTH + ciphertext.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(ciphertext), IV_LENGTH);
  return ENCRYPTED_PREFIX + btoa(String.fromCharCode(...combined));
}

/**
 * Decrypt a value.
 * If not prefixed with "enc:", returns as-is (legacy plaintext passthrough).
 * This allows seamless handling of both encrypted and unencrypted values.
 */
export async function decrypt(value: string): Promise<string> {
  if (!value.startsWith(ENCRYPTED_PREFIX)) return value; // legacy plaintext
  const key = await getKey();
  const combined = Uint8Array.from(
    atob(value.slice(ENCRYPTED_PREFIX.length)),
    (c) => c.charCodeAt(0),
  );
  const iv = combined.slice(0, IV_LENGTH);
  const ciphertext = combined.slice(IV_LENGTH);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ciphertext,
  );
  return new TextDecoder().decode(decrypted);
}

/** Check if a value is already encrypted. */
export function isEncrypted(value: string): boolean {
  return value.startsWith(ENCRYPTED_PREFIX);
}
