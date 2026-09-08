import { EDGE_MAIL_QUEUE_CONTRACT_VERSION, type Env } from '../env';
import { runInBackground } from '../background';
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
import { enqueueMailJob } from '../mail-queue';
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
import { verifyFormChallenge } from './challenge';
import { getActiveFormBySlug, getActiveFormFields, insertFormSubmission } from './repository';
import {
  FORM_ALLOWED_READ_QUERY_KEYS,
  FORM_ALLOWED_SUBMIT_QUERY_KEYS,
  getSubmitChallengeFields,
  getSubmitTurnstileTokenInput,
  parseFormSlug,
  parseSubmitBody,
  parseSubmitSourceUrl,
  toPublicFormField,
  validateSubmitBodyCommon,
  validateSubmitBodyEnvelope,
} from './validation';
import type { FormRecord } from './types';
import { rethrowEdgeDatabaseLifecycleQueryFailure } from '../database-lifecycle';

export const FORM_API_PATH = '/api/forms/:slug';
export const FORM_SUBMISSIONS_API_PATH = '/api/forms/:slug/submissions';

export const FORM_INFO_CACHE_LIFETIME_SECONDS = 300;
const FORM_SUBMISSION_MAX_BODY_BYTES = 256 * 1024;

type PublicFormResponse = {
  form: ReturnType<typeof toPublicForm>;
  fields: ReturnType<typeof toPublicFormField>[];
};

export async function handleFormRequest(request: Request, env: Env, slugSegment: string): Promise<Response> {
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

  const queryError = validateQueryKeys(request, FORM_ALLOWED_READ_QUERY_KEYS);
  if (queryError) {
    return errorResponse(request, env, queryError.code, queryError.message, 400, queryError.errors, cors);
  }

  const slug = parseFormSlug(slugSegment);
  if (!slug) {
    return errorResponse(request, env, 'INVALID_FORM_SLUG', 'Form slug is invalid.', 400, [
      { field: 'slug', message: 'Expected a lowercase URL slug.' },
    ], cors);
  }

  const rateLimitResponse = await applyPublicRateLimit({
    request, env, cors,
    binding: 'FORM_READ_RATE_LIMITER',
    key: getClientIP(request),
  });
  if (rateLimitResponse) {
    return rateLimitResponse;
  }

  try {
    const form = await getActiveFormBySlug(env, slug);
    if (!form) {
      return errorResponse(request, env, 'FORM_NOT_FOUND', 'Form was not found.', 404, [], cors);
    }
    const cachedPayload = await getFormInfoCache(env, slug);
    if (cachedPayload) {
      return jsonResponse({ item: cachedPayload }, 200, request, env, cors);
    }

    const fields = await getActiveFormFields(env, form.id);
    const payload: PublicFormResponse = {
      form: toPublicForm(form),
      fields: fields.map(toPublicFormField),
    };
    await putFormInfoCache(env, slug, payload);
    return jsonResponse({ item: payload }, 200, request, env, cors);
  } catch (error) {
    rethrowEdgeDatabaseLifecycleQueryFailure(error);
    logError('Form read failed', { errorMessage: getLogErrorMessage(error) });
    return errorResponse(request, env, 'INTERNAL_ERROR', 'Internal Server Error', 500, [], cors);
  }
}

export async function handleFormSubmissionRequest(
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

  const queryError = validateQueryKeys(request, FORM_ALLOWED_SUBMIT_QUERY_KEYS);
  if (queryError) {
    return errorResponse(request, env, queryError.code, queryError.message, 400, queryError.errors, cors);
  }

  if (!isApplicationJsonContentType(request.headers.get('content-type'))) {
    return errorResponse(request, env, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json.', 415, [
      { field: 'content-type', message: 'Expected application/json.' },
    ], cors);
  }

  const slug = parseFormSlug(slugSegment);
  if (!slug) {
    return errorResponse(request, env, 'INVALID_FORM_SLUG', 'Form slug is invalid.', 400, [
      { field: 'slug', message: 'Expected a lowercase URL slug.' },
    ], cors);
  }

  const bodyResult = await readBoundedJson(request, FORM_SUBMISSION_MAX_BODY_BYTES);
  if (!bodyResult.ok) {
    if (bodyResult.kind === 'too_large') {
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

    return errorResponse(request, env, 'INVALID_JSON', 'Request body must be valid JSON.', 400, [], cors);
  }
  const rawBody = bodyResult.value;

  const commonErrors = validateSubmitBodyCommon(rawBody);
  if (commonErrors.length > 0) {
    return errorResponse(request, env, 'VALIDATION_ERROR', 'Input validation failed.', 422, commonErrors, cors);
  }

  const sourceUrlResult = parseSubmitSourceUrl(rawBody, request, env.ALLOWED_ORIGINS);
  if (sourceUrlResult.errors.length > 0) {
    return errorResponse(request, env, 'VALIDATION_ERROR', 'Input validation failed.', 422, sourceUrlResult.errors, cors);
  }

  const rateLimitResponse = await applyPublicRateLimit({
    request, env, cors,
    binding: 'FORM_SUBMIT_RATE_LIMITER',
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
  const verificationMode = runtimeSettings.formSubmitVerificationMode;

  const envelopeErrors = validateSubmitBodyEnvelope(rawBody, verificationMode);
  if (envelopeErrors.length > 0) {
    return errorResponse(request, env, 'VALIDATION_ERROR', 'Input validation failed.', 422, envelopeErrors, cors);
  }

  const verificationDescriptorResult = createWriteVerificationDescriptor(
    env,
    runtimeSettings.turnstileSitekey,
    verificationMode,
    'form_submit',
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

  const challengeFields = getSubmitChallengeFields(rawBody);
  let challengeExpiresAtSeconds: number | undefined;
  if (verificationMode === 'pow') {
    const challengeResult = await verifyFormChallenge(env, slug, 'submit', challengeFields.token, challengeFields.solution);
    if (!challengeResult.ok) {
      const status = challengeResult.code === 'FORM_CHALLENGE_NOT_AVAILABLE' ? 503 : 403;
      return errorResponse(
        request,
        env,
        challengeResult.code ?? 'INVALID_FORM_CHALLENGE',
        challengeResult.message ?? 'Form challenge is invalid.',
        status,
        [],
        cors,
      );
    }
    challengeExpiresAtSeconds = challengeResult.expiresAtSeconds;
  } else {
    const turnstileRateLimitResult = await applyTurnstileVerifyRateLimit(env, 'form_submit', getClientIP(request));
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
      token: parseTurnstileToken(getSubmitTurnstileTokenInput(rawBody)),
      action: 'form_submit',
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
    const form = await getActiveFormBySlug(env, slug);
    if (!form) {
      return errorResponse(request, env, 'FORM_NOT_FOUND', 'Form was not found.', 404, [], cors);
    }

    const fields = await getActiveFormFields(env, form.id);
    const parsedBody = parseSubmitBody(rawBody, fields, sourceUrlResult.value, verificationMode);
    if (parsedBody.errors.length > 0 || !parsedBody.value) {
      return errorResponse(request, env, 'VALIDATION_ERROR', 'Input validation failed.', 422, parsedBody.errors, cors);
    }

    if (verificationMode === 'pow') {
      const usedChallengeResult = await consumeUsedChallenge(env, {
        scope: 'form-submit',
        challengeToken: challengeFields.token,
        expiresAtSeconds: challengeExpiresAtSeconds ?? Math.floor(Date.now() / 1000),
        alreadyUsedCode: 'FORM_CHALLENGE_ALREADY_USED',
        alreadyUsedMessage: 'Form challenge has already been used.',
      });
      if (!usedChallengeResult.ok) {
        return errorResponse(
          request,
          env,
          usedChallengeResult.code ?? 'FORM_CHALLENGE_ALREADY_USED',
          usedChallengeResult.message ?? 'Form challenge has already been used.',
          403,
          [],
          cors,
        );
      }
    }

    const now = formatDateToUtcSecondIso(new Date());
    let clientMetadata;
    try {
      clientMetadata = await getClientNetworkMetadata(env, request, getClientIP(request));
    } catch (error) {
      if (error instanceof IpHashSecretUnavailableError) {
        return errorResponse(request, env, 'FORM_IP_HASH_NOT_AVAILABLE', 'Form submissions are temporarily unavailable.', 503, [], cors);
      }
      throw error;
    }
    const submission = await insertFormSubmission(env, {
      formId: form.id,
      summary: parsedBody.value.summary,
      submitterEmail: parsedBody.value.submitterEmail,
      submitterName: parsedBody.value.submitterName,
      sourceUrl: parsedBody.value.sourceUrl,
      ipAddress: clientMetadata.ipAddress,
      ipHash: clientMetadata.ipHash,
      asn: clientMetadata.asn,
      asOrganization: clientMetadata.asOrganization,
      countryCode: clientMetadata.countryCode,
      userAgent: clientMetadata.userAgent,
      values: parsedBody.value.values,
      now,
    });

    if (form.notification_recipient_user_id) {
      await scheduleFormNotificationBestEffort(
        ctx,
        env,
        submission.id,
        form.notification_recipient_user_id,
      );
    }

    return jsonResponse({
      status: 'accepted',
      message: form.success_message || 'Your submission has been received.',
    }, 202, request, env, cors);
  } catch (error) {
    rethrowEdgeDatabaseLifecycleQueryFailure(error);
    logError('Form submission failed', { errorMessage: getLogErrorMessage(error) });
    return errorResponse(request, env, 'INTERNAL_ERROR', 'Internal Server Error', 500, [], cors);
  }
}

async function scheduleFormNotificationBestEffort(
  ctx: ExecutionContext | undefined,
  env: Env,
  submissionId: string,
  recipientUserId: string,
): Promise<void> {
  try {
    await runInBackground(
      ctx,
      sendFormNotificationBestEffort(env, submissionId, recipientUserId),
      'form-notification-email',
    );
  } catch (error) {
    logWarn('Form notification scheduling failed after submission storage', {
      submissionId,
      errorMessage: getLogErrorMessage(error),
    });
  }
}

async function sendFormNotificationBestEffort(
  env: Env,
  submissionId: string,
  recipientUserId: string,
): Promise<void> {
  try {
    if (!env.MAIL_QUEUE) {
      return;
    }

    await enqueueMailJob(env, {
      contract_version: EDGE_MAIL_QUEUE_CONTRACT_VERSION,
      type: 'form.notification',
      submission_id: submissionId,
      recipient_user_id: recipientUserId,
    });
  } catch (error) {
    logWarn('Form notification failed after submission storage', {
      submissionId,
      errorMessage: getLogErrorMessage(error),
    });
  }
}

function handleOptionsRequest(cors: ReturnType<typeof resolveCorsContext>): Response {
  return new Response(null, {
    status: 204,
    headers: withCorsHeaders(new Headers(), cors, true),
  });
}

async function getFormInfoCache(env: Env, slug: string): Promise<PublicFormResponse | null> {
  return getEdgeKvJsonValue<PublicFormResponse>(env, getFormInfoCacheKey(slug));
}

async function putFormInfoCache(env: Env, slug: string, payload: PublicFormResponse): Promise<void> {
  await putEdgeKvJsonValue(env, getFormInfoCacheKey(slug), payload, FORM_INFO_CACHE_LIFETIME_SECONDS);
}

function getFormInfoCacheKey(slug: string): string {
  return `form-info:v2:${slug}`;
}

function toPublicForm(form: FormRecord) {
  return {
    slug: form.slug,
    title: form.title,
    description: form.description,
    submit_label: form.submit_label,
    success_message: form.success_message,
  };
}
