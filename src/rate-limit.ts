import type { Env } from './env';
import { errorResponse, type CorsContext } from './http';
import { logWarn } from './log';

export type PublicRateLimiterBinding =
  | 'COMMENT_READ_RATE_LIMITER'
  | 'COMMENT_WRITE_RATE_LIMITER'
  | 'COMMENT_CHALLENGE_RATE_LIMITER'
  | 'NEWSLETTER_READ_RATE_LIMITER'
  | 'NEWSLETTER_SUBSCRIBE_RATE_LIMITER'
  | 'NEWSLETTER_CHALLENGE_RATE_LIMITER'
  | 'FORM_READ_RATE_LIMITER'
  | 'FORM_SUBMIT_RATE_LIMITER'
  | 'FORM_CHALLENGE_RATE_LIMITER';

export async function applyPublicRateLimit(input: {
  request: Request;
  env: Env;
  cors: CorsContext;
  binding: PublicRateLimiterBinding;
  key: string;
  rateLimitedMessage?: string;
}): Promise<Response | null> {
  const { request, env, cors, binding } = input;
  const limiter = env[binding];
  if (!limiter) return null;

  try {
    const { success } = await limiter.limit({ key: input.key });
    if (success) return null;
  } catch {
    logWarn('Public API rate limiter failed', {
      code: 'RATE_LIMIT_NOT_AVAILABLE',
      binding,
      guidance: 'Check the rate limiter binding and Cloudflare service status, then retry.',
    });
    return errorResponse(
      request,
      env,
      'RATE_LIMIT_NOT_AVAILABLE',
      'Request rate limiting is temporarily unavailable.',
      503,
      [],
      cors,
    );
  }

  return errorResponse(
    request,
    env,
    'RATE_LIMITED',
    input.rateLimitedMessage ?? 'Too many requests.',
    429,
    [],
    cors,
  );
}
