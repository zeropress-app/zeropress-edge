import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { type Env } from '../index';
import { createNewsletterConfirmToken } from './confirm-token';
import { decodeBase64Url, encodeBase64Url, sha256Base64Url, signDerivedHmacSha256Base64Url } from '../crypto';
import { TEST_EDGE_TOKEN_SIGNING_SECRET, TEST_IP_HASH_SECRET } from '../test-utils';

type MockNewsletter = {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  status: string;
};

type MockField = {
  id: string;
  newsletter_id: string;
  field_key: string;
  label: string;
  type: 'text' | 'textarea' | 'number' | 'url' | 'boolean' | 'select' | 'radio' | 'checkbox';
  required: number;
  options_json: string | null;
  sort_order: number;
  status: string;
};

type MockSubscriber = {
  id: string;
  email: string;
};

type MockSubscription = {
  id: string;
  newsletter_id: string;
  subscriber_id: string;
  status: 'pending' | 'subscribed' | 'unsubscribed';
  confirm_token_hash: string | null;
  confirm_expires_at: string | null;
  confirm_sent_at?: string | null;
  confirm_email_status?: 'not_sent' | 'sent' | 'failed' | null;
  confirm_email_error?: string | null;
  source_url?: string | null;
  ip_address?: string | null;
  ip_address_recorded_at?: string | null;
  ip_hash?: string | null;
  asn?: number | null;
  as_organization?: string | null;
  country_code?: string | null;
  user_agent?: string | null;
};

type MockFieldValue = {
  id: string;
  subscription_id: string;
  field_id: string;
  field_value: string;
};

type MockDelivery = {
  id: string;
  newsletter_id: string;
  subscription_id: string;
  status: 'queued' | 'sent' | 'failed' | 'skipped';
  failure_code: string | null;
  created_at?: string;
};

describe('zeropress-edge newsletters API', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns active newsletter metadata and fields', async () => {
    const { env } = createNewsletterMockEnv({
      fields: [
        {
          id: 'field-1',
          newsletter_id: 'newsletter-1',
          field_key: 'first_name',
          label: 'First Name',
          type: 'text',
          required: 1,
          options_json: null,
          sort_order: 10,
          status: 'active',
        },
      ],
    });

    const response = await worker.fetch(new Request('https://example.com/api/newsletters/default'), env);
    const payload = await readJson(response);

    expect(response.status).toBe(200);
    expect(payload).toEqual({
      accepting_subscriptions: true,
      newsletter: {
        slug: 'default',
        title: 'Newsletter',
        description: null,
      },
      fields: [
        {
          key: 'first_name',
          label: 'First Name',
          type: 'text',
          required: true,
          options: [],
          sort_order: 10,
        },
      ],
    });
  });

  it('caches active newsletter metadata and fields in EDGE_KV', async () => {
    const { env, kv, sqlCalls } = createNewsletterMockEnv({
      fields: [textField('first_name')],
    });

    const firstResponse = await worker.fetch(new Request('https://example.com/api/newsletters/default'), env);
    const secondResponse = await worker.fetch(new Request('https://example.com/api/newsletters/default'), env);
    const secondPayload = await readJson(secondResponse);

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(secondPayload.newsletter.slug).toBe('default');
    expect(kv.get).toHaveBeenCalledWith('newsletter-info:v1:default');
    expect(kv.put).toHaveBeenCalledWith(
      'newsletter-info:v1:default',
      expect.any(String),
      { expirationTtl: 300 },
    );
    // The lifecycle-bearing list lookup runs on every request before a cached
    // payload can be trusted; the larger field query remains cached.
    expect(sqlCalls.filter((sql) => sql.includes('JOIN newsletter_lists AS l'))).toHaveLength(2);
    expect(sqlCalls.filter((sql) => sql.includes('FROM newsletter_fields'))).toHaveLength(1);
  });

  it.each([
    { label: 'confirmation mail disabled', edgeMailSettings: { newsletter_confirmation_enabled: 0 } },
    { label: 'queue missing', mailQueueBound: false },
  ])('reports signup unavailable with $label while returning metadata', async (options) => {
    const { env, mailQueue } = createNewsletterMockEnv(options);
    const response = await worker.fetch(new Request('https://example.com/api/newsletters/default'), env);
    expect(response.status).toBe(200);
    expect(await readJson(response)).toMatchObject({
      newsletter: { slug: 'default' }, fields: [], accepting_subscriptions: false,
    });
    expect(mailQueue.send).not.toHaveBeenCalled();
  });

  it('rechecks mail readiness and list activation while reusing cached fields', async () => {
    const { env, edgeMailSettings, newsletter, sqlCalls } = createNewsletterMockEnv();
    const read = () => worker.fetch(new Request('https://example.com/api/newsletters/default'), env);
    expect((await readJson(await read())).accepting_subscriptions).toBe(true);
    edgeMailSettings.newsletter_confirmation_enabled = 0;
    expect((await readJson(await read())).accepting_subscriptions).toBe(false);
    edgeMailSettings.newsletter_confirmation_enabled = 1;
    expect((await readJson(await read())).accepting_subscriptions).toBe(true);
    env.MAIL_QUEUE = undefined;
    expect((await readJson(await read())).accepting_subscriptions).toBe(false);
    expect(sqlCalls.filter((sql) => sql.includes('FROM newsletter_fields'))).toHaveLength(1);
    newsletter!.status = 'archived';
    const archivedResponse = await read();
    expect(archivedResponse.status).toBe(404);
    expect((await readJson(archivedResponse)).code).toBe('NEWSLETTER_NOT_FOUND');
  });

  it('applies the optional newsletter read rate limiter', async () => {
    const { env, readRateLimiter, sqlCalls } = createNewsletterMockEnv({
      readRateLimitSuccess: false,
    });

    const response = await worker.fetch(new Request('https://example.com/api/newsletters/default', {
      headers: {
        'CF-Connecting-IP': '203.0.113.51',
      },
    }), env);
    const payload = await readJson(response);

    expect(response.status).toBe(429);
    expect(payload.code).toBe('RATE_LIMITED');
    expect(readRateLimiter.limit).toHaveBeenCalledWith({ key: '203.0.113.51' });
    expect(sqlCalls).toHaveLength(0);
  });

  it('returns not found for missing or inactive newsletters', async () => {
    const missing = createNewsletterMockEnv({ newsletter: null });
    const inactive = createNewsletterMockEnv({
      newsletter: {
        id: 'newsletter-1',
        slug: 'default',
        title: 'Newsletter',
        description: null,
        status: 'archived',
      },
    });

    const missingResponse = await worker.fetch(new Request('https://example.com/api/newsletters/default'), missing.env);
    const inactiveResponse = await worker.fetch(new Request('https://example.com/api/newsletters/default'), inactive.env);

    expect(missingResponse.status).toBe(404);
    expect((await readJson(missingResponse)).code).toBe('NEWSLETTER_NOT_FOUND');
    expect(inactiveResponse.status).toBe(404);
    expect((await readJson(inactiveResponse)).code).toBe('NEWSLETTER_NOT_FOUND');
  });

  it('issues newsletter subscribe challenges and applies the challenge rate limiter', async () => {
    const { env, challengeRateLimiter } = createNewsletterMockEnv();
    const response = await worker.fetch(new Request('https://example.com/api/newsletters/default/challenge/subscribe', {
      headers: {
        'CF-Connecting-IP': '203.0.113.12',
      },
    }), env);
    const payload = await readJson(response);

    expect(response.status).toBe(200);
    expect(payload.mode).toBe('pow');
    expect(payload.scope).toBe('subscribe');
    expect(payload.pow.algorithm).toBe('zp-newsletter-pow-v1');
    expect(payload.pow.scope).toBe('subscribe');
    expect(payload.pow.difficulty).toBe(15);
    expect(payload.pow.challenge_token).toMatch(/^n1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    expect(challengeLifetimeSeconds(payload.pow.challenge_token)).toBe(60);
    expect(challengeRateLimiter.limit).toHaveBeenCalledWith({ key: '203.0.113.12' });

    const limited = createNewsletterMockEnv({ challengeRateLimitSuccess: false });
    const limitedResponse = await worker.fetch(new Request('https://example.com/api/newsletters/default/challenge/subscribe'), limited.env);

    expect(limitedResponse.status).toBe(429);
    expect((await readJson(limitedResponse)).code).toBe('RATE_LIMITED');

    const unavailable = createNewsletterMockEnv({ edgeTokenSigningSecret: '' });
    const unavailableResponse = await worker.fetch(
      new Request('https://example.com/api/newsletters/default/challenge/subscribe'),
      unavailable.env,
    );

    expect(unavailableResponse.status).toBe(503);
    expect((await readJson(unavailableResponse)).code).toBe('NEWSLETTER_CHALLENGE_NOT_AVAILABLE');

    const tooShort = createNewsletterMockEnv({ edgeTokenSigningSecret: 'too-short-secret' });
    const tooShortResponse = await worker.fetch(
      new Request('https://example.com/api/newsletters/default/challenge/subscribe'),
      tooShort.env,
    );

    expect(tooShortResponse.status).toBe(503);
    expect((await readJson(tooShortResponse)).code).toBe('NEWSLETTER_CHALLENGE_NOT_AVAILABLE');
  });

  it('discovers Turnstile newsletter verification without issuing a PoW challenge', async () => {
    const { env } = createNewsletterMockEnv({
      verificationMode: 'turnstile',
      turnstileSiteKey: 'newsletter-site-key',
      turnstileSecretKey: 'newsletter-secret-key',
    });

    const response = await worker.fetch(
      new Request('https://example.com/api/newsletters/default/challenge/subscribe'),
      env,
    );
    const payload = await readJson(response);

    expect(response.status).toBe(200);
    expect(payload).toEqual({
      mode: 'turnstile',
      scope: 'subscribe',
      turnstile: {
        site_key: 'newsletter-site-key',
        action: 'newsletter_subscribe',
      },
    });
    expect(payload).not.toHaveProperty('pow');
  });

  it('uses Turnstile for newsletter subscribe and rejects PoW fields before checking a missing secret', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      success: true,
      action: 'newsletter_subscribe',
      hostname: 'example.com',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const success = createNewsletterMockEnv({
      verificationMode: 'turnstile',
      turnstileSiteKey: 'newsletter-site-key',
      turnstileSecretKey: 'newsletter-secret-key',
    });
    const strict = createNewsletterMockEnv({
      verificationMode: 'turnstile',
      turnstileSiteKey: 'newsletter-site-key',
    });

    const successResponse = await worker.fetch(new Request('https://example.com/api/newsletters/default/subscriptions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Origin: 'https://example.com',
      },
      body: JSON.stringify({
        email: 'hello@example.com',
        source_url: 'https://example.com/newsletter_zeropress.html',
        turnstile_token: 'turnstile-newsletter-token',
      }),
    }), success.env);
    const strictResponse = await worker.fetch(new Request('https://example.com/api/newsletters/default/subscriptions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'hello@example.com',
        source_url: 'https://example.com/newsletter_zeropress.html',
        turnstile_token: 'turnstile-newsletter-token',
        newsletter_challenge_token: 'not-allowed',
        newsletter_challenge_solution: '0',
      }),
    }), strict.env);
    const strictPayload = await readJson(strictResponse);

    expect(successResponse.status).toBe(202);
    expect(success.subscriptions).toHaveLength(1);
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(strictResponse.status).toBe(422);
    expect(strictPayload.errors.map((error: { field?: string }) => error.field)).toEqual([
      'newsletter_challenge_token',
      'newsletter_challenge_solution',
    ]);
    expect(strict.subscribeRateLimiter.limit).toHaveBeenCalledOnce();
    expect(strict.subscriptions).toHaveLength(0);
  });

  it('keeps Turnstile fields out of PoW newsletter requests', async () => {
    const state = createNewsletterMockEnv();
    const response = await worker.fetch(new Request('https://example.com/api/newsletters/default/subscriptions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'hello@example.com',
        source_url: 'https://example.com/newsletter_zeropress.html',
        turnstile_token: 'not-allowed',
      }),
    }), state.env);
    const payload = await readJson(response);

    expect(response.status).toBe(422);
    expect(payload.errors).toContainEqual({
      field: 'turnstile_token',
      message: 'Unsupported body field: turnstile_token.',
    });
    expect(state.subscriptions).toHaveLength(0);
  });

  it('fails newsletter verification closed for invalid modes and incomplete Turnstile configuration', async () => {
    const invalidMode = createNewsletterMockEnv({ verificationMode: 'pow_and_turnstile' });
    const missingSiteKey = createNewsletterMockEnv({
      verificationMode: 'turnstile',
      turnstileSecretKey: 'newsletter-secret-key',
    });
    const missingSecret = createNewsletterMockEnv({
      verificationMode: 'turnstile',
      turnstileSiteKey: 'newsletter-site-key',
    });

    const invalidModeResponse = await worker.fetch(
      new Request('https://example.com/api/newsletters/default/challenge/subscribe'),
      invalidMode.env,
    );
    const missingSiteKeyResponse = await worker.fetch(
      new Request('https://example.com/api/newsletters/default/challenge/subscribe'),
      missingSiteKey.env,
    );
    const missingSecretDiscoveryResponse = await worker.fetch(
      new Request('https://example.com/api/newsletters/default/challenge/subscribe'),
      missingSecret.env,
    );
    const missingSecretResponse = await worker.fetch(new Request('https://example.com/api/newsletters/default/subscriptions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Origin: 'https://example.com',
      },
      body: JSON.stringify({
        email: 'hello@example.com',
        source_url: 'https://example.com/newsletter_zeropress.html',
        turnstile_token: 'turnstile-newsletter-token',
      }),
    }), missingSecret.env);

    expect(invalidModeResponse.status).toBe(503);
    expect((await readJson(invalidModeResponse)).code).toBe('EDGE_RUNTIME_SETTINGS_NOT_AVAILABLE');
    expect(missingSiteKeyResponse.status).toBe(503);
    expect((await readJson(missingSiteKeyResponse)).code).toBe('EDGE_RUNTIME_SETTINGS_NOT_AVAILABLE');
    expect(missingSecretDiscoveryResponse.status).toBe(503);
    expect((await readJson(missingSecretDiscoveryResponse)).code).toBe('TURNSTILE_NOT_AVAILABLE');
    expect(missingSecretResponse.status).toBe(503);
    expect((await readJson(missingSecretResponse)).code).toBe('TURNSTILE_NOT_AVAILABLE');
    expect(missingSecret.subscriptions).toHaveLength(0);
  });

  it('runs the newsletter write limiter before Turnstile verification and Siteverify', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const state = createNewsletterMockEnv({
      verificationMode: 'turnstile',
      turnstileSiteKey: 'newsletter-site-key',
      turnstileSecretKey: 'newsletter-secret-key',
      turnstileVerifyRateLimitSuccess: false,
    });

    const response = await worker.fetch(new Request('https://example.com/api/newsletters/default/subscriptions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Origin: 'https://example.com',
        'CF-Connecting-IP': '203.0.113.91',
      },
      body: JSON.stringify({
        email: 'hello@example.com',
        source_url: 'https://example.com/newsletter_zeropress.html',
        turnstile_token: 'turnstile-newsletter-token',
      }),
    }), state.env);

    expect(response.status).toBe(429);
    expect((await readJson(response)).code).toBe('TURNSTILE_VERIFY_RATE_LIMITED');
    expect(state.turnstileVerifyRateLimiter.limit).toHaveBeenCalledWith({
      key: 'newsletter_subscribe:203.0.113.91',
    });
    expect(state.subscribeRateLimiter.limit).toHaveBeenCalledWith({ key: '203.0.113.91' });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(state.subscriptions).toHaveLength(0);
  });

  it('requires a solved newsletter subscribe challenge before subscription work', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    const missing = createNewsletterMockEnv();
    const mismatched = createNewsletterMockEnv();
    const unavailable = createNewsletterMockEnv({ edgeTokenSigningSecret: '' });
    const otherChallenge = await newsletterChallengeBody(mismatched.env, 'other');
    const unavailableChallenge = await newsletterChallengeBody(createNewsletterMockEnv().env);

    const missingResponse = await worker.fetch(new Request('https://example.com/api/newsletters/default/subscriptions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'hello@example.com',
        source_url: 'https://example.com/newsletter_zeropress.html',
      }),
    }), missing.env);
    const mismatchedResponse = await worker.fetch(new Request('https://example.com/api/newsletters/default/subscriptions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'hello@example.com',
        source_url: 'https://example.com/newsletter_zeropress.html',
        ...otherChallenge,
      }),
    }), mismatched.env);
    const unavailableResponse = await worker.fetch(new Request('https://example.com/api/newsletters/default/subscriptions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'hello@example.com',
        source_url: 'https://example.com/newsletter_zeropress.html',
        ...unavailableChallenge,
      }),
    }), unavailable.env);

    expect(missingResponse.status).toBe(403);
    expect((await readJson(missingResponse)).code).toBe('MISSING_NEWSLETTER_CHALLENGE');
    expect(mismatchedResponse.status).toBe(403);
    expect((await readJson(mismatchedResponse)).code).toBe('INVALID_NEWSLETTER_CHALLENGE');
    expect(unavailableResponse.status).toBe(503);
    expect((await readJson(unavailableResponse)).code).toBe('NEWSLETTER_CHALLENGE_NOT_AVAILABLE');
    expect(missing.subscribers).toEqual([]);
    expect(mismatched.subscribers).toEqual([]);
    expect(unavailable.subscribers).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('enforces the newsletter subscribe body limit and preserves invalid JSON errors', async () => {
    const oversized = createNewsletterMockEnv();
    const invalid = createNewsletterMockEnv();

    const oversizedResponse = await worker.fetch(new Request(
      'https://example.com/api/newsletters/default/subscriptions',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ padding: 'x'.repeat(256 * 1024) }),
      },
    ), oversized.env);
    const invalidResponse = await worker.fetch(new Request(
      'https://example.com/api/newsletters/default/subscriptions',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{',
      },
    ), invalid.env);

    expect(oversizedResponse.status).toBe(413);
    expect(await readJson(oversizedResponse)).toEqual({
      code: 'REQUEST_BODY_TOO_LARGE',
      message: 'Request body exceeds the maximum allowed size.',
    });
    expect(oversized.subscribeRateLimiter.limit).not.toHaveBeenCalled();
    expect(oversized.sqlCalls).toEqual([]);
    expect(invalidResponse.status).toBe(400);
    expect((await readJson(invalidResponse)).code).toBe('INVALID_JSON');
    expect(invalid.subscribeRateLimiter.limit).not.toHaveBeenCalled();
    expect(invalid.sqlCalls).toEqual([]);
  });

  it('creates a pending email-only subscription and queues a confirmation email', async () => {
    const {
      env,
      subscribers,
      subscriptions,
      deliveries,
      fieldValues,
      mailQueueMessages,
    } = createNewsletterMockEnv();

    const request = await newsletterSubscribeRequest(env, { email: 'HELLO@EXAMPLE.COM' }, {
      'CF-Connecting-IP': '203.0.113.25',
      'User-Agent': 'Newsletter test',
    });
    withCloudflareMetadata(request, {
      asn: 15169,
      asOrganization: 'Google LLC',
      country: 'us',
    });

    const response = await worker.fetch(request, env);
    const payload = await readJson(response);

    expect(response.status).toBe(202);
    expect(payload).toEqual({ status: 'accepted' });
    expect(subscribers).toHaveLength(1);
    expect(subscribers[0].id).toMatch(/^[0-9a-f]{32}$/);
    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0].id).toMatch(/^[0-9a-f]{32}$/);
    expect(subscriptions[0].status).toBe('pending');
    expect(subscriptions[0].confirm_token_hash).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(subscriptions[0].confirm_email_status).toBe('not_sent');
    expect(subscriptions[0].confirm_email_error).toBeNull();
    expect(subscriptions[0].confirm_sent_at).toBeNull();
    expect(subscriptions[0].source_url).toBe('https://example.com/newsletter_zeropress.html');
    expect(subscriptions[0].ip_address).toBe('203.0.113.25');
    expect(subscriptions[0].ip_address_recorded_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(subscriptions[0].ip_hash).toMatch(/^v1\.[A-Za-z0-9_-]+$/);
    expect(subscriptions[0].asn).toBe(15169);
    expect(subscriptions[0].as_organization).toBe('Google LLC');
    expect(subscriptions[0].country_code).toBe('US');
    expect(subscriptions[0].user_agent).toBe('Newsletter test');
    expect(fieldValues).toEqual([]);
    expect(mailQueueMessages).toEqual([
      {
        contract_version: 1,
        type: 'newsletter.confirmation',
        delivery_id: expect.stringMatching(/^[0-9a-f]{32}$/u),
        subscription_id: subscriptions[0].id,
        token: expect.stringMatching(/^nc1\./),
        unsubscribe_token: `nu1.${subscriptions[0].id}`,
      },
    ]);
    expect(deliveries).toEqual([{
      id: (mailQueueMessages[0] as { delivery_id: string }).delivery_id,
      newsletter_id: 'newsletter-1',
      subscription_id: subscriptions[0].id,
      status: 'queued',
      failure_code: null,
      created_at: expect.any(String),
    }]);
  });

  it('rejects a reused newsletter subscribe challenge before writing another subscription', async () => {
    const { env, subscribers, subscriptions, mailQueueMessages } = createNewsletterMockEnv();
    const challengeFields = await newsletterChallengeBody(env);
    const body = {
      email: 'hello@example.com',
      source_url: 'https://example.com/newsletter_zeropress.html',
      ...challengeFields,
    };

    const firstResponse = await worker.fetch(new Request('https://example.com/api/newsletters/default/subscriptions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }), env);
    const replayResponse = await worker.fetch(new Request('https://example.com/api/newsletters/default/subscriptions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }), env);
    const replayPayload = await readJson(replayResponse);

    expect(firstResponse.status).toBe(202);
    expect(replayResponse.status).toBe(403);
    expect(replayPayload.code).toBe('NEWSLETTER_CHALLENGE_ALREADY_USED');
    expect(subscribers).toHaveLength(1);
    expect(subscriptions).toHaveLength(1);
    expect(mailQueueMessages).toHaveLength(1);
  });

  it('keeps a failed enqueue reservation within the recipient cooldown', async () => {
    const { env, subscribers, subscriptions, fieldValues, deliveries, mailQueue } = createNewsletterMockEnv({
      mailQueueSendSuccess: false,
    });
    const first = await worker.fetch(await newsletterSubscribeRequest(env, { email: 'hello@example.com' }), env);
    expect(first.status).toBe(202);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ status: 'failed', failure_code: 'enqueue_failed' });
    const saved = structuredClone({ subscribers, subscriptions, fieldValues, deliveries });
    const repeated = await worker.fetch(await newsletterSubscribeRequest(env, {
      email: ' HELLO@EXAMPLE.COM ', source_url: 'https://example.com/changed',
    }, { 'CF-Connecting-IP': '203.0.113.51' }), env);
    expect(repeated.status).toBe(202);
    expect(await readJson(repeated)).toEqual(await readJson(first));
    expect(mailQueue.send).toHaveBeenCalledTimes(1);
    expect({ subscribers, subscriptions, fieldValues, deliveries }).toEqual(saved);
  });

  it('re-submits a pending subscription by replacing the confirmation token and field values', async () => {
    const subscriptionId = '11111111111141118111111111111111';
    const { env, subscriptions, fieldValues } = createNewsletterMockEnv({
      subscribers: [{ id: 'subscriber-1', email: 'hello@example.com' }],
      subscriptions: [{
        id: subscriptionId,
        newsletter_id: 'newsletter-1',
        subscriber_id: 'subscriber-1',
        status: 'pending',
        confirm_token_hash: 'old-token-hash',
        confirm_expires_at: '2026-06-30T00:00:00Z',
      }],
      fields: [
        textField('first_name'),
        {
          id: 'field-bio',
          newsletter_id: 'newsletter-1',
          field_key: 'bio',
          label: 'bio',
          type: 'textarea',
          required: 0,
          options_json: null,
          sort_order: 20,
          status: 'active',
        },
      ],
      fieldValues: [{
        id: 'field-value-1',
        subscription_id: subscriptionId,
        field_id: 'field-first_name',
        field_value: 'Old',
      }],
    });

    const request = await newsletterSubscribeRequest(env, {
      email: 'hello@example.com',
      fields: {
        first_name: ' New\u0007😀 ',
        bio: 'Hello\u0000😀\r\n\r\n\r\nZero\tPress',
      },
    }, {
      'CF-Connecting-IP': '203.0.113.26',
      'User-Agent': 'Newsletter resubmit test',
    });
    withCloudflareMetadata(request, {
      asn: 8075,
      asOrganization: 'Microsoft Corporation',
      country: 'US',
    });

    const response = await worker.fetch(request, env);
    const payload = await readJson(response);

    expect(response.status, JSON.stringify(payload)).toBe(202);
    expect(subscriptions[0].confirm_token_hash).not.toBe('old-token-hash');
    expect(subscriptions[0].source_url).toBe('https://example.com/newsletter_zeropress.html');
    expect(subscriptions[0].ip_address).toBe('203.0.113.26');
    expect(subscriptions[0].ip_address_recorded_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(subscriptions[0].ip_hash).toMatch(/^v1\.[A-Za-z0-9_-]+$/);
    expect(subscriptions[0].asn).toBe(8075);
    expect(subscriptions[0].as_organization).toBe('Microsoft Corporation');
    expect(subscriptions[0].country_code).toBe('US');
    expect(subscriptions[0].user_agent).toBe('Newsletter resubmit test');
    expect(fieldValues).toEqual([
      expect.objectContaining({
        subscription_id: subscriptionId,
        field_id: 'field-first_name',
        field_value: 'New',
      }),
      expect.objectContaining({
        subscription_id: subscriptionId,
        field_id: 'field-bio',
        field_value: 'Hello\n\nZero Press',
      }),
    ]);
  });

  it('returns accepted without sending email when the subscriber is already subscribed', async () => {
    const { env, mailQueueMessages } = createNewsletterMockEnv({
      subscribers: [{ id: 'subscriber-1', email: 'hello@example.com' }],
      subscriptions: [{
        id: 'subscription-1',
        newsletter_id: 'newsletter-1',
        subscriber_id: 'subscriber-1',
        status: 'subscribed',
        confirm_token_hash: null,
        confirm_expires_at: null,
      }],
    });

    const response = await worker.fetch(await newsletterSubscribeRequest(env, { email: 'hello@example.com' }), env);

    expect(response.status).toBe(202);
    expect(mailQueueMessages).toEqual([]);
  });

  it('consumes the challenge for an already subscribed email so replay does not reveal subscription state', async () => {
    const { env, mailQueueMessages } = createNewsletterMockEnv({
      subscribers: [{ id: 'subscriber-1', email: 'hello@example.com' }],
      subscriptions: [{
        id: 'subscription-1',
        newsletter_id: 'newsletter-1',
        subscriber_id: 'subscriber-1',
        status: 'subscribed',
        confirm_token_hash: null,
        confirm_expires_at: null,
      }],
    });
    const challenge = await newsletterChallengeBody(env);
    const body = {
      email: 'hello@example.com',
      source_url: 'https://example.com/newsletter_zeropress.html',
      ...challenge,
    };

    const request = () => new Request('https://example.com/api/newsletters/default/subscriptions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const firstResponse = await worker.fetch(request(), env);
    const replayResponse = await worker.fetch(request(), env);
    const replayPayload = await readJson(replayResponse);

    expect(firstResponse.status).toBe(202);
    expect(replayResponse.status).toBe(403);
    expect(replayPayload.code).toBe('NEWSLETTER_CHALLENGE_ALREADY_USED');
    expect(mailQueueMessages).toEqual([]);
  });

  it('rejects newsletter subscriptions when IP_HASH_SECRET is missing', async () => {
    const { env, subscribers, subscriptions } = createNewsletterMockEnv({
      ipHashSecret: null,
    });

    const response = await worker.fetch(await newsletterSubscribeRequest(env, { email: 'hello@example.com' }, {
      'CF-Connecting-IP': '203.0.113.25',
    }), env);
    const payload = await readJson(response);

    expect(response.status).toBe(503);
    expect(payload).toEqual({
      code: 'NEWSLETTER_IP_HASH_NOT_AVAILABLE',
      message: 'Newsletter subscriptions are temporarily unavailable.',
    });
    expect(subscribers).toHaveLength(0);
    expect(subscriptions).toHaveLength(0);
  });

  it('rejects suppressed emails and unknown fields', async () => {
    const suppressed = createNewsletterMockEnv({
      suppressions: ['hello@example.com'],
    });
    const unknownField = createNewsletterMockEnv();

    const suppressedResponse = await worker.fetch(await newsletterSubscribeRequest(suppressed.env, {
      email: 'hello@example.com',
    }), suppressed.env);
    const unknownFieldResponse = await worker.fetch(await newsletterSubscribeRequest(unknownField.env, {
      email: 'hello@example.com',
      fields: {
        unknown: 'value',
      },
    }), unknownField.env);

    expect(suppressedResponse.status).toBe(403);
    expect((await readJson(suppressedResponse)).code).toBe('NEWSLETTER_SUPPRESSED');
    expect(unknownFieldResponse.status).toBe(422);
    expect((await readJson(unknownFieldResponse)).errors[0].field).toBe('fields.unknown');
  });

  it('rejects a subscription when suppression is added after the initial lookup', async () => {
    const { env, subscribers, subscriptions, mailQueueMessages } = createNewsletterMockEnv({
      suppressBeforePendingWrite: 'hello@example.com',
    });

    const response = await worker.fetch(await newsletterSubscribeRequest(env, {
      email: 'hello@example.com',
    }), env);

    expect(response.status).toBe(403);
    expect((await readJson(response)).code).toBe('NEWSLETTER_SUPPRESSED');
    expect(subscriptions).toEqual([]);
    expect(subscribers).toEqual([]);
    expect(mailQueueMessages).toEqual([]);
  });

  it('rejects newsletter emails that require unsafe character removal', async () => {
    const { env, subscribers, subscriptions, subscribeRateLimiter, sqlCalls } = createNewsletterMockEnv();

    const response = await worker.fetch(await newsletterSubscribeRequest(env, {
      email: 'hello@example.com😀',
    }), env);
    const payload = await readJson(response);

    expect(response.status).toBe(422);
    expect(payload.errors).toContainEqual({
      field: 'email',
      message: 'Email must be a valid email address.',
    });
    expect(subscribers).toEqual([]);
    expect(subscriptions).toEqual([]);
    expect(subscribeRateLimiter.limit).not.toHaveBeenCalled();
    expect(sqlCalls).toHaveLength(0);
  });

  it('rejects missing, unsafe, and disallowed source_url values', async () => {
    const missing = createNewsletterMockEnv();
    const unsafe = createNewsletterMockEnv();
    const disallowed = createNewsletterMockEnv({
      allowedOrigins: 'https://site.example',
    });

    const missingResponse = await worker.fetch(await newsletterSubscribeRequest(missing.env, {
      email: 'hello@example.com',
      source_url: undefined,
    }), missing.env);
    const unsafeResponse = await worker.fetch(await newsletterSubscribeRequest(unsafe.env, {
      email: 'hello@example.com',
      source_url: 'javascript:alert(1)',
    }), unsafe.env);
    const disallowedResponse = await worker.fetch(await newsletterSubscribeRequest(disallowed.env, {
      email: 'hello@example.com',
      source_url: 'https://evil.example/newsletter.html',
    }, { Origin: 'https://site.example' }), disallowed.env);

    expect(missingResponse.status).toBe(422);
    expect((await readJson(missingResponse)).errors[0].field).toBe('source_url');
    expect(unsafeResponse.status).toBe(422);
    expect((await readJson(unsafeResponse)).errors[0].field).toBe('source_url');
    expect(disallowedResponse.status).toBe(422);
    expect((await readJson(disallowedResponse)).errors[0].field).toBe('source_url');
  });

  it('validates custom fields and stores canonical field values', async () => {
    const { env, fieldValues } = createNewsletterMockEnv({
      fields: [
        textField('first_name', true),
        {
          id: 'field-topic',
          newsletter_id: 'newsletter-1',
          field_key: 'topic',
          label: 'Topic',
          type: 'select',
          required: 1,
          options_json: JSON.stringify([{ value: 'dev', label: 'Development' }]),
          sort_order: 20,
          status: 'active',
        },
        {
          id: 'field-interests',
          newsletter_id: 'newsletter-1',
          field_key: 'interests',
          label: 'Interests',
          type: 'checkbox',
          required: 0,
          options_json: JSON.stringify([
            { value: 'design', label: 'Design' },
            { value: 'migration', label: 'Migration' },
          ]),
          sort_order: 30,
          status: 'active',
        },
      ],
    });

    const response = await worker.fetch(await newsletterSubscribeRequest(env, {
      email: 'hello@example.com',
      fields: {
        first_name: ' Lael ',
        topic: 'dev',
        interests: ['design', 'migration', 'design'],
      },
    }), env);

    expect(response.status).toBe(202);
    expect(fieldValues.map((value) => ({
      field_id: value.field_id,
      field_value: value.field_value,
    }))).toEqual([
      { field_id: 'field-first_name', field_value: 'Lael' },
      { field_id: 'field-topic', field_value: 'dev' },
      { field_id: 'field-interests', field_value: '["design","migration"]' },
    ]);
    expect(fieldValues.every((value) => /^[0-9a-f]{32}$/.test(value.id))).toBe(true);
  });

  it('returns validation errors for missing required fields and invalid options', async () => {
    const { env } = createNewsletterMockEnv({
      fields: [
        textField('first_name', true),
        {
          id: 'field-topic',
          newsletter_id: 'newsletter-1',
          field_key: 'topic',
          label: 'Topic',
          type: 'select',
          required: 0,
          options_json: JSON.stringify([{ value: 'dev', label: 'Development' }]),
          sort_order: 20,
          status: 'active',
        },
      ],
    });

    const response = await worker.fetch(await newsletterSubscribeRequest(env, {
      email: 'hello@example.com',
      fields: {
        topic: 'unknown',
      },
    }), env);
    const payload = await readJson(response);

    expect(response.status).toBe(422);
    expect(payload.errors.map((error: { field: string }) => error.field)).toEqual([
      'fields.first_name',
      'fields.topic',
    ]);
  });

  it('treats an empty required checkbox array as a missing field', async () => {
    const { env, subscribers, subscriptions } = createNewsletterMockEnv({
      fields: [{
        id: 'field-interests',
        newsletter_id: 'newsletter-1',
        field_key: 'interests',
        label: 'Interests',
        type: 'checkbox',
        required: 1,
        options_json: JSON.stringify([{ value: 'design', label: 'Design' }]),
        sort_order: 10,
        status: 'active',
      }],
    });

    const response = await worker.fetch(await newsletterSubscribeRequest(env, {
      email: 'hello@example.com',
      fields: { interests: [] },
    }), env);
    const payload = await readJson(response);

    expect(response.status).toBe(422);
    expect(payload.errors).toContainEqual({
      field: 'fields.interests',
      message: 'Field is required.',
    });
    expect(subscribers).toHaveLength(0);
    expect(subscriptions).toHaveLength(0);
  });

  it('enforces the 120-character newsletter option value contract', async () => {
    const option = 'o'.repeat(120);
    const field = {
      id: 'field-topic',
      newsletter_id: 'newsletter-1',
      field_key: 'topic',
      label: 'Topic',
      type: 'select' as const,
      required: 1,
      options_json: JSON.stringify([{ value: option, label: 'L'.repeat(120) }]),
      sort_order: 10,
      status: 'active' as const,
    };
    const valid = createNewsletterMockEnv({ fields: [field] });
    const invalid = createNewsletterMockEnv({ fields: [field] });

    const validResponse = await worker.fetch(await newsletterSubscribeRequest(valid.env, {
      email: 'valid@example.com',
      fields: { topic: option },
    }), valid.env);
    const invalidResponse = await worker.fetch(await newsletterSubscribeRequest(invalid.env, {
      email: 'invalid@example.com',
      fields: { topic: `${option}x` },
    }), invalid.env);
    const invalidPayload = await readJson(invalidResponse);

    expect(validResponse.status).toBe(202);
    expect(valid.fieldValues[0].field_value).toBe(option);
    expect(invalidResponse.status).toBe(422);
    expect(invalidPayload.errors).toContainEqual({
      field: 'fields.topic',
      message: 'Field must be 120 characters or fewer.',
    });
  });

  it('stores decimal number fields and rejects non-decimal number notation', async () => {
    const numberField = {
      id: 'field-score',
      newsletter_id: 'newsletter-1',
      field_key: 'score',
      label: 'Score',
      type: 'number' as const,
      required: 1,
      options_json: null,
      sort_order: 10,
      status: 'active' as const,
    };
    const valid = createNewsletterMockEnv({
      fields: [numberField],
    });
    const invalid = createNewsletterMockEnv({
      fields: [numberField],
    });

    const validResponse = await worker.fetch(await newsletterSubscribeRequest(valid.env, {
      email: 'valid@example.com',
      fields: {
        score: ' 001.50 ',
      },
    }), valid.env);
    const invalidResponse = await worker.fetch(await newsletterSubscribeRequest(invalid.env, {
      email: 'invalid@example.com',
      fields: {
        score: '1e5',
      },
    }), invalid.env);
    const invalidPayload = await readJson(invalidResponse);

    expect(validResponse.status).toBe(202);
    expect(valid.fieldValues.map((value) => ({
      field_id: value.field_id,
      field_value: value.field_value,
    }))).toEqual([
      { field_id: 'field-score', field_value: '1.5' },
    ]);
    expect(invalidResponse.status).toBe(422);
    expect(invalidPayload.errors).toContainEqual({
      field: 'fields.score',
      message: 'Field must be a finite number.',
    });
  });

  it('confirms pending subscriptions without write verification and rejects invalid or expired tokens', async () => {
    const validSubscriptionId = '22222222222242228222222222222222';
    const expiredSubscriptionId = '33333333333343338333333333333333';
    const alreadyProcessedSubscriptionId = '55555555555545558555555555555555';
    const valid = createNewsletterMockEnv({
      verificationMode: 'pow_and_turnstile',
      subscriptions: [{
        id: validSubscriptionId,
        newsletter_id: 'newsletter-1',
        subscriber_id: 'subscriber-1',
        status: 'pending',
        confirm_token_hash: null,
        confirm_expires_at: '2999-01-01T00:00:00Z',
      }],
    });
    const expired = createNewsletterMockEnv({
      subscriptions: [{
        id: expiredSubscriptionId,
        newsletter_id: 'newsletter-1',
        subscriber_id: 'subscriber-1',
        status: 'pending',
        confirm_token_hash: null,
        confirm_expires_at: '2000-01-01T00:00:00Z',
      }],
    });
    const alreadyProcessed = createNewsletterMockEnv({
      subscriptions: [{
        id: alreadyProcessedSubscriptionId,
        newsletter_id: 'newsletter-1',
        subscriber_id: 'subscriber-1',
        status: 'subscribed',
        confirm_token_hash: null,
        confirm_expires_at: '2999-01-01T00:00:00Z',
      }],
    });
    const unknown = createNewsletterMockEnv();
    const validToken = await createSignedConfirmToken(valid.env, 'default', validSubscriptionId, '2999-01-01T00:00:00Z');
    valid.subscriptions[0].confirm_token_hash = await sha256Base64Url(validToken);
    const expiredToken = await createSignedConfirmToken(expired.env, 'default', expiredSubscriptionId, '2000-01-01T00:00:00Z');
    expired.subscriptions[0].confirm_token_hash = await sha256Base64Url(expiredToken);
    const alreadyProcessedToken = await createSignedConfirmToken(
      alreadyProcessed.env,
      'default',
      alreadyProcessedSubscriptionId,
      '2999-01-01T00:00:00Z',
    );
    alreadyProcessed.subscriptions[0].confirm_token_hash = await sha256Base64Url(alreadyProcessedToken);
    const unknownToken = await createSignedConfirmToken(
      unknown.env,
      'default',
      '44444444444444448444444444444444',
      '2999-01-01T00:00:00Z',
    );

    const validResponse = await worker.fetch(confirmRequest(validToken), valid.env);
    const expiredResponse = await worker.fetch(confirmRequest(expiredToken), expired.env);
    const alreadyProcessedResponse = await worker.fetch(confirmRequest(alreadyProcessedToken), alreadyProcessed.env);
    const unknownResponse = await worker.fetch(confirmRequest(unknownToken), unknown.env);
    const unavailableResponse = await worker.fetch(
      confirmRequest(validToken),
      createNewsletterMockEnv({ edgeTokenSigningSecret: '' }).env,
    );
    const tooShortResponse = await worker.fetch(
      confirmRequest(validToken),
      createNewsletterMockEnv({ edgeTokenSigningSecret: 'too-short-secret' }).env,
    );
    const validPayload = await readJson(validResponse);
    const expiredPayload = await readJson(expiredResponse);
    const alreadyProcessedPayload = await readJson(alreadyProcessedResponse);
    const unknownPayload = await readJson(unknownResponse);
    const unavailablePayload = await readJson(unavailableResponse);
    const tooShortPayload = await readJson(tooShortResponse);

    expect(validResponse.status).toBe(200);
    expect(validPayload).toEqual({ status: 'confirmed' });
    expect(valid.subscriptions[0].status).toBe('subscribed');
    expect(valid.subscriptions[0].confirm_token_hash).toBeNull();
    expect(expiredResponse.status).toBe(410);
    expect(expiredPayload.code).toBe('EXPIRED_NEWSLETTER_CONFIRMATION_TOKEN');
    expect(alreadyProcessedResponse.status).toBe(400);
    expect(alreadyProcessedPayload.code).toBe('INVALID_NEWSLETTER_CONFIRMATION_TOKEN');
    expect(unknownResponse.status).toBe(400);
    expect(unknownPayload.code).toBe('INVALID_NEWSLETTER_CONFIRMATION_TOKEN');
    expect(unavailableResponse.status).toBe(503);
    expect(unavailablePayload.code).toBe('NEWSLETTER_CONFIRMATION_NOT_AVAILABLE');
    expect(tooShortResponse.status).toBe(503);
    expect(tooShortPayload.code).toBe('NEWSLETTER_CONFIRMATION_NOT_AVAILABLE');
  });

  it('rejects a confirmation token replaced between lookup and the atomic update', async () => {
    const subscriptionId = '66666666666646668666666666666666';
    const replacedTokenHash = 'replacement-token-hash';
    const state = createNewsletterMockEnv({
      subscriptions: [{
        id: subscriptionId,
        newsletter_id: 'newsletter-1',
        subscriber_id: 'subscriber-1',
        status: 'pending',
        confirm_token_hash: null,
        confirm_expires_at: '2999-01-01T00:00:00Z',
      }],
      beforeConfirmCommit(subscription) {
        subscription.confirm_token_hash = replacedTokenHash;
      },
    });
    const token = await createSignedConfirmToken(
      state.env,
      'default',
      subscriptionId,
      '2999-01-01T00:00:00Z',
    );
    state.subscriptions[0].confirm_token_hash = await sha256Base64Url(token);

    const response = await worker.fetch(confirmRequest(token), state.env);
    const payload = await readJson(response);

    expect(response.status).toBe(400);
    expect(payload.code).toBe('INVALID_NEWSLETTER_CONFIRMATION_TOKEN');
    expect(state.subscriptions[0].status).toBe('pending');
    expect(state.subscriptions[0].confirm_token_hash).toBe(replacedTokenHash);
  });

  it('does not confirm a subscription suppressed between token lookup and update', async () => {
    const subscriptionId = '77777777777747778777777777777777';
    const state = createNewsletterMockEnv({
      subscribers: [{ id: 'subscriber-1', email: 'blocked@example.com' }],
      subscriptions: [{
        id: subscriptionId,
        newsletter_id: 'newsletter-1',
        subscriber_id: 'subscriber-1',
        status: 'pending',
        confirm_token_hash: null,
        confirm_expires_at: '2999-01-01T00:00:00Z',
      }],
      suppressBeforeConfirmCommit: 'blocked@example.com',
    });
    const token = await createSignedConfirmToken(
      state.env,
      'default',
      subscriptionId,
      '2999-01-01T00:00:00Z',
    );
    state.subscriptions[0].confirm_token_hash = await sha256Base64Url(token);

    const response = await worker.fetch(confirmRequest(token), state.env);
    const payload = await readJson(response);

    expect(response.status).toBe(400);
    expect(payload.code).toBe('INVALID_NEWSLETTER_CONFIRMATION_TOKEN');
    expect(state.subscriptions[0].status).toBe('pending');
  });

  it('does not confirm a subscription after its Newsletter is archived', async () => {
    const subscriptionId = '88888888888848888888888888888888';
    const state = createNewsletterMockEnv({
      subscriptions: [{
        id: subscriptionId,
        newsletter_id: 'newsletter-1',
        subscriber_id: 'subscriber-1',
        status: 'pending',
        confirm_token_hash: null,
        confirm_expires_at: '2999-01-01T00:00:00Z',
      }],
      archiveBeforeConfirmCommit: true,
    });
    const token = await createSignedConfirmToken(
      state.env,
      'default',
      subscriptionId,
      '2999-01-01T00:00:00Z',
    );
    state.subscriptions[0].confirm_token_hash = await sha256Base64Url(token);

    const response = await worker.fetch(confirmRequest(token), state.env);
    const payload = await readJson(response);

    expect(response.status).toBe(400);
    expect(payload.code).toBe('INVALID_NEWSLETTER_CONFIRMATION_TOKEN');
    expect(state.subscriptions[0].status).toBe('pending');
    expect(state.subscriptions[0].confirm_token_hash).not.toBeNull();
  });

  it('does not confirm subscriptions from GET confirmation links', async () => {
    const { env, subscriptions } = createNewsletterMockEnv({
      subscriptions: [{
        id: '22222222222242228222222222222222',
        newsletter_id: 'newsletter-1',
        subscriber_id: 'subscriber-1',
        status: 'pending',
        confirm_token_hash: 'unchanged-token-hash',
        confirm_expires_at: '2999-01-01T00:00:00Z',
      }],
    });

    const response = await worker.fetch(new Request(
      'https://example.com/api/newsletters/default/subscriptions/confirm?token=anything',
    ), env);
    const payload = await readJson(response);

    expect(response.status).toBe(405);
    expect(payload.code).toBe('METHOD_NOT_ALLOWED');
    expect(subscriptions[0].status).toBe('pending');
    expect(subscriptions[0].confirm_token_hash).toBe('unchanged-token-hash');
  });

  it('rejects non-JSON newsletter confirmation POST requests', async () => {
    const { env } = createNewsletterMockEnv();

    const response = await worker.fetch(new Request(
      'https://example.com/api/newsletters/default/subscriptions/confirm',
      { method: 'POST' },
    ), env);
    const payload = await readJson(response);

    expect(response.status).toBe(415);
    expect(payload.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('enforces the newsletter confirmation body limit and preserves invalid JSON errors', async () => {
    const oversized = createNewsletterMockEnv();
    const invalid = createNewsletterMockEnv();

    const oversizedResponse = await worker.fetch(new Request(
      'https://example.com/api/newsletters/default/subscriptions/confirm',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: 'x'.repeat(8 * 1024) }),
      },
    ), oversized.env);
    const invalidResponse = await worker.fetch(new Request(
      'https://example.com/api/newsletters/default/subscriptions/confirm',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{',
      },
    ), invalid.env);

    expect(oversizedResponse.status).toBe(413);
    expect(await readJson(oversizedResponse)).toEqual({
      code: 'REQUEST_BODY_TOO_LARGE',
      message: 'Request body exceeds the maximum allowed size.',
    });
    expect(oversized.sqlCalls).toEqual([]);
    expect(invalidResponse.status).toBe(400);
    expect((await readJson(invalidResponse)).code).toBe('INVALID_JSON');
    expect(invalid.sqlCalls).toEqual([]);
  });

  it('keeps confirmation and unsubscribe available without the optional read limiter', async () => {
    const subscriptionId = 'a'.repeat(32);
    const state = createNewsletterMockEnv({
      subscriptions: [{
        id: subscriptionId,
        newsletter_id: 'newsletter-1',
        subscriber_id: 'subscriber-1',
        status: 'pending',
        confirm_token_hash: null,
        confirm_expires_at: '2999-01-01T00:00:00Z',
      }],
    });
    delete state.env.NEWSLETTER_READ_RATE_LIMITER;
    const token = await createSignedConfirmToken(state.env, 'default', subscriptionId, '2999-01-01T00:00:00Z');
    state.subscriptions[0].confirm_token_hash = await sha256Base64Url(token);

    expect((await worker.fetch(confirmRequest(token), state.env)).status).toBe(200);
    const unsubscribe = await worker.fetch(new Request(
      'https://example.com/api/newsletters/default/subscriptions/unsubscribe', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: `nu1.${subscriptionId}` }),
      },
    ), state.env);

    expect(unsubscribe.status).toBe(200);
    expect(state.subscriptions[0].status).toBe('unsubscribed');
    expect(state.readRateLimiter.limit).not.toHaveBeenCalled();
  });

  it.each(['confirm', 'unsubscribe'])('rejects oversized %s bodies before consuming quota', async (action) => {
    const { env, readRateLimiter, sqlCalls } = createNewsletterMockEnv({ readRateLimitSuccess: false });
    const response = await worker.fetch(new Request(
      `https://example.com/api/newsletters/default/subscriptions/${action}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: 'x'.repeat(8 * 1024) }),
      },
    ), env);

    expect(response.status).toBe(413);
    expect(readRateLimiter.limit).not.toHaveBeenCalled();
    expect(sqlCalls).toEqual([]);
  });

  it('unsubscribes through an opaque public token and remains idempotent', async () => {
    const subscriptionId = 'a'.repeat(32);
    const state = createNewsletterMockEnv({
      subscribers: [{ id: 'subscriber-1', email: 'reader@example.com' }],
      subscriptions: [{
        id: subscriptionId,
        newsletter_id: 'newsletter-1',
        subscriber_id: 'subscriber-1',
        status: 'subscribed',
        confirm_token_hash: null,
        confirm_expires_at: null,
      }],
    });
    const request = () => new Request(
      'https://example.com/api/newsletters/default/subscriptions/unsubscribe',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: `nu1.${subscriptionId}` }),
      },
    );

    const first = await worker.fetch(request(), state.env);
    const second = await worker.fetch(request(), state.env);

    expect(first.status).toBe(200);
    expect(await readJson(first)).toEqual({ status: 'unsubscribed' });
    expect(second.status).toBe(200);
    expect(await readJson(second)).toEqual({ status: 'unsubscribed' });
    expect(state.subscriptions[0].status).toBe('unsubscribed');
  });

  it('keeps public unsubscribe available when newsletter signup is disabled', async () => {
    const subscriptionId = 'b'.repeat(32);
    const state = createNewsletterMockEnv({
      subscribers: [{ id: 'subscriber-1', email: 'reader@example.com' }],
      subscriptions: [{
        id: subscriptionId,
        newsletter_id: 'newsletter-1',
        subscriber_id: 'subscriber-1',
        status: 'pending',
        confirm_token_hash: 'pending-token',
        confirm_expires_at: '2999-01-01T00:00:00Z',
      }],
    });
    state.env.NEWSLETTER_ENABLED = 'false';
    const response = await worker.fetch(new Request(
      'https://example.com/api/newsletters/default/subscriptions/unsubscribe',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: `nu1.${subscriptionId}` }),
      },
    ), state.env);

    expect(response.status).toBe(200);
    expect(state.subscriptions[0]).toMatchObject({
      status: 'unsubscribed',
      confirm_token_hash: null,
      confirm_expires_at: null,
    });
  });

  it('rejects malformed unsubscribe tokens and never mutates from GET', async () => {
    const { env } = createNewsletterMockEnv();
    const malformed = await worker.fetch(new Request(
      'https://example.com/api/newsletters/default/subscriptions/unsubscribe',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: 'not-a-token' }),
      },
    ), env);
    const get = await worker.fetch(new Request(
      `https://example.com/api/newsletters/default/subscriptions/unsubscribe`,
    ), env);

    expect(malformed.status).toBe(400);
    expect((await readJson(malformed)).code)
      .toBe('INVALID_NEWSLETTER_UNSUBSCRIBE_TOKEN');
    expect(get.status).toBe(405);
  });

  it('does not reveal subscription state while newsletter mail is unavailable', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const disabledNew = createNewsletterMockEnv({
      edgeMailSettings: { newsletter_confirmation_enabled: 0 },
    });
    const disabledSubscribed = createSubscribedNewsletterMockEnv({
      edgeMailSettings: { newsletter_confirmation_enabled: 0 },
    });
    const missingQueueNew = createNewsletterMockEnv({ mailQueueBound: false });
    const missingQueueSubscribed = createSubscribedNewsletterMockEnv({ mailQueueBound: false });
    const queueFailureNew = createNewsletterMockEnv({
      mailQueueSendSuccess: false,
    });
    const queueFailureSubscribed = createSubscribedNewsletterMockEnv({
      mailQueueSendSuccess: false,
    });

    const disabledNewResponse = await worker.fetch(await newsletterSubscribeRequest(disabledNew.env, {
      email: 'hello@example.com',
    }), disabledNew.env);
    const disabledSubscribedResponse = await worker.fetch(await newsletterSubscribeRequest(disabledSubscribed.env, {
      email: 'subscribed@example.com',
    }), disabledSubscribed.env);
    const missingQueueNewResponse = await worker.fetch(await newsletterSubscribeRequest(missingQueueNew.env, {
      email: 'hello@example.com',
    }), missingQueueNew.env);
    const missingQueueSubscribedResponse = await worker.fetch(await newsletterSubscribeRequest(missingQueueSubscribed.env, {
      email: 'subscribed@example.com',
    }), missingQueueSubscribed.env);
    const queueFailureNewResponse = await worker.fetch(await newsletterSubscribeRequest(queueFailureNew.env, {
      email: 'hello@example.com',
    }), queueFailureNew.env);
    const queueFailureSubscribedResponse = await worker.fetch(await newsletterSubscribeRequest(queueFailureSubscribed.env, {
      email: 'subscribed@example.com',
    }), queueFailureSubscribed.env);

    expect(disabledNewResponse.status).toBe(503);
    expect(disabledSubscribedResponse.status).toBe(503);
    expect(await readJson(disabledSubscribedResponse)).toEqual(await readJson(disabledNewResponse));
    expect(disabledNew.subscribers).toEqual([]);
    expect(disabledNew.subscriptions).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith({
      message: 'Newsletter confirmation mail is disabled in edge_mail_settings',
      $zeropress: {
        code: 'NEWSLETTER_EMAIL_NOT_AVAILABLE',
        setting: 'edge_mail_settings.newsletter_confirmation_enabled',
        value: 0,
        newsletterSlug: 'default',
      },
    });
    expect(missingQueueNewResponse.status).toBe(503);
    expect(missingQueueSubscribedResponse.status).toBe(503);
    expect(await readJson(missingQueueSubscribedResponse)).toEqual(await readJson(missingQueueNewResponse));
    expect(queueFailureNewResponse.status).toBe(202);
    expect(queueFailureSubscribedResponse.status).toBe(202);
    expect(await readJson(queueFailureSubscribedResponse)).toEqual(await readJson(queueFailureNewResponse));
    expect(queueFailureNew.subscriptions[0].confirm_email_status).toBe('failed');
    expect(queueFailureNew.subscriptions[0].confirm_email_error).toBe('mail queue send failed');
    expect(queueFailureNew.deliveries).toEqual([
      expect.objectContaining({
        subscription_id: queueFailureNew.subscriptions[0].id,
        status: 'failed',
        failure_code: 'enqueue_failed',
      }),
    ]);
    expect(queueFailureSubscribed.mailQueue.send).not.toHaveBeenCalled();
  });

  it('applies the optional newsletter subscribe rate limiter', async () => {
    const { env, subscribeRateLimiter, sqlCalls } = createNewsletterMockEnv({
      subscribeRateLimitSuccess: false,
    });

    const response = await worker.fetch(await newsletterSubscribeRequest(env, { email: 'hello@example.com' }, {
      'CF-Connecting-IP': '203.0.113.77',
    }), env);

    expect(response.status).toBe(429);
    expect((await readJson(response)).code).toBe('RATE_LIMITED');
    expect(subscribeRateLimiter.limit).toHaveBeenCalledWith({ key: '203.0.113.77' });
    expect(sqlCalls).toHaveLength(0);
  });
});

function createNewsletterMockEnv(options?: {
  newsletter?: MockNewsletter | null;
  fields?: MockField[];
  subscribers?: MockSubscriber[];
  subscriptions?: MockSubscription[];
  fieldValues?: MockFieldValue[];
  deliveries?: MockDelivery[];
  suppressions?: string[];
  readRateLimitSuccess?: boolean;
  subscribeRateLimitSuccess?: boolean;
  challengeRateLimitSuccess?: boolean;
  allowedOrigins?: string;
  secretEncryptionKey?: string;
  edgeTokenSigningSecret?: string;
  verificationMode?: string;
  turnstileSiteKey?: string;
  turnstileSecretKey?: string;
  turnstileVerifyRateLimitSuccess?: boolean;
  ipHashSecret?: string | null;
  edgeMailSettings?: {
    newsletter_confirmation_enabled?: number;
  };
  mailQueueBound?: boolean;
  mailQueueSendSuccess?: boolean;
  beforeConfirmCommit?: (subscription: MockSubscription) => void;
  archiveBeforeConfirmCommit?: boolean;
  suppressBeforePendingWrite?: string;
  suppressBeforeConfirmCommit?: string;
}) {
  const newsletter = options?.newsletter === undefined
    ? {
        id: 'newsletter-1',
        slug: 'default',
        title: 'Newsletter',
        description: null,
        status: 'active',
      }
    : options.newsletter;
  const fields = [...(options?.fields ?? [])];
  const subscribers = [...(options?.subscribers ?? [])];
  const subscriptions = [...(options?.subscriptions ?? [])];
  const fieldValues = [...(options?.fieldValues ?? [])];
  const deliveries = [...(options?.deliveries ?? [])];
  const suppressions = new Set(options?.suppressions ?? []);
  const sqlCalls: string[] = [];
  const readRateLimiter = {
    limit: vi.fn(async () => ({ success: options?.readRateLimitSuccess ?? true })),
  };
  const subscribeRateLimiter = {
    limit: vi.fn(async () => ({ success: options?.subscribeRateLimitSuccess ?? true })),
  };
  const challengeRateLimiter = {
    limit: vi.fn(async () => ({ success: options?.challengeRateLimitSuccess ?? true })),
  };
  const turnstileVerifyRateLimiter = {
    limit: vi.fn(async () => ({ success: options?.turnstileVerifyRateLimitSuccess ?? true })),
  };
  const kvStore = new Map<string, string>();
  const kv = {
    get: vi.fn(async (key: string) => kvStore.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      kvStore.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      kvStore.delete(key);
    }),
  };
  const mailQueueMessages: unknown[] = [];
  const mailQueue = {
    send: vi.fn(async (message: unknown) => {
      if (options?.mailQueueSendSuccess === false) {
        throw new Error('mail queue send failed');
      }
      mailQueueMessages.push(message);
    }),
  };
  const edgeMailSettings = {
    newsletter_confirmation_enabled: options?.edgeMailSettings?.newsletter_confirmation_enabled ?? 1,
  };
  const verificationMode = options?.verificationMode ?? 'pow';
  const runtimeSettingsRow = {
    runtime_settings_id: 1,
    comment_write_verification_mode: 'pow',
    newsletter_subscribe_verification_mode: verificationMode,
    form_submit_verification_mode: 'pow',
    turnstile_sitekey: options?.turnstileSiteKey ?? null,
    ip_address_retention_days: 30,
  };
  const lifecycleRow = {
    edge_schema_version: 1,
    edge_lifecycle_state: 'ready',
    edge_target_schema_version: null,
    edge_active_operation_id: null,
  };
  // HTTP policy tests use this lightweight state double; atomic admission and
  // rollback are exercised separately against SQLite and the local Worker.
  function canReserve(recipient: MockSubscriber, quota: unknown[]) {
    const history = deliveries.filter((delivery) => subscriptions.some((subscription) =>
      subscription.id === delivery.subscription_id && subscription.subscriber_id === recipient.id));
    return !suppressions.has(recipient.email)
      && !history.some((delivery) => (delivery.created_at ?? '') > String(quota[0]))
      && history.filter((delivery) => (delivery.created_at ?? '') > String(quota[1])).length < Number(quota[2]);
  }
  const edgeDb = {
    prepare: vi.fn((sql: string) => {
      sqlCalls.push(sql);
      const createBoundStatement = (...args: unknown[]) => ({
          first: vi.fn(async () => {
            if (sql.includes('FROM zeropress_edge_schema_state')) {
              if (sql.includes('edge_runtime_settings')) {
                return { ...lifecycleRow, ...runtimeSettingsRow };
              }
              if (sql.includes('s.id, s.status, s.confirm_expires_at')) {
                const subscriptionId = String(args[0]);
                const tokenHash = String(args[1]);
                const slug = String(args[2]);
                const subscription = subscriptions.find((item) => (
                  item.id === subscriptionId
                  && item.confirm_token_hash === tokenHash
                ));
                return subscription
                  && newsletter?.slug === slug
                  && newsletter.status === 'active'
                  ? {
                      ...lifecycleRow,
                      ...subscription,
                      active_newsletter_id: newsletter.id,
                    }
                  : lifecycleRow;
              }
              if (sql.includes('subscription.id AS subscription_id')) {
                const slug = String(args[0]);
                const subscriptionId = String(args[1]);
                const subscription = subscriptions.find((item) => (
                  item.id === subscriptionId
                  && item.newsletter_id === newsletter?.id
                ));
                return newsletter?.slug === slug && subscription
                  ? { ...lifecycleRow, subscription_id: subscription.id }
                  : lifecycleRow;
              }
              if (sql.includes('newsletter_lists AS l')) {
                const slug = String(args[0]);
                return newsletter && newsletter.slug === slug && newsletter.status === 'active'
                  ? { ...lifecycleRow, ...newsletter }
                  : lifecycleRow;
              }
              return lifecycleRow;
            }

            if (sql.includes('FROM edge_runtime_settings')) {
              return runtimeSettingsRow;
            }

            if (
              sql.includes('UPDATE newsletter_subscriptions') &&
              sql.includes("status = 'subscribed'") &&
              sql.includes('RETURNING id')
            ) {
              const subscription = subscriptions.find((item) => item.id === String(args[3]));
              if (subscription) {
                options?.beforeConfirmCommit?.(subscription);
                if (options?.archiveBeforeConfirmCommit && newsletter) {
                  newsletter.status = 'archived';
                }
                const subscriber = subscribers.find((item) => item.id === subscription.subscriber_id);
                if (subscriber && subscriber.email === options?.suppressBeforeConfirmCommit) {
                  suppressions.add(subscriber.email);
                }
              }
              if (
                !subscription ||
                subscription.status !== 'pending' ||
                subscription.confirm_token_hash !== String(args[4]) ||
                newsletter?.slug !== String(args[5]) ||
                newsletter.status !== 'active' ||
                subscribers.some((subscriber) => (
                  subscriber.id === subscription.subscriber_id && suppressions.has(subscriber.email)
                ))
              ) {
                return null;
              }

              subscription.status = 'subscribed';
              subscription.confirm_token_hash = null;
              subscription.confirm_expires_at = null;
              return { id: subscription.id };
            }

            if (sql.includes('FROM edge_mail_settings')) {
              return edgeMailSettings;
            }

            if (sql.includes('FROM newsletter_lists')) {
              const slug = String(args[0]);
              return newsletter && newsletter.slug === slug && newsletter.status === 'active'
                ? newsletter
                : null;
            }

            if (sql.includes('FROM newsletter_suppressions')) {
              return suppressions.has(String(args[0])) ? { id: 'suppression-1' } : null;
            }

            if (sql.includes('FROM newsletter_subscribers')) {
              const email = String(args[0]);
              return subscribers.find((subscriber) => subscriber.email === email) ?? null;
            }

            if (sql.includes('JOIN newsletter_subscribers')) {
              const newsletterId = String(args[0]);
              const email = String(args[1]);
              const subscriber = subscribers.find((item) => item.email === email);
              return subscriber
                ? subscriptions.find((subscription) => (
                    subscription.newsletter_id === newsletterId &&
                    subscription.subscriber_id === subscriber.id
                  )) ?? null
                : null;
            }

            if (sql.includes('FROM newsletter_subscriptions') && sql.includes('subscriber_id')) {
              const newsletterId = String(args[0]);
              const subscriberId = String(args[1]);
              return subscriptions.find((subscription) => (
                subscription.newsletter_id === newsletterId &&
                subscription.subscriber_id === subscriberId
              )) ?? null;
            }

            if (sql.includes('JOIN newsletter_lists') && sql.includes('confirm_token_hash')) {
              const subscriptionId = String(args[0]);
              const slug = String(args[1]);
              const tokenHash = String(args[2]);
              return newsletter?.slug === slug
                ? subscriptions.find((subscription) => (
                    subscription.id === subscriptionId &&
                    subscription.confirm_token_hash === tokenHash
                  )) ?? null
                : null;
            }

            return null;
          }),
          all: vi.fn(async () => {
            if (sql.includes('FROM newsletter_fields')) {
              const newsletterId = String(args[0]);
              return {
                results: fields
                  .filter((field) => field.newsletter_id === newsletterId && field.status === 'active')
                  .sort((a, b) => a.sort_order - b.sort_order || a.field_key.localeCompare(b.field_key)),
              };
            }

            return { results: [] };
          }),
          run: vi.fn(async () => {
            if (sql.includes('INSERT INTO newsletter_deliveries')) {
              const subscription = subscriptions.find((item) => item.id === String(args[5]));
              const recipient = subscribers.find((item) => item.id === subscription?.subscriber_id);
              if (!subscription || !recipient || subscription.newsletter_id !== String(args[6])
                || recipient.email !== String(args[7]) || subscription.status === 'subscribed'
                || !canReserve(recipient, args.slice(8))) return { success: true, results: [] };
              const delivery = {
                id: String(args[0]), newsletter_id: subscription.newsletter_id,
                subscription_id: subscription.id, status: 'queued' as const,
                failure_code: null, created_at: String(args[3]),
              };
              deliveries.push(delivery);
              return { success: true, results: [{ id: delivery.id }] };
            }

            if (sql.includes('UPDATE newsletter_deliveries')) {
              const delivery = deliveries.find((item) => item.id === String(args[1]));
              if (delivery?.status === 'queued') {
                delivery.status = 'failed';
                delivery.failure_code = 'enqueue_failed';
              }
              return { success: true };
            }

            if (
              sql.includes('UPDATE newsletter_subscriptions')
              && sql.includes("status = 'unsubscribed'")
            ) {
              const subscription = subscriptions.find((item) => item.id === String(args[2]));
              if (subscription && ['pending', 'subscribed'].includes(subscription.status)) {
                subscription.status = 'unsubscribed';
                subscription.confirm_token_hash = null;
                subscription.confirm_expires_at = null;
                subscription.confirm_email_error = null;
              }
              return { success: true };
            }

            if (sql.includes('DELETE FROM newsletter_subscribers')) {
              const subscriberId = String(args[0]);
              const hasSubscriptions = subscriptions.some((item) => item.subscriber_id === subscriberId);
              if (!hasSubscriptions) {
                const index = subscribers.findIndex((item) => item.id === subscriberId);
                if (index >= 0) subscribers.splice(index, 1);
              }
              return { success: true };
            }

            if (sql.includes('UPDATE newsletter_subscribers')) {
              return { success: true };
            }

            if (sql.includes('INSERT INTO newsletter_subscribers')) {
              const email = String(args[1]);
              if (args[4] === 1 && !suppressions.has(email)
                && !subscribers.some((item) => item.email === email)) {
                subscribers.push({ id: String(args[0]), email });
              }
              return { success: true };
            }

            if (sql.includes("confirm_email_status = 'failed'")) {
              const subscription = subscriptions.find((item) => item.id === String(args[2]));
              if (subscription?.status === 'pending' && subscription.confirm_token_hash === String(args[3])) {
                subscription.confirm_email_status = 'failed';
                subscription.confirm_email_error = String(args[0]);
              }
              return { success: true };
            }

            if (sql.includes('UPDATE newsletter_subscriptions') && sql.includes('confirm_token_hash = ?')) {
              const subscription = subscriptions.find((item) => item.id === String(args[11]));
              if (subscription && deliveries.some((item) => item.id === String(args[12]))) {
                Object.assign(subscription, {
                  status: 'pending', confirm_token_hash: String(args[0]), confirm_expires_at: String(args[1]),
                  confirm_sent_at: null, confirm_email_status: 'not_sent', confirm_email_error: null,
                  source_url: args[2], ip_address: args[3], ip_address_recorded_at: args[4],
                  ip_hash: args[5], asn: args[6], as_organization: args[7], country_code: args[8], user_agent: args[9],
                });
              }
              return { success: true };
            }

            if (sql.includes('INSERT INTO newsletter_subscriptions')) {
              const recipient = subscribers.find((item) => item.email === String(args[4]));
              if (recipient && args[5] === 1 && canReserve(recipient, args.slice(6))
                && !subscriptions.some((item) => item.newsletter_id === String(args[1]) && item.subscriber_id === recipient.id)) {
                subscriptions.push({
                  id: String(args[0]), newsletter_id: String(args[1]), subscriber_id: recipient.id,
                  status: 'pending', confirm_token_hash: null, confirm_expires_at: null,
                });
              }
              return { success: true };
            }

            if (sql.includes('DELETE FROM newsletter_field_values')) {
              if (!deliveries.some((item) => item.id === String(args[1]))) return { success: true };
              const subscriptionId = String(args[0]);
              for (let index = fieldValues.length - 1; index >= 0; index -= 1) {
                if (fieldValues[index].subscription_id === subscriptionId) {
                  fieldValues.splice(index, 1);
                }
              }
              return { success: true };
            }

            if (sql.includes('INSERT INTO newsletter_field_values')) {
              if (!deliveries.some((item) => item.id === String(args[5]))) return { success: true };
              fieldValues.push({
                id: String(args[0]),
                subscription_id: String(args[1]),
                field_id: String(args[2]),
                field_value: String(args[3]),
              });
              return { success: true };
            }

            return { success: true };
          }),
        });
      return {
        bind: (...args: unknown[]) => createBoundStatement(...args),
        first: createBoundStatement().first,
        all: createBoundStatement().all,
        run: createBoundStatement().run,
      };
    }),
    batch: vi.fn(async (statements: Array<{ run: () => Promise<unknown> }>) => {
      if (options?.suppressBeforePendingWrite) suppressions.add(options.suppressBeforePendingWrite);
      const results = [];
      for (const statement of statements) {
        results.push(await statement.run());
      }
      return results;
    }),
  } as unknown as D1Database;

  const env = {
    NEWSLETTER_ENABLED: 'true',
    ALLOWED_ORIGINS: options?.allowedOrigins ?? '',
    EDGE_DB: edgeDb,
    EDGE_TOKEN_SIGNING_SECRET: options?.edgeTokenSigningSecret ?? TEST_EDGE_TOKEN_SIGNING_SECRET,
    IP_HASH_SECRET: options?.ipHashSecret === null
      ? undefined
      : options?.ipHashSecret ?? TEST_IP_HASH_SECRET,
    EDGE_KV: kv as unknown as KVNamespace,
    TURNSTILE_SECRET_KEY: options?.turnstileSecretKey,
    TURNSTILE_VERIFY_RATE_LIMITER: options?.turnstileVerifyRateLimitSuccess === undefined
      ? undefined
      : turnstileVerifyRateLimiter,
    NEWSLETTER_READ_RATE_LIMITER: readRateLimiter,
    NEWSLETTER_SUBSCRIBE_RATE_LIMITER: subscribeRateLimiter,
    NEWSLETTER_CHALLENGE_RATE_LIMITER: challengeRateLimiter,
    MAIL_QUEUE: options?.mailQueueBound === false ? undefined : mailQueue as unknown as Queue,
  } as Env;

  return {
    env,
    subscribers,
    subscriptions,
    deliveries,
    fieldValues,
    kv,
    kvStore,
    sqlCalls,
    mailQueue,
    mailQueueMessages,
    readRateLimiter,
    subscribeRateLimiter,
    challengeRateLimiter,
    turnstileVerifyRateLimiter,
    edgeMailSettings,
    newsletter,
  };
}

function createSubscribedNewsletterMockEnv(
  options: Parameters<typeof createNewsletterMockEnv>[0] = {},
) {
  return createNewsletterMockEnv({
    ...options,
    subscribers: [{ id: 'subscriber-existing', email: 'subscribed@example.com' }],
    subscriptions: [{
      id: 'subscription-existing',
      newsletter_id: 'newsletter-1',
      subscriber_id: 'subscriber-existing',
      status: 'subscribed',
      confirm_token_hash: null,
      confirm_expires_at: null,
    }],
  });
}

function textField(key: string, required = false): MockField {
  return {
    id: `field-${key}`,
    newsletter_id: 'newsletter-1',
    field_key: key,
    label: key,
    type: 'text',
    required: required ? 1 : 0,
    options_json: null,
    sort_order: 10,
    status: 'active',
  };
}

async function readJson(response: Response): Promise<any> {
  return unwrapApiEnvelopeForTests(await response.json());
}

function unwrapApiEnvelopeForTests(payload: any): any {
  if (payload && typeof payload === 'object' && payload.success === false && payload.error) {
    return payload.error;
  }

  if (payload && typeof payload === 'object' && payload.success === true && payload.data) {
    const data = payload.data;
    if (data && typeof data === 'object' && data.item) {
      return data.item;
    }
    return data;
  }

  return payload;
}

async function newsletterChallengeBody(_env: Env, slug = 'default') {
  const payloadSegment = encodeBase64Url(JSON.stringify({
    v: 1,
    typ: 'newsletter_challenge',
    slug,
    scope: 'subscribe',
    iat: 0,
    exp: 32_503_680_000,
    nonce: crypto.randomUUID(),
    difficulty: 0,
  }));
  const signatureMessage = `n1.${payloadSegment}`;
  const signature = await signDerivedHmacSha256Base64Url(
    TEST_EDGE_TOKEN_SIGNING_SECRET,
    'zeropress-edge/newsletter-challenge/v1',
    signatureMessage,
  );
  return {
    newsletter_challenge_token: `${signatureMessage}.${signature}`,
    newsletter_challenge_solution: '0',
  };
}

async function newsletterSubscribeRequest(env: Env, body: Record<string, unknown>, headers?: Record<string, string>): Promise<Request> {
  return new Request('https://example.com/api/newsletters/default/subscriptions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify({
      source_url: 'https://example.com/newsletter_zeropress.html#stale',
      ...body,
      ...await newsletterChallengeBody(env),
    }),
  });
}

function confirmRequest(token: string): Request {
  return new Request('https://example.com/api/newsletters/default/subscriptions/confirm', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({ token }),
  });
}

function withCloudflareMetadata(request: Request, cf: Record<string, unknown>): Request {
  Object.defineProperty(request, 'cf', {
    value: cf,
    configurable: true,
  });
  return request;
}

async function createSignedConfirmToken(
  env: Env,
  slug: string,
  subscriptionId: string,
  expiresAt: string,
): Promise<string> {
  return createNewsletterConfirmToken(env, {
    slug,
    subscriptionId,
    issuedAt: new Date('2026-01-01T00:00:00Z'),
    expiresAt: new Date(expiresAt),
  });
}

function challengeLifetimeSeconds(challengeToken: string): number {
  const payloadSegment = challengeToken.split('.')[1];
  const payload = JSON.parse(new TextDecoder().decode(decodeBase64Url(payloadSegment))) as {
    iat: number;
    exp: number;
  };
  return payload.exp - payload.iat;
}
