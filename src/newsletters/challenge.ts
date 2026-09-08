import type { Env } from '../env';
import { parseBase64UrlJsonPayload, solutionMeetsDifficulty } from '../challenge';
import { constantTimeEqual, encodeBase64Url, randomBase64Url, signDerivedHmacSha256Base64Url } from '../crypto';
import { errorResponse, getClientIP, jsonResponse, resolveCorsContext, validateQueryKeys, withCorsHeaders } from '../http';
import { getLogErrorMessage, logError } from '../log';
import { applyPublicRateLimit } from '../rate-limit';
import { formatDateToUtcSecondIso } from '../time';
import { getEdgeTokenSigningSecret } from '../token-secret';
import { getEdgeRuntimeSettings } from '../runtime-settings';
import { createWriteVerificationDescriptor } from '../turnstile';
import { parseNewsletterSlug } from './validation';

export const NEWSLETTER_CHALLENGE_API_PATH = '/api/newsletters/:slug/challenge/:scope';
export const NEWSLETTER_CHALLENGE_TOKEN_BODY_KEY = 'newsletter_challenge_token';
export const NEWSLETTER_CHALLENGE_SOLUTION_BODY_KEY = 'newsletter_challenge_solution';

const NEWSLETTER_CHALLENGE_ALLOWED_QUERY_KEYS = new Set<string>();
const NEWSLETTER_CHALLENGE_TOKEN_PATTERN = /^(n1)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/;
export const NEWSLETTER_SUBSCRIBE_POW_DIFFICULTY_BITS = 15;
export const NEWSLETTER_SUBSCRIBE_POW_LIFETIME_SECONDS = 60;
const NEWSLETTER_CHALLENGE_HMAC_INFO = 'zeropress-edge/newsletter-challenge/v1';

export type NewsletterChallengeScope = 'subscribe';

type NewsletterChallengePayload = {
  v: 1;
  typ: 'newsletter_challenge';
  slug: string;
  scope: NewsletterChallengeScope;
  iat: number;
  exp: number;
  nonce: string;
  difficulty: number;
};

export type NewsletterChallengeVerificationResult = {
  ok: boolean;
  expiresAtSeconds?: number;
  code?: string;
  message?: string;
};

export async function handleNewsletterChallengeRequest(
  request: Request,
  env: Env,
  slugSegment: string,
  scopeSegment: string,
): Promise<Response> {
  const cors = resolveCorsContext(request, env);
  if (!cors.allowed) {
    return errorResponse(request, env, 'CORS_ORIGIN_DENIED', 'The request origin is not allowed.', 403, [], cors);
  }

  if (request.method === 'OPTIONS') {
    const requestedMethod = request.headers.get('Access-Control-Request-Method');
    if (requestedMethod && requestedMethod.toUpperCase() !== 'GET') {
      return errorResponse(request, env, 'METHOD_NOT_ALLOWED', 'Method Not Allowed', 405, [], cors, {
        allow: 'GET, OPTIONS',
      });
    }

    const headers = withCorsHeaders(new Headers(), cors, true);
    headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
    return new Response(null, {
      status: 204,
      headers,
    });
  }

  if (request.method !== 'GET') {
    return errorResponse(request, env, 'METHOD_NOT_ALLOWED', 'Method Not Allowed', 405, [], cors, {
      allow: 'GET, OPTIONS',
    });
  }

  const queryError = validateQueryKeys(request, NEWSLETTER_CHALLENGE_ALLOWED_QUERY_KEYS);
  if (queryError) {
    return errorResponse(request, env, queryError.code, queryError.message, 400, queryError.errors, cors);
  }

  const slug = parseNewsletterSlug(slugSegment);
  if (!slug) {
    return errorResponse(request, env, 'INVALID_NEWSLETTER_SLUG', 'Newsletter slug is invalid.', 400, [
      { field: 'slug', message: 'Expected a lowercase URL slug.' },
    ], cors);
  }

  const scope = parseNewsletterChallengeScope(scopeSegment);
  if (!scope) {
    return errorResponse(request, env, 'INVALID_NEWSLETTER_CHALLENGE_SCOPE', 'The scope path parameter must be subscribe.', 400, [
      { field: 'scope', message: 'Expected subscribe path parameter.' },
    ], cors);
  }

  const rateLimitResponse = await applyPublicRateLimit({
    request, env, cors,
    binding: 'NEWSLETTER_CHALLENGE_RATE_LIMITER',
    key: getClientIP(request),
    rateLimitedMessage: 'Too many newsletter challenge attempts. Try again later.',
  });
  if (rateLimitResponse) return rateLimitResponse;

  const runtimeSettingsResult = await getEdgeRuntimeSettings(env);
  if (!runtimeSettingsResult.ok) {
    return errorResponse(request, env, runtimeSettingsResult.code, runtimeSettingsResult.message, 503, [], cors);
  }
  const { settings: runtimeSettings } = runtimeSettingsResult;
  const verificationMode = runtimeSettings.newsletterSubscribeVerificationMode;

  const descriptorResult = createWriteVerificationDescriptor(
    env,
    runtimeSettings.turnstileSitekey,
    verificationMode,
    'newsletter_subscribe',
  );
  if (!descriptorResult.ok) {
    return errorResponse(request, env, descriptorResult.code, descriptorResult.message, 503, [], cors);
  }

  try {
    if (verificationMode === 'turnstile') {
      return jsonResponse({
        item: {
          ...descriptorResult.descriptor,
          scope,
        },
      }, 200, request, env, cors);
    }

    const secret = getNewsletterChallengeSecret(env);
    if (!secret) {
      return errorResponse(
        request,
        env,
        'NEWSLETTER_CHALLENGE_NOT_AVAILABLE',
        'Newsletter challenge is not available.',
        503,
        [],
        cors,
      );
    }

    return jsonResponse({
      item: {
        ...descriptorResult.descriptor,
        scope,
        pow: await createNewsletterChallenge(env, slug, scope, secret),
      },
    }, 200, request, env, cors);
  } catch (error) {
    logError('Newsletter challenge failed', { errorMessage: getLogErrorMessage(error) });
    return errorResponse(request, env, 'INTERNAL_ERROR', 'Internal Server Error', 500, [], cors);
  }
}

export async function verifyNewsletterChallenge(
  env: Env,
  slug: string,
  scope: NewsletterChallengeScope,
  token: string,
  solution: string,
  now = new Date(),
): Promise<NewsletterChallengeVerificationResult> {
  const normalizedToken = String(token || '').trim();
  const normalizedSolution = String(solution || '').trim();
  if (!normalizedToken || !normalizedSolution) {
    return {
      ok: false,
      code: 'MISSING_NEWSLETTER_CHALLENGE',
      message: 'Newsletter challenge token and solution are required.',
    };
  }

  if (!/^\d{1,16}$/.test(normalizedSolution)) {
    return invalidChallenge();
  }

  const match = normalizedToken.match(NEWSLETTER_CHALLENGE_TOKEN_PATTERN);
  if (!match) {
    return invalidChallenge();
  }

  const [, version, payloadSegment, signature] = match;
  if (version !== 'n1') {
    return invalidChallenge();
  }

  const payload = parseBase64UrlJsonPayload(payloadSegment, isNewsletterChallengePayload);
  if (!payload || payload.slug !== slug || payload.scope !== scope) {
    return invalidChallenge();
  }

  if (payload.exp * 1000 < now.getTime()) {
    return {
      ok: false,
      code: 'EXPIRED_NEWSLETTER_CHALLENGE',
      message: 'Newsletter challenge has expired.',
    };
  }

  const secret = getNewsletterChallengeSecret(env);
  if (!secret) {
    return {
      ok: false,
      code: 'NEWSLETTER_CHALLENGE_NOT_AVAILABLE',
      message: 'Newsletter challenge is not available.',
    };
  }

  const signatureMessage = buildChallengeSignatureMessage(payloadSegment);
  const expectedSignature = await signDerivedHmacSha256Base64Url(secret, NEWSLETTER_CHALLENGE_HMAC_INFO, signatureMessage);
  if (!constantTimeEqual(signature, expectedSignature)) {
    return invalidChallenge();
  }

  const solved = await solutionMeetsDifficulty(normalizedToken, normalizedSolution, payload.difficulty);
  return solved ? { ok: true, expiresAtSeconds: payload.exp } : invalidChallenge();
}

function parseNewsletterChallengeScope(value: string | null): NewsletterChallengeScope | null {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'subscribe' ? normalized : null;
}

async function createNewsletterChallenge(
  env: Env,
  slug: string,
  scope: NewsletterChallengeScope,
  secret: string,
): Promise<{
  algorithm: 'zp-newsletter-pow-v1';
  scope: NewsletterChallengeScope;
  difficulty: number;
  expires_at: string;
  challenge_token: string;
}> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const payload: NewsletterChallengePayload = {
    v: 1,
    typ: 'newsletter_challenge',
    slug,
    scope,
    iat: nowSeconds,
    exp: nowSeconds + NEWSLETTER_SUBSCRIBE_POW_LIFETIME_SECONDS,
    nonce: randomBase64Url(16),
    difficulty: NEWSLETTER_SUBSCRIBE_POW_DIFFICULTY_BITS,
  };
  const payloadSegment = encodeBase64Url(JSON.stringify(payload));
  const signatureMessage = buildChallengeSignatureMessage(payloadSegment);
  const signature = await signDerivedHmacSha256Base64Url(secret, NEWSLETTER_CHALLENGE_HMAC_INFO, signatureMessage);

  return {
    algorithm: 'zp-newsletter-pow-v1',
    scope,
    difficulty: payload.difficulty,
    expires_at: formatDateToUtcSecondIso(new Date(payload.exp * 1000)),
    challenge_token: `${signatureMessage}.${signature}`,
  };
}

function isNewsletterChallengePayload(value: unknown): value is NewsletterChallengePayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return record.v === 1 &&
    record.typ === 'newsletter_challenge' &&
    typeof record.slug === 'string' &&
    parseNewsletterSlug(record.slug) === record.slug &&
    record.scope === 'subscribe' &&
    typeof record.iat === 'number' &&
    Number.isInteger(record.iat) &&
    typeof record.exp === 'number' &&
    Number.isInteger(record.exp) &&
    typeof record.nonce === 'string' &&
    record.nonce.length > 0 &&
    typeof record.difficulty === 'number' &&
    Number.isInteger(record.difficulty) &&
    record.difficulty >= 0 &&
    record.difficulty <= 24;
}

function buildChallengeSignatureMessage(payloadSegment: string): string {
  return `n1.${payloadSegment}`;
}

function getNewsletterChallengeSecret(env: Env): string {
  return getEdgeTokenSigningSecret(env);
}

function invalidChallenge(): NewsletterChallengeVerificationResult {
  return {
    ok: false,
    code: 'INVALID_NEWSLETTER_CHALLENGE',
    message: 'Newsletter challenge is invalid.',
  };
}
