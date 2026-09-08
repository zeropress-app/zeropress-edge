import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TURNSTILE_SITEVERIFY_MAX_ATTEMPTS,
  TURNSTILE_SITEVERIFY_TIMEOUT_MS,
  TURNSTILE_SITEVERIFY_URL,
  TURNSTILE_TOKEN_MAX_LENGTH,
  applyTurnstileVerifyRateLimit,
  createWriteVerificationDescriptor,
  parseTurnstileToken,
  verifyTurnstileToken,
  type TurnstileAction,
} from './turnstile';

const SECRET = 'turnstile-secret-for-tests';
const TOKEN = 'turnstile-token-for-tests';
const ACTION: TurnstileAction = 'comment_create';
let warnSpy = vi.fn();

beforeEach(() => {
  warnSpy = vi.fn();
  vi.spyOn(console, 'warn').mockImplementation(warnSpy);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('write verification descriptor', () => {
  it('does not require or expose a Turnstile sitekey in pow mode', () => {
    expect(createWriteVerificationDescriptor({}, null, 'pow', 'comment_create')).toEqual({
      ok: true,
      descriptor: { mode: 'pow' },
    });
  });

  it.each([undefined, '', '   '])('fails closed when the Turnstile sitekey is unavailable (%j)', (siteKey) => {
    expect(createWriteVerificationDescriptor(
      { TURNSTILE_SECRET_KEY: SECRET },
      siteKey ?? null,
      'turnstile',
      'newsletter_subscribe',
    )).toMatchObject({
      ok: false,
      kind: 'unavailable',
      code: 'TURNSTILE_NOT_AVAILABLE',
    });
    expect(warnSpy).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Turnstile configuration is incomplete',
      $zeropress: expect.objectContaining({
        code: 'TURNSTILE_NOT_AVAILABLE',
        action: 'newsletter_subscribe',
        missingSettings: ['edge_runtime_settings.turnstile_sitekey'],
      }),
    }));
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(SECRET);
  });

  it.each([undefined, '', '   '])('fails closed without exposing a missing Turnstile secret (%j)', (secret) => {
    const result = createWriteVerificationDescriptor(
      { TURNSTILE_SECRET_KEY: secret },
      'public-site-key',
      'turnstile',
      'newsletter_subscribe',
    );
    expect(result).toMatchObject({
      ok: false,
      kind: 'unavailable',
      code: 'TURNSTILE_NOT_AVAILABLE',
    });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(warnSpy).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Turnstile configuration is incomplete',
      $zeropress: expect.objectContaining({
        missingSettings: ['TURNSTILE_SECRET_KEY'],
      }),
    }));
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain('public-site-key');
  });

  it.each([
    ['comment_create', 'comment_create'],
    ['newsletter_subscribe', 'newsletter_subscribe'],
    ['form_submit', 'form_submit'],
  ] as const)('returns the public sitekey and exact %s action', (action, expectedAction) => {
    expect(createWriteVerificationDescriptor(
      { TURNSTILE_SECRET_KEY: ` ${SECRET} ` },
      ' public-site-key ',
      'turnstile',
      action,
    )).toEqual({
      ok: true,
      descriptor: {
        mode: 'turnstile',
        turnstile: {
          site_key: 'public-site-key',
          action: expectedAction,
        },
      },
    });
  });
});

describe('Turnstile token input', () => {
  it('accepts the documented 1 through 2048 character range', () => {
    expect(parseTurnstileToken('a')).toBe('a');
    expect(parseTurnstileToken('a'.repeat(TURNSTILE_TOKEN_MAX_LENGTH))).toHaveLength(2_048);
  });

  it.each([
    undefined,
    null,
    1,
    '',
    ' ',
    ' token',
    'token ',
    'a'.repeat(TURNSTILE_TOKEN_MAX_LENGTH + 1),
  ])('rejects invalid token input without coercion (%j)', (value) => {
    expect(parseTurnstileToken(value)).toBeNull();
  });
});

describe('optional Turnstile verification rate limiter', () => {
  it('continues when the binding is absent', async () => {
    await expect(applyTurnstileVerifyRateLimit({}, 'comment_create', '203.0.113.7')).resolves.toEqual({ ok: true });
  });

  it('uses an action and client IP scoped key', async () => {
    const limit = vi.fn(async () => ({ success: true }));
    await expect(applyTurnstileVerifyRateLimit(
      { TURNSTILE_VERIFY_RATE_LIMITER: { limit } },
      'form_submit',
      '203.0.113.8',
    )).resolves.toEqual({ ok: true });
    expect(limit).toHaveBeenCalledWith({ key: 'form_submit:203.0.113.8' });
  });

  it('distinguishes a rate limit rejection from an unavailable limiter', async () => {
    const limited = { limit: vi.fn(async () => ({ success: false })) };
    const unavailable = { limit: vi.fn(async () => { throw new Error('binding unavailable'); }) };

    await expect(applyTurnstileVerifyRateLimit(
      { TURNSTILE_VERIFY_RATE_LIMITER: limited },
      'newsletter_subscribe',
      '198.51.100.3',
    )).resolves.toMatchObject({ ok: false, kind: 'rate_limited', code: 'TURNSTILE_VERIFY_RATE_LIMITED' });
    expect(warnSpy).not.toHaveBeenCalled();
    await expect(applyTurnstileVerifyRateLimit(
      { TURNSTILE_VERIFY_RATE_LIMITER: unavailable },
      'newsletter_subscribe',
      '198.51.100.3',
    )).resolves.toMatchObject({
      ok: false,
      kind: 'unavailable',
      code: 'TURNSTILE_VERIFY_RATE_LIMIT_NOT_AVAILABLE',
    });
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy).toHaveBeenCalledWith({
      message: 'Turnstile verification rate limiter failed',
      $zeropress: {
        code: 'TURNSTILE_VERIFY_RATE_LIMIT_NOT_AVAILABLE',
        action: 'newsletter_subscribe',
        binding: 'TURNSTILE_VERIFY_RATE_LIMITER',
        guidance: 'Check the optional rate limiter binding and Cloudflare service status.',
      },
    });
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain('198.51.100.3');
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain('binding unavailable');
  });
});

describe('Turnstile Siteverify', () => {
  it('posts only the secret, response, and a UUID idempotency key', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => siteverifyResponse({
      success: true,
      action: ACTION,
      hostname: 'blog.example.com',
    }));

    await expect(verifyTurnstileToken(
      { TURNSTILE_SECRET_KEY: ` ${SECRET} ` },
      {
        token: TOKEN,
        action: ACTION,
        request: requestWithOrigin('https://blog.example.com'),
        fetcher,
      },
    )).resolves.toEqual({ ok: true });

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe(TURNSTILE_SITEVERIFY_URL);
    expect(init).toMatchObject({
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/json' },
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);

    const body = JSON.parse(String(init?.body));
    expect(Object.keys(body).sort()).toEqual(['idempotency_key', 'response', 'secret']);
    expect(body).toMatchObject({ secret: SECRET, response: TOKEN });
    expect(body.idempotency_key).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(body).not.toHaveProperty('remoteip');
    expect(body).not.toHaveProperty('cdata');
  });

  it('uses the hostname component of the exact request Origin, including non-default-port origins', async () => {
    const fetcher = vi.fn(async () => siteverifyResponse({
      success: true,
      action: 'form_submit',
      hostname: 'forms.example.com',
    }));

    await expect(verifyTurnstileToken(
      { TURNSTILE_SECRET_KEY: SECRET },
      {
        token: TOKEN,
        action: 'form_submit',
        request: requestWithOrigin('https://forms.example.com:8443'),
        fetcher,
      },
    )).resolves.toEqual({ ok: true });
  });

  it.each([
    [undefined, 'missing'],
    ['null', 'opaque'],
    ['not a URL', 'malformed'],
    ['file:///tmp/form.html', 'unsupported scheme'],
    ['https://example.com/path', 'non-origin URL'],
    ['https://EXAMPLE.com', 'non-canonical serialization'],
  ])('rejects a %s Origin before Siteverify (%s)', async (origin, _description) => {
    const fetcher = vi.fn();
    const request = origin === undefined
      ? new Request('https://edge.example/api')
      : requestWithOrigin(origin);

    await expect(verifyTurnstileToken(
      { TURNSTILE_SECRET_KEY: SECRET },
      { token: TOKEN, action: ACTION, request, fetcher },
    )).resolves.toMatchObject({ ok: false, kind: 'invalid', code: 'INVALID_TURNSTILE_ORIGIN' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('rejects invalid token input before Siteverify', async () => {
    const fetcher = vi.fn();
    await expect(verifyTurnstileToken(
      { TURNSTILE_SECRET_KEY: SECRET },
      { token: '', action: ACTION, request: requestWithOrigin('https://example.com'), fetcher },
    )).resolves.toMatchObject({ ok: false, kind: 'invalid', code: 'INVALID_TURNSTILE_TOKEN' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it.each([undefined, '', '   '])('fails as unavailable when the secret is absent (%j)', async (secret) => {
    const fetcher = vi.fn();
    await expect(verifyTurnstileToken(
      { TURNSTILE_SECRET_KEY: secret },
      { token: TOKEN, action: ACTION, request: requestWithOrigin('https://example.com'), fetcher },
    )).resolves.toMatchObject({ ok: false, kind: 'unavailable', code: 'TURNSTILE_NOT_AVAILABLE' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Turnstile configuration is incomplete',
      $zeropress: expect.objectContaining({
        action: ACTION,
        missingSettings: ['TURNSTILE_SECRET_KEY'],
      }),
    }));
  });

  it.each([
    [{ success: true, action: 'form_submit', hostname: 'example.com' }, 'action mismatch'],
    [{ success: true, action: ACTION, hostname: 'other.example' }, 'hostname mismatch'],
    [{ success: true, hostname: 'example.com' }, 'missing action'],
    [{ success: true, action: ACTION }, 'missing hostname'],
  ])('returns invalid for a successful response with %s', async (payload, _description) => {
    const fetcher = vi.fn(async () => siteverifyResponse(payload));
    await expect(verifyTurnstileToken(
      { TURNSTILE_SECRET_KEY: SECRET },
      { token: TOKEN, action: ACTION, request: requestWithOrigin('https://example.com'), fetcher },
    )).resolves.toMatchObject({ ok: false, kind: 'invalid', code: 'INVALID_TURNSTILE_TOKEN' });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it.each(['invalid-input-response', 'timeout-or-duplicate'])('maps client token failure %s to invalid', async (errorCode) => {
    const fetcher = vi.fn(async () => siteverifyResponse({ success: false, 'error-codes': [errorCode] }));
    await expect(verifyTurnstileToken(
      { TURNSTILE_SECRET_KEY: SECRET },
      { token: TOKEN, action: ACTION, request: requestWithOrigin('https://example.com'), fetcher },
    )).resolves.toMatchObject({ ok: false, kind: 'invalid', code: 'INVALID_TURNSTILE_TOKEN' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it.each([
    'missing-input-secret',
    'invalid-input-secret',
    'bad-request',
    'missing-input-response',
    'future-error-code',
  ])('maps configuration or unknown failure %s to unavailable', async (errorCode) => {
    const fetcher = vi.fn(async () => siteverifyResponse({ success: false, 'error-codes': [errorCode] }));
    await expect(verifyTurnstileToken(
      { TURNSTILE_SECRET_KEY: SECRET },
      { token: TOKEN, action: ACTION, request: requestWithOrigin('https://example.com'), fetcher },
    )).resolves.toMatchObject({
      ok: false,
      kind: 'unavailable',
      code: 'TURNSTILE_VERIFICATION_NOT_AVAILABLE',
    });
    expect(warnSpy).toHaveBeenCalledOnce();
    const warning = warnSpy.mock.calls[0][0];
    expect(warning).toMatchObject({
      message: 'Turnstile Siteverify is unavailable',
      $zeropress: {
        code: 'TURNSTILE_VERIFICATION_NOT_AVAILABLE',
        service: 'cloudflare-turnstile-siteverify',
        action: ACTION,
      },
    });
    if (errorCode === 'future-error-code') {
      expect(warning.$zeropress.attemptFailures).toEqual([{
        attempt: 1,
        reason: 'siteverify_rejected',
        unknownErrorCodeCount: 1,
      }]);
      expect(JSON.stringify(warning)).not.toContain(errorCode);
    } else {
      expect(warning.$zeropress.attemptFailures).toEqual([{
        attempt: 1,
        reason: 'siteverify_rejected',
        errorCodes: [errorCode],
      }]);
      if (errorCode === 'invalid-input-secret') {
        expect(warning.$zeropress).toMatchObject({
          reason: 'siteverify_rejected',
          attempts: 1,
          errorCodes: ['invalid-input-secret'],
        });
        expect(warning.$zeropress.guidance).toBe(
          'Verify TURNSTILE_SECRET_KEY is the secret for the same Turnstile widget as edge_runtime_settings.turnstile_sitekey, then update the secret on this Worker.',
        );
      }
    }
  });

  it('fails unavailable when an otherwise client error response also contains an unknown error code', async () => {
    const fetcher = vi.fn(async () => siteverifyResponse({
      success: false,
      'error-codes': ['invalid-input-response', 'future-error-code'],
    }));
    await expect(verifyTurnstileToken(
      { TURNSTILE_SECRET_KEY: SECRET },
      { token: TOKEN, action: ACTION, request: requestWithOrigin('https://example.com'), fetcher },
    )).resolves.toMatchObject({
      ok: false,
      kind: 'unavailable',
      code: 'TURNSTILE_VERIFICATION_NOT_AVAILABLE',
    });
    expect(warnSpy).toHaveBeenCalledOnce();
    const serializedWarning = JSON.stringify(warnSpy.mock.calls);
    expect(serializedWarning).toContain('invalid-input-response');
    expect(serializedWarning).toContain('unknownErrorCodeCount');
    expect(serializedWarning).not.toContain('future-error-code');
  });

  it('logs repeated Cloudflare internal errors only after the final retry', async () => {
    const fetcher = vi.fn(async () => siteverifyResponse({
      success: false,
      'error-codes': ['internal-error'],
    }));

    await expect(verifyTurnstileToken(
      { TURNSTILE_SECRET_KEY: SECRET },
      { token: TOKEN, action: ACTION, request: requestWithOrigin('https://example.com'), fetcher },
    )).resolves.toMatchObject({
      ok: false,
      kind: 'unavailable',
      code: 'TURNSTILE_VERIFICATION_NOT_AVAILABLE',
    });

    expect(fetcher).toHaveBeenCalledTimes(TURNSTILE_SITEVERIFY_MAX_ATTEMPTS);
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toMatchObject({
      message: 'Turnstile Siteverify is unavailable',
      $zeropress: {
        reason: 'siteverify_rejected',
        attempts: 2,
        errorCodes: ['internal-error'],
        attemptFailures: [
          { attempt: 1, reason: 'siteverify_rejected', errorCodes: ['internal-error'] },
          { attempt: 2, reason: 'siteverify_rejected', errorCodes: ['internal-error'] },
        ],
      },
    });
  });

  it.each([
    [{}, 'missing success'],
    [{ success: 'true' }, 'non-boolean success'],
    [{ success: true, action: 1, hostname: 'example.com' }, 'non-string action'],
    [{ success: false, 'error-codes': [1] }, 'non-string error code'],
  ])('retries a malformed Siteverify response with %s and fails unavailable', async (payload, _description) => {
    const fetcher = vi.fn(async () => siteverifyResponse(payload));
    await expect(verifyTurnstileToken(
      { TURNSTILE_SECRET_KEY: SECRET },
      { token: TOKEN, action: ACTION, request: requestWithOrigin('https://example.com'), fetcher },
    )).resolves.toMatchObject({ ok: false, kind: 'unavailable' });
    expect(fetcher).toHaveBeenCalledTimes(TURNSTILE_SITEVERIFY_MAX_ATTEMPTS);
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toMatchObject({
      message: 'Turnstile Siteverify is unavailable',
      $zeropress: {
        attemptFailures: [
          { attempt: 1, reason: 'invalid_response' },
          { attempt: 2, reason: 'invalid_response' },
        ],
      },
    });
  });

  it('classifies non-JSON Siteverify responses without recording their body', async () => {
    const unsafeBody = `upstream body contained ${SECRET} ${TOKEN}`;
    const fetcher = vi.fn(async () => new Response(unsafeBody, { status: 200 }));

    await expect(verifyTurnstileToken(
      { TURNSTILE_SECRET_KEY: SECRET },
      { token: TOKEN, action: ACTION, request: requestWithOrigin('https://example.com'), fetcher },
    )).resolves.toMatchObject({ ok: false, kind: 'unavailable' });

    expect(warnSpy).toHaveBeenCalledOnce();
    const serializedWarning = JSON.stringify(warnSpy.mock.calls);
    expect(serializedWarning).toContain('invalid_json');
    expect(serializedWarning).not.toContain(SECRET);
    expect(serializedWarning).not.toContain(TOKEN);
    expect(serializedWarning).not.toContain(unsafeBody);
  });

  it.each([500, 429, 400, 302])('bounds retries for HTTP %d responses', async (status) => {
    const fetcher = vi.fn(async () => new Response('unavailable', { status }));
    await expect(verifyTurnstileToken(
      { TURNSTILE_SECRET_KEY: SECRET },
      { token: TOKEN, action: ACTION, request: requestWithOrigin('https://example.com'), fetcher },
    )).resolves.toMatchObject({ ok: false, kind: 'unavailable' });
    expect(fetcher).toHaveBeenCalledTimes(TURNSTILE_SITEVERIFY_MAX_ATTEMPTS);
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toMatchObject({
      message: 'Turnstile Siteverify is unavailable',
      $zeropress: {
        reason: 'http_error',
        attempts: 2,
        upstreamStatus: status,
        attemptFailures: [
          { attempt: 1, reason: 'http_error', httpStatus: status },
          { attempt: 2, reason: 'http_error', httpStatus: status },
        ],
      },
    });
  });

  it('retries a transient network failure with the same idempotency UUID', async () => {
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new Error('temporary network failure'))
      .mockResolvedValueOnce(siteverifyResponse({
        success: true,
        action: ACTION,
        hostname: 'example.com',
      }));

    await expect(verifyTurnstileToken(
      { TURNSTILE_SECRET_KEY: SECRET },
      { token: TOKEN, action: ACTION, request: requestWithOrigin('https://example.com'), fetcher },
    )).resolves.toEqual({ ok: true });

    expect(fetcher).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
    const secondBody = JSON.parse(String(fetcher.mock.calls[1][1]?.body));
    expect(secondBody.idempotency_key).toBe(firstBody.idempotency_key);
    expect(secondBody).toEqual(firstBody);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('retries Cloudflare internal-error once with the same idempotency UUID', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(siteverifyResponse({ success: false, 'error-codes': ['internal-error'] }))
      .mockResolvedValueOnce(siteverifyResponse({
        success: true,
        action: ACTION,
        hostname: 'example.com',
      }));

    await expect(verifyTurnstileToken(
      { TURNSTILE_SECRET_KEY: SECRET },
      { token: TOKEN, action: ACTION, request: requestWithOrigin('https://example.com'), fetcher },
    )).resolves.toEqual({ ok: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1][1]?.body).toBe(fetcher.mock.calls[0][1]?.body);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('aborts timed-out attempts and fails unavailable after the bounded retry', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));

    const resultPromise = verifyTurnstileToken(
      { TURNSTILE_SECRET_KEY: SECRET },
      { token: TOKEN, action: ACTION, request: requestWithOrigin('https://example.com'), fetcher },
    );
    await vi.advanceTimersByTimeAsync(TURNSTILE_SITEVERIFY_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(TURNSTILE_SITEVERIFY_TIMEOUT_MS);

    await expect(resultPromise).resolves.toMatchObject({ ok: false, kind: 'unavailable' });
    expect(fetcher).toHaveBeenCalledTimes(TURNSTILE_SITEVERIFY_MAX_ATTEMPTS);
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toMatchObject({
      message: 'Turnstile Siteverify is unavailable',
      $zeropress: {
        attemptFailures: [
          { attempt: 1, reason: 'request_timeout' },
          { attempt: 2, reason: 'request_timeout' },
        ],
      },
    });
  });

  it('logs only sanitized failure metadata when a fetch error contains secret or token text', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const unsafeErrorMessage = `upstream included ${SECRET} ${TOKEN}`;
    const fetcher = vi.fn(async () => { throw new Error(unsafeErrorMessage); });

    await verifyTurnstileToken(
      { TURNSTILE_SECRET_KEY: SECRET },
      { token: TOKEN, action: ACTION, request: requestWithOrigin('https://example.com'), fetcher },
    );

    expect(errorSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledOnce();
    const serializedWarning = JSON.stringify(warnSpy.mock.calls);
    expect(serializedWarning).toContain('request_failed');
    expect(serializedWarning).not.toContain(SECRET);
    expect(serializedWarning).not.toContain(TOKEN);
    expect(serializedWarning).not.toContain(unsafeErrorMessage);
  });
});

function requestWithOrigin(origin: string): Request {
  return new Request('https://edge.example/api', { headers: { Origin: origin } });
}

function siteverifyResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
