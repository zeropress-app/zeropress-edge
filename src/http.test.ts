import { describe, expect, it, vi } from 'vitest';
import worker from './index';
import { parseOptionalPage, parsePositiveIntegerString } from './http';
import {
  commentPostUrl,
  commentsUrl,
  createMockEnv,
  defaultOpenSettings,
  publishedPost,
  readJson,
} from './test-utils';

describe('zeropress-edge CORS and routing', () => {
  it('handles allowed preflight requests', async () => {
    const { env } = createMockEnv({
      allowedOrigins: 'https://site.example',
    });

    const response = await worker.fetch(new Request('https://api.example/api/posts/101/comments', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://site.example',
        'Access-Control-Request-Method': 'POST',
      },
    }), env);

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://site.example');
    expect(response.headers.get('access-control-allow-methods')).toBe('GET, POST, OPTIONS');
    expect(response.headers.get('vary')).toContain('Origin');
  });

  it('handles Page comment preflight requests through the same CORS policy', async () => {
    const { env } = createMockEnv({ allowedOrigins: 'https://site.example' });

    const response = await worker.fetch(new Request('https://api.example/api/pages/101/comments', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://site.example',
        'Access-Control-Request-Method': 'GET',
      },
    }), env);

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://site.example');
    expect(response.headers.get('access-control-allow-methods')).toBe('GET, POST, OPTIONS');
  });

  it('rejects disallowed cross-origin requests', async () => {
    const { env } = createMockEnv({
      allowedOrigins: 'https://site.example',
    });

    const response = await worker.fetch(new Request('https://api.example/api/posts/101/comments', {
      headers: {
        Origin: 'https://evil.example',
      },
    }), env);
    const rawPayload = await response.clone().json();
    const payload = await readJson(response);

    expect(response.status).toBe(403);
    expect(rawPayload).toEqual({
      success: false,
      error: {
        code: 'CORS_ORIGIN_DENIED',
        message: 'The request origin is not allowed.',
      },
    });
    expect(payload.code).toBe('CORS_ORIGIN_DENIED');
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('allows same-origin requests without explicit ALLOWED_ORIGINS', async () => {
    const { env } = createMockEnv({
      post: publishedPost(),
      settings: defaultOpenSettings(),
    });

    const response = await worker.fetch(new Request(commentsUrl(), {
      headers: {
        Origin: 'https://example.com',
      },
    }), env);
    const rawPayload = await response.clone().json() as {
      success: boolean;
      data: { items?: unknown[] };
    };

    expect(response.status).toBe(200);
    expect(rawPayload.success).toBe(true);
    expect(Array.isArray(rawPayload.data.items)).toBe(true);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://example.com');
  });

  it('returns method and known module route errors as structured JSON', async () => {
    const { env } = createMockEnv();

    const wrongRoute = await worker.fetch(new Request('https://example.com/api/posts/101/comments/unknown'), env);
    const wrongMethod = await worker.fetch(new Request(commentPostUrl(), {
      method: 'PUT',
    }), env);

    expect(wrongRoute.status).toBe(404);
    expect((await readJson(wrongRoute)).code).toBe('NOT_FOUND');
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get('allow')).toBe('GET, POST, OPTIONS');
  });

  it('returns empty 404 responses outside registered API module paths', async () => {
    const { env, sqlCalls } = createMockEnv();
    const paths = [
      '/',
      '/foo/bar',
      '/favicon.ico',
      '/api/unknown',
    ];

    for (const path of paths) {
      const response = await worker.fetch(new Request(`https://example.com${path}`), env);

      expect(response.status).toBe(404);
      expect(response.headers.get('content-type')).toBeNull();
      expect(await response.text()).toBe('');
    }
    expect(sqlCalls).toEqual([]);
  });

  it('returns empty 404 responses for disabled feature paths', async () => {
    const commentsDisabled = createMockEnv();
    commentsDisabled.env.COMMENTS_ENABLED = 'false';
    const newsletterDisabled = createMockEnv();
    newsletterDisabled.env.NEWSLETTER_ENABLED = 'false';
    const formsDisabled = createMockEnv();
    formsDisabled.env.FORMS_ENABLED = 'false';

    const responses = [
      await worker.fetch(new Request('https://example.com/api/posts/101/comments'), commentsDisabled.env),
      await worker.fetch(new Request('https://example.com/api/posts/101/comments/challenge/read'), commentsDisabled.env),
      await worker.fetch(new Request('https://example.com/api/pages/101/comments'), commentsDisabled.env),
      await worker.fetch(new Request('https://example.com/api/pages/101/comments/challenge/read'), commentsDisabled.env),
      await worker.fetch(new Request('https://example.com/api/newsletters/default'), newsletterDisabled.env),
      await worker.fetch(new Request('https://example.com/api/newsletters/default/challenge/subscribe'), newsletterDisabled.env),
      await worker.fetch(new Request('https://example.com/api/newsletters/default/subscriptions'), newsletterDisabled.env),
      await worker.fetch(new Request('https://example.com/api/newsletters/default/subscriptions/confirm?token=abc'), newsletterDisabled.env),
      await worker.fetch(new Request('https://example.com/api/forms/contact'), formsDisabled.env),
      await worker.fetch(new Request('https://example.com/api/forms/contact/challenge/submit'), formsDisabled.env),
      await worker.fetch(new Request('https://example.com/api/forms/contact/submissions'), formsDisabled.env),
    ];

    for (const response of responses) {
      expect(response.status).toBe(404);
      expect(response.headers.get('content-type')).toBeNull();
      expect(await response.text()).toBe('');
    }
    expect(commentsDisabled.sqlCalls).toEqual([]);
    expect(newsletterDisabled.sqlCalls).toEqual([]);
    expect(formsDisabled.sqlCalls).toEqual([]);
  });

  it('keeps every omitted feature disabled without accessing runtime bindings', async () => {
    const commentsOmitted = createMockEnv();
    delete commentsOmitted.env.COMMENTS_ENABLED;
    const newsletterOmitted = createMockEnv();
    delete newsletterOmitted.env.NEWSLETTER_ENABLED;
    const formsOmitted = createMockEnv();
    delete formsOmitted.env.FORMS_ENABLED;

    const cases = [
      [commentsOmitted, '/api/posts/101/comments'],
      [newsletterOmitted, '/api/newsletters/default'],
      [formsOmitted, '/api/forms/contact'],
    ] as const;

    for (const [state, path] of cases) {
      const response = await worker.fetch(new Request(`https://example.com${path}`), state.env);

      expect(response.status).toBe(404);
      expect(response.headers.get('content-type')).toBeNull();
      expect(await response.text()).toBe('');
      expect(state.sqlCalls).toEqual([]);
    }
  });

  it.each([
    ['COMMENTS_ENABLED', 'flase', '/api/posts/101/comments'],
    ['NEWSLETTER_ENABLED', 'TRUE', '/api/newsletters/default'],
    ['FORMS_ENABLED', '1', '/api/forms/contact'],
  ] as const)('fails %s closed when configured as %j', async (variable, value, path) => {
    const { env, sqlCalls } = createMockEnv();
    env[variable] = value;

    const response = await worker.fetch(new Request(`https://example.com${path}`), env);
    const payload = await readJson(response);

    expect(response.status).toBe(503);
    expect(payload.code).toBe('EDGE_CONFIGURATION_ERROR');
    expect(sqlCalls).toEqual([]);
  });

  it('keeps unsubscribe available when the newsletter gate is omitted but closes malformed configuration', async () => {
    const path = 'https://example.com/api/newsletters/default/subscriptions/unsubscribe';
    const omitted = createMockEnv();
    delete omitted.env.NEWSLETTER_ENABLED;

    const omittedResponse = await worker.fetch(new Request(path), omitted.env);

    expect(omittedResponse.status).toBe(405);
    expect((await readJson(omittedResponse)).code).toBe('METHOD_NOT_ALLOWED');
    expect(omitted.sqlCalls).toEqual([]);

    const malformed = createMockEnv();
    malformed.env.NEWSLETTER_ENABLED = 'enabled';

    const malformedResponse = await worker.fetch(new Request(path), malformed.env);

    expect(malformedResponse.status).toBe(503);
    expect((await readJson(malformedResponse)).code)
      .toBe('EDGE_CONFIGURATION_ERROR');
    expect(malformed.sqlCalls).toEqual([]);
  });

  it('preserves CORS preflight for a malformed feature setting', async () => {
    const { env, sqlCalls } = createMockEnv({
      allowedOrigins: 'https://site.example',
    });
    env.COMMENTS_ENABLED = ' true ';

    const response = await worker.fetch(new Request(
      'https://example.com/api/posts/101/comments',
      {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://site.example',
          'Access-Control-Request-Method': 'GET',
        },
      },
    ), env);

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin'))
      .toBe('https://site.example');
    expect(sqlCalls).toEqual([]);
  });

  it('temporarily stops every public module without changing feature gates', async () => {
    const { env, sqlCalls } = createMockEnv({
      allowedOrigins: 'https://site.example',
    });
    env.COMMENTS_ENABLED = 'true';
    env.NEWSLETTER_ENABLED = 'true';
    env.FORMS_ENABLED = 'false';
    env.EDGE_MAINTENANCE_MODE = 'true';
    const paths = [
      '/api/posts/101/comments',
      '/api/posts/101/comments/challenge/read',
      '/api/comments/auth',
      '/api/newsletters/default',
      '/api/newsletters/default/challenge/subscribe',
      '/api/newsletters/default/subscriptions',
      '/api/forms/contact',
      '/api/forms/contact/challenge/submit',
      '/api/forms/contact/submissions',
    ];

    for (const path of paths) {
      const response = await worker.fetch(new Request(
        `https://example.com${path}`,
        { headers: { Origin: 'https://site.example' } },
      ), env);
      const payload = await readJson(response);

      expect(response.status).toBe(503);
      expect(payload.code).toBe('EDGE_MAINTENANCE');
      expect(response.headers.get('access-control-allow-origin'))
        .toBe('https://site.example');
    }
    expect(sqlCalls).toEqual([]);
    expect(env.COMMENTS_ENABLED).toBe('true');
    expect(env.NEWSLETTER_ENABLED).toBe('true');
    expect(env.FORMS_ENABLED).toBe('false');
  });

  it.each([
    '',
    'TRUE',
    'False',
    '1',
    'yes',
    ' true ',
    'invalid',
  ])('fails public modules closed for invalid maintenance value %j', async (value) => {
    const { env, sqlCalls } = createMockEnv();
    env.EDGE_MAINTENANCE_MODE = value;

    const response = await worker.fetch(new Request(
      'https://example.com/api/posts/101/comments',
    ), env);
    const payload = await readJson(response);

    expect(response.status).toBe(503);
    expect(payload.code).toBe('EDGE_CONFIGURATION_ERROR');
    expect(sqlCalls).toEqual([]);
  });

  it('keeps CORS preflight available while maintenance blocks runtime requests', async () => {
    const { env, sqlCalls } = createMockEnv({
      allowedOrigins: 'https://site.example',
    });
    env.EDGE_MAINTENANCE_MODE = 'true';

    for (const path of [
      '/api/posts/101/comments',
      '/api/newsletters/default/subscriptions',
      '/api/forms/contact/submissions',
    ]) {
      const response = await worker.fetch(new Request(
        `https://example.com${path}`,
        {
          method: 'OPTIONS',
          headers: {
            Origin: 'https://site.example',
            'Access-Control-Request-Method': 'POST',
          },
        },
      ), env);

      expect(response.status).toBe(204);
      expect(response.headers.get('access-control-allow-origin'))
        .toBe('https://site.example');
    }
    expect(sqlCalls).toEqual([]);
  });

  it.each(['true', 'invalid'])(
    'keeps unknown non-module paths private under maintenance setting %j',
    async (value) => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { env, sqlCalls } = createMockEnv();
      env.EDGE_MAINTENANCE_MODE = value;

      const response = await worker.fetch(new Request(
        'https://example.com/not-an-edge-api',
      ), env);

      expect(response.status).toBe(404);
      expect(response.headers.get('content-type')).toBeNull();
      expect(await response.text()).toBe('');
      expect(sqlCalls).toEqual([]);
      expect(error).not.toHaveBeenCalled();
      error.mockRestore();
    },
  );

  it('skips scheduled D1 maintenance in Edge maintenance mode', async () => {
    const { env, sqlCalls } = createMockEnv();
    env.EDGE_MAINTENANCE_MODE = 'true';

    await expect(worker.scheduled(
      {} as ScheduledController,
      env,
      {} as ExecutionContext,
    )).resolves.toBeUndefined();
    expect(sqlCalls).toEqual([]);
  });

  it('fails scheduled work closed and logs one diagnostic for invalid maintenance configuration', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { env, sqlCalls } = createMockEnv();
    env.EDGE_MAINTENANCE_MODE = 'on';

    await expect(worker.scheduled(
      {} as ScheduledController,
      env,
      {} as ExecutionContext,
    )).rejects.toThrow('EDGE_MAINTENANCE_MODE');
    expect(sqlCalls).toEqual([]);
    expect(error).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith(expect.objectContaining({
      $zeropress: expect.objectContaining({
        code: 'EDGE_CONFIGURATION_ERROR',
        action: 'run_scheduled_ip_retention',
      }),
    }));
  });
});

describe('positive integer HTTP parsing', () => {
  it('accepts the largest exactly representable positive integer', () => {
    expect(parsePositiveIntegerString('9007199254740991'))
      .toBe(Number.MAX_SAFE_INTEGER);
  });

  it.each([
    '9007199254740992',
    '9007199254740993',
    '9999999999999999999999999999999999999999',
  ])('rejects unsafe integer %s', (value) => {
    expect(parsePositiveIntegerString(value)).toBe(0);
    expect(parseOptionalPage(value)).toBe(0);
  });
});
