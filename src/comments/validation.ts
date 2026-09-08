import type { ApiErrorItem } from '../http';
import { isRecord, normalizeBodyString } from '../http';
import { normalizeEmailTextInput, normalizeMultiLineFreeTextInput, normalizeSingleLineTextInput } from '../text-input';
import {
  COMMENT_CHALLENGE_SOLUTION_BODY_KEY,
  COMMENT_CHALLENGE_SOLUTION_QUERY_KEY,
  COMMENT_CHALLENGE_TOKEN_BODY_KEY,
  COMMENT_CHALLENGE_TOKEN_QUERY_KEY,
} from './challenge';
import {
  COMMENT_REQUEST_TOKEN_BODY_KEY,
  COMMENT_REQUEST_TOKEN_QUERY_KEY,
} from './token';
import { parseTurnstileToken, type WriteVerificationMode } from '../turnstile';

type CreateCommentBody = {
  parent_id?: unknown;
  author_name?: unknown;
  author_email?: unknown;
  content_text?: unknown;
  comment_request_token?: unknown;
  comment_challenge_token?: unknown;
  comment_challenge_solution?: unknown;
  turnstile_token?: unknown;
};

export const COMMENT_ALLOWED_GET_QUERY_KEYS = new Set([
  'page',
  COMMENT_REQUEST_TOKEN_QUERY_KEY,
  COMMENT_CHALLENGE_TOKEN_QUERY_KEY,
  COMMENT_CHALLENGE_SOLUTION_QUERY_KEY,
]);
export const COMMENT_ALLOWED_POST_QUERY_KEYS = new Set<string>();

const COMMENT_ALLOWED_CREATE_BODY_KEYS = [
  'parent_id',
  'author_name',
  'author_email',
  'content_text',
  COMMENT_REQUEST_TOKEN_BODY_KEY,
] as const;
const COMMENT_ALLOWED_CREATE_ANY_MODE_BODY_KEYS = new Set<string>([
  ...COMMENT_ALLOWED_CREATE_BODY_KEYS,
  COMMENT_CHALLENGE_TOKEN_BODY_KEY,
  COMMENT_CHALLENGE_SOLUTION_BODY_KEY,
  'turnstile_token',
]);
const MAX_AUTHOR_NAME_LENGTH = 80;
const MAX_AUTHOR_EMAIL_LENGTH = 254;
const MAX_COMMENT_LENGTH = 5000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type CommentAuthorEmailPolicy = 'required' | 'ignored';

export function validateCreateCommentBodyCommon(
  rawBody: unknown,
  authorEmailPolicy: CommentAuthorEmailPolicy = 'required',
): ApiErrorItem[] {
  if (!isRecord(rawBody) || Array.isArray(rawBody)) {
    return [{ message: 'Request body must be a JSON object.' }];
  }

  const errors: ApiErrorItem[] = [];
  for (const key of Object.keys(rawBody)) {
    if (!COMMENT_ALLOWED_CREATE_ANY_MODE_BODY_KEYS.has(key)) {
      errors.push({ field: key, message: `Unsupported body field: ${key}.` });
    }
  }

  const parentId = parseParentValue((rawBody as CreateCommentBody).parent_id);
  if (parentId === null) {
    errors.push({
      field: 'parent_id',
      message: 'Expected a positive safe integer, null, or omitted value.',
    });
  }

  const authorName = normalizeSingleLineTextInput(normalizeBodyString((rawBody as CreateCommentBody).author_name));
  const authorEmail = normalizeEmailTextInput(normalizeBodyString((rawBody as CreateCommentBody).author_email));
  const contentText = normalizeMultiLineFreeTextInput(normalizeBodyString((rawBody as CreateCommentBody).content_text));

  if (!authorName) {
    errors.push({ field: 'author_name', message: 'Author name is required.' });
  } else if (authorName.length > MAX_AUTHOR_NAME_LENGTH) {
    errors.push({ field: 'author_name', message: `Author name must be ${MAX_AUTHOR_NAME_LENGTH} characters or fewer.` });
  }

  if (authorEmailPolicy === 'required') {
    appendAuthorEmailErrors(errors, authorEmail);
  }

  if (!contentText) {
    errors.push({ field: 'content_text', message: 'Comment content is required.' });
  } else if (contentText.length > MAX_COMMENT_LENGTH) {
    errors.push({ field: 'content_text', message: `Comment content must be ${MAX_COMMENT_LENGTH} characters or fewer.` });
  }

  return errors;
}

export function parseCreateCommentBody(
  rawBody: unknown,
  mode: WriteVerificationMode = 'pow',
  authorEmailPolicy: CommentAuthorEmailPolicy = 'required',
): {
  value: {
    parentId: number;
    authorName: string;
    authorEmail: string;
    contentText: string;
    commentRequestToken: string;
    commentChallengeToken: string;
    commentChallengeSolution: string;
    turnstileToken: string;
  } | null;
  errors: ApiErrorItem[];
} {
  const errors: ApiErrorItem[] = [];
  if (!isRecord(rawBody) || Array.isArray(rawBody)) {
    return {
      value: null,
      errors: [{ message: 'Request body must be a JSON object.' }],
    };
  }

  const allowedKeys = new Set<string>(COMMENT_ALLOWED_CREATE_BODY_KEYS);
  if (mode === 'pow') {
    allowedKeys.add(COMMENT_CHALLENGE_TOKEN_BODY_KEY);
    allowedKeys.add(COMMENT_CHALLENGE_SOLUTION_BODY_KEY);
  } else {
    allowedKeys.add('turnstile_token');
  }

  for (const key of Object.keys(rawBody)) {
    if (!allowedKeys.has(key)) {
      errors.push({
        field: key,
        message: `Unsupported body field: ${key}.`,
      });
    }
  }

  const parentId = parseParentValue((rawBody as CreateCommentBody).parent_id);
  if (parentId === null) {
    errors.push({
      field: 'parent_id',
      message: 'Expected a positive safe integer, null, or omitted value.',
    });
  }

  const authorName = normalizeSingleLineTextInput(normalizeBodyString((rawBody as CreateCommentBody).author_name));
  const authorEmail = normalizeEmailTextInput(normalizeBodyString((rawBody as CreateCommentBody).author_email));
  const contentText = normalizeMultiLineFreeTextInput(normalizeBodyString((rawBody as CreateCommentBody).content_text));
  const commentRequestToken = normalizeBodyString((rawBody as CreateCommentBody).comment_request_token);
  const commentChallengeToken = normalizeBodyString((rawBody as CreateCommentBody).comment_challenge_token);
  const commentChallengeSolution = normalizeBodyString((rawBody as CreateCommentBody).comment_challenge_solution);
  const turnstileToken = parseTurnstileToken((rawBody as CreateCommentBody).turnstile_token) ?? '';

  if (!authorName) {
    errors.push({ field: 'author_name', message: 'Author name is required.' });
  } else if (authorName.length > MAX_AUTHOR_NAME_LENGTH) {
    errors.push({ field: 'author_name', message: `Author name must be ${MAX_AUTHOR_NAME_LENGTH} characters or fewer.` });
  }

  if (authorEmailPolicy === 'required') {
    appendAuthorEmailErrors(errors, authorEmail);
  }

  if (!contentText) {
    errors.push({ field: 'content_text', message: 'Comment content is required.' });
  } else if (contentText.length > MAX_COMMENT_LENGTH) {
    errors.push({ field: 'content_text', message: `Comment content must be ${MAX_COMMENT_LENGTH} characters or fewer.` });
  }

  return {
    value: errors.length > 0
      ? null
      : {
          parentId: parentId ?? 0,
          authorName,
          authorEmail: authorEmail ?? '',
          contentText,
          commentRequestToken,
          commentChallengeToken,
          commentChallengeSolution,
          turnstileToken,
        },
    errors,
  };
}

export function normalizeCommentAuthorEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = normalizeEmailTextInput(value);
  return normalized &&
    normalized.length <= MAX_AUTHOR_EMAIL_LENGTH &&
    EMAIL_PATTERN.test(normalized)
    ? normalized
    : null;
}

function appendAuthorEmailErrors(errors: ApiErrorItem[], authorEmail: string | null): void {
  if (authorEmail === null) {
    errors.push({ field: 'author_email', message: 'Author email must be a valid email address.' });
  } else if (!authorEmail) {
    errors.push({ field: 'author_email', message: 'Author email is required.' });
  } else if (authorEmail.length > MAX_AUTHOR_EMAIL_LENGTH) {
    errors.push({ field: 'author_email', message: `Author email must be ${MAX_AUTHOR_EMAIL_LENGTH} characters or fewer.` });
  } else if (!EMAIL_PATTERN.test(authorEmail)) {
    errors.push({ field: 'author_email', message: 'Author email must be a valid email address.' });
  }
}

function parseParentValue(value: unknown): number | null {
  if (value === undefined || value === null) {
    return 0;
  }

  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }

  return null;
}
