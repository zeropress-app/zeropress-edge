import { describe, expect, it } from 'vitest';
import worker from '../index';
import { createMockEnv, readJson } from '../test-utils';

const AUTH_URL = 'https://edge.example/api/comments/auth';
const TEST_PUBLISHABLE_KEY = 'sb_publishable_1234567890abcdefghijklmnop';

describe('comments authentication discovery endpoint', () => {
  it('returns a minimal disabled response without exposing retained configuration', async () => {
    const { env, sqlCalls } = createMockEnv({
      authEnabled: false,
      supabaseProjectUrl: 'https://retained.supabase.co',
      supabasePublishableKey: TEST_PUBLISHABLE_KEY,
    });

    const response = await worker.fetch(new Request(AUTH_URL), env);

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({ enabled: false });
    expect(sqlCalls).toHaveLength(1);
    expect(sqlCalls[0]).toContain('auth_enabled');
    expect(sqlCalls[0]).not.toContain('edge_runtime_settings');
    expect(response.headers.get('cache-control')).toBe('private, no-store, max-age=0');
  });

  it('returns normalized public Supabase client configuration when enabled', async () => {
    const { env } = createMockEnv({
      authEnabled: true,
      supabaseProjectUrl: 'https://auth-project.supabase.co/',
      supabasePublishableKey: TEST_PUBLISHABLE_KEY,
      allowedOrigins: 'https://blog.example',
    });

    const response = await worker.fetch(new Request(AUTH_URL, {
      headers: { Origin: 'https://blog.example' },
    }), env);

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({
      enabled: true,
      provider: 'supabase',
      mode: 'optional',
      project_url: 'https://auth-project.supabase.co',
      publishable_key: TEST_PUBLISHABLE_KEY,
    });
    expect(response.headers.get('access-control-allow-origin')).toBe('https://blog.example');
  });

  it('allows discovery when the optional read limiter is not bound', async () => {
    const { env, sqlCalls } = createMockEnv();
    delete env.COMMENT_READ_RATE_LIMITER;

    const response = await worker.fetch(new Request(AUTH_URL), env);

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({ enabled: false });
    expect(sqlCalls).toHaveLength(1);
  });

  it('fails closed for malformed enabled settings', async () => {
    const { env } = createMockEnv({
      authEnabled: true,
      supabaseProjectUrl: 'https://auth-project.supabase.co/path',
      supabasePublishableKey: TEST_PUBLISHABLE_KEY,
    });

    const response = await worker.fetch(new Request(AUTH_URL), env);

    expect(response.status).toBe(503);
    expect((await readJson(response)).code).toBe('COMMENT_AUTH_SETTINGS_NOT_AVAILABLE');
  });

  it('uses normal exact-origin CORS and advertises Authorization on preflight', async () => {
    const { env, sqlCalls } = createMockEnv({ allowedOrigins: 'https://blog.example' });

    const denied = await worker.fetch(new Request(AUTH_URL, {
      headers: { Origin: 'https://not-allowed.example' },
    }), env);
    const preflight = await worker.fetch(new Request(AUTH_URL, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://blog.example',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'authorization',
      },
    }), env);

    expect(denied.status).toBe(403);
    expect((await readJson(denied)).code).toBe('CORS_ORIGIN_DENIED');
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('https://blog.example');
    expect(preflight.headers.get('access-control-allow-methods')).toBe('GET, OPTIONS');
    expect(preflight.headers.get('access-control-allow-headers')).toBe('authorization, content-type');
    expect(sqlCalls).toEqual([]);
  });

  it('rejects unsupported methods and query parameters', async () => {
    const { env } = createMockEnv();

    const methodResponse = await worker.fetch(new Request(AUTH_URL, { method: 'POST' }), env);
    const queryResponse = await worker.fetch(new Request(`${AUTH_URL}?unexpected=1`), env);

    expect(methodResponse.status).toBe(405);
    expect(methodResponse.headers.get('allow')).toBe('GET, OPTIONS');
    expect((await readJson(methodResponse)).code).toBe('METHOD_NOT_ALLOWED');
    expect(queryResponse.status).toBe(400);
    expect((await readJson(queryResponse)).code).toBe('UNSUPPORTED_QUERY');
  });

  it('returns the feature-gate empty 404 without reading D1 when comments are disabled', async () => {
    const { env, sqlCalls, readRateLimiter } = createMockEnv({ authEnabled: true });
    env.COMMENTS_ENABLED = 'false';

    const response = await worker.fetch(new Request(AUTH_URL), env);

    expect(response.status).toBe(404);
    expect(await response.text()).toBe('');
    expect(sqlCalls).toEqual([]);
    expect(readRateLimiter.limit).not.toHaveBeenCalled();
  });
});
