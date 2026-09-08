import { describe, expect, it, vi } from 'vitest';
import type { Env } from './env';
import { consumeUsedChallenge } from './edge-kv';

describe('used PoW challenge replay markers', () => {
  it('keeps a freshly consumed 60-second write challenge for 120 seconds', async () => {
    const now = new Date('2026-07-13T00:00:00Z');
    const nowSeconds = Math.floor(now.getTime() / 1000);
    const kv = {
      get: vi.fn(async () => null),
      put: vi.fn(async () => undefined),
    };
    const env = { EDGE_KV: kv as unknown as KVNamespace } as Env;

    const result = await consumeUsedChallenge(env, {
      scope: 'comment-write',
      challengeToken: 'fresh-write-challenge',
      expiresAtSeconds: nowSeconds + 60,
      alreadyUsedCode: 'ALREADY_USED',
      alreadyUsedMessage: 'Already used.',
      now,
    });

    expect(result).toEqual({ ok: true });
    expect(kv.put).toHaveBeenCalledWith(
      expect.stringMatching(/^challenge-used:v1:comment-write:/),
      '1',
      { expirationTtl: 120 },
    );
  });

  it('applies the 60-second minimum to a challenge at or past expiry', async () => {
    const now = new Date('2026-07-13T00:00:00Z');
    const nowSeconds = Math.floor(now.getTime() / 1000);
    const kv = {
      get: vi.fn(async () => null),
      put: vi.fn(async () => undefined),
    };
    const env = { EDGE_KV: kv as unknown as KVNamespace } as Env;

    await consumeUsedChallenge(env, {
      scope: 'form-submit',
      challengeToken: 'expired-write-challenge',
      expiresAtSeconds: nowSeconds - 10,
      alreadyUsedCode: 'ALREADY_USED',
      alreadyUsedMessage: 'Already used.',
      now,
    });

    expect(kv.put).toHaveBeenCalledWith(
      expect.stringMatching(/^challenge-used:v1:form-submit:/),
      '1',
      { expirationTtl: 60 },
    );
  });
});
