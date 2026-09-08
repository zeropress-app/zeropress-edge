import { describe, expect, it } from 'vitest';
import {
  normalizeSupabaseProjectUrl,
  normalizeSupabasePublishableKey,
  parseCommentAuthConfig,
} from './auth-config';

const VALID_KEY = `sb_publishable_${'a'.repeat(16)}`;

describe('Supabase comment auth settings', () => {
  it.each([
    ['https://example.supabase.co', 'https://example.supabase.co'],
    ['https://EXAMPLE.supabase.co/', 'https://example.supabase.co'],
    ['http://localhost:54321', 'http://localhost:54321'],
    ['http://127.0.0.1:54321/', 'http://127.0.0.1:54321'],
    ['http://[::1]:54321', 'http://[::1]:54321'],
  ])('normalizes supported project origin %s', (value, expected) => {
    expect(normalizeSupabaseProjectUrl(value)).toBe(expected);
  });

  it.each([
    'http://example.supabase.co',
    'https://user:pass@example.supabase.co',
    'https://example.supabase.co/path',
    'https://example.supabase.co?query=1',
    'https://example.supabase.co#fragment',
    ' https://example.supabase.co',
    'https:\\example.supabase.co',
  ])('rejects unsafe or non-origin project URL %s', (value) => {
    expect(normalizeSupabaseProjectUrl(value)).toBeNull();
  });

  it('accepts only the canonical public publishable-key format and bounds', () => {
    expect(normalizeSupabasePublishableKey(`sb_publishable_${'a'.repeat(16)}`)).not.toBeNull();
    expect(normalizeSupabasePublishableKey(`sb_publishable_${'A0._-'.repeat(102).slice(0, 512)}`)).not.toBeNull();
    expect(normalizeSupabasePublishableKey(`sb_publishable_${'a'.repeat(15)}`)).toBeNull();
    expect(normalizeSupabasePublishableKey(`sb_publishable_${'a'.repeat(513)}`)).toBeNull();
    expect(normalizeSupabasePublishableKey(`sb_publishable_${'a'.repeat(15)}!`)).toBeNull();
    expect(normalizeSupabasePublishableKey(` ${VALID_KEY}`)).toBeNull();
  });

  it('allows disabled settings to retain a complete pair but never a partial pair', () => {
    expect(parseCommentAuthConfig({
      auth_enabled: 0,
      supabase_project_url: 'https://example.supabase.co',
      supabase_publishable_key: VALID_KEY,
    })).toMatchObject({
      ok: true,
      config: {
        enabled: false,
        issuer: 'https://example.supabase.co/auth/v1',
      },
    });

    expect(parseCommentAuthConfig({
      auth_enabled: 0,
      supabase_project_url: 'https://example.supabase.co',
      supabase_publishable_key: null,
    })).toEqual({ ok: false, reason: 'invalid_settings' });
  });

  it('requires a complete valid pair when enabled', () => {
    expect(parseCommentAuthConfig({
      auth_enabled: 1,
      supabase_project_url: 'https://example.supabase.co',
      supabase_publishable_key: VALID_KEY,
    })).toMatchObject({
      ok: true,
      config: {
        enabled: true,
        provider: 'supabase',
        mode: 'optional',
        projectUrl: 'https://example.supabase.co',
        publishableKey: VALID_KEY,
        issuer: 'https://example.supabase.co/auth/v1',
      },
    });
    expect(parseCommentAuthConfig({
      auth_enabled: 1,
      supabase_project_url: null,
      supabase_publishable_key: null,
    })).toEqual({ ok: false, reason: 'invalid_settings' });
  });
});
