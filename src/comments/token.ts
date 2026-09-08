import type { Env } from '../env';
import { isPlainRecord } from '../guards';
import { getLogErrorMessage, logWarn } from '../log';
import { constantTimeEqual, signHmacSha256Base64Url } from './crypto';
import type { CommentTargetRef } from './types';

export const COMMENT_REQUEST_TOKEN_QUERY_KEY = 'comment_request_token';
export const COMMENT_REQUEST_TOKEN_BODY_KEY = 'comment_request_token';

export const COMMENT_REQUEST_SECRETS_SETTING_KEY = 'comment_request_secrets';
const COMMENT_REQUEST_TOKEN_MESSAGE_PREFIX = 'v2:comments:';
const TOKEN_PATTERN = /^(k_[A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;
const SECRET_KID_PATTERN = /^k_[A-Za-z0-9_-]{22}$/;

export type CommentRequestSecretEntry = {
  kid: string;
  secret: string;
  created_at: string;
  expires_at?: string;
};

export type CommentRequestSecrets = {
  version: 1;
  current: CommentRequestSecretEntry;
  previous: CommentRequestSecretEntry[];
};

export type CommentRequestTokenResult = {
  ok: boolean;
  code?: string;
  message?: string;
};

type ParsedCommentRequestToken =
  | { ok: true; kid: string; signature: string }
  | { ok: false; code: string; message: string };

export async function verifyCommentRequestToken(
  env: Env,
  target: CommentTargetRef & { requestTokenNonce: string },
  token: string,
  now = new Date(),
): Promise<CommentRequestTokenResult> {
  const secrets = await readCommentRequestSecrets(env);
  return verifyCommentRequestTokenWithSecrets(secrets, target, token, now);
}

export async function verifyCommentRequestTokenWithSecrets(
  secrets: CommentRequestSecrets | null,
  target: CommentTargetRef & { requestTokenNonce: string },
  token: string,
  now = new Date(),
): Promise<CommentRequestTokenResult> {
  const parsed = parseCommentRequestToken(token);
  if (!parsed.ok) return parsed;

  if (!secrets) {
    return invalidToken();
  }

  const key = findUsableCommentRequestSecret(secrets, parsed.kid, now);
  if (!key) {
    return invalidToken();
  }

  const expected = await signCommentRequestToken(key.secret, target);
  return constantTimeEqual(parsed.signature, expected)
    ? { ok: true }
    : invalidToken();
}

// Syntax only. Callers must still verify the signature and current target nonce.
export function parseCommentRequestToken(token: string): ParsedCommentRequestToken {
  const normalizedToken = String(token || '').trim();
  if (!normalizedToken) {
    return {
      ok: false,
      code: 'MISSING_COMMENT_REQUEST_TOKEN',
      message: 'Comment request token is required.',
    };
  }

  const match = normalizedToken.match(TOKEN_PATTERN);
  if (!match) {
    return invalidToken();
  }

  const [, kid, signature] = match;
  return { ok: true, kid, signature };
}

export async function readCommentRequestSecrets(env: Env): Promise<CommentRequestSecrets | null> {
  const row = await env.EDGE_DB.prepare(
    `SELECT request_secrets_json
     FROM edge_comment_settings
     WHERE id = 1
     LIMIT 1`
  )
    .first<{ request_secrets_json: string | null }>();
  return parseCommentRequestSecretsSetting(row?.request_secrets_json ?? null);
}

export function parseCommentRequestSecretsSetting(value: unknown): CommentRequestSecrets | null {
  if (!value) {
    logWarn('Missing comment_request_secrets setting');
    return null;
  }

  if (typeof value !== 'string') {
    logWarn('Invalid comment_request_secrets setting', {
      errorMessage: 'Expected a JSON string.',
    });
    return null;
  }

  try {
    return parseCommentRequestSecretsJson(value);
  } catch (error) {
    logWarn('Invalid comment_request_secrets setting', {
      errorMessage: getLogErrorMessage(error),
    });
    return null;
  }
}

function parseCommentRequestSecretsJson(rawValue: string): CommentRequestSecrets {
  const parsed = JSON.parse(rawValue) as unknown;
  if (!isPlainRecord(parsed) || parsed.version !== 1) {
    throw new Error('version must be 1');
  }

  const current = parseSecretEntry(parsed.current);
  const previous = Array.isArray(parsed.previous)
    ? parsed.previous.map(parseSecretEntry)
    : null;
  if (!previous) {
    throw new Error('previous must be an array');
  }

  return {
    version: 1,
    current,
    previous,
  };
}

function parseSecretEntry(value: unknown): CommentRequestSecretEntry {
  if (!isPlainRecord(value)) {
    throw new Error('secret entry must be an object');
  }

  const kid = normalizeRequiredString(value.kid);
  if (!SECRET_KID_PATTERN.test(kid)) {
    throw new Error('secret kid has invalid format');
  }

  const secret = normalizeRequiredString(value.secret);
  const createdAt = normalizeRequiredString(value.created_at);
  const entry: CommentRequestSecretEntry = {
    kid,
    secret,
    created_at: createdAt,
  };

  if (value.expires_at !== undefined) {
    entry.expires_at = normalizeRequiredString(value.expires_at);
  }

  return entry;
}

export function findUsableCommentRequestSecret(
  secrets: CommentRequestSecrets,
  kid: string,
  now: Date,
): CommentRequestSecretEntry | null {
  if (secrets.current.kid === kid) {
    return secrets.current;
  }

  return secrets.previous.find((entry) => (
    entry.kid === kid &&
    Boolean(entry.expires_at) &&
    new Date(String(entry.expires_at)).getTime() >= now.getTime()
  )) ?? null;
}

export async function signCommentRequestToken(
  secret: string,
  target: CommentTargetRef & { requestTokenNonce: string },
): Promise<string> {
  return signHmacSha256Base64Url(
    secret,
    `${COMMENT_REQUEST_TOKEN_MESSAGE_PREFIX}${target.targetType}:${target.targetPublicId}:${target.requestTokenNonce}`,
  );
}

function invalidToken(): Extract<ParsedCommentRequestToken, { ok: false }> {
  return {
    ok: false,
    code: 'INVALID_COMMENT_REQUEST_TOKEN',
    message: 'Comment request token is invalid.',
  };
}

function normalizeRequiredString(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('expected a non-empty string');
  }
  return value.trim();
}
