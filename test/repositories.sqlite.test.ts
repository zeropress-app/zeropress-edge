import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { insertComment, resolveParentComment } from '../src/comments/repository';
import { ZP_NATIVE_PUBLIC_ID_BASE } from '../src/comments/public-id';
import { getActiveFormBySlug, insertFormSubmission } from '../src/forms/repository';
import { createId } from '../src/id';
import {
  confirmNewsletterSubscription, getActiveNewsletterBySlug, NewsletterEmailSuppressedError,
  reserveNewsletterConfirmation, unsubscribeNewsletterSubscriptionById,
} from '../src/newsletters/repository';
import { expireStoredIpAddresses } from '../src/ip-retention';
import { createSqliteD1 } from './helpers/sqlite-d1';
import { clientMetadata, fixtureIds, fixtureNow, seedPublicFixtures } from './helpers/fixtures';

describe('repositories against the canonical Edge schema', () => {
  let fixture: ReturnType<typeof createSqliteD1>;
  let env: Env;
  let newsletterId: string;

  beforeEach(async () => {
    fixture = createSqliteD1();
    env = { EDGE_DB: fixture.db };
    await seedPublicFixtures(fixture.db);
    newsletterId = (await getActiveNewsletterBySlug(env, 'default'))!.id;
  });

  afterEach(() => {
    try {
      expect(fixture.sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      fixture.sqlite.close();
    }
  });

  const formInput = () => ({
    ...clientMetadata, formId: fixtureIds.form, summary: 'A message',
    submitterEmail: null, submitterName: 'Visitor', sourceUrl: 'https://site.example/contact',
    values: [{ fieldId: fixtureIds.formField, fieldKey: 'name', fieldLabel: 'Name',
      fieldType: 'text' as const, value: '홍길동 😊' }], now: fixtureNow,
  });

  const subscriptionInput = () => ({
    ...clientMetadata, newsletterId, email: 'reader@example.com',
    subscriptionId: createId(), createSubscription: true, confirmTokenHash: 'test-token-hash',
    confirmExpiresAt: '2026-09-08T00:00:00Z',
    fieldValues: [{ fieldId: fixtureIds.newsletterField, value: 'Original name' }],
    sourceUrl: 'https://site.example/newsletter', now: fixtureNow,
  });

  async function pendingDelivery() {
    const input = subscriptionInput();
    const deliveryId = await reserveNewsletterConfirmation(env, input);
    expect(deliveryId).toMatch(/^[0-9a-f]{32}$/u);
    return { subscriptionId: input.subscriptionId, deliveryId: deliveryId! };
  }

  function newsletterState() {
    return Object.fromEntries([
      'newsletter_subscribers', 'newsletter_subscriptions', 'newsletter_field_values', 'newsletter_deliveries',
    ].map((table) => [table, fixture.sqlite.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));
  }

  const commentInput = () => ({
    targetId: 1, parentPublicId: null, authorName: 'Visitor', authorEmail: 'reader@example.com',
    content: '© 😊 日本語', status: 'approved' as const, clientIP: clientMetadata.ipAddress,
    ipHash: clientMetadata.ipHash, userAgent: clientMetadata.userAgent, asn: null,
    asOrganization: null, countryCode: null, authorKind: 'guest' as const,
    authorIdentityIssuer: null, authorUserId: null,
  });

  it('allocates unique native comment IDs and resolves target-bound reply depth', async () => {
    await Promise.all(Array.from({ length: 12 }, () => insertComment(env, commentInput())));
    const ids = fixture.sqlite.prepare('SELECT public_id, content FROM comments ORDER BY public_id').all();
    expect(ids).toEqual(Array.from({ length: 12 }, (_, i) => ({
      public_id: ZP_NATIVE_PUBLIC_ID_BASE + i + 1, content: '© 😊 日本語',
    })));
    const parentId = ZP_NATIVE_PUBLIC_ID_BASE + 1;
    await insertComment(env, { ...commentInput(), parentPublicId: parentId });
    expect(await resolveParentComment(env, 1, parentId, {
      threadComments: true, threadCommentsDepth: 2,
    })).toEqual({ parentPublicId: parentId, errors: [] });
    for (const [target, parent] of [[2, parentId], [1, ZP_NATIVE_PUBLIC_ID_BASE + 13]]) {
      expect((await resolveParentComment(env, target, parent, {
        threadComments: true, threadCommentsDepth: 2,
      })).errors).toHaveLength(1);
    }
  });

  it('retains form value snapshots when the configured field is removed', async () => {
    const { id } = await insertFormSubmission(env, formInput());
    fixture.sqlite.prepare('DELETE FROM form_fields WHERE id = ?').run(fixtureIds.formField);
    expect(fixture.sqlite.prepare(`SELECT field_id, field_key, field_label, field_type, field_value
      FROM form_submission_values WHERE submission_id = ?`).get(id)).toEqual({
      field_id: null, field_key: 'name', field_label: 'Name', field_type: 'text', field_value: '홍길동 😊',
    });
  });

  it('rolls back the submission and earlier values if a later field violates a foreign key', async () => {
    const saved = await insertFormSubmission(env, formInput());
    const input = formInput();
    input.values.push({ ...input.values[0], fieldId: 'missing-field', fieldKey: 'missing' });
    await expect(insertFormSubmission(env, input)).rejects.toThrow(/FOREIGN KEY/u);
    expect(fixture.sqlite.prepare('SELECT id FROM form_submissions').all()).toEqual([{ id: saved.id }]);
    expect(fixture.sqlite.prepare('SELECT COUNT(*) AS n FROM form_submission_values').get()).toEqual({ n: 1 });
  });

  it('keeps the subscription identity on repeat signup and consumes confirmation once', async () => {
    const { subscriptionId, deliveryId } = await pendingDelivery();
    const repeated = await reserveNewsletterConfirmation(env, {
      ...subscriptionInput(), subscriptionId, createSubscription: false,
      confirmTokenHash: 'replacement-hash', now: '2026-09-07T00:05:00Z',
    });
    expect(repeated).not.toBeNull();
    expect(fixture.sqlite.prepare('SELECT id FROM newsletter_subscriptions').all()).toEqual([{ id: subscriptionId }]);
    // An admitted resend invalidates the earlier confirmation token.
    expect(await confirmNewsletterSubscription(env, 'default', subscriptionId, 'test-token-hash', fixtureNow)).toBe(false);
    expect(await confirmNewsletterSubscription(env, 'default', subscriptionId, 'replacement-hash', fixtureNow)).toBe(true);
    expect(await confirmNewsletterSubscription(env, 'default', subscriptionId, 'replacement-hash', fixtureNow)).toBe(false);
    const saved = newsletterState();
    expect(await reserveNewsletterConfirmation(env, {
      ...subscriptionInput(), subscriptionId, createSubscription: false,
      fieldValues: [], sourceUrl: 'https://site.example/changed', now: '2026-09-07T00:10:00Z',
    })).toBeNull();
    expect(newsletterState()).toEqual(saved);
    expect(fixture.sqlite.prepare('SELECT field_value FROM newsletter_field_values').all())
      .toEqual([{ field_value: 'Original name' }]);
    expect(fixture.sqlite.prepare('SELECT subscription_id, status FROM newsletter_deliveries WHERE id = ?').get(deliveryId))
      .toEqual({ subscription_id: subscriptionId, status: 'queued' });
  });

  it('rolls back a field replacement without deleting the previously saved values', async () => {
    const { subscriptionId } = await pendingDelivery();
    const saved = newsletterState();
    await expect(reserveNewsletterConfirmation(env, {
      ...subscriptionInput(), subscriptionId, createSubscription: false,
      confirmTokenHash: 'replacement-hash', now: '2026-09-07T00:05:00Z',
      fieldValues: [
        { fieldId: fixtureIds.newsletterField, value: 'Replacement' },
        { fieldId: 'missing-field', value: 'Invalid' },
      ],
    })).rejects.toThrow(/FOREIGN KEY/u);
    expect(newsletterState()).toEqual(saved);
  });

  it('rolls back a new recipient, subscription and reservation when a field write fails', async () => {
    const saved = newsletterState();
    await expect(reserveNewsletterConfirmation(env, {
      ...subscriptionInput(), fieldValues: [{ fieldId: 'missing-field', value: 'Invalid' }],
    })).rejects.toThrow(/FOREIGN KEY/u);
    expect(newsletterState()).toEqual(saved);
  });

  it('rolls back token replacement if the confirmation delivery insert fails', async () => {
    const { subscriptionId } = await pendingDelivery();
    const saved = newsletterState();
    fixture.sqlite.exec(`CREATE TRIGGER reject_delivery BEFORE INSERT ON newsletter_deliveries
      BEGIN SELECT RAISE(ABORT, 'injected delivery failure'); END`);
    await expect(reserveNewsletterConfirmation(env, {
      ...subscriptionInput(), subscriptionId, createSubscription: false,
      confirmTokenHash: 'replacement-hash',
      confirmExpiresAt: '2026-09-09T00:00:00Z', now: '2026-09-07T00:05:00Z',
    })).rejects.toThrow('injected delivery failure');
    expect(newsletterState()).toEqual(saved);
  });

  it('preserves every saved value during cooldown and admits a resend exactly five minutes later', async () => {
    const { subscriptionId } = await pendingDelivery();
    fixture.sqlite.prepare(`UPDATE newsletter_subscriptions SET
      confirm_email_status = 'sent', confirm_sent_at = ?`).run(fixtureNow);
    const saved = newsletterState();
    const retry = {
      ...subscriptionInput(), subscriptionId, createSubscription: false,
      confirmTokenHash: 'replacement-hash', confirmExpiresAt: '2026-09-09T00:00:00Z',
      fieldValues: [{ fieldId: fixtureIds.newsletterField, value: 'Replacement' }],
      sourceUrl: 'https://site.example/changed', ipAddress: '203.0.113.51',
    };
    for (const now of ['2026-09-07T00:00:01Z', '2026-09-07T00:01:00Z', '2026-09-07T00:04:59Z']) {
      expect(await reserveNewsletterConfirmation(env, { ...retry, now })).toBeNull();
      expect(newsletterState()).toEqual(saved);
    }
    expect(await reserveNewsletterConfirmation(env, { ...retry, now: '2026-09-07T00:05:00Z' })).not.toBeNull();
    expect(fixture.sqlite.prepare(`SELECT confirm_token_hash, source_url, confirm_email_status,
      confirm_sent_at FROM newsletter_subscriptions`).get()).toEqual({
      confirm_token_hash: 'replacement-hash', source_url: retry.sourceUrl,
      confirm_email_status: 'not_sent', confirm_sent_at: null,
    });
    expect(fixture.sqlite.prepare('SELECT field_value FROM newsletter_field_values').all())
      .toEqual([{ field_value: 'Replacement' }]);
  });

  it('counts five reservations across every delivery status in a rolling 24-hour window', async () => {
    const input = subscriptionInput();
    const times = ['00:00', '00:05', '00:10', '00:15', '00:20'];
    const statuses = ['failed', 'sent', 'skipped', 'queued', 'failed'];
    for (let i = 0; i < times.length; i++) {
      const deliveryId = await reserveNewsletterConfirmation(env, {
        ...input, createSubscription: i === 0, now: `2026-09-07T${times[i]}:00Z`,
      });
      expect(deliveryId).not.toBeNull();
      // Retrying the same delivery and updating its timestamps adds no reservation.
      fixture.sqlite.prepare(`UPDATE newsletter_deliveries SET status = ?, attempt_count = 50,
        sent_at = ?, last_attempt_at = ?, updated_at = ? WHERE id = ?`).run(
        statuses[i], statuses[i] === 'sent' ? fixtureNow : null,
        '2026-09-07T02:00:00Z', '2026-09-07T02:00:00Z', deliveryId,
      );
    }
    const saved = newsletterState();
    for (const now of ['2026-09-07T00:25:00Z', '2026-09-07T23:59:59Z']) {
      expect(await reserveNewsletterConfirmation(env, { ...input, createSubscription: false, now })).toBeNull();
      expect(newsletterState()).toEqual(saved);
    }
    // A different email has its own allowance, even on the same newsletter.
    expect(await reserveNewsletterConfirmation(env, {
      ...subscriptionInput(), email: 'other@example.com', now: '2026-09-07T00:25:00Z',
    })).not.toBeNull();
    for (const now of ['2026-09-08T00:00:00Z', '2026-09-08T00:05:00Z']) {
      expect(await reserveNewsletterConfirmation(env, { ...input, createSubscription: false, now })).not.toBeNull();
    }
  });

  it('shares cooldown and the daily cap across newsletters without creating denied subscriptions', async () => {
    const { subscriptionId } = await pendingDelivery();
    const otherList = createId();
    fixture.sqlite.prepare('INSERT INTO newsletter_lists (id, slug, title) VALUES (?, ?, ?)')
      .run(otherList, 'other', 'Other newsletter');
    const other = { ...subscriptionInput(), newsletterId: otherList, fieldValues: [] };
    const saved = newsletterState();
    expect(await reserveNewsletterConfirmation(env, other)).toBeNull();
    expect(newsletterState()).toEqual(saved);
    for (const [i, time] of ['00:05', '00:10', '00:15', '00:20'].entries()) {
      expect(await reserveNewsletterConfirmation(env, {
        ...other, createSubscription: i === 0, now: `2026-09-07T${time}:00Z`,
      })).not.toBeNull();
    }
    const capped = newsletterState();
    expect(await reserveNewsletterConfirmation(env, {
      ...subscriptionInput(), subscriptionId, createSubscription: false, now: '2026-09-07T00:25:00Z',
    })).toBeNull();
    expect(newsletterState()).toEqual(capped);
  });

  it('excludes post notifications from recipient confirmation limits', async () => {
    const { subscriptionId } = await pendingDelivery();
    for (let i = 0; i < 6; i++) {
      fixture.sqlite.prepare(`INSERT INTO newsletter_deliveries
        (id, newsletter_id, subscription_id, delivery_type, content_id, idempotency_key, queued_at, created_at, updated_at)
        VALUES (?, ?, ?, 'post_notification', 'post-1', ?, ?, ?, ?)`).run(
        createId(), newsletterId, subscriptionId, `post-notification-${i}`,
        '2026-09-07T00:04:59Z', '2026-09-07T00:04:59Z', '2026-09-07T00:04:59Z',
      );
    }
    expect(await reserveNewsletterConfirmation(env, {
      ...subscriptionInput(), subscriptionId, createSubscription: false, now: '2026-09-07T00:05:00Z',
    })).not.toBeNull();
  });

  it('reserves one delivery for competing first signups and competing resends', async () => {
    const inputs = Array.from({ length: 8 }, subscriptionInput);
    const results = await Promise.all(inputs.map((input) => reserveNewsletterConfirmation(env, input)));
    expect(results.filter(Boolean)).toHaveLength(1);
    const subscriptionId = inputs[results.findIndex(Boolean)].subscriptionId;
    expect(fixture.sqlite.prepare('SELECT COUNT(*) AS n FROM newsletter_subscribers').get()).toEqual({ n: 1 });
    expect(fixture.sqlite.prepare('SELECT id FROM newsletter_subscriptions').all()).toEqual([{ id: subscriptionId }]);
    const repeated = await Promise.all(inputs.map((input, i) => reserveNewsletterConfirmation(env, {
      ...input, subscriptionId, createSubscription: false, confirmTokenHash: `retry-${i}`,
      now: '2026-09-07T00:05:00Z',
    })));
    expect(repeated.filter(Boolean)).toHaveLength(1);
    expect(fixture.sqlite.prepare('SELECT confirm_token_hash FROM newsletter_subscriptions').get())
      .toEqual({ confirm_token_hash: `retry-${repeated.findIndex(Boolean)}` });
    expect(fixture.sqlite.prepare('SELECT COUNT(*) AS n FROM newsletter_deliveries').get()).toEqual({ n: 2 });
  });

  it('does not resurrect an existing subscription deleted after the handler lookup', async () => {
    const { subscriptionId } = await pendingDelivery();
    fixture.sqlite.prepare('DELETE FROM newsletter_subscriptions WHERE id = ?').run(subscriptionId);
    const saved = newsletterState();
    expect(await reserveNewsletterConfirmation(env, {
      ...subscriptionInput(), subscriptionId, createSubscription: false, now: '2026-09-07T00:05:00Z',
    })).toBeNull();
    expect(newsletterState()).toEqual(saved);
  });

  it.each(['archived', 'suppressed', 'wrong-list'])('does not confirm a %s subscription', async (state) => {
    const { subscriptionId } = await pendingDelivery();
    if (state === 'archived') fixture.sqlite.exec("UPDATE newsletter_lists SET status = 'archived'");
    if (state === 'suppressed') fixture.sqlite.exec("INSERT INTO newsletter_suppressions (email, reason) VALUES ('reader@example.com', 'manual')");
    expect(await confirmNewsletterSubscription(env, state === 'wrong-list' ? 'other' : 'default',
      subscriptionId, 'test-token-hash', fixtureNow)).toBe(false);
    expect(fixture.sqlite.prepare('SELECT status FROM newsletter_subscriptions').get()).toEqual({ status: 'pending' });
  });

  it('suppresses signup without leaving an orphan subscriber', async () => {
    fixture.sqlite.exec("INSERT INTO newsletter_suppressions (email, reason) VALUES ('reader@example.com', 'manual')");
    await expect(reserveNewsletterConfirmation(env, subscriptionInput())).rejects.toBeInstanceOf(NewsletterEmailSuppressedError);
    expect(fixture.sqlite.prepare('SELECT COUNT(*) AS n FROM newsletter_subscribers').get()).toEqual({ n: 0 });
  });

  it('unsubscribes idempotently, clears confirmation, and checks the newsletter slug', async () => {
    const { subscriptionId } = await pendingDelivery();
    await unsubscribeNewsletterSubscriptionById(env, 'other', subscriptionId, fixtureNow);
    expect(fixture.sqlite.prepare('SELECT status FROM newsletter_subscriptions').get()).toEqual({ status: 'pending' });
    await unsubscribeNewsletterSubscriptionById(env, 'default', subscriptionId, fixtureNow);
    await unsubscribeNewsletterSubscriptionById(env, 'default', subscriptionId, '2026-09-08T00:00:00Z');
    expect(fixture.sqlite.prepare(`SELECT status, confirm_token_hash, confirm_expires_at, unsubscribed_at
      FROM newsletter_subscriptions`).get()).toEqual({
      status: 'unsubscribed', confirm_token_hash: null, confirm_expires_at: null, unsubscribed_at: fixtureNow,
    });
  });

  it.each(['missing', 'newer', 'upgrading'])('rejects repository lookups when schema state is %s', async (state) => {
    if (state === 'missing') fixture.sqlite.exec('DELETE FROM zeropress_edge_schema_state');
    if (state === 'newer') fixture.sqlite.exec('UPDATE zeropress_edge_schema_state SET schema_version = 2');
    if (state === 'upgrading') fixture.sqlite.prepare(`UPDATE zeropress_edge_schema_state
      SET lifecycle_state = 'upgrading', target_schema_version = 2, active_operation_id = ?`).run('e'.repeat(32));
    await expect(getActiveFormBySlug(env, 'contact')).rejects.toThrow('lifecycle is not ready');
    await expect(getActiveNewsletterBySlug(env, 'default')).rejects.toThrow('lifecycle is not ready');
  });

  it('expires old IPs across modules, retains the cutoff boundary and preserves hashes', async () => {
    await insertComment(env, commentInput());
    await insertFormSubmission(env, formInput());
    await pendingDelivery();
    const tables = ['comments', 'form_submissions', 'newsletter_subscriptions'];
    for (const table of tables) fixture.sqlite.prepare(`UPDATE ${table} SET ip_address_recorded_at = ?`).run(fixtureNow);
    expect(await expireStoredIpAddresses(env, new Date('2026-10-07T00:00:00Z')))
      .toMatchObject({ comments: 0, formSubmissions: 0, newsletterSubscriptions: 0 });
    expect(await expireStoredIpAddresses(env, new Date('2026-10-07T00:00:01Z')))
      .toMatchObject({ comments: 1, formSubmissions: 1, newsletterSubscriptions: 1 });
    for (const table of tables) {
      expect(fixture.sqlite.prepare(`SELECT ip_address, ip_hash FROM ${table}`).get())
        .toEqual({ ip_address: null, ip_hash: 'test-ip-hash' });
    }
  });
});
