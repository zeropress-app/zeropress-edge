-- ZeroPress Edge fresh-install artifact. This is not a Wrangler migration and
-- must only be executed by the reviewed Studio Edge database lifecycle runner.

CREATE TABLE zeropress_edge_schema_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
  lifecycle_state TEXT NOT NULL
    CHECK (lifecycle_state IN ('ready', 'installing', 'upgrading', 'failed')),
  target_schema_version INTEGER
    CHECK (target_schema_version IS NULL OR target_schema_version >= 1),
  active_operation_id TEXT
    CHECK (
      active_operation_id IS NULL OR (
        length(active_operation_id) = 32 AND
        active_operation_id NOT GLOB '*[^0-9a-f]*'
      )
    ),
  updated_at_iso TEXT NOT NULL,
  CHECK (
    (
      lifecycle_state = 'ready' AND
      target_schema_version IS NULL AND
      active_operation_id IS NULL
    ) OR (
      lifecycle_state IN ('installing', 'upgrading') AND
      target_schema_version IS NOT NULL AND
      target_schema_version > schema_version AND
      active_operation_id IS NOT NULL
    ) OR lifecycle_state = 'failed'
  )
);

-- Table: edge_comment_settings
CREATE TABLE edge_comment_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  api_base_url TEXT,
  comments_enabled INTEGER NOT NULL DEFAULT 1 CHECK (comments_enabled IN (0, 1)),
  require_approval INTEGER NOT NULL DEFAULT 1 CHECK (require_approval IN (0, 1)),
  per_page INTEGER NOT NULL DEFAULT 50 CHECK (per_page BETWEEN 1 AND 100),
  sort_order TEXT NOT NULL DEFAULT 'desc' CHECK (sort_order IN ('asc', 'desc')),
  thread_comments INTEGER NOT NULL DEFAULT 1 CHECK (thread_comments IN (0, 1)),
  thread_comments_depth INTEGER NOT NULL DEFAULT 2 CHECK (thread_comments_depth BETWEEN 2 AND 10),
  request_secrets_json TEXT,
  auth_enabled INTEGER NOT NULL DEFAULT 0 CHECK (auth_enabled IN (0, 1)),
  supabase_project_url TEXT,
  supabase_publishable_key TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  CONSTRAINT chk_edge_comment_settings_supabase_pair
    CHECK (
      (
        supabase_project_url IS NULL AND
        supabase_publishable_key IS NULL
      ) OR (
        supabase_project_url IS NOT NULL AND
        supabase_publishable_key IS NOT NULL AND
        supabase_project_url = trim(supabase_project_url) AND
        length(supabase_project_url) BETWEEN 9 AND 2048 AND
        (
          (
            substr(supabase_project_url, 1, 8) = 'https://' AND
            length(substr(supabase_project_url, 9)) > 0 AND
            instr(substr(supabase_project_url, 9), '/') = 0
          ) OR (
            substr(supabase_project_url, 1, 7) = 'http://' AND
            instr(substr(supabase_project_url, 8), '/') = 0 AND
            (
              substr(supabase_project_url, 8) = 'localhost' OR
              substr(supabase_project_url, 8) LIKE 'localhost:%' OR
              substr(supabase_project_url, 8) = '127.0.0.1' OR
              substr(supabase_project_url, 8) LIKE '127.0.0.1:%' OR
              substr(supabase_project_url, 8) = '[::1]' OR
              substr(supabase_project_url, 8) LIKE '[::1]:%'
            )
          )
        ) AND
        instr(supabase_project_url, '@') = 0 AND
        instr(supabase_project_url, '?') = 0 AND
        instr(supabase_project_url, '#') = 0 AND
        instr(supabase_project_url, char(9)) = 0 AND
        instr(supabase_project_url, char(10)) = 0 AND
        instr(supabase_project_url, char(13)) = 0 AND
        instr(supabase_project_url, ' ') = 0 AND
        supabase_publishable_key = trim(supabase_publishable_key) AND
        length(supabase_publishable_key) BETWEEN 31 AND 527 AND
        substr(supabase_publishable_key, 1, 15) = 'sb_publishable_' AND
        substr(supabase_publishable_key, 16) NOT GLOB '*[^A-Za-z0-9._-]*' AND
        instr(supabase_publishable_key, char(9)) = 0 AND
        instr(supabase_publishable_key, char(10)) = 0 AND
        instr(supabase_publishable_key, char(13)) = 0 AND
        instr(supabase_publishable_key, ' ') = 0
      )
    ),
  CONSTRAINT chk_edge_comment_settings_auth_enabled
    CHECK (
      auth_enabled = 0 OR (
        supabase_project_url IS NOT NULL AND
        supabase_publishable_key IS NOT NULL
      )
    )
);

-- Table: edge_runtime_settings
CREATE TABLE edge_runtime_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  comment_write_verification_mode TEXT NOT NULL DEFAULT 'pow'
    CHECK (comment_write_verification_mode IN ('pow', 'turnstile')),
  newsletter_subscribe_verification_mode TEXT NOT NULL DEFAULT 'pow'
    CHECK (newsletter_subscribe_verification_mode IN ('pow', 'turnstile')),
  form_submit_verification_mode TEXT NOT NULL DEFAULT 'pow'
    CHECK (form_submit_verification_mode IN ('pow', 'turnstile')),
  turnstile_sitekey TEXT
    CHECK (
      turnstile_sitekey IS NULL OR
      (
        turnstile_sitekey = trim(turnstile_sitekey) AND
        turnstile_sitekey <> '' AND
        length(turnstile_sitekey) <= 256
      )
    ),
  ip_address_retention_days INTEGER NOT NULL DEFAULT 30
    CHECK (
      typeof(ip_address_retention_days) = 'integer' AND
      ip_address_retention_days BETWEEN 1 AND 365
    ),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  CHECK (
    (
      comment_write_verification_mode = 'pow' AND
      newsletter_subscribe_verification_mode = 'pow' AND
      form_submit_verification_mode = 'pow'
    ) OR
    turnstile_sitekey IS NOT NULL
  )
);

-- Table: edge_mail_settings
CREATE TABLE edge_mail_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  newsletter_confirmation_enabled INTEGER NOT NULL DEFAULT 0 CHECK (newsletter_confirmation_enabled IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Table: edge_comment_targets
CREATE TABLE edge_comment_targets (
  id INTEGER PRIMARY KEY,
  target_type TEXT NOT NULL CHECK (target_type IN ('post', 'page')),
  public_id INTEGER NOT NULL CHECK (public_id > 0),
  status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'scheduled', 'archived', 'trash')),
  allow_comments INTEGER NOT NULL DEFAULT 0 CHECK (allow_comments IN (0, 1)),
  request_token_nonce TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))),
  comments_cache_revision TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))),
  UNIQUE (target_type, public_id)
);

-- Table: comments
CREATE TABLE comments (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  public_id INTEGER NOT NULL UNIQUE CHECK (public_id > 0),
  target_id INTEGER NOT NULL REFERENCES edge_comment_targets(id) ON DELETE CASCADE,
  parent_public_id INTEGER CHECK (parent_public_id IS NULL OR parent_public_id > 0),
  author_name TEXT NOT NULL,
  author_email TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'spam', 'trash')),
  imported INTEGER NOT NULL DEFAULT 0 CHECK (imported IN (0, 1)),
  ip_address TEXT,
  ip_address_recorded_at TEXT,
  ip_hash TEXT,
  user_agent TEXT,
  asn INTEGER,
  as_organization TEXT,
  country_code TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  author_user_id TEXT,
  author_kind TEXT NOT NULL DEFAULT 'guest',
  author_identity_issuer TEXT,
  CONSTRAINT chk_comments_ip_address_recorded_at
    CHECK (ip_address IS NULL OR ip_address_recorded_at IS NOT NULL),
  CONSTRAINT chk_comments_author_identity_v2
    CHECK (
      author_kind IN ('guest', 'site_user', 'authenticated_user') AND
      (
        (
          author_kind = 'guest' AND
          author_identity_issuer IS NULL AND
          author_user_id IS NULL
        ) OR (
          author_kind = 'site_user' AND
          author_identity_issuer = 'zeropress:studio' AND
          author_user_id IS NOT NULL AND
          author_user_id = trim(author_user_id) AND
          length(author_user_id) > 0
        ) OR (
          author_kind = 'authenticated_user' AND
          author_identity_issuer IS NOT NULL AND
          author_identity_issuer = trim(author_identity_issuer) AND
          substr(author_identity_issuer, -8) = '/auth/v1' AND
          (
            substr(author_identity_issuer, 1, 8) = 'https://' OR
            author_identity_issuer LIKE 'http://localhost%/auth/v1' OR
            author_identity_issuer LIKE 'http://127.0.0.1%/auth/v1' OR
            author_identity_issuer LIKE 'http://[::1]%/auth/v1'
          ) AND
          author_user_id IS NOT NULL AND
          author_user_id = trim(author_user_id) AND
          length(author_user_id) > 0
        )
      )
    )
);

CREATE INDEX idx_comments_target_status_public
ON comments(target_id, status, public_id);

CREATE INDEX idx_comments_target_parent
ON comments(target_id, parent_public_id);

CREATE INDEX idx_comments_ip_address_recorded_at
ON comments(ip_address_recorded_at)
WHERE ip_address IS NOT NULL
  AND ip_address_recorded_at IS NOT NULL;

CREATE INDEX idx_comments_pending
ON comments(status)
WHERE status = 'pending';

-- Table: forms
CREATE TABLE forms (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'disabled', 'archived')),
  submit_label TEXT NOT NULL DEFAULT 'Submit',
  success_message TEXT,
  notification_recipient_user_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Table: form_fields
CREATE TABLE form_fields (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  form_id TEXT NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  field_key TEXT NOT NULL,
  label TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('text', 'textarea', 'email', 'number', 'date', 'select', 'radio', 'checkbox', 'phone')),
  required INTEGER NOT NULL DEFAULT 0 CHECK (required IN (0, 1)),
  placeholder TEXT,
  help_text TEXT,
  options_json TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  UNIQUE (form_id, field_key)
);

CREATE INDEX idx_form_fields_form_order
ON form_fields(form_id, sort_order);

-- Table: form_submissions
CREATE TABLE form_submissions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  form_id TEXT NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'unread' CHECK (status IN ('unread', 'read', 'archived', 'spam')),
  summary TEXT,
  submitter_email TEXT,
  submitter_name TEXT,
  source_url TEXT,
  ip_address TEXT,
  ip_address_recorded_at TEXT,
  ip_hash TEXT,
  user_agent TEXT,
  asn INTEGER,
  as_organization TEXT,
  country_code TEXT,
  submitted_at TEXT NOT NULL,
  read_at TEXT,
  archived_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  CONSTRAINT chk_form_submissions_ip_address_recorded_at
    CHECK (ip_address IS NULL OR ip_address_recorded_at IS NOT NULL)
);

CREATE INDEX idx_form_submissions_form_status_submitted
ON form_submissions(form_id, status, submitted_at DESC);

CREATE INDEX idx_form_submissions_ip_address_recorded_at
ON form_submissions(ip_address_recorded_at)
WHERE ip_address IS NOT NULL
  AND ip_address_recorded_at IS NOT NULL;

CREATE INDEX idx_form_submissions_unread
ON form_submissions(status)
WHERE status = 'unread';

-- Table: form_submission_values
CREATE TABLE form_submission_values (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  submission_id TEXT NOT NULL REFERENCES form_submissions(id) ON DELETE CASCADE,
  field_id TEXT REFERENCES form_fields(id) ON DELETE SET NULL,
  field_key TEXT NOT NULL,
  field_label TEXT NOT NULL,
  field_type TEXT NOT NULL,
  field_value TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_form_submission_values_submission
ON form_submission_values(submission_id);

-- Table: newsletter_lists
CREATE TABLE newsletter_lists (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  slug TEXT NOT NULL UNIQUE CHECK (slug = lower(slug) AND slug <> ''),
  title TEXT NOT NULL CHECK (title <> ''),
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Table: newsletter_fields
CREATE TABLE newsletter_fields (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  newsletter_id TEXT NOT NULL REFERENCES newsletter_lists(id) ON DELETE CASCADE,
  field_key TEXT NOT NULL CHECK (field_key = lower(field_key) AND field_key <> ''),
  label TEXT NOT NULL CHECK (label <> ''),
  type TEXT NOT NULL CHECK (type IN ('text', 'textarea', 'number', 'url', 'boolean', 'select', 'radio', 'checkbox')),
  required INTEGER NOT NULL DEFAULT 0 CHECK (required IN (0, 1)),
  options_json TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  UNIQUE (newsletter_id, field_key)
);

CREATE INDEX idx_newsletter_fields_newsletter_status_sort_order
ON newsletter_fields(newsletter_id, status, sort_order);

-- Table: newsletter_subscribers
CREATE TABLE newsletter_subscribers (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  email TEXT NOT NULL UNIQUE CHECK (email = lower(email) AND email <> ''),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Table: newsletter_subscriptions
CREATE TABLE newsletter_subscriptions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  newsletter_id TEXT NOT NULL REFERENCES newsletter_lists(id) ON DELETE CASCADE,
  subscriber_id TEXT NOT NULL REFERENCES newsletter_subscribers(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'subscribed', 'unsubscribed')),
  confirm_token_hash TEXT,
  confirm_expires_at TEXT,
  confirm_sent_at TEXT,
  confirm_email_status TEXT NOT NULL DEFAULT 'not_sent' CHECK (confirm_email_status IN ('not_sent', 'sent', 'failed')),
  confirm_email_error TEXT,
  confirmed_at TEXT,
  subscribed_at TEXT,
  unsubscribed_at TEXT,
  source_url TEXT,
  ip_address TEXT,
  ip_address_recorded_at TEXT,
  ip_hash TEXT,
  user_agent TEXT,
  asn INTEGER,
  as_organization TEXT,
  country_code TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  UNIQUE (newsletter_id, subscriber_id),
  CONSTRAINT chk_newsletter_subscriptions_ip_address_recorded_at
    CHECK (ip_address IS NULL OR ip_address_recorded_at IS NOT NULL)
);

CREATE INDEX idx_newsletter_subscriptions_newsletter_status
ON newsletter_subscriptions(newsletter_id, status);

CREATE INDEX idx_newsletter_subscriptions_newsletter_created_at_id
ON newsletter_subscriptions(newsletter_id, created_at DESC, id DESC);

CREATE INDEX idx_newsletter_subscriptions_newsletter_status_created_at_id
ON newsletter_subscriptions(newsletter_id, status, created_at DESC, id DESC);

CREATE INDEX idx_newsletter_subscriptions_subscriber_status
ON newsletter_subscriptions(subscriber_id, status);

CREATE INDEX idx_newsletter_subscriptions_confirm_token
ON newsletter_subscriptions(confirm_token_hash)
WHERE confirm_token_hash IS NOT NULL;

CREATE INDEX idx_newsletter_subscriptions_ip_address_recorded_at
ON newsletter_subscriptions(ip_address_recorded_at)
WHERE ip_address IS NOT NULL
  AND ip_address_recorded_at IS NOT NULL;

CREATE INDEX idx_newsletter_subscriptions_pending
ON newsletter_subscriptions(status)
WHERE status = 'pending';

-- Table: newsletter_deliveries
CREATE TABLE newsletter_deliveries (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  newsletter_id TEXT NOT NULL REFERENCES newsletter_lists(id) ON DELETE CASCADE,
  subscription_id TEXT NOT NULL REFERENCES newsletter_subscriptions(id) ON DELETE CASCADE,
  delivery_type TEXT NOT NULL
    CHECK (delivery_type IN ('confirmation', 'post_notification')),
  content_id TEXT,
  idempotency_key TEXT NOT NULL UNIQUE
    CHECK (length(idempotency_key) BETWEEN 1 AND 255),
  subject TEXT,
  provider TEXT CHECK (provider IS NULL OR provider IN ('resend', 'cloudflare')),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'sent', 'failed', 'skipped')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  failure_code TEXT CHECK (failure_code IS NULL OR length(failure_code) <= 100),
  queued_at TEXT NOT NULL,
  last_attempt_at TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CONSTRAINT chk_newsletter_deliveries_content
    CHECK (
      (delivery_type = 'confirmation' AND content_id IS NULL) OR
      (delivery_type = 'post_notification' AND content_id IS NOT NULL)
    ),
  CONSTRAINT chk_newsletter_deliveries_sent_at
    CHECK (
      (status = 'sent' AND sent_at IS NOT NULL) OR
      (status <> 'sent' AND sent_at IS NULL)
    )
);

CREATE INDEX idx_newsletter_deliveries_newsletter_created_at_id
ON newsletter_deliveries(newsletter_id, created_at DESC, id DESC);

CREATE INDEX idx_newsletter_deliveries_newsletter_status_created_at_id
ON newsletter_deliveries(newsletter_id, status, created_at DESC, id DESC);

CREATE INDEX idx_newsletter_deliveries_subscription_created_at_id
ON newsletter_deliveries(subscription_id, created_at DESC, id DESC);

-- Table: newsletter_field_values
CREATE TABLE newsletter_field_values (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  subscription_id TEXT NOT NULL REFERENCES newsletter_subscriptions(id) ON DELETE CASCADE,
  field_id TEXT NOT NULL REFERENCES newsletter_fields(id) ON DELETE CASCADE,
  field_value TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  UNIQUE (subscription_id, field_id)
);

CREATE INDEX idx_newsletter_field_values_field_id
ON newsletter_field_values(field_id);

-- Table: newsletter_suppressions
CREATE TABLE newsletter_suppressions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  email TEXT NOT NULL UNIQUE CHECK (email = lower(email) AND email <> ''),
  reason TEXT NOT NULL CHECK (reason IN ('bounce', 'complaint', 'manual', 'invalid')),
  source TEXT NOT NULL DEFAULT 'manual',
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_newsletter_suppressions_created_at_id
ON newsletter_suppressions(created_at DESC, id DESC);

CREATE INDEX idx_newsletter_suppressions_reason_created_at_id
ON newsletter_suppressions(reason, created_at DESC, id DESC);
