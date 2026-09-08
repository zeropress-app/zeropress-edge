import type { Env } from '../env';
import {
  errorResponse,
  getClientIP,
  jsonResponse,
  resolveCorsContext,
  validateQueryKeys,
  withCorsHeaders,
} from '../http';
import { logWarn } from '../log';
import { applyPublicRateLimit } from '../rate-limit';
import { getCommentAuthConfig } from './auth-config';

const COMMENT_AUTH_ALLOWED_QUERY_KEYS = new Set<string>();
const COMMENT_AUTH_ALLOW_METHODS = 'GET, OPTIONS';

export async function handleCommentsAuthRequest(request: Request, env: Env): Promise<Response> {
  const cors = resolveCorsContext(request, env);
  if (!cors.allowed) {
    return errorResponse(request, env, 'CORS_ORIGIN_DENIED', 'The request origin is not allowed.', 403, [], cors);
  }

  if (request.method === 'OPTIONS') {
    const requestedMethod = request.headers.get('Access-Control-Request-Method');
    if (requestedMethod && requestedMethod.toUpperCase() !== 'GET') {
      return errorResponse(request, env, 'METHOD_NOT_ALLOWED', 'Method Not Allowed', 405, [], cors, {
        allow: COMMENT_AUTH_ALLOW_METHODS,
      });
    }
    const headers = withCorsHeaders(new Headers({ allow: COMMENT_AUTH_ALLOW_METHODS }), cors, true);
    headers.set('Access-Control-Allow-Methods', COMMENT_AUTH_ALLOW_METHODS);
    return new Response(null, {
      status: 204,
      headers,
    });
  }

  if (request.method !== 'GET') {
    return errorResponse(request, env, 'METHOD_NOT_ALLOWED', 'Method Not Allowed', 405, [], cors, {
      allow: COMMENT_AUTH_ALLOW_METHODS,
    });
  }

  const queryError = validateQueryKeys(request, COMMENT_AUTH_ALLOWED_QUERY_KEYS);
  if (queryError) {
    return errorResponse(request, env, queryError.code, queryError.message, 400, queryError.errors, cors);
  }

  const rateLimitResponse = await applyPublicRateLimit({
    request, env, cors,
    binding: 'COMMENT_READ_RATE_LIMITER',
    key: `comment-auth:${getClientIP(request)}`,
    rateLimitedMessage: 'Too many comment authentication requests. Try again later.',
  });
  if (rateLimitResponse) return rateLimitResponse;

  const result = await getCommentAuthConfig(env);
  if (!result.ok) {
    if (result.reason !== 'query_failed') {
      logWarn('Comment authentication settings are invalid or unavailable', {
        code: 'COMMENT_AUTH_SETTINGS_NOT_AVAILABLE',
        reason: result.reason,
        guidance: 'Configure a complete Supabase project URL and publishable key in Studio, or disable comment authentication.',
      });
    }
    return errorResponse(
      request,
      env,
      'COMMENT_AUTH_SETTINGS_NOT_AVAILABLE',
      'Comment authentication settings are temporarily unavailable.',
      503,
      [],
      cors,
    );
  }

  if (!result.config.enabled) {
    return jsonResponse({ enabled: false }, 200, request, env, cors);
  }

  return jsonResponse({
    enabled: true,
    provider: result.config.provider,
    mode: result.config.mode,
    project_url: result.config.projectUrl,
    publishable_key: result.config.publishableKey,
  }, 200, request, env, cors);
}
