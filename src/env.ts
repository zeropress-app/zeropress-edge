export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  EDGE_DB: D1Database;
  EDGE_KV?: KVNamespace;
  MAIL_QUEUE?: Queue<EdgeMailQueueMessage>;
  COMMENTS_ENABLED?: string;
  NEWSLETTER_ENABLED?: string;
  FORMS_ENABLED?: string;
  EDGE_MAINTENANCE_MODE?: string;
  COMMENT_READ_RATE_LIMITER?: RateLimiter;
  COMMENT_WRITE_RATE_LIMITER?: RateLimiter;
  COMMENT_CHALLENGE_RATE_LIMITER?: RateLimiter;
  NEWSLETTER_READ_RATE_LIMITER?: RateLimiter;
  NEWSLETTER_SUBSCRIBE_RATE_LIMITER?: RateLimiter;
  NEWSLETTER_CHALLENGE_RATE_LIMITER?: RateLimiter;
  FORM_READ_RATE_LIMITER?: RateLimiter;
  FORM_SUBMIT_RATE_LIMITER?: RateLimiter;
  FORM_CHALLENGE_RATE_LIMITER?: RateLimiter;
  TURNSTILE_VERIFY_RATE_LIMITER?: RateLimiter;
  ALLOWED_ORIGINS?: string;
  TURNSTILE_SECRET_KEY?: string;
  EDGE_TOKEN_SIGNING_SECRET?: string;
  IP_HASH_SECRET?: string;
}

// Public Edge/Studio queue contract.
export const EDGE_MAIL_QUEUE_CONTRACT_VERSION = 1 as const;

export type EdgeMailQueueMessage =
  | {
      contract_version: typeof EDGE_MAIL_QUEUE_CONTRACT_VERSION;
      type: 'newsletter.confirmation';
      delivery_id: string;
      subscription_id: string;
      token: string;
      unsubscribe_token: string;
    }
  | {
      contract_version: typeof EDGE_MAIL_QUEUE_CONTRACT_VERSION;
      type: 'form.notification';
      submission_id: string;
      recipient_user_id: string;
    };
