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
import { parseFormSlug } from './validation';

export const FORM_CHALLENGE_API_PATH = '/api/forms/:slug/challenge/:scope';
export const FORM_CHALLENGE_TOKEN_BODY_KEY = 'form_challenge_token';
export const FORM_CHALLENGE_SOLUTION_BODY_KEY = 'form_challenge_solution';

const FORM_CHALLENGE_ALLOWED_QUERY_KEYS = new Set<string>();
const FORM_CHALLENGE_TOKEN_PATTERN = /^(f1)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/;
export const FORM_SUBMIT_POW_DIFFICULTY_BITS = 15;
export const FORM_SUBMIT_POW_LIFETIME_SECONDS = 60;
const FORM_CHALLENGE_HMAC_INFO = 'zeropress-edge/form-challenge/v1';

export type FormChallengeScope = 'submit';

type FormChallengePayload = {
  v: 1;
  typ: 'form_challenge';
  slug: string;
  scope: FormChallengeScope;
  iat: number;
  exp: number;
  nonce: string;
  difficulty: number;
};

export type FormChallengeVerificationResult = {
  ok: boolean;
  expiresAtSeconds?: number;
  code?: string;
  message?: string;
};

export async function handleFormChallengeRequest(
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
    return new Response(null, { status: 204, headers });
  }

  if (request.method !== 'GET') {
    return errorResponse(request, env, 'METHOD_NOT_ALLOWED', 'Method Not Allowed', 405, [], cors, {
      allow: 'GET, OPTIONS',
    });
  }

  const queryError = validateQueryKeys(request, FORM_CHALLENGE_ALLOWED_QUERY_KEYS);
  if (queryError) {
    return errorResponse(request, env, queryError.code, queryError.message, 400, queryError.errors, cors);
  }

  const slug = parseFormSlug(slugSegment);
  if (!slug) {
    return errorResponse(request, env, 'INVALID_FORM_SLUG', 'Form slug is invalid.', 400, [
      { field: 'slug', message: 'Expected a lowercase URL slug.' },
    ], cors);
  }

  const scope = parseFormChallengeScope(scopeSegment);
  if (!scope) {
    return errorResponse(request, env, 'INVALID_FORM_CHALLENGE_SCOPE', 'The scope path parameter must be submit.', 400, [
      { field: 'scope', message: 'Expected submit path parameter.' },
    ], cors);
  }

  const rateLimitResponse = await applyPublicRateLimit({
    request, env, cors,
    binding: 'FORM_CHALLENGE_RATE_LIMITER',
    key: getClientIP(request),
    rateLimitedMessage: 'Too many form challenge attempts. Try again later.',
  });
  if (rateLimitResponse) return rateLimitResponse;

  const runtimeSettingsResult = await getEdgeRuntimeSettings(env);
  if (!runtimeSettingsResult.ok) {
    return errorResponse(request, env, runtimeSettingsResult.code, runtimeSettingsResult.message, 503, [], cors);
  }
  const { settings: runtimeSettings } = runtimeSettingsResult;
  const verificationMode = runtimeSettings.formSubmitVerificationMode;

  const descriptorResult = createWriteVerificationDescriptor(
    env,
    runtimeSettings.turnstileSitekey,
    verificationMode,
    'form_submit',
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

    const secret = getFormChallengeSecret(env);
    if (!secret) {
      return errorResponse(request, env, 'FORM_CHALLENGE_NOT_AVAILABLE', 'Form challenge is not available.', 503, [], cors);
    }

    return jsonResponse({
      item: {
        ...descriptorResult.descriptor,
        scope,
        pow: await createFormChallenge(env, slug, scope, secret),
      },
    }, 200, request, env, cors);
  } catch (error) {
    logError('Form challenge failed', { errorMessage: getLogErrorMessage(error) });
    return errorResponse(request, env, 'INTERNAL_ERROR', 'Internal Server Error', 500, [], cors);
  }
}

export async function verifyFormChallenge(
  env: Env,
  slug: string,
  scope: FormChallengeScope,
  token: string,
  solution: string,
  now = new Date(),
): Promise<FormChallengeVerificationResult> {
  const normalizedToken = String(token || '').trim();
  const normalizedSolution = String(solution || '').trim();
  if (!normalizedToken || !normalizedSolution) {
    return {
      ok: false,
      code: 'MISSING_FORM_CHALLENGE',
      message: 'Form challenge token and solution are required.',
    };
  }

  if (!/^\d{1,16}$/.test(normalizedSolution)) {
    return invalidChallenge();
  }

  const match = normalizedToken.match(FORM_CHALLENGE_TOKEN_PATTERN);
  if (!match) {
    return invalidChallenge();
  }

  const [, version, payloadSegment, signature] = match;
  if (version !== 'f1') {
    return invalidChallenge();
  }

  const payload = parseBase64UrlJsonPayload(payloadSegment, isFormChallengePayload);
  if (!payload || payload.slug !== slug || payload.scope !== scope) {
    return invalidChallenge();
  }

  if (payload.exp * 1000 < now.getTime()) {
    return {
      ok: false,
      code: 'EXPIRED_FORM_CHALLENGE',
      message: 'Form challenge has expired.',
    };
  }

  const secret = getFormChallengeSecret(env);
  if (!secret) {
    return {
      ok: false,
      code: 'FORM_CHALLENGE_NOT_AVAILABLE',
      message: 'Form challenge is not available.',
    };
  }

  const signatureMessage = buildChallengeSignatureMessage(payloadSegment);
  const expectedSignature = await signDerivedHmacSha256Base64Url(secret, FORM_CHALLENGE_HMAC_INFO, signatureMessage);
  if (!constantTimeEqual(signature, expectedSignature)) {
    return invalidChallenge();
  }

  const solved = await solutionMeetsDifficulty(normalizedToken, normalizedSolution, payload.difficulty);
  return solved ? { ok: true, expiresAtSeconds: payload.exp } : invalidChallenge();
}

function parseFormChallengeScope(value: string | null): FormChallengeScope | null {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'submit' ? normalized : null;
}

async function createFormChallenge(
  env: Env,
  slug: string,
  scope: FormChallengeScope,
  secret: string,
): Promise<{
  algorithm: 'zp-form-pow-v1';
  scope: FormChallengeScope;
  difficulty: number;
  expires_at: string;
  challenge_token: string;
}> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const payload: FormChallengePayload = {
    v: 1,
    typ: 'form_challenge',
    slug,
    scope,
    iat: nowSeconds,
    exp: nowSeconds + FORM_SUBMIT_POW_LIFETIME_SECONDS,
    nonce: randomBase64Url(16),
    difficulty: FORM_SUBMIT_POW_DIFFICULTY_BITS,
  };
  const payloadSegment = encodeBase64Url(JSON.stringify(payload));
  const signatureMessage = buildChallengeSignatureMessage(payloadSegment);
  const signature = await signDerivedHmacSha256Base64Url(secret, FORM_CHALLENGE_HMAC_INFO, signatureMessage);

  return {
    algorithm: 'zp-form-pow-v1',
    scope,
    difficulty: payload.difficulty,
    expires_at: formatDateToUtcSecondIso(new Date(payload.exp * 1000)),
    challenge_token: `${signatureMessage}.${signature}`,
  };
}

function isFormChallengePayload(value: unknown): value is FormChallengePayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Partial<FormChallengePayload>;
  const difficulty = candidate.difficulty;
  return candidate.v === 1 &&
    candidate.typ === 'form_challenge' &&
    typeof candidate.slug === 'string' &&
    candidate.scope === 'submit' &&
    Number.isInteger(candidate.iat) &&
    Number.isInteger(candidate.exp) &&
    typeof candidate.nonce === 'string' &&
    Number.isInteger(difficulty) &&
    typeof difficulty === 'number' &&
    difficulty >= 0 &&
    difficulty <= 24;
}

function buildChallengeSignatureMessage(payloadSegment: string): string {
  return `f1.${payloadSegment}`;
}

function invalidChallenge(): FormChallengeVerificationResult {
  return {
    ok: false,
    code: 'INVALID_FORM_CHALLENGE',
    message: 'Form challenge is invalid.',
  };
}

function getFormChallengeSecret(env: Env): string {
  return getEdgeTokenSigningSecret(env);
}
