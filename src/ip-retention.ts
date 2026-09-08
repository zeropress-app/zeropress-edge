import type { Env } from './env';
import { getEdgeRuntimeSettings } from './runtime-settings';
import { formatDateToUtcSecondIso } from './time';

const DAY_MS = 24 * 60 * 60 * 1000;

export type ExpireIpAddressResult = {
  cutoff: string;
  comments: number;
  formSubmissions: number;
  newsletterSubscriptions: number;
};

export async function expireStoredIpAddresses(env: Env, now = new Date()): Promise<ExpireIpAddressResult> {
  const runtimeSettingsResult = await getEdgeRuntimeSettings(env);
  if (!runtimeSettingsResult.ok) {
    throw new Error(runtimeSettingsResult.code);
  }
  const retentionDays = runtimeSettingsResult.settings.ipAddressRetentionDays;
  const cutoff = formatDateToUtcSecondIso(new Date(now.getTime() - retentionDays * DAY_MS));
  const [comments, formSubmissions, newsletterSubscriptions] = await env.EDGE_DB.batch([
    env.EDGE_DB.prepare(
      `UPDATE comments
       SET ip_address = NULL
       WHERE ip_address IS NOT NULL
         AND ip_address_recorded_at IS NOT NULL
         AND ip_address_recorded_at < ?`
    ).bind(cutoff),
    env.EDGE_DB.prepare(
      `UPDATE form_submissions
       SET ip_address = NULL
       WHERE ip_address IS NOT NULL
         AND ip_address_recorded_at IS NOT NULL
         AND ip_address_recorded_at < ?`
    ).bind(cutoff),
    env.EDGE_DB.prepare(
      `UPDATE newsletter_subscriptions
       SET ip_address = NULL
       WHERE ip_address IS NOT NULL
         AND ip_address_recorded_at IS NOT NULL
         AND ip_address_recorded_at < ?`
    ).bind(cutoff),
  ]);

  return {
    cutoff,
    comments: normalizeRowsChanged(comments),
    formSubmissions: normalizeRowsChanged(formSubmissions),
    newsletterSubscriptions: normalizeRowsChanged(newsletterSubscriptions),
  };
}

function normalizeRowsChanged(result: D1Result<unknown>): number {
  const changes = result.meta.changes;
  return typeof changes === 'number' && Number.isFinite(changes) ? changes : 0;
}
