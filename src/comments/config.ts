import type { Env } from '../env';
import {
  EDGE_RUNTIME_SETTINGS_NOT_AVAILABLE,
  logEdgeRuntimeSettingsUnavailable,
  parseEdgeRuntimeSettingsRow,
  type EdgeRuntimeSettings,
  type EdgeRuntimeSettingsResult,
  type EdgeRuntimeSettingsRow,
  type EdgeRuntimeSettingsUnavailableResult,
} from '../runtime-settings';
import type { CommentRuntimeConfig } from './types';
import {
  parseCommentAuthConfig,
  type CommentAuthConfigResult,
  type CommentAuthSettingsRow,
} from './auth-config';
import {
  parseCommentRequestSecretsSetting,
  type CommentRequestSecrets,
} from './token';
import {
  assertEdgeDatabaseReady,
  EDGE_DATABASE_LIFECYCLE_SELECT,
  rethrowEdgeDatabaseLifecycleQueryFailure,
  type EdgeDatabaseLifecycleRow,
} from '../database-lifecycle';

const DEFAULT_COMMENTS_PER_PAGE = 50;
const MAX_COMMENTS_PER_PAGE = 100;
export const COMMENTS_CACHE_LIFETIME_SECONDS = 300;
const DEFAULT_THREAD_COMMENTS_DEPTH = 2;

type EdgeCommentSettingsRow = EdgeDatabaseLifecycleRow & {
  api_base_url: string | null;
  comments_enabled: number | boolean | null;
  require_approval: number | boolean | null;
  per_page: number | string | null;
  sort_order: string | null;
  thread_comments: number | boolean | null;
  thread_comments_depth: number | string | null;
  request_secrets_json: unknown;
};

type CommentWriteContextRow = EdgeCommentSettingsRow & EdgeRuntimeSettingsRow & CommentAuthSettingsRow;

export type CommentReadContext = {
  config: CommentRuntimeConfig;
  requestSecrets: CommentRequestSecrets | null;
};

export type CommentWriteContext = CommentReadContext & {
  runtimeSettings: EdgeRuntimeSettings;
  authConfigResult: CommentAuthConfigResult;
};

export type CommentWriteContextResult =
  | { ok: true; context: CommentWriteContext }
  | Exclude<EdgeRuntimeSettingsResult, { ok: true }>;

export async function getCommentReadContext(env: Env): Promise<CommentReadContext> {
  const row = await env.EDGE_DB.prepare(
    `SELECT
       ${EDGE_DATABASE_LIFECYCLE_SELECT},
       c.comments_enabled,
       api_base_url,
       require_approval,
       per_page,
       sort_order,
       thread_comments,
       thread_comments_depth,
       request_secrets_json
     FROM zeropress_edge_schema_state AS edge_schema
     LEFT JOIN edge_comment_settings AS c ON c.id = 1
     WHERE edge_schema.id = 1
     LIMIT 1`
  ).first<EdgeCommentSettingsRow>();
  assertEdgeDatabaseReady(row);
  return createCommentReadContext(row);
}

export async function getCommentWriteContext(env: Env): Promise<CommentWriteContextResult> {
  let row: CommentWriteContextRow | null;
  try {
    row = await env.EDGE_DB.prepare(
      `SELECT
       ${EDGE_DATABASE_LIFECYCLE_SELECT},
       c.comments_enabled,
       c.api_base_url,
       c.require_approval,
       c.per_page,
       c.sort_order,
       c.thread_comments,
       c.thread_comments_depth,
       c.request_secrets_json,
       c.auth_enabled,
       c.supabase_project_url,
       c.supabase_publishable_key,
       r.id AS runtime_settings_id,
       r.comment_write_verification_mode,
       r.newsletter_subscribe_verification_mode,
       r.form_submit_verification_mode,
       r.turnstile_sitekey,
       r.ip_address_retention_days
     FROM zeropress_edge_schema_state AS edge_schema
     LEFT JOIN edge_runtime_settings AS r ON r.id = 1
     LEFT JOIN edge_comment_settings AS c ON c.id = 1
     WHERE edge_schema.id = 1
     LIMIT 1`
    ).first<CommentWriteContextRow>();
    assertEdgeDatabaseReady(row);
  } catch (error) {
    rethrowEdgeDatabaseLifecycleQueryFailure(error);
    const queryFailure: EdgeRuntimeSettingsUnavailableResult = {
      ok: false,
      code: EDGE_RUNTIME_SETTINGS_NOT_AVAILABLE,
      message: 'Edge runtime settings are temporarily unavailable.',
      reason: 'query_failed' as const,
    };
    logEdgeRuntimeSettingsUnavailable(queryFailure, error);
    return queryFailure;
  }

  const runtimeSettingsResult = parseEdgeRuntimeSettingsRow(row);
  if (!runtimeSettingsResult.ok) {
    logEdgeRuntimeSettingsUnavailable(runtimeSettingsResult);
    return runtimeSettingsResult;
  }

  return {
    ok: true,
    context: {
      ...createCommentReadContext(row),
      runtimeSettings: runtimeSettingsResult.settings,
      authConfigResult: parseCommentAuthConfig({
        auth_enabled: row?.auth_enabled ?? null,
        supabase_project_url: row?.supabase_project_url ?? null,
        supabase_publishable_key: row?.supabase_publishable_key ?? null,
      }),
    },
  };
}

function createCommentReadContext(row: EdgeCommentSettingsRow | null | undefined): CommentReadContext {
  return {
    config: {
      disallowComments: !toBoolean(row?.comments_enabled, true),
      requireCommentApproval: toBoolean(row?.require_approval, true),
      perPage: toIntegerInRange(row?.per_page, DEFAULT_COMMENTS_PER_PAGE, 1, MAX_COMMENTS_PER_PAGE),
      order: row?.sort_order === 'asc' ? 'asc' : 'desc',
      threadComments: toBoolean(row?.thread_comments, true),
      threadCommentsDepth: toIntegerInRange(row?.thread_comments_depth, DEFAULT_THREAD_COMMENTS_DEPTH, 2, 10),
      cacheTtlSeconds: COMMENTS_CACHE_LIFETIME_SECONDS,
      apiBaseUrl: normalizeApiBaseUrl(row?.api_base_url),
    },
    requestSecrets: parseCommentRequestSecretsSetting(row?.request_secrets_json),
  };
}

function normalizeApiBaseUrl(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || value !== value.trim() || value === '') return null;
  if (/[\u0000-\u0020\u007f\\?#]/.test(value) || value.startsWith('//')) return null;

  try {
    decodeURIComponent(value);
  } catch {
    return null;
  }

  if (value.startsWith('/')) {
    return value === '/' ? '/' : value.replace(/\/+$/, '');
  }

  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      return null;
    }
    return value.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

function toBoolean(value: number | boolean | null | undefined, defaultValue: boolean): boolean {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  return defaultValue;
}

function toIntegerInRange(
  value: number | string | null | undefined,
  defaultValue: number,
  min: number,
  max: number,
): number {
  const numberValue = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d+$/.test(value.trim())
      ? Number.parseInt(value.trim(), 10)
      : defaultValue;

  if (!Number.isInteger(numberValue)) return defaultValue;
  return Math.min(max, Math.max(min, numberValue));
}
