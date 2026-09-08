import { vi } from 'vitest';
import { type Env } from './index';

export const ZP_NATIVE_PUBLIC_ID_BASE = 100_000_000_000;
export const TEST_EDGE_TOKEN_SIGNING_SECRET = 'test-only-edge-signing-secret-'.repeat(3);
export const TEST_IP_HASH_SECRET = 'test-only-ip-hash-secret-'.repeat(3);
export const TEST_COMMENT_REQUEST_TOKEN = 'k_AAAAAAAAAAAAAAAAAAAAAA.wy-nh0myRz80TywHrc3Rlwy4x45YhqFm_jEFb5hN6SM';
export const TEST_PREVIOUS_COMMENT_REQUEST_TOKEN = 'k_BBBBBBBBBBBBBBBBBBBBBB.4wR1J20rYCwb93aH0q3ElneEF9wV14xGKiZ8wjhYLlw';
export const TEST_READ_CHALLENGE_TOKEN = 'c3.eyJ2IjoyLCJ0eXAiOiJjb21tZW50X2NoYWxsZW5nZSIsInRhcmdldF90eXBlIjoicG9zdCIsInRhcmdldF9wdWJsaWNfaWQiOjEwMSwidGFyZ2V0X25vbmNlIjoidGFyZ2V0LW5vbmNlLXBvc3QtMTAxIiwic2NvcGUiOiJyZWFkIiwiaWF0IjowLCJleHAiOjMyNTAzNjgwMDAwLCJub25jZSI6InRlc3QtcmVhZCIsImRpZmZpY3VsdHkiOjB9.MEG7cW0IbpqqDlSEXafYHcmgkbrZYk5goCD0K1wXL8E';
export const TEST_WRITE_CHALLENGE_TOKEN = 'c3.eyJ2IjoyLCJ0eXAiOiJjb21tZW50X2NoYWxsZW5nZSIsInRhcmdldF90eXBlIjoicG9zdCIsInRhcmdldF9wdWJsaWNfaWQiOjEwMSwidGFyZ2V0X25vbmNlIjoidGFyZ2V0LW5vbmNlLXBvc3QtMTAxIiwic2NvcGUiOiJ3cml0ZSIsImlhdCI6MCwiZXhwIjozMjUwMzY4MDAwMCwibm9uY2UiOiJ0ZXN0LXdyaXRlIiwiZGlmZmljdWx0eSI6MH0.g4CWseNf--gRycdqjC1YO9-dQELNF_Tm37ANDv09Mcg';
export const TEST_CHALLENGE_SOLUTION = '0';

export function commentsUrl(query = 'post=101'): string {
  const params = new URLSearchParams(query);
  const post = params.get('post') || '101';
  params.delete('post');
  params.set('comment_request_token', TEST_COMMENT_REQUEST_TOKEN);
  params.set('comment_challenge_token', TEST_READ_CHALLENGE_TOKEN);
  params.set('comment_challenge_solution', TEST_CHALLENGE_SOLUTION);
  return `https://example.com/api/posts/${encodeURIComponent(post)}/comments?${params.toString()}`;
}

export function commentWriteChallengeFields() {
  return {
    comment_challenge_token: TEST_WRITE_CHALLENGE_TOKEN,
    comment_challenge_solution: TEST_CHALLENGE_SOLUTION,
  };
}

export function commentPostUrl(): string {
  return 'https://example.com/api/posts/101/comments';
}

export function commentRequestSecretsSetting(options?: {
  previousExpiresAt?: string;
}): MockSetting {
  return {
    type: 'json',
    value: JSON.stringify({
      version: 1,
      current: {
        kid: 'k_AAAAAAAAAAAAAAAAAAAAAA',
        secret: 'test-comment-secret',
        created_at: '2026-06-27T10:20:30Z',
      },
      previous: [
        {
          kid: 'k_BBBBBBBBBBBBBBBBBBBBBB',
          secret: 'previous-secret',
          created_at: '2026-06-26T10:20:30Z',
          expires_at: options?.previousExpiresAt ?? '2999-01-01T00:00:00Z',
        },
      ],
    }),
  };
}

export type MockComment = {
  id: string;
  public_id: number;
  target_id?: number;
  parent_public_id?: number | null;
  author_name: string;
  author_kind?: 'guest' | 'site_user' | 'authenticated_user';
  author_email?: string;
  author_identity_issuer?: string | null;
  author_user_id?: string | null;
  content: string;
  status?: string;
  imported?: number | boolean | null;
  created_at: string;
  parent_id?: string | null;
};

export type MockSetting = {
  value: string | null;
  type: string;
};

export function createMockEnv(options?: {
  post?: {
    id: string;
    public_id: number;
    status: string;
    allow_comments: number;
    target_type?: 'post' | 'page';
    request_token_nonce?: string;
    comments_cache_revision?: string;
  } | null;
  targets?: Array<{
    id: string;
    public_id: number;
    status: string;
    allow_comments: number;
    target_type: 'post' | 'page';
    request_token_nonce?: string;
    comments_cache_revision?: string;
  }>;
  comments?: MockComment[];
  settings?: Record<string, MockSetting>;
  kvValue?: string | null;
  allowedOrigins?: string;
  readRateLimitSuccess?: boolean;
  rateLimitSuccess?: boolean;
  identityRateLimitSuccess?: boolean;
  challengeRateLimitSuccess?: boolean;
  turnstileRateLimitSuccess?: boolean;
  writeVerificationMode?: string;
  turnstileSiteKey?: string | null;
  runtimeSettingsAvailable?: boolean;
  turnstileSecretKey?: string | null;
  edgeTokenSigningSecret?: string | null;
  ipHashSecret?: string | null;
  insertErrors?: unknown[];
  apiBaseUrl?: string | null;
  authEnabled?: boolean;
  supabaseProjectUrl?: string | null;
  supabasePublishableKey?: string | null;
  edgeLifecycle?: {
    edge_schema_version: unknown;
    edge_lifecycle_state: unknown;
    edge_target_schema_version: unknown;
    edge_active_operation_id: unknown;
  } | null;
  lifecycleQueryError?: unknown;
}) {
  const insertedRows: unknown[][] = [];
  const sqlCalls: string[] = [];
  const comments = [...(options?.comments ?? [])];
  const edgeCommentSettingsRow = createMockEdgeCommentSettingsRow(options);
  const edgeRuntimeSettingsRow = options?.runtimeSettingsAvailable === false
    ? null
    : createMockEdgeRuntimeSettingsRow(options);
  const insertErrors = [...(options?.insertErrors ?? [])];
  const edgeLifecycleRow = options?.edgeLifecycle === undefined
    ? createMockReadyEdgeLifecycleRow()
    : options.edgeLifecycle;
  const kvStore = new Map<string, string>();
  if (options?.kvValue) {
    kvStore.set('comments:v3:post:101:cache-revision-post-101:approved', options.kvValue);
  }
  const kv = {
    get: vi.fn(async (key: string) => kvStore.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      kvStore.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      kvStore.delete(key);
    }),
  };
  const readRateLimiter = {
    limit: vi.fn(async () => ({ success: options?.readRateLimitSuccess ?? true })),
  };
  const rateLimiter = {
    limit: vi.fn(async ({ key }: { key: string }) => ({
      success: key.startsWith('comment-auth:v1.')
        ? options?.identityRateLimitSuccess ?? true
        : options?.rateLimitSuccess ?? true,
    })),
  };
  const challengeRateLimiter = {
    limit: vi.fn(async () => ({ success: options?.challengeRateLimitSuccess ?? true })),
  };
  const turnstileRateLimiter = {
    limit: vi.fn(async () => ({ success: options?.turnstileRateLimitSuccess ?? true })),
  };
  const edgeDb = {
    prepare: vi.fn((sql: string) => {
      sqlCalls.push(sql);
      const createBoundStatement = (...args: unknown[]) => ({
        first: vi.fn(async () => {
          if (sql.includes('FROM zeropress_edge_schema_state')) {
            if (options?.lifecycleQueryError !== undefined) {
              throw options.lifecycleQueryError;
            }
            const lifecycle = edgeLifecycleRow;
            if (lifecycle === null) return null;
            if (sql.includes('edge_runtime_settings')) {
              return edgeRuntimeSettingsRow
                ? { ...lifecycle, ...edgeCommentSettingsRow, ...edgeRuntimeSettingsRow }
                : lifecycle;
            }
            if (sql.includes('edge_comment_settings')) {
              return { ...lifecycle, ...edgeCommentSettingsRow };
            }
            return lifecycle;
          }

          if (sql.includes('FROM edge_runtime_settings AS r')) {
            return edgeRuntimeSettingsRow
              ? { ...edgeCommentSettingsRow, ...edgeRuntimeSettingsRow }
              : null;
          }

          if (sql.includes('FROM edge_runtime_settings')) {
            return edgeRuntimeSettingsRow;
          }

          if (sql.includes('INSERT INTO comments')) {
            if (insertErrors.length > 0) {
              throw insertErrors.shift();
            }

            const publicId = comments
              .filter((comment) => comment.public_id >= ZP_NATIVE_PUBLIC_ID_BASE)
              .reduce((max, comment) => Math.max(max, comment.public_id), ZP_NATIVE_PUBLIC_ID_BASE) + 1;
            const insertedRow = [args[0], publicId, ...args.slice(3)];
            insertedRows.push(insertedRow);
            comments.push({
              id: String(insertedRow[0]),
              public_id: publicId,
              target_id: Number(insertedRow[2]),
              parent_public_id: insertedRow[3] === null ? null : Number(insertedRow[3]),
              author_name: String(insertedRow[4]),
              author_kind: insertedRow[17] === 'site_user'
                ? 'site_user'
                : insertedRow[17] === 'authenticated_user'
                  ? 'authenticated_user'
                  : 'guest',
              content: String(insertedRow[6]),
              status: String(insertedRow[7]),
              imported: 0,
              created_at: String(insertedRow[15]),
              parent_id: null,
            });
            return { public_id: publicId };
          }

          if (sql.includes('FROM edge_comment_settings')) {
            return edgeCommentSettingsRow;
          }

          if (sql.includes('FROM edge_comment_targets')) {
            const targets = options?.targets ?? (options?.post ? [options.post] : []);
            const targetIndex = targets.findIndex((entry) => (
              (entry.target_type ?? 'post') === String(args[0]) &&
              entry.public_id === Number(args[1])
            ));
            const target = targetIndex >= 0 ? targets[targetIndex] : null;
            return target
              ? {
                  id: targetIndex + 1,
                  target_type: target.target_type ?? 'post',
                  public_id: target.public_id,
                  status: target.status,
                  allow_comments: target.allow_comments,
                  request_token_nonce: target.request_token_nonce ?? `target-nonce-${target.target_type ?? 'post'}-${target.public_id}`,
                  comments_cache_revision: target.comments_cache_revision ?? `cache-revision-${target.target_type ?? 'post'}-${target.public_id}`,
                }
              : null;
          }

          if (sql.includes('FROM comments') && sql.includes('public_id =')) {
            const parentPublicId = Number(args[0]);
            const targetId = Number(args[1]);
            const comment = comments.find((entry) => (
              entry.public_id === parentPublicId &&
              (entry.status ?? 'approved') === 'approved' &&
              (entry.target_id ?? 1) === targetId
            ));
            return comment ? {
              ...comment,
              parent_public_id: comment.parent_public_id ?? null,
            } : null;
          }

          return null;
        }),
        all: vi.fn(async () => {
          if (sql.includes('FROM comments c')) {
            const targetId = Number(args[0]);
            return {
              results: comments
                .filter((comment) => (
                  (comment.status ?? 'approved') === 'approved' &&
                  (comment.target_id ?? 1) === targetId
                ))
                .map((comment) => ({
                  id: comment.id,
                  public_id: comment.public_id,
                  target_id: comment.target_id ?? 1,
                  parent_public_id: comment.parent_public_id ?? null,
                  author_name: comment.author_name,
                  author_kind: comment.author_kind ?? 'guest',
                  content: comment.content,
                  status: comment.status ?? 'approved',
                  imported: comment.imported ?? 0,
                  created_at: comment.created_at,
                })),
            };
          }

          return { results: [] };
        }),
        run: vi.fn(async () => ({ success: true })),
      });

      return {
        bind: (...args: unknown[]) => createBoundStatement(...args),
        first: createBoundStatement().first,
        all: createBoundStatement().all,
        run: createBoundStatement().run,
      };
    }),
  } as unknown as D1Database;

  const env = {
    COMMENTS_ENABLED: 'true',
    NEWSLETTER_ENABLED: 'true',
    FORMS_ENABLED: 'true',
    ALLOWED_ORIGINS: options?.allowedOrigins ?? '',
    TURNSTILE_SECRET_KEY: options?.turnstileSecretKey === null
      ? undefined
      : options?.turnstileSecretKey ?? '1x0000000000000000000000000000000AA',
    EDGE_TOKEN_SIGNING_SECRET: options?.edgeTokenSigningSecret === null
      ? undefined
      : options?.edgeTokenSigningSecret ?? TEST_EDGE_TOKEN_SIGNING_SECRET,
    IP_HASH_SECRET: options?.ipHashSecret === null
      ? undefined
      : options?.ipHashSecret ?? TEST_IP_HASH_SECRET,
    EDGE_KV: kv as unknown as KVNamespace,
    COMMENT_READ_RATE_LIMITER: readRateLimiter,
    COMMENT_WRITE_RATE_LIMITER: rateLimiter,
    COMMENT_CHALLENGE_RATE_LIMITER: challengeRateLimiter,
    TURNSTILE_VERIFY_RATE_LIMITER: turnstileRateLimiter,
    EDGE_DB: edgeDb,
  } as Env;

  return {
    env,
    kv,
    readRateLimiter,
    rateLimiter,
    challengeRateLimiter,
    turnstileRateLimiter,
    insertedRows,
    sqlCalls,
    kvStore,
  };
}

function createMockEdgeRuntimeSettingsRow(options: {
  writeVerificationMode?: string;
  turnstileSiteKey?: string | null;
} | undefined) {
  const commentMode = options?.writeVerificationMode ?? 'pow';
  const turnstileSitekey = options?.turnstileSiteKey === null
    ? null
    : options?.turnstileSiteKey ?? (commentMode === 'turnstile' ? '1x00000000000000000000AA' : null);
  return {
    runtime_settings_id: 1,
    comment_write_verification_mode: commentMode,
    newsletter_subscribe_verification_mode: 'pow',
    form_submit_verification_mode: 'pow',
    turnstile_sitekey: turnstileSitekey,
    ip_address_retention_days: 30,
  };
}

export function createMockReadyEdgeLifecycleRow() {
  return {
    edge_schema_version: 1,
    edge_lifecycle_state: 'ready',
    edge_target_schema_version: null,
    edge_active_operation_id: null,
  };
}

function createMockEdgeCommentSettingsRow(options: Parameters<typeof createMockEnv>[0]) {
  const settings = options?.settings ?? {};
  const apiBaseUrl = options?.apiBaseUrl;
  const authEnabled = options?.authEnabled ?? false;
  return {
    api_base_url: apiBaseUrl === undefined ? 'https://edge.example.com/api' : apiBaseUrl,
    comments_enabled: getBooleanMockSetting(settings.disallow_comments, false) ? 0 : 1,
    require_approval: getBooleanMockSetting(settings.require_comment_approval, true) ? 1 : 0,
    per_page: getIntegerMockSetting(settings.comments_per_page, 50, 1, 100),
    sort_order: settings.comments_order?.value === 'asc' ? 'asc' : 'desc',
    thread_comments: getBooleanMockSetting(settings.thread_comments, true) ? 1 : 0,
    thread_comments_depth: getIntegerMockSetting(settings.thread_comments_depth, 2, 2, 10),
    request_secrets_json: settings.comment_request_secrets?.value ?? null,
    auth_enabled: authEnabled ? 1 : 0,
    supabase_project_url: options?.supabaseProjectUrl === undefined
      ? authEnabled ? 'https://test-project.supabase.co' : null
      : options.supabaseProjectUrl,
    supabase_publishable_key: options?.supabasePublishableKey === undefined
      ? authEnabled ? 'sb_publishable_1234567890abcdefghijklmnop' : null
      : options.supabasePublishableKey,
  };
}

function getBooleanMockSetting(setting: MockSetting | undefined, defaultValue: boolean): boolean {
  if (!setting || setting.value === null) return defaultValue;
  const value = setting.value.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(value)) return true;
  if (['false', '0', 'no', 'off'].includes(value)) return false;
  return defaultValue;
}

function getIntegerMockSetting(
  setting: MockSetting | undefined,
  defaultValue: number,
  min: number,
  max: number,
): number {
  const value = setting?.value?.trim() ?? '';
  if (!/^\d+$/.test(value)) return defaultValue;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) return defaultValue;
  return Math.min(max, Math.max(min, parsed));
}

export async function readJson(response: Response): Promise<any> {
  return unwrapApiEnvelopeForTests(await response.json());
}

export function unwrapApiEnvelopeForTests(payload: any): any {
  if (payload && typeof payload === 'object' && payload.success === false && payload.error) {
    return payload.error;
  }

  if (payload && typeof payload === 'object' && payload.success === true && payload.data) {
    const data = payload.data;
    if (data && typeof data === 'object' && data.item) {
      return data.item;
    }
    if (data && typeof data === 'object' && Array.isArray(data.items)) {
      return {
        comments: data.items,
        pagination: data.pagination,
      };
    }
    return data;
  }

  return payload;
}

export function publishedPost() {
  return {
    id: 'post-db-1',
    public_id: 101,
    status: 'published',
    allow_comments: 1,
    target_type: 'post' as const,
    request_token_nonce: 'target-nonce-post-101',
    comments_cache_revision: 'cache-revision-post-101',
  };
}

export function defaultOpenSettings(overrides?: Record<string, MockSetting>): Record<string, MockSetting> {
  return {
    disallow_comments: { value: 'false', type: 'boolean' },
    require_comment_approval: { value: 'true', type: 'boolean' },
    comments_per_page: { value: '50', type: 'number' },
    comments_order: { value: 'desc', type: 'string' },
    comment_request_secrets: commentRequestSecretsSetting(),
    ...overrides,
  };
}
