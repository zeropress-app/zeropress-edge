import { describe, expect, it } from 'vitest';
import {
  normalizeEmailTextInput,
  normalizeMultiLineFreeTextInput,
  normalizeMultiLineTextInput,
  normalizeSingleLineFreeTextInput,
  normalizeSingleLineTextInput,
} from './text-input';

describe('free-text input policy', () => {
  it.each([
    '© ® ™ ♥ ★ 😊',
    '👨‍👩‍👧‍👦 👍🏽 🇯🇵 1️⃣ #️⃣ *️⃣ ♥\uFE0E ♥\uFE0F',
    'ところで、今日は忙しいのでこの業務を処理できません。',
    '<b>text</b> & "quotes" \'apostrophes\' # * 1',
    'e\u0301 Ａ ①',
  ])('preserves authored Unicode and plain text: %s', (value) => {
    expect(normalizeSingleLineFreeTextInput(value)).toBe(value);
    expect(normalizeMultiLineFreeTextInput(value)).toBe(value);
  });

  it('removes C0/C1 controls and normalizes whitespace while preserving emoji', () => {
    const input = ' \u0000©😊\u0007\r\n \t👨‍👩‍👧‍👦 \r\n\r\n\r\n終\t\t了\u001B\u007F\u0085\u009F ';
    expect(normalizeSingleLineFreeTextInput(input))
      .toBe('©😊   👨‍👩‍👧‍👦  終 了');
    expect(normalizeMultiLineFreeTextInput(input))
      .toBe('©😊\n👨‍👩‍👧‍👦\n\n終 了');
    expect(normalizeMultiLineFreeTextInput(normalizeMultiLineFreeTextInput(input)))
      .toBe(normalizeMultiLineFreeTextInput(input));
  });

  it('keeps restricted text and email normalization separate from free text', () => {
    expect(normalizeSingleLineTextInput(' Alice\u0007 ©😊 1️⃣ ')).toBe('Alice');
    expect(normalizeMultiLineTextInput('Hello\u0000😀\r\n\r\n\r\nZero\tPress'))
      .toBe('Hello\n\nZero Press');
    expect(normalizeEmailTextInput(' Alice@Example.com ')).toBe('alice@example.com');
    expect(normalizeEmailTextInput('alice@example.com😊')).toBeNull();
    expect(normalizeEmailTextInput('alice©@example.com')).toBeNull();
  });
});
