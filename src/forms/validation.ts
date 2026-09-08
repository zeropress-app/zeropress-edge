import type { ApiErrorItem } from '../http';
import { isRecord, normalizeBodyString } from '../http';
import { parseDecimalNumberInput } from '../number-input';
import { parsePublicSourceUrl } from '../source-url';
import {
  normalizeEmailTextInput,
  normalizeMultiLineFreeTextInput,
  normalizeSingleLineFreeTextInput,
  normalizeSingleLineTextInput,
} from '../text-input';
import type {
  FormField,
  FormFieldOption,
  FormSubmissionValueInput,
  PublicFormField,
} from './types';

export const FORM_ALLOWED_READ_QUERY_KEYS = new Set<string>();
export const FORM_ALLOWED_SUBMIT_QUERY_KEYS = new Set<string>();

const FORM_ALLOWED_SUBMIT_BASE_BODY_KEYS = new Set([
  'fields',
  'source_url',
]);
const FORM_ALLOWED_SUBMIT_POW_BODY_KEYS = new Set([
  ...FORM_ALLOWED_SUBMIT_BASE_BODY_KEYS,
  'form_challenge_token',
  'form_challenge_solution',
]);
const FORM_ALLOWED_SUBMIT_TURNSTILE_BODY_KEYS = new Set([
  ...FORM_ALLOWED_SUBMIT_BASE_BODY_KEYS,
  'turnstile_token',
]);
const FORM_ALLOWED_SUBMIT_ANY_MODE_BODY_KEYS = new Set([
  ...FORM_ALLOWED_SUBMIT_POW_BODY_KEYS,
  ...FORM_ALLOWED_SUBMIT_TURNSTILE_BODY_KEYS,
]);
const FORM_CHALLENGE_TOKEN_BODY_KEY = 'form_challenge_token';
const FORM_CHALLENGE_SOLUTION_BODY_KEY = 'form_challenge_solution';
const FORM_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_TEXT_FIELD_LENGTH = 300;
const MAX_TEXTAREA_FIELD_LENGTH = 5000;
const MAX_EMAIL_LENGTH = 254;
const MAX_PHONE_LENGTH = 80;
const MAX_OPTION_VALUE_LENGTH = 120;
const MAX_FIELD_OPTIONS = 50;
const MAX_CHECKBOX_VALUES = MAX_FIELD_OPTIONS;
const MAX_SOURCE_URL_LENGTH = 2048;

export function validateSubmitBodyCommon(rawBody: unknown): ApiErrorItem[] {
  if (!isRecord(rawBody) || Array.isArray(rawBody)) {
    return [{ message: 'Request body must be a JSON object.' }];
  }

  const errors: ApiErrorItem[] = [];
  Object.keys(rawBody).forEach((key) => {
    if (!FORM_ALLOWED_SUBMIT_ANY_MODE_BODY_KEYS.has(key)) {
      errors.push({ field: key, message: `Unsupported body field: ${key}.` });
    }
  });

  const fields = rawBody.fields === undefined ? {} : rawBody.fields;
  if (!isRecord(fields) || Array.isArray(fields)) {
    errors.push({ field: 'fields', message: 'Fields must be a JSON object.' });
  }

  return errors;
}

export function parseFormSlug(value: string): string {
  let slug = '';
  try {
    slug = decodeURIComponent(value).trim().toLowerCase();
  } catch {
    return '';
  }
  return FORM_SLUG_PATTERN.test(slug) ? slug : '';
}

export function validateSubmitBodyEnvelope(
  rawBody: unknown,
  verificationMode: 'pow' | 'turnstile' = 'pow',
): ApiErrorItem[] {
  if (!isRecord(rawBody) || Array.isArray(rawBody)) {
    return [{ message: 'Request body must be a JSON object.' }];
  }

  const errors: ApiErrorItem[] = [];
  const allowedBodyKeys = getSubmitAllowedBodyKeys(verificationMode);
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

export function getSubmitChallengeFields(rawBody: unknown): {
  token: string;
  solution: string;
} {
  if (!isRecord(rawBody) || Array.isArray(rawBody)) {
    return { token: '', solution: '' };
  }

  return {
    token: normalizeBodyString(rawBody[FORM_CHALLENGE_TOKEN_BODY_KEY]),
    solution: normalizeBodyString(rawBody[FORM_CHALLENGE_SOLUTION_BODY_KEY]),
  };
}

export function getSubmitTurnstileTokenInput(rawBody: unknown): unknown {
  if (!isRecord(rawBody) || Array.isArray(rawBody)) {
    return undefined;
  }

  return rawBody.turnstile_token;
}

export function parseSubmitBody(
  rawBody: unknown,
  fields: FormField[],
  sourceUrl: string | null,
  verificationMode: 'pow' | 'turnstile' = 'pow',
): {
  value: {
    values: FormSubmissionValueInput[];
    summary: string | null;
    submitterEmail: string | null;
    submitterName: string | null;
    sourceUrl: string | null;
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

  const allowedBodyKeys = getSubmitAllowedBodyKeys(verificationMode);
  Object.keys(rawBody).forEach((key) => {
    if (!allowedBodyKeys.has(key)) {
      errors.push({
        field: key,
        message: `Unsupported body field: ${key}.`,
      });
    }
  });

  const rawFields = rawBody.fields === undefined ? {} : rawBody.fields;
  if (!isRecord(rawFields) || Array.isArray(rawFields)) {
    errors.push({ field: 'fields', message: 'Fields must be a JSON object.' });
  }

  const fieldInput = isRecord(rawFields) && !Array.isArray(rawFields) ? rawFields : {};
  const activeFieldMap = new Map(fields.map((field) => [field.field_key, field]));
  Object.keys(fieldInput).forEach((key) => {
    if (!activeFieldMap.has(key)) {
      errors.push({
        field: `fields.${key}`,
        message: `Unknown form field: ${key}.`,
      });
    }
  });

  const values: FormSubmissionValueInput[] = [];
  fields.forEach((field) => {
    const hasValue = Object.prototype.hasOwnProperty.call(fieldInput, field.field_key);
    const parsed = parseFieldValue(field, fieldInput[field.field_key], hasValue);
    errors.push(...parsed.errors);
    if (parsed.value !== null) {
      values.push({
        fieldId: field.id,
        fieldKey: field.field_key,
        fieldLabel: field.label,
        fieldType: field.type,
        value: parsed.value,
      });
    }
  });

  return {
    value: errors.length > 0
      ? null
      : {
          values,
          summary: buildSummary(values),
          submitterEmail: findSubmitterEmail(fields, values),
          submitterName: findSubmitterName(fields, values),
          sourceUrl,
        },
    errors,
  };
}

function getSubmitAllowedBodyKeys(verificationMode: 'pow' | 'turnstile'): Set<string> {
  return verificationMode === 'turnstile'
    ? FORM_ALLOWED_SUBMIT_TURNSTILE_BODY_KEYS
    : FORM_ALLOWED_SUBMIT_POW_BODY_KEYS;
}

export function parseSubmitSourceUrl(
  rawBody: unknown,
  request: Request,
  allowedOriginsValue: string | undefined,
) {
  if (!isRecord(rawBody) || Array.isArray(rawBody)) {
    return {
      value: null,
      errors: [{ message: 'Request body must be a JSON object.' }],
    };
  }

  return parsePublicSourceUrl(rawBody.source_url, request, allowedOriginsValue, {
    required: false,
    maxLength: MAX_SOURCE_URL_LENGTH,
  });
}

export function toPublicFormField(field: FormField): PublicFormField {
  return {
    key: field.field_key,
    label: field.label,
    type: field.type,
    required: field.required === 1,
    placeholder: field.placeholder ?? null,
    help_text: field.help_text ?? null,
    options: parseFieldOptions(field),
    sort_order: field.sort_order,
  };
}

function parseFieldValue(field: FormField, rawValue: unknown, hasValue: boolean): {
  value: string | null;
  errors: ApiErrorItem[];
} {
  const fieldName = `fields.${field.field_key}`;
  const isEmpty = !hasValue ||
    rawValue === null ||
    rawValue === undefined ||
    rawValue === '' ||
    (Array.isArray(rawValue) && rawValue.length === 0);

  if (isEmpty) {
    if (field.required === 1) {
      return { value: null, errors: [{ field: fieldName, message: 'Field is required.' }] };
    }
    return { value: null, errors: [] };
  }

  if (field.type === 'text') {
    return parseLimitedString(fieldName, rawValue, MAX_TEXT_FIELD_LENGTH, normalizeSingleLineFreeTextInput);
  }

  if (field.type === 'textarea') {
    return parseLimitedString(fieldName, rawValue, MAX_TEXTAREA_FIELD_LENGTH, normalizeMultiLineFreeTextInput);
  }

  if (field.type === 'email') {
    const parsed = parseEmailString(fieldName, rawValue, MAX_EMAIL_LENGTH);
    if (parsed.value === null) return parsed;
    const email = parsed.value;
    return EMAIL_PATTERN.test(email)
      ? { value: email, errors: [] }
      : { value: null, errors: [{ field: fieldName, message: 'Field must be a valid email address.' }] };
  }

  if (field.type === 'number') {
    const numericValue = parseDecimalNumberInput(rawValue);
    if (numericValue === null) {
      return { value: null, errors: [{ field: fieldName, message: 'Field must be a finite number.' }] };
    }
    return { value: numericValue, errors: [] };
  }

  if (field.type === 'date') {
    const parsed = parseLimitedString(fieldName, rawValue, 10, normalizeSingleLineTextInput);
    if (parsed.value === null) return parsed;
    return isValidDateInput(parsed.value)
      ? parsed
      : { value: null, errors: [{ field: fieldName, message: 'Field must be a valid date in YYYY-MM-DD format.' }] };
  }

  if (field.type === 'phone') {
    return parseLimitedString(fieldName, rawValue, MAX_PHONE_LENGTH, normalizeSingleLineTextInput);
  }

  if (field.type === 'select' || field.type === 'radio') {
    const parsed = parseLimitedString(fieldName, rawValue, MAX_OPTION_VALUE_LENGTH, normalizeSingleLineTextInput);
    if (parsed.value === null) return parsed;
    const options = parseFieldOptions(field);
    return options.some((option) => option.value === parsed.value)
      ? { value: parsed.value, errors: [] }
      : { value: null, errors: [{ field: fieldName, message: 'Field value must match one of the configured options.' }] };
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
    const errors: ApiErrorItem[] = [];
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
  normalizeInput: (value: string) => string,
): {
  value: string | null;
  errors: ApiErrorItem[];
} {
  if (typeof rawValue !== 'string') {
    return { value: null, errors: [{ field, message: 'Field must be a string.' }] };
  }

  const value = normalizeInput(rawValue);
  if (!value) {
    return { value: null, errors: [{ field, message: 'Field must not be empty.' }] };
  }

  if (value.length > maxLength) {
    return { value: null, errors: [{ field, message: `Field must be ${maxLength} characters or fewer.` }] };
  }

  return { value, errors: [] };
}

function parseEmailString(field: string, rawValue: unknown, maxLength: number): {
  value: string | null;
  errors: ApiErrorItem[];
} {
  if (typeof rawValue !== 'string') {
    return { value: null, errors: [{ field, message: 'Field must be a string.' }] };
  }

  const value = normalizeEmailTextInput(rawValue);
  if (value === null) {
    return { value: null, errors: [{ field, message: 'Field must be a valid email address.' }] };
  }

  if (!value) {
    return { value: null, errors: [{ field, message: 'Field must not be empty.' }] };
  }

  if (value.length > maxLength) {
    return { value: null, errors: [{ field, message: `Field must be ${maxLength} characters or fewer.` }] };
  }

  return { value, errors: [] };
}

function buildSummary(values: FormSubmissionValueInput[]): string | null {
  const summary = values
    .map((value) => displayFieldValue(value.value))
    .filter(Boolean)
    .slice(0, 3)
    .join(', ');
  return summary ? summary.slice(0, 300) : null;
}

function findSubmitterEmail(fields: FormField[], values: FormSubmissionValueInput[]): string | null {
  const emailField = fields.find((field) => field.type === 'email');
  if (!emailField) return null;
  return values.find((value) => value.fieldId === emailField.id)?.value ?? null;
}

function findSubmitterName(fields: FormField[], values: FormSubmissionValueInput[]): string | null {
  const nameKeys = new Set(['name', 'full_name', 'first_name', 'contact_name']);
  const namedField = fields.find((field) => (
    nameKeys.has(field.field_key) &&
    (field.type === 'text' || field.type === 'textarea')
  ));
  if (namedField) {
    return values.find((value) => value.fieldId === namedField.id)?.value ?? null;
  }

  const textField = fields.find((field) => field.type === 'text');
  return textField
    ? values.find((value) => value.fieldId === textField.id)?.value ?? null
    : null;
}

function displayFieldValue(value: string): string {
  if (value.startsWith('[')) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed.join(', ');
      }
    } catch {
      return value;
    }
  }
  return value.replace(/\s+/g, ' ');
}

function parseFieldOptions(field: FormField): FormFieldOption[] {
  if (!field.options_json) return [];
  try {
    const parsed = JSON.parse(field.options_json) as unknown;
    if (!Array.isArray(parsed)) return [];
    const seenValues = new Set<string>();
    const options: FormFieldOption[] = [];
    for (const option of parsed) {
      if (options.length >= MAX_FIELD_OPTIONS) {
        break;
      }
      if (!isRecord(option) || typeof option.value !== 'string' || typeof option.label !== 'string') {
        continue;
      }

      const value = normalizeSingleLineTextInput(option.value);
      const label = option.label.trim();
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
  } catch {
    return [];
  }
}

function isValidDateInput(value: string): boolean {
  if (!DATE_PATTERN.test(value)) {
    return false;
  }

  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
