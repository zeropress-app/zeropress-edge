import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../index';
import {
  ZP_NATIVE_PUBLIC_ID_BASE,
  TEST_EDGE_TOKEN_SIGNING_SECRET,
  TEST_COMMENT_REQUEST_TOKEN,
  commentPostUrl,
  commentWriteChallengeFields,
  commentsUrl,
  createMockEnv,
  defaultOpenSettings,
  publishedPost,
  readJson,
} from '../test-utils';
import {
  encodeBase64Url,
  signDerivedHmacSha256Base64Url,
  signHmacSha256Base64Url,
} from './crypto';

describe('zeropress-edge comments API', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns JSON comments for a published commentable post', async () => {
    const { env, sqlCalls } = createMockEnv({
      post: publishedPost(),
      comments: [
        {
          id: 'comment-1',
          public_id: 501,
          author_name: 'Alice',
          content: 'Hello\nworld',
          created_at: '2026-04-22T00:00:00Z',
          parent_id: null,
        },
      ],
      settings: defaultOpenSettings(),
    });

    const response = await worker.fetch(new Request(commentsUrl()), env);
    const payload = await readJson(response);

    expect(response.status).toBe(200);
    expect(payload).toEqual({
      comments: [
        {
          id: 501,
          parent_id: null,
          author_name: 'Alice',
          author_kind: 'guest',
          created_at_iso: '2026-04-22T00:00:00Z',
          content_text: 'Hello\nworld',
        },
      ],
      pagination: {
        page: 1,
        total_pages: 1,
        total_comments: 1,
      },
    });
    const settingsQueries = sqlCalls.filter((sql) => (
      sql.includes('edge_comment_settings') || sql.includes('edge_runtime_settings')
    ));
    expect(settingsQueries).toHaveLength(1);
    expect(settingsQueries[0]).toContain('JOIN edge_comment_settings');
    expect(settingsQueries[0]).toContain('FROM zeropress_edge_schema_state');
    expect(settingsQueries[0]).not.toContain('edge_runtime_settings');
  });

  it('exposes a trusted site-user discriminator without exposing internal identity data', async () => {
    const { env, sqlCalls } = createMockEnv({
      post: publishedPost(),
      comments: [
        {
          id: 'comment-1',
          public_id: 501,
          author_name: 'Site author',
          author_kind: 'site_user',
          author_email: 'author@example.com',
          author_user_id: 'studio-user-1',
          content: 'Official reply',
          created_at: '2026-04-22T00:00:00Z',
        },
      ],
      settings: defaultOpenSettings(),
    });

    const response = await worker.fetch(new Request(commentsUrl()), env);
    const payload = await readJson(response);

    expect(response.status).toBe(200);
    expect(payload.comments[0]).toEqual({
      id: 501,
      parent_id: null,
      author_name: 'Site author',
      author_kind: 'site_user',
      created_at_iso: '2026-04-22T00:00:00Z',
      content_text: 'Official reply',
    });
    expect(payload.comments[0]).not.toHaveProperty('author_email');
    expect(payload.comments[0]).not.toHaveProperty('author_user_id');
    const commentsQuery = sqlCalls.find((sql) => sql.includes('FROM comments c')) ?? '';
    expect(commentsQuery).toContain('c.author_kind');
    expect(commentsQuery).not.toContain('c.author_email');
    expect(commentsQuery).not.toContain('c.author_user_id');
  });

  it('serves Post and Page targets with the same numeric ID in complete isolation', async () => {
    const pageCredentials = await createTargetReadCredentials('page', 101, 'target-nonce-page-101');
    const { env } = createMockEnv({
      targets: [
        publishedPost(),
        {
          ...publishedPost(),
          id: 'page-db-1',
          target_type: 'page',
          request_token_nonce: 'target-nonce-page-101',
          comments_cache_revision: 'cache-revision-page-101',
        },
      ],
      comments: [
        {
          id: 'post-comment',
          public_id: 501,
          target_id: 1,
          author_name: 'Post author',
          content: 'Post body',
          created_at: '2026-04-22T00:00:00Z',
        },
        {
          id: 'page-comment',
          public_id: 502,
          target_id: 2,
          author_name: 'Page author',
          content: 'Page body',
          created_at: '2026-04-22T00:01:00Z',
        },
      ],
      settings: defaultOpenSettings(),
    });

    const postResponse = await worker.fetch(new Request(commentsUrl()), env);
    const pageResponse = await worker.fetch(new Request(
      `https://example.com/api/pages/101/comments?${pageCredentials}`,
    ), env);

    expect(postResponse.status).toBe(200);
    expect(pageResponse.status).toBe(200);
    expect((await readJson(postResponse)).comments.map((item: { id: number }) => item.id)).toEqual([501]);
    expect((await readJson(pageResponse)).comments.map((item: { id: number }) => item.id)).toEqual([502]);
  });

  it('creates Page comments through the generic target handler', async () => {
    const credentials = new URLSearchParams(await createTargetCredentials(
      'page',
      101,
      'target-nonce-page-101',
      'write',
    ));
    const { env, insertedRows } = createMockEnv({
      targets: [{
        ...publishedPost(),
        id: 'page-db-1',
        target_type: 'page',
        request_token_nonce: 'target-nonce-page-101',
        comments_cache_revision: 'cache-revision-page-101',
      }],
      settings: defaultOpenSettings(),
    });

    const challengeResponse = await worker.fetch(new Request(
      `https://example.com/api/pages/101/comments/challenge/write?comment_request_token=${encodeURIComponent(String(credentials.get('comment_request_token')))}`,
    ), env);

    const response = await worker.fetch(new Request('https://example.com/api/pages/101/comments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        author_name: 'Page author',
        author_email: 'page@example.com',
        content_text: 'Page comment',
        comment_request_token: credentials.get('comment_request_token'),
        comment_challenge_token: credentials.get('comment_challenge_token'),
        comment_challenge_solution: credentials.get('comment_challenge_solution'),
      }),
    }), env);

    expect(challengeResponse.status).toBe(200);
    expect((await readJson(challengeResponse)).pow.challenge_token).toMatch(/^c3\./);
    expect(response.status).toBe(201);
    expect((await readJson(response)).publication).toBe('pending_moderation');
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0][2]).toBe(1);
  });

  it('treats comments as unavailable when no API base URL is configured', async () => {
    const { env, sqlCalls } = createMockEnv({
      post: publishedPost(),
      settings: defaultOpenSettings(),
      apiBaseUrl: null,
    });

    const response = await worker.fetch(new Request(commentsUrl()), env);

    expect(response.status).toBe(404);
    expect((await readJson(response)).code).toBe('COMMENTS_NOT_FOUND');
    expect(sqlCalls.some((sql) => sql.includes('edge_comment_targets'))).toBe(false);
  });

  it('rejects tokens and challenges issued for a deleted incarnation of a target', async () => {
    const oldCredentials = await createTargetReadCredentials('post', 101, 'old-target-nonce');
    const newCredentials = await createTargetReadCredentials('post', 101, 'new-target-nonce');
    const oldChallenge = new URLSearchParams(oldCredentials).get('comment_challenge_token');
    const { env } = createMockEnv({
      post: {
        ...publishedPost(),
        request_token_nonce: 'new-target-nonce',
      },
      settings: defaultOpenSettings(),
    });

    const oldTokenResponse = await worker.fetch(new Request(
      `https://example.com/api/posts/101/comments?${oldCredentials}`,
    ), env);
    const mixed = new URLSearchParams(newCredentials);
    mixed.set('comment_challenge_token', String(oldChallenge));
    const oldChallengeResponse = await worker.fetch(new Request(
      `https://example.com/api/posts/101/comments?${mixed}`,
    ), env);

    expect(oldTokenResponse.status).toBe(403);
    expect((await readJson(oldTokenResponse)).code).toBe('INVALID_COMMENT_REQUEST_TOKEN');
    expect(oldChallengeResponse.status).toBe(403);
    expect((await readJson(oldChallengeResponse)).code).toBe('INVALID_COMMENT_CHALLENGE');
  });

  it('normalizes stored comment timestamps to UTC-second ISO', async () => {
    const { env } = createMockEnv({
      post: publishedPost(),
      comments: [
        {
          id: 'comment-naive',
          public_id: 501,
          author_name: 'Naive',
          content: 'Naive timestamp',
          created_at: '2026-04-22 00:00:00',
          parent_id: null,
        },
        {
          id: 'comment-fractional',
          public_id: 502,
          author_name: 'Fractional',
          content: 'Fractional timestamp',
          created_at: '2026-04-22T00:01:00.987Z',
          parent_id: null,
        },
        {
          id: 'comment-offset',
          public_id: 503,
          author_name: 'Offset',
          content: 'Offset timestamp',
          created_at: '2026-04-22T09:02:00+09:00',
          parent_id: null,
        },
      ],
      settings: defaultOpenSettings(),
    });

    const response = await worker.fetch(new Request(commentsUrl()), env);
    const payload = await readJson(response);

    expect(response.status).toBe(200);
    expect(payload.comments.map((comment: { created_at_iso: string }) => comment.created_at_iso)).toEqual([
      '2026-04-22T00:02:00Z',
      '2026-04-22T00:01:00Z',
      '2026-04-22T00:00:00Z',
    ]);
  });

  it('keeps comment reads available when edge runtime settings are missing', async () => {
    const { env, sqlCalls } = createMockEnv({
      post: publishedPost(),
      settings: defaultOpenSettings(),
      runtimeSettingsAvailable: false,
    });

    const response = await worker.fetch(new Request(commentsUrl()), env);

    expect(response.status).toBe(200);
    expect(sqlCalls.some((sql) => sql.includes('edge_runtime_settings'))).toBe(false);
  });

  it('fails closed when a stored comment timestamp is invalid', async () => {
    const { env } = createMockEnv({
      post: publishedPost(),
      comments: [
        {
          id: 'comment-invalid-timestamp',
          public_id: 501,
          author_name: 'Invalid',
          content: 'Invalid timestamp',
          created_at: 'not-a-date',
          parent_id: null,
        },
      ],
      settings: defaultOpenSettings(),
    });

    const response = await worker.fetch(new Request(commentsUrl()), env);
    const payload = await readJson(response);

    expect(response.status).toBe(500);
    expect(payload.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(payload)).not.toContain('not-a-date');
  });

  it('rejects unsupported query parameters', async () => {
    const { env } = createMockEnv();

    const response = await worker.fetch(new Request(commentsUrl('post=101&per_page=3')), env);
    const payload = await readJson(response);

    expect(response.status).toBe(400);
    expect(payload.code).toBe('UNSUPPORTED_QUERY');
    expect(payload.errors[0].field).toBe('per_page');
  });

  it('rejects duplicate allowed query parameters', async () => {
    const { env } = createMockEnv();

    const response = await worker.fetch(new Request(commentsUrl('post=101&page=1&page=2')), env);
    const payload = await readJson(response);

    expect(response.status).toBe(400);
    expect(payload.code).toBe('UNSUPPORTED_QUERY');
    expect(payload.errors).toEqual([
      {
        field: 'page',
        message: 'Duplicate query parameter: page.',
      },
    ]);
  });

  it('rejects malformed post and page values', async () => {
    const { env } = createMockEnv();

    const badPost = await worker.fetch(new Request('https://example.com/api/posts/hello/comments'), env);
    const badPage = await worker.fetch(new Request(commentsUrl('post=101&page=zero')), env);
    const badPostPayload = await readJson(badPost);

    expect(badPost.status).toBe(400);
    expect(badPostPayload.code).toBe('INVALID_COMMENT_TARGET_ID');
    expect(badPostPayload.errors[0].field).toBe('target_id');
    expect(badPage.status).toBe(400);
    expect((await readJson(badPage)).code).toBe('INVALID_PAGE');
  });

  it('returns not found when the post is unpublished or not commentable', async () => {
    const { env } = createMockEnv({
      post: {
        ...publishedPost(),
        status: 'draft',
      },
      settings: defaultOpenSettings(),
    });

    const response = await worker.fetch(new Request(commentsUrl()), env);
    const payload = await readJson(response);

    expect(response.status).toBe(404);
    expect(payload.code).toBe('COMMENTS_NOT_FOUND');
  });

  it('blocks comments when site comments are globally disabled', async () => {
    const { env } = createMockEnv({
      post: publishedPost(),
      settings: defaultOpenSettings({
        disallow_comments: { value: 'true', type: 'boolean' },
      }),
    });

    const response = await worker.fetch(new Request(commentsUrl()), env);
    const payload = await readJson(response);

    expect(response.status).toBe(403);
    expect(payload.code).toBe('COMMENTS_DISABLED');
  });

  it('sorts unordered rows and paginates by root-level comments with replies', async () => {
    const { env } = createMockEnv({
      post: publishedPost(),
      settings: defaultOpenSettings({
        comments_per_page: { value: '2', type: 'number' },
        comments_order: { value: 'desc', type: 'string' },
      }),
      comments: [
        {
          id: 'root-oldest',
          public_id: 501,
          author_name: 'Oldest root',
          content: 'Root 1',
          created_at: '2026-04-20T00:00:00Z',
          parent_id: null,
        },
        {
          id: 'reply-middle',
          public_id: 505,
          parent_public_id: 504,
          author_name: 'Middle reply',
          content: 'Reply 2',
          created_at: '2026-04-21T01:00:00Z',
          parent_id: 'root-middle',
        },
        {
          id: 'root-newest',
          public_id: 503,
          author_name: 'Newest root',
          content: 'Root 3',
          created_at: '2026-04-22T00:00:00Z',
          parent_id: null,
        },
        {
          id: 'root-middle',
          public_id: 504,
          author_name: 'Middle root',
          content: 'Root 2',
          created_at: '2026-04-21T00:00:00Z',
          parent_id: null,
        },
      ],
    });

    const response = await worker.fetch(new Request(commentsUrl('post=101&page=1')), env);
    const payload = await readJson(response);

    expect(response.status).toBe(200);
    expect(payload.pagination).toEqual({
      page: 1,
      total_pages: 2,
      total_comments: 4,
    });
    expect(payload.comments.map((comment: { id: number }) => comment.id)).toEqual([503, 504, 505]);
    expect(payload.comments.map((comment: { parent_id: number | null }) => comment.parent_id)).toEqual([null, null, 504]);
  });

  it('returns an empty comment page when requested page exceeds total pages', async () => {
    const { env } = createMockEnv({
      post: publishedPost(),
      settings: defaultOpenSettings({
        comments_per_page: { value: '2', type: 'number' },
      }),
      comments: [
        {
          id: 'root-1',
          public_id: 501,
          author_name: 'Root 1',
          content: 'Root 1',
          created_at: '2026-04-20T00:00:00Z',
          parent_id: null,
        },
        {
          id: 'root-2',
          public_id: 502,
          author_name: 'Root 2',
          content: 'Root 2',
          created_at: '2026-04-21T00:00:00Z',
          parent_id: null,
        },
        {
          id: 'reply-2',
          public_id: 503,
          parent_public_id: 502,
          author_name: 'Reply 2',
          content: 'Reply 2',
          created_at: '2026-04-21T01:00:00Z',
          parent_id: 'root-2',
        },
      ],
    });

    const response = await worker.fetch(new Request(commentsUrl('post=101&page=3')), env);
    const payload = await readJson(response);

    expect(response.status).toBe(200);
    expect(payload).toEqual({
      comments: [],
      pagination: {
        page: 3,
        total_pages: 1,
        total_comments: 3,
      },
    });
  });

  it('uses KV cached raw comments and keeps formatting request-specific', async () => {
    const cachedRows = JSON.stringify([
      {
        id: 'cached-comment',
        public_id: 601,
        target_id: 1,
        parent_public_id: null,
        author_name: 'Cached',
        author_kind: 'guest',
        content: 'Cached body',
        status: 'approved',
        imported: 0,
        created_at: '2026-04-22T00:00:00Z',
        parent_id: null,
      },
    ]);
    const { env, kv, sqlCalls } = createMockEnv({
      post: publishedPost(),
      settings: defaultOpenSettings(),
      kvValue: cachedRows,
    });

    const response = await worker.fetch(new Request(commentsUrl()), env);
    const payload = await readJson(response);

    expect(response.status).toBe(200);
    expect(payload.comments[0].id).toBe(601);
    expect(payload.pagination).toEqual({
      page: 1,
      total_pages: 1,
      total_comments: 1,
    });
    expect(kv.get).toHaveBeenCalledWith('comments:v3:post:101:cache-revision-post-101:approved');
    expect(kv.put).not.toHaveBeenCalled();
    expect(sqlCalls.some((sql) => sql.includes('FROM comments c'))).toBe(false);
  });

  it('uses the fixed 300 second comments cache lifetime', async () => {
    const { env, kv } = createMockEnv({
      post: publishedPost(),
      settings: defaultOpenSettings(),
    });

    const response = await worker.fetch(new Request(commentsUrl()), env);

    expect(response.status).toBe(200);
    expect(kv.get).toHaveBeenCalledWith('comments:v3:post:101:cache-revision-post-101:approved');
    expect(kv.put).toHaveBeenCalledWith(
      'comments:v3:post:101:cache-revision-post-101:approved',
      expect.any(String),
      { expirationTtl: 300 },
    );
  });

  it('returns imported WordPress comment content as plain text', async () => {
    const { env } = createMockEnv({
      post: publishedPost(),
      settings: defaultOpenSettings(),
      comments: [
        {
          id: 'comment-1',
          public_id: 501,
          author_name: 'Imported',
          content: '<p>반<br />\n가 ** 워 **<br />\n요 <a href="https://google.com">google</a><br />\n<code>whoami</code>&#8230;</p>\n',
          imported: 1,
          created_at: '2026-04-22T00:00:00Z',
          parent_id: null,
        },
      ],
    });

    const response = await worker.fetch(new Request(commentsUrl()), env);
    const payload = await readJson(response);

    expect(response.status).toBe(200);
    expect(payload.comments[0].content_text).toBe('반\n가 ** 워 **\n요 google\nwhoami…');
  });

  it('creates a pending root comment from JSON', async () => {
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('11111111-1111-4111-8111-111111111111');
    const { env, insertedRows, kv } = createMockEnv({
      post: publishedPost(),
      settings: defaultOpenSettings({
        require_comment_approval: { value: 'true', type: 'boolean' },
      }),
    });

    const request = new Request(commentPostUrl(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'CF-Connecting-IP': '203.0.113.42',
        'User-Agent': 'Comment test',
      },
      body: JSON.stringify({
        author_name: ' Alice\u0007😀 ',
        author_email: 'alice@example.com',
        content_text: 'Hello\u0000😀\r\n\r\n\r\nZero\tPress',
        comment_request_token: TEST_COMMENT_REQUEST_TOKEN,
        ...commentWriteChallengeFields(),
      }),
    });
    withCloudflareMetadata(request, {
      asn: 64500,
      asOrganization: 'Example Network',
      country: 'KR',
    });

    const response = await worker.fetch(request, env);
    const payload = await response.json();

    expect(response.status).toBe(201);
    expect(payload).toEqual({
      success: true,
      data: { publication: 'pending_moderation' },
    });
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0][0]).toBe('11111111111141118111111111111111');
    expect(insertedRows[0][1]).toBe(ZP_NATIVE_PUBLIC_ID_BASE + 1);
    expect(insertedRows[0][2]).toBe(1);
    expect(insertedRows[0][3]).toBeNull();
    expect(insertedRows[0][4]).toBe('Alice');
    expect(insertedRows[0][5]).toBe('alice@example.com');
    expect(insertedRows[0][6]).toBe('Hello😀\n\nZero Press');
    expect(insertedRows[0][7]).toBe('pending');
    expect(insertedRows[0][8]).toBe('203.0.113.42');
    expect(insertedRows[0][9]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(insertedRows[0][10]).toMatch(/^v1\.[A-Za-z0-9_-]+$/);
    expect(insertedRows[0][11]).toBe('Comment test');
    expect(insertedRows[0][12]).toBe(64500);
    expect(insertedRows[0][13]).toBe('Example Network');
    expect(insertedRows[0][14]).toBe('KR');
    expect(insertedRows[0][17]).toBe('guest');
    expect(insertedRows[0][18]).toBeNull();
    expect(insertedRows[0][19]).toBeNull();
    expect(kv.delete).not.toHaveBeenCalled();
  });

  it('creates a comment with Turnstile when the operator selects turnstile mode', async () => {
    const siteverify = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      success: true,
      action: 'comment_create',
      hostname: 'example.com',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const { env, insertedRows, kv, rateLimiter, turnstileRateLimiter } = createMockEnv({
      post: publishedPost(),
      settings: defaultOpenSettings(),
      writeVerificationMode: 'turnstile',
    });

    const response = await worker.fetch(new Request(commentPostUrl(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Origin: 'https://example.com',
        'CF-Connecting-IP': '203.0.113.42',
      },
      body: JSON.stringify({
        author_name: 'Alice',
        author_email: 'alice@example.com',
        content_text: 'Turnstile comment',
        comment_request_token: TEST_COMMENT_REQUEST_TOKEN,
        turnstile_token: 'turnstile-response-token',
      }),
    }), env);
    const payload = await readJson(response);

    expect(response.status).toBe(201);
    expect(payload).toEqual({ publication: 'pending_moderation' });
    expect(insertedRows).toHaveLength(1);
    expect(turnstileRateLimiter.limit).toHaveBeenCalledWith({ key: 'comment_create:203.0.113.42' });
    expect(rateLimiter.limit).toHaveBeenCalledWith({ key: '203.0.113.42' });
    expect(kv.put).not.toHaveBeenCalled();
    expect(siteverify).toHaveBeenCalledTimes(1);
    const [, init] = siteverify.mock.calls[0];
    const siteverifyBody = JSON.parse(String(init?.body));
    expect(siteverifyBody).toMatchObject({
      response: 'turnstile-response-token',
    });
    expect(siteverifyBody.remoteip).toBeUndefined();
    expect(siteverifyBody.cdata).toBeUndefined();
  });

  it('rejects a Turnstile action mismatch after consuming the business write quota', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      success: true,
      action: 'form_submit',
      hostname: 'example.com',
    }), { status: 200 }));
    const { env, insertedRows, rateLimiter, turnstileRateLimiter } = createMockEnv({
      post: publishedPost(),
      settings: defaultOpenSettings(),
      writeVerificationMode: 'turnstile',
    });

    const response = await worker.fetch(new Request(commentPostUrl(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Origin: 'https://example.com',
      },
      body: JSON.stringify({
        author_name: 'Alice',
        author_email: 'alice@example.com',
        content_text: 'Rejected comment',
        comment_request_token: TEST_COMMENT_REQUEST_TOKEN,
        turnstile_token: 'turnstile-response-token',
      }),
    }), env);
    const payload = await readJson(response);

    expect(response.status).toBe(403);
    expect(payload.code).toBe('INVALID_TURNSTILE_TOKEN');
    expect(turnstileRateLimiter.limit).toHaveBeenCalled();
    expect(rateLimiter.limit).toHaveBeenCalledWith({ key: 'unknown' });
    expect(insertedRows).toHaveLength(0);
  });

  it('fails comment writes closed for invalid runtime settings and incomplete Turnstile secrets', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const invalidMode = createMockEnv({
      post: publishedPost(),
      settings: defaultOpenSettings(),
      writeVerificationMode: 'pow_and_turnstile',
    });
    const missingSiteKey = createMockEnv({
      post: publishedPost(),
      settings: defaultOpenSettings(),
      writeVerificationMode: 'turnstile',
      turnstileSiteKey: null,
    });
    const missingSecret = createMockEnv({
      post: publishedPost(),
      settings: defaultOpenSettings(),
      writeVerificationMode: 'turnstile',
      turnstileSecretKey: null,
    });
    const request = () => new Request(commentPostUrl(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Origin: 'https://example.com',
      },
      body: JSON.stringify({
        author_name: 'Alice',
        author_email: 'alice@example.com',
        content_text: 'Configuration check',
        comment_request_token: TEST_COMMENT_REQUEST_TOKEN,
        turnstile_token: 'turnstile-response-token',
      }),
    });

    const invalidModeResponse = await worker.fetch(request(), invalidMode.env);
    const missingSiteKeyResponse = await worker.fetch(request(), missingSiteKey.env);
    const missingSecretResponse = await worker.fetch(request(), missingSecret.env);

    expect(invalidModeResponse.status).toBe(503);
    expect((await readJson(invalidModeResponse)).code).toBe('EDGE_RUNTIME_SETTINGS_NOT_AVAILABLE');
    expect(missingSiteKeyResponse.status).toBe(503);
    expect((await readJson(missingSiteKeyResponse)).code).toBe('EDGE_RUNTIME_SETTINGS_NOT_AVAILABLE');
    expect(missingSecretResponse.status).toBe(503);
    expect((await readJson(missingSecretResponse)).code).toBe('TURNSTILE_NOT_AVAILABLE');
    expect(invalidMode.insertedRows).toHaveLength(0);
    expect(missingSiteKey.insertedRows).toHaveLength(0);
    expect(missingSecret.insertedRows).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects mode-specific comment fields before checking a missing Turnstile secret', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const turnstile = createMockEnv({
      post: publishedPost(),
      settings: defaultOpenSettings(),
      writeVerificationMode: 'turnstile',
      turnstileSecretKey: null,
    });
    const pow = createMockEnv({
      post: publishedPost(),
      settings: defaultOpenSettings(),
    });
    const baseBody = {
      author_name: 'Alice',
      author_email: 'alice@example.com',
      content_text: 'Strict verification fields',
      comment_request_token: TEST_COMMENT_REQUEST_TOKEN,
    };

    const turnstileResponse = await worker.fetch(new Request(commentPostUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', Origin: 'https://example.com' },
      body: JSON.stringify({
        ...baseBody,
        turnstile_token: 'turnstile-response-token',
        ...commentWriteChallengeFields(),
      }),
    }), turnstile.env);
    const powResponse = await worker.fetch(new Request(commentPostUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...baseBody,
        ...commentWriteChallengeFields(),
        turnstile_token: 'turnstile-response-token',
      }),
    }), pow.env);
    const turnstilePayload = await readJson(turnstileResponse);
    const powPayload = await readJson(powResponse);

    expect(turnstileResponse.status).toBe(422);
    expect(turnstilePayload.errors.map((error: { field?: string }) => error.field)).toEqual([
      'comment_challenge_token',
      'comment_challenge_solution',
    ]);
    expect(powResponse.status).toBe(422);
    expect(powPayload.errors).toContainEqual({
      field: 'turnstile_token',
      message: 'Unsupported body field: turnstile_token.',
    });
    expect(turnstile.insertedRows).toHaveLength(0);
    expect(pow.insertedRows).toHaveLength(0);
    expect(turnstile.rateLimiter.limit).toHaveBeenCalledOnce();
    expect(pow.rateLimiter.limit).toHaveBeenCalledOnce();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects comment writes when IP_HASH_SECRET is missing', async () => {
    const { env, insertedRows } = createMockEnv({
      post: publishedPost(),
      settings: defaultOpenSettings(),
      ipHashSecret: null,
    });

    const response = await worker.fetch(new Request(commentPostUrl(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'CF-Connecting-IP': '203.0.113.42',
      },
      body: JSON.stringify({
        author_name: 'Alice',
        author_email: 'alice@example.com',
        content_text: 'Hello from JSON',
        comment_request_token: TEST_COMMENT_REQUEST_TOKEN,
        ...commentWriteChallengeFields(),
      }),
    }), env);
    const payload = await readJson(response);

    expect(response.status).toBe(503);
    expect(payload).toEqual({
      code: 'COMMENT_IP_HASH_NOT_AVAILABLE',
      message: 'Comments are temporarily unavailable.',
    });
    expect(insertedRows).toHaveLength(0);
  });

  it('normalizes stored comment IP address and user agent metadata', async () => {
    const { env, insertedRows } = createMockEnv({
      post: publishedPost(),
      settings: defaultOpenSettings(),
    });
    const normalizedUserAgent = `ZeroPress Test ${'x'.repeat(300)}`.slice(0, 250);

    const response = await worker.fetch(new Request(commentPostUrl(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'CF-Connecting-IP': 'a'.repeat(46),
        'User-Agent': `ZeroPress   Test ${'x'.repeat(300)}`,
      },
      body: JSON.stringify({
        author_name: 'Alice',
        author_email: 'alice@example.com',
        content_text: 'Hello from JSON',
        comment_request_token: TEST_COMMENT_REQUEST_TOKEN,
        ...commentWriteChallengeFields(),
      }),
    }), env);

    expect(response.status).toBe(201);
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0][8]).toBeNull();
    expect(insertedRows[0][9]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(insertedRows[0][10]).toBeNull();
    expect(insertedRows[0][11]).toBe(normalizedUserAgent);
    expect(String(insertedRows[0][11])).toHaveLength(250);
    expect(insertedRows[0][12]).toBeNull();
    expect(insertedRows[0][13]).toBeNull();
    expect(insertedRows[0][14]).toBeNull();
  });

  it('rejects a reused write challenge before creating another comment', async () => {
    const { env, insertedRows } = createMockEnv({
      post: publishedPost(),
      settings: defaultOpenSettings(),
    });
    const requestBody = {
      author_name: 'Alice',
      author_email: 'alice@example.com',
      content_text: 'Hello from JSON',
      comment_request_token: TEST_COMMENT_REQUEST_TOKEN,
      ...commentWriteChallengeFields(),
    };

    const firstResponse = await worker.fetch(new Request(commentPostUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(requestBody),
    }), env);
    const replayResponse = await worker.fetch(new Request(commentPostUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(requestBody),
    }), env);
    const replayPayload = await readJson(replayResponse);

    expect(firstResponse.status).toBe(201);
    expect(replayResponse.status).toBe(403);
    expect(replayPayload.code).toBe('COMMENT_CHALLENGE_ALREADY_USED');
    expect(insertedRows).toHaveLength(1);
  });

  it('creates an approved reply and invalidates the approved comments cache', async () => {
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('22222222-2222-4222-8222-222222222222');
    const { env, insertedRows, kv } = createMockEnv({
      post: publishedPost(),
      settings: defaultOpenSettings({
        require_comment_approval: { value: 'false', type: 'boolean' },
      }),
      comments: [
        {
          id: 'parent-internal-id',
          public_id: 501,
          author_name: 'Parent',
          content: 'Parent comment',
          created_at: '2026-04-22T00:00:00Z',
          parent_id: null,
        },
      ],
    });

    const response = await worker.fetch(new Request(commentPostUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        parent_id: 501,
        author_name: 'Bob',
        author_email: 'bob@example.com',
        content_text: 'Reply',
        comment_request_token: TEST_COMMENT_REQUEST_TOKEN,
        ...commentWriteChallengeFields(),
      }),
    }), env);
    const payload = await response.json();

    expect(response.status).toBe(201);
    expect(payload).toEqual({
      success: true,
      data: { publication: 'published' },
    });
    expect(insertedRows[0][3]).toBe(501);
    expect(insertedRows[0][7]).toBe('approved');
    expect(kv.delete).toHaveBeenCalledWith('comments:v3:post:101:cache-revision-post-101:approved');
  });

  it('creates native comment ids above the existing native high range', async () => {
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('33333333-3333-4333-8333-333333333333');
    const { env, insertedRows } = createMockEnv({
      post: publishedPost(),
      settings: defaultOpenSettings(),
      comments: [
        {
          id: 'imported-comment',
          public_id: 501,
          author_name: 'Imported',
          content: 'Imported',
          created_at: '2026-04-22T00:00:00Z',
          parent_id: null,
        },
        {
          id: 'native-comment',
          public_id: ZP_NATIVE_PUBLIC_ID_BASE + 12,
          author_name: 'Native',
          content: 'Native',
          created_at: '2026-04-22T00:00:00Z',
          parent_id: null,
        },
      ],
    });

    const response = await worker.fetch(new Request(commentPostUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        author_name: 'Alice',
        author_email: 'alice@example.com',
        content_text: 'Hello from JSON',
        comment_request_token: TEST_COMMENT_REQUEST_TOKEN,
        ...commentWriteChallengeFields(),
      }),
    }), env);
    const payload = await readJson(response);

    expect(response.status).toBe(201);
    expect(payload).toEqual({ publication: 'pending_moderation' });
    expect(insertedRows[0][1]).toBe(ZP_NATIVE_PUBLIC_ID_BASE + 13);
  });

  it('allocates distinct native public ids for concurrent comment inserts', async () => {
    const { env, insertedRows, sqlCalls } = createMockEnv({
      post: publishedPost(),
      settings: defaultOpenSettings(),
    });
    env.EDGE_KV = undefined;

    const responses = await Promise.all(Array.from({ length: 10 }, (_, index) => worker.fetch(
      new Request(commentPostUrl(), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'CF-Connecting-IP': `203.0.113.${index + 1}`,
        },
        body: JSON.stringify({
          author_name: `Author ${index}`,
          author_email: `author-${index}@example.com`,
          content_text: `Concurrent comment ${index}`,
          comment_request_token: TEST_COMMENT_REQUEST_TOKEN,
          ...commentWriteChallengeFields(),
        }),
      }),
      env,
    )));
    const payloads = await Promise.all(responses.map(readJson));

    expect(responses.map((response) => response.status)).toEqual(Array(10).fill(201));
    expect(payloads).toEqual(Array(10).fill({ publication: 'pending_moderation' }));
    expect(insertedRows.map((row) => Number(row[1])).sort((left, right) => left - right)).toEqual(
      Array.from({ length: 10 }, (_, index) => ZP_NATIVE_PUBLIC_ID_BASE + index + 1),
    );
    expect(new Set(insertedRows.map((row) => row[1])).size).toBe(10);
    expect(insertedRows).toHaveLength(10);
    expect(sqlCalls.filter((sql) => sql.includes('INSERT INTO comments'))).toHaveLength(10);
    expect(sqlCalls.some((sql) => sql.trimStart().startsWith('SELECT COALESCE(MAX(public_id)'))).toBe(false);
  });

  it('does not retry public_id constraint failures after atomic allocation', async () => {
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('44444444-4444-4444-8444-444444444444');
    const { env, insertedRows, sqlCalls } = createMockEnv({
      post: publishedPost(),
      settings: defaultOpenSettings(),
      insertErrors: [new Error('D1_ERROR: UNIQUE constraint failed: comments.public_id')],
    });

    const response = await worker.fetch(new Request(commentPostUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        author_name: 'Alice',
        author_email: 'alice@example.com',
        content_text: 'Hello from JSON',
        comment_request_token: TEST_COMMENT_REQUEST_TOKEN,
        ...commentWriteChallengeFields(),
      }),
    }), env);
    const payload = await readJson(response);

    expect(response.status).toBe(500);
    expect(payload.code).toBe('INTERNAL_ERROR');
    expect(insertedRows).toHaveLength(0);
    expect(sqlCalls.filter((sql) => sql.includes('INSERT INTO comments'))).toHaveLength(1);
    expect(globalThis.crypto.randomUUID).toHaveBeenCalledTimes(1);
  });

  it('does not retry non-public_id insert failures', async () => {
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('66666666-6666-4666-8666-666666666666');
    const { env, insertedRows } = createMockEnv({
      post: publishedPost(),
      settings: defaultOpenSettings(),
      insertErrors: [new Error('D1_ERROR: NOT NULL constraint failed: comments.content')],
    });

    const response = await worker.fetch(new Request(commentPostUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        author_name: 'Alice',
        author_email: 'alice@example.com',
        content_text: 'Hello from JSON',
        comment_request_token: TEST_COMMENT_REQUEST_TOKEN,
        ...commentWriteChallengeFields(),
      }),
    }), env);
    const payload = await readJson(response);

    expect(response.status).toBe(500);
    expect(payload.code).toBe('INTERNAL_ERROR');
    expect(insertedRows).toHaveLength(0);
    expect(globalThis.crypto.randomUUID).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid JSON and invalid content type', async () => {
    const { env } = createMockEnv();

    const badType = await worker.fetch(new Request(commentPostUrl(), {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data' },
      body: 'bad',
    }), env);
    const badJson = await worker.fetch(new Request(commentPostUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: '{',
    }), env);
    const jsonPrefixType = await worker.fetch(new Request(commentPostUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/jsonp' },
      body: '{}',
    }), env);

    expect(badType.status).toBe(415);
    expect((await readJson(badType)).code).toBe('UNSUPPORTED_MEDIA_TYPE');
    expect(badJson.status).toBe(400);
    expect((await readJson(badJson)).code).toBe('INVALID_JSON');
    expect(jsonPrefixType.status).toBe(415);
    expect((await readJson(jsonPrefixType)).code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('rejects comment bodies larger than 64 KiB before protected work', async () => {
    const { env, insertedRows, rateLimiter, sqlCalls, kv } = createMockEnv();

    const response = await worker.fetch(new Request(commentPostUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ padding: 'x'.repeat(64 * 1024) }),
    }), env);
    const payload = await readJson(response);

    expect(response.status).toBe(413);
    expect(payload).toEqual({
      code: 'REQUEST_BODY_TOO_LARGE',
      message: 'Request body exceeds the maximum allowed size.',
    });
    expect(rateLimiter.limit).not.toHaveBeenCalled();
    expect(sqlCalls).toHaveLength(0);
    expect(kv.get).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
    expect(insertedRows).toHaveLength(0);
  });

  it('rejects invalid body fields and values', async () => {
    const { env, insertedRows } = createMockEnv({
      post: publishedPost(),
      settings: defaultOpenSettings(),
    });

    const response = await worker.fetch(new Request(commentPostUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        parent_id: -1,
        author_name: '',
        author_email: 'alice@example.com😀',
        content_text: '',
        comment_request_token: TEST_COMMENT_REQUEST_TOKEN,
        ...commentWriteChallengeFields(),
        extra: true,
      }),
    }), env);
    const payload = await readJson(response);

    expect(response.status).toBe(422);
    expect(payload.code).toBe('VALIDATION_ERROR');
    expect(payload.errors.map((error: { field?: string }) => error.field)).toEqual([
      'extra',
      'parent_id',
      'author_name',
      'author_email',
      'content_text',
    ]);
    expect(insertedRows).toHaveLength(0);
  });

  it('rejects client-supplied author identity fields on the public write endpoint', async () => {
    const { env, insertedRows } = createMockEnv({
      post: publishedPost(),
      settings: defaultOpenSettings(),
    });

    const response = await worker.fetch(new Request(commentPostUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        author_name: 'Impersonator',
        author_email: 'guest@example.com',
        content_text: 'Client identity must not be trusted.',
        author_kind: 'site_user',
        author_identity_issuer: 'zeropress:studio',
        author_user_id: 'studio-user-1',
        comment_request_token: TEST_COMMENT_REQUEST_TOKEN,
        ...commentWriteChallengeFields(),
      }),
    }), env);
    const payload = await readJson(response);

    expect(response.status).toBe(422);
    expect(payload.code).toBe('VALIDATION_ERROR');
    expect(payload.errors.map((error: { field?: string }) => error.field)).toEqual([
      'author_kind',
      'author_identity_issuer',
      'author_user_id',
    ]);
    expect(insertedRows).toHaveLength(0);
  });

  it.each([
    '©',
    '😊',
    '👨‍👩‍👧‍👦 👍🏽 🇯🇵 1️⃣ © ™ ♥\uFE0E ♥\uFE0F <b>plain text</b>',
    'ところで、今日は忙しいのでこの業務を処理できません。',
  ])('preserves valid free text in comment storage: %s', async (content) => {
    const state = createMockEnv({ post: publishedPost(), settings: defaultOpenSettings() });
    const response = await worker.fetch(new Request(commentPostUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        author_name: 'Alice',
        author_email: 'alice@example.com',
        content_text: content,
        comment_request_token: TEST_COMMENT_REQUEST_TOKEN,
        ...commentWriteChallengeFields(),
      }),
    }), state.env);

    expect(response.status).toBe(201);
    expect(state.insertedRows[0][6]).toBe(content);
  });

  it('rejects comment content made empty by control-character cleanup before database work', async () => {
    const state = createMockEnv({ post: publishedPost(), settings: defaultOpenSettings() });
    const response = await worker.fetch(new Request(commentPostUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        author_name: 'Alice',
        author_email: 'alice@example.com',
        content_text: ' \u0000\u0007\u001B\u007F\u0085\u009F\t\r\n ',
        comment_request_token: TEST_COMMENT_REQUEST_TOKEN,
        ...commentWriteChallengeFields(),
      }),
    }), state.env);

    expect(response.status).toBe(422);
    expect((await readJson(response)).errors).toContainEqual({
      field: 'content_text', message: 'Comment content is required.',
    });
    expect(state.sqlCalls).toHaveLength(0);
    expect(state.insertedRows).toHaveLength(0);
  });

  it.each([
    ['ASCII', 'a'.repeat(5000)],
    ['emoji', '😊'.repeat(2500)],
  ])('enforces the 5000 UTF-16 code-unit comment limit for %s', async (_label, content) => {
    const accepted = createMockEnv({
      post: publishedPost(),
      settings: defaultOpenSettings(),
    });
    const rejected = createMockEnv({
      post: publishedPost(),
      settings: defaultOpenSettings(),
    });

    const acceptedResponse = await worker.fetch(new Request(commentPostUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        author_name: 'Alice',
        author_email: 'alice@example.com',
        content_text: content,
        comment_request_token: TEST_COMMENT_REQUEST_TOKEN,
        ...commentWriteChallengeFields(),
      }),
    }), accepted.env);
    const rejectedResponse = await worker.fetch(new Request(commentPostUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        author_name: 'Alice',
        author_email: 'alice@example.com',
        content_text: `${content}x`,
        comment_request_token: TEST_COMMENT_REQUEST_TOKEN,
        ...commentWriteChallengeFields(),
      }),
    }), rejected.env);
    const rejectedPayload = await readJson(rejectedResponse);

    expect(acceptedResponse.status).toBe(201);
    expect(accepted.insertedRows).toHaveLength(1);
    expect(accepted.insertedRows[0][6]).toBe(content);
    expect(rejectedResponse.status).toBe(422);
    expect(rejectedPayload.errors).toContainEqual({
      field: 'content_text',
      message: 'Comment content must be 5000 characters or fewer.',
    });
    expect(rejected.rateLimiter.limit).not.toHaveBeenCalled();
    expect(rejected.sqlCalls).toHaveLength(0);
    expect(rejected.insertedRows).toHaveLength(0);
  });

  it('rejects unknown parent comments', async () => {
    const { env } = createMockEnv({
      post: publishedPost(),
      settings: defaultOpenSettings(),
    });

    const response = await worker.fetch(new Request(commentPostUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        parent_id: 999,
        author_name: 'Alice',
        author_email: 'alice@example.com',
        content_text: 'Reply',
        comment_request_token: TEST_COMMENT_REQUEST_TOKEN,
        ...commentWriteChallengeFields(),
      }),
    }), env);
    const payload = await readJson(response);

    expect(response.status).toBe(422);
    expect(payload.errors[0].field).toBe('parent_id');
  });

  it.each(['pending', 'spam', 'trash'])('rejects a %s parent comment', async (status) => {
    const { env, insertedRows } = createMockEnv({
      post: publishedPost(),
      settings: defaultOpenSettings(),
      comments: [
        {
          id: `${status}-parent`,
          public_id: 501,
          author_name: 'Parent',
          content: 'Parent comment',
          status,
          created_at: '2026-04-22T00:00:00Z',
          parent_public_id: null,
        },
      ],
    });

    const response = await worker.fetch(new Request(commentPostUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        parent_id: 501,
        author_name: 'Alice',
        author_email: 'alice@example.com',
        content_text: 'Reply',
        comment_request_token: TEST_COMMENT_REQUEST_TOKEN,
        ...commentWriteChallengeFields(),
      }),
    }), env);
    const payload = await readJson(response);

    expect(response.status).toBe(422);
    expect(payload.errors).toContainEqual({
      field: 'parent_id',
      message: 'Parent comment was not found.',
    });
    expect(insertedRows).toHaveLength(0);
  });

  it('rejects a parent comment from another target', async () => {
    const { env, insertedRows } = createMockEnv({
      post: publishedPost(),
      settings: defaultOpenSettings(),
      comments: [
        {
          id: 'other-post-parent',
          public_id: 501,
          target_id: 2,
          author_name: 'Parent',
          content: 'Parent comment',
          status: 'approved',
          created_at: '2026-04-22T00:00:00Z',
          parent_public_id: null,
        },
      ],
    });

    const response = await worker.fetch(new Request(commentPostUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        parent_id: 501,
        author_name: 'Alice',
        author_email: 'alice@example.com',
        content_text: 'Reply',
        comment_request_token: TEST_COMMENT_REQUEST_TOKEN,
        ...commentWriteChallengeFields(),
      }),
    }), env);
    const payload = await readJson(response);

    expect(response.status).toBe(422);
    expect(payload.errors[0].field).toBe('parent_id');
    expect(insertedRows).toHaveLength(0);
  });

  it.each([
    {
      label: 'orphaned',
      comments: [
        {
          id: 'orphan-parent',
          public_id: 501,
          author_name: 'Parent',
          content: 'Parent comment',
          status: 'approved',
          created_at: '2026-04-22T00:00:00Z',
          parent_public_id: 999,
        },
      ],
    },
    {
      label: 'cyclic',
      comments: [
        {
          id: 'cycle-a',
          public_id: 501,
          author_name: 'Parent A',
          content: 'Parent A',
          status: 'approved',
          created_at: '2026-04-22T00:00:00Z',
          parent_public_id: 502,
        },
        {
          id: 'cycle-b',
          public_id: 502,
          author_name: 'Parent B',
          content: 'Parent B',
          status: 'approved',
          created_at: '2026-04-22T00:01:00Z',
          parent_public_id: 501,
        },
      ],
    },
  ])('rejects an $label parent chain', async ({ comments }) => {
    const { env, insertedRows } = createMockEnv({
      post: publishedPost(),
      settings: defaultOpenSettings(),
      comments,
    });

    const response = await worker.fetch(new Request(commentPostUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        parent_id: 501,
        author_name: 'Alice',
        author_email: 'alice@example.com',
        content_text: 'Reply',
        comment_request_token: TEST_COMMENT_REQUEST_TOKEN,
        ...commentWriteChallengeFields(),
      }),
    }), env);
    const payload = await readJson(response);

    expect(response.status).toBe(422);
    expect(payload.errors).toContainEqual({
      field: 'parent_id',
      message: 'Parent comment tree is invalid.',
    });
    expect(insertedRows).toHaveLength(0);
  });

  it('rejects replies when threaded comments are disabled', async () => {
    const { env, insertedRows } = createMockEnv({
      post: publishedPost(),
      settings: defaultOpenSettings({
        thread_comments: { value: 'false', type: 'boolean' },
      }),
      comments: [
        {
          id: 'parent-internal-id',
          public_id: 501,
          author_name: 'Parent',
          content: 'Parent comment',
          created_at: '2026-04-22T00:00:00Z',
          parent_public_id: null,
        },
      ],
    });

    const response = await worker.fetch(new Request(commentPostUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        parent_id: 501,
        author_name: 'Alice',
        author_email: 'alice@example.com',
        content_text: 'Reply',
        comment_request_token: TEST_COMMENT_REQUEST_TOKEN,
        ...commentWriteChallengeFields(),
      }),
    }), env);
    const payload = await readJson(response);

    expect(response.status).toBe(422);
    expect(payload.errors).toContainEqual({
      field: 'parent_id',
      message: 'Threaded replies are disabled.',
    });
    expect(insertedRows).toHaveLength(0);
  });

  it('rejects replies deeper than the configured thread depth', async () => {
    const { env, insertedRows } = createMockEnv({
      post: publishedPost(),
      settings: defaultOpenSettings({
        thread_comments_depth: { value: '2', type: 'number' },
      }),
      comments: [
        {
          id: 'root-internal-id',
          public_id: 501,
          author_name: 'Root',
          content: 'Root comment',
          created_at: '2026-04-22T00:00:00Z',
          parent_public_id: null,
        },
        {
          id: 'reply-internal-id',
          public_id: 502,
          author_name: 'Reply',
          content: 'Reply comment',
          created_at: '2026-04-22T01:00:00Z',
          parent_public_id: 501,
        },
      ],
    });

    const response = await worker.fetch(new Request(commentPostUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        parent_id: 502,
        author_name: 'Alice',
        author_email: 'alice@example.com',
        content_text: 'Deep reply',
        comment_request_token: TEST_COMMENT_REQUEST_TOKEN,
        ...commentWriteChallengeFields(),
      }),
    }), env);
    const payload = await readJson(response);

    expect(response.status).toBe(422);
    expect(payload.errors).toContainEqual({
      field: 'parent_id',
      message: 'Reply depth exceeds the configured limit.',
    });
    expect(insertedRows).toHaveLength(0);
  });

  it('applies the comment write rate limiter', async () => {
    const { env, rateLimiter, sqlCalls } = createMockEnv({
      post: publishedPost(),
      settings: defaultOpenSettings(),
      rateLimitSuccess: false,
    });

    const response = await worker.fetch(new Request(commentPostUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        author_name: 'Alice',
        author_email: 'alice@example.com',
        content_text: 'Hello',
        comment_request_token: TEST_COMMENT_REQUEST_TOKEN,
        ...commentWriteChallengeFields(),
      }),
    }), env);
    const payload = await readJson(response);

    expect(response.status).toBe(429);
    expect(payload.code).toBe('RATE_LIMITED');
    expect(rateLimiter.limit).toHaveBeenCalledWith({ key: 'unknown' });
    expect(sqlCalls).toHaveLength(0);
  });
});

function withCloudflareMetadata(request: Request, cf: Record<string, unknown>): Request {
  Object.defineProperty(request, 'cf', {
    value: cf,
    configurable: true,
  });
  return request;
}

async function createTargetCredentials(
  targetType: 'post' | 'page',
  targetPublicId: number,
  targetNonce: string,
  scope: 'read' | 'write' = 'read',
): Promise<string> {
  const requestSignature = await signHmacSha256Base64Url(
    'test-comment-secret',
    `v2:comments:${targetType}:${targetPublicId}:${targetNonce}`,
  );
  const payloadSegment = encodeBase64Url(JSON.stringify({
    v: 2,
    typ: 'comment_challenge',
    target_type: targetType,
    target_public_id: targetPublicId,
    target_nonce: targetNonce,
    scope,
    iat: 0,
    exp: 32_503_680_000,
    nonce: `test-${targetType}-${scope}`,
    difficulty: 0,
  }));
  const signatureMessage = `c3.${payloadSegment}`;
  const challengeSignature = await signDerivedHmacSha256Base64Url(
    TEST_EDGE_TOKEN_SIGNING_SECRET,
    'zeropress-edge/comment-challenge/v2',
    signatureMessage,
  );
  return new URLSearchParams({
    comment_request_token: `k_AAAAAAAAAAAAAAAAAAAAAA.${requestSignature}`,
    comment_challenge_token: `${signatureMessage}.${challengeSignature}`,
    comment_challenge_solution: '0',
  }).toString();
}

const createTargetReadCredentials = createTargetCredentials;
