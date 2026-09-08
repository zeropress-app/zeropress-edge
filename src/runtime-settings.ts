import type { Env } from './env';
import { getLogErrorMessage, logWarn } from './log';
import {
  assertEdgeDatabaseReady,
  EDGE_DATABASE_LIFECYCLE_SELECT,
  rethrowEdgeDatabaseLifecycleQueryFailure,
  type EdgeDatabaseLifecycleRow,
} from './database-lifecycle';

export const EDGE_RUNTIME_SETTINGS_NOT_AVAILABLE = 'EDGE_RUNTIME_SETTINGS_NOT_AVAILABLE';

export type WriteVerificationMode = 'pow' | 'turnstile';

export type EdgeRuntimeSettings = {
  commentWriteVerificationMode: WriteVerificationMode;
  newsletterSubscribeVerificationMode: WriteVerificationMode;
  formSubmitVerificationMode: WriteVerificationMode;
  turnstileSitekey: string | null;
  ipAddressRetentionDays: number;
};

export type EdgeRuntimeSettingsRow = EdgeDatabaseLifecycleRow & {
  runtime_settings_id: unknown;
  comment_write_verification_mode: unknown;
  newsletter_subscribe_verification_mode: unknown;
  form_submit_verification_mode: unknown;
  turnstile_sitekey: unknown;
  ip_address_retention_days: unknown;
};

export type EdgeRuntimeSettingsUnavailableResult = {
  ok: false;
  code: typeof EDGE_RUNTIME_SETTINGS_NOT_AVAILABLE;
  message: string;
  reason: 'query_failed' | 'missing_row' | 'invalid_row';
  invalidFields?: string[];
};

export type EdgeRuntimeSettingsResult =
  | { ok: true; settings: EdgeRuntimeSettings }
  | EdgeRuntimeSettingsUnavailableResult;

const EDGE_RUNTIME_SETTINGS_SELECT = `SELECT
   ${EDGE_DATABASE_LIFECYCLE_SELECT},
   r.id AS runtime_settings_id,
   comment_write_verification_mode,
   newsletter_subscribe_verification_mode,
   form_submit_verification_mode,
   turnstile_sitekey,
   ip_address_retention_days
 FROM zeropress_edge_schema_state AS edge_schema
 LEFT JOIN edge_runtime_settings AS r ON r.id = 1
 WHERE edge_schema.id = 1
 LIMIT 1`;

export async function getEdgeRuntimeSettings(env: Pick<Env, 'EDGE_DB'>): Promise<EdgeRuntimeSettingsResult> {
  try {
    const row = await env.EDGE_DB.prepare(EDGE_RUNTIME_SETTINGS_SELECT).first<EdgeRuntimeSettingsRow>();
    assertEdgeDatabaseReady(row);
    const result = parseEdgeRuntimeSettingsRow(row);
    if (!result.ok) {
      logEdgeRuntimeSettingsUnavailable(result);
    }
    return result;
  } catch (error) {
    rethrowEdgeDatabaseLifecycleQueryFailure(error);
    const result = edgeRuntimeSettingsUnavailable('query_failed');
    logEdgeRuntimeSettingsUnavailable(result, error);
    return result;
  }
}

export function parseEdgeRuntimeSettingsRow(
  row: EdgeRuntimeSettingsRow | null | undefined,
): EdgeRuntimeSettingsResult {
  if (!row) {
    return edgeRuntimeSettingsUnavailable('missing_row');
  }
  if (row.runtime_settings_id === null || row.runtime_settings_id === undefined) {
    return edgeRuntimeSettingsUnavailable('missing_row');
  }

  const invalidFields: string[] = [];
  if (row.runtime_settings_id !== 1) {
    invalidFields.push('id');
  }
  if (!isWriteVerificationMode(row.comment_write_verification_mode)) {
    invalidFields.push('comment_write_verification_mode');
  }
  if (!isWriteVerificationMode(row.newsletter_subscribe_verification_mode)) {
    invalidFields.push('newsletter_subscribe_verification_mode');
  }
  if (!isWriteVerificationMode(row.form_submit_verification_mode)) {
    invalidFields.push('form_submit_verification_mode');
  }
  if (!isTurnstileSitekey(row.turnstile_sitekey)) {
    invalidFields.push('turnstile_sitekey');
  }
  if (
    row.turnstile_sitekey === null &&
    [
      row.comment_write_verification_mode,
      row.newsletter_subscribe_verification_mode,
      row.form_submit_verification_mode,
    ].includes('turnstile') &&
    !invalidFields.includes('turnstile_sitekey')
  ) {
    invalidFields.push('turnstile_sitekey');
  }
  if (!isRetentionDays(row.ip_address_retention_days)) {
    invalidFields.push('ip_address_retention_days');
  }

  if (invalidFields.length > 0) {
    return edgeRuntimeSettingsUnavailable('invalid_row', invalidFields);
  }

  return {
    ok: true,
    settings: {
      commentWriteVerificationMode: row.comment_write_verification_mode as WriteVerificationMode,
      newsletterSubscribeVerificationMode: row.newsletter_subscribe_verification_mode as WriteVerificationMode,
      formSubmitVerificationMode: row.form_submit_verification_mode as WriteVerificationMode,
      turnstileSitekey: row.turnstile_sitekey as string | null,
      ipAddressRetentionDays: row.ip_address_retention_days as number,
    },
  };
}

export function logEdgeRuntimeSettingsUnavailable(
  result: EdgeRuntimeSettingsUnavailableResult,
  error?: unknown,
): void {
  logWarn('Edge runtime settings are unavailable', {
    code: result.code,
    table: 'edge_runtime_settings',
    reason: result.reason,
    invalidFields: result.invalidFields,
    errorMessage: error === undefined ? undefined : getLogErrorMessage(error),
    guidance: 'Use Studio Maintenance & Recovery to inspect EDGE_DB and repair the id=1 runtime settings row.',
  });
}

function edgeRuntimeSettingsUnavailable(
  reason: EdgeRuntimeSettingsUnavailableResult['reason'],
  invalidFields?: string[],
): EdgeRuntimeSettingsUnavailableResult {
  return {
    ok: false,
    code: EDGE_RUNTIME_SETTINGS_NOT_AVAILABLE,
    message: 'Edge runtime settings are temporarily unavailable.',
    reason,
    ...(invalidFields ? { invalidFields } : {}),
  };
}

function isWriteVerificationMode(value: unknown): value is WriteVerificationMode {
  return value === 'pow' || value === 'turnstile';
}

function isTurnstileSitekey(value: unknown): value is string | null {
  return value === null || (
    typeof value === 'string' &&
    value !== '' &&
    value.length <= 256 &&
    value.trim() === value
  );
}

function isRetentionDays(value: unknown): value is number {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 365;
}
