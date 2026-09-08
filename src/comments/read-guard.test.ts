import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../index';
import {
  commentsUrl,
  createMockEnv,
  defaultOpenSettings,
  publishedPost,
} from '../test-utils';

const SITE_ORIGIN = 'https://site.example';
const CLIENT_IP = '203.0.113.42';

afterEach(() => vi.restoreAllMocks());

function readRequest(url = new URL(commentsUrl())) {
  return new Request(url, { headers: { Origin: SITE_ORIGIN, 'CF-Connecting-IP': CLIENT_IP } });
}

function openComments(options: Parameters<typeof createMockEnv>[0] = {}) {
  return createMockEnv({
    post: publishedPost(),
    settings: defaultOpenSettings(),
    allowedOrigins: SITE_ORIGIN,
    ...options,
  });
}

describe.each(['posts', 'pages'])('comment read input boundary for %s', (collection) => {
  it.each([
    ['comment_request_token', null, 'MISSING_COMMENT_REQUEST_TOKEN'],
    ['comment_request_token', '  ', 'MISSING_COMMENT_REQUEST_TOKEN'],
    ['comment_request_token', 'invalid', 'INVALID_COMMENT_REQUEST_TOKEN'],
    ['comment_challenge_token', null, 'MISSING_COMMENT_CHALLENGE'],
    ['comment_challenge_solution', null, 'MISSING_COMMENT_CHALLENGE'],
    ['comment_challenge_token', 'invalid', 'INVALID_COMMENT_CHALLENGE'],
    ['comment_challenge_token', `c3.e30.${'A'.repeat(43)}`, 'INVALID_COMMENT_CHALLENGE'],
    ['comment_challenge_token', `c3.YQ.${'A'.repeat(43)}`, 'INVALID_COMMENT_CHALLENGE'],
    ['comment_challenge_solution', '  ', 'MISSING_COMMENT_CHALLENGE'],
    ['comment_challenge_solution', '1e2', 'INVALID_COMMENT_CHALLENGE'],
    ['comment_challenge_solution', '1'.repeat(17), 'INVALID_COMMENT_CHALLENGE'],
  ])('rejects %s=%s before D1, KV, rate limits or logs', async (field, value, code) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { env, sqlCalls, kv, readRateLimiter } = openComments({
      lifecycleQueryError: new Error('D1 must not be reached for malformed input'),
      readRateLimitSuccess: false,
    });
    const url = new URL(commentsUrl());
    url.pathname = `/api/${collection}/101/comments`;
    if (value === null) url.searchParams.delete(field!);
    else url.searchParams.set(field!, value!);

    const response = await worker.fetch(readRequest(url), env);

    expect(response.status).toBe(403);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(SITE_ORIGIN);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(await response.json()).toMatchObject({ success: false, error: { code } });
    expect(sqlCalls).toEqual([]);
    expect(kv.get).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
    expect(readRateLimiter.limit).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});

describe('comment read rate limit', () => {
  it('limits well-formed forged tokens before D1 or KV', async () => {
    const { env, sqlCalls, kv, readRateLimiter, rateLimiter, challengeRateLimiter } = openComments({
      readRateLimitSuccess: false,
    });
    const url = new URL(commentsUrl());
    const token = url.searchParams.get('comment_request_token')!;
    url.searchParams.set('comment_request_token', `${token.slice(0, -1)}A`);

    const response = await worker.fetch(readRequest(url), env);

    expect(response.status).toBe(429);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(SITE_ORIGIN);
    expect(await response.json()).toMatchObject({ success: false, error: { code: 'RATE_LIMITED' } });
    expect(readRateLimiter.limit).toHaveBeenCalledExactlyOnceWith({ key: CLIENT_IP });
    expect(rateLimiter.limit).not.toHaveBeenCalled();
    expect(challengeRateLimiter.limit).not.toHaveBeenCalled();
    expect(sqlCalls).toEqual([]);
    expect(kv.get).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it('limits repeated reads even when the approved comments are cached', async () => {
    const { env, sqlCalls, kv, readRateLimiter } = openComments();
    readRateLimiter.limit.mockResolvedValueOnce({ success: true }).mockResolvedValueOnce({ success: false });
    const first = await worker.fetch(readRequest(), env);
    expect(first.status).toBe(200);
    expect(kv.put).toHaveBeenCalledOnce();
    const previousQueries = sqlCalls.length;

    const second = await worker.fetch(readRequest(), env);

    expect(second.status).toBe(429);
    expect(readRateLimiter.limit).toHaveBeenCalledTimes(2);
    expect(sqlCalls).toHaveLength(previousQueries);
    expect(kv.get).toHaveBeenCalledOnce();
  });

  it('supports installations without the optional read limiter', async () => {
    const { env, readRateLimiter } = openComments();
    delete env.COMMENT_READ_RATE_LIMITER;
    const response = await worker.fetch(readRequest(), env);
    expect(response.status).toBe(200);
    expect(readRateLimiter.limit).not.toHaveBeenCalled();
  });

  it.each(['comment_request_token', 'comment_challenge_token'])(
    'rejects a forged %s after syntax and rate checks pass', async (field) => {
      const { env, sqlCalls, kv, readRateLimiter } = openComments();
      const url = new URL(commentsUrl());
      const token = url.searchParams.get(field)!;
      url.searchParams.set(field, `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`);

      const response = await worker.fetch(readRequest(url), env);

      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        success: false,
        error: { code: field === 'comment_request_token' ? 'INVALID_COMMENT_REQUEST_TOKEN' : 'INVALID_COMMENT_CHALLENGE' },
      });
      expect(readRateLimiter.limit).toHaveBeenCalledExactlyOnceWith({ key: CLIENT_IP });
      expect(sqlCalls).toHaveLength(2);
      expect(kv.get).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['disabled', 404], ['maintenance', 503], ['invalid maintenance', 503],
    ['preflight', 204], ['denied origin', 403],
  ] as const)('keeps %s requests ahead of the read limiter', async (mode, expectedStatus) => {
    const { env, sqlCalls, readRateLimiter } = openComments({ readRateLimitSuccess: false });
    if (mode === 'disabled') env.COMMENTS_ENABLED = 'false';
    if (mode === 'maintenance') env.EDGE_MAINTENANCE_MODE = 'true';
    if (mode === 'invalid maintenance') env.EDGE_MAINTENANCE_MODE = 'invalid';
    const request = new Request(commentsUrl(), {
      method: mode === 'preflight' ? 'OPTIONS' : 'GET',
      headers: { Origin: mode === 'denied origin' ? 'https://denied.example' : SITE_ORIGIN },
    });

    const response = await worker.fetch(request, env);

    expect(response.status).toBe(expectedStatus);
    expect(sqlCalls).toEqual([]);
    expect(readRateLimiter.limit).not.toHaveBeenCalled();
  });
});
