import { decodeBase64Url } from './crypto';

export function parseBase64UrlJsonPayload<T>(
  payloadSegment: string,
  isPayload: (value: unknown) => value is T,
): T | null {
  try {
    const json = new TextDecoder().decode(decodeBase64Url(payloadSegment));
    const parsed = JSON.parse(json) as unknown;
    return isPayload(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function solutionMeetsDifficulty(
  challengeToken: string,
  solution: string,
  difficulty: number,
): Promise<boolean> {
  if (difficulty <= 0) {
    return true;
  }

  const digest = new Uint8Array(await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${challengeToken}.${solution}`),
  ));
  return hasLeadingZeroBits(digest, difficulty);
}

function hasLeadingZeroBits(bytes: Uint8Array, bitCount: number): boolean {
  let remaining = bitCount;
  for (const byte of bytes) {
    if (remaining <= 0) return true;
    if (remaining >= 8) {
      if (byte !== 0) return false;
      remaining -= 8;
      continue;
    }

    const mask = (0xff << (8 - remaining)) & 0xff;
    return (byte & mask) === 0;
  }

  return remaining <= 0;
}
