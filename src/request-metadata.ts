import { signDerivedHmacSha256Base64Url } from './crypto';
import type { Env } from './env';
import { getIpHashSecret } from './ip-hash-secret';

const IP_HASH_HMAC_INFO = 'zeropress-edge/ip-hash/v1';

export type ClientNetworkMetadata = {
  ipAddress: string | null;
  ipHash: string | null;
  asn: number | null;
  asOrganization: string | null;
  countryCode: string | null;
  userAgent: string | null;
};

export class IpHashSecretUnavailableError extends Error {
  constructor() {
    super('IP_HASH_SECRET is missing or too short.');
    this.name = 'IpHashSecretUnavailableError';
  }
}

export async function hashClientIp(env: Env, ip: string): Promise<string | null> {
  const secret = getIpHashSecret(env);
  if (!secret) {
    throw new IpHashSecretUnavailableError();
  }

  const normalizedIp = normalizeIpAddress(ip);
  if (!normalizedIp) return null;

  const signature = await signDerivedHmacSha256Base64Url(secret, IP_HASH_HMAC_INFO, `v1:${normalizedIp}`);
  return `v1.${signature}`;
}

export async function getClientNetworkMetadata(env: Env, request: Request, clientIP: string): Promise<ClientNetworkMetadata> {
  const cf = readCloudflareRequestMetadata(request);
  return {
    ipAddress: normalizeIpAddress(clientIP),
    ipHash: await hashClientIp(env, clientIP),
    asn: normalizeAutonomousSystemNumber(cf?.asn),
    asOrganization: normalizeMetadataText(cf?.asOrganization, 255),
    countryCode: normalizeCountryCode(cf?.country),
    userAgent: normalizeUserAgent(request.headers.get('user-agent')),
  };
}

function normalizeIpAddress(value: string): string | null {
  const normalized = value.trim();
  if (!normalized || normalized === 'unknown' || normalized.length > 45) {
    return null;
  }
  return normalized;
}

export function normalizeUserAgent(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, 1000) : null;
}

function readCloudflareRequestMetadata(request: Request): Record<string, unknown> | null {
  const cf = (request as Request & { cf?: unknown }).cf;
  return typeof cf === 'object' && cf !== null && !Array.isArray(cf)
    ? cf as Record<string, unknown>
    : null;
}

function normalizeAutonomousSystemNumber(value: unknown): number | null {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0
    ? value
    : null;
}

function normalizeMetadataText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function normalizeCountryCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  return /^[A-Z0-9]{2,8}$/.test(normalized) ? normalized : null;
}
