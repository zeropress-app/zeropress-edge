const NEWSLETTER_UNSUBSCRIBE_TOKEN_PATTERN = /^nu1\.([0-9a-f]{32})$/u;

export function createNewsletterUnsubscribeToken(
  subscriptionId: string,
): string {
  if (!/^[0-9a-f]{32}$/u.test(subscriptionId)) {
    throw new TypeError('Newsletter subscription ID is invalid.');
  }
  return `nu1.${subscriptionId}`;
}

export function parseNewsletterUnsubscribeToken(
  value: string,
): string | null {
  const match = value.trim().match(NEWSLETTER_UNSUBSCRIBE_TOKEN_PATTERN);
  return match?.[1] ?? null;
}
