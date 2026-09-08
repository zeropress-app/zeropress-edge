import type { Env } from '../env';
import type { ApiErrorItem } from '../http';
import { createId } from '../id';
import { formatDateToUtcSecondIso } from '../time';
import { ZP_NATIVE_PUBLIC_ID_BASE } from './public-id';
import type {
  CommentRuntimeConfig,
  CommentTargetPolicy,
  CommentTargetRef,
  CreateCommentInput,
  InsertedCommentPublicIdRow,
} from './types';

const MAX_COMMENT_IP_ADDRESS_LENGTH = 45;
const MAX_COMMENT_USER_AGENT_LENGTH = 250;

export async function getCommentTargetPolicy(
  env: Env,
  target: CommentTargetRef,
): Promise<CommentTargetPolicy | null> {
  const result = await env.EDGE_DB.prepare(
    `SELECT
       id,
       target_type,
       public_id,
       status,
       allow_comments,
       request_token_nonce,
       comments_cache_revision
     FROM edge_comment_targets
     WHERE target_type = ? AND public_id = ?
     LIMIT 1`
  )
    .bind(target.targetType, target.targetPublicId)
    .first<CommentTargetPolicy>();

  return result ?? null;
}

export async function resolveParentComment(
  env: Env,
  targetId: number,
  parentPublicId: number,
  config: Pick<CommentRuntimeConfig, 'threadComments' | 'threadCommentsDepth'>,
): Promise<{
  parentPublicId: number | null;
  errors: ApiErrorItem[];
}> {
  if (parentPublicId === 0) {
    return {
      parentPublicId: null,
      errors: [],
    };
  }

  if (!config.threadComments) {
    return {
      parentPublicId: null,
      errors: [{ field: 'parent_id', message: 'Threaded replies are disabled.' }],
    };
  }

  const parentComment = await env.EDGE_DB.prepare(
    `SELECT public_id, parent_public_id
     FROM comments
     WHERE public_id = ? AND target_id = ? AND status = 'approved'
     LIMIT 1`
  )
    .bind(parentPublicId, targetId)
    .first<{ public_id: number; parent_public_id: number | null }>();

  if (!parentComment) {
    return {
      parentPublicId: null,
      errors: [{ field: 'parent_id', message: 'Parent comment was not found.' }],
    };
  }

  const parentDepthResult = await resolveApprovedCommentDepth(env, targetId, parentComment);
  if (!parentDepthResult.ok) {
    return {
      parentPublicId: null,
      errors: [{ field: 'parent_id', message: 'Parent comment tree is invalid.' }],
    };
  }

  if (parentDepthResult.depth >= config.threadCommentsDepth) {
    return {
      parentPublicId: null,
      errors: [{ field: 'parent_id', message: 'Reply depth exceeds the configured limit.' }],
    };
  }

  return {
    parentPublicId: parentComment.public_id,
    errors: [],
  };
}

async function resolveApprovedCommentDepth(
  env: Env,
  targetId: number,
  startComment: { public_id: number; parent_public_id: number | null },
): Promise<{ ok: true; depth: number } | { ok: false }> {
  const seen = new Set<number>();
  let depth = 1;
  let current: { public_id: number; parent_public_id: number | null } | null = startComment;

  while (current) {
    if (seen.has(current.public_id)) {
      return { ok: false };
    }
    seen.add(current.public_id);

    if (current.parent_public_id === null) {
      return { ok: true, depth };
    }

    if (depth >= 10) {
      return { ok: false };
    }

    current = await env.EDGE_DB.prepare(
      `SELECT public_id, parent_public_id
       FROM comments
       WHERE public_id = ? AND target_id = ? AND status = 'approved'
       LIMIT 1`
    )
      .bind(current.parent_public_id, targetId)
      .first<{ public_id: number; parent_public_id: number | null }>();
    if (!current) {
      return { ok: false };
    }
    depth += 1;
  }

  return { ok: false };
}

export async function insertComment(
  env: Env,
  input: CreateCommentInput,
): Promise<void> {
  const commentId = createId();
  const createdAt = formatDateToUtcSecondIso(new Date());
  // Keep allocation inside this write statement. A separate MAX() read would
  // allow concurrent requests to select the same public ID before either insert.
  const inserted = await env.EDGE_DB.prepare(
    `INSERT INTO comments (
       id,
       public_id,
       target_id,
       parent_public_id,
       author_name,
       author_email,
       content,
       status,
       ip_address,
       ip_address_recorded_at,
       ip_hash,
       user_agent,
       asn,
       as_organization,
       country_code,
       created_at,
       updated_at,
       author_kind,
       author_identity_issuer,
       author_user_id
     )
     VALUES (
       ?,
       (
         SELECT COALESCE(MAX(public_id), ?) + 1
         FROM comments
         WHERE public_id >= ?
       ),
       ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
     )
     RETURNING public_id`
  )
    .bind(
      commentId,
      ZP_NATIVE_PUBLIC_ID_BASE,
      ZP_NATIVE_PUBLIC_ID_BASE,
      input.targetId,
      input.parentPublicId,
      input.authorName,
      input.authorEmail,
      input.content,
      input.status,
      normalizeCommentIpAddress(input.clientIP),
      createdAt,
      input.ipHash,
      normalizeCommentUserAgent(input.userAgent),
      input.asn,
      input.asOrganization,
      input.countryCode,
      createdAt,
      createdAt,
      input.authorKind,
      input.authorIdentityIssuer,
      input.authorUserId,
    )
    .first<InsertedCommentPublicIdRow>();

  if (
    !inserted
    || !Number.isSafeInteger(inserted.public_id)
    || inserted.public_id <= ZP_NATIVE_PUBLIC_ID_BASE
  ) {
    throw new Error('Comment insert did not return a valid native public ID.');
  }
}

function normalizeCommentIpAddress(value: string): string | null {
  const normalized = value.trim();
  if (!normalized || normalized === 'unknown' || normalized.length > MAX_COMMENT_IP_ADDRESS_LENGTH) {
    return null;
  }
  return normalized;
}

function normalizeCommentUserAgent(value: string | null): string | null {
  if (!value) return null;
  const normalized = value
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return normalized ? normalized.slice(0, MAX_COMMENT_USER_AGENT_LENGTH) : null;
}
