import type { Env } from '../env';
import { constantTimeEqual, decodeBase64Url, encodeBase64Url, randomBase64Url, signDerivedHmacSha256Base64Url } from '../crypto';
import { getEdgeTokenSigningSecret } from '../token-secret';
import { parseNewsletterSlug } from './validation';

const CONFIRM_TOKEN_PATTERN = /^(nc1)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/;
const SUBSCRIPTION_ID_PATTERN = /^[0-9a-f]{32}$/;
const NEWSLETTER_CONFIRM_HMAC_INFO = 'zeropress-edge/newsletter-confirm/v1';

type NewsletterConfirmTokenPayload = {
  v: 1;
  typ: 'newsletter_confirm';
  slug: string;
  sid: string;
  iat: number;
  exp: number;
  nonce: string;
};

export type NewsletterConfirmTokenVerificationResult = {
  ok: boolean;
  subscriptionId?: string;
  code?: 'INVALID' | 'EXPIRED' | 'NOT_AVAILABLE';
};

export class NewsletterConfirmTokenUnavailableError extends Error {
  code = 'NEWSLETTER_CONFIRMATION_NOT_AVAILABLE';
}

export async function createNewsletterConfirmToken(
  env: Env,
  input: {
    slug: string;
    subscriptionId: string;
    issuedAt: Date;
    expiresAt: Date;
  },
): Promise<string> {
  const secret = getNewsletterConfirmSecret(env);
  if (!secret) {
    throw new NewsletterConfirmTokenUnavailableError('EDGE_TOKEN_SIGNING_SECRET is missing or too short.');
  }

  const payload: NewsletterConfirmTokenPayload = {
    v: 1,
    typ: 'newsletter_confirm',
    slug: input.slug,
    sid: input.subscriptionId,
    iat: Math.floor(input.issuedAt.getTime() / 1000),
    exp: Math.floor(input.expiresAt.getTime() / 1000),
    nonce: randomBase64Url(16),
  };
  const payloadSegment = encodeBase64Url(JSON.stringify(payload));
  const signatureMessage = buildConfirmTokenSignatureMessage(payloadSegment);
  const signature = await signDerivedHmacSha256Base64Url(secret, NEWSLETTER_CONFIRM_HMAC_INFO, signatureMessage);
  return `${signatureMessage}.${signature}`;
}

export async function verifyNewsletterConfirmToken(
  env: Env,
  slug: string,
  token: string,
  now = new Date(),
): Promise<NewsletterConfirmTokenVerificationResult> {
  const normalizedToken = String(token || '').trim();
  const match = normalizedToken.match(CONFIRM_TOKEN_PATTERN);
  if (!match) {
    return { ok: false, code: 'INVALID' };
  }

  const [, version, payloadSegment, signature] = match;
  if (version !== 'nc1') {
    return { ok: false, code: 'INVALID' };
  }

  const payload = parseConfirmPayload(payloadSegment);
  if (!payload || payload.slug !== slug) {
    return { ok: false, code: 'INVALID' };
  }

  if (payload.exp * 1000 < now.getTime()) {
    return { ok: false, code: 'EXPIRED' };
  }

  const secret = getNewsletterConfirmSecret(env);
  if (!secret) {
    return { ok: false, code: 'NOT_AVAILABLE' };
  }

  const signatureMessage = buildConfirmTokenSignatureMessage(payloadSegment);
  const expectedSignature = await signDerivedHmacSha256Base64Url(secret, NEWSLETTER_CONFIRM_HMAC_INFO, signatureMessage);
  if (!constantTimeEqual(signature, expectedSignature)) {
    return { ok: false, code: 'INVALID' };
  }

  return {
    ok: true,
    subscriptionId: payload.sid,
  };
}

function parseConfirmPayload(payloadSegment: string): NewsletterConfirmTokenPayload | null {
  try {
    const json = new TextDecoder().decode(decodeBase64Url(payloadSegment));
    const parsed = JSON.parse(json) as unknown;
    if (!isConfirmPayload(parsed)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function isConfirmPayload(value: unknown): value is NewsletterConfirmTokenPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return record.v === 1 &&
    record.typ === 'newsletter_confirm' &&
    typeof record.slug === 'string' &&
    parseNewsletterSlug(record.slug) === record.slug &&
    typeof record.sid === 'string' &&
    SUBSCRIPTION_ID_PATTERN.test(record.sid) &&
    typeof record.iat === 'number' &&
    Number.isInteger(record.iat) &&
    typeof record.exp === 'number' &&
    Number.isInteger(record.exp) &&
    typeof record.nonce === 'string' &&
    record.nonce.length > 0;
}

function buildConfirmTokenSignatureMessage(payloadSegment: string): string {
  return `nc1.${payloadSegment}`;
}

function getNewsletterConfirmSecret(env: Env): string {
  return getEdgeTokenSigningSecret(env);
}
