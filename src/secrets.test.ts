import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from './env';
import { getIpHashSecret } from './ip-hash-secret';
import { getEdgeTokenSigningSecret } from './token-secret';

describe.each([
  { name: 'EDGE_TOKEN_SIGNING_SECRET', getSecret: getEdgeTokenSigningSecret },
  { name: 'IP_HASH_SECRET', getSecret: getIpHashSecret },
])('$name minimum length', ({ name, getSecret }) => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function readSecret(value: string): string {
    const env: Partial<Env> = { [name]: value };
    return getSecret(env as Env);
  }

  it.each([48, 63])('rejects a %i-character secret', (length) => {
    expect(readSecret('a'.repeat(length))).toBe('');
  });

  it.each([64, 65])('accepts a %i-character secret without requiring hex encoding', (length) => {
    const secret = 's'.repeat(length);
    expect(readSecret(secret)).toBe(secret);
  });

  it('does not count surrounding whitespace toward the minimum length', () => {
    expect(readSecret(` \t${'a'.repeat(63)}\n `)).toBe('');
    const secret = '0123456789abcdef'.repeat(4);
    expect(readSecret(` \t${secret}\n `)).toBe(secret);
  });
});
