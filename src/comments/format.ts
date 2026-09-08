import { formatDateToUtcSecondIso } from '../time';
import type { CommentData, CommentListItemData } from './types';

export function normalizeCommentTimestamp(value: string): string {
  const trimmedValue = String(value || '').trim();
  if (!trimmedValue) {
    return '';
  }

  let candidate = trimmedValue.replace(' ', 'T');
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(candidate)) {
    candidate = `${candidate}Z`;
  }

  const date = new Date(candidate);
  if (Number.isNaN(date.getTime())) {
    return '';
  }

  return formatDateToUtcSecondIso(date);
}

export function formatCommentListItems(comments: CommentData[]): CommentListItemData[] {
  return comments.map((comment): CommentListItemData => ({
    ...formatCommentBase(comment),
    content_text: formatCommentText(comment),
  }));
}

function formatCommentBase(comment: CommentData) {
  const dateGmt = normalizeCommentTimestamp(comment.created_at);
  if (!dateGmt) {
    throw new Error(`Invalid created_at timestamp for comment public_id ${comment.public_id}.`);
  }

  return {
    id: comment.public_id,
    parent_id: comment.parent_public_id,
    author_name: comment.author_name,
    author_kind: comment.author_kind,
    created_at_iso: dateGmt,
  };
}

function decodeHtmlEntities(value: string): string {
  return String(value || '')
    .replace(/&#(\d+);/g, (_match, code) => {
      const parsed = Number.parseInt(code, 10);
      return Number.isFinite(parsed) && parsed >= 0 && parsed <= 0x10ffff
        ? String.fromCodePoint(parsed)
        : '';
    })
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => {
      const parsed = Number.parseInt(code, 16);
      return Number.isFinite(parsed) && parsed >= 0 && parsed <= 0x10ffff
        ? String.fromCodePoint(parsed)
        : '';
    })
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/gi, "'");
}

function formatNativeCommentText(value: string): string {
  return String(value || '').replace(/\r\n?/g, '\n').trim();
}

function formatImportedCommentText(value: string): string {
  const normalizedValue = String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/<br\s*\/?>[ \t]*\n?/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n\n')
    .replace(/<\/div\s*>/gi, '\n\n')
    .replace(/<\/li\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '');

  return decodeHtmlEntities(normalizedValue)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function formatCommentText(comment: CommentData): string {
  return comment.imported === 1 || comment.imported === true
    ? formatImportedCommentText(comment.content)
    : formatNativeCommentText(comment.content);
}
