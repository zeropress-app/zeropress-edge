import { describe, expect, it } from 'vitest';
import { parsePublicSourceUrl } from './source-url';

const request = new Request('https://edge.example/api/forms/contact/submissions', {
  headers: { Origin: 'https://site.example' },
});

describe('parsePublicSourceUrl', () => {
  it('accepts allowed HTTP origins and strips fragments', () => {
    expect(parsePublicSourceUrl(
      'https://site.example/contact?from=form#untrusted',
      request,
      undefined,
      { required: true, maxLength: 2048 },
    )).toEqual({
      value: 'https://site.example/contact?from=form',
      errors: [],
    });
    expect(parsePublicSourceUrl(
      'https://allowed.example/contact',
      request,
      'https://allowed.example',
      { required: true, maxLength: 2048 },
    )).toEqual({
      value: 'https://allowed.example/contact',
      errors: [],
    });
  });

  it('allows an omitted optional source URL', () => {
    expect(parsePublicSourceUrl(undefined, request, undefined, {
      required: false,
      maxLength: 2048,
    })).toEqual({ value: null, errors: [] });
  });

  it.each([
    ['javascript:alert(1)', 'source_url must use http or https.'],
    ['https://user:password@site.example/contact', 'source_url must not include credentials.'],
    ['https://evil.example/contact', 'source_url origin is not allowed.'],
    ['/contact', 'source_url must be an absolute URL.'],
  ])('rejects unsafe source URL %s', (value, message) => {
    expect(parsePublicSourceUrl(value, request, undefined, {
      required: true,
      maxLength: 2048,
    })).toEqual({
      value: null,
      errors: [{ field: 'source_url', message }],
    });
  });
});
