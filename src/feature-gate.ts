export type EdgeFeatureGate =
  | 'enabled'
  | 'disabled'
  | 'invalid';

/**
 * Public features are explicit opt-in. Only the two documented literals are
 * accepted; absence is disabled and every malformed configured value is an
 * operator error that callers must fail closed.
 */
export function resolveEdgeFeatureGate(
  value: string | undefined,
): EdgeFeatureGate {
  if (value === undefined || value === 'false') return 'disabled';
  if (value === 'true') return 'enabled';
  return 'invalid';
}
