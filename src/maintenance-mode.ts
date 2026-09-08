import type { Env } from './env';
import { errorResponse } from './http';

export type EdgeMaintenanceMode =
  | 'operational'
  | 'maintenance'
  | 'invalid';

/**
 * This safety gate deliberately accepts only the two documented literals.
 * Absence means normal operation, while every malformed configured value is
 * fail-closed so an operator typo cannot leave public writes running.
 */
export function resolveEdgeMaintenanceMode(
  value: string | undefined,
): EdgeMaintenanceMode {
  if (value === undefined || value === 'false') return 'operational';
  if (value === 'true') return 'maintenance';
  return 'invalid';
}

export function edgeMaintenanceResponse(input: {
  request: Request;
  env: Env;
  mode: Exclude<EdgeMaintenanceMode, 'operational'>;
}): Response {
  return input.mode === 'maintenance'
    ? errorResponse(
        input.request,
        input.env,
        'EDGE_MAINTENANCE',
        'The Edge API is temporarily unavailable for maintenance.',
        503,
      )
    : errorResponse(
        input.request,
        input.env,
        'EDGE_CONFIGURATION_ERROR',
        'The Edge Worker configuration is invalid.',
        503,
      );
}
