import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from './index';
import type { Env } from './env';
import * as confirmTokens from './newsletters/confirm-token';
import type { PublicRateLimiterBinding } from './rate-limit';
import { commentsUrl, createMockEnv, TEST_COMMENT_REQUEST_TOKEN } from './test-utils';

const SITE_ORIGIN = 'https://site.example';
const CLIENT_IP = '203.0.113.42';

type PublicRoute = {
  name: string;
  path: string;
  body?: Record<string, unknown>;
  binding?: PublicRateLimiterBinding;
  rateLimitKey?: string;
};

const routes: PublicRoute[] = [
  {
    name: 'comment auth discovery', path: '/api/comments/auth',
    binding: 'COMMENT_READ_RATE_LIMITER', rateLimitKey: `comment-auth:${CLIENT_IP}`,
  },
  {
    name: 'comment read',
    path: `/api/posts/101/comments${new URL(commentsUrl()).search}`,
    binding: 'COMMENT_READ_RATE_LIMITER',
  },
  ...(['read', 'write'] as const).map((scope): PublicRoute => ({
    name: `comment ${scope} challenge`,
    path: `/api/posts/101/comments/challenge/${scope}?comment_request_token=${TEST_COMMENT_REQUEST_TOKEN}`,
    binding: 'COMMENT_CHALLENGE_RATE_LIMITER',
  })),
  {
    name: 'comment write',
    path: '/api/posts/101/comments',
    body: { author_name: 'Reader', author_email: 'reader@example.com', content_text: 'A comment.' },
    binding: 'COMMENT_WRITE_RATE_LIMITER',
  },
  { name: 'form read', path: '/api/forms/contact', binding: 'FORM_READ_RATE_LIMITER' },
  { name: 'form challenge', path: '/api/forms/contact/challenge/submit', binding: 'FORM_CHALLENGE_RATE_LIMITER' },
  { name: 'form submit', path: '/api/forms/contact/submissions', body: { fields: {} }, binding: 'FORM_SUBMIT_RATE_LIMITER' },
  { name: 'newsletter read', path: '/api/newsletters/default', binding: 'NEWSLETTER_READ_RATE_LIMITER' },
  { name: 'newsletter challenge', path: '/api/newsletters/default/challenge/subscribe', binding: 'NEWSLETTER_CHALLENGE_RATE_LIMITER' },
  {
    name: 'newsletter subscribe',
    path: '/api/newsletters/default/subscriptions',
    body: { email: 'reader@example.com', source_url: `${SITE_ORIGIN}/newsletter` },
    binding: 'NEWSLETTER_SUBSCRIBE_RATE_LIMITER',
  },
  {
    name: 'newsletter confirm', path: '/api/newsletters/default/subscriptions/confirm',
    binding: 'NEWSLETTER_READ_RATE_LIMITER', rateLimitKey: `newsletter-confirm:${CLIENT_IP}`,
  },
  {
    name: 'newsletter unsubscribe', path: '/api/newsletters/default/subscriptions/unsubscribe',
    body: { token: `nu1.${'a'.repeat(32)}` },
    binding: 'NEWSLETTER_READ_RATE_LIMITER', rateLimitKey: `newsletter-unsubscribe:${CLIENT_IP}`,
  },
];

afterEach(() => {
  vi.restoreAllMocks();
});

async function createRouteRequest(route: PublicRoute, env: Env): Promise<Request> {
  let body = route.body;
  if (route.name === 'newsletter confirm') {
    body = {
      token: await confirmTokens.createNewsletterConfirmToken(env, {
        slug: 'default',
        subscriptionId: 'a'.repeat(32),
        issuedAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      }),
    };
  }
  return new Request(`https://edge.example${route.path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Origin: SITE_ORIGIN,
      'CF-Connecting-IP': CLIENT_IP,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe.each([
  'D1_ERROR: no such table: zeropress_edge_schema_state',
  'D1_ERROR: no such column: edge_schema.schema_version',
])('public lifecycle query failure: %s', (message) => {
  it.each(routes)('returns the lifecycle 503 for $name', async (route) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetch = vi.spyOn(globalThis, 'fetch');
    const { env, sqlCalls, kv, insertedRows } = createMockEnv({
      allowedOrigins: SITE_ORIGIN,
      lifecycleQueryError: new Error(message),
    });
    env.FORMS_ENABLED = env.NEWSLETTER_ENABLED = 'true';

    const response = await worker.fetch(await createRouteRequest(route, env), env);

    expect(response.status).toBe(503);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(SITE_ORIGIN);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(await response.json()).toEqual({
      success: false,
      error: { code: 'EDGE_DATABASE_NOT_AVAILABLE', message: 'The Edge database is temporarily unavailable.' },
    });
    expect(sqlCalls).toHaveLength(1);
    expect(insertedRows).toHaveLength(0);
    expect(kv.get).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({
      $zeropress: expect.objectContaining({ code: 'EDGE_DATABASE_NOT_AVAILABLE', reason: 'query_failed' }),
    }));
  });
});

describe('public rate limiter outages', () => {
  it.each(routes.filter((route) => route.binding))('fails $name closed with a CORS JSON 503', async (route) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetch = vi.spyOn(globalThis, 'fetch');
    const { env, sqlCalls, kv, insertedRows } = createMockEnv({ allowedOrigins: SITE_ORIGIN });
    env.FORMS_ENABLED = env.NEWSLETTER_ENABLED = 'true';
    const binding = route.binding!;
    const limit = vi.fn().mockRejectedValue(new Error(`Private limiter error for ${CLIENT_IP}`));
    env[binding] = { limit };

    const request = await createRouteRequest(route, env);
    const verifyToken = vi.spyOn(confirmTokens, 'verifyNewsletterConfirmToken');
    const response = await worker.fetch(request, env);

    expect(response.status).toBe(503);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(SITE_ORIGIN);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(await response.json()).toEqual({
      success: false,
      error: { code: 'RATE_LIMIT_NOT_AVAILABLE', message: 'Request rate limiting is temporarily unavailable.' },
    });
    expect(limit).toHaveBeenCalledExactlyOnceWith({ key: route.rateLimitKey ?? CLIENT_IP });
    expect(verifyToken).not.toHaveBeenCalled();
    expect(sqlCalls).toHaveLength(0);
    expect(insertedRows).toHaveLength(0);
    expect(kv.get).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith({
      message: 'Public API rate limiter failed',
      $zeropress: {
        code: 'RATE_LIMIT_NOT_AVAILABLE',
        binding,
        guidance: expect.any(String),
      },
    });
  });
});

describe.each(routes.filter((route) => route.rateLimitKey))('$name rate limit boundary', (route) => {
  it('rejects before token verification, D1 and KV using only the trusted client IP', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { env, sqlCalls, kv } = createMockEnv({ allowedOrigins: SITE_ORIGIN });
    env.NEWSLETTER_ENABLED = 'true';
    const limit = vi.fn().mockResolvedValue({ success: false });
    env[route.binding!] = { limit };
    const request = await createRouteRequest(route, env);
    request.headers.set('X-Forwarded-For', '198.51.100.99');
    const verifyToken = vi.spyOn(confirmTokens, 'verifyNewsletterConfirmToken');

    const response = await worker.fetch(request, env);

    expect(response.status).toBe(429);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(SITE_ORIGIN);
    expect(await response.json()).toMatchObject({ success: false, error: { code: 'RATE_LIMITED' } });
    expect(limit).toHaveBeenCalledExactlyOnceWith({ key: route.rateLimitKey });
    expect(verifyToken).not.toHaveBeenCalled();
    expect(sqlCalls).toEqual([]);
    expect(kv.get).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(['preflight', 'denied origin', 'unsupported method', 'unsupported query', 'maintenance'])(
    'preserves %s handling without consuming quota', async (scenario) => {
      const { env, sqlCalls, kv } = createMockEnv({ allowedOrigins: SITE_ORIGIN });
      env.NEWSLETTER_ENABLED = 'true';
      const limit = vi.fn().mockResolvedValue({ success: false });
      env[route.binding!] = { limit };
      let request = await createRouteRequest(route, env);
      let status: number;
      switch (scenario) {
        case 'preflight':
          request = new Request(request.url, { method: 'OPTIONS', headers: {
            Origin: SITE_ORIGIN, 'Access-Control-Request-Method': request.method,
          } });
          status = 204;
          break;
        case 'denied origin':
          request.headers.set('Origin', 'https://denied.example');
          status = 403;
          break;
        case 'unsupported method':
          request = new Request(request.url, { method: 'DELETE', headers: request.headers });
          status = 405;
          break;
        case 'unsupported query':
          request = new Request(`${request.url}?unexpected=1`, request);
          status = 400;
          break;
        default:
          env.EDGE_MAINTENANCE_MODE = 'true';
          status = 503;
      }
      const verifyToken = vi.spyOn(confirmTokens, 'verifyNewsletterConfirmToken');

      expect((await worker.fetch(request, env)).status).toBe(status);
      expect(limit).not.toHaveBeenCalled();
      expect(verifyToken).not.toHaveBeenCalled();
      expect(sqlCalls).toEqual([]);
      expect(kv.get).not.toHaveBeenCalled();
      expect(kv.put).not.toHaveBeenCalled();
    },
  );
});

describe('unrelated read failures', () => {
  it.each(routes.filter((route) => ['comment read', 'form read', 'newsletter read'].includes(route.name)))(
    'keeps $name failures distinct from lifecycle errors',
    async (route) => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { env } = createMockEnv({
        allowedOrigins: SITE_ORIGIN,
        lifecycleQueryError: new Error('D1_ERROR: database temporarily unavailable'),
      });
      env.FORMS_ENABLED = env.NEWSLETTER_ENABLED = 'true';

      const response = await worker.fetch(await createRouteRequest(route, env), env);

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Internal Server Error' },
      });
      expect(warn).not.toHaveBeenCalled();
    },
  );
});
