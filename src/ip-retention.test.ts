import { describe, expect, it, vi } from 'vitest';
import { expireStoredIpAddresses } from './ip-retention';
import type { Env } from './env';

describe('IP address retention', () => {
  it('expires timestamped old original IP addresses without touching hashes or metadata', async () => {
    const statements: Array<{ sql: string; args: unknown[] }> = [];
    const env = {
      EDGE_DB: {
        prepare: vi.fn((sql: string) => {
          if (sql.includes('edge_runtime_settings')) {
            return {
              first: vi.fn(async () => ({
                edge_schema_version: 1,
                edge_lifecycle_state: 'ready',
                edge_target_schema_version: null,
                edge_active_operation_id: null,
                runtime_settings_id: 1,
                comment_write_verification_mode: 'pow',
                newsletter_subscribe_verification_mode: 'pow',
                form_submit_verification_mode: 'pow',
                turnstile_sitekey: null,
                ip_address_retention_days: 30,
              })),
            };
          }

          return {
            bind: (...args: unknown[]) => {
              statements.push({ sql, args });
              return { sql, args };
            },
          };
        }),
        batch: vi.fn(async () => [
          { success: true, meta: { changes: 2, rows_written: 4 } },
          { success: true, meta: { changes: 3, rows_written: 6 } },
          { success: true, meta: { changes: 5, rows_written: 10 } },
        ]),
      },
    } as unknown as Env;

    const result = await expireStoredIpAddresses(env, new Date('2026-07-10T00:00:00.987Z'));

    expect(result).toEqual({
      cutoff: '2026-06-10T00:00:00Z',
      comments: 2,
      formSubmissions: 3,
      newsletterSubscriptions: 5,
    });
    expect(statements).toHaveLength(3);
    expect(statements.map((statement) => statement.args)).toEqual([
      ['2026-06-10T00:00:00Z'],
      ['2026-06-10T00:00:00Z'],
      ['2026-06-10T00:00:00Z'],
    ]);
    for (const statement of statements) {
      expect(statement.sql).toContain('SET ip_address = NULL');
      expect(statement.sql).toContain('ip_address IS NOT NULL');
      expect(statement.sql).toContain('ip_address_recorded_at IS NOT NULL');
      expect(statement.sql).toContain('ip_address_recorded_at < ?');
      expect(statement.sql).not.toContain('ip_address_recorded_at IS NULL');
      expect(statement.sql).not.toContain(' OR ');
      expect(statement.sql).not.toContain('ip_hash = NULL');
      expect(statement.sql).not.toContain('asn = NULL');
      expect(statement.sql).not.toContain('country_code = NULL');
    }
  });
});
