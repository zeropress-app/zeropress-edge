import type { Env } from './env';
import { logWarn } from './log';

export const EDGE_TOKEN_SIGNING_SECRET_MIN_LENGTH = 64;

let warnedInvalidEdgeTokenSigningSecret = false;

export function getEdgeTokenSigningSecret(env: Env): string {
  const secret = String(env.EDGE_TOKEN_SIGNING_SECRET || '').trim();
  if (secret.length >= EDGE_TOKEN_SIGNING_SECRET_MIN_LENGTH) {
    return secret;
  }

  if (!warnedInvalidEdgeTokenSigningSecret) {
    warnedInvalidEdgeTokenSigningSecret = true;
    logWarn('EDGE_TOKEN_SIGNING_SECRET is missing or too short', {
      guidance: 'Generate one with: openssl rand -hex 32',
    });
  }

  return '';
}
