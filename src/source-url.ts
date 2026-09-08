import type { ApiErrorItem } from './http';

export type PublicSourceUrlResult = {
  value: string | null;
  errors: ApiErrorItem[];
};

export function parsePublicSourceUrl(
  rawValue: unknown,
  request: Request,
  allowedOriginsValue: string | undefined,
  options: {
    required: boolean;
    maxLength: number;
  },
): PublicSourceUrlResult {
  if (rawValue === undefined || rawValue === null || rawValue === '') {
    return options.required
      ? sourceUrlError('source_url is required.')
      : { value: null, errors: [] };
  }

  if (typeof rawValue !== 'string') {
    return sourceUrlError('source_url must be a string.');
  }

  const sourceUrlValue = rawValue.trim();
  if (!sourceUrlValue) {
    return options.required
      ? sourceUrlError('source_url is required.')
      : { value: null, errors: [] };
  }

  if (sourceUrlValue.length > options.maxLength) {
    return sourceUrlError(`source_url must be ${options.maxLength} characters or fewer.`);
  }

  let sourceUrl: URL;
  try {
    sourceUrl = new URL(sourceUrlValue);
  } catch {
    return sourceUrlError('source_url must be an absolute URL.');
  }

  if (!['http:', 'https:'].includes(sourceUrl.protocol)) {
    return sourceUrlError('source_url must use http or https.');
  }

  if (sourceUrl.username || sourceUrl.password) {
    return sourceUrlError('source_url must not include credentials.');
  }

  const requestOrigin = request.headers.get('Origin') || new URL(request.url).origin;
  const allowedOrigins = parseAllowedOrigins(allowedOriginsValue);
  if (sourceUrl.origin !== requestOrigin && !allowedOrigins.has(sourceUrl.origin)) {
    return sourceUrlError('source_url origin is not allowed.');
  }

  sourceUrl.hash = '';
  return {
    value: sourceUrl.toString(),
    errors: [],
  };
}

function sourceUrlError(message: string): PublicSourceUrlResult {
  return {
    value: null,
    errors: [{ field: 'source_url', message }],
  };
}

function parseAllowedOrigins(value: string | undefined): Set<string> {
  return new Set(
    String(value || '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}
