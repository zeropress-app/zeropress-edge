import { normalizeSingleLineTextInput } from './text-input';

const DECIMAL_NUMBER_PATTERN = /^-?\d+(?:\.\d+)?$/;

export function parseDecimalNumberInput(rawValue: unknown): string | null {
  if (typeof rawValue === 'number') {
    return Number.isFinite(rawValue) ? String(rawValue) : null;
  }

  if (typeof rawValue !== 'string') {
    return null;
  }

  const trimmed = rawValue.trim();
  const normalized = normalizeSingleLineTextInput(trimmed);
  if (normalized !== trimmed || !DECIMAL_NUMBER_PATTERN.test(normalized)) {
    return null;
  }

  const numericValue = Number(normalized);
  return Number.isFinite(numericValue) ? String(numericValue) : null;
}
