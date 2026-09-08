import { describe, expect, it } from 'vitest';
import { signDerivedHmacSha256Base64Url, signHmacSha256Base64Url } from './crypto';

describe('crypto helpers', () => {
  it('derives purpose-specific HMAC signing keys from a master secret', async () => {
    const masterSecret = 'test-master-secret';
    const message = 'message';

    const newsletterSignature = await signDerivedHmacSha256Base64Url(
      masterSecret,
      'zeropress-edge/newsletter-challenge/v1',
      message,
    );
    const formSignature = await signDerivedHmacSha256Base64Url(
      masterSecret,
      'zeropress-edge/form-challenge/v1',
      message,
    );
    const repeatedNewsletterSignature = await signDerivedHmacSha256Base64Url(
      masterSecret,
      'zeropress-edge/newsletter-challenge/v1',
      message,
    );
    const rawSignature = await signHmacSha256Base64Url(masterSecret, message);

    expect(newsletterSignature).toBe(repeatedNewsletterSignature);
    expect(newsletterSignature).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(formSignature).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newsletterSignature).not.toBe(formSignature);
    expect(newsletterSignature).not.toBe(rawSignature);
  });
});
