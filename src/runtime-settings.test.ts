import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from './env';
import {
  getEdgeRuntimeSettings,
  parseEdgeRuntimeSettingsRow,
  type EdgeRuntimeSettingsRow,
} from './runtime-settings';

const VALID_ROW: EdgeRuntimeSettingsRow = {
  runtime_settings_id: 1,
  comment_write_verification_mode: 'pow',
  newsletter_subscribe_verification_mode: 'turnstile',
  form_submit_verification_mode: 'pow',
  turnstile_sitekey: 'public-site-key',
  ip_address_retention_days: 30,
};

const READY_LIFECYCLE_ROW = {
  edge_schema_version: 1,
  edge_lifecycle_state: 'ready',
  edge_target_schema_version: null,
  edge_active_operation_id: null,
} as const;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('edge runtime settings', () => {
  it('maps the typed singleton row without environment fallbacks', () => {
    expect(parseEdgeRuntimeSettingsRow(VALID_ROW)).toEqual({
      ok: true,
      settings: {
        commentWriteVerificationMode: 'pow',
        newsletterSubscribeVerificationMode: 'turnstile',
        formSubmitVerificationMode: 'pow',
        turnstileSitekey: 'public-site-key',
        ipAddressRetentionDays: 30,
      },
    });
  });

  it('allows a null sitekey only when every write uses PoW', () => {
    expect(parseEdgeRuntimeSettingsRow({
      ...VALID_ROW,
      newsletter_subscribe_verification_mode: 'pow',
      turnstile_sitekey: null,
    })).toMatchObject({ ok: true });

    expect(parseEdgeRuntimeSettingsRow({
      ...VALID_ROW,
      turnstile_sitekey: null,
    })).toMatchObject({
      ok: false,
      reason: 'invalid_row',
      invalidFields: ['turnstile_sitekey'],
    });
  });

  it.each([
    ['id', { runtime_settings_id: 2 }],
    ['comment_write_verification_mode', { comment_write_verification_mode: 'POW' }],
    ['newsletter_subscribe_verification_mode', { newsletter_subscribe_verification_mode: '' }],
    ['form_submit_verification_mode', { form_submit_verification_mode: 1 }],
    ['turnstile_sitekey', { turnstile_sitekey: ' padded ' }],
    ['turnstile_sitekey', { turnstile_sitekey: 'x'.repeat(257) }],
    ['ip_address_retention_days', { ip_address_retention_days: 0 }],
    ['ip_address_retention_days', { ip_address_retention_days: 366 }],
    ['ip_address_retention_days', { ip_address_retention_days: 30.5 }],
    ['ip_address_retention_days', { ip_address_retention_days: '30' }],
  ])('fails closed for invalid %s', (field, override) => {
    expect(parseEdgeRuntimeSettingsRow({ ...VALID_ROW, ...override })).toMatchObject({
      ok: false,
      code: 'EDGE_RUNTIME_SETTINGS_NOT_AVAILABLE',
      reason: 'invalid_row',
      invalidFields: [field],
    });
  });

  it('fails closed and logs operator guidance when the seeded row is missing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await getEdgeRuntimeSettings(mockEnvWithRuntimeRow(null));

    expect(result).toMatchObject({
      ok: false,
      code: 'EDGE_RUNTIME_SETTINGS_NOT_AVAILABLE',
      reason: 'missing_row',
    });
    expect(warn).toHaveBeenCalledWith({
      message: 'Edge runtime settings are unavailable',
      $zeropress: {
        code: 'EDGE_RUNTIME_SETTINGS_NOT_AVAILABLE',
        table: 'edge_runtime_settings',
        reason: 'missing_row',
        guidance: 'Use Studio Maintenance & Recovery to inspect EDGE_DB and repair the id=1 runtime settings row.',
      },
    });
  });

  it('fails closed and classifies D1 query failures', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const edgeDb = {
      prepare: vi.fn(() => ({
        first: vi.fn(async () => {
          throw new Error('D1 unavailable');
        }),
      })),
    } as unknown as D1Database;

    const result = await getEdgeRuntimeSettings({ EDGE_DB: edgeDb });

    expect(result).toMatchObject({
      ok: false,
      code: 'EDGE_RUNTIME_SETTINGS_NOT_AVAILABLE',
      reason: 'query_failed',
    });
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({
      $zeropress: expect.objectContaining({
        reason: 'query_failed',
        errorMessage: 'D1 unavailable',
      }),
    }));
  });
});

function mockEnvWithRuntimeRow(row: EdgeRuntimeSettingsRow | null): Pick<Env, 'EDGE_DB'> {
  return {
    EDGE_DB: {
      prepare: vi.fn(() => ({
        first: vi.fn(async () => row
          ? { ...READY_LIFECYCLE_ROW, ...row }
          : READY_LIFECYCLE_ROW),
      })),
    } as unknown as D1Database,
  };
}
