import {
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWK,
} from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../index';
import {
  TEST_COMMENT_REQUEST_TOKEN,
  commentPostUrl,
  commentWriteChallengeFields,
  commentsUrl,
  createMockEnv,
  defaultOpenSettings,
  publishedPost,
  readJson,
} from '../test-utils';

let projectCounter = 0;

describe('optional Supabase authentication for comment writes', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stores a verified account as authenticated_user and derives its email from the JWT', async () => {
    const auth = await createSupabaseAuthFixture({ email: 'Member@Example.com' });
    const jwksFetch = mockJwks(auth.jwks);
    const { env, insertedRows, rateLimiter } = createMockEnv({
      post: publishedPost(),
      settings: defaultOpenSettings(),
      authEnabled: true,
      supabaseProjectUrl: auth.projectUrl,
    });

    const response = await worker.fetch(authenticatedCommentRequest(auth.token, {
      authorizationScheme: 'bearer',
    }), env);

    expect(response.status).toBe(201);
    expect(await readJson(response)).toEqual({ publication: 'pending_moderation' });
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0][4]).toBe('Authenticated member');
    expect(insertedRows[0][5]).toBe('member@example.com');
    expect(insertedRows[0][17]).toBe('authenticated_user');
    expect(insertedRows[0][18]).toBe(`${auth.projectUrl}/auth/v1`);
    expect(insertedRows[0][19]).toBe('supabase-user-1');
    expect(rateLimiter.limit).toHaveBeenCalledTimes(2);
    expect(rateLimiter.limit).toHaveBeenNthCalledWith(1, { key: '203.0.113.42' });
    expect(rateLimiter.limit.mock.calls[1][0].key).toMatch(/^comment-auth:v1\.[A-Za-z0-9_-]+$/);
    expect(jwksFetch).toHaveBeenCalledTimes(1);
    expect(String(jwksFetch.mock.calls[0][0])).toBe(`${auth.projectUrl}/auth/v1/.well-known/jwks.json`);
  });

  it('does not trust a client-supplied email for an authenticated comment', async () => {
    const auth = await createSupabaseAuthFixture({ email: 'trusted@example.com' });
    mockJwks(auth.jwks);
    const { env, insertedRows } = createMockEnv({
      post: publishedPost(),
      settings: defaultOpenSettings(),
      authEnabled: true,
      supabaseProjectUrl: auth.projectUrl,
    });

    const response = await worker.fetch(authenticatedCommentRequest(auth.token, {
      authorEmail: 'attacker-controlled@example.net',
    }), env);

    expect(response.status).toBe(201);
    expect(insertedRows[0][5]).toBe('trusted@example.com');
  });

  it('rejects explicit malformed or invalid bearer credentials without guest downgrade', async () => {
    const auth = await createSupabaseAuthFixture();
    mockJwks(auth.jwks);
    const { env, insertedRows } = createMockEnv({
      post: publishedPost(),
      settings: defaultOpenSettings(),
      authEnabled: true,
      supabaseProjectUrl: auth.projectUrl,
    });

    const malformed = await worker.fetch(authenticatedCommentRequest('not-a-jwt', {
      authorizationValue: 'Basic abc',
    }), env);
    const invalid = await worker.fetch(authenticatedCommentRequest(`${auth.token}x`), env);

    for (const response of [malformed, invalid]) {
      expect(response.status).toBe(401);
      expect((await readJson(response)).code).toBe('INVALID_COMMENT_AUTH_TOKEN');
      expect(response.headers.get('www-authenticate')).toBe('Bearer realm="zeropress-comments"');
    }
    expect(insertedRows).toHaveLength(0);
  });

  it('rejects expired, anonymous, and non-user service tokens', async () => {
    const fixtures = await Promise.all([
      createSupabaseAuthFixture({ expirationTime: Math.floor(Date.now() / 1000) - 60 }),
      createSupabaseAuthFixture({ isAnonymous: true }),
      createSupabaseAuthFixture({ role: 'service_role' }),
    ]);

    for (const auth of fixtures) {
      mockJwks(auth.jwks);
      const { env, insertedRows } = createMockEnv({
        post: publishedPost(),
        settings: defaultOpenSettings(),
        authEnabled: true,
        supabaseProjectUrl: auth.projectUrl,
      });
      const response = await worker.fetch(authenticatedCommentRequest(auth.token), env);

      expect(response.status).toBe(401);
      expect((await readJson(response)).code).toBe('INVALID_COMMENT_AUTH_TOKEN');
      expect(insertedRows).toHaveLength(0);
      vi.restoreAllMocks();
    }
  });

  it('reports HS256 as an unsupported algorithm without logging unverified JWT input', async () => {
    const auth = await createSupabaseHs256AuthFixture();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { env, insertedRows } = createMockEnv({
      post: publishedPost(),
      settings: defaultOpenSettings(),
      authEnabled: true,
      supabaseProjectUrl: auth.projectUrl,
    });

    const response = await worker.fetch(authenticatedCommentRequest(auth.token), env);

    expect(response.status).toBe(401);
    expect(await readJson(response)).toEqual({
      code: 'UNSUPPORTED_COMMENT_AUTH_TOKEN_ALGORITHM',
      message: 'Comment authentication requires an ES256 or RS256 access token.',
    });
    expect(response.headers.get('www-authenticate')).toBe('Bearer realm="zeropress-comments"');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(insertedRows).toHaveLength(0);
  });

  it('pins issuer and audience to the configured Supabase project', async () => {
    const fixtures = await Promise.all([
      createSupabaseAuthFixture({ tokenIssuer: 'https://another-project.supabase.co/auth/v1' }),
      createSupabaseAuthFixture({ audience: 'another-audience' }),
      createSupabaseAuthFixture({ subject: ' padded-subject ' }),
    ]);

    for (const auth of fixtures) {
      mockJwks(auth.jwks);
      const { env, insertedRows } = createMockEnv({
        post: publishedPost(),
        settings: defaultOpenSettings(),
        authEnabled: true,
        supabaseProjectUrl: auth.projectUrl,
      });
      const response = await worker.fetch(authenticatedCommentRequest(auth.token), env);

      expect(response.status).toBe(401);
      expect((await readJson(response)).code).toBe('INVALID_COMMENT_AUTH_TOKEN');
      expect(insertedRows).toHaveLength(0);
      vi.restoreAllMocks();
    }
  });

  it('returns a clear authentication error when the verified account has no usable email', async () => {
    const auth = await createSupabaseAuthFixture({ email: undefined });
    mockJwks(auth.jwks);
    const { env, insertedRows } = createMockEnv({
      post: publishedPost(),
      settings: defaultOpenSettings(),
      authEnabled: true,
      supabaseProjectUrl: auth.projectUrl,
    });

    const response = await worker.fetch(authenticatedCommentRequest(auth.token), env);

    expect(response.status).toBe(403);
    expect((await readJson(response)).code).toBe('COMMENT_AUTH_EMAIL_NOT_AVAILABLE');
    expect(response.headers.get('www-authenticate')).toBeNull();
    expect(insertedRows).toHaveLength(0);
  });

  it('returns 503 when JWKS retrieval is unavailable and never downgrades to guest', async () => {
    const auth = await createSupabaseAuthFixture();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('network unavailable'));
    const { env, insertedRows } = createMockEnv({
      post: publishedPost(),
      settings: defaultOpenSettings(),
      authEnabled: true,
      supabaseProjectUrl: auth.projectUrl,
    });

    const response = await worker.fetch(authenticatedCommentRequest(auth.token), env);

    expect(response.status).toBe(503);
    expect((await readJson(response)).code).toBe('COMMENT_AUTH_VERIFICATION_NOT_AVAILABLE');
    expect(insertedRows).toHaveLength(0);
  });

  it('respects the JWKS cooldown before accepting a rotated signing key', async () => {
    const auth = await createSupabaseAuthFixture();
    const stale = await createSupabaseAuthFixture();
    const initialNow = Date.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(initialNow);
    const jwksFetch = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jwksResponse(stale.jwks))
      .mockResolvedValueOnce(jwksResponse(auth.jwks));
    const { env, insertedRows } = createMockEnv({
      post: publishedPost(),
      settings: defaultOpenSettings(),
      authEnabled: true,
      supabaseProjectUrl: auth.projectUrl,
    });

    const first = await worker.fetch(authenticatedCommentRequest(auth.token), env);
    const duringCooldown = await worker.fetch(authenticatedCommentRequest(auth.token), env);

    expect(first.status).toBe(401);
    expect(duringCooldown.status).toBe(401);
    expect(jwksFetch).toHaveBeenCalledTimes(1);
    expect(insertedRows).toHaveLength(0);

    now.mockReturnValue(initialNow + 30_001);
    const afterCooldown = await worker.fetch(authenticatedCommentRequest(auth.token), env);

    expect(afterCooldown.status).toBe(201);
    expect(insertedRows[0][17]).toBe('authenticated_user');
    expect(jwksFetch).toHaveBeenCalledTimes(2);
  });

  it('rejects an explicit bearer token when authentication is disabled', async () => {
    const auth = await createSupabaseAuthFixture();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { env, insertedRows } = createMockEnv({
      post: publishedPost(),
      settings: defaultOpenSettings(),
      authEnabled: false,
      supabaseProjectUrl: auth.projectUrl,
      supabasePublishableKey: 'sb_publishable_1234567890abcdefghijklmnop',
    });

    const response = await worker.fetch(authenticatedCommentRequest(auth.token), env);

    expect(response.status).toBe(401);
    expect((await readJson(response)).code).toBe('COMMENT_AUTH_NOT_ENABLED');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(insertedRows).toHaveLength(0);
  });

  it('applies the identity rate limit before challenge consumption', async () => {
    const auth = await createSupabaseAuthFixture();
    mockJwks(auth.jwks);
    const { env, insertedRows, kv, rateLimiter } = createMockEnv({
      post: publishedPost(),
      settings: defaultOpenSettings(),
      authEnabled: true,
      supabaseProjectUrl: auth.projectUrl,
      identityRateLimitSuccess: false,
    });

    const response = await worker.fetch(authenticatedCommentRequest(auth.token), env);

    expect(response.status).toBe(429);
    expect((await readJson(response)).code).toBe('RATE_LIMITED');
    expect(rateLimiter.limit).toHaveBeenCalledTimes(2);
    expect(kv.put).not.toHaveBeenCalled();
    expect(insertedRows).toHaveLength(0);
  });

  it('fails identity limiter outages closed before challenge consumption', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const auth = await createSupabaseAuthFixture();
    mockJwks(auth.jwks);
    const { env, insertedRows, kv, rateLimiter } = createMockEnv({
      post: publishedPost(),
      settings: defaultOpenSettings(),
      authEnabled: true,
      supabaseProjectUrl: auth.projectUrl,
    });
    rateLimiter.limit
      .mockResolvedValueOnce({ success: true })
      .mockRejectedValueOnce(new Error('Identity rate limiter unavailable'));
    const request = authenticatedCommentRequest(auth.token);
    request.headers.set('Origin', 'https://example.com');

    const response = await worker.fetch(request, env);

    expect(response.status).toBe(503);
    expect((await readJson(response)).code).toBe('RATE_LIMIT_NOT_AVAILABLE');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://example.com');
    expect(rateLimiter.limit).toHaveBeenCalledTimes(2);
    expect(kv.put).not.toHaveBeenCalled();
    expect(insertedRows).toHaveLength(0);
    expect(warn).toHaveBeenCalledExactlyOnceWith({
      message: 'Public API rate limiter failed',
      $zeropress: {
        code: 'RATE_LIMIT_NOT_AVAILABLE',
        binding: 'COMMENT_WRITE_RATE_LIMITER',
        guidance: expect.any(String),
      },
    });
  });

  it('requires the target request token before attempting Supabase verification', async () => {
    const auth = await createSupabaseAuthFixture();
    const jwksFetch = mockJwks(auth.jwks);
    const { env, insertedRows } = createMockEnv({
      post: publishedPost(),
      settings: defaultOpenSettings(),
      authEnabled: true,
      supabaseProjectUrl: auth.projectUrl,
    });
    const request = authenticatedCommentRequest(auth.token, { requestToken: 'invalid' });

    const response = await worker.fetch(request, env);

    expect(response.status).toBe(403);
    expect((await readJson(response)).code).toBe('INVALID_COMMENT_REQUEST_TOKEN');
    expect(jwksFetch).not.toHaveBeenCalled();
    expect(insertedRows).toHaveLength(0);
  });
});

describe('authenticated comment reads', () => {
  it('exposes only the authenticated_user discriminator', async () => {
    const { env, sqlCalls } = createMockEnv({
      post: publishedPost(),
      settings: defaultOpenSettings(),
      comments: [{
        id: 'comment-authenticated',
        public_id: 701,
        author_name: 'Member',
        author_kind: 'authenticated_user',
        author_email: 'member@example.com',
        author_identity_issuer: 'https://project.supabase.co/auth/v1',
        author_user_id: 'private-subject',
        content: 'Authenticated comment',
        created_at: '2026-07-19T01:02:03Z',
      }],
    });

    const response = await worker.fetch(new Request(commentsUrl()), env);
    const item = (await readJson(response)).comments[0];

    expect(response.status).toBe(200);
    expect(item.author_kind).toBe('authenticated_user');
    expect(item).not.toHaveProperty('author_email');
    expect(item).not.toHaveProperty('author_identity_issuer');
    expect(item).not.toHaveProperty('author_user_id');
    const query = sqlCalls.find((sql) => sql.includes('FROM comments c')) ?? '';
    expect(query).not.toContain('author_identity_issuer');
    expect(query).not.toContain('author_user_id');
    expect(query).not.toContain('author_email');
  });
});

type SupabaseAuthFixtureOptions = {
  email?: string;
  role?: string;
  isAnonymous?: boolean;
  expirationTime?: number;
  tokenIssuer?: string;
  audience?: string;
  subject?: string;
};

async function createSupabaseAuthFixture(
  options: SupabaseAuthFixtureOptions = { email: 'member@example.com' },
) {
  projectCounter += 1;
  const projectUrl = `https://auth-project-${projectCounter}.supabase.co`;
  const issuer = `${projectUrl}/auth/v1`;
  const keyPair = await generateKeyPair('ES256');
  const kid = `key-${projectCounter}`;
  const publicJwk = await exportJWK(keyPair.publicKey);
  const payload: Record<string, unknown> = {
    role: options.role ?? 'authenticated',
    is_anonymous: options.isAnonymous ?? false,
  };
  if (Object.prototype.hasOwnProperty.call(options, 'email')) {
    if (options.email !== undefined) payload.email = options.email;
  } else {
    payload.email = 'member@example.com';
  }
  const token = await new SignJWT(payload)
    .setProtectedHeader({ alg: 'ES256', kid, typ: 'JWT' })
    .setIssuer(options.tokenIssuer ?? issuer)
    .setAudience(options.audience ?? 'authenticated')
    .setSubject(options.subject ?? 'supabase-user-1')
    .setIssuedAt()
    .setExpirationTime(options.expirationTime ?? Math.floor(Date.now() / 1000) + 3600)
    .sign(keyPair.privateKey);

  return {
    projectUrl,
    token,
    jwks: {
      keys: [{ ...publicJwk, kid, alg: 'ES256', use: 'sig' } as JWK],
    },
  };
}

async function createSupabaseHs256AuthFixture() {
  projectCounter += 1;
  const projectUrl = `https://auth-project-${projectCounter}.supabase.co`;
  const token = await new SignJWT({
    role: 'authenticated',
    email: 'member@example.com',
    is_anonymous: false,
  })
    .setProtectedHeader({ alg: 'HS256', kid: `shared-key-${projectCounter}`, typ: 'JWT' })
    .setIssuer(`${projectUrl}/auth/v1`)
    .setAudience('authenticated')
    .setSubject('supabase-user-1')
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
    .sign(new TextEncoder().encode('test-only-supabase-hs256-secret-at-least-32-bytes'));

  return { projectUrl, token };
}

function authenticatedCommentRequest(token: string, options?: {
  authorEmail?: string;
  authorizationScheme?: string;
  authorizationValue?: string;
  requestToken?: string;
}): Request {
  return new Request(commentPostUrl(), {
    method: 'POST',
    headers: {
      authorization: options?.authorizationValue ?? `${options?.authorizationScheme ?? 'Bearer'} ${token}`,
      'content-type': 'application/json',
      'CF-Connecting-IP': '203.0.113.42',
    },
    body: JSON.stringify({
      author_name: 'Authenticated member',
      ...(options?.authorEmail === undefined ? {} : { author_email: options.authorEmail }),
      content_text: 'Authenticated comment',
      comment_request_token: options?.requestToken ?? TEST_COMMENT_REQUEST_TOKEN,
      ...commentWriteChallengeFields(),
    }),
  });
}

function mockJwks(jwks: { keys: JWK[] }) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(jwksResponse(jwks));
}

function jwksResponse(jwks: { keys: JWK[] }): Response {
  return new Response(JSON.stringify(jwks), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
