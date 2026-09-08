import type { Env } from '../env';
import { createId } from '../id';
import type { FormField, FormRecord, FormSubmissionValueInput } from './types';
import {
  assertEdgeDatabaseReady,
  EDGE_DATABASE_LIFECYCLE_SELECT,
  type EdgeDatabaseLifecycleRow,
} from '../database-lifecycle';

export async function getActiveFormBySlug(env: Env, slug: string): Promise<FormRecord | null> {
  const row = await env.EDGE_DB.prepare(
    `SELECT ${EDGE_DATABASE_LIFECYCLE_SELECT},
            f.id, f.slug, f.title, f.description, f.status,
            f.submit_label, f.success_message,
            f.notification_recipient_user_id
     FROM zeropress_edge_schema_state AS edge_schema
     LEFT JOIN forms AS f ON f.slug = ? AND f.status = 'active'
     WHERE edge_schema.id = 1
     LIMIT 1`
  )
    .bind(slug)
    .first<FormRecord & EdgeDatabaseLifecycleRow>();

  assertEdgeDatabaseReady(row);
  return row?.id ? row : null;
}

export async function getActiveFormFields(env: Env, formId: string): Promise<FormField[]> {
  const { results } = await env.EDGE_DB.prepare(
    `SELECT id,
            form_id,
            field_key,
            label,
            type,
            required,
            placeholder,
            help_text,
            options_json,
            sort_order,
            status
     FROM form_fields
     WHERE form_id = ? AND status = 'active'
     ORDER BY sort_order ASC, field_key ASC`
  )
    .bind(formId)
    .all<FormField>();

  return results ?? [];
}

export async function insertFormSubmission(
  env: Env,
  input: {
    formId: string;
    summary: string | null;
    submitterEmail: string | null;
    submitterName: string | null;
    sourceUrl: string | null;
    ipAddress: string | null;
    ipHash: string | null;
    asn: number | null;
    asOrganization: string | null;
    countryCode: string | null;
    userAgent: string | null;
    values: FormSubmissionValueInput[];
    now: string;
  },
): Promise<{ id: string }> {
  const submissionId = createId();
  const statements: D1PreparedStatement[] = [
    env.EDGE_DB.prepare(
      `INSERT INTO form_submissions (
         id,
         form_id,
         status,
         summary,
         submitter_email,
         submitter_name,
         source_url,
         ip_address,
         ip_address_recorded_at,
         ip_hash,
         asn,
         as_organization,
         country_code,
         user_agent,
         submitted_at,
         created_at,
         updated_at
       )
       VALUES (?, ?, 'unread', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        submissionId,
        input.formId,
        input.summary,
        input.submitterEmail,
        input.submitterName,
        input.sourceUrl,
        input.ipAddress,
        input.now,
        input.ipHash,
        input.asn,
        input.asOrganization,
        input.countryCode,
        input.userAgent,
        input.now,
        input.now,
        input.now,
      ),
  ];

  for (const value of input.values) {
    statements.push(env.EDGE_DB.prepare(
      `INSERT INTO form_submission_values (
         id,
         submission_id,
         field_id,
         field_key,
         field_label,
         field_type,
         field_value,
         created_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        createId(),
        submissionId,
        value.fieldId,
        value.fieldKey,
        value.fieldLabel,
        value.fieldType,
        value.value,
        input.now,
      ));
  }

  await env.EDGE_DB.batch(statements);
  return { id: submissionId };
}
