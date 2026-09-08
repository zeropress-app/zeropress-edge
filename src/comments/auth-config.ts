import type { Env } from '../env';
import { getLogErrorMessage, logWarn } from '../log';
import {
  assertEdgeDatabaseReady,
  EDGE_DATABASE_LIFECYCLE_SELECT,
  rethrowEdgeDatabaseLifecycleQueryFailure,
  type EdgeDatabaseLifecycleRow,
} from '../database-lifecycle';

const SUPABASE_PUBLISHABLE_KEY_PATTERN = /^sb_publishable_[A-Za-z0-9._-]{16,512}$/;

export type CommentAuthSettingsRow = EdgeDatabaseLifecycleRow & {
  auth_enabled: number | boolean | null;
  supabase_project_url: string | null;
  supabase_publishable_key: string | null;
};

export type DisabledCommentAuthConfig = {
  enabled: false;
  provider: 'supabase';
  mode: 'optional';
  projectUrl: string | null;
  publishableKey: string | null;
  issuer: string | null;
};

export type EnabledCommentAuthConfig = {
  enabled: true;
  provider: 'supabase';
  mode: 'optional';
  projectUrl: string;
  publishableKey: string;
  issuer: string;
};

export type CommentAuthConfig = DisabledCommentAuthConfig | EnabledCommentAuthConfig;

export type CommentAuthConfigResult =
  | { ok: true; config: CommentAuthConfig }
  | { ok: false; reason: 'missing_settings' | 'invalid_settings' | 'query_failed' };

export async function getCommentAuthConfig(env: Env): Promise<CommentAuthConfigResult> {
  let row: CommentAuthSettingsRow | null;
  try {
    row = await env.EDGE_DB.prepare(
      `SELECT
         ${EDGE_DATABASE_LIFECYCLE_SELECT},
         c.auth_enabled,
         supabase_project_url,
         supabase_publishable_key
       FROM zeropress_edge_schema_state AS edge_schema
       LEFT JOIN edge_comment_settings AS c ON c.id = 1
       WHERE edge_schema.id = 1
       LIMIT 1`,
    ).first<CommentAuthSettingsRow>();
    assertEdgeDatabaseReady(row);
  } catch (error) {
    rethrowEdgeDatabaseLifecycleQueryFailure(error);
    logWarn('Comment authentication settings are unavailable', {
      code: 'COMMENT_AUTH_SETTINGS_NOT_AVAILABLE',
      reason: 'query_failed',
      errorMessage: getLogErrorMessage(error),
      guidance: 'Use Studio Maintenance & Recovery to inspect EDGE_DB and verify the comment-auth singleton.',
    });
    return { ok: false, reason: 'query_failed' };
  }

  return parseCommentAuthConfig(row);
}

export function parseCommentAuthConfig(
  row: CommentAuthSettingsRow | null | undefined,
): CommentAuthConfigResult {
  if (!row) {
    return { ok: false, reason: 'missing_settings' };
  }

  const enabled = parseStoredBoolean(row.auth_enabled);
  if (enabled === null) {
    return { ok: false, reason: 'invalid_settings' };
  }

  const hasProjectUrl = row.supabase_project_url !== null;
  const hasPublishableKey = row.supabase_publishable_key !== null;
  if (hasProjectUrl !== hasPublishableKey) {
    return { ok: false, reason: 'invalid_settings' };
  }

  if (!hasProjectUrl || !hasPublishableKey) {
    return enabled
      ? { ok: false, reason: 'invalid_settings' }
      : {
          ok: true,
          config: {
            enabled: false,
            provider: 'supabase',
            mode: 'optional',
            projectUrl: null,
            publishableKey: null,
            issuer: null,
          },
        };
  }

  const projectUrl = normalizeSupabaseProjectUrl(row.supabase_project_url);
  const publishableKey = normalizeSupabasePublishableKey(row.supabase_publishable_key);
  if (!projectUrl || !publishableKey) {
    return { ok: false, reason: 'invalid_settings' };
  }

  const common = {
    provider: 'supabase' as const,
    mode: 'optional' as const,
    projectUrl,
    publishableKey,
    issuer: `${projectUrl}/auth/v1`,
  };
  return enabled
    ? { ok: true, config: { enabled: true, ...common } }
    : { ok: true, config: { enabled: false, ...common } };
}

export function normalizeSupabaseProjectUrl(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    value === '' ||
    value !== value.trim() ||
    /[\u0000-\u0020\u007f\\]/.test(value)
  ) {
    return null;
  }

  try {
    const url = new URL(value);
    const isLocalHttp = url.protocol === 'http:' && (
      url.hostname === 'localhost' ||
      url.hostname === '127.0.0.1' ||
      url.hostname === '[::1]'
    );
    if (
      (url.protocol !== 'https:' && !isLocalHttp) ||
      url.username !== '' ||
      url.password !== '' ||
      url.pathname !== '/' ||
      url.search !== '' ||
      url.hash !== '' ||
      url.origin === 'null'
    ) {
      return null;
    }

    return url.origin;
  } catch {
    return null;
  }
}

export function normalizeSupabasePublishableKey(value: unknown): string | null {
  if (typeof value !== 'string' || value !== value.trim()) {
    return null;
  }
  return SUPABASE_PUBLISHABLE_KEY_PATTERN.test(value) ? value : null;
}

function parseStoredBoolean(value: number | boolean | null): boolean | null {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  return null;
}
