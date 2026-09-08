import type { Env } from '../env';
import { runInBackground } from '../background';
import { consumeUsedChallenge } from '../edge-kv';
import { errorResponse, getClientIP, jsonResponse, parseOptionalPage, parsePositiveIntegerString, resolveCorsContext, validateQueryKeys, withCorsHeaders } from '../http';
import { isApplicationJsonContentType, readBoundedJson } from '../json-body';
import { getLogErrorMessage, logError, logWarn } from '../log';
import { IpHashSecretUnavailableError, getClientNetworkMetadata } from '../request-metadata';
import { applyPublicRateLimit } from '../rate-limit';
import {
  applyTurnstileVerifyRateLimit,
  createWriteVerificationDescriptor,
  verifyTurnstileToken,
  type TurnstileVerificationResult,
} from '../turnstile';
import { getApprovedCommentRows, deleteCommentsCache } from './cache';
import {
  createCommentIdentityRateLimitKey,
  getBearerToken,
  verifySupabaseCommentIdentity,
  type AuthenticatedCommentIdentity,
} from './auth';
import { COMMENT_CHALLENGE_SOLUTION_QUERY_KEY, COMMENT_CHALLENGE_TOKEN_QUERY_KEY, parseCommentChallengeInput, verifyCommentChallenge } from './challenge';
import { getCommentReadContext, getCommentWriteContext } from './config';
import { formatCommentListItems } from './format';
import { paginateComments } from './pagination';
import { getCommentTargetPolicy, insertComment, resolveParentComment } from './repository';
import {
  COMMENT_REQUEST_TOKEN_QUERY_KEY,
  parseCommentRequestToken,
  verifyCommentRequestTokenWithSecrets,
} from './token';
import {
  COMMENT_ALLOWED_GET_QUERY_KEYS,
  COMMENT_ALLOWED_POST_QUERY_KEYS,
  parseCreateCommentBody,
  validateCreateCommentBodyCommon,
} from './validation';
import type { CommentTargetPolicy, CommentTargetType } from './types';
import { rethrowEdgeDatabaseLifecycleQueryFailure } from '../database-lifecycle';

export const COMMENTS_API_PATH = '/api/:target_type/:target_id/comments';

const COMMENT_CREATE_MAX_BODY_BYTES = 64 * 1024;

export async function handleCommentsRequest(
  request: Request,
  env: Env,
  targetType: CommentTargetType,
  targetIdSegment: string,
  ctx?: ExecutionContext,
): Promise<Response> {
  const cors = resolveCorsContext(request, env);
  if (!cors.allowed) {
    return errorResponse(request, env, 'CORS_ORIGIN_DENIED', 'The request origin is not allowed.', 403, [], cors);
  }

  if (request.method === 'OPTIONS') {
    return handleOptionsRequest(request, env, cors);
  }

  if (request.method === 'GET') {
    return handleGetComments(request, env, cors, targetType, targetIdSegment);
  }

  if (request.method === 'POST') {
    return handleCreateComment(request, env, cors, targetType, targetIdSegment, ctx);
  }

  return errorResponse(request, env, 'METHOD_NOT_ALLOWED', 'Method Not Allowed', 405, [], cors, {
    allow: 'GET, POST, OPTIONS',
  });
}

function handleOptionsRequest(
  request: Request,
  env: Env,
  cors: ReturnType<typeof resolveCorsContext>,
): Response {
  const requestedMethod = request.headers.get('Access-Control-Request-Method');
  if (requestedMethod && !['GET', 'POST'].includes(requestedMethod.toUpperCase())) {
    return errorResponse(request, env, 'METHOD_NOT_ALLOWED', 'Method Not Allowed', 405, [], cors, {
      allow: 'GET, POST, OPTIONS',
    });
  }

  return new Response(null, {
    status: 204,
    headers: withCorsHeaders(new Headers(), cors, true),
  });
}

async function handleGetComments(
  request: Request,
  env: Env,
  cors: ReturnType<typeof resolveCorsContext>,
  targetType: CommentTargetType,
  targetIdSegment: string,
): Promise<Response> {
  const queryError = validateQueryKeys(request, COMMENT_ALLOWED_GET_QUERY_KEYS);
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

  const page = parseOptionalPage(url.searchParams.get('page'));
  if (!page) {
    return errorResponse(request, env, 'INVALID_PAGE', 'The page query parameter must be a positive integer.', 400, [
      { field: 'page', message: 'Expected a positive integer.' },
    ], cors);
  }

  const requestToken = url.searchParams.get(COMMENT_REQUEST_TOKEN_QUERY_KEY) ?? '';
  const tokenInput = parseCommentRequestToken(requestToken);
  if (!tokenInput.ok) {
    return errorResponse(request, env, tokenInput.code, tokenInput.message, 403, [], cors);
  }

  const challengeInput = parseCommentChallengeInput(
    url.searchParams.get(COMMENT_CHALLENGE_TOKEN_QUERY_KEY) ?? '',
    url.searchParams.get(COMMENT_CHALLENGE_SOLUTION_QUERY_KEY) ?? '',
  );
  if (!challengeInput.ok) {
    return errorResponse(request, env, challengeInput.code, challengeInput.message, 403, [], cors);
  }

  try {
    const rateLimitResponse = await applyPublicRateLimit({
      request, env, cors,
      binding: 'COMMENT_READ_RATE_LIMITER',
      key: getClientIP(request),
      rateLimitedMessage: 'Too many comment reads. Try again later.',
    });
    if (rateLimitResponse) return rateLimitResponse;

    const { config, requestSecrets } = await getCommentReadContext(env);
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
      requestToken,
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

    const challengeResult = await verifyCommentChallenge(
      env,
      targetPolicy,
      'read',
      challengeInput.token,
      challengeInput.solution,
    );
    if (!challengeResult.ok) {
      const status = challengeResult.code === 'COMMENT_CHALLENGE_NOT_AVAILABLE' ? 503 : 403;
      return errorResponse(
        request,
        env,
        challengeResult.code ?? 'INVALID_COMMENT_CHALLENGE',
        challengeResult.message ?? 'Comment challenge is invalid.',
        status,
        [],
        cors,
      );
    }

    const commentRows = await getApprovedCommentRows(env, targetPolicy, config.cacheTtlSeconds);
    const paginated = paginateComments(commentRows, {
      page,
      perPage: config.perPage,
      order: config.order,
    });

    return jsonResponse(
      {
        items: formatCommentListItems(paginated.comments),
        pagination: {
          page,
          total_pages: paginated.totalPages,
          total_comments: paginated.totalComments,
        },
      },
      200,
      request,
      env,
      cors,
    );
  } catch (error) {
    rethrowEdgeDatabaseLifecycleQueryFailure(error);
    logError('Comment fetch failed', { errorMessage: getLogErrorMessage(error) });
    return errorResponse(request, env, 'INTERNAL_ERROR', 'Internal Server Error', 500, [], cors);
  }
}

async function handleCreateComment(
  request: Request,
  env: Env,
  cors: ReturnType<typeof resolveCorsContext>,
  targetType: CommentTargetType,
  targetIdSegment: string,
  ctx?: ExecutionContext,
): Promise<Response> {
  const queryError = validateQueryKeys(request, COMMENT_ALLOWED_POST_QUERY_KEYS);
  if (queryError) {
    return errorResponse(request, env, queryError.code, queryError.message, 400, queryError.errors, cors);
  }

  if (!isApplicationJsonContentType(request.headers.get('content-type'))) {
    return errorResponse(request, env, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json.', 415, [
      { field: 'content-type', message: 'Expected application/json.' },
    ], cors);
  }

  const targetPublicId = parsePositiveIntegerString(targetIdSegment);
  if (!targetPublicId) {
    return errorResponse(request, env, 'INVALID_COMMENT_TARGET_ID', 'The comment target path parameter must be a positive integer.', 400, [
      { field: 'target_id', message: 'Expected a positive integer path parameter.' },
    ], cors);
  }

  const bodyResult = await readBoundedJson(request, COMMENT_CREATE_MAX_BODY_BYTES);
  if (!bodyResult.ok) {
    if (bodyResult.kind === 'too_large') {
      return errorResponse(
        request,
        env,
        'REQUEST_BODY_TOO_LARGE',
        'Request body exceeds the maximum allowed size.',
        413,
        [],
        cors,
      );
    }

    return errorResponse(request, env, 'INVALID_JSON', 'Request body must be valid JSON.', 400, [], cors);
  }
  const rawBody = bodyResult.value;

  const bearerToken = getBearerToken(request);
  const authorEmailPolicy = bearerToken.present ? 'ignored' : 'required';
  const commonErrors = validateCreateCommentBodyCommon(rawBody, authorEmailPolicy);
  if (commonErrors.length > 0) {
    return errorResponse(request, env, 'VALIDATION_ERROR', 'Input validation failed.', 422, commonErrors, cors);
  }

  const clientIP = getClientIP(request);
  try {
    const rateLimitResponse = await applyPublicRateLimit({
      request, env, cors,
      binding: 'COMMENT_WRITE_RATE_LIMITER',
      key: clientIP,
      rateLimitedMessage: 'Too many comment attempts. Try again later.',
    });
    if (rateLimitResponse) return rateLimitResponse;

    const contextResult = await getCommentWriteContext(env);
    if (!contextResult.ok) {
      return errorResponse(request, env, contextResult.code, contextResult.message, 503, [], cors);
    }
    const { config, requestSecrets, runtimeSettings, authConfigResult } = contextResult.context;
    const writeVerificationMode = runtimeSettings.commentWriteVerificationMode;

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

    const parsedBody = parseCreateCommentBody(rawBody, writeVerificationMode, authorEmailPolicy);
    if (parsedBody.errors.length > 0 || !parsedBody.value) {
      return errorResponse(request, env, 'VALIDATION_ERROR', 'Input validation failed.', 422, parsedBody.errors, cors);
    }

    const descriptorResult = createWriteVerificationDescriptor(
      env,
      runtimeSettings.turnstileSitekey,
      writeVerificationMode,
      'comment_create',
    );
    if (!descriptorResult.ok) {
      return errorResponse(request, env, descriptorResult.code, descriptorResult.message, 503, [], cors);
    }

    const tokenResult = await verifyCommentRequestTokenWithSecrets(
      requestSecrets,
      toTokenTarget(targetPolicy),
      parsedBody.value.commentRequestToken,
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

    let authenticatedIdentity: AuthenticatedCommentIdentity | null = null;
    if (bearerToken.present) {
      if (!bearerToken.ok) {
        return commentAuthErrorResponse(
          request,
          env,
          cors,
          'INVALID_COMMENT_AUTH_TOKEN',
          'Comment authentication token is invalid or expired.',
          401,
        );
      }
      if (!authConfigResult.ok) {
        logWarn('Comment authentication settings are invalid or unavailable', {
          code: 'COMMENT_AUTH_SETTINGS_NOT_AVAILABLE',
          reason: authConfigResult.reason,
          guidance: 'Configure a complete Supabase project URL and publishable key in Studio, or disable comment authentication.',
        });
        return commentAuthErrorResponse(
          request,
          env,
          cors,
          'COMMENT_AUTH_SETTINGS_NOT_AVAILABLE',
          'Comment authentication settings are temporarily unavailable.',
          503,
        );
      }
      if (!authConfigResult.config.enabled) {
        return commentAuthErrorResponse(
          request,
          env,
          cors,
          'COMMENT_AUTH_NOT_ENABLED',
          'Comment authentication is not enabled.',
          401,
        );
      }

      const authenticationResult = await verifySupabaseCommentIdentity(
        bearerToken.token,
        authConfigResult.config,
      );
      if (!authenticationResult.ok) {
        return commentAuthErrorResponse(
          request,
          env,
          cors,
          authenticationResult.code,
          authenticationResult.message,
          authenticationResult.kind === 'unavailable'
            ? 503
            : authenticationResult.kind === 'email_missing'
              ? 403
              : 401,
        );
      }
      authenticatedIdentity = authenticationResult.identity;

      if (env.COMMENT_WRITE_RATE_LIMITER) {
        let identityRateLimitKey: string;
        try {
          identityRateLimitKey = await createCommentIdentityRateLimitKey(env, authenticatedIdentity);
        } catch (error) {
          if (error instanceof IpHashSecretUnavailableError) {
            return errorResponse(request, env, 'COMMENT_IP_HASH_NOT_AVAILABLE', 'Comments are temporarily unavailable.', 503, [], cors);
          }
          throw error;
        }
        const identityRateLimitResponse = await applyPublicRateLimit({
          request, env, cors,
          binding: 'COMMENT_WRITE_RATE_LIMITER',
          key: identityRateLimitKey,
          rateLimitedMessage: 'Too many comment attempts. Try again later.',
        });
        if (identityRateLimitResponse) return identityRateLimitResponse;
      }
    }

    let challengeExpiresAtSeconds: number | undefined;
    if (writeVerificationMode === 'pow') {
      const challengeResult = await verifyCommentChallenge(
        env,
        targetPolicy,
        'write',
        parsedBody.value.commentChallengeToken,
        parsedBody.value.commentChallengeSolution,
      );
      if (!challengeResult.ok) {
        const status = challengeResult.code === 'COMMENT_CHALLENGE_NOT_AVAILABLE' ? 503 : 403;
        return errorResponse(
          request,
          env,
          challengeResult.code ?? 'INVALID_COMMENT_CHALLENGE',
          challengeResult.message ?? 'Comment challenge is invalid.',
          status,
          [],
          cors,
        );
      }
      challengeExpiresAtSeconds = challengeResult.expiresAtSeconds;
    } else {
      const verificationResponse = await verifyCommentTurnstile(
        request,
        env,
        cors,
        clientIP,
        parsedBody.value.turnstileToken,
      );
      if (verificationResponse) {
        return verificationResponse;
      }
    }

    const parentInfo = await resolveParentComment(env, targetPolicy.id, parsedBody.value.parentId, config);
    if (parentInfo.errors.length > 0) {
      return errorResponse(request, env, 'VALIDATION_ERROR', 'Input validation failed.', 422, parentInfo.errors, cors);
    }

    if (writeVerificationMode === 'pow') {
      const usedChallengeResult = await consumeUsedChallenge(env, {
        scope: 'comment-write',
        challengeToken: parsedBody.value.commentChallengeToken,
        expiresAtSeconds: challengeExpiresAtSeconds ?? Math.floor(Date.now() / 1000),
        alreadyUsedCode: 'COMMENT_CHALLENGE_ALREADY_USED',
        alreadyUsedMessage: 'Comment challenge has already been used.',
      });
      if (!usedChallengeResult.ok) {
        return errorResponse(
          request,
          env,
          usedChallengeResult.code ?? 'COMMENT_CHALLENGE_ALREADY_USED',
          usedChallengeResult.message ?? 'Comment challenge has already been used.',
          403,
          [],
          cors,
        );
      }
    }

    const status = config.requireCommentApproval ? 'pending' : 'approved';
    let networkMetadata;
    try {
      networkMetadata = await getClientNetworkMetadata(env, request, clientIP);
    } catch (error) {
      if (error instanceof IpHashSecretUnavailableError) {
        return errorResponse(request, env, 'COMMENT_IP_HASH_NOT_AVAILABLE', 'Comments are temporarily unavailable.', 503, [], cors);
      }
      throw error;
    }
    await insertComment(env, {
      targetId: targetPolicy.id,
      parentPublicId: parentInfo.parentPublicId,
      authorName: parsedBody.value.authorName,
      authorEmail: authenticatedIdentity?.email ?? parsedBody.value.authorEmail,
      content: parsedBody.value.contentText,
      status,
      clientIP,
      ipHash: networkMetadata.ipHash,
      userAgent: networkMetadata.userAgent,
      asn: networkMetadata.asn,
      asOrganization: networkMetadata.asOrganization,
      countryCode: networkMetadata.countryCode,
      authorKind: authenticatedIdentity?.kind ?? 'guest',
      authorIdentityIssuer: authenticatedIdentity?.issuer ?? null,
      authorUserId: authenticatedIdentity?.subject ?? null,
    });

    if (status === 'approved') {
      await runInBackground(ctx, deleteCommentsCache(env, targetPolicy), 'comments-cache-invalidation');
    }

    return jsonResponse(
      {
        publication: status === 'approved' ? 'published' : 'pending_moderation',
      },
      201,
      request,
      env,
      cors,
    );
  } catch (error) {
    rethrowEdgeDatabaseLifecycleQueryFailure(error);
    logError('Comment submit failed', { errorMessage: getLogErrorMessage(error) });
    return errorResponse(request, env, 'INTERNAL_ERROR', 'Internal Server Error', 500, [], cors);
  }
}

function commentAuthErrorResponse(
  request: Request,
  env: Env,
  cors: ReturnType<typeof resolveCorsContext>,
  code: string,
  message: string,
  status: 401 | 403 | 503,
): Response {
  return errorResponse(request, env, code, message, status, [], cors, status === 401
    ? { 'www-authenticate': 'Bearer realm="zeropress-comments"' }
    : undefined);
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

async function verifyCommentTurnstile(
  request: Request,
  env: Env,
  cors: ReturnType<typeof resolveCorsContext>,
  clientIP: string,
  token: string,
): Promise<Response | null> {
  const rateLimitResult = await applyTurnstileVerifyRateLimit(env, 'comment_create', clientIP);
  if (!rateLimitResult.ok) {
    const status = rateLimitResult.kind === 'rate_limited' ? 429 : 503;
    return errorResponse(request, env, rateLimitResult.code, rateLimitResult.message, status, [], cors);
  }

  const result = await verifyTurnstileToken(env, {
    token,
    action: 'comment_create',
    request,
  });
  return turnstileErrorResponse(request, env, cors, result);
}

function turnstileErrorResponse(
  request: Request,
  env: Env,
  cors: ReturnType<typeof resolveCorsContext>,
  result: TurnstileVerificationResult,
): Response | null {
  if (result.ok) {
    return null;
  }

  return errorResponse(
    request,
    env,
    result.code,
    result.message,
    result.kind === 'invalid' ? 403 : 503,
    [],
    cors,
  );
}
