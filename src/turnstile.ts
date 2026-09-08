import type { Env, RateLimiter } from './env';
import { logWarn } from './log';
import type { WriteVerificationMode } from './runtime-settings';

export type { WriteVerificationMode } from './runtime-settings';

export const TURNSTILE_SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
export const TURNSTILE_SITEVERIFY_TIMEOUT_MS = 5_000;
export const TURNSTILE_SITEVERIFY_MAX_ATTEMPTS = 2;
export const TURNSTILE_TOKEN_MAX_LENGTH = 2_048;

const TURNSTILE_SITEVERIFY_DOCS_URL = 'https://developers.cloudflare.com/turnstile/get-started/server-side-validation/';

export const TURNSTILE_ACTIONS = [
  'comment_create',
  'newsletter_subscribe',
  'form_submit',
] as const;

export type TurnstileAction = typeof TURNSTILE_ACTIONS[number];

type UnavailableResult = {
  ok: false;
  kind: 'unavailable';
  code: string;
  message: string;
};

type InvalidResult = {
  ok: false;
  kind: 'invalid';
  code: string;
  message: string;
};

export type WriteVerificationDescriptor =
  | { mode: 'pow' }
  | {
      mode: 'turnstile';
      turnstile: {
        site_key: string;
        action: TurnstileAction;
      };
    };

export type WriteVerificationDescriptorResult =
  | { ok: true; descriptor: WriteVerificationDescriptor }
  | UnavailableResult;

export type TurnstileVerificationResult =
  | { ok: true }
  | InvalidResult
  | UnavailableResult;

export type TurnstileRateLimitResult =
  | { ok: true }
  | {
      ok: false;
      kind: 'rate_limited';
      code: 'TURNSTILE_VERIFY_RATE_LIMITED';
      message: string;
    }
  | UnavailableResult;

type TurnstileDescriptorEnv = Pick<Env, 'TURNSTILE_SECRET_KEY'>;
type TurnstileVerificationEnv = Pick<Env, 'TURNSTILE_SECRET_KEY'>;
type TurnstileRateLimitEnv = Pick<Env, 'TURNSTILE_VERIFY_RATE_LIMITER'>;

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type SiteverifyResponse = {
  success: boolean;
  action?: string;
  hostname?: string;
  'error-codes'?: string[];
};

type SiteverifyAttempt =
  | { kind: 'response'; value: SiteverifyResponse }
  | {
      kind: 'retryable_error';
      reason: 'request_timeout' | 'request_failed' | 'http_error' | 'invalid_json' | 'invalid_response';
      httpStatus?: number;
    };

type SiteverifyFailureLog = {
  attempt: number;
  reason:
    | 'request_timeout'
    | 'request_failed'
    | 'http_error'
    | 'invalid_json'
    | 'invalid_response'
    | 'siteverify_rejected'
    | 'unexpected_state';
  httpStatus?: number;
  errorCodes?: string[];
  unknownErrorCodeCount?: number;
  emptyErrorCodes?: boolean;
};

const CONFIGURATION_ERROR_CODES = new Set([
  'bad-request',
  'invalid-input-secret',
  'missing-input-secret',
]);

const CLIENT_ERROR_CODES = new Set([
  'invalid-input-response',
  'timeout-or-duplicate',
]);

const KNOWN_SITEVERIFY_ERROR_CODES = new Set([
  ...CONFIGURATION_ERROR_CODES,
  ...CLIENT_ERROR_CODES,
  'internal-error',
  'missing-input-response',
]);

export function createWriteVerificationDescriptor(
  env: TurnstileDescriptorEnv,
  turnstileSitekey: string | null,
  mode: WriteVerificationMode,
  action: TurnstileAction,
): WriteVerificationDescriptorResult {
  if (mode === 'pow') {
    return { ok: true, descriptor: { mode: 'pow' } };
  }

  const siteKey = normalizeRequiredSecret(turnstileSitekey ?? undefined);
  const secret = normalizeRequiredSecret(env.TURNSTILE_SECRET_KEY);
  if (!siteKey || !secret) {
    logTurnstileConfigurationUnavailable(action, [
      ...(!siteKey ? ['edge_runtime_settings.turnstile_sitekey' as const] : []),
      ...(!secret ? ['TURNSTILE_SECRET_KEY' as const] : []),
    ]);
    return unavailable(
      'TURNSTILE_NOT_AVAILABLE',
      'Turnstile verification is temporarily unavailable.',
    );
  }

  return {
    ok: true,
    descriptor: {
      mode: 'turnstile',
      turnstile: {
        site_key: siteKey,
        action,
      },
    },
  };
}

export function parseTurnstileToken(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > TURNSTILE_TOKEN_MAX_LENGTH ||
    value.trim() !== value
  ) {
    return null;
  }

  return value;
}

export async function applyTurnstileVerifyRateLimit(
  env: TurnstileRateLimitEnv,
  action: TurnstileAction,
  clientIP: string,
): Promise<TurnstileRateLimitResult> {
  const limiter: RateLimiter | undefined = env.TURNSTILE_VERIFY_RATE_LIMITER;
  if (!limiter) {
    return { ok: true };
  }

  try {
    const { success } = await limiter.limit({ key: `${action}:${clientIP}` });
    if (!success) {
      return {
        ok: false,
        kind: 'rate_limited',
        code: 'TURNSTILE_VERIFY_RATE_LIMITED',
        message: 'Too many verification attempts. Try again later.',
      };
    }
  } catch {
    logWarn('Turnstile verification rate limiter failed', {
      code: 'TURNSTILE_VERIFY_RATE_LIMIT_NOT_AVAILABLE',
      action,
      binding: 'TURNSTILE_VERIFY_RATE_LIMITER',
      guidance: 'Check the optional rate limiter binding and Cloudflare service status.',
    });
    return unavailable(
      'TURNSTILE_VERIFY_RATE_LIMIT_NOT_AVAILABLE',
      'Turnstile verification is temporarily unavailable.',
    );
  }

  return { ok: true };
}

export async function verifyTurnstileToken(
  env: TurnstileVerificationEnv,
  options: {
    token: unknown;
    action: TurnstileAction;
    request: Request;
    fetcher?: Fetcher;
  },
): Promise<TurnstileVerificationResult> {
  const token = parseTurnstileToken(options.token);
  if (!token) {
    return invalid('INVALID_TURNSTILE_TOKEN', 'Turnstile verification failed.');
  }

  const expectedHostname = getOriginHostname(options.request);
  if (!expectedHostname) {
    return invalid('INVALID_TURNSTILE_ORIGIN', 'Turnstile verification failed.');
  }

  const secret = normalizeRequiredSecret(env.TURNSTILE_SECRET_KEY);
  if (!secret) {
    logTurnstileConfigurationUnavailable(options.action, ['TURNSTILE_SECRET_KEY']);
    return unavailable(
      'TURNSTILE_NOT_AVAILABLE',
      'Turnstile verification is temporarily unavailable.',
    );
  }

  const fetcher = options.fetcher ?? fetch;
  const idempotencyKey = crypto.randomUUID();
  const requestBody = JSON.stringify({
    secret,
    response: token,
    idempotency_key: idempotencyKey,
  });
  const attemptFailures: SiteverifyFailureLog[] = [];

  for (let attempt = 1; attempt <= TURNSTILE_SITEVERIFY_MAX_ATTEMPTS; attempt += 1) {
    const result = await performSiteverifyAttempt(fetcher, requestBody);
    if (result.kind === 'retryable_error') {
      attemptFailures.push({
        attempt,
        reason: result.reason,
        ...(result.httpStatus !== undefined ? { httpStatus: result.httpStatus } : {}),
      });
      if (attempt < TURNSTILE_SITEVERIFY_MAX_ATTEMPTS) {
        continue;
      }
      logSiteverifyUnavailable(options.action, attemptFailures);
      return unavailable(
        'TURNSTILE_VERIFICATION_NOT_AVAILABLE',
        'Turnstile verification is temporarily unavailable.',
      );
    }

    const response = result.value;
    if (!response.success) {
      const errorCodes = response['error-codes'] ?? [];
      const failure = createSiteverifyRejectionLog(attempt, errorCodes);
      if (errorCodes.includes('internal-error') && attempt < TURNSTILE_SITEVERIFY_MAX_ATTEMPTS) {
        attemptFailures.push(failure);
        continue;
      }
      const isClientFailure = errorCodes.length > 0 && errorCodes.every((code) => CLIENT_ERROR_CODES.has(code));
      if (
        errorCodes.includes('internal-error') ||
        errorCodes.some((code) => CONFIGURATION_ERROR_CODES.has(code)) ||
        !isClientFailure
      ) {
        attemptFailures.push(failure);
        logSiteverifyUnavailable(options.action, attemptFailures);
        return unavailable(
          'TURNSTILE_VERIFICATION_NOT_AVAILABLE',
          'Turnstile verification is temporarily unavailable.',
        );
      }
      return invalid('INVALID_TURNSTILE_TOKEN', 'Turnstile verification failed.');
    }

    if (response.action !== options.action || response.hostname !== expectedHostname) {
      return invalid('INVALID_TURNSTILE_TOKEN', 'Turnstile verification failed.');
    }

    return { ok: true };
  }

  attemptFailures.push({
    attempt: TURNSTILE_SITEVERIFY_MAX_ATTEMPTS,
    reason: 'unexpected_state',
  });
  logSiteverifyUnavailable(options.action, attemptFailures);
  return unavailable(
    'TURNSTILE_VERIFICATION_NOT_AVAILABLE',
    'Turnstile verification is temporarily unavailable.',
  );
}

async function performSiteverifyAttempt(
  fetcher: Fetcher,
  requestBody: string,
): Promise<SiteverifyAttempt> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TURNSTILE_SITEVERIFY_TIMEOUT_MS);

  try {
    const response = await fetcher(TURNSTILE_SITEVERIFY_URL, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'content-type': 'application/json',
      },
      body: requestBody,
      signal: controller.signal,
    });

    if (!response.ok) {
      return {
        kind: 'retryable_error',
        reason: 'http_error',
        httpStatus: response.status,
      };
    }

    let value: unknown;
    try {
      value = await response.json() as unknown;
    } catch {
      return {
        kind: 'retryable_error',
        reason: controller.signal.aborted ? 'request_timeout' : 'invalid_json',
      };
    }
    if (!isSiteverifyResponse(value)) {
      return { kind: 'retryable_error', reason: 'invalid_response' };
    }

    return { kind: 'response', value };
  } catch {
    return {
      kind: 'retryable_error',
      reason: controller.signal.aborted ? 'request_timeout' : 'request_failed',
    };
  } finally {
    clearTimeout(timeout);
  }
}

function isSiteverifyResponse(value: unknown): value is SiteverifyResponse {
  if (!isRecord(value) || typeof value.success !== 'boolean') {
    return false;
  }

  if (value.action !== undefined && typeof value.action !== 'string') {
    return false;
  }

  if (value.hostname !== undefined && typeof value.hostname !== 'string') {
    return false;
  }

  if (
    value['error-codes'] !== undefined &&
    (!Array.isArray(value['error-codes']) || value['error-codes'].some((code) => typeof code !== 'string'))
  ) {
    return false;
  }

  return true;
}

function getOriginHostname(request: Request): string | null {
  const origin = request.headers.get('Origin');
  if (!origin) {
    return null;
  }

  try {
    const parsed = new URL(origin);
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.origin !== origin ||
      parsed.username !== '' ||
      parsed.password !== ''
    ) {
      return null;
    }
    return parsed.hostname || null;
  } catch {
    return null;
  }
}

function normalizeRequiredSecret(value: string | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  return normalized || null;
}

function logTurnstileConfigurationUnavailable(
  action: TurnstileAction,
  missingSettings: Array<'edge_runtime_settings.turnstile_sitekey' | 'TURNSTILE_SECRET_KEY'>,
): void {
  logWarn('Turnstile configuration is incomplete', {
    code: 'TURNSTILE_NOT_AVAILABLE',
    action,
    missingSettings,
    guidance: 'Set turnstile_sitekey in edge_runtime_settings and store TURNSTILE_SECRET_KEY as a Worker secret from the same Turnstile widget.',
    documentation: TURNSTILE_SITEVERIFY_DOCS_URL,
  });
}

function createSiteverifyRejectionLog(attempt: number, errorCodes: string[]): SiteverifyFailureLog {
  const knownErrorCodes = Array.from(new Set(
    errorCodes.filter((code) => KNOWN_SITEVERIFY_ERROR_CODES.has(code)),
  )).sort();
  const unknownErrorCodeCount = errorCodes.filter((code) => !KNOWN_SITEVERIFY_ERROR_CODES.has(code)).length;

  return {
    attempt,
    reason: 'siteverify_rejected',
    ...(knownErrorCodes.length > 0 ? { errorCodes: knownErrorCodes } : {}),
    ...(unknownErrorCodeCount > 0 ? { unknownErrorCodeCount } : {}),
    ...(errorCodes.length === 0 ? { emptyErrorCodes: true } : {}),
  };
}

function logSiteverifyUnavailable(action: TurnstileAction, attemptFailures: SiteverifyFailureLog[]): void {
  const errorCodes = new Set(attemptFailures.flatMap((failure) => failure.errorCodes ?? []));
  const latestFailure = attemptFailures[attemptFailures.length - 1];
  const guidance = errorCodes.has('invalid-input-secret') || errorCodes.has('missing-input-secret')
    ? 'Verify TURNSTILE_SECRET_KEY is the secret for the same Turnstile widget as edge_runtime_settings.turnstile_sitekey, then update the secret on this Worker.'
    : errorCodes.has('bad-request') || errorCodes.has('missing-input-response')
      ? 'Verify the deployed Worker uses the current Siteverify request contract, then check Cloudflare Turnstile service status.'
      : 'Check Cloudflare Turnstile service status and the Worker outbound request path, then retry with a fresh token.';

  logWarn('Turnstile Siteverify is unavailable', {
    code: 'TURNSTILE_VERIFICATION_NOT_AVAILABLE',
    service: 'cloudflare-turnstile-siteverify',
    action,
    reason: latestFailure?.reason,
    attempts: attemptFailures.length,
    upstreamStatus: latestFailure?.httpStatus,
    errorCodes: latestFailure?.errorCodes,
    unknownErrorCodeCount: latestFailure?.unknownErrorCodeCount,
    emptyErrorCodes: latestFailure?.emptyErrorCodes,
    attemptFailures,
    guidance,
    documentation: TURNSTILE_SITEVERIFY_DOCS_URL,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(code: string, message: string): InvalidResult {
  return { ok: false, kind: 'invalid', code, message };
}

function unavailable(code: string, message: string): UnavailableResult {
  return { ok: false, kind: 'unavailable', code, message };
}
