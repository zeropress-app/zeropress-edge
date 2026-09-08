import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from './index';
import {
  assertEdgeDatabaseReady,
  EdgeDatabaseNotAvailableError,
} from './database-lifecycle';
import { createMockEnv } from './test-utils';

const AUTH_URL = 'https://edge.example/api/comments/auth';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Edge database lifecycle gate', () => {
  it.each([
    [null, 'missing_state'],
    [{
      edge_schema_version: 2,
      edge_lifecycle_state: 'ready',
      edge_target_schema_version: null,
      edge_active_operation_id: null,
    }, 'schema_newer'],
    [{
      edge_schema_version: 1,
      edge_lifecycle_state: 'upgrading',
      edge_target_schema_version: 2,
      edge_active_operation_id: 'a'.repeat(32),
    }, 'operation_in_progress'],
    [{
      edge_schema_version: 1,
      edge_lifecycle_state: 'ready',
      edge_target_schema_version: 1,
      edge_active_operation_id: null,
    }, 'invalid_state'],
  ] as const)('rejects a non-ready lifecycle row with %s', (row, reason) => {
    try {
      assertEdgeDatabaseReady(row);
      throw new Error('Expected lifecycle validation to fail.');
    } catch (error) {
      expect(error).toBeInstanceOf(EdgeDatabaseNotAvailableError);
      expect((error as EdgeDatabaseNotAvailableError).reason).toBe(reason);
    }
  });

  it.each([
    [null, 'missing_state'],
    [{
      edge_schema_version: 2,
      edge_lifecycle_state: 'ready',
      edge_target_schema_version: null,
      edge_active_operation_id: null,
    }, 'schema_newer'],
    [{
      edge_schema_version: 1,
      edge_lifecycle_state: 'upgrading',
      edge_target_schema_version: 2,
      edge_active_operation_id: 'b'.repeat(32),
    }, 'operation_in_progress'],
  ] as const)('fails an active public route closed for %s', async (lifecycle, reason) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { env, sqlCalls } = createMockEnv({ edgeLifecycle: lifecycle });

    const response = await worker.fetch(new Request(AUTH_URL), env);
    const payload = await response.json() as { error: { code: string } };

    expect(response.status).toBe(503);
    expect(payload.error.code).toBe('EDGE_DATABASE_NOT_AVAILABLE');
    expect(sqlCalls).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({
      $zeropress: expect.objectContaining({
        code: 'EDGE_DATABASE_NOT_AVAILABLE',
        reason,
        guidance: expect.stringContaining('Maintenance & Recovery'),
      }),
    }));
  });

  it('maps a missing lifecycle table query to the same operator-safe 503', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { env } = createMockEnv({
      lifecycleQueryError: new Error(
        'D1_ERROR: no such table: zeropress_edge_schema_state',
      ),
    });

    const response = await worker.fetch(new Request(AUTH_URL), env);
    const payload = await response.json() as { error: { code: string } };

    expect(response.status).toBe(503);
    expect(payload.error.code).toBe('EDGE_DATABASE_NOT_AVAILABLE');
  });

  it('fails scheduled retention closed while preserving lifecycle guidance', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { env } = createMockEnv({
      edgeLifecycle: {
        edge_schema_version: 1,
        edge_lifecycle_state: 'upgrading',
        edge_target_schema_version: 2,
        edge_active_operation_id: 'c'.repeat(32),
      },
    });

    await expect(worker.scheduled(
      {} as ScheduledController,
      env,
      {} as ExecutionContext,
    )).rejects.toBeInstanceOf(EdgeDatabaseNotAvailableError);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({
      $zeropress: expect.objectContaining({
        reason: 'operation_in_progress',
      }),
    }));
  });
});
