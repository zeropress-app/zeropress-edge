-- ZeroPress Edge uninstall artifact. This is not a Wrangler migration and
-- must only be executed by the reviewed Studio Edge database lifecycle runner.
-- The Cloudflare D1 resource and its binding are deliberately preserved.

DROP TABLE form_submission_values;
DROP TABLE form_submissions;
DROP TABLE form_fields;
DROP TABLE forms;

DROP TABLE newsletter_field_values;
DROP TABLE newsletter_deliveries;
DROP TABLE newsletter_subscriptions;
DROP TABLE newsletter_fields;
DROP TABLE newsletter_subscribers;
DROP TABLE newsletter_suppressions;
DROP TABLE newsletter_lists;

DROP TABLE comments;
DROP TABLE edge_comment_targets;

DROP TABLE edge_mail_settings;
DROP TABLE edge_runtime_settings;
DROP TABLE edge_comment_settings;

-- Keep the lifecycle authority last so a committed batch is classified as
-- uninstalled and an interrupted pre-commit batch remains fully managed.
DROP TABLE zeropress_edge_schema_state;
