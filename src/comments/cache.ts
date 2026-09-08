import type { Env } from '../env';
import { deleteEdgeKvValue, getEdgeKvValue, putEdgeKvValue } from '../edge-kv';
import type { CommentData, CommentTargetPolicy } from './types';

export async function getApprovedCommentRows(
  env: Env,
  targetPolicy: CommentTargetPolicy,
  cacheTtlSeconds: number,
): Promise<CommentData[]> {
  const cacheKey = buildCommentsCacheKey(targetPolicy);
  if (env.EDGE_KV && cacheTtlSeconds > 0) {
    const cachedValue = await getEdgeKvValue(env, cacheKey);
    const cachedRows = parseCachedCommentRows(cachedValue);
    if (cachedRows) {
      return cachedRows;
    }
  }

  const { results } = await env.EDGE_DB.prepare(
    `SELECT
       c.id,
       c.public_id,
       c.target_id,
       c.parent_public_id,
       c.author_name,
       c.author_kind,
       c.content,
       c.status,
       c.imported,
       c.created_at
     FROM comments c
     WHERE c.target_id = ? AND c.status = 'approved'`
  )
    .bind(targetPolicy.id)
    .all<CommentData>();

  const rows = results ?? [];
  if (env.EDGE_KV && cacheTtlSeconds > 0) {
    await putEdgeKvValue(env, cacheKey, JSON.stringify(rows), cacheTtlSeconds);
  }

  return rows;
}

export async function deleteCommentsCache(env: Env, targetPolicy: CommentTargetPolicy): Promise<void> {
  await deleteEdgeKvValue(env, buildCommentsCacheKey(targetPolicy));
}

function parseCachedCommentRows(value: string | null): CommentData[] | null {
  if (!value) return null;

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed as CommentData[] : null;
  } catch {
    return null;
  }
}

export function buildCommentsCacheKey(targetPolicy: Pick<
  CommentTargetPolicy,
  'target_type' | 'public_id' | 'comments_cache_revision'
>): string {
  return `comments:v3:${targetPolicy.target_type}:${targetPolicy.public_id}:${targetPolicy.comments_cache_revision}:approved`;
}
