import type { ApiErrorItem } from '../http';
import { isRecord, normalizeBodyString } from '../http';
import { parseDecimalNumberInput } from '../number-input';
import { parsePublicSourceUrl } from '../source-url';
import { normalizeEmailTextInput, normalizeMultiLineTextInput, normalizeSingleLineTextInput } from '../text-input';
import type {
  NewsletterField,
  NewsletterFieldOption,
  NewsletterFieldValueInput,
  PublicNewsletterField,
} from './types';

export const NEWSLETTER_ALLOWED_READ_QUERY_KEYS = new Set<string>();
export const NEWSLETTER_ALLOWED_SUBSCRIBE_QUERY_KEYS = new Set<string>();
export const NEWSLETTER_ALLOWED_CONFIRM_QUERY_KEYS = new Set<string>();
export const NEWSLETTER_ALLOWED_UNSUBSCRIBE_QUERY_KEYS = new Set<string>();

const NEWSLETTER_ALLOWED_SUBSCRIBE_BASE_BODY_KEYS = new Set([
  'email',
  'fields',
  'source_url',
]);
const NEWSLETTER_ALLOWED_SUBSCRIBE_POW_BODY_KEYS = new Set([
  ...NEWSLETTER_ALLOWED_SUBSCRIBE_BASE_BODY_KEYS,
  'newsletter_challenge_token',
  'newsletter_challenge_solution',
]);
const NEWSLETTER_ALLOWED_SUBSCRIBE_TURNSTILE_BODY_KEYS = new Set([
  ...NEWSLETTER_ALLOWED_SUBSCRIBE_BASE_BODY_KEYS,
  'turnstile_token',
]);
const NEWSLETTER_ALLOWED_SUBSCRIBE_ANY_MODE_BODY_KEYS = new Set([
  ...NEWSLETTER_ALLOWED_SUBSCRIBE_POW_BODY_KEYS,
  ...NEWSLETTER_ALLOWED_SUBSCRIBE_TURNSTILE_BODY_KEYS,
]);
const NEWSLETTER_ALLOWED_CONFIRM_BODY_KEYS = new Set(['token']);
const NEWSLETTER_ALLOWED_UNSUBSCRIBE_BODY_KEYS = new Set(['token']);
const NEWSLETTER_CHALLENGE_TOKEN_BODY_KEY = 'newsletter_challenge_token';
const NEWSLETTER_CHALLENGE_SOLUTION_BODY_KEY = 'newsletter_challenge_solution';
const NEWSLETTER_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254;
const MAX_SOURCE_URL_LENGTH = 2048;
const MAX_TEXT_FIELD_LENGTH = 300;
const MAX_TEXTAREA_FIELD_LENGTH = 5000;
const MAX_URL_FIELD_LENGTH = 2048;
const MAX_OPTION_VALUE_LENGTH = 120;
const MAX_CHECKBOX_VALUES = 50;

export function validateSubscribeBodyCommon(rawBody: unknown): ApiErrorItem[] {
  if (!isRecord(rawBody) || Array.isArray(rawBody)) {
    return [{ message: 'Request body must be a JSON object.' }];
  }

  const errors: ApiErrorItem[] = [];
  Object.keys(rawBody).forEach((key) => {
    if (!NEWSLETTER_ALLOWED_SUBSCRIBE_ANY_MODE_BODY_KEYS.has(key)) {
      errors.push({ field: key, message: `Unsupported body field: ${key}.` });
    }
  });

  const email = normalizeEmail(rawBody.email);
  if (email === null) {
    errors.push({ field: 'email', message: 'Email must be a valid email address.' });
  } else if (!email) {
    errors.push({ field: 'email', message: 'Email is required.' });
  } else if (email.length > MAX_EMAIL_LENGTH) {
    errors.push({ field: 'email', message: `Email must be ${MAX_EMAIL_LENGTH} characters or fewer.` });
  } else if (!EMAIL_PATTERN.test(email)) {
    errors.push({ field: 'email', message: 'Email must be a valid email address.' });
  }

  const fields = rawBody.fields === undefined ? {} : rawBody.fields;
  if (!isRecord(fields) || Array.isArray(fields)) {
    errors.push({ field: 'fields', message: 'Fields must be a JSON object.' });
  }

  return errors;
}

export function parseNewsletterSlug(value: string): string {
  let slug = '';
  try {
    slug = decodeURIComponent(value).trim().toLowerCase();
  } catch {
    return '';
  }
  return NEWSLETTER_SLUG_PATTERN.test(slug) ? slug : '';
}

export function validateSubscribeBodyEnvelope(
  rawBody: unknown,
  verificationMode: 'pow' | 'turnstile' = 'pow',
): ApiErrorItem[] {
  if (!isRecord(rawBody) || Array.isArray(rawBody)) {
    return [{ message: 'Request body must be a JSON object.' }];
  }

  const errors: ApiErrorItem[] = [];
  const allowedBodyKeys = getSubscribeAllowedBodyKeys(verificationMode);
  Object.keys(rawBody).forEach((key) => {
    if (!allowedBodyKeys.has(key)) {
      errors.push({
        field: key,
        message: `Unsupported body field: ${key}.`,
      });
    }
  });
  return errors;
}

export function validateConfirmBodyEnvelope(rawBody: unknown): ApiErrorItem[] {
  if (!isRecord(rawBody) || Array.isArray(rawBody)) {
    return [{ message: 'Request body must be a JSON object.' }];
  }

  const errors: ApiErrorItem[] = [];
  Object.keys(rawBody).forEach((key) => {
    if (!NEWSLETTER_ALLOWED_CONFIRM_BODY_KEYS.has(key)) {
      errors.push({
        field: key,
        message: `Unsupported body field: ${key}.`,
      });
    }
  });
  return errors;
}

export function validateUnsubscribeBodyEnvelope(rawBody: unknown): ApiErrorItem[] {
  if (!isRecord(rawBody) || Array.isArray(rawBody)) {
    return [{ message: 'Request body must be a JSON object.' }];
  }

  const errors: ApiErrorItem[] = [];
  Object.keys(rawBody).forEach((key) => {
    if (!NEWSLETTER_ALLOWED_UNSUBSCRIBE_BODY_KEYS.has(key)) {
      errors.push({
        field: key,
        message: `Unsupported body field: ${key}.`,
      });
    }
  });
  if (typeof rawBody.token !== 'string' || !rawBody.token.trim()) {
    errors.push({ field: 'token', message: 'Unsubscribe token is required.' });
  }
  return errors;
}

export function getSubscribeChallengeFields(rawBody: unknown): {
  token: string;
  solution: string;
} {
  if (!isRecord(rawBody) || Array.isArray(rawBody)) {
    return { token: '', solution: '' };
  }

  return {
    token: normalizeBodyString(rawBody[NEWSLETTER_CHALLENGE_TOKEN_BODY_KEY]),
    solution: normalizeBodyString(rawBody[NEWSLETTER_CHALLENGE_SOLUTION_BODY_KEY]),
  };
}

export function getSubscribeTurnstileTokenInput(rawBody: unknown): unknown {
  if (!isRecord(rawBody) || Array.isArray(rawBody)) {
    return undefined;
  }

  return rawBody.turnstile_token;
}

export function parseSubscribeBody(
  rawBody: unknown,
  fields: NewsletterField[],
  verificationMode: 'pow' | 'turnstile' = 'pow',
): {
  value: {
    email: string;
    fieldValues: NewsletterFieldValueInput[];
  } | null;
  errors: ApiErrorItem[];
} {
  const errors: ApiErrorItem[] = [];
  if (!isRecord(rawBody) || Array.isArray(rawBody)) {
    return {
      value: null,
      errors: [{ message: 'Request body must be a JSON object.' }],
    };
  }

  const allowedBodyKeys = getSubscribeAllowedBodyKeys(verificationMode);
  Object.keys(rawBody).forEach((key) => {
    if (!allowedBodyKeys.has(key)) {
      errors.push({
        field: key,
        message: `Unsupported body field: ${key}.`,
      });
    }
  });

  const email = normalizeEmail((rawBody as { email?: unknown }).email);
  if (email === null) {
    errors.push({ field: 'email', message: 'Email must be a valid email address.' });
  } else if (!email) {
    errors.push({ field: 'email', message: 'Email is required.' });
  } else if (email.length > MAX_EMAIL_LENGTH) {
    errors.push({ field: 'email', message: `Email must be ${MAX_EMAIL_LENGTH} characters or fewer.` });
  } else if (!EMAIL_PATTERN.test(email)) {
    errors.push({ field: 'email', message: 'Email must be a valid email address.' });
  }

  const rawFields = (rawBody as { fields?: unknown }).fields;
  const fieldValuesInput = rawFields === undefined ? {} : rawFields;
  if (!isRecord(fieldValuesInput) || Array.isArray(fieldValuesInput)) {
    errors.push({ field: 'fields', message: 'Fields must be a JSON object.' });
  }

  const fieldValues: NewsletterFieldValueInput[] = [];
  const activeFieldMap = new Map(fields.map((field) => [field.field_key, field]));
  const fieldInput = isRecord(fieldValuesInput) && !Array.isArray(fieldValuesInput)
    ? fieldValuesInput
    : {};

  Object.keys(fieldInput).forEach((key) => {
    if (!activeFieldMap.has(key)) {
      errors.push({
        field: `fields.${key}`,
        message: `Unknown newsletter field: ${key}.`,
      });
    }
  });

  fields.forEach((field) => {
    const hasValue = Object.prototype.hasOwnProperty.call(fieldInput, field.field_key);
    const rawValue = fieldInput[field.field_key];
    const parsed = parseFieldValue(field, rawValue, hasValue);
    errors.push(...parsed.errors);
    if (parsed.value !== null) {
      fieldValues.push({
        fieldId: field.id,
        value: parsed.value,
      });
    }
  });

  return {
    value: errors.length > 0
      ? null
      : {
          email: email ?? '',
          fieldValues,
        },
    errors,
  };
}

function getSubscribeAllowedBodyKeys(verificationMode: 'pow' | 'turnstile'): Set<string> {
  return verificationMode === 'turnstile'
    ? NEWSLETTER_ALLOWED_SUBSCRIBE_TURNSTILE_BODY_KEYS
    : NEWSLETTER_ALLOWED_SUBSCRIBE_POW_BODY_KEYS;
}

export function parseSubscribeSourceUrl(
  rawBody: unknown,
  request: Request,
  allowedOriginsValue: string | undefined,
): {
  value: string | null;
  errors: ApiErrorItem[];
} {
  if (!isRecord(rawBody) || Array.isArray(rawBody)) {
    return {
      value: null,
      errors: [{ message: 'Request body must be a JSON object.' }],
    };
  }

  return parsePublicSourceUrl(rawBody.source_url, request, allowedOriginsValue, {
    required: true,
    maxLength: MAX_SOURCE_URL_LENGTH,
  });
}

export function parseConfirmBodyToken(rawBody: unknown): string {
  if (!isRecord(rawBody) || Array.isArray(rawBody)) {
    return '';
  }
  return normalizeBodyString(rawBody.token);
}

export function toPublicNewsletterField(field: NewsletterField): PublicNewsletterField {
  return {
    key: field.field_key,
    label: field.label,
    type: field.type,
    required: field.required === 1,
    options: parseFieldOptions(field),
    sort_order: field.sort_order,
  };
}

function parseFieldValue(field: NewsletterField, rawValue: unknown, hasValue: boolean): {
  value: string | null;
  errors: ApiErrorItem[];
} {
  const errors: ApiErrorItem[] = [];
  const fieldName = `fields.${field.field_key}`;

  if (
    !hasValue ||
    rawValue === null ||
    rawValue === undefined ||
    rawValue === '' ||
    (Array.isArray(rawValue) && rawValue.length === 0)
  ) {
    if (field.required === 1) {
      errors.push({ field: fieldName, message: 'Field is required.' });
    }
    return { value: null, errors };
  }

  if (field.type === 'text') {
    return parseLimitedString(fieldName, rawValue, MAX_TEXT_FIELD_LENGTH, 'single-line');
  }

  if (field.type === 'textarea') {
    return parseLimitedString(fieldName, rawValue, MAX_TEXTAREA_FIELD_LENGTH, 'multi-line');
  }

  if (field.type === 'url') {
    const parsed = parseLimitedString(fieldName, rawValue, MAX_URL_FIELD_LENGTH, 'single-line');
    if (parsed.value === null) return parsed;
    try {
      const url = new URL(parsed.value);
      if (!['http:', 'https:'].includes(url.protocol)) {
        return {
          value: null,
          errors: [{ field: fieldName, message: 'URL must use http or https.' }],
        };
      }
      return { value: url.toString(), errors: [] };
    } catch {
      return {
        value: null,
        errors: [{ field: fieldName, message: 'Field must be a valid URL.' }],
      };
    }
  }

  if (field.type === 'number') {
    const numericValue = parseDecimalNumberInput(rawValue);
    if (numericValue === null) {
      return {
        value: null,
        errors: [{ field: fieldName, message: 'Field must be a finite number.' }],
      };
    }
    return { value: numericValue, errors: [] };
  }

  if (field.type === 'boolean') {
    if (typeof rawValue !== 'boolean') {
      return {
        value: null,
        errors: [{ field: fieldName, message: 'Field must be a boolean.' }],
      };
    }
    return { value: rawValue ? 'true' : 'false', errors: [] };
  }

  if (field.type === 'select' || field.type === 'radio') {
    const parsed = parseLimitedString(fieldName, rawValue, MAX_OPTION_VALUE_LENGTH, 'single-line');
    if (parsed.value === null) return parsed;
    const options = parseFieldOptions(field);
    if (!options.some((option) => option.value === parsed.value)) {
      return {
        value: null,
        errors: [{ field: fieldName, message: 'Field value must match one of the configured options.' }],
      };
    }
    return { value: parsed.value, errors: [] };
  }

  if (field.type === 'checkbox') {
    if (!Array.isArray(rawValue) || rawValue.length > MAX_CHECKBOX_VALUES) {
      return {
        value: null,
        errors: [{ field: fieldName, message: `Field must be an array with ${MAX_CHECKBOX_VALUES} values or fewer.` }],
      };
    }

    const options = parseFieldOptions(field);
    const values: string[] = [];
    rawValue.forEach((entry, index) => {
      const value = typeof entry === 'string' ? normalizeSingleLineTextInput(entry) : '';
      if (!value || value.length > MAX_OPTION_VALUE_LENGTH) {
        errors.push({
          field: `${fieldName}.${index}`,
          message: `Checkbox value must be a non-empty string with ${MAX_OPTION_VALUE_LENGTH} characters or fewer.`,
        });
        return;
      }

      if (!options.some((option) => option.value === value)) {
        errors.push({ field: `${fieldName}.${index}`, message: 'Checkbox value must match one of the configured options.' });
        return;
      }

      if (!values.includes(value)) {
        values.push(value);
      }
    });

    return {
      value: errors.length > 0 ? null : JSON.stringify(values),
      errors,
    };
  }

  return {
    value: null,
    errors: [{ field: fieldName, message: 'Unsupported field type.' }],
  };
}

function parseLimitedString(
  field: string,
  rawValue: unknown,
  maxLength: number,
  mode: 'single-line' | 'multi-line',
): {
  value: string | null;
  errors: ApiErrorItem[];
} {
  if (typeof rawValue !== 'string') {
    return {
      value: null,
      errors: [{ field, message: 'Field must be a string.' }],
    };
  }

  const value = mode === 'multi-line'
    ? normalizeMultiLineTextInput(rawValue)
    : normalizeSingleLineTextInput(rawValue);
  if (!value) {
    return {
      value: null,
      errors: [{ field, message: 'Field must not be empty.' }],
    };
  }

  if (value.length > maxLength) {
    return {
      value: null,
      errors: [{ field, message: `Field must be ${maxLength} characters or fewer.` }],
    };
  }

  return { value, errors: [] };
}

function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') {
    return '';
  }

  return normalizeEmailTextInput(value);
}

function parseFieldOptions(field: NewsletterField): NewsletterFieldOption[] {
  if (!field.options_json) {
    return [];
  }

  let rawOptions: unknown;
  try {
    rawOptions = JSON.parse(field.options_json);
  } catch {
    return [];
  }

  if (!Array.isArray(rawOptions)) {
    return [];
  }

  const seenValues = new Set<string>();
  const options: NewsletterFieldOption[] = [];
  for (const option of rawOptions) {
    if (!isRecord(option)) {
      continue;
    }

    const value = typeof option.value === 'string'
      ? option.value.trim()
      : '';
    const label = typeof option.label === 'string'
      ? option.label.trim() || value
      : value;
    if (
      !value ||
      !label ||
      value.length > MAX_OPTION_VALUE_LENGTH ||
      label.length > MAX_OPTION_VALUE_LENGTH ||
      seenValues.has(value)
    ) {
      continue;
    }

    seenValues.add(value);
    options.push({ value, label });
  }
  return options;
}
