import { handleCommentChallengeRequest } from './comments/challenge';
import { handleCommentsRequest } from './comments';
import { handleCommentsAuthRequest } from './comments/auth-discovery';
import type { Env } from './env';
import { errorResponse } from './http';
import { handleFormChallengeRequest } from './forms/challenge';
import { handleFormRequest, handleFormSubmissionRequest } from './forms';
import { expireStoredIpAddresses } from './ip-retention';
import { getLogErrorMessage, logError, logInfo } from './log';
import { handleNewsletterChallengeRequest } from './newsletters/challenge';
import {
  handleNewsletterConfirmRequest,
  handleNewsletterRequest,
  handleNewsletterSubscriptionRequest,
  handleNewsletterUnsubscribeRequest,
} from './newsletters';
import type { CommentTargetType } from './comments/types';
import {
  EdgeDatabaseNotAvailableError,
  edgeDatabaseNotAvailableResponse,
  logEdgeDatabaseNotAvailable,
  rethrowEdgeDatabaseLifecycleQueryFailure,
} from './database-lifecycle';
import {
  edgeMaintenanceResponse,
  resolveEdgeMaintenanceMode,
} from './maintenance-mode';
import { resolveEdgeFeatureGate } from './feature-gate';

export type { Env };

const COMMENTS_API_PATH_PATTERN = /^\/api\/(posts|pages)\/([^/]+)\/comments$/;
const COMMENTS_CHALLENGE_API_PATH_PATTERN = /^\/api\/(posts|pages)\/([^/]+)\/comments\/challenge\/([^/]+)$/;
const COMMENTS_AUTH_API_PATH = '/api/comments/auth';
const NEWSLETTER_API_PATH_PATTERN = /^\/api\/newsletters\/([^/]+)$/;
const NEWSLETTER_CHALLENGE_API_PATH_PATTERN = /^\/api\/newsletters\/([^/]+)\/challenge\/([^/]+)$/;
const NEWSLETTER_SUBSCRIPTIONS_API_PATH_PATTERN = /^\/api\/newsletters\/([^/]+)\/subscriptions$/;
const NEWSLETTER_CONFIRM_API_PATH_PATTERN = /^\/api\/newsletters\/([^/]+)\/subscriptions\/confirm$/;
const NEWSLETTER_UNSUBSCRIBE_API_PATH_PATTERN = /^\/api\/newsletters\/([^/]+)\/subscriptions\/unsubscribe$/;
const FORM_API_PATH_PATTERN = /^\/api\/forms\/([^/]+)$/;
const FORM_CHALLENGE_API_PATH_PATTERN = /^\/api\/forms\/([^/]+)\/challenge\/([^/]+)$/;
const FORM_SUBMISSIONS_API_PATH_PATTERN = /^\/api\/forms\/([^/]+)\/submissions$/;
const API_MODULE_PATH_PREFIXES = [
  '/api/posts/',
  '/api/pages/',
  '/api/comments/',
  '/api/newsletters/',
  '/api/forms/',
] as const;

function isApiModulePath(pathname: string): boolean {
  return API_MODULE_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function emptyNotFoundResponse(): Response {
  return new Response(null, {
    status: 404,
    headers: {
      'cache-control': 'private, no-store, max-age=0',
    },
  });
}

function featureGateResponse(input: {
  request: Request;
  env: Env;
  value: string | undefined;
  allowWhenDisabled?: boolean;
}): Response | null {
  const gate = resolveEdgeFeatureGate(input.value);
  if (gate === 'invalid') {
    return input.request.method === 'OPTIONS'
      ? null
      : errorResponse(
          input.request,
          input.env,
          'EDGE_CONFIGURATION_ERROR',
          'The Edge Worker configuration is invalid.',
          503,
        );
  }

  return gate === 'disabled' && input.allowWhenDisabled !== true
    ? emptyNotFoundResponse()
    : null;
}

export default {
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const maintenanceMode = resolveEdgeMaintenanceMode(
      env.EDGE_MAINTENANCE_MODE,
    );
    try {
      const maintenancePreflight = request.method === 'OPTIONS'
        && maintenanceMode !== 'operational';
      if (
        maintenanceMode !== 'operational'
        && request.method !== 'OPTIONS'
        && isApiModulePath(url.pathname)
      ) {
        // Do not log this request-level configuration failure. A remote caller
        // could otherwise amplify one operator typo into unbounded logs. The
        // daily scheduled path emits one actionable configuration diagnostic.
        return edgeMaintenanceResponse({
          request,
          env,
          mode: maintenanceMode,
        });
      }

      if (
        !maintenancePreflight
        && (
          url.pathname.startsWith('/api/posts/')
          || url.pathname.startsWith('/api/pages/')
          || url.pathname.startsWith('/api/comments/')
        )
      ) {
        const response = featureGateResponse({
          request,
          env,
          value: env.COMMENTS_ENABLED,
        });
        if (response) return response;
      }

    if (url.pathname === COMMENTS_AUTH_API_PATH) {
      return await handleCommentsAuthRequest(request, env);
    }

    const newsletterUnsubscribeMatch = url.pathname.match(
      NEWSLETTER_UNSUBSCRIBE_API_PATH_PATTERN,
    );

      if (
        !maintenancePreflight
        && url.pathname.startsWith('/api/newsletters/')
      ) {
        const response = featureGateResponse({
          request,
          env,
          value: env.NEWSLETTER_ENABLED,
          allowWhenDisabled: newsletterUnsubscribeMatch !== null,
        });
        if (response) return response;
      }

      if (
        !maintenancePreflight
        && url.pathname.startsWith('/api/forms/')
      ) {
        const response = featureGateResponse({
          request,
          env,
          value: env.FORMS_ENABLED,
        });
        if (response) return response;
      }

    const commentsMatch = url.pathname.match(COMMENTS_API_PATH_PATTERN);
    if (commentsMatch) {
      return await handleCommentsRequest(
        request,
        env,
        toCommentTargetType(commentsMatch[1]),
        commentsMatch[2],
        ctx,
      );
    }

    const challengeMatch = url.pathname.match(COMMENTS_CHALLENGE_API_PATH_PATTERN);
    if (challengeMatch) {
      return await handleCommentChallengeRequest(
        request,
        env,
        toCommentTargetType(challengeMatch[1]),
        challengeMatch[2],
        challengeMatch[3],
      );
    }

    const newsletterMatch = url.pathname.match(NEWSLETTER_API_PATH_PATTERN);
    if (newsletterMatch) {
      return await handleNewsletterRequest(request, env, newsletterMatch[1]);
    }

    const newsletterChallengeMatch = url.pathname.match(NEWSLETTER_CHALLENGE_API_PATH_PATTERN);
    if (newsletterChallengeMatch) {
      return await handleNewsletterChallengeRequest(
        request,
        env,
        newsletterChallengeMatch[1],
        newsletterChallengeMatch[2],
      );
    }

    const newsletterSubscriptionsMatch = url.pathname.match(NEWSLETTER_SUBSCRIPTIONS_API_PATH_PATTERN);
    if (newsletterSubscriptionsMatch) {
      return await handleNewsletterSubscriptionRequest(
        request,
        env,
        newsletterSubscriptionsMatch[1],
        ctx,
      );
    }

    const newsletterConfirmMatch = url.pathname.match(NEWSLETTER_CONFIRM_API_PATH_PATTERN);
    if (newsletterConfirmMatch) {
      return await handleNewsletterConfirmRequest(
        request,
        env,
        newsletterConfirmMatch[1],
      );
    }

    if (newsletterUnsubscribeMatch) {
      return await handleNewsletterUnsubscribeRequest(
        request,
        env,
        newsletterUnsubscribeMatch[1],
      );
    }

    const formMatch = url.pathname.match(FORM_API_PATH_PATTERN);
    if (formMatch) {
      return await handleFormRequest(request, env, formMatch[1]);
    }

    const formChallengeMatch = url.pathname.match(FORM_CHALLENGE_API_PATH_PATTERN);
    if (formChallengeMatch) {
      return await handleFormChallengeRequest(
        request,
        env,
        formChallengeMatch[1],
        formChallengeMatch[2],
      );
    }

    const formSubmissionsMatch = url.pathname.match(FORM_SUBMISSIONS_API_PATH_PATTERN);
    if (formSubmissionsMatch) {
      return await handleFormSubmissionRequest(
        request,
        env,
        formSubmissionsMatch[1],
        ctx,
      );
    }

      return isApiModulePath(url.pathname)
        ? errorResponse(request, env, 'NOT_FOUND', 'Not Found', 404)
        : emptyNotFoundResponse();
    } catch (error) {
      try {
        rethrowEdgeDatabaseLifecycleQueryFailure(error);
      } catch (lifecycleError) {
        if (lifecycleError instanceof EdgeDatabaseNotAvailableError) {
          return edgeDatabaseNotAvailableResponse({ request, env, error: lifecycleError });
        }
        throw lifecycleError;
      }
      throw error;
    }
  },
  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const maintenanceMode = resolveEdgeMaintenanceMode(
      env.EDGE_MAINTENANCE_MODE,
    );
    if (maintenanceMode === 'maintenance') return;
    if (maintenanceMode === 'invalid') {
      const error = new TypeError(
        'EDGE_MAINTENANCE_MODE must be exactly "true" or "false".',
      );
      logError('Edge Worker maintenance configuration is invalid', {
        code: 'EDGE_CONFIGURATION_ERROR',
        resource: 'worker-configuration',
        action: 'run_scheduled_ip_retention',
        guidance: 'Set EDGE_MAINTENANCE_MODE to exactly "true" or "false", then redeploy the Worker.',
      });
      throw error;
    }
    try {
      const result = await expireStoredIpAddresses(env);
      logInfo('Expired stored IP addresses', {
        cutoff: result.cutoff,
        comments: result.comments,
        formSubmissions: result.formSubmissions,
        newsletterSubscriptions: result.newsletterSubscriptions,
      });
    } catch (error) {
      if (error instanceof EdgeDatabaseNotAvailableError) {
        logEdgeDatabaseNotAvailable(error);
      }
      logError('Failed to expire stored IP addresses', {
        errorMessage: getLogErrorMessage(error),
      });
      throw error;
    }
  },
};

function toCommentTargetType(collection: string): CommentTargetType {
  return collection === 'pages' ? 'page' : 'post';
}
