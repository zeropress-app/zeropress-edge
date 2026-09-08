import type { Env } from './env';
import { errorResponse } from './http';
import { getLogErrorMessage, logWarn } from './log';

export const EDGE_DATABASE_SCHEMA_VERSION = 1;

export type EdgeDatabaseLifecycleRow = {
  edge_schema_version?: unknown;
  edge_lifecycle_state?: unknown;
  edge_target_schema_version?: unknown;
  edge_active_operation_id?: unknown;
};

export const EDGE_DATABASE_LIFECYCLE_SELECT = `
  edge_schema.schema_version AS edge_schema_version,
  edge_schema.lifecycle_state AS edge_lifecycle_state,
  edge_schema.target_schema_version AS edge_target_schema_version,
  edge_schema.active_operation_id AS edge_active_operation_id
`;

export class EdgeDatabaseNotAvailableError extends Error {
  constructor(
    public readonly reason:
      | 'missing_state'
      | 'invalid_state'
      | 'schema_outdated'
      | 'schema_newer'
      | 'operation_in_progress'
      | 'query_failed',
    public readonly observed: EdgeDatabaseLifecycleRow | null = null,
    options?: { cause?: unknown },
  ) {
    super('The Edge database lifecycle is not ready.', options);
    this.name = 'EdgeDatabaseNotAvailableError';
  }
}

export function assertEdgeDatabaseReady(
  row: EdgeDatabaseLifecycleRow | null | undefined,
): void {
  if (!row) throw new EdgeDatabaseNotAvailableError('missing_state');
  const version = row.edge_schema_version;
  const lifecycle = row.edge_lifecycle_state;
  const target = row.edge_target_schema_version;
  const operation = row.edge_active_operation_id;
  if (
    typeof version !== 'number'
    || !Number.isInteger(version)
    || version < 1
    || typeof lifecycle !== 'string'
    || (target !== null && (!Number.isInteger(target) || Number(target) < 1))
    || (operation !== null && (
      typeof operation !== 'string'
      || !/^[0-9a-f]{32}$/u.test(operation)
    ))
  ) throw new EdgeDatabaseNotAvailableError('invalid_state', row);
  if (version < EDGE_DATABASE_SCHEMA_VERSION) {
    throw new EdgeDatabaseNotAvailableError('schema_outdated', row);
  }
  if (version > EDGE_DATABASE_SCHEMA_VERSION) {
    throw new EdgeDatabaseNotAvailableError('schema_newer', row);
  }
  if (lifecycle !== 'ready' || target !== null || operation !== null) {
    throw new EdgeDatabaseNotAvailableError(
      lifecycle === 'installing' || lifecycle === 'upgrading'
        ? 'operation_in_progress'
        : 'invalid_state',
      row,
    );
  }
}

export function rethrowEdgeDatabaseLifecycleQueryFailure(error: unknown): void {
  if (error instanceof EdgeDatabaseNotAvailableError) throw error;
  const message = getLogErrorMessage(error).toLowerCase();
  if (
    message.includes('zeropress_edge_schema_state')
    || message.includes('edge_schema')
  ) {
    throw new EdgeDatabaseNotAvailableError(
      'query_failed',
      null,
      { cause: error },
    );
  }
}

export function edgeDatabaseNotAvailableResponse(input: {
  request: Request;
  env: Env;
  error: EdgeDatabaseNotAvailableError;
}): Response {
  logEdgeDatabaseNotAvailable(input.error);
  return errorResponse(
    input.request,
    input.env,
    'EDGE_DATABASE_NOT_AVAILABLE',
    'The Edge database is temporarily unavailable.',
    503,
  );
}

export function logEdgeDatabaseNotAvailable(
  error: EdgeDatabaseNotAvailableError,
): void {
  const observed = error.observed;
  logWarn('Edge database is not available', {
    code: 'EDGE_DATABASE_NOT_AVAILABLE',
    service: 'edge-database-lifecycle',
    reason: error.reason,
    currentSchemaVersion: observed?.edge_schema_version,
    targetSchemaVersion: EDGE_DATABASE_SCHEMA_VERSION,
    lifecycleState: observed?.edge_lifecycle_state,
    activeOperationId: observed?.edge_active_operation_id,
    errorMessage: error.cause === undefined
      ? undefined
      : getLogErrorMessage(error.cause),
    guidance: 'For a fresh installation, initialize EDGE_DB through the Studio installer. For an existing database, use Studio Maintenance & Recovery to inspect and restore readiness.',
  });
}
