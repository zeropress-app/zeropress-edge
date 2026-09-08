import type { Env } from '../env';
import { createId } from '../id';
import { formatDateToUtcSecondIso } from '../time';
import type {
  NewsletterField,
  NewsletterFieldValueInput,
  NewsletterList,
  Subscription,
} from './types';
import {
  assertEdgeDatabaseReady,
  EDGE_DATABASE_LIFECYCLE_SELECT,
  type EdgeDatabaseLifecycleRow,
} from '../database-lifecycle';

export class NewsletterEmailSuppressedError extends Error {
  constructor() {
    super('Newsletter email is suppressed.');
    this.name = 'NewsletterEmailSuppressedError';
  }
}

export type ConfirmSubscriptionRow = {
  id: string;
  status: 'pending' | 'subscribed' | 'unsubscribed';
  confirm_expires_at: string | null;
  active_newsletter_id: string | null;
};

type NewsletterLifecycleLookupRow = EdgeDatabaseLifecycleRow & {
  subscription_id?: string | null;
};

export async function getActiveNewsletterBySlug(env: Env, slug: string): Promise<NewsletterList | null> {
  const row = await env.EDGE_DB.prepare(
    `SELECT ${EDGE_DATABASE_LIFECYCLE_SELECT},
            l.id, l.slug, l.title, l.description, l.status
     FROM zeropress_edge_schema_state AS edge_schema
     LEFT JOIN newsletter_lists AS l
       ON l.slug = ? AND l.status = 'active'
     WHERE edge_schema.id = 1
     LIMIT 1`
  )
    .bind(slug)
    .first<NewsletterList & EdgeDatabaseLifecycleRow>();

  assertEdgeDatabaseReady(row);
  return row?.id ? row : null;
}

export async function getActiveNewsletterFields(env: Env, newsletterId: string): Promise<NewsletterField[]> {
  const { results } = await env.EDGE_DB.prepare(
    `SELECT id, newsletter_id, field_key, label, type, required, options_json, sort_order, status
     FROM newsletter_fields
     WHERE newsletter_id = ? AND status = 'active'
     ORDER BY sort_order ASC, field_key ASC`
  )
    .bind(newsletterId)
    .all<NewsletterField>();

  return results ?? [];
}

export async function isNewsletterEmailSuppressed(env: Env, email: string): Promise<boolean> {
  const row = await env.EDGE_DB.prepare(
    `SELECT id
     FROM newsletter_suppressions
     WHERE email = ?
     LIMIT 1`
  )
    .bind(email)
    .first<{ id: string }>();

  return Boolean(row);
}

export async function getNewsletterSubscriptionByEmail(
  env: Env,
  newsletterId: string,
  email: string,
): Promise<Subscription | null> {
  const row = await env.EDGE_DB.prepare(
    `SELECT s.id,
            s.newsletter_id,
            s.subscriber_id,
            s.status,
            s.confirm_email_status,
            s.confirm_email_error
     FROM newsletter_subscriptions s
     JOIN newsletter_subscribers sub ON sub.id = s.subscriber_id
     WHERE s.newsletter_id = ? AND sub.email = ?
     LIMIT 1`
  )
    .bind(newsletterId, email)
    .first<Subscription>();

  return row ?? null;
}

export const NEWSLETTER_CONFIRMATION_MIN_INTERVAL_SECONDS = 5 * 60;
export const NEWSLETTER_CONFIRMATION_WINDOW_SECONDS = 24 * 60 * 60;
export const NEWSLETTER_CONFIRMATION_MAX_PER_WINDOW = 5;

// Both callers bind the cooldown cutoff, rolling-window cutoff and maximum,
// in that order. All lists belonging to the canonical recipient share a quota.
// Count reservations in every delivery state; enqueue/provider failures and
// Queue redelivery must not refund or consume additional recipient allowance.
const RECIPIENT_CONFIRMATION_AVAILABLE_SQL = `
  NOT EXISTS (
    SELECT 1 FROM newsletter_suppressions WHERE email = recipient.email
  )
  AND NOT EXISTS (
    SELECT 1
    FROM newsletter_subscriptions AS history_subscription
    JOIN newsletter_deliveries AS delivery
      ON delivery.subscription_id = history_subscription.id
    WHERE history_subscription.subscriber_id = recipient.id
      AND delivery.delivery_type = 'confirmation'
      AND delivery.created_at > ?
  )
  AND (
    SELECT COUNT(*)
    FROM newsletter_subscriptions AS history_subscription
    JOIN newsletter_deliveries AS delivery
      ON delivery.subscription_id = history_subscription.id
    WHERE history_subscription.subscriber_id = recipient.id
      AND delivery.delivery_type = 'confirmation'
      AND delivery.created_at > ?
  ) < ?
`;

export async function reserveNewsletterConfirmation(
  env: Env,
  input: {
    newsletterId: string;
    email: string;
    subscriptionId: string;
    createSubscription: boolean;
    confirmTokenHash: string;
    confirmExpiresAt: string;
    fieldValues: NewsletterFieldValueInput[];
    sourceUrl: string;
    ipAddress: string | null;
    ipHash: string | null;
    asn: number | null;
    asOrganization: string | null;
    countryCode: string | null;
    userAgent: string | null;
    now: string;
  },
): Promise<string | null> {
  const now = new Date(input.now);
  const quotaBindings = [
    formatDateToUtcSecondIso(new Date(now.getTime() - NEWSLETTER_CONFIRMATION_MIN_INTERVAL_SECONDS * 1000)),
    formatDateToUtcSecondIso(new Date(now.getTime() - NEWSLETTER_CONFIRMATION_WINDOW_SECONDS * 1000)),
    NEWSLETTER_CONFIRMATION_MAX_PER_WINDOW,
  ];
  const deliveryId = createId();
  const statements = [
    // Create identities only for a new subscription. Existing recipient rows
    // are untouched, and a deleted existing subscription is never resurrected
    // with its old unsubscribe capability.
    env.EDGE_DB.prepare(
      `INSERT INTO newsletter_subscribers (id, email, created_at, updated_at)
       SELECT ?, ?, ?, ?
       WHERE ? = 1
         AND NOT EXISTS (SELECT 1 FROM newsletter_suppressions WHERE email = ?)
       ON CONFLICT(email) DO NOTHING`
    ).bind(createId(), input.email, input.now, input.now, Number(input.createSubscription), input.email),
    env.EDGE_DB.prepare(
      `INSERT INTO newsletter_subscriptions (
         id, newsletter_id, subscriber_id, created_at, updated_at
       )
       SELECT ?, ?, recipient.id, ?, ?
       FROM newsletter_subscribers AS recipient
       WHERE recipient.email = ? AND ? = 1
         AND ${RECIPIENT_CONFIRMATION_AVAILABLE_SQL}
       ON CONFLICT(newsletter_id, subscriber_id) DO NOTHING`
    ).bind(
      input.subscriptionId, input.newsletterId, input.now, input.now,
      input.email, Number(input.createSubscription), ...quotaBindings,
    ),
    // Admission is evaluated inside the write transaction, including for a
    // previously absent subscription. A competing first signup can choose a
    // different ID; only the request whose signed token matches the actual
    // subscription ID can reserve a delivery.
    env.EDGE_DB.prepare(
      `INSERT INTO newsletter_deliveries (
         id, newsletter_id, subscription_id, delivery_type, idempotency_key,
         status, attempt_count, queued_at, created_at, updated_at
       )
       SELECT ?, subscription.newsletter_id, subscription.id, 'confirmation', ?,
              'queued', 0, ?, ?, ?
       FROM newsletter_subscriptions AS subscription
       JOIN newsletter_subscribers AS recipient ON recipient.id = subscription.subscriber_id
       WHERE subscription.id = ? AND subscription.newsletter_id = ?
         AND recipient.email = ? AND subscription.status <> 'subscribed'
         AND ${RECIPIENT_CONFIRMATION_AVAILABLE_SQL}
       RETURNING id`
    ).bind(
      deliveryId, `newsletter-delivery-${deliveryId}`, input.now, input.now, input.now,
      input.subscriptionId, input.newsletterId, input.email, ...quotaBindings,
    ),
    // A denied reservation makes every following statement a no-op. In
    // particular, it preserves the token, fields, timestamps and source URL,
    // and does not extend the recipient's cooldown.
    env.EDGE_DB.prepare(
      `UPDATE newsletter_subscriptions
       SET status = 'pending',
           confirm_token_hash = ?, confirm_expires_at = ?,
           confirm_sent_at = NULL, confirm_email_status = 'not_sent', confirm_email_error = NULL,
           source_url = ?, ip_address = ?, ip_address_recorded_at = ?, ip_hash = ?,
           asn = ?, as_organization = ?, country_code = ?, user_agent = ?,
           confirmed_at = NULL, subscribed_at = NULL, unsubscribed_at = NULL, updated_at = ?
       WHERE id = ? AND EXISTS (SELECT 1 FROM newsletter_deliveries WHERE id = ?)`
    ).bind(
      input.confirmTokenHash, input.confirmExpiresAt, input.sourceUrl,
      input.ipAddress, input.now, input.ipHash, input.asn, input.asOrganization,
      input.countryCode, input.userAgent, input.now, input.subscriptionId, deliveryId,
    ),
    env.EDGE_DB.prepare(
      `UPDATE newsletter_subscribers SET updated_at = ?
       WHERE email = ? AND EXISTS (SELECT 1 FROM newsletter_deliveries WHERE id = ?)`
    ).bind(input.now, input.email, deliveryId),
    env.EDGE_DB.prepare(
      `DELETE FROM newsletter_field_values
       WHERE subscription_id = ? AND EXISTS (SELECT 1 FROM newsletter_deliveries WHERE id = ?)`
    ).bind(input.subscriptionId, deliveryId),
    ...input.fieldValues.map((value) => env.EDGE_DB.prepare(
      `INSERT INTO newsletter_field_values (id, subscription_id, field_id, field_value, created_at)
       SELECT ?, ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM newsletter_deliveries WHERE id = ?)`
    ).bind(createId(), input.subscriptionId, value.fieldId, value.value, input.now, deliveryId)),
  ];

  const results = await env.EDGE_DB.batch<{ id: string }>(statements);
  if (results[2].results?.[0]?.id === deliveryId) return deliveryId;
  // Preserve the existing suppression response when suppression wins the
  // race after the handler's early lookup, before this atomic batch.
  if (await isNewsletterEmailSuppressed(env, input.email)) {
    throw new NewsletterEmailSuppressedError();
  }
  return null;
}

export async function markNewsletterDeliveryEnqueueFailed(
  env: Env,
  deliveryId: string,
  now: string,
): Promise<void> {
  await env.EDGE_DB.prepare(
    `UPDATE newsletter_deliveries
     SET status = 'failed',
         failure_code = 'enqueue_failed',
         updated_at = ?
     WHERE id = ? AND status = 'queued'`
  )
    .bind(now, deliveryId)
    .run();
}

export async function markNewsletterConfirmationEmailSent(
  env: Env,
  subscriptionId: string,
  now: string,
): Promise<void> {
  await env.EDGE_DB.prepare(
    `UPDATE newsletter_subscriptions
     SET confirm_email_status = 'sent',
         confirm_email_error = NULL,
         confirm_sent_at = ?,
         updated_at = ?
     WHERE id = ?`
  )
    .bind(now, now, subscriptionId)
    .run();
}

export async function markNewsletterConfirmationEmailFailed(
  env: Env,
  subscriptionId: string,
  confirmTokenHash: string,
  errorMessage: string,
  now: string,
): Promise<void> {
  await env.EDGE_DB.prepare(
    `UPDATE newsletter_subscriptions
     SET confirm_email_status = 'failed',
         confirm_email_error = ?,
         updated_at = ?
     WHERE id = ? AND status = 'pending' AND confirm_token_hash = ?`
  )
    .bind(errorMessage.slice(0, 1000), now, subscriptionId, confirmTokenHash)
    .run();
}

export async function getPendingSubscriptionByIdAndConfirmTokenHash(
  env: Env,
  newsletterSlug: string,
  subscriptionId: string,
  confirmTokenHash: string,
): Promise<ConfirmSubscriptionRow | null> {
  const row = await env.EDGE_DB.prepare(
    `SELECT ${EDGE_DATABASE_LIFECYCLE_SELECT},
            s.id, s.status, s.confirm_expires_at,
            l.id AS active_newsletter_id
     FROM zeropress_edge_schema_state AS edge_schema
     LEFT JOIN newsletter_subscriptions AS s
       ON s.id = ? AND s.confirm_token_hash = ?
     LEFT JOIN newsletter_lists AS l
       ON l.id = s.newsletter_id AND l.slug = ? AND l.status = 'active'
     WHERE edge_schema.id = 1
     LIMIT 1`
  )
    .bind(subscriptionId, confirmTokenHash, newsletterSlug)
    .first<ConfirmSubscriptionRow & EdgeDatabaseLifecycleRow>();

  assertEdgeDatabaseReady(row);
  return row?.id && row.status && row.active_newsletter_id ? row : null;
}

export async function confirmNewsletterSubscription(
  env: Env,
  newsletterSlug: string,
  subscriptionId: string,
  confirmTokenHash: string,
  now: string,
): Promise<boolean> {
  const row = await env.EDGE_DB.prepare(
    `UPDATE newsletter_subscriptions
     SET status = 'subscribed',
         confirm_token_hash = NULL,
         confirm_expires_at = NULL,
         confirmed_at = ?,
         subscribed_at = COALESCE(subscribed_at, ?),
         unsubscribed_at = NULL,
         updated_at = ?
     WHERE id = ?
       AND status = 'pending'
       AND confirm_token_hash = ?
       AND EXISTS (
         SELECT 1
         FROM newsletter_lists active_list
         WHERE active_list.id = newsletter_subscriptions.newsletter_id
           AND active_list.slug = ?
           AND active_list.status = 'active'
       )
       AND NOT EXISTS (
         SELECT 1
         FROM newsletter_suppressions suppression
         JOIN newsletter_subscribers candidate ON candidate.email = suppression.email
         WHERE candidate.id = newsletter_subscriptions.subscriber_id
       )
     RETURNING id`
  )
    .bind(now, now, now, subscriptionId, confirmTokenHash, newsletterSlug)
    .first<{ id: string }>();

  return Boolean(row);
}

export async function unsubscribeNewsletterSubscriptionById(
  env: Env,
  newsletterSlug: string,
  subscriptionId: string,
  now: string,
): Promise<void> {
  const row = await env.EDGE_DB.prepare(
    `SELECT ${EDGE_DATABASE_LIFECYCLE_SELECT},
            subscription.id AS subscription_id
     FROM zeropress_edge_schema_state AS edge_schema
     LEFT JOIN newsletter_lists AS list
       ON list.slug = ?
     LEFT JOIN newsletter_subscriptions AS subscription
       ON subscription.newsletter_id = list.id AND subscription.id = ?
     WHERE edge_schema.id = 1
     LIMIT 1`
  )
    .bind(newsletterSlug, subscriptionId)
    .first<NewsletterLifecycleLookupRow>();

  assertEdgeDatabaseReady(row);
  if (!row?.subscription_id) return;

  await env.EDGE_DB.prepare(
    `UPDATE newsletter_subscriptions
     SET status = 'unsubscribed',
         confirm_token_hash = NULL,
         confirm_expires_at = NULL,
         confirm_email_error = NULL,
         unsubscribed_at = COALESCE(unsubscribed_at, ?),
         updated_at = ?
     WHERE id = ?
       AND status IN ('pending', 'subscribed')`
  )
    .bind(now, now, subscriptionId)
    .run();
}
