import type { Env } from '../env';
import { parseBase64UrlJsonPayload, solutionMeetsDifficulty } from '../challenge';
import { errorResponse, getClientIP, jsonResponse, parsePositiveIntegerString, resolveCorsContext, validateQueryKeys, withCorsHeaders } from '../http';
import { getLogErrorMessage, logError } from '../log';
import { applyPublicRateLimit } from '../rate-limit';
import {
  getCommentReadContext,
  getCommentWriteContext,
  type CommentReadContext,
} from './config';
import type { EdgeRuntimeSettings } from '../runtime-settings';
import { formatDateToUtcSecondIso } from '../time';
import { getEdgeTokenSigningSecret } from '../token-secret';
import {
  createWriteVerificationDescriptor,
  type WriteVerificationDescriptor,
} from '../turnstile';
import { constantTimeEqual, encodeBase64Url, randomBase64Url, signDerivedHmacSha256Base64Url } from './crypto';
import { getCommentTargetPolicy } from './repository';
import {
  COMMENT_REQUEST_TOKEN_QUERY_KEY,
  verifyCommentRequestTokenWithSecrets,
} from './token';
import type { CommentTargetPolicy, CommentTargetType } from './types';
import { rethrowEdgeDatabaseLifecycleQueryFailure } from '../database-lifecycle';

export const COMMENTS_CHALLENGE_API_PATH = '/api/:target_type/:target_id/comments/challenge/:scope';

export const COMMENT_CHALLENGE_TOKEN_QUERY_KEY = 'comment_challenge_token';
export const COMMENT_CHALLENGE_SOLUTION_QUERY_KEY = 'comment_challenge_solution';
export const COMMENT_CHALLENGE_TOKEN_BODY_KEY = 'comment_challenge_token';
export const COMMENT_CHALLENGE_SOLUTION_BODY_KEY = 'comment_challenge_solution';

const COMMENT_CHALLENGE_ALLOWED_QUERY_KEYS = new Set([
  COMMENT_REQUEST_TOKEN_QUERY_KEY,
]);
const CHALLENGE_TOKEN_PATTERN = /^(c3)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/;
export const COMMENT_READ_POW_DIFFICULTY_BITS = 14;
export const COMMENT_WRITE_POW_DIFFICULTY_BITS = 15;
export const COMMENT_READ_POW_LIFETIME_SECONDS = 300;
export const COMMENT_WRITE_POW_LIFETIME_SECONDS = 60;
const COMMENT_CHALLENGE_HMAC_INFO = 'zeropress-edge/comment-challenge/v2';

export type CommentChallengeScope = 'read' | 'write';

type CommentChallengePayload = {
  v: 2;
  typ: 'comment_challenge';
  target_type: CommentTargetType;
  target_public_id: number;
  target_nonce: string;
  scope: CommentChallengeScope;
  iat: number;
  exp: number;
  nonce: string;
  difficulty: number;
};

export type CommentChallengeVerificationResult = {
  ok: boolean;
  expiresAtSeconds?: number;
  code?: string;
  message?: string;
};

type ParsedCommentChallengeInput =
  | {
      ok: true;
      token: string;
      solution: string;
      payloadSegment: string;
      signature: string;
      payload: CommentChallengePayload;
    }
  | { ok: false; code: string; message: string };

export async function handleCommentChallengeRequest(
  request: Request,
  env: Env,
  targetType: CommentTargetType,
  targetIdSegment: string,
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

  const queryError = validateQueryKeys(request, COMMENT_CHALLENGE_ALLOWED_QUERY_KEYS);
  if (queryError) {
    return errorResponse(request, env, queryError.code, queryError.message, 400, queryError.errors, cors);
  }

  const url = new URL(request.url);
  const targetPublicId = parsePositiveIntegerString(targetIdSegment);
  if (!targetPublicId) {
    return errorResponse(request, env, 'INVALID_COMMENT_TARGET_ID', 'The comment target path parameter must be a positive integer.', 400, [
      { field: 'target_id', message: 'Expected a positive integer path parameter.' },
    ], cors);
  }

  const scope = parseCommentChallengeScope(scopeSegment);
  if (!scope) {
    return errorResponse(request, env, 'INVALID_COMMENT_CHALLENGE_SCOPE', 'The scope path parameter must be read or write.', 400, [
      { field: 'scope', message: 'Expected read or write path parameter.' },
    ], cors);
  }

  const rateLimitResponse = await applyPublicRateLimit({
    request, env, cors,
    binding: 'COMMENT_CHALLENGE_RATE_LIMITER',
    key: getClientIP(request),
    rateLimitedMessage: 'Too many comment challenge attempts. Try again later.',
  });
  if (rateLimitResponse) return rateLimitResponse;

  try {
    let context: CommentReadContext;
    let runtimeSettings: EdgeRuntimeSettings | null = null;
    if (scope === 'write') {
      const contextResult = await getCommentWriteContext(env);
      if (!contextResult.ok) {
        return errorResponse(request, env, contextResult.code, contextResult.message, 503, [], cors);
      }
      context = contextResult.context;
      runtimeSettings = contextResult.context.runtimeSettings;
    } else {
      context = await getCommentReadContext(env);
    }
    const { config, requestSecrets } = context;
    if (config.disallowComments) {
      return errorResponse(request, env, 'COMMENTS_DISABLED', 'Comments are disabled for this site.', 403, [], cors);
    }
    if (!config.apiBaseUrl) {
      return errorResponse(request, env, 'COMMENTS_NOT_FOUND', 'Comments are not available for this target.', 404, [], cors);
    }

    const targetPolicy = await getCommentTargetPolicy(env, { targetType, targetPublicId });
    if (!isAvailableCommentTarget(targetPolicy)) {
      return errorResponse(request, env, 'COMMENTS_NOT_FOUND', 'Comments are not available for this target.', 404, [], cors);
    }

    const tokenResult = await verifyCommentRequestTokenWithSecrets(
      requestSecrets,
      toTokenTarget(targetPolicy),
      url.searchParams.get(COMMENT_REQUEST_TOKEN_QUERY_KEY) ?? '',
    );
    if (!tokenResult.ok) {
      return errorResponse(
        request,
        env,
        tokenResult.code ?? 'INVALID_COMMENT_REQUEST_TOKEN',
        tokenResult.message ?? 'Comment request token is invalid.',
        403,
        [],
        cors,
      );
    }
    if (!requestSecrets) {
      return errorResponse(request, env, 'INVALID_COMMENT_REQUEST_TOKEN', 'Comment request token is invalid.', 403, [], cors);
    }

    if (scope === 'write') {
      if (!runtimeSettings) {
        throw new Error('Comment write runtime settings are unavailable.');
      }
      const descriptorResult = createWriteVerificationDescriptor(
        env,
        runtimeSettings.turnstileSitekey,
        runtimeSettings.commentWriteVerificationMode,
        'comment_create',
      );
      if (!descriptorResult.ok) {
        return errorResponse(request, env, descriptorResult.code, descriptorResult.message, 503, [], cors);
      }

      const verification = await createCommentWriteVerification(
        env,
        targetPolicy,
        descriptorResult.descriptor,
      );
      if (!verification) {
        return errorResponse(request, env, 'COMMENT_CHALLENGE_NOT_AVAILABLE', 'Comment challenge is not available.', 503, [], cors);
      }
      return jsonResponse({ item: verification }, 200, request, env, cors);
    }

    const challengeSecret = getCommentChallengeSecret(env);
    if (!challengeSecret) {
      return errorResponse(request, env, 'COMMENT_CHALLENGE_NOT_AVAILABLE', 'Comment challenge is not available.', 503, [], cors);
    }

    const challenge = await createCommentChallenge(env, targetPolicy, scope, challengeSecret);
    return jsonResponse({ item: challenge }, 200, request, env, cors);
  } catch (error) {
    rethrowEdgeDatabaseLifecycleQueryFailure(error);
    logError('Comment challenge failed', { errorMessage: getLogErrorMessage(error) });
    return errorResponse(request, env, 'INTERNAL_ERROR', 'Internal Server Error', 500, [], cors);
  }
}

async function createCommentWriteVerification(
  env: Env,
  targetPolicy: CommentTargetPolicy,
  descriptor: WriteVerificationDescriptor,
) {
  if (descriptor.mode === 'turnstile') {
    return {
      scope: 'write' as const,
      ...descriptor,
    };
  }

  const challengeSecret = getCommentChallengeSecret(env);
  if (!challengeSecret) {
    return null;
  }

  return {
    scope: 'write' as const,
    ...descriptor,
    pow: await createCommentChallenge(env, targetPolicy, 'write', challengeSecret),
  };
}

export async function verifyCommentChallenge(
  env: Env,
  targetPolicy: CommentTargetPolicy,
  scope: CommentChallengeScope,
  token: string,
  solution: string,
  now = new Date(),
): Promise<CommentChallengeVerificationResult> {
  const parsed = parseCommentChallengeInput(token, solution);
  if (!parsed.ok) return parsed;

  const { payload, payloadSegment, signature } = parsed;
  if (
    payload.target_type !== targetPolicy.target_type ||
    payload.target_public_id !== targetPolicy.public_id ||
    payload.target_nonce !== targetPolicy.request_token_nonce ||
    payload.scope !== scope
  ) {
    return invalidChallenge();
  }

  if (payload.exp * 1000 < now.getTime()) {
    return {
      ok: false,
      code: 'EXPIRED_COMMENT_CHALLENGE',
      message: 'Comment challenge has expired.',
    };
  }

  const secret = getCommentChallengeSecret(env);
  if (!secret) {
    return {
      ok: false,
      code: 'COMMENT_CHALLENGE_NOT_AVAILABLE',
      message: 'Comment challenge is not available.',
    };
  }

  const message = buildChallengeSignatureMessage(payloadSegment);
  const expectedSignature = await signDerivedHmacSha256Base64Url(secret, COMMENT_CHALLENGE_HMAC_INFO, message);
  if (!constantTimeEqual(signature, expectedSignature)) {
    return invalidChallenge();
  }

  const solved = await solutionMeetsDifficulty(parsed.token, parsed.solution, payload.difficulty);
  return solved ? { ok: true, expiresAtSeconds: payload.exp } : invalidChallenge();
}

// Syntax only: a parsed payload is untrusted until signature, target and PoW verification.
export function parseCommentChallengeInput(
  token: string,
  solution: string,
): ParsedCommentChallengeInput {
  const normalizedToken = String(token || '').trim();
  const normalizedSolution = String(solution || '').trim();
  if (!normalizedToken || !normalizedSolution) {
    return {
      ok: false,
      code: 'MISSING_COMMENT_CHALLENGE',
      message: 'Comment challenge token and solution are required.',
    };
  }

  if (!/^\d{1,16}$/.test(normalizedSolution)) {
    return invalidChallenge();
  }

  const match = normalizedToken.match(CHALLENGE_TOKEN_PATTERN);
  if (!match) {
    return invalidChallenge();
  }

  const [, version, payloadSegment, signature] = match;
  if (version !== 'c3') {
    return invalidChallenge();
  }

  const payload = parseBase64UrlJsonPayload(payloadSegment, isCommentChallengePayload);
  if (!payload) return invalidChallenge();

  return {
    ok: true,
    token: normalizedToken,
    solution: normalizedSolution,
    payloadSegment,
    signature,
    payload,
  };
}

function parseCommentChallengeScope(value: string | null): CommentChallengeScope | null {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'read' || normalized === 'write' ? normalized : null;
}

async function createCommentChallenge(
  env: Env,
  targetPolicy: CommentTargetPolicy,
  scope: CommentChallengeScope,
  secret: string,
): Promise<{
  algorithm: 'zp-comment-pow-v1';
  scope: CommentChallengeScope;
  difficulty: number;
  expires_at: string;
  challenge_token: string;
}> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const difficulty = scope === 'write'
    ? COMMENT_WRITE_POW_DIFFICULTY_BITS
    : COMMENT_READ_POW_DIFFICULTY_BITS;
  const lifetimeSeconds = scope === 'write'
    ? COMMENT_WRITE_POW_LIFETIME_SECONDS
    : COMMENT_READ_POW_LIFETIME_SECONDS;
  const payload: CommentChallengePayload = {
    v: 2,
    typ: 'comment_challenge',
    target_type: targetPolicy.target_type,
    target_public_id: targetPolicy.public_id,
    target_nonce: targetPolicy.request_token_nonce,
    scope,
    iat: nowSeconds,
    exp: nowSeconds + lifetimeSeconds,
    nonce: randomBase64Url(16),
    difficulty,
  };
  const payloadSegment = encodeBase64Url(JSON.stringify(payload));
  const signatureMessage = buildChallengeSignatureMessage(payloadSegment);
  const signature = await signDerivedHmacSha256Base64Url(secret, COMMENT_CHALLENGE_HMAC_INFO, signatureMessage);

  return {
    algorithm: 'zp-comment-pow-v1',
    scope,
    difficulty,
    expires_at: formatDateToUtcSecondIso(new Date(payload.exp * 1000)),
    challenge_token: `${signatureMessage}.${signature}`,
  };
}

function isCommentChallengePayload(value: unknown): value is CommentChallengePayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return record.v === 2 &&
    record.typ === 'comment_challenge' &&
    (record.target_type === 'post' || record.target_type === 'page') &&
    typeof record.target_public_id === 'number' &&
    Number.isInteger(record.target_public_id) &&
    record.target_public_id > 0 &&
    typeof record.target_nonce === 'string' &&
    record.target_nonce.length > 0 &&
    (record.scope === 'read' || record.scope === 'write') &&
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
  return `c3.${payloadSegment}`;
}

function isAvailableCommentTarget(
  target: CommentTargetPolicy | null,
): target is CommentTargetPolicy {
  return Boolean(target && target.status === 'published' && target.allow_comments === 1);
}

function toTokenTarget(target: CommentTargetPolicy) {
  return {
    targetType: target.target_type,
    targetPublicId: target.public_id,
    requestTokenNonce: target.request_token_nonce,
  };
}

function invalidChallenge(): Extract<ParsedCommentChallengeInput, { ok: false }> {
  return {
    ok: false,
    code: 'INVALID_COMMENT_CHALLENGE',
    message: 'Comment challenge is invalid.',
  };
}

function getCommentChallengeSecret(env: Env): string {
  return getEdgeTokenSigningSecret(env);
}
