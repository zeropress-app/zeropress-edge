import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { type Env } from '../index';
import { decodeBase64Url, encodeBase64Url, signDerivedHmacSha256Base64Url } from '../crypto';
import { TEST_EDGE_TOKEN_SIGNING_SECRET, TEST_IP_HASH_SECRET } from '../test-utils';

type MockForm = {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  status: 'active' | 'draft' | 'disabled' | 'archived';
  submit_label: string;
  success_message: string | null;
  notification_recipient_user_id: string | null;
};

type MockField = {
  id: string;
  form_id: string;
  field_key: string;
  label: string;
  type: 'text' | 'textarea' | 'email' | 'number' | 'date' | 'select' | 'radio' | 'checkbox' | 'phone';
  required: number;
  placeholder: string | null;
  help_text: string | null;
  options_json: string | null;
  sort_order: number;
  status: 'active' | 'disabled';
};

type MockSubmission = {
  id: string;
  form_id: string;
  status: string;
  summary: string | null;
  submitter_email: string | null;
  submitter_name: string | null;
  source_url: string | null;
  ip_address: string | null;
  ip_address_recorded_at: string | null;
  ip_hash: string | null;
  asn: number | null;
  as_organization: string | null;
  country_code: string | null;
  user_agent: string | null;
  submitted_at: string;
  created_at: string;
  updated_at: string;
};

type MockSubmissionValue = {
  id: string;
  submission_id: string;
  field_id: string;
  field_key: string;
  field_label: string;
  field_type: string;
  field_value: string;
  created_at: string;
};

describe('zeropress-edge forms API', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns active form metadata and fields', async () => {
    const { env } = createFormsMockEnv();

    const response = await worker.fetch(new Request('https://example.com/api/forms/contact'), env);
    const payload = await readJson(response);

    expect(response.status).toBe(200);
    expect(payload).toEqual({
      form: {
        slug: 'contact',
        title: 'Contact',
        description: 'Send a message.',
        submit_label: 'Send',
        success_message: 'Thanks for contacting us.',
      },
      fields: [
        {
          key: 'name',
          label: 'Name',
          type: 'text',
          required: true,
          placeholder: null,
          help_text: null,
          options: [],
          sort_order: 10,
        },
        {
          key: 'email',
          label: 'Email',
          type: 'email',
          required: true,
          placeholder: null,
          help_text: null,
          options: [],
          sort_order: 20,
        },
        {
          key: 'message',
          label: 'Message',
          type: 'textarea',
          required: true,
          placeholder: null,
          help_text: null,
          options: [],
          sort_order: 30,
        },
      ],
    });
  });

  it('normalizes configured option values and exposes no more than the checkbox limit', async () => {
    const configuredOptions = [
      { value: '  alpha\tbeta😀  ', label: 'Alpha beta' },
      ...Array.from({ length: 50 }, (_, index) => ({
        value: `option_${index}`,
        label: `Option ${index}`,
      })),
    ];
    const { env, submissionValues } = createFormsMockEnv({
      fields: [{
        ...defaultField('topic', 'Topic', 'select', true, 10),
        options_json: JSON.stringify(configuredOptions),
      }],
    });

    const infoResponse = await worker.fetch(new Request('https://example.com/api/forms/contact'), env);
    const infoPayload = await readJson(infoResponse);

    expect(infoResponse.status).toBe(200);
    expect(infoPayload.fields[0].options).toHaveLength(50);
    expect(infoPayload.fields[0].options[0]).toEqual({ value: 'alpha beta', label: 'Alpha beta' });

    const submitResponse = await worker.fetch(await formSubmitRequest(env, {
      fields: { topic: 'alpha\nbeta😀' },
    }), env);

    expect(submitResponse.status).toBe(202);
    expect(submissionValues[0].field_value).toBe('alpha beta');
  });

  it('caches active form metadata and fields in EDGE_KV', async () => {
    const { env, kv, sqlCalls } = createFormsMockEnv();

    const firstResponse = await worker.fetch(new Request('https://example.com/api/forms/contact'), env);
    const secondResponse = await worker.fetch(new Request('https://example.com/api/forms/contact'), env);
    const secondPayload = await readJson(secondResponse);

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(secondPayload.form.slug).toBe('contact');
    expect(kv.get).toHaveBeenCalledWith('form-info:v2:contact');
    expect(kv.put).toHaveBeenCalledWith(
      'form-info:v2:contact',
      expect.any(String),
      { expirationTtl: 300 },
    );
    // The lifecycle-bearing form lookup runs on every request before a cached
    // payload can be trusted; the larger field query remains cached.
    expect(sqlCalls.filter((sql) => sql.includes('JOIN forms AS f'))).toHaveLength(2);
    expect(sqlCalls.filter((sql) => sql.includes('FROM form_fields'))).toHaveLength(1);
  });

  it('applies the optional form read rate limiter', async () => {
    const { env, readRateLimiter, sqlCalls } = createFormsMockEnv({
      readRateLimitSuccess: false,
    });

    const response = await worker.fetch(new Request('https://example.com/api/forms/contact', {
      headers: {
        'CF-Connecting-IP': '203.0.113.52',
      },
    }), env);
    const payload = await readJson(response);

    expect(response.status).toBe(429);
    expect(payload.code).toBe('RATE_LIMITED');
    expect(readRateLimiter.limit).toHaveBeenCalledWith({ key: '203.0.113.52' });
    expect(sqlCalls).toHaveLength(0);
  });

  it('issues form submit challenges and applies challenge rate limiting', async () => {
    const { env, challengeRateLimiter } = createFormsMockEnv();

    const response = await worker.fetch(new Request('https://example.com/api/forms/contact/challenge/submit', {
      headers: { 'CF-Connecting-IP': '203.0.113.15' },
    }), env);
    const payload = await readJson(response);

    expect(response.status).toBe(200);
    expect(payload.mode).toBe('pow');
    expect(payload.scope).toBe('submit');
    expect(payload.pow.algorithm).toBe('zp-form-pow-v1');
    expect(payload.pow.scope).toBe('submit');
    expect(payload.pow.difficulty).toBe(15);
    expect(payload.pow.challenge_token).toMatch(/^f1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    expect(challengeLifetimeSeconds(payload.pow.challenge_token)).toBe(60);
    expect(challengeRateLimiter.limit).toHaveBeenCalledWith({ key: '203.0.113.15' });

    const limited = createFormsMockEnv({ challengeRateLimitSuccess: false });
    const limitedResponse = await worker.fetch(new Request('https://example.com/api/forms/contact/challenge/submit'), limited.env);

    expect(limitedResponse.status).toBe(429);
    expect((await readJson(limitedResponse)).code).toBe('RATE_LIMITED');

    const unavailable = createFormsMockEnv({ edgeTokenSigningSecret: '' });
    const unavailableResponse = await worker.fetch(
      new Request('https://example.com/api/forms/contact/challenge/submit'),
      unavailable.env,
    );

    expect(unavailableResponse.status).toBe(503);
    expect((await readJson(unavailableResponse)).code).toBe('FORM_CHALLENGE_NOT_AVAILABLE');

    const tooShort = createFormsMockEnv({ edgeTokenSigningSecret: 'too-short-secret' });
    const tooShortResponse = await worker.fetch(
      new Request('https://example.com/api/forms/contact/challenge/submit'),
      tooShort.env,
    );

    expect(tooShortResponse.status).toBe(503);
    expect((await readJson(tooShortResponse)).code).toBe('FORM_CHALLENGE_NOT_AVAILABLE');
  });

  it('discovers Turnstile form verification without issuing a PoW challenge', async () => {
    const { env } = createFormsMockEnv({
      verificationMode: 'turnstile',
      turnstileSiteKey: 'form-site-key',
      turnstileSecretKey: 'form-secret-key',
    });

    const response = await worker.fetch(new Request('https://example.com/api/forms/contact/challenge/submit'), env);
    const payload = await readJson(response);

    expect(response.status).toBe(200);
    expect(payload).toEqual({
      mode: 'turnstile',
      scope: 'submit',
      turnstile: {
        site_key: 'form-site-key',
        action: 'form_submit',
      },
    });
    expect(payload).not.toHaveProperty('pow');
  });

  it('uses Turnstile for form submit and rejects PoW fields before checking a missing secret', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      success: true,
      action: 'form_submit',
      hostname: 'example.com',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const success = createFormsMockEnv({
      verificationMode: 'turnstile',
      turnstileSiteKey: 'form-site-key',
      turnstileSecretKey: 'form-secret-key',
    });
    const strict = createFormsMockEnv({
      verificationMode: 'turnstile',
      turnstileSiteKey: 'form-site-key',
    });
    const body = {
      fields: {
        name: 'Alice',
        email: 'alice@example.com',
        message: 'Hello',
      },
      turnstile_token: 'turnstile-form-token',
    };

    const successResponse = await worker.fetch(new Request('https://example.com/api/forms/contact/submissions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Origin: 'https://example.com',
      },
      body: JSON.stringify(body),
    }), success.env);
    const strictResponse = await worker.fetch(new Request('https://example.com/api/forms/contact/submissions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...body,
        form_challenge_token: 'not-allowed',
        form_challenge_solution: '0',
      }),
    }), strict.env);
    const strictPayload = await readJson(strictResponse);

    expect(successResponse.status).toBe(202);
    expect(success.submissions).toHaveLength(1);
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(strictResponse.status).toBe(422);
    expect(strictPayload.errors.map((error: { field?: string }) => error.field)).toEqual([
      'form_challenge_token',
      'form_challenge_solution',
    ]);
    expect(strict.submitRateLimiter.limit).toHaveBeenCalledOnce();
    expect(strict.submissions).toHaveLength(0);
  });

  it('keeps Turnstile fields out of PoW form requests', async () => {
    const state = createFormsMockEnv();
    const response = await worker.fetch(new Request('https://example.com/api/forms/contact/submissions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        fields: {},
        turnstile_token: 'not-allowed',
      }),
    }), state.env);
    const payload = await readJson(response);

    expect(response.status).toBe(422);
    expect(payload.errors).toContainEqual({
      field: 'turnstile_token',
      message: 'Unsupported body field: turnstile_token.',
    });
    expect(state.submissions).toHaveLength(0);
  });

  it('fails form verification closed for invalid modes and incomplete Turnstile configuration', async () => {
    const invalidMode = createFormsMockEnv({ verificationMode: 'pow_and_turnstile' });
    const missingSiteKey = createFormsMockEnv({
      verificationMode: 'turnstile',
      turnstileSecretKey: 'form-secret-key',
    });
    const missingSecret = createFormsMockEnv({
      verificationMode: 'turnstile',
      turnstileSiteKey: 'form-site-key',
    });

    const invalidModeResponse = await worker.fetch(
      new Request('https://example.com/api/forms/contact/challenge/submit'),
      invalidMode.env,
    );
    const missingSiteKeyResponse = await worker.fetch(
      new Request('https://example.com/api/forms/contact/challenge/submit'),
      missingSiteKey.env,
    );
    const missingSecretResponse = await worker.fetch(new Request('https://example.com/api/forms/contact/submissions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Origin: 'https://example.com',
      },
      body: JSON.stringify({
        fields: {},
        turnstile_token: 'turnstile-form-token',
      }),
    }), missingSecret.env);

    expect(invalidModeResponse.status).toBe(503);
    expect((await readJson(invalidModeResponse)).code).toBe('EDGE_RUNTIME_SETTINGS_NOT_AVAILABLE');
    expect(missingSiteKeyResponse.status).toBe(503);
    expect((await readJson(missingSiteKeyResponse)).code).toBe('EDGE_RUNTIME_SETTINGS_NOT_AVAILABLE');
    expect(missingSecretResponse.status).toBe(503);
    expect((await readJson(missingSecretResponse)).code).toBe('TURNSTILE_NOT_AVAILABLE');
    expect(missingSecret.submissions).toHaveLength(0);
  });

  it('runs the form write limiter before Turnstile verification and Siteverify', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const state = createFormsMockEnv({
      verificationMode: 'turnstile',
      turnstileSiteKey: 'form-site-key',
      turnstileSecretKey: 'form-secret-key',
      turnstileVerifyRateLimitSuccess: false,
    });

    const response = await worker.fetch(new Request('https://example.com/api/forms/contact/submissions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Origin: 'https://example.com',
        'CF-Connecting-IP': '203.0.113.90',
      },
      body: JSON.stringify({
        fields: {},
        turnstile_token: 'turnstile-form-token',
      }),
    }), state.env);

    expect(response.status).toBe(429);
    expect((await readJson(response)).code).toBe('TURNSTILE_VERIFY_RATE_LIMITED');
    expect(state.turnstileVerifyRateLimiter.limit).toHaveBeenCalledWith({ key: 'form_submit:203.0.113.90' });
    expect(state.submitRateLimiter.limit).toHaveBeenCalledWith({ key: '203.0.113.90' });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(state.submissions).toHaveLength(0);
  });

  it('rejects at the form write limiter before reading runtime settings', async () => {
    const state = createFormsMockEnv({ submitRateLimitSuccess: false });

    const response = await worker.fetch(new Request('https://example.com/api/forms/contact/submissions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'CF-Connecting-IP': '203.0.113.92',
      },
      body: JSON.stringify({ fields: {} }),
    }), state.env);

    expect(response.status).toBe(429);
    expect((await readJson(response)).code).toBe('RATE_LIMITED');
    expect(state.submitRateLimiter.limit).toHaveBeenCalledWith({ key: '203.0.113.92' });
    expect(state.sqlCalls).toHaveLength(0);
  });

  it('stores a valid form submission with canonical values and submitter metadata', async () => {
    const { env, submissions, submissionValues, submitRateLimiter } = createFormsMockEnv();

    const request = await formSubmitRequest(env, {
      fields: {
        name: ' Alice\u0007😀 ',
        email: 'ALICE@EXAMPLE.COM',
        message: 'Hello\u0000😀\r\n\r\n\r\nZero\tPress',
      },
      source_url: 'https://example.com/contact/#untrusted-fragment',
    }, {
      'CF-Connecting-IP': '203.0.113.20',
      'User-Agent': 'Forms test',
    });
    withCloudflareMetadata(request, {
      asn: 13335,
      asOrganization: 'Cloudflare, Inc.',
      country: 'KR',
    });

    const response = await worker.fetch(request, env);
    const payload = await readJson(response);

    expect(response.status).toBe(202);
    expect(payload).toEqual({
      status: 'accepted',
      message: 'Thanks for contacting us.',
    });
    expect(submissions).toHaveLength(1);
    expect(submissions[0]).toEqual(expect.objectContaining({
      id: expect.stringMatching(/^[0-9a-f]{32}$/),
      form_id: 'form-1',
      status: 'unread',
      summary: 'Alice😀, alice@example.com, Hello😀 Zero Press',
      submitter_email: 'alice@example.com',
      submitter_name: 'Alice😀',
      source_url: 'https://example.com/contact/',
      ip_address: '203.0.113.20',
      ip_address_recorded_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
      asn: 13335,
      as_organization: 'Cloudflare, Inc.',
      country_code: 'KR',
      user_agent: 'Forms test',
    }));
    expect(submissions[0].ip_hash).toMatch(/^v1\.[A-Za-z0-9_-]+$/);
    expect(submissionValues.map((value) => ({
      field_key: value.field_key,
      field_type: value.field_type,
      field_value: value.field_value,
    }))).toEqual([
      { field_key: 'name', field_type: 'text', field_value: 'Alice😀' },
      { field_key: 'email', field_type: 'email', field_value: 'alice@example.com' },
      { field_key: 'message', field_type: 'textarea', field_value: 'Hello😀\n\nZero Press' },
    ]);
    expect(submitRateLimiter.limit).toHaveBeenCalledWith({ key: '203.0.113.20' });
  });

  it.each(['text', 'textarea'] as const)('preserves Unicode free text in %s fields', async (type) => {
    const state = createFormsMockEnv({ fields: [defaultField('message', 'Message', type, true, 10)] });
    const content = '© 😊 👨‍👩‍👧‍👦 👍🏽 🇯🇵 1️⃣ ♥\uFE0E ♥\uFE0F';
    const japanese = 'ところで、今日は忙しいのでこの業務を処理できません。';
    const response = await worker.fetch(await formSubmitRequest(state.env, {
      fields: { message: `  ${content}\u0000\r\n\r\n\r\n${japanese}\t<b>text</b> &  ` },
    }), state.env);

    expect(response.status).toBe(202);
    expect(state.submissionValues[0].field_value)
      .toBe(`${content}${type === 'text' ? ' ' : '\n\n'}${japanese} <b>text</b> &`);
  });

  it.each([
    ['text', 300],
    ['textarea', 5000],
  ] as const)('enforces the %s UTF-16 length limit without dropping emoji', async (type, limit) => {
    const fields = [defaultField('message', 'Message', type, true, 10)];
    const accepted = createFormsMockEnv({ fields });
    const rejected = createFormsMockEnv({ fields });
    const content = '😊'.repeat(limit / 2);
    const acceptedResponse = await worker.fetch(await formSubmitRequest(accepted.env, {
      fields: { message: ` \u0000${content} ` },
    }), accepted.env);
    const rejectedResponse = await worker.fetch(await formSubmitRequest(rejected.env, {
      fields: { message: `${content}©` },
    }), rejected.env);

    expect(acceptedResponse.status).toBe(202);
    expect(accepted.submissionValues[0].field_value).toBe(content);
    expect(rejectedResponse.status).toBe(422);
    expect((await readJson(rejectedResponse)).errors).toContainEqual({
      field: 'fields.message', message: `Field must be ${limit} characters or fewer.`,
    });
    expect(rejected.submissions).toHaveLength(0);
  });

  it.each(['text', 'textarea'] as const)('rejects empty normalized and non-string %s values', async (type) => {
    for (const content of [' \u0000\u0007\u001B\u007F\u0085\u009F\t\r\n ', 123, ['😊']]) {
      const state = createFormsMockEnv({ fields: [defaultField('message', 'Message', type, true, 10)] });
      const response = await worker.fetch(await formSubmitRequest(state.env, {
        fields: { message: content },
      }), state.env);

      expect(response.status).toBe(422);
      expect((await readJson(response)).errors).toContainEqual({
        field: 'fields.message',
        message: typeof content === 'string' ? 'Field must not be empty.' : 'Field must be a string.',
      });
      expect(state.submissions).toHaveLength(0);
    }
  });

  it('accepts a form hosted on an allowed external site and stores the submission page URL', async () => {
    const { env, submissions } = createFormsMockEnv({
      allowedOrigins: 'https://site.example',
    });

    const response = await worker.fetch(await formSubmitRequest(env, {
      fields: {
        name: 'Alice',
        email: 'alice@example.com',
        message: 'Hello',
      },
      source_url: 'https://site.example/contact/?from=partner#form',
    }, {
      Origin: 'https://site.example',
    }), env);

    expect(response.status).toBe(202);
    expect(submissions).toHaveLength(1);
    expect(submissions[0].source_url).toBe('https://site.example/contact/?from=partner');
  });

  it.each([
    ['javascript:alert(1)', 'source_url must use http or https.'],
    ['https://user:password@example.com/contact/', 'source_url must not include credentials.'],
    ['https://evil.example/contact/', 'source_url origin is not allowed.'],
    ['/contact/', 'source_url must be an absolute URL.'],
  ])('rejects unsafe form source_url %s before challenge verification', async (sourceUrl, message) => {
    const { env, submissions, submitRateLimiter, sqlCalls } = createFormsMockEnv();

    const response = await worker.fetch(new Request('https://example.com/api/forms/contact/submissions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source_url: sourceUrl, fields: {} }),
    }), env);
    const payload = await readJson(response);

    expect(response.status).toBe(422);
    expect(payload.errors).toContainEqual({ field: 'source_url', message });
    expect(submitRateLimiter.limit).not.toHaveBeenCalled();
    expect(sqlCalls).toHaveLength(0);
    expect(submissions).toHaveLength(0);
  });

  it('rejects form submission bodies larger than 256 KiB before protected work', async () => {
    const { env, submissions, submitRateLimiter, sqlCalls, kv } = createFormsMockEnv();

    const response = await worker.fetch(new Request('https://example.com/api/forms/contact/submissions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ padding: 'x'.repeat(256 * 1024) }),
    }), env);
    const payload = await readJson(response);

    expect(response.status).toBe(413);
    expect(payload).toEqual({
      code: 'REQUEST_BODY_TOO_LARGE',
      message: 'Request body exceeds the maximum allowed size.',
    });
    expect(submitRateLimiter.limit).not.toHaveBeenCalled();
    expect(sqlCalls).toHaveLength(0);
    expect(kv.get).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
    expect(submissions).toHaveLength(0);
  });

  it('preserves the invalid JSON response for form submissions', async () => {
    const { env, submissions, submitRateLimiter, sqlCalls } = createFormsMockEnv();

    const response = await worker.fetch(new Request('https://example.com/api/forms/contact/submissions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    }), env);
    const payload = await readJson(response);

    expect(response.status).toBe(400);
    expect(payload.code).toBe('INVALID_JSON');
    expect(submitRateLimiter.limit).not.toHaveBeenCalled();
    expect(sqlCalls).toHaveLength(0);
    expect(submissions).toHaveLength(0);
  });

  it('queues a best-effort notification with the selected Studio User snapshot', async () => {
    const { env, submissions, mailQueueMessages } = createFormsMockEnv({
      form: {
        id: 'form-1',
        slug: 'contact',
        title: 'Contact',
        description: 'Send a message.',
        status: 'active',
        submit_label: 'Send',
        success_message: 'Thanks for contacting us.',
        notification_recipient_user_id: 'a'.repeat(32),
      },
    });

    const response = await worker.fetch(await formSubmitRequest(env, {
      fields: {
        name: 'Alice',
        email: 'alice@example.com',
        message: 'Hello',
      },
    }), env);
    const payload = await readJson(response);

    expect(response.status).toBe(202);
    expect(payload).toEqual({
      status: 'accepted',
      message: 'Thanks for contacting us.',
    });
    expect(mailQueueMessages).toEqual([
      {
        contract_version: 1,
        type: 'form.notification',
        submission_id: submissions[0].id,
        recipient_user_id: 'a'.repeat(32),
      },
    ]);
  });

  it('keeps the submission accepted when no notification recipient is selected', async () => {
    const { env, submissions, mailQueueMessages } = createFormsMockEnv({
      form: {
        id: 'form-1',
        slug: 'contact',
        title: 'Contact',
        description: 'Send a message.',
        status: 'active',
        submit_label: 'Send',
        success_message: 'Thanks for contacting us.',
        notification_recipient_user_id: null,
      },
    });

    const response = await worker.fetch(await formSubmitRequest(env, {
      fields: {
        name: 'Alice',
        email: 'alice@example.com',
        message: 'Hello',
      },
    }), env);
    const payload = await readJson(response);

    expect(response.status).toBe(202);
    expect(payload).toEqual({
      status: 'accepted',
      message: 'Thanks for contacting us.',
    });
    expect(submissions).toHaveLength(1);
    expect(mailQueueMessages).toEqual([]);
  });

  it('schedules the recipient snapshot through waitUntil after storage', async () => {
    const backgroundTasks: Promise<unknown>[] = [];
    const waitUntil = vi.fn((task: Promise<unknown>) => {
      backgroundTasks.push(task);
    });
    const ctx = {
      waitUntil,
      passThroughOnException: vi.fn(),
    } as unknown as ExecutionContext;
    const { env, submissions, submissionValues, mailQueueMessages } = createFormsMockEnv({
      form: {
        id: 'form-1',
        slug: 'contact',
        title: 'Contact',
        description: 'Send a message.',
        status: 'active',
        submit_label: 'Send',
        success_message: 'Thanks for contacting us.',
        notification_recipient_user_id: 'a'.repeat(32),
      },
    });

    const response = await worker.fetch(
      await formSubmitRequest(env, {
        fields: {
          name: 'Alice',
          email: 'alice@example.com',
          message: 'Hello',
        },
      }),
      env,
      ctx,
    );
    const payload = await readJson(response);
    await Promise.all(backgroundTasks);

    expect(response.status).toBe(202);
    expect(payload).toEqual({
      status: 'accepted',
      message: 'Thanks for contacting us.',
    });
    expect(submissions).toHaveLength(1);
    expect(submissionValues).toHaveLength(3);
    expect(mailQueueMessages).toEqual([{
      contract_version: 1,
      type: 'form.notification',
      submission_id: submissions[0].id,
      recipient_user_id: 'a'.repeat(32),
    }]);
    expect(waitUntil).toHaveBeenCalledOnce();
  });

  it('keeps the submission accepted when notification enqueue fails after storage', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { env, submissions, submissionValues, mailQueueMessages } = createFormsMockEnv({
      form: {
        id: 'form-1',
        slug: 'contact',
        title: 'Contact',
        description: 'Send a message.',
        status: 'active',
        submit_label: 'Send',
        success_message: 'Thanks for contacting us.',
        notification_recipient_user_id: 'a'.repeat(32),
      },
      mailQueueSendSuccess: false,
    });

    const response = await worker.fetch(await formSubmitRequest(env, {
      fields: {
        name: 'Alice',
        email: 'alice@example.com',
        message: 'Hello',
      },
    }), env);
    const payload = await readJson(response);

    expect(response.status).toBe(202);
    expect(payload).toEqual({
      status: 'accepted',
      message: 'Thanks for contacting us.',
    });
    expect(submissions).toHaveLength(1);
    expect(submissionValues).toHaveLength(3);
    expect(mailQueueMessages).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith({
      message: 'Form notification failed after submission storage',
      $zeropress: {
        submissionId: submissions[0].id,
        errorMessage: 'mail queue send failed',
      },
    });
  });

  it('rejects form submissions when IP_HASH_SECRET is missing', async () => {
    const { env, submissions } = createFormsMockEnv({ ipHashSecret: null });

    const response = await worker.fetch(await formSubmitRequest(env, {
      fields: {
        name: 'Alice',
        email: 'alice@example.com',
        message: 'Hello',
      },
    }, {
      'CF-Connecting-IP': '203.0.113.20',
    }), env);
    const payload = await readJson(response);

    expect(response.status).toBe(503);
    expect(payload).toEqual({
      code: 'FORM_IP_HASH_NOT_AVAILABLE',
      message: 'Form submissions are temporarily unavailable.',
    });
    expect(submissions).toHaveLength(0);
  });

  it('rejects missing required fields, unknown fields, and invalid options', async () => {
    const { env } = createFormsMockEnv({
      fields: [
        defaultField('name', 'Name', 'text', true, 10),
        {
          ...defaultField('topic', 'Topic', 'select', false, 20),
          options_json: JSON.stringify([{ value: 'dev', label: 'Development' }]),
        },
      ],
    });

    const response = await worker.fetch(await formSubmitRequest(env, {
      fields: {
        unknown: 'value',
        topic: 'bad',
      },
    }), env);
    const payload = await readJson(response);

    expect(response.status).toBe(422);
    expect(payload.errors.map((error: { field: string }) => error.field)).toEqual([
      'fields.unknown',
      'fields.name',
      'fields.topic',
    ]);
  });

  it('stores decimal number fields and rejects non-decimal number notation', async () => {
    const valid = createFormsMockEnv({
      fields: [defaultField('quantity', 'Quantity', 'number', true, 10)],
    });
    const invalid = createFormsMockEnv({
      fields: [
        defaultField('hex_value', 'Hex value', 'number', false, 10),
        defaultField('scientific_value', 'Scientific value', 'number', false, 20),
      ],
    });

    const validResponse = await worker.fetch(await formSubmitRequest(valid.env, {
      fields: {
        quantity: ' 001.50 ',
      },
    }), valid.env);
    const invalidResponse = await worker.fetch(await formSubmitRequest(invalid.env, {
      fields: {
        hex_value: '0x10',
        scientific_value: '1e5',
      },
    }), invalid.env);
    const invalidPayload = await readJson(invalidResponse);

    expect(validResponse.status).toBe(202);
    expect(valid.submissionValues.map((value) => ({
      field_key: value.field_key,
      field_value: value.field_value,
    }))).toEqual([
      { field_key: 'quantity', field_value: '1.5' },
    ]);
    expect(invalidResponse.status).toBe(422);
    expect(invalidPayload.errors.map((error: { field: string }) => error.field)).toEqual([
      'fields.hex_value',
      'fields.scientific_value',
    ]);
  });

  it('accepts real calendar dates and rejects impossible YYYY-MM-DD values', async () => {
    const valid = createFormsMockEnv({
      fields: [defaultField('event_date', 'Event date', 'date', true, 10)],
    });
    const invalid = createFormsMockEnv({
      fields: [defaultField('event_date', 'Event date', 'date', true, 10)],
    });

    const validResponse = await worker.fetch(await formSubmitRequest(valid.env, {
      fields: { event_date: '2024-02-29' },
    }), valid.env);
    const invalidResponse = await worker.fetch(await formSubmitRequest(invalid.env, {
      fields: { event_date: '2026-02-29' },
    }), invalid.env);
    const invalidPayload = await readJson(invalidResponse);

    expect(validResponse.status).toBe(202);
    expect(valid.submissionValues[0].field_value).toBe('2024-02-29');
    expect(invalidResponse.status).toBe(422);
    expect(invalidPayload.errors).toContainEqual({
      field: 'fields.event_date',
      message: 'Field must be a valid date in YYYY-MM-DD format.',
    });
    expect(invalid.submissions).toHaveLength(0);
  });

  it('enforces the 120-character option value contract', async () => {
    const option = 'o'.repeat(120);
    const valid = createFormsMockEnv({
      fields: [{
        ...defaultField('topic', 'Topic', 'select', true, 10),
        options_json: JSON.stringify([{ value: option, label: 'L'.repeat(120) }]),
      }],
    });
    const invalid = createFormsMockEnv({
      fields: [{
        ...defaultField('topic', 'Topic', 'select', true, 10),
        options_json: JSON.stringify([{ value: option, label: 'Topic' }]),
      }],
    });

    const validResponse = await worker.fetch(await formSubmitRequest(valid.env, {
      fields: { topic: option },
    }), valid.env);
    const invalidResponse = await worker.fetch(await formSubmitRequest(invalid.env, {
      fields: { topic: `${option}x` },
    }), invalid.env);
    const invalidPayload = await readJson(invalidResponse);

    expect(validResponse.status).toBe(202);
    expect(valid.submissionValues[0].field_value).toBe(option);
    expect(invalidResponse.status).toBe(422);
    expect(invalidPayload.errors).toContainEqual({
      field: 'fields.topic',
      message: 'Field must be 120 characters or fewer.',
    });
  });

  it('rejects form email fields that require unsafe character removal', async () => {
    const { env } = createFormsMockEnv({
      fields: [defaultField('email', 'Email', 'email', true, 10)],
    });

    const response = await worker.fetch(await formSubmitRequest(env, {
      fields: {
        email: 'alice@example.com😀',
      },
    }), env);
    const payload = await readJson(response);

    expect(response.status).toBe(422);
    expect(payload.errors).toContainEqual({
      field: 'fields.email',
      message: 'Field must be a valid email address.',
    });
  });

  it('rejects a reused form submit challenge before writing another submission', async () => {
    const { env, submissions } = createFormsMockEnv();
    const challenge = await formChallengeBody(env);
    const body = {
      fields: {
        name: 'Alice',
        email: 'alice@example.com',
        message: 'Hello',
      },
      ...challenge,
    };

    const firstResponse = await worker.fetch(new Request('https://example.com/api/forms/contact/submissions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }), env);
    const replayResponse = await worker.fetch(new Request('https://example.com/api/forms/contact/submissions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }), env);
    const replayPayload = await readJson(replayResponse);

    expect(firstResponse.status).toBe(202);
    expect(replayResponse.status).toBe(403);
    expect(replayPayload.code).toBe('FORM_CHALLENGE_ALREADY_USED');
    expect(submissions).toHaveLength(1);
  });

  it('returns not available when form submit challenge verification has no signing secret', async () => {
    const signer = createFormsMockEnv();
    const unavailable = createFormsMockEnv({ edgeTokenSigningSecret: '' });
    const challenge = await formChallengeBody(signer.env);

    const response = await worker.fetch(new Request('https://example.com/api/forms/contact/submissions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source_url: 'https://example.com/contact/',
        fields: {
          name: 'Alice',
          email: 'alice@example.com',
          message: 'Hello',
        },
        ...challenge,
      }),
    }), unavailable.env);
    const payload = await readJson(response);

    expect(response.status).toBe(503);
    expect(payload.code).toBe('FORM_CHALLENGE_NOT_AVAILABLE');
    expect(unavailable.submissions).toHaveLength(0);
  });
});

function createFormsMockEnv(options?: {
  form?: MockForm | null;
  fields?: MockField[];
  readRateLimitSuccess?: boolean;
  submitRateLimitSuccess?: boolean;
  challengeRateLimitSuccess?: boolean;
  allowedOrigins?: string;
  edgeTokenSigningSecret?: string;
  verificationMode?: string;
  turnstileSiteKey?: string;
  turnstileSecretKey?: string;
  turnstileVerifyRateLimitSuccess?: boolean;
  ipHashSecret?: string | null;
  mailQueueSendSuccess?: boolean;
}) {
  const form = options?.form === undefined
    ? {
        id: 'form-1',
        slug: 'contact',
        title: 'Contact',
        description: 'Send a message.',
        status: 'active',
        submit_label: 'Send',
        success_message: 'Thanks for contacting us.',
        notification_recipient_user_id: null,
      } satisfies MockForm
    : options.form;
  const fields = [...(options?.fields ?? [
    defaultField('name', 'Name', 'text', true, 10),
    defaultField('email', 'Email', 'email', true, 20),
    defaultField('message', 'Message', 'textarea', true, 30),
  ])];
  const sqlCalls: string[] = [];
  const submissions: MockSubmission[] = [];
  const submissionValues: MockSubmissionValue[] = [];
  const readRateLimiter = {
    limit: vi.fn(async () => ({ success: options?.readRateLimitSuccess ?? true })),
  };
  const submitRateLimiter = {
    limit: vi.fn(async () => ({ success: options?.submitRateLimitSuccess ?? true })),
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
  const verificationMode = options?.verificationMode ?? 'pow';
  const runtimeSettingsRow = {
    runtime_settings_id: 1,
    comment_write_verification_mode: 'pow',
    newsletter_subscribe_verification_mode: 'pow',
    form_submit_verification_mode: verificationMode,
    turnstile_sitekey: options?.turnstileSiteKey ?? null,
    ip_address_retention_days: 30,
  };
  const lifecycleRow = {
    edge_schema_version: 1,
    edge_lifecycle_state: 'ready',
    edge_target_schema_version: null,
    edge_active_operation_id: null,
  };
  const edgeDb = {
    prepare: vi.fn((sql: string) => {
      sqlCalls.push(sql);
      const createBoundStatement = (...args: unknown[]) => ({
          first: vi.fn(async () => {
            if (sql.includes('FROM zeropress_edge_schema_state')) {
              if (sql.includes('edge_runtime_settings')) {
                return { ...lifecycleRow, ...runtimeSettingsRow };
              }
              if (sql.includes('forms AS f')) {
                const slug = String(args[0]);
                return form && form.slug === slug && form.status === 'active'
                  ? { ...lifecycleRow, ...form }
                  : lifecycleRow;
              }
              return lifecycleRow;
            }

            if (sql.includes('FROM edge_runtime_settings')) {
              return runtimeSettingsRow;
            }

            if (sql.includes('FROM forms')) {
              const slug = String(args[0]);
              return form && form.slug === slug && form.status === 'active' ? form : null;
            }

            return null;
          }),
          all: vi.fn(async () => {
            if (sql.includes('FROM form_fields')) {
              const formId = String(args[0]);
              return {
                results: fields
                  .filter((field) => field.form_id === formId && field.status === 'active')
                  .sort((a, b) => a.sort_order - b.sort_order || a.field_key.localeCompare(b.field_key)),
              };
            }

            return { results: [] };
          }),
          run: vi.fn(async () => {
            if (sql.includes('INSERT INTO form_submissions')) {
              submissions.push({
                id: String(args[0]),
                form_id: String(args[1]),
                status: 'unread',
                summary: args[2] === null ? null : String(args[2]),
                submitter_email: args[3] === null ? null : String(args[3]),
                submitter_name: args[4] === null ? null : String(args[4]),
                source_url: args[5] === null ? null : String(args[5]),
                ip_address: args[6] === null ? null : String(args[6]),
                ip_address_recorded_at: args[7] === null ? null : String(args[7]),
                ip_hash: args[8] === null ? null : String(args[8]),
                asn: args[9] === null ? null : Number(args[9]),
                as_organization: args[10] === null ? null : String(args[10]),
                country_code: args[11] === null ? null : String(args[11]),
                user_agent: args[12] === null ? null : String(args[12]),
                submitted_at: String(args[13]),
                created_at: String(args[14]),
                updated_at: String(args[15]),
              });
              return { success: true };
            }

            if (sql.includes('INSERT INTO form_submission_values')) {
              submissionValues.push({
                id: String(args[0]),
                submission_id: String(args[1]),
                field_id: String(args[2]),
                field_key: String(args[3]),
                field_label: String(args[4]),
                field_type: String(args[5]),
                field_value: String(args[6]),
                created_at: String(args[7]),
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
      const results = [];
      for (const statement of statements) {
        results.push(await statement.run());
      }
      return results;
    }),
  } as unknown as D1Database;

  const env = {
    FORMS_ENABLED: 'true',
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
    FORM_READ_RATE_LIMITER: readRateLimiter,
    FORM_SUBMIT_RATE_LIMITER: submitRateLimiter,
    FORM_CHALLENGE_RATE_LIMITER: challengeRateLimiter,
    MAIL_QUEUE: mailQueue as unknown as Queue,
  } as Env;

  return {
    env,
    submissions,
    submissionValues,
    readRateLimiter,
    submitRateLimiter,
    challengeRateLimiter,
    turnstileVerifyRateLimiter,
    kv,
    kvStore,
    sqlCalls,
    mailQueue,
    mailQueueMessages,
  };
}

function withCloudflareMetadata(request: Request, cf: Record<string, unknown>): Request {
  Object.defineProperty(request, 'cf', {
    value: cf,
    configurable: true,
  });
  return request;
}

function defaultField(
  key: string,
  label: string,
  type: MockField['type'],
  required: boolean,
  sortOrder: number,
): MockField {
  return {
    id: `field-${key}`,
    form_id: 'form-1',
    field_key: key,
    label,
    type,
    required: required ? 1 : 0,
    placeholder: null,
    help_text: null,
    options_json: null,
    sort_order: sortOrder,
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

async function formChallengeBody(_env: Env, slug = 'contact') {
  const payloadSegment = encodeBase64Url(JSON.stringify({
    v: 1,
    typ: 'form_challenge',
    slug,
    scope: 'submit',
    iat: 0,
    exp: 32_503_680_000,
    nonce: crypto.randomUUID(),
    difficulty: 0,
  }));
  const signatureMessage = `f1.${payloadSegment}`;
  const signature = await signDerivedHmacSha256Base64Url(
    TEST_EDGE_TOKEN_SIGNING_SECRET,
    'zeropress-edge/form-challenge/v1',
    signatureMessage,
  );
  return {
    form_challenge_token: `${signatureMessage}.${signature}`,
    form_challenge_solution: '0',
  };
}

async function formSubmitRequest(
  env: Env,
  body: Record<string, unknown>,
  headers?: Record<string, string>,
): Promise<Request> {
  return new Request('https://example.com/api/forms/contact/submissions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify({
      ...body,
      ...await formChallengeBody(env),
    }),
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
