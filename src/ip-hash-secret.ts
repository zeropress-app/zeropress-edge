import type { Env } from './env';
import { logWarn } from './log';

export const IP_HASH_SECRET_MIN_LENGTH = 64;

let warnedInvalidIpHashSecret = false;

export function getIpHashSecret(env: Env): string {
  const secret = String(env.IP_HASH_SECRET || '').trim();
  if (secret.length >= IP_HASH_SECRET_MIN_LENGTH) {
    return secret;
  }

  if (!warnedInvalidIpHashSecret) {
    warnedInvalidIpHashSecret = true;
    logWarn('IP_HASH_SECRET is missing or too short', {
      guidance: 'Generate one with: openssl rand -hex 32',
    });
  }

  return '';
}
