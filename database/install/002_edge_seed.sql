-- ZeroPress Edge fresh-install seed. The schema lifecycle row is deliberately
-- last so a successful atomic install always finishes in schema v1 `ready`.

INSERT INTO edge_comment_settings (id)
SELECT 1
WHERE NOT EXISTS (
  SELECT 1 FROM edge_comment_settings WHERE id = 1
);

INSERT INTO edge_mail_settings (id)
SELECT 1
WHERE NOT EXISTS (
  SELECT 1 FROM edge_mail_settings WHERE id = 1
);

INSERT INTO edge_runtime_settings (id)
SELECT 1
WHERE NOT EXISTS (
  SELECT 1 FROM edge_runtime_settings WHERE id = 1
);

INSERT INTO newsletter_lists (slug, title, status)
SELECT 'default', 'Newsletter', 'archived'
WHERE NOT EXISTS (
  SELECT 1 FROM newsletter_lists WHERE slug = 'default'
);

INSERT INTO zeropress_edge_schema_state (
  id,
  schema_version,
  lifecycle_state,
  target_schema_version,
  active_operation_id,
  updated_at_iso
)
VALUES (
  1,
  1,
  'ready',
  NULL,
  NULL,
  strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
);
