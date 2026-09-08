import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { insertFormSubmission } from '../src/forms/repository';
import { reserveNewsletterConfirmation } from '../src/newsletters/repository';
import { formatDateToUtcSecondIso } from '../src/time';
import { clientMetadata, commentRequestToken, fixtureIds, fixtureNow } from './helpers/fixtures';
import { createLocalWorker } from './helpers/local-worker';

type Runtime = Awaited<ReturnType<typeof createLocalWorker>>;
type Challenge = { challenge_token: string; difficulty: number };
const post = (body: unknown) => ({
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

// Solve the issued challenge as a client would, without changing difficulty or
// mocking the Worker's crypto/verification code. Bound the work if the protocol changes.
async function proof(runtime: Runtime, path: string) {
  const response = await runtime.fetch(path);
  expect(response.status).toBe(200);
  const { data: { item } } = await response.json() as { data: { item: Challenge & { pow?: Challenge } } };
  const challenge = item.pow ?? item;
  expect(challenge.difficulty).toBeGreaterThan(0);
  expect(challenge.difficulty).toBeLessThanOrEqual(20);
  const wholeBytes = Math.floor(challenge.difficulty / 8);
  const remainingBits = challenge.difficulty % 8;
  for (let nonce = 0; nonce < 2 ** 24; nonce++) {
    const hash = createHash('sha256').update(`${challenge.challenge_token}.${nonce}`).digest();
    if (hash.subarray(0, wholeBytes).some((byte) => byte !== 0)) continue;
    if (remainingBits && hash[wholeBytes] >>> (8 - remainingBits)) continue;
    return { token: challenge.challenge_token, solution: String(nonce) };
  }
  throw new Error('Could not solve the issued proof of work within the test budget');
}

async function newsletterSignup(runtime: Runtime, slug: string, body: Record<string, unknown>, ip: string) {
  const challenge = await proof(runtime, `/api/newsletters/${slug}/challenge/subscribe`);
  const init = post({
    source_url: 'https://site.example/newsletter', ...body,
    newsletter_challenge_token: challenge.token, newsletter_challenge_solution: challenge.solution,
  });
  return runtime.fetch(`/api/newsletters/${slug}/subscriptions`, {
    ...init, headers: { ...init.headers, 'CF-Connecting-IP': ip },
  });
}

describe('built Edge Worker with disposable local D1, KV and Queue', () => {
  let runtime: Runtime | undefined;
  afterEach(async () => {
    if (!runtime) return;
    try {
      expect(runtime.outboundRequests).toEqual([]);
    } finally {
      await runtime.dispose();
      runtime = undefined;
    }
  });

  it('writes and reads a Unicode comment through signed requests, PoW and KV', async () => {
    runtime = await createLocalWorker();
    const token = await commentRequestToken();
    const base = '/api/posts/101/comments';
    const write = await proof(runtime, `${base}/challenge/write?comment_request_token=${token}`);
    const response = await runtime.fetch(base, post({
      author_name: 'Visitor', author_email: 'reader@example.com', content_text: '© 😊 日本語',
      comment_request_token: token, comment_challenge_token: write.token, comment_challenge_solution: write.solution,
    }));
    expect(response.status).toBe(201);
    const read = await proof(runtime, `${base}/challenge/read?comment_request_token=${token}`);
    const url = `${base}?comment_request_token=${token}&comment_challenge_token=${read.token}&comment_challenge_solution=${read.solution}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const comments = await runtime.fetch(url);
      expect(comments.status).toBe(200);
      expect(comments.headers.get('Access-Control-Allow-Origin')).toBe('https://site.example');
      const body = await comments.json() as { data: { items: { content_text: string }[] } };
      expect(body.data.items.map((comment) => comment.content_text)).toEqual(['© 😊 日本語']);
    }
    expect((await runtime.env.EDGE_KV!.list()).keys.length).toBeGreaterThan(0);
    expect(await runtime.env.EDGE_DB.prepare('SELECT content FROM comments').first())
      .toEqual({ content: '© 😊 日本語' });
  }, 30_000);

  it('limits auth discovery separately from comment reads and by client IP', async () => {
    runtime = await createLocalWorker({ rateLimits: { COMMENT_READ_RATE_LIMITER: 1 } });
    const limiter = runtime.env.COMMENT_READ_RATE_LIMITER!;
    expect(await limiter.limit({ key: '203.0.113.50' })).toEqual({ success: true });
    expect(await limiter.limit({ key: '203.0.113.50' })).toEqual({ success: false });

    const path = '/api/comments/auth';
    expect((await runtime.fetch(path, { method: 'OPTIONS', headers: {
      'Access-Control-Request-Method': 'GET',
    } })).status).toBe(204);
    expect((await runtime.fetch(path)).status).toBe(200);
    const limited = await runtime.fetch(path, { headers: { 'X-Forwarded-For': '198.51.100.99' } });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Access-Control-Allow-Origin')).toBe('https://site.example');
    expect(await limited.json()).toMatchObject({ success: false, error: { code: 'RATE_LIMITED' } });
    expect((await runtime.fetch(path, { headers: { 'CF-Connecting-IP': '203.0.113.51' } })).status).toBe(200);
  }, 30_000);

  it('stores a form and delivers its contract 1 message to the local queue consumer', async () => {
    runtime = await createLocalWorker();
    const challenge = await proof(runtime, '/api/forms/contact/challenge/submit');
    const response = await runtime.fetch('/api/forms/contact/submissions', post({
      fields: { name: '홍길동 😊' }, form_challenge_token: challenge.token, form_challenge_solution: challenge.solution,
    }));
    expect(response.status).toBe(202);
    await expect.poll(() => runtime!.messages()).toHaveLength(1);
    const [message] = await runtime.messages();
    const submission = await runtime.env.EDGE_DB.prepare('SELECT id FROM form_submissions').first<{ id: string }>();
    expect(message).toEqual({ contract_version: 1, type: 'form.notification',
      submission_id: submission!.id, recipient_user_id: fixtureIds.recipient });
    expect(await runtime.env.EDGE_DB.prepare('SELECT field_value FROM form_submission_values').first())
      .toEqual({ field_value: '홍길동 😊' });
  }, 30_000);

  it('binds newsletter mail to its ledger and isolates confirmation and unsubscribe quotas', async () => {
    runtime = await createLocalWorker({ rateLimits: {
      NEWSLETTER_READ_RATE_LIMITER: 2, NEWSLETTER_SUBSCRIBE_RATE_LIMITER: 1,
    } });
    for (let attempt = 0; attempt < 2; attempt++) {
      expect((await runtime.fetch('/api/newsletters/default')).status).toBe(200);
    }
    expect((await runtime.fetch('/api/newsletters/default')).status).toBe(429);
    const challenge = await proof(runtime, '/api/newsletters/default/challenge/subscribe');
    const response = await runtime.fetch('/api/newsletters/default/subscriptions', post({
      email: 'reader@example.com', source_url: 'https://site.example/newsletter',
      newsletter_challenge_token: challenge.token, newsletter_challenge_solution: challenge.solution,
    }));
    expect(response.status).toBe(202);
    expect(await runtime.env.NEWSLETTER_SUBSCRIBE_RATE_LIMITER!.limit({ key: '203.0.113.50' }))
      .toEqual({ success: false });
    await expect.poll(() => runtime!.messages()).toHaveLength(1);
    const [message] = await runtime.messages();
    if (message.type !== 'newsletter.confirmation') throw new Error('Expected a confirmation job');
    expect(message).toEqual({ contract_version: 1, type: 'newsletter.confirmation',
      delivery_id: expect.stringMatching(/^[0-9a-f]{32}$/u), subscription_id: expect.stringMatching(/^[0-9a-f]{32}$/u),
      token: expect.any(String), unsubscribe_token: expect.stringMatching(/^nu1\.[0-9a-f]{32}$/u) });
    expect(await runtime.env.EDGE_DB.prepare('SELECT subscription_id, status FROM newsletter_deliveries WHERE id = ?')
      .bind(message.delivery_id).first()).toEqual({ subscription_id: message.subscription_id, status: 'queued' });
    const confirmPath = '/api/newsletters/default/subscriptions/confirm';
    expect((await runtime.fetch(confirmPath, post({ token: message.token }))).status).toBe(200);
    expect((await runtime.fetch(confirmPath, post({ token: message.token }))).status).toBe(400);
    // Changing the slug or token must not create another quota bucket.
    expect((await runtime.fetch('/api/newsletters/other/subscriptions/confirm',
      post({ token: 'another-token' }))).status).toBe(429);
    for (let attempt = 0; attempt < 2; attempt++) {
      expect((await runtime.fetch('/api/newsletters/default/subscriptions/unsubscribe',
        post({ token: message.unsubscribe_token }))).status).toBe(200);
    }
    expect((await runtime.fetch('/api/newsletters/other/subscriptions/unsubscribe',
      post({ token: `nu1.${'f'.repeat(32)}` }))).status).toBe(429);
    expect(await runtime.env.EDGE_DB.prepare('SELECT status, confirm_token_hash FROM newsletter_subscriptions').first())
      .toEqual({ status: 'unsubscribed', confirm_token_hash: null });
  }, 30_000);

  it('keeps unsubscribe available and rate limited while newsletter signup is disabled', async () => {
    runtime = await createLocalWorker({
      bindings: { NEWSLETTER_ENABLED: 'false' }, rateLimits: { NEWSLETTER_READ_RATE_LIMITER: 1 },
    });
    const subscriberId = 'e'.repeat(32);
    const subscriptionId = 'f'.repeat(32);
    const db = runtime.env.EDGE_DB;
    await db.batch([
      db.prepare('INSERT INTO newsletter_subscribers (id, email) VALUES (?, ?)')
        .bind(subscriberId, 'reader@example.com'),
      db.prepare(`INSERT INTO newsletter_subscriptions (id, newsletter_id, subscriber_id, status)
        SELECT ?, id, ?, 'subscribed' FROM newsletter_lists WHERE slug = 'default'`)
        .bind(subscriptionId, subscriberId),
    ]);
    const path = '/api/newsletters/default/subscriptions/unsubscribe';
    const body = { token: `nu1.${subscriptionId}` };

    expect((await runtime.fetch(path, post(body))).status).toBe(200);
    expect((await runtime.fetch(path, post(body))).status).toBe(429);
    expect(await db.prepare('SELECT status FROM newsletter_subscriptions WHERE id = ?')
      .bind(subscriptionId).first()).toEqual({ status: 'unsubscribed' });
  }, 30_000);

  it('preserves the pending confirmation and fields when the same recipient retries from another IP', async () => {
    runtime = await createLocalWorker();
    const first = await newsletterSignup(runtime, 'default', {
      email: ' Reader@Example.com ', fields: { name: 'Original name' },
    }, '203.0.113.50');
    expect(first.status).toBe(202);
    await expect.poll(() => runtime!.messages()).toHaveLength(1);
    const [message] = await runtime.messages();
    if (message.type !== 'newsletter.confirmation') throw new Error('Expected a confirmation job');
    const tables = ['newsletter_subscribers', 'newsletter_subscriptions', 'newsletter_field_values', 'newsletter_deliveries'];
    const snapshot = () => Promise.all(tables.map(async (table) =>
      (await runtime!.env.EDGE_DB.prepare(`SELECT * FROM ${table} ORDER BY id`).all()).results));
    const saved = await snapshot();
    expect(saved[0]).toMatchObject([{ email: 'reader@example.com' }]);
    const repeated = await newsletterSignup(runtime, 'default', {
      email: 'reader@example.com', fields: { name: 'Replacement' }, source_url: 'https://site.example/changed',
    }, '203.0.113.51');
    expect(repeated.status).toBe(202);
    expect(await repeated.json()).toEqual(await first.json());
    expect(repeated.headers.get('Retry-After')).toBeNull();
    expect(await snapshot()).toEqual(saved);
    expect(await runtime.messages()).toHaveLength(1);
    expect((await runtime.fetch('/api/newsletters/default/subscriptions/confirm',
      post({ token: message.token }))).status).toBe(200);
  }, 30_000);

  it('atomically reserves one confirmation across concurrent signups and resends on different lists and IPs', async () => {
    runtime = await createLocalWorker();
    const db = runtime.env.EDGE_DB;
    await db.prepare("INSERT INTO newsletter_lists (slug, title) VALUES ('other', 'Other newsletter')").run();
    const slugs = ['default', 'other', 'default', 'other', 'default', 'other'];
    const responses = await Promise.all(slugs.map((slug, i) => newsletterSignup(runtime!, slug, {
      email: i % 2 ? 'reader@example.com' : ' Reader@Example.com ',
    }, `203.0.113.${60 + i}`)));
    for (const response of responses) expect(response.status).toBe(202);
    const bodies = await Promise.all(responses.map((response) => response.json()));
    for (const body of bodies) expect(body).toEqual(bodies[0]);
    await expect.poll(() => runtime!.messages()).toHaveLength(1);
    for (const table of ['newsletter_subscribers', 'newsletter_subscriptions', 'newsletter_deliveries']) {
      expect(await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).toEqual({ n: 1 });
    }
    const subscription = await db.prepare(`SELECT s.id, l.slug FROM newsletter_subscriptions AS s
      JOIN newsletter_lists AS l ON l.id = s.newsletter_id`).first<{ id: string; slug: string }>();
    // Only the disposable fixture's reservation time changes; no wall-clock wait is needed.
    await db.prepare('UPDATE newsletter_deliveries SET created_at = ?')
      .bind(formatDateToUtcSecondIso(new Date(Date.now() - 301_000))).run();
    const repeated = await Promise.all(Array.from({ length: 6 }, (_, i) => newsletterSignup(runtime!, subscription!.slug, {
      email: 'reader@example.com',
    }, `203.0.113.${70 + i}`)));
    for (const response of repeated) expect(response.status).toBe(202);
    await expect.poll(() => runtime!.messages()).toHaveLength(2);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM newsletter_deliveries').first()).toEqual({ n: 2 });
    expect(await db.prepare('SELECT id FROM newsletter_subscriptions').first()).toEqual({ id: subscription!.id });
    expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  }, 30_000);

  it('rolls back newsletter admission, identities and token changes on a real D1 field failure', async () => {
    runtime = await createLocalWorker();
    const db = runtime.env.EDGE_DB;
    const newsletter = await db.prepare("SELECT id FROM newsletter_lists WHERE slug = 'default'").first<{ id: string }>();
    const input = {
      ...clientMetadata, newsletterId: newsletter!.id, email: 'reader@example.com',
      subscriptionId: 'e'.repeat(32), createSubscription: true,
      confirmTokenHash: 'original-hash', confirmExpiresAt: '2026-09-09T00:00:00Z',
      fieldValues: [{ fieldId: fixtureIds.newsletterField, value: 'Original name' }],
      sourceUrl: 'https://site.example/newsletter', now: fixtureNow,
    };
    const tables = ['newsletter_subscribers', 'newsletter_subscriptions', 'newsletter_field_values', 'newsletter_deliveries'];
    const snapshot = () => Promise.all(tables.map(async (table) =>
      (await db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()).results));
    const empty = await snapshot();
    await expect(reserveNewsletterConfirmation(runtime.env, {
      ...input, fieldValues: [{ fieldId: 'missing-field', value: 'Invalid' }],
    })).rejects.toThrow(/FOREIGN KEY/u);
    expect(await snapshot()).toEqual(empty);
    expect(await reserveNewsletterConfirmation(runtime.env, input)).not.toBeNull();
    const saved = await snapshot();
    await expect(reserveNewsletterConfirmation(runtime.env, {
      ...input, createSubscription: false, now: '2026-09-07T00:05:00Z',
      confirmTokenHash: 'replacement-hash', fieldValues: [{ fieldId: 'missing-field', value: 'Invalid' }],
    })).rejects.toThrow(/FOREIGN KEY/u);
    expect(await snapshot()).toEqual(saved);
    expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  }, 30_000);

  it('rolls back the complete form batch on a real D1 foreign-key failure', async () => {
    runtime = await createLocalWorker();
    await expect(insertFormSubmission(runtime.env, {
      ...clientMetadata, formId: fixtureIds.form, summary: null, submitterEmail: null,
      submitterName: null, sourceUrl: null, now: fixtureNow,
      values: [fixtureIds.formField, 'missing-field'].map((fieldId) => ({
        fieldId, fieldKey: fieldId, fieldLabel: 'Name', fieldType: 'text', value: 'Test',
      })),
    })).rejects.toThrow(/FOREIGN KEY/u);
    for (const table of ['form_submissions', 'form_submission_values']) {
      expect(await runtime.env.EDGE_DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).toEqual({ n: 0 });
    }
    expect((await runtime.env.EDGE_DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  }, 30_000);

  it('enforces a real rate-limit binding and the database lifecycle gate', async () => {
    runtime = await createLocalWorker({ rateLimits: { FORM_READ_RATE_LIMITER: 1 } });
    expect((await runtime.fetch('/api/forms/contact')).status).toBe(200);
    expect((await runtime.fetch('/api/forms/contact')).status).toBe(429);
    await runtime.env.EDGE_DB.prepare('UPDATE zeropress_edge_schema_state SET schema_version = 2').run();
    const response = await runtime.fetch('/api/newsletters/default');
    expect(response.status).toBe(503);
    expect(await response.text()).toContain('EDGE_DATABASE_NOT_AVAILABLE');
  }, 30_000);

  it.each([
    ['true', 'EDGE_MAINTENANCE'], ['invalid', 'EDGE_CONFIGURATION_ERROR'],
  ])('fails closed with maintenance=%s even without any resource bindings', async (mode, code) => {
    runtime = await createLocalWorker({ resources: false, bindings: { EDGE_MAINTENANCE_MODE: mode } });
    for (const path of [
      '/api/posts/101/comments', '/api/forms/contact', '/api/newsletters/default',
      '/api/comments/auth', '/api/newsletters/default/subscriptions/confirm',
      '/api/newsletters/default/subscriptions/unsubscribe',
    ]) {
      const response = await runtime.fetch(path);
      expect(response.status).toBe(503);
      expect(await response.text()).toContain(code);
    }
    expect((await runtime.fetch('/api/forms/contact', { method: 'OPTIONS', headers: {
      'Access-Control-Request-Method': 'GET',
    } })).status).toBe(204);
  }, 30_000);
});
