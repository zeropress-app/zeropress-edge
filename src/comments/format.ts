import { defaultTreeAdapter, parseFragment, type DefaultTreeAdapterMap } from 'parse5';
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

function formatNativeCommentText(value: string): string {
  return String(value || '').replace(/\r\n?/g, '\n').trim();
}

function formatImportedCommentText(value: string): string {
  const fragment = parseFragment(String(value || ''));
  const pending: (DefaultTreeAdapterMap['childNode'] | string)[] = [...fragment.childNodes].reverse();
  const parts: string[] = [];
  let afterBr = false;

  // Parsing decodes entities once. Extracted text must still be rendered as text, not HTML.
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (typeof node === 'string') {
      parts.push(node);
      afterBr = false;
      continue;
    }
    if (defaultTreeAdapter.isTextNode(node)) {
      parts.push(afterBr ? node.value.replace(/^[ \t]*\n?/, '') : node.value);
      afterBr = false;
      continue;
    }
    if (!defaultTreeAdapter.isElementNode(node)) continue;
    if (node.tagName === 'script' || node.tagName === 'style' || node.tagName === 'template') continue;
    if (node.tagName === 'br') {
      parts.push('\n');
      afterBr = true;
      continue;
    }
    if (node.tagName === 'p' || node.tagName === 'div') pending.push('\n\n');
    else if (node.tagName === 'li') pending.push('\n');
    for (let index = node.childNodes.length - 1; index >= 0; index--) {
      pending.push(node.childNodes[index]);
    }
  }

  return parts.join('')
    .replace(/\u00a0/g, ' ')
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
