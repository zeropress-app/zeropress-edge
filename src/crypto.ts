const textEncoder = new TextEncoder();
const HMAC_HKDF_SALT = textEncoder.encode('zeropress-edge/hmac/v1');

export function encodeBase64Url(bytes: Uint8Array | string): string {
  const rawBytes = typeof bytes === 'string'
    ? textEncoder.encode(bytes)
    : bytes;
  let binary = '';
  rawBytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });

  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

export function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function randomBase64Url(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return encodeBase64Url(bytes);
}

export async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(value));
  return encodeBase64Url(new Uint8Array(digest));
}

export async function signHmacSha256Base64Url(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    textEncoder.encode(message),
  );
  return encodeBase64Url(new Uint8Array(signature));
}

export async function signDerivedHmacSha256Base64Url(
  masterSecret: string,
  purpose: string,
  message: string,
): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(masterSecret),
    'HKDF',
    false,
    ['deriveKey'],
  );
  const key = await crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: HMAC_HKDF_SALT,
      info: textEncoder.encode(purpose),
    },
    keyMaterial,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    textEncoder.encode(message),
  );
  return encodeBase64Url(new Uint8Array(signature));
}

export function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = textEncoder.encode(left);
  const rightBytes = textEncoder.encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let diff = leftBytes.length ^ rightBytes.length;

  for (let index = 0; index < length; index += 1) {
    diff |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }

  return diff === 0;
}
