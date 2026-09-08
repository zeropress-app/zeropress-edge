import { describe, expect, it } from 'vitest';
import { resolveEdgeFeatureGate } from './feature-gate';

describe('Edge public feature gate contract', () => {
  it.each([
    [undefined, 'disabled'],
    ['false', 'disabled'],
    ['true', 'enabled'],
  ] as const)('resolves %j as %s', (value, expected) => {
    expect(resolveEdgeFeatureGate(value)).toBe(expected);
  });

  it.each([
    '',
    'TRUE',
    'False',
    '0',
    '1',
    'off',
    'on',
    'no',
    'yes',
    ' false ',
    ' true ',
    'invalid',
  ])('rejects configured non-boolean literal %j', (value) => {
    expect(resolveEdgeFeatureGate(value)).toBe('invalid');
  });
});
