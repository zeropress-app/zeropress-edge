import type { Env } from '../../src/env';
import { signCommentRequestToken } from '../../src/comments/token';

export const fixtureIds = {
  form: 'a'.repeat(32),
  formField: 'b'.repeat(32),
  recipient: 'c'.repeat(32),
  newsletterField: 'd'.repeat(32),
};
export const fixtureNow = '2026-09-07T00:00:00Z';
const requestSecret = 'test-only-comment-request-secret';
const kid = 'k_AAAAAAAAAAAAAAAAAAAAAA';

export async function seedPublicFixtures(db: D1Database) {
  await db.batch([
    db.prepare(`UPDATE edge_comment_settings
      SET api_base_url = ?, require_approval = 0, request_secrets_json = ? WHERE id = 1`)
      .bind('https://edge.example/api', JSON.stringify({
        version: 1, current: { kid, secret: requestSecret, created_at: fixtureNow }, previous: [],
      })),
    db.prepare(`INSERT INTO edge_comment_targets
      (id, target_type, public_id, status, allow_comments, request_token_nonce, comments_cache_revision)
      VALUES (1, 'post', 101, 'published', 1, 'test-nonce', 'test-revision')`),
    db.prepare(`UPDATE edge_mail_settings SET newsletter_confirmation_enabled = 1 WHERE id = 1`),
    db.prepare(`INSERT INTO forms (id, slug, title, status, notification_recipient_user_id)
      VALUES (?, 'contact', 'Contact', 'active', ?)`)
      .bind(fixtureIds.form, fixtureIds.recipient),
    db.prepare(`INSERT INTO form_fields (id, form_id, field_key, label, type, required)
      VALUES (?, ?, 'name', 'Name', 'text', 1)`)
      .bind(fixtureIds.formField, fixtureIds.form),
    db.prepare(`INSERT INTO newsletter_fields (id, newsletter_id, field_key, label, type)
      SELECT ?, id, 'name', 'Name', 'text' FROM newsletter_lists WHERE slug = 'default'`)
      .bind(fixtureIds.newsletterField),
  ]);
}

export async function commentRequestToken() {
  return `${kid}.${await signCommentRequestToken(requestSecret, {
    targetType: 'post', targetPublicId: 101, requestTokenNonce: 'test-nonce',
  })}`;
}

export const publicBindings = {
  COMMENTS_ENABLED: 'true',
  NEWSLETTER_ENABLED: 'true',
  FORMS_ENABLED: 'true',
  EDGE_MAINTENANCE_MODE: 'false',
  EDGE_TOKEN_SIGNING_SECRET: 'test-only-edge-signing-secret-'.repeat(3),
  IP_HASH_SECRET: 'test-only-ip-hash-secret-'.repeat(3),
  ALLOWED_ORIGINS: 'https://site.example',
} satisfies Partial<Env>;

export const clientMetadata = {
  ipAddress: '203.0.113.50', ipHash: 'test-ip-hash',
  asn: null, asOrganization: null, countryCode: null, userAgent: 'Edge integration test',
};
