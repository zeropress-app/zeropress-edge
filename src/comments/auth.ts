import {
  createRemoteJWKSet,
  errors as joseErrors,
  jwtVerify,
  type JWTPayload,
} from 'jose';
import { signDerivedHmacSha256Base64Url } from '../crypto';
import type { Env } from '../env';
import { getIpHashSecret } from '../ip-hash-secret';
import { logWarn } from '../log';
import { IpHashSecretUnavailableError } from '../request-metadata';
import { normalizeCommentAuthorEmail } from './validation';
import type { EnabledCommentAuthConfig } from './auth-config';

const MAX_BEARER_TOKEN_LENGTH = 8192;
const SUPABASE_JWKS_CACHE_MAX_AGE_MS = 10 * 60 * 1000;
const SUPABASE_JWKS_TIMEOUT_MS = 5000;
const COMMENT_AUTH_RATE_LIMIT_HMAC_INFO = 'zeropress-edge/comment-auth-rate-limit/v1';
const SUPABASE_ALLOWED_ALGORITHMS = ['ES256', 'RS256'] as const;

type RemoteJwks = ReturnType<typeof createRemoteJWKSet>;
const remoteJwksByIssuer = new Map<string, RemoteJwks>();

export type AuthenticatedCommentIdentity = {
  kind: 'authenticated_user';
  issuer: string;
  subject: string;
  email: string;
};

export type CommentAuthenticationResult =
  | { ok: true; identity: AuthenticatedCommentIdentity }
  | {
      ok: false;
      kind: 'invalid' | 'unsupported_algorithm' | 'unavailable' | 'email_missing';
      code: string;
      message: string;
    };

export function getBearerToken(request: Request):
  | { present: false }
  | { present: true; ok: true; token: string }
  | { present: true; ok: false } {
  const value = request.headers.get('authorization');
  if (value === null) {
    return { present: false };
  }

  const match = /^Bearer ([^\s]+)$/i.exec(value);
  if (!match || match[1].length > MAX_BEARER_TOKEN_LENGTH) {
    return { present: true, ok: false };
  }

  return { present: true, ok: true, token: match[1] };
}

export async function verifySupabaseCommentIdentity(
  token: string,
  config: EnabledCommentAuthConfig,
): Promise<CommentAuthenticationResult> {
  let payload: JWTPayload;
  try {
    payload = await verifyJwtWithRemoteJwks(token, config.issuer);
  } catch (error) {
    if (error instanceof joseErrors.JOSEAlgNotAllowed) {
      // Intentionally do not log this branch. The JWT header and claims are
      // unverified attacker-controlled input, so emitting an operator warning
      // here would allow public requests to amplify console logs.
      return {
        ok: false,
        kind: 'unsupported_algorithm',
        code: 'UNSUPPORTED_COMMENT_AUTH_TOKEN_ALGORITHM',
        message: 'Comment authentication requires an ES256 or RS256 access token.',
      };
    }

    if (isInvalidAccessTokenError(error)) {
      return {
        ok: false,
        kind: 'invalid',
        code: 'INVALID_COMMENT_AUTH_TOKEN',
        message: 'Comment authentication token is invalid or expired.',
      };
    }

    logWarn('Supabase comment authentication verification is unavailable', {
      code: 'COMMENT_AUTH_VERIFICATION_NOT_AVAILABLE',
      service: 'supabase-jwks',
      issuer: config.issuer,
      reason: toSafeJoseErrorCode(error),
      guidance: 'Check the Supabase Auth service status, project URL, asymmetric signing-key configuration, and Worker outbound request path.',
    });
    return {
      ok: false,
      kind: 'unavailable',
      code: 'COMMENT_AUTH_VERIFICATION_NOT_AVAILABLE',
      message: 'Comment authentication is temporarily unavailable.',
    };
  }

  const subject = typeof payload.sub === 'string' ? payload.sub : '';
  if (
    !subject ||
    subject !== subject.trim() ||
    subject.length > 512 ||
    payload.role !== 'authenticated' ||
    payload.is_anonymous === true
  ) {
    return {
      ok: false,
      kind: 'invalid',
      code: 'INVALID_COMMENT_AUTH_TOKEN',
      message: 'Comment authentication token is invalid or expired.',
    };
  }

  const email = normalizeCommentAuthorEmail(payload.email);
  if (!email) {
    return {
      ok: false,
      kind: 'email_missing',
      code: 'COMMENT_AUTH_EMAIL_NOT_AVAILABLE',
      message: 'The authenticated account does not provide a valid email address.',
    };
  }

  return {
    ok: true,
    identity: {
      kind: 'authenticated_user',
      issuer: config.issuer,
      subject,
      email,
    },
  };
}

export async function createCommentIdentityRateLimitKey(
  env: Env,
  identity: AuthenticatedCommentIdentity,
): Promise<string> {
  const secret = getIpHashSecret(env);
  if (!secret) {
    throw new IpHashSecretUnavailableError();
  }

  const signature = await signDerivedHmacSha256Base64Url(
    secret,
    COMMENT_AUTH_RATE_LIMIT_HMAC_INFO,
    `v1:${JSON.stringify([identity.issuer, identity.subject])}`,
  );
  return `comment-auth:v1.${signature}`;
}

async function verifyJwtWithRemoteJwks(token: string, issuer: string): Promise<JWTPayload> {
  const jwks = getRemoteJwks(issuer);
  // createRemoteJWKSet already refreshes unknown keys after its cooldown and
  // coalesces concurrent fetches. Calling reload() here would bypass that
  // protection and let arbitrary JWT kid values amplify outbound requests.
  return (await verifyJwt(token, issuer, jwks)).payload;
}

function verifyJwt(token: string, issuer: string, jwks: RemoteJwks) {
  return jwtVerify(token, jwks, {
    algorithms: [...SUPABASE_ALLOWED_ALGORITHMS],
    issuer,
    audience: 'authenticated',
    requiredClaims: ['exp', 'sub', 'role'],
  });
}

function getRemoteJwks(issuer: string): RemoteJwks {
  const existing = remoteJwksByIssuer.get(issuer);
  if (existing) return existing;

  const remoteJwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`), {
    timeoutDuration: SUPABASE_JWKS_TIMEOUT_MS,
    cacheMaxAge: SUPABASE_JWKS_CACHE_MAX_AGE_MS,
    cooldownDuration: 30_000,
  });
  remoteJwksByIssuer.set(issuer, remoteJwks);
  return remoteJwks;
}

function isInvalidAccessTokenError(error: unknown): boolean {
  return error instanceof joseErrors.JWTExpired ||
    error instanceof joseErrors.JWTClaimValidationFailed ||
    error instanceof joseErrors.JWTInvalid ||
    error instanceof joseErrors.JWSInvalid ||
    error instanceof joseErrors.JWSSignatureVerificationFailed ||
    error instanceof joseErrors.JOSENotSupported ||
    error instanceof joseErrors.JWKSNoMatchingKey;
}

function toSafeJoseErrorCode(error: unknown): string {
  if (error instanceof joseErrors.JOSEError) {
    return error.code;
  }
  return error instanceof TypeError ? 'network_or_runtime_error' : 'unexpected_error';
}
