const KEYCAP_EMOJI_PATTERN = /[0-9#*]\uFE0F?\u20E3/gu;
const EMOJI_PATTERN = /[\p{Extended_Pictographic}\p{Emoji_Presentation}\p{Emoji_Modifier}\p{Regional_Indicator}]/gu;
const EMOJI_FORMAT_PATTERN = /[\u200D\uFE0E\uFE0F]/g;
const CONTROL_CHARS_EXCEPT_LF_AND_TAB_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

export function normalizeSingleLineTextInput(value: string): string {
  return normalizeSingleLineFreeTextInput(stripEmojiCodePoints(value));
}

export function normalizeMultiLineTextInput(value: string): string {
  return normalizeMultiLineFreeTextInput(stripEmojiCodePoints(value));
}

// Free text preserves emoji, their joiners/variation selectors, and symbols.
export function normalizeSingleLineFreeTextInput(value: string): string {
  return normalizeLineEndings(value)
    .replace(CONTROL_CHARS_EXCEPT_LF_AND_TAB_PATTERN, '')
    .replace(/[\t\n]+/g, ' ')
    .trim();
}

export function normalizeMultiLineFreeTextInput(value: string): string {
  return normalizeLineEndings(value)
    .replace(CONTROL_CHARS_EXCEPT_LF_AND_TAB_PATTERN, '')
    .replace(/\t+/g, ' ')
    .replace(/[^\S\n]+\n/g, '\n')
    .replace(/\n[^\S\n]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function normalizeEmailTextInput(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }

  const normalized = normalizeSingleLineTextInput(trimmed);
  return normalized === trimmed ? normalized.toLowerCase() : null;
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

function stripEmojiCodePoints(value: string): string {
  return value
    .replace(KEYCAP_EMOJI_PATTERN, '')
    .replace(EMOJI_PATTERN, '')
    .replace(EMOJI_FORMAT_PATTERN, '');
}
