import type { Env } from './env';
import { sha256Base64Url } from './crypto';
import { getLogErrorMessage, logWarn } from './log';

export type UsedChallengeResult = {
  ok: boolean;
  code?: string;
  message?: string;
};

const USED_CHALLENGE_EXPIRY_BUFFER_SECONDS = 60;
const MINIMUM_USED_CHALLENGE_TTL_SECONDS = 60;

export async function getEdgeKvValue(env: Env, key: string): Promise<string | null> {
  if (!env.EDGE_KV) return null;

  try {
    return await env.EDGE_KV.get(key);
  } catch (error) {
    logWarn('KV get failed', { key, errorMessage: getLogErrorMessage(error) });
    return null;
  }
}

export async function putEdgeKvValue(
  env: Env,
  key: string,
  value: string,
  expirationTtl: number,
): Promise<void> {
  if (!env.EDGE_KV) return;

  try {
    await env.EDGE_KV.put(key, value, { expirationTtl });
  } catch (error) {
    logWarn('KV put failed', { key, expirationTtl, errorMessage: getLogErrorMessage(error) });
  }
}

export async function deleteEdgeKvValue(env: Env, key: string): Promise<void> {
  if (!env.EDGE_KV) return;

  try {
    await env.EDGE_KV.delete(key);
  } catch (error) {
    logWarn('KV delete failed', { key, errorMessage: getLogErrorMessage(error) });
  }
}

export async function getEdgeKvJsonValue<T>(env: Env, key: string): Promise<T | null> {
  const value = await getEdgeKvValue(env, key);
  if (value === null) return null;

  try {
    return JSON.parse(value) as T;
  } catch (error) {
    logWarn('KV JSON parse failed', { key, errorMessage: getLogErrorMessage(error) });
    return null;
  }
}

export async function putEdgeKvJsonValue(
  env: Env,
  key: string,
  value: unknown,
  expirationTtl: number,
): Promise<void> {
  await putEdgeKvValue(env, key, JSON.stringify(value), expirationTtl);
}

export async function consumeUsedChallenge(
  env: Env,
  input: {
    scope: 'comment-write' | 'newsletter-subscribe' | 'form-submit';
    challengeToken: string;
    expiresAtSeconds: number;
    alreadyUsedCode: string;
    alreadyUsedMessage: string;
    now?: Date;
  },
): Promise<UsedChallengeResult> {
  if (!env.EDGE_KV) {
    return { ok: true };
  }

  const key = await buildUsedChallengeKey(input.scope, input.challengeToken);
  const existingValue = await getEdgeKvValue(env, key);
  if (existingValue !== null) {
    return {
      ok: false,
      code: input.alreadyUsedCode,
      message: input.alreadyUsedMessage,
    };
  }

  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const ttlSeconds = Math.max(
    MINIMUM_USED_CHALLENGE_TTL_SECONDS,
    input.expiresAtSeconds - nowSeconds + USED_CHALLENGE_EXPIRY_BUFFER_SECONDS,
  );
  // This write is intentionally awaited by callers. Moving it to waitUntil()
  // would widen the replay window for rapid duplicate submissions.
  await putEdgeKvValue(env, key, '1', ttlSeconds);
  return { ok: true };
}

async function buildUsedChallengeKey(
  scope: 'comment-write' | 'newsletter-subscribe' | 'form-submit',
  challengeToken: string,
): Promise<string> {
  return `challenge-used:v1:${scope}:${await sha256Base64Url(challengeToken)}`;
}
