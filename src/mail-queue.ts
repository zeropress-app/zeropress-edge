import type { EdgeMailQueueMessage, Env } from './env';

export type EdgeMailSettings = {
  newsletterConfirmationEnabled: boolean;
};

export class EdgeMailUnavailableError extends Error {
  constructor(message = 'Edge mail queue is not available.') {
    super(message);
    this.name = 'EdgeMailUnavailableError';
  }
}

export async function getEdgeMailSettings(env: Env): Promise<EdgeMailSettings> {
  const row = await env.EDGE_DB.prepare(
    `SELECT newsletter_confirmation_enabled
     FROM edge_mail_settings
     WHERE id = 1`
  ).first<{
    newsletter_confirmation_enabled: number;
  }>();

  return {
    newsletterConfirmationEnabled: row?.newsletter_confirmation_enabled === 1,
  };
}

export async function enqueueMailJob(env: Env, message: EdgeMailQueueMessage): Promise<void> {
  if (!env.MAIL_QUEUE) {
    throw new EdgeMailUnavailableError();
  }

  await env.MAIL_QUEUE.send(message);
}
