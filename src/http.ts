import type { Env } from './env';
import { isPlainRecord } from './guards';

export type ApiErrorItem = {
  field?: string;
  message: string;
};

export type CorsContext = {
  origin: string | null;
  allowedOrigin: string | null;
  allowed: boolean;
};

export function validateQueryKeys(
  request: Request,
  allowedKeys: Set<string>,
  requiredKeys: string[] = [],
): { code: string; message: string; errors: ApiErrorItem[] } | null {
  const url = new URL(request.url);
  const errors: ApiErrorItem[] = [];
  let hasUnsupportedOrDuplicateError = false;

  url.searchParams.forEach((_value, key) => {
    if (!allowedKeys.has(key)) {
      hasUnsupportedOrDuplicateError = true;
      errors.push({
        field: key,
        message: `Unsupported query parameter: ${key}.`,
      });
    }
  });

  for (const key of allowedKeys) {
    if (url.searchParams.getAll(key).length > 1) {
      hasUnsupportedOrDuplicateError = true;
      errors.push({
        field: key,
        message: `Duplicate query parameter: ${key}.`,
      });
    }
  }

  for (const key of requiredKeys) {
    if (!url.searchParams.has(key)) {
      errors.push({
        field: key,
        message: `Required query parameter is missing: ${key}.`,
      });
    }
  }

  return errors.length > 0
    ? {
        code: hasUnsupportedOrDuplicateError ? 'UNSUPPORTED_QUERY' : 'MISSING_QUERY',
        message: hasUnsupportedOrDuplicateError
          ? 'Unsupported query parameters were provided.'
          : 'Required query parameters are missing.',
        errors,
      }
    : null;
}

export function parsePositiveIntegerString(value: string | null): number {
  if (!value || value.trim() === '') {
    return 0;
  }

  const normalizedValue = value.trim();
  if (!/^\d+$/.test(normalizedValue)) {
    return 0;
  }

  const parsed = Number.parseInt(normalizedValue, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

export function parseOptionalPage(value: string | null): number {
  if (value === null || value.trim() === '') {
    return 1;
  }

  return parsePositiveIntegerString(value);
}

export function normalizeBodyString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function getClientIP(request: Request): string {
  return request.headers.get('CF-Connecting-IP')?.trim() || 'unknown';
}

export { isPlainRecord as isRecord };

export function resolveCorsContext(request: Request, env: Env): CorsContext {
  const origin = request.headers.get('Origin');
  if (!origin) {
    return {
      origin: null,
      allowedOrigin: null,
      allowed: true,
    };
  }

  if (isAllowedRequestOrigin(origin, request, env)) {
    return {
      origin,
      allowedOrigin: origin,
      allowed: true,
    };
  }

  return {
    origin,
    allowedOrigin: null,
    allowed: false,
  };
}

/**
 * Applies the same exact-origin policy used by public API CORS checks without
 * reading the request's Origin header. This is useful when validating an
 * explicitly supplied site origin from a management client.
 */
export function isAllowedRequestOrigin(origin: string, request: Request, env: Env): boolean {
  return origin === new URL(request.url).origin || parseAllowedOrigins(env.ALLOWED_ORIGINS).has(origin);
}

function parseAllowedOrigins(value: string | undefined): Set<string> {
  return new Set(
    String(value || '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}

export function withCorsHeaders(headers: Headers, cors: CorsContext, isPreflight = false): Headers {
  headers.append('Vary', 'Origin');

  if (cors.allowedOrigin) {
    headers.set('Access-Control-Allow-Origin', cors.allowedOrigin);
  }

  if (isPreflight) {
    headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'authorization, content-type');
    headers.set('Access-Control-Max-Age', '86400');
  }

  return headers;
}

export function jsonResponse(
  data: unknown,
  status: number,
  request: Request,
  env: Env,
  cors?: CorsContext,
  headers?: Headers,
): Response {
  return rawJsonResponse({ success: true, data }, status, request, env, cors, headers);
}

function rawJsonResponse(
  body: unknown,
  status: number,
  request: Request,
  env: Env,
  cors?: CorsContext,
  headers?: Headers,
): Response {
  const responseHeaders = headers ? new Headers(headers) : new Headers();
  responseHeaders.set('content-type', 'application/json; charset=UTF-8');
  responseHeaders.set('cache-control', 'private, no-store, max-age=0');

  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: withCorsHeaders(responseHeaders, cors ?? resolveCorsContext(request, env)),
  });
}

export function errorResponse(
  request: Request,
  env: Env,
  code: string,
  message: string,
  status: number,
  errors: ApiErrorItem[] = [],
  cors?: CorsContext,
  extraHeaders?: Record<string, string>,
): Response {
  const headers = new Headers(extraHeaders);
  return rawJsonResponse(
    {
      success: false,
      error: {
        code,
        message,
        ...(errors.length > 0 ? { errors } : {}),
      },
    },
    status,
    request,
    env,
    cors,
    headers,
  );
}
