import { EDGE_MAIL_QUEUE_CONTRACT_VERSION, type Env } from '../env';
import { consumeUsedChallenge, getEdgeKvJsonValue, putEdgeKvJsonValue } from '../edge-kv';
import {
  errorResponse,
  getClientIP,
  jsonResponse,
  resolveCorsContext,
  validateQueryKeys,
  withCorsHeaders,
} from '../http';
import { isApplicationJsonContentType, readBoundedJson } from '../json-body';
import { getLogErrorMessage, logError, logWarn } from '../log';
import { EdgeMailUnavailableError, enqueueMailJob, getEdgeMailSettings } from '../mail-queue';
import { IpHashSecretUnavailableError, getClientNetworkMetadata } from '../request-metadata';
import { applyPublicRateLimit } from '../rate-limit';
import { formatDateToUtcSecondIso } from '../time';
import { getEdgeRuntimeSettings } from '../runtime-settings';
import {
  applyTurnstileVerifyRateLimit,
  createWriteVerificationDescriptor,
  parseTurnstileToken,
  verifyTurnstileToken,
} from '../turnstile';
import { verifyNewsletterChallenge } from './challenge';
import {
  NewsletterConfirmTokenUnavailableError,
  createNewsletterConfirmToken,
  verifyNewsletterConfirmToken,
} from './confirm-token';
import { sha256Base64Url } from '../crypto';
import { createId } from '../id';
import {
  NewsletterEmailSuppressedError,
  confirmNewsletterSubscription,
  getActiveNewsletterBySlug,
  getActiveNewsletterFields,
  getNewsletterSubscriptionByEmail,
  getPendingSubscriptionByIdAndConfirmTokenHash,
  isNewsletterEmailSuppressed,
  markNewsletterConfirmationEmailFailed,
  markNewsletterDeliveryEnqueueFailed,
  reserveNewsletterConfirmation,
  unsubscribeNewsletterSubscriptionById,
} from './repository';
import {
  NEWSLETTER_ALLOWED_CONFIRM_QUERY_KEYS,
  NEWSLETTER_ALLOWED_READ_QUERY_KEYS,
  NEWSLETTER_ALLOWED_SUBSCRIBE_QUERY_KEYS,
  NEWSLETTER_ALLOWED_UNSUBSCRIBE_QUERY_KEYS,
  getSubscribeChallengeFields,
  getSubscribeTurnstileTokenInput,
  parseConfirmBodyToken,
  parseNewsletterSlug,
  parseSubscribeBody,
  parseSubscribeSourceUrl,
  toPublicNewsletterField,
  validateConfirmBodyEnvelope,
  validateSubscribeBodyCommon,
  validateSubscribeBodyEnvelope,
  validateUnsubscribeBodyEnvelope,
} from './validation';
import type { NewsletterList } from './types';
import { rethrowEdgeDatabaseLifecycleQueryFailure } from '../database-lifecycle';
import {
  createNewsletterUnsubscribeToken,
  parseNewsletterUnsubscribeToken,
} from './unsubscribe-token';

export const NEWSLETTER_API_PATH = '/api/newsletters/:slug';
export const NEWSLETTER_SUBSCRIPTIONS_API_PATH = '/api/newsletters/:slug/subscriptions';
export const NEWSLETTER_CONFIRM_API_PATH = '/api/newsletters/:slug/subscriptions/confirm';
export const NEWSLETTER_UNSUBSCRIBE_API_PATH = '/api/newsletters/:slug/subscriptions/unsubscribe';

const CONFIRM_TOKEN_TTL_SECONDS = 48 * 60 * 60;
export const NEWSLETTER_INFO_CACHE_LIFETIME_SECONDS = 300;
const NEWSLETTER_SUBSCRIBE_MAX_BODY_BYTES = 256 * 1024;
const NEWSLETTER_CONFIRM_MAX_BODY_BYTES = 8 * 1024;
const NEWSLETTER_UNSUBSCRIBE_MAX_BODY_BYTES = 8 * 1024;

type PublicNewsletterResponse = {
  newsletter: ReturnType<typeof toPublicNewsletter>;
  fields: ReturnType<typeof toPublicNewsletterField>[];
};

export async function handleNewsletterRequest(request: Request, env: Env, slugSegment: string): Promise<Response> {
  const cors = resolveCorsContext(request, env);
  if (!cors.allowed) {
    return errorResponse(request, env, 'CORS_ORIGIN_DENIED', 'The request origin is not allowed.', 403, [], cors);
  }

  if (request.method === 'OPTIONS') {
    return handleOptionsRequest(cors);
  }

  if (request.method !== 'GET') {
    return errorResponse(request, env, 'METHOD_NOT_ALLOWED', 'Method Not Allowed', 405, [], cors, {
      allow: 'GET, OPTIONS',
    });
  }

  const queryError = validateQueryKeys(request, NEWSLETTER_ALLOWED_READ_QUERY_KEYS);
  if (queryError) {
    return errorResponse(request, env, queryError.code, queryError.message, 400, queryError.errors, cors);
  }

  const slug = parseNewsletterSlug(slugSegment);
  if (!slug) {
    return errorResponse(request, env, 'INVALID_NEWSLETTER_SLUG', 'Newsletter slug is invalid.', 400, [
      { field: 'slug', message: 'Expected a lowercase URL slug.' },
    ], cors);
  }

  const rateLimitResponse = await applyPublicRateLimit({
    request, env, cors,
    binding: 'NEWSLETTER_READ_RATE_LIMITER',
    key: getClientIP(request),
  });
  if (rateLimitResponse) {
    return rateLimitResponse;
  }

  try {
    const newsletter = await getActiveNewsletterBySlug(env, slug);
    if (!newsletter) {
      return errorResponse(request, env, 'NEWSLETTER_NOT_FOUND', 'Newsletter was not found.', 404, [], cors);
    }
    const cachedPayload = await getNewsletterInfoCache(env, slug);
    if (cachedPayload) {
      return jsonResponse({ item: cachedPayload }, 200, request, env, cors);
    }

    const fields = await getActiveNewsletterFields(env, newsletter.id);
    const payload: PublicNewsletterResponse = {
      newsletter: toPublicNewsletter(newsletter),
      fields: fields.map(toPublicNewsletterField),
    };
    await putNewsletterInfoCache(env, slug, payload);
    return jsonResponse({ item: payload }, 200, request, env, cors);
  } catch (error) {
    rethrowEdgeDatabaseLifecycleQueryFailure(error);
    logError('Newsletter read failed', { errorMessage: getLogErrorMessage(error) });
    return errorResponse(request, env, 'INTERNAL_ERROR', 'Internal Server Error', 500, [], cors);
  }
}

export async function handleNewsletterSubscriptionRequest(
  request: Request,
  env: Env,
  slugSegment: string,
  ctx?: ExecutionContext,
): Promise<Response> {
  const cors = resolveCorsContext(request, env);
  if (!cors.allowed) {
    return errorResponse(request, env, 'CORS_ORIGIN_DENIED', 'The request origin is not allowed.', 403, [], cors);
  }

  if (request.method === 'OPTIONS') {
    return handleOptionsRequest(cors);
  }

  if (request.method !== 'POST') {
    return errorResponse(request, env, 'METHOD_NOT_ALLOWED', 'Method Not Allowed', 405, [], cors, {
      allow: 'POST, OPTIONS',
    });
  }

  const queryError = validateQueryKeys(request, NEWSLETTER_ALLOWED_SUBSCRIBE_QUERY_KEYS);
  if (queryError) {
    return errorResponse(request, env, queryError.code, queryError.message, 400, queryError.errors, cors);
  }

  if (!isApplicationJsonContentType(request.headers.get('content-type'))) {
    return errorResponse(request, env, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json.', 415, [
      { field: 'content-type', message: 'Expected application/json.' },
    ], cors);
  }

  const slug = parseNewsletterSlug(slugSegment);
  if (!slug) {
    return errorResponse(request, env, 'INVALID_NEWSLETTER_SLUG', 'Newsletter slug is invalid.', 400, [
      { field: 'slug', message: 'Expected a lowercase URL slug.' },
    ], cors);
  }

  const bodyResult = await readBoundedJson(request, NEWSLETTER_SUBSCRIBE_MAX_BODY_BYTES);
  if (!bodyResult.ok && bodyResult.kind === 'too_large') {
    return errorResponse(
      request,
      env,
      'REQUEST_BODY_TOO_LARGE',
      'Request body exceeds the maximum allowed size.',
      413,
      [],
      cors,
    );
  }
  if (!bodyResult.ok) {
    return errorResponse(request, env, 'INVALID_JSON', 'Request body must be valid JSON.', 400, [], cors);
  }
  const rawBody = bodyResult.value;

  const commonErrors = validateSubscribeBodyCommon(rawBody);
  if (commonErrors.length > 0) {
    return errorResponse(request, env, 'VALIDATION_ERROR', 'Input validation failed.', 422, commonErrors, cors);
  }

  const sourceUrlResult = parseSubscribeSourceUrl(rawBody, request, env.ALLOWED_ORIGINS);
  if (sourceUrlResult.errors.length > 0 || !sourceUrlResult.value) {
    return errorResponse(request, env, 'VALIDATION_ERROR', 'Input validation failed.', 422, sourceUrlResult.errors, cors);
  }

  const rateLimitResponse = await applyPublicRateLimit({
    request, env, cors,
    binding: 'NEWSLETTER_SUBSCRIBE_RATE_LIMITER',
    key: getClientIP(request),
  });
  if (rateLimitResponse) {
    return rateLimitResponse;
  }

  const runtimeSettingsResult = await getEdgeRuntimeSettings(env);
  if (!runtimeSettingsResult.ok) {
    return errorResponse(
      request,
      env,
      runtimeSettingsResult.code,
      runtimeSettingsResult.message,
      503,
      [],
      cors,
    );
  }
  const { settings: runtimeSettings } = runtimeSettingsResult;
  const verificationMode = runtimeSettings.newsletterSubscribeVerificationMode;

  const envelopeErrors = validateSubscribeBodyEnvelope(rawBody, verificationMode);
  if (envelopeErrors.length > 0) {
    return errorResponse(request, env, 'VALIDATION_ERROR', 'Input validation failed.', 422, envelopeErrors, cors);
  }

  const verificationDescriptorResult = createWriteVerificationDescriptor(
    env,
    runtimeSettings.turnstileSitekey,
    verificationMode,
    'newsletter_subscribe',
  );
  if (!verificationDescriptorResult.ok) {
    return errorResponse(
      request,
      env,
      verificationDescriptorResult.code,
      verificationDescriptorResult.message,
      503,
      [],
      cors,
    );
  }

  const challengeFields = getSubscribeChallengeFields(rawBody);
  let challengeExpiresAtSeconds: number | undefined;
  if (verificationMode === 'pow') {
    const challengeResult = await verifyNewsletterChallenge(
      env,
      slug,
      'subscribe',
      challengeFields.token,
      challengeFields.solution,
    );
    if (!challengeResult.ok) {
      const status = challengeResult.code === 'NEWSLETTER_CHALLENGE_NOT_AVAILABLE' ? 503 : 403;
      return errorResponse(
        request,
        env,
        challengeResult.code ?? 'INVALID_NEWSLETTER_CHALLENGE',
        challengeResult.message ?? 'Newsletter challenge is invalid.',
        status,
        [],
        cors,
      );
    }
    challengeExpiresAtSeconds = challengeResult.expiresAtSeconds;
  } else {
    const turnstileRateLimitResult = await applyTurnstileVerifyRateLimit(
      env,
      'newsletter_subscribe',
      getClientIP(request),
    );
    if (!turnstileRateLimitResult.ok) {
      return errorResponse(
        request,
        env,
        turnstileRateLimitResult.code,
        turnstileRateLimitResult.message,
        turnstileRateLimitResult.kind === 'unavailable' ? 503 : 429,
        [],
        cors,
      );
    }

    const turnstileResult = await verifyTurnstileToken(env, {
      token: parseTurnstileToken(getSubscribeTurnstileTokenInput(rawBody)),
      action: 'newsletter_subscribe',
      request,
    });
    if (!turnstileResult.ok) {
      return errorResponse(
        request,
        env,
        turnstileResult.code,
        turnstileResult.message,
        turnstileResult.kind === 'unavailable' ? 503 : 403,
        [],
        cors,
      );
    }
  }

  try {
    const newsletter = await getActiveNewsletterBySlug(env, slug);
    if (!newsletter) {
      return errorResponse(request, env, 'NEWSLETTER_NOT_FOUND', 'Newsletter was not found.', 404, [], cors);
    }

    const fields = await getActiveNewsletterFields(env, newsletter.id);
    const parsedBody = parseSubscribeBody(rawBody, fields, verificationMode);
    if (parsedBody.errors.length > 0 || !parsedBody.value) {
      return errorResponse(request, env, 'VALIDATION_ERROR', 'Input validation failed.', 422, parsedBody.errors, cors);
    }

    if (await isNewsletterEmailSuppressed(env, parsedBody.value.email)) {
      return errorResponse(request, env, 'NEWSLETTER_SUPPRESSED', 'This email address cannot subscribe.', 403, [], cors);
    }

    const mailSettings = await getEdgeMailSettings(env);
    if (!mailSettings.newsletterConfirmationEnabled) {
      logWarn('Newsletter confirmation mail is disabled in edge_mail_settings', {
        code: 'NEWSLETTER_EMAIL_NOT_AVAILABLE',
        setting: 'edge_mail_settings.newsletter_confirmation_enabled',
        value: 0,
        newsletterSlug: newsletter.slug,
      });
      return errorResponse(
        request,
        env,
        'NEWSLETTER_EMAIL_NOT_AVAILABLE',
        'Newsletter subscription is temporarily unavailable.',
        503,
        [],
        cors,
      );
    }

    if (!env.MAIL_QUEUE) {
      logWarn('Newsletter confirmation mail queue binding is missing', {
        code: 'NEWSLETTER_EMAIL_NOT_AVAILABLE',
        binding: 'MAIL_QUEUE',
        newsletterSlug: newsletter.slug,
      });
      return errorResponse(
        request,
        env,
        'NEWSLETTER_EMAIL_NOT_AVAILABLE',
        'Newsletter subscription is temporarily unavailable.',
        503,
        [],
        cors,
      );
    }

    if (verificationMode === 'pow') {
      const usedChallengeResult = await consumeUsedChallenge(env, {
        scope: 'newsletter-subscribe',
        challengeToken: challengeFields.token,
        expiresAtSeconds: challengeExpiresAtSeconds ?? Math.floor(Date.now() / 1000),
        alreadyUsedCode: 'NEWSLETTER_CHALLENGE_ALREADY_USED',
        alreadyUsedMessage: 'Newsletter challenge has already been used.',
      });
      if (!usedChallengeResult.ok) {
        return errorResponse(
          request,
          env,
          usedChallengeResult.code ?? 'NEWSLETTER_CHALLENGE_ALREADY_USED',
          usedChallengeResult.message ?? 'Newsletter challenge has already been used.',
          403,
          [],
          cors,
        );
      }
    }

    const existingSubscription = await getNewsletterSubscriptionByEmail(env, newsletter.id, parsedBody.value.email);
    if (existingSubscription?.status === 'subscribed') {
      return acceptedResponse(request, env, cors);
    }

    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + CONFIRM_TOKEN_TTL_SECONDS * 1000);
    const now = formatDateToUtcSecondIso(issuedAt);
    const confirmExpiresAt = formatDateToUtcSecondIso(expiresAt);
    let clientMetadata;
    try {
      clientMetadata = await getClientNetworkMetadata(env, request, getClientIP(request));
    } catch (error) {
      if (error instanceof IpHashSecretUnavailableError) {
        return errorResponse(request, env, 'NEWSLETTER_IP_HASH_NOT_AVAILABLE', 'Newsletter subscriptions are temporarily unavailable.', 503, [], cors);
      }
      throw error;
    }
    const subscriptionId = existingSubscription?.id ?? createId();
    const token = await createNewsletterConfirmToken(env, {
      slug: newsletter.slug,
      subscriptionId,
      issuedAt,
      expiresAt,
    });
    const confirmTokenHash = await sha256Base64Url(token);
    const deliveryId = await reserveNewsletterConfirmation(env, {
      newsletterId: newsletter.id,
      email: parsedBody.value.email,
      subscriptionId,
      createSubscription: existingSubscription === null,
      confirmTokenHash,
      confirmExpiresAt,
      fieldValues: parsedBody.value.fieldValues,
      sourceUrl: sourceUrlResult.value,
      ipAddress: clientMetadata.ipAddress,
      ipHash: clientMetadata.ipHash,
      asn: clientMetadata.asn,
      asOrganization: clientMetadata.asOrganization,
      countryCode: clientMetadata.countryCode,
      userAgent: clientMetadata.userAgent,
      now,
    });

    if (deliveryId === null) {
      return acceptedResponse(request, env, cors);
    }

    try {
      await enqueueMailJob(env, {
        contract_version: EDGE_MAIL_QUEUE_CONTRACT_VERSION,
        type: 'newsletter.confirmation',
        delivery_id: deliveryId,
        subscription_id: subscriptionId,
        token,
        unsubscribe_token: createNewsletterUnsubscribeToken(
          subscriptionId,
        ),
      });
    } catch (error) {
      logWarn('Newsletter confirmation mail enqueue failed', {
        errorMessage: getLogErrorMessage(error),
        unavailable: error instanceof EdgeMailUnavailableError,
      });
      try {
        const failedAt = formatDateToUtcSecondIso(new Date());
        await markNewsletterConfirmationEmailFailed(
          env,
          subscriptionId,
          confirmTokenHash,
          getLogErrorMessage(error),
          failedAt,
        );
        await markNewsletterDeliveryEnqueueFailed(env, deliveryId, failedAt);
      } catch (markError) {
        logWarn('Failed to record newsletter confirmation enqueue failure', {
          errorMessage: getLogErrorMessage(markError),
          subscriptionId,
        });
      }
      return acceptedResponse(request, env, cors);
    }

    return acceptedResponse(request, env, cors);
  } catch (error) {
    rethrowEdgeDatabaseLifecycleQueryFailure(error);
    if (error instanceof NewsletterEmailSuppressedError) {
      return errorResponse(request, env, 'NEWSLETTER_SUPPRESSED', 'This email address cannot subscribe.', 403, [], cors);
    }

    if (error instanceof NewsletterConfirmTokenUnavailableError) {
      return errorResponse(
        request,
        env,
        error.code,
        'Newsletter confirmation could not be processed.',
        503,
        [],
        cors,
      );
    }

    logError('Newsletter subscription failed', { errorMessage: getLogErrorMessage(error) });
    return errorResponse(request, env, 'INTERNAL_ERROR', 'Internal Server Error', 500, [], cors);
  }
}

export async function handleNewsletterConfirmRequest(request: Request, env: Env, slugSegment: string): Promise<Response> {
  const cors = resolveCorsContext(request, env);
  if (!cors.allowed) {
    return errorResponse(request, env, 'CORS_ORIGIN_DENIED', 'The request origin is not allowed.', 403, [], cors);
  }

  if (request.method === 'OPTIONS') {
    return handleOptionsRequest(cors);
  }

  if (request.method !== 'POST') {
    return errorResponse(request, env, 'METHOD_NOT_ALLOWED', 'Method Not Allowed', 405, [], cors, {
      allow: 'POST, OPTIONS',
    });
  }

  const queryError = validateQueryKeys(request, NEWSLETTER_ALLOWED_CONFIRM_QUERY_KEYS);
  if (queryError) {
    return errorResponse(request, env, queryError.code, queryError.message, 400, queryError.errors, cors);
  }

  if (!isApplicationJsonContentType(request.headers.get('content-type'))) {
    return errorResponse(request, env, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json.', 415, [
      { field: 'content-type', message: 'Expected application/json.' },
    ], cors);
  }

  const slug = parseNewsletterSlug(slugSegment);
  if (!slug) {
    return errorResponse(request, env, 'INVALID_NEWSLETTER_SLUG', 'Newsletter slug is invalid.', 400, [
      { field: 'slug', message: 'Expected a lowercase URL slug.' },
    ], cors);
  }

  const bodyResult = await readBoundedJson(request, NEWSLETTER_CONFIRM_MAX_BODY_BYTES);
  if (!bodyResult.ok && bodyResult.kind === 'too_large') {
    return errorResponse(
      request,
      env,
      'REQUEST_BODY_TOO_LARGE',
      'Request body exceeds the maximum allowed size.',
      413,
      [],
      cors,
    );
  }
  if (!bodyResult.ok) {
    return errorResponse(request, env, 'INVALID_JSON', 'Request body must be valid JSON.', 400, [], cors);
  }
  const rawBody = bodyResult.value;

  const envelopeErrors = validateConfirmBodyEnvelope(rawBody);
  if (envelopeErrors.length > 0) {
    return errorResponse(request, env, 'VALIDATION_ERROR', 'Input validation failed.', 422, envelopeErrors, cors);
  }

  try {
    const token = parseConfirmBodyToken(rawBody);
    if (!token) {
      return errorResponse(
        request,
        env,
        'INVALID_NEWSLETTER_CONFIRMATION_TOKEN',
        'Newsletter confirmation token is invalid or has already been processed.',
        400,
        [],
        cors,
      );
    }

    const rateLimitResponse = await applyPublicRateLimit({
      request, env, cors,
      binding: 'NEWSLETTER_READ_RATE_LIMITER',
      key: `newsletter-confirm:${getClientIP(request)}`,
      rateLimitedMessage: 'Too many newsletter confirmation attempts. Try again later.',
    });
    if (rateLimitResponse) return rateLimitResponse;

    const tokenResult = await verifyNewsletterConfirmToken(env, slug, token);
    if (!tokenResult.ok) {
      if (tokenResult.code === 'EXPIRED') {
        return errorResponse(
          request,
          env,
          'EXPIRED_NEWSLETTER_CONFIRMATION_TOKEN',
          'Newsletter confirmation token has expired.',
          410,
          [],
          cors,
        );
      }
      if (tokenResult.code === 'NOT_AVAILABLE') {
        return errorResponse(
          request,
          env,
          'NEWSLETTER_CONFIRMATION_NOT_AVAILABLE',
          'Newsletter confirmation could not be processed.',
          503,
          [],
          cors,
        );
      }
      return errorResponse(
        request,
        env,
        'INVALID_NEWSLETTER_CONFIRMATION_TOKEN',
        'Newsletter confirmation token is invalid or has already been processed.',
        400,
        [],
        cors,
      );
    }

    const tokenHash = await sha256Base64Url(token);
    const subscription = await getPendingSubscriptionByIdAndConfirmTokenHash(
      env,
      slug,
      tokenResult.subscriptionId ?? '',
      tokenHash,
    );
    if (!subscription || subscription.status !== 'pending' || !subscription.confirm_expires_at) {
      return errorResponse(
        request,
        env,
        'INVALID_NEWSLETTER_CONFIRMATION_TOKEN',
        'Newsletter confirmation token is invalid or has already been processed.',
        400,
        [],
        cors,
      );
    }

    const expiresAt = new Date(subscription.confirm_expires_at);
    if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() < Date.now()) {
      return errorResponse(
        request,
        env,
        'EXPIRED_NEWSLETTER_CONFIRMATION_TOKEN',
        'Newsletter confirmation token has expired.',
        410,
        [],
        cors,
      );
    }

    const confirmed = await confirmNewsletterSubscription(
      env,
      slug,
      subscription.id,
      tokenHash,
      formatDateToUtcSecondIso(new Date()),
    );
    if (!confirmed) {
      return errorResponse(
        request,
        env,
        'INVALID_NEWSLETTER_CONFIRMATION_TOKEN',
        'Newsletter confirmation token is invalid or has already been processed.',
        400,
        [],
        cors,
      );
    }
    return jsonResponse({ status: 'confirmed' }, 200, request, env, cors);
  } catch (error) {
    rethrowEdgeDatabaseLifecycleQueryFailure(error);
    logError('Newsletter confirmation failed', { errorMessage: getLogErrorMessage(error) });
    return errorResponse(request, env, 'INTERNAL_ERROR', 'Internal Server Error', 500, [], cors);
  }
}

export async function handleNewsletterUnsubscribeRequest(
  request: Request,
  env: Env,
  slugSegment: string,
): Promise<Response> {
  const cors = resolveCorsContext(request, env);
  if (!cors.allowed) {
    return errorResponse(request, env, 'CORS_ORIGIN_DENIED', 'The request origin is not allowed.', 403, [], cors);
  }
  if (request.method === 'OPTIONS') return handleOptionsRequest(cors);
  if (request.method !== 'POST') {
    return errorResponse(request, env, 'METHOD_NOT_ALLOWED', 'Method Not Allowed', 405, [], cors, {
      allow: 'POST, OPTIONS',
    });
  }
  const queryError = validateQueryKeys(
    request,
    NEWSLETTER_ALLOWED_UNSUBSCRIBE_QUERY_KEYS,
  );
  if (queryError) {
    return errorResponse(request, env, queryError.code, queryError.message, 400, queryError.errors, cors);
  }
  if (!isApplicationJsonContentType(request.headers.get('content-type'))) {
    return errorResponse(request, env, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json.', 415, [
      { field: 'content-type', message: 'Expected application/json.' },
    ], cors);
  }
  const slug = parseNewsletterSlug(slugSegment);
  if (!slug) {
    return errorResponse(request, env, 'INVALID_NEWSLETTER_SLUG', 'Newsletter slug is invalid.', 400, [
      { field: 'slug', message: 'Expected a lowercase URL slug.' },
    ], cors);
  }
  const bodyResult = await readBoundedJson(
    request,
    NEWSLETTER_UNSUBSCRIBE_MAX_BODY_BYTES,
  );
  if (!bodyResult.ok && bodyResult.kind === 'too_large') {
    return errorResponse(
      request,
      env,
      'REQUEST_BODY_TOO_LARGE',
      'Request body exceeds the maximum allowed size.',
      413,
      [],
      cors,
    );
  }
  if (!bodyResult.ok) {
    return errorResponse(request, env, 'INVALID_JSON', 'Request body must be valid JSON.', 400, [], cors);
  }
  const envelopeErrors = validateUnsubscribeBodyEnvelope(bodyResult.value);
  if (envelopeErrors.length > 0) {
    return errorResponse(request, env, 'VALIDATION_ERROR', 'Input validation failed.', 422, envelopeErrors, cors);
  }
  const rawToken = (bodyResult.value as { token: string }).token;
  const subscriptionId = parseNewsletterUnsubscribeToken(rawToken);
  if (!subscriptionId) {
    return errorResponse(
      request,
      env,
      'INVALID_NEWSLETTER_UNSUBSCRIBE_TOKEN',
      'Newsletter unsubscribe token is invalid.',
      400,
      [],
      cors,
    );
  }
  const rateLimitResponse = await applyPublicRateLimit({
    request, env, cors,
    binding: 'NEWSLETTER_READ_RATE_LIMITER',
    key: `newsletter-unsubscribe:${getClientIP(request)}`,
    rateLimitedMessage: 'Too many newsletter unsubscribe attempts. Try again later.',
  });
  if (rateLimitResponse) return rateLimitResponse;

  try {
    await unsubscribeNewsletterSubscriptionById(
      env,
      slug,
      subscriptionId,
      formatDateToUtcSecondIso(new Date()),
    );
    // Do not reveal whether the opaque token selected a current subscription.
    return jsonResponse({ status: 'unsubscribed' }, 200, request, env, cors);
  } catch (error) {
    rethrowEdgeDatabaseLifecycleQueryFailure(error);
    logError('Newsletter unsubscribe failed', {
      errorMessage: getLogErrorMessage(error),
    });
    return errorResponse(request, env, 'INTERNAL_ERROR', 'Internal Server Error', 500, [], cors);
  }
}

function handleOptionsRequest(cors: ReturnType<typeof resolveCorsContext>): Response {
  return new Response(null, {
    status: 204,
    headers: withCorsHeaders(new Headers(), cors, true),
  });
}

async function getNewsletterInfoCache(env: Env, slug: string): Promise<PublicNewsletterResponse | null> {
  return getEdgeKvJsonValue<PublicNewsletterResponse>(env, getNewsletterInfoCacheKey(slug));
}

async function putNewsletterInfoCache(env: Env, slug: string, payload: PublicNewsletterResponse): Promise<void> {
  await putEdgeKvJsonValue(env, getNewsletterInfoCacheKey(slug), payload, NEWSLETTER_INFO_CACHE_LIFETIME_SECONDS);
}

function getNewsletterInfoCacheKey(slug: string): string {
  return `newsletter-info:v1:${slug}`;
}

function acceptedResponse(request: Request, env: Env, cors: ReturnType<typeof resolveCorsContext>): Response {
  return jsonResponse({ status: 'accepted' }, 202, request, env, cors);
}

function toPublicNewsletter(newsletter: NewsletterList) {
  return {
    slug: newsletter.slug,
    title: newsletter.title,
    description: newsletter.description,
  };
}
