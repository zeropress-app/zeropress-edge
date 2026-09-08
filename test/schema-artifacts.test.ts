import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EDGE_DATABASE_SCHEMA_VERSION } from '../src/database-lifecycle';

type SchemaContract = {
  schema_version: number;
  minimum_supported_schema_version: number;
  state_table: string;
  supported_schema_catalogs: Array<{
    schema_version: number;
    sha256: string;
  }>;
  install_artifacts: Array<{
    id: string;
    file: string;
    sha256: string;
  }>;
  uninstall_artifact: {
    id: string;
    file: string;
    sha256: string;
  };
  upgrade_artifacts: Array<{
    id: string;
    file: string;
    from_version: number;
    to_version: number;
    sha256: string;
  }>;
};

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

function readSchemaContract(): SchemaContract {
  return JSON.parse(readFileSync(
    fileURLToPath(new URL('../database/schema-contract.json', import.meta.url)),
    'utf8',
  )) as SchemaContract;
}

describe('authoritative Edge database schema artifacts', () => {
  it('matches the reviewed contract and checksums', () => {
    const contract = readSchemaContract();
    expect(contract.schema_version).toBe(EDGE_DATABASE_SCHEMA_VERSION);
    expect(contract).toMatchObject({
      schema_version: 1,
      minimum_supported_schema_version: 1,
      state_table: 'zeropress_edge_schema_state',
      supported_schema_catalogs: [
        {
          schema_version: 1,
          sha256: 'd8068600f666766195aff82abaeae01413e6ed44a800a03444699cbcbed964f6',
        },
      ],
      install_artifacts: [
        {
          id: 'edge_install_baseline_v1',
        },
        {
          id: 'edge_install_seed_v1',
        },
      ],
      uninstall_artifact: {
        id: 'edge_uninstall_v1',
      },
      upgrade_artifacts: [],
    });
    for (const artifact of contract.install_artifacts) {
      const contents = readFileSync(fileURLToPath(new URL(
        `../database/${artifact.file}`,
        import.meta.url,
      )));
      expect(createHash('sha256').update(contents).digest('hex')).toBe(
        artifact.sha256,
      );
    }
    const uninstall = readFileSync(fileURLToPath(new URL(
      `../database/${contract.uninstall_artifact.file}`,
      import.meta.url,
    )));
    expect(createHash('sha256').update(uninstall).digest('hex')).toBe(
      contract.uninstall_artifact.sha256,
    );
    for (const artifact of contract.upgrade_artifacts) {
      const contents = readFileSync(fileURLToPath(new URL(
        `../database/${artifact.file}`,
        import.meta.url,
      )));
      expect(createHash('sha256').update(contents).digest('hex')).toBe(
        artifact.sha256,
      );
    }
  });

  it('drops every managed table and removes lifecycle state last', () => {
    const baseline = readFileSync(
      fileURLToPath(new URL('../database/install/001_edge_baseline.sql', import.meta.url)),
      'utf8',
    );
    const uninstall = readFileSync(
      fileURLToPath(new URL('../database/operations/001_uninstall.sql', import.meta.url)),
      'utf8',
    );
    const managedTables = [...baseline.matchAll(
      /^CREATE TABLE ([a-z][a-z0-9_]*)/gmu,
    )].map((match) => match[1]).sort();
    const droppedTables = [...uninstall.matchAll(
      /^DROP TABLE ([a-z][a-z0-9_]*)\s*;/gmu,
    )].map((match) => match[1]);
    expect([...droppedTables].sort()).toEqual(managedTables);
    expect(droppedTables.at(-1)).toBe('zeropress_edge_schema_state');
  });

  it('keeps fresh install non-destructive and lifecycle state last', () => {
    const baseline = readFileSync(
      fileURLToPath(new URL('../database/install/001_edge_baseline.sql', import.meta.url)),
      'utf8',
    );
    const seed = readFileSync(
      fileURLToPath(new URL('../database/install/002_edge_seed.sql', import.meta.url)),
      'utf8',
    );
    expect(baseline).not.toMatch(/\bDROP\s+(?:TABLE|INDEX|TRIGGER|VIEW)\b/iu);
    expect(seed.trimEnd()).toMatch(
      /INSERT INTO zeropress_edge_schema_state[\s\S]*?\);$/u,
    );
  });

  it('keeps the schema-upgrade inventory synchronized with the contract', () => {
    const contract = readSchemaContract();
    const upgradeFiles = readdirSync(
      `${projectRoot}/database/schema-upgrades`,
    )
      .filter((file) => file.endsWith('.sql'))
      .map((file) => `schema-upgrades/${file}`)
      .sort();
    const declaredFiles = contract.upgrade_artifacts
      .map((artifact) => artifact.file)
      .sort();

    expect(upgradeFiles).toEqual(declaredFiles);
  });
});
