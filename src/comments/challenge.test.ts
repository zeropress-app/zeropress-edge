import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../index';
import {
  TEST_CHALLENGE_SOLUTION,
  TEST_COMMENT_REQUEST_TOKEN,
  TEST_EDGE_TOKEN_SIGNING_SECRET,
  TEST_PREVIOUS_COMMENT_REQUEST_TOKEN,
  TEST_READ_CHALLENGE_TOKEN,
  TEST_WRITE_CHALLENGE_TOKEN,
  commentPostUrl,
  commentRequestSecretsSetting,
  commentsUrl,
  createMockEnv,
  defaultOpenSettings,
  publishedPost,
  readJson,
} from '../test-utils';
import { decodeBase64Url, encodeBase64Url, signDerivedHmacSha256Base64Url } from './crypto';

const COMMENT_CHALLENGE_HMAC_INFO = 'zeropress-edge/comment-challenge/v2';

describe('zeropress-edge comment challenge and token API', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('issues the fixed-strength comment challenge and accepts a valid read challenge', async () => {
    const { env } = createMockEnv({
      post: publishedPost(),
      settings: defaultOpenSettings(),
    });

    const challengeResponse = await worker.fetch(new Request(
      `https://example.com/api/posts/101/comments/challenge/read?comment_request_token=${TEST_COMMENT_REQUEST_TOKEN}`,
    ), env);
    const challenge = await readJson(challengeResponse);

    expect(challengeResponse.status).toBe(200);
    expect(challenge.algorithm).toBe('zp-comment-pow-v1');
    expect(challenge.scope).toBe('read');
    expect(challenge.difficulty).toBe(14);
    expect(challenge.challenge_token).toMatch(/^c3\./);
    expect(challengeLifetimeSeconds(challenge.challenge_token)).toBe(300);

    const response = await worker.fetch(new Request(
      `https://example.com/api/posts/101/comments?comment_request_token=${TEST_COMMENT_REQUEST_TOKEN}&comment_challenge_token=${encodeURIComponent(TEST_READ_CHALLENGE_TOKEN)}&comment_challenge_solution=${TEST_CHALLENGE_SOLUTION}`,
    ), env);

    expect(response.status).toBe(200);
  });

  it('advertises a nested PoW descriptor for comment writes by default', async () => {
    const { env, sqlCalls } = createMockEnv({
      post: publishedPost(),
      settings: defaultOpenSettings(),
    });

    const response = await worker.fetch(new Request(
      `https://example.com/api/posts/101/comments/challenge/write?comment_request_token=${TEST_COMMENT_REQUEST_TOKEN}`,
    ), env);
    const verification = await readJson(response);

    expect(response.status).toBe(200);
    expect(verification).toMatchObject({
      mode: 'pow',
      scope: 'write',
      pow: {
        algorithm: 'zp-comment-pow-v1',
        scope: 'write',
        difficulty: 15,
      },
    });
    expect(verification.pow.challenge_token).toMatch(/^c3\./);
    expect(challengeLifetimeSeconds(verification.pow.challenge_token)).toBe(60);
    expect(sqlCalls.filter((sql) => (
      sql.includes('edge_comment_settings') || sql.includes('edge_runtime_settings')
    ))).toHaveLength(1);
  });

  it('keeps read challenge discovery independent from runtime settings while write discovery fails closed', async () => {
    const { env } = createMockEnv({
      post: publishedPost(),
      settings: defaultOpenSettings(),
      runtimeSettingsAvailable: false,
    });

    const readResponse = await worker.fetch(new Request(
      `https://example.com/api/posts/101/comments/challenge/read?comment_request_token=${TEST_COMMENT_REQUEST_TOKEN}`,
    ), env);
    const writeResponse = await worker.fetch(new Request(
      `https://example.com/api/posts/101/comments/challenge/write?comment_request_token=${TEST_COMMENT_REQUEST_TOKEN}`,
    ), env);

    expect(readResponse.status).toBe(200);
    expect(writeResponse.status).toBe(503);
    expect((await readJson(writeResponse)).code).toBe('EDGE_RUNTIME_SETTINGS_NOT_AVAILABLE');
  });

  it('advertises Turnstile for comment writes without issuing a PoW challenge', async () => {
    const { env } = createMockEnv({
      post: publishedPost(),
      settings: defaultOpenSettings(),
      writeVerificationMode: 'turnstile',
      turnstileSiteKey: 'public-site-key',
      edgeTokenSigningSecret: null,
    });

    const response = await worker.fetch(new Request(
      `https://example.com/api/posts/101/comments/challenge/write?comment_request_token=${TEST_COMMENT_REQUEST_TOKEN}`,
    ), env);
    const verification = await readJson(response);

    expect(response.status).toBe(200);
    expect(verification).toEqual({
      mode: 'turnstile',
      scope: 'write',
      turnstile: {
        site_key: 'public-site-key',
        action: 'comment_create',
      },
    });
    expect(verification.pow).toBeUndefined();
  });

  it('applies the comment challenge rate limiter before issuing challenges', async () => {
    const { env, challengeRateLimiter, sqlCalls } = createMockEnv({
      challengeRateLimitSuccess: false,
    });

    const response = await worker.fetch(new Request(
      `https://example.com/api/posts/101/comments/challenge/read?comment_request_token=${TEST_COMMENT_REQUEST_TOKEN}`,
      {
        headers: {
          'CF-Connecting-IP': '203.0.113.88',
        },
      },
    ), env);
    const payload = await readJson(response);

    expect(response.status).toBe(429);
    expect(payload.code).toBe('RATE_LIMITED');
    expect(challengeRateLimiter.limit).toHaveBeenCalledWith({ key: '203.0.113.88' });
    expect(sqlCalls).toHaveLength(0);
  });

  it('accepts an unexpired previous comment request token', async () => {
    const { env } = createMockEnv({
      post: publishedPost(),
      settings: defaultOpenSettings(),
    });

    const response = await worker.fetch(new Request(
      `https://example.com/api/posts/101/comments?comment_request_token=${TEST_PREVIOUS_COMMENT_REQUEST_TOKEN}&comment_challenge_token=${encodeURIComponent(TEST_READ_CHALLENGE_TOKEN)}&comment_challenge_solution=${TEST_CHALLENGE_SOLUTION}`,
    ), env);

    expect(response.status).toBe(200);
  });

  it('rejects missing, mismatched, and expired comment request tokens', async () => {
    const missing = createMockEnv({
      post: publishedPost(),
      settings: defaultOpenSettings(),
    });
    const invalid = createMockEnv({
      post: publishedPost(),
      settings: defaultOpenSettings(),
    });
    const expired = createMockEnv({
      post: publishedPost(),
      settings: defaultOpenSettings({
        comment_request_secrets: commentRequestSecretsSetting({
          previousExpiresAt: '2000-01-01T00:00:00Z',
        }),
      }),
    });

    const missingResponse = await worker.fetch(new Request('https://example.com/api/posts/101/comments'), missing.env);
    const invalidResponse = await worker.fetch(new Request(
      'https://example.com/api/posts/101/comments?comment_request_token=k_AAAAAAAAAAAAAAAAAAAAAA.invalid',
    ), invalid.env);
    const expiredUrl = new URL(commentsUrl());
    expiredUrl.searchParams.set('comment_request_token', TEST_PREVIOUS_COMMENT_REQUEST_TOKEN);
    const expiredResponse = await worker.fetch(new Request(expiredUrl), expired.env);

    expect(missingResponse.status).toBe(403);
    expect((await readJson(missingResponse)).code).toBe('MISSING_COMMENT_REQUEST_TOKEN');
    expect(invalidResponse.status).toBe(403);
    expect((await readJson(invalidResponse)).code).toBe('INVALID_COMMENT_REQUEST_TOKEN');
    expect(expiredResponse.status).toBe(403);
    expect((await readJson(expiredResponse)).code).toBe('INVALID_COMMENT_REQUEST_TOKEN');
  });

  it('returns not found before signature verification for well-formed input when the target does not exist', async () => {
    const { env, sqlCalls } = createMockEnv({
      post: null,
      settings: defaultOpenSettings(),
    });

    const url = new URL(commentsUrl());
    url.searchParams.set('comment_request_token', `${TEST_COMMENT_REQUEST_TOKEN.slice(0, -1)}A`);
    const response = await worker.fetch(new Request(url), env);

    expect(response.status).toBe(404);
    expect((await readJson(response)).code).toBe('COMMENTS_NOT_FOUND');
    expect(sqlCalls.some((sql) => sql.includes('FROM edge_comment_targets'))).toBe(true);
  });

  it('requires a solved read comment challenge', async () => {
    const missing = createMockEnv({
      post: publishedPost(),
      settings: defaultOpenSettings(),
    });
    const invalid = createMockEnv({
      post: publishedPost(),
      settings: defaultOpenSettings(),
    });

    const missingResponse = await worker.fetch(new Request(
      `https://example.com/api/posts/101/comments?comment_request_token=${TEST_COMMENT_REQUEST_TOKEN}`,
    ), missing.env);
    const invalidResponse = await worker.fetch(new Request(
      `https://example.com/api/posts/101/comments?comment_request_token=${TEST_COMMENT_REQUEST_TOKEN}&comment_challenge_token=${encodeURIComponent(TEST_WRITE_CHALLENGE_TOKEN)}&comment_challenge_solution=0`,
    ), invalid.env);

    expect(missingResponse.status).toBe(403);
    expect((await readJson(missingResponse)).code).toBe('MISSING_COMMENT_CHALLENGE');
    expect(invalidResponse.status).toBe(403);
    expect((await readJson(invalidResponse)).code).toBe('INVALID_COMMENT_CHALLENGE');
  });

  it('requires EDGE_TOKEN_SIGNING_SECRET before issuing comment challenges', async () => {
    const missing = createMockEnv({
      post: publishedPost(),
      settings: defaultOpenSettings(),
      edgeTokenSigningSecret: null,
    });
    const tooShort = createMockEnv({
      post: publishedPost(),
      settings: defaultOpenSettings(),
      edgeTokenSigningSecret: 'too-short',
    });

    const missingResponse = await worker.fetch(new Request(
      `https://example.com/api/posts/101/comments/challenge/read?comment_request_token=${TEST_COMMENT_REQUEST_TOKEN}`,
    ), missing.env);
    const tooShortResponse = await worker.fetch(new Request(
      `https://example.com/api/posts/101/comments/challenge/read?comment_request_token=${TEST_COMMENT_REQUEST_TOKEN}`,
    ), tooShort.env);

    expect(missingResponse.status).toBe(503);
    expect((await readJson(missingResponse)).code).toBe('COMMENT_CHALLENGE_NOT_AVAILABLE');
    expect(tooShortResponse.status).toBe(503);
    expect((await readJson(tooShortResponse)).code).toBe('COMMENT_CHALLENGE_NOT_AVAILABLE');
  });

  it('requires EDGE_TOKEN_SIGNING_SECRET before verifying comment challenges', async () => {
    const { env } = createMockEnv({
      post: publishedPost(),
      settings: defaultOpenSettings(),
      edgeTokenSigningSecret: null,
    });

    const response = await worker.fetch(new Request(
      `https://example.com/api/posts/101/comments?comment_request_token=${TEST_COMMENT_REQUEST_TOKEN}&comment_challenge_token=${encodeURIComponent(TEST_READ_CHALLENGE_TOKEN)}&comment_challenge_solution=${TEST_CHALLENGE_SOLUTION}`,
    ), env);

    expect(response.status).toBe(503);
    expect((await readJson(response)).code).toBe('COMMENT_CHALLENGE_NOT_AVAILABLE');
  });

  it('rejects expired read comment challenges', async () => {
    const { env } = createMockEnv({
      post: publishedPost(),
      settings: defaultOpenSettings(),
    });
    const expiredChallengeToken = await createExpiredCommentChallengeToken('read');

    const response = await worker.fetch(new Request(
      `https://example.com/api/posts/101/comments?comment_request_token=${TEST_COMMENT_REQUEST_TOKEN}&comment_challenge_token=${encodeURIComponent(expiredChallengeToken)}&comment_challenge_solution=0`,
    ), env);
    const payload = await readJson(response);

    expect(response.status).toBe(403);
    expect(payload.code).toBe('EXPIRED_COMMENT_CHALLENGE');
  });

  it('returns not found before challenge verification when the target does not exist', async () => {
    const { env, sqlCalls } = createMockEnv({
      post: null,
      settings: defaultOpenSettings(),
    });

    const response = await worker.fetch(new Request(
      `https://example.com/api/posts/101/comments?comment_request_token=${TEST_COMMENT_REQUEST_TOKEN}&comment_challenge_token=${encodeURIComponent(TEST_WRITE_CHALLENGE_TOKEN)}&comment_challenge_solution=0`,
    ), env);

    expect(response.status).toBe(404);
    expect((await readJson(response)).code).toBe('COMMENTS_NOT_FOUND');
    expect(sqlCalls.some((sql) => sql.includes('FROM edge_comment_targets'))).toBe(true);
  });

  it('warns when comment_request_secrets is missing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { env } = createMockEnv({
      post: publishedPost(),
      settings: {
        disallow_comments: { value: 'false', type: 'boolean' },
      },
    });

    const response = await worker.fetch(new Request(commentsUrl()), env);
    const payload = await readJson(response);

    expect(response.status).toBe(403);
    expect(payload.code).toBe('INVALID_COMMENT_REQUEST_TOKEN');
    expect(warn).toHaveBeenCalledWith({
      message: 'Missing comment_request_secrets setting',
    });
  });

  it('rejects missing and invalid comment request tokens on writes', async () => {
    const missing = createMockEnv({
      post: publishedPost(),
      settings: defaultOpenSettings(),
    });
    const invalid = createMockEnv({
      post: publishedPost(),
      settings: defaultOpenSettings(),
    });

    const body = {
      author_name: 'Alice',
      author_email: 'alice@example.com',
      content_text: 'Hello',
    };
    const missingResponse = await worker.fetch(new Request(commentPostUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }), missing.env);
    const invalidResponse = await worker.fetch(new Request(commentPostUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...body,
        comment_request_token: 'k_AAAAAAAAAAAAAAAAAAAAAA.invalid',
      }),
    }), invalid.env);

    expect(missingResponse.status).toBe(403);
    expect((await readJson(missingResponse)).code).toBe('MISSING_COMMENT_REQUEST_TOKEN');
    expect(invalidResponse.status).toBe(403);
    expect((await readJson(invalidResponse)).code).toBe('INVALID_COMMENT_REQUEST_TOKEN');
  });

  it('requires a solved write comment challenge', async () => {
    const missing = createMockEnv({
      post: publishedPost(),
      settings: defaultOpenSettings(),
    });
    const invalid = createMockEnv({
      post: publishedPost(),
      settings: defaultOpenSettings(),
    });
    const body = {
      author_name: 'Alice',
      author_email: 'alice@example.com',
      content_text: 'Hello',
      comment_request_token: TEST_COMMENT_REQUEST_TOKEN,
    };

    const missingResponse = await worker.fetch(new Request(commentPostUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }), missing.env);
    const invalidResponse = await worker.fetch(new Request(commentPostUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...body,
        comment_challenge_token: TEST_READ_CHALLENGE_TOKEN,
        comment_challenge_solution: TEST_CHALLENGE_SOLUTION,
      }),
    }), invalid.env);

    expect(missingResponse.status).toBe(403);
    expect((await readJson(missingResponse)).code).toBe('MISSING_COMMENT_CHALLENGE');
    expect(invalidResponse.status).toBe(403);
    expect((await readJson(invalidResponse)).code).toBe('INVALID_COMMENT_CHALLENGE');
  });

});

async function createExpiredCommentChallengeToken(scope: 'read' | 'write'): Promise<string> {
  const payloadSegment = encodeBase64Url(JSON.stringify({
    v: 2,
    typ: 'comment_challenge',
    target_type: 'post',
    target_public_id: 101,
    target_nonce: 'target-nonce-post-101',
    scope,
    iat: 0,
    exp: 1,
    nonce: 'expired-test',
    difficulty: 0,
  }));
  const signatureMessage = `c3.${payloadSegment}`;
  const signature = await signDerivedHmacSha256Base64Url(
    TEST_EDGE_TOKEN_SIGNING_SECRET,
    COMMENT_CHALLENGE_HMAC_INFO,
    signatureMessage,
  );
  return `${signatureMessage}.${signature}`;
}

function challengeLifetimeSeconds(challengeToken: string): number {
  const payloadSegment = challengeToken.split('.')[1];
  const payload = JSON.parse(new TextDecoder().decode(decodeBase64Url(payloadSegment))) as {
    iat: number;
    exp: number;
  };
  return payload.exp - payload.iat;
}
