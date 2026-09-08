import { describe, expect, it } from 'vitest';
import { resolveEdgeMaintenanceMode } from './maintenance-mode';

describe('Edge maintenance mode contract', () => {
  it.each([
    [undefined, 'operational'],
    ['false', 'operational'],
    ['true', 'maintenance'],
  ] as const)('resolves %j as %s', (value, expected) => {
    expect(resolveEdgeMaintenanceMode(value)).toBe(expected);
  });

  it.each([
    '',
    'TRUE',
    'False',
    '0',
    '1',
    'off',
    'on',
    ' false ',
    ' true ',
    'invalid',
  ])('rejects configured non-boolean literal %j', (value) => {
    expect(resolveEdgeMaintenanceMode(value)).toBe('invalid');
  });
});
