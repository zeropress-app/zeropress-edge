import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BASE_CONFIG_PATH,
  composeWranglerConfig,
  EXAMPLE_OVERRIDE_PATH,
  forceLocalBindings,
  INSTALLATION_RATE_LIMIT_BINDINGS,
  OUTPUT_PATHS,
  PROJECT_ROOT,
  readConfigFragment,
  stripDevelopmentBindingFields,
  validateInstallationConfig,
} from './compose-wrangler-config.mjs';

const CI_OVERRIDE_PATH = join(
  PROJECT_ROOT,
  'scripts/fixtures/wrangler.override.ci.jsonc',
);

function installationOverride() {
  return {
    name: 'customer-edge',
    d1_databases: [
      {
        binding: 'EDGE_DB',
        database_name: 'customer-edge-db',
        remote: false,
      },
    ],
    kv_namespaces: [
      {
        binding: 'EDGE_KV',
        id: '1234567890abcdef1234567890abcdef',
        remote: false,
      },
    ],
    queues: {
      producers: [
        {
          binding: 'MAIL_QUEUE',
          queue: 'customer-edge-mail',
          remote: false,
        },
      ],
    },
    ratelimits: INSTALLATION_RATE_LIMIT_BINDINGS.map((name, index) => ({
      name,
      namespace_id: String(700001 + index),
    })),
  };
}

describe('Wrangler config composition', () => {
  it('keeps vendor behavior in the base and moves installation targets into the override', () => {
    const base = readConfigFragment(BASE_CONFIG_PATH);
    expect(base).toMatchObject({
      name: 'zeropress-edge',
      main: 'src/index.ts',
      compatibility_date: '2026-09-07',
      keep_vars: true,
      d1_databases: [
        {
          binding: 'EDGE_DB',
          database_name: 'zeropress-edge-build',
          remote: false,
        },
      ],
      kv_namespaces: [
        {
          binding: 'EDGE_KV',
          id: '00000000000000000000000000000000',
          remote: false,
        },
      ],
    });
    expect(base).not.toHaveProperty('vars');
    expect(base.ratelimits.map(({ name }) => name)).toEqual(
      INSTALLATION_RATE_LIMIT_BINDINGS,
    );
    const exampleRateLimits = readConfigFragment(
      EXAMPLE_OVERRIDE_PATH,
    ).ratelimits;
    expect(exampleRateLimits.map(({ name }) => name))
      .toEqual(INSTALLATION_RATE_LIMIT_BINDINGS);
    expect(exampleRateLimits.every((binding) => (
      Object.keys(binding).sort().join(',') === 'name,namespace_id'
    ))).toBe(true);
  });

  it('merges binding arrays by their stable binding name', () => {
    const base = readConfigFragment(BASE_CONFIG_PATH);
    const override = installationOverride();
    const config = composeWranglerConfig(base, override);

    expect(config.name).toBe('customer-edge');
    expect(config.d1_databases).toEqual([
      {
        binding: 'EDGE_DB',
        database_name: 'customer-edge-db',
        remote: false,
      },
    ]);
    expect(config.ratelimits).toHaveLength(
      INSTALLATION_RATE_LIMIT_BINDINGS.length,
    );
    expect(config.ratelimits[0]).toEqual({
      name: 'COMMENT_READ_RATE_LIMITER',
      namespace_id: '700001',
      simple: { limit: 120, period: 60 },
    });
    expect(() => validateInstallationConfig(config, override)).not.toThrow();
  });

  it('keeps the public-package CI override complete and local-only', () => {
    const base = readConfigFragment(BASE_CONFIG_PATH);
    const override = readConfigFragment(CI_OVERRIDE_PATH);
    const config = composeWranglerConfig(base, override);

    expect(() => validateInstallationConfig(config, override)).not.toThrow();
    expect(forceLocalBindings(config)).toEqual(config);
  });

  it('supports explicit removal of optional bindings', () => {
    const base = readConfigFragment(BASE_CONFIG_PATH);
    const override = {
      ...installationOverride(),
      kv_namespaces: [],
      queues: { producers: [] },
      ratelimits: [],
    };
    const config = composeWranglerConfig(base, override);

    expect(config.kv_namespaces).toEqual([]);
    expect(config.queues.producers).toEqual([]);
    expect(config.ratelimits).toEqual([]);
    expect(() => validateInstallationConfig(config, override)).not.toThrow();
  });

  it('rejects customer changes to vendor-owned and dashboard-owned fields', () => {
    const base = readConfigFragment(BASE_CONFIG_PATH);
    expect(() => composeWranglerConfig(base, { main: 'other.ts' })).toThrow(
      /cannot override main/u,
    );
    expect(() => composeWranglerConfig(base, {
      vars: { COMMENTS_ENABLED: 'true' },
    })).toThrow(/cannot override vars/u);
    expect(() => composeWranglerConfig(base, {
      ratelimits: [{
        name: 'COMMENT_READ_RATE_LIMITER',
        namespace_id: '700001',
        simple: { limit: 1, period: 60 },
      }],
    })).toThrow(/cannot change ratelimits\.simple/u);
  });

  it('fails installation targets before Wrangler can use placeholder resources', () => {
    const base = readConfigFragment(BASE_CONFIG_PATH);
    const override = {
      ...installationOverride(),
      d1_databases: [
        {
          binding: 'EDGE_DB',
          database_name: '  <your-edge-database-name>',
          remote: false,
        },
      ],
    };
    const config = composeWranglerConfig(base, override);

    expect(() => validateInstallationConfig(config, override)).toThrow(
      /Installation configuration is incomplete/u,
    );
  });

  it('requires an explicit local or remote choice for configured resources', () => {
    const base = readConfigFragment(BASE_CONFIG_PATH);
    const override = installationOverride();
    delete override.d1_databases[0].remote;
    const config = composeWranglerConfig(base, override);

    expect(() => validateInstallationConfig(config, override)).toThrow(
      /EDGE_DB\.remote must explicitly be true or false/u,
    );
  });

  it('forces ordinary development local and strips dev-only fields from builds', () => {
    const base = readConfigFragment(BASE_CONFIG_PATH);
    const override = installationOverride();
    override.d1_databases[0].remote = true;
    const config = composeWranglerConfig(base, override);

    expect(forceLocalBindings(config).d1_databases[0].remote).toBe(false);
    expect(stripDevelopmentBindingFields(config).d1_databases[0])
      .not.toHaveProperty('remote');
  });

  it('requires remote development to opt at least one binding in', () => {
    const base = readConfigFragment(BASE_CONFIG_PATH);
    const localOverride = installationOverride();
    const localConfig = composeWranglerConfig(base, localOverride);

    expect(() => validateInstallationConfig(
      localConfig,
      localOverride,
      { requireRemote: true },
    )).toThrow(/at least one binding with remote=true/u);

    const remoteOverride = installationOverride();
    remoteOverride.d1_databases[0].remote = true;
    const remoteConfig = composeWranglerConfig(base, remoteOverride);
    expect(() => validateInstallationConfig(
      remoteConfig,
      remoteOverride,
      { requireRemote: true },
    )).not.toThrow();
  });

  it('rejects duplicate keyed bindings instead of producing ambiguous output', () => {
    const base = readConfigFragment(BASE_CONFIG_PATH);
    expect(() => composeWranglerConfig(base, {
      d1_databases: [
        { binding: 'EDGE_DB', database_name: 'one' },
        { binding: 'EDGE_DB', database_name: 'two' },
      ],
    })).toThrow(/duplicate binding/u);
  });

  it('blocks bare Wrangler commands and separates local and installation scripts', () => {
    const redirect = JSON.parse(readFileSync(
      join(PROJECT_ROOT, '.wrangler/deploy/config.json'),
      'utf8',
    ));
    const packageJson = JSON.parse(readFileSync(
      join(PROJECT_ROOT, 'package.json'),
      'utf8',
    ));

    expect(redirect).toEqual({
      configPath: '../../.wrangler.direct-command-disabled.jsonc',
    });
    expect(packageJson.scripts.build).toContain('--target build');
    expect(packageJson.scripts.dev).toContain('--target dev');
    expect(packageJson.scripts['dev:enable-remote'])
      .toContain('--target remote-dev');
    expect(packageJson.scripts.deploy).toContain('--target deploy');
    expect(packageJson.scripts.deploy).not.toContain('--strict');
  });
});

describe('Wrangler config initialization', () => {
  const temporaryDirectories = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function createConfigProject() {
    const directory = realpathSync(
      mkdtempSync(join(tmpdir(), 'zeropress-edge-config-')),
    );
    temporaryDirectories.push(directory);
    mkdirSync(join(directory, 'scripts'));
    for (const file of [
      'scripts/compose-wrangler-config.mjs',
      'wrangler.base.jsonc',
      'wrangler.override.example.jsonc',
    ]) {
      copyFileSync(join(PROJECT_ROOT, file), join(directory, file));
    }
    symlinkSync(
      join(PROJECT_ROOT, 'node_modules'),
      join(directory, 'node_modules'),
      'junction',
    );
    const environment = { ...process.env };
    delete environment.ZEROPRESS_EDGE_WRANGLER_OVERRIDE;

    return {
      directory,
      overridePath: join(directory, 'wrangler.override.jsonc'),
      outputPath: (target) => join(directory, basename(OUTPUT_PATHS[target])),
      run(args, extraEnvironment = {}) {
        const result = spawnSync(process.execPath, [
          join(directory, 'scripts/compose-wrangler-config.mjs'),
          ...args,
        ], {
          cwd: directory,
          env: { ...environment, ...extraEnvironment },
          encoding: 'utf8',
          timeout: 15_000,
        });
        if (result.error) throw result.error;
        return result;
      },
    };
  }

  it.each(Object.keys(OUTPUT_PATHS))(
    'creates the default override and rejects its placeholders for %s',
    (target) => {
      const project = createConfigProject();
      const outputPath = project.outputPath(target);
      writeFileSync(outputPath, 'stale generated config');
      writeFileSync(`${outputPath}.tmp`, 'stale temporary config');

      const result = project.run(['--target', target]);

      expect(result.status).toBe(1);
      expect(result.stdout).toContain('Created wrangler.override.jsonc');
      expect(result.stdout).toContain('Edit it to replace every placeholder');
      expect(result.stderr).toContain('Installation configuration is incomplete:');
      expect(result.stderr).toContain('name must contain a deployable Cloudflare Worker name.');
      expect(result.stderr).toContain('EDGE_DB.database_name must contain an installation value.');
      expect(result.stdout + result.stderr).not.toContain('npm run config:init');
      expect(readFileSync(project.overridePath, 'utf8'))
        .toBe(readFileSync(EXAMPLE_OVERRIDE_PATH, 'utf8'));
      expect(existsSync(outputPath)).toBe(false);
      expect(existsSync(`${outputPath}.tmp`)).toBe(false);
    },
  );

  it('uses an existing default override without changing its contents', () => {
    const project = createConfigProject();
    const source = `// Reviewed installation\n${JSON.stringify(installationOverride())}\n`;
    writeFileSync(project.overridePath, source);

    const result = project.run(['--target', 'build']);

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('Created wrangler.override.jsonc');
    expect(readFileSync(project.overridePath, 'utf8')).toBe(source);
    expect(readConfigFragment(project.outputPath('build')).name).toBe('customer-edge');
  });

  it('preserves an invalid existing override and reports its parse error', () => {
    const project = createConfigProject();
    const source = '{ "name": }';
    writeFileSync(project.overridePath, source);

    const result = project.run(['--target', 'build']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('contains invalid JSONC:');
    expect(result.stdout).not.toContain('Created wrangler.override.jsonc');
    expect(readFileSync(project.overridePath, 'utf8')).toBe(source);
    expect(existsSync(project.outputPath('build'))).toBe(false);
  });

  it.each(['relative', 'absolute', 'default'])(
    'reports a missing explicitly selected %s path without initializing it',
    (selection) => {
      const project = createConfigProject();
      const filename = selection === 'default'
        ? 'wrangler.override.jsonc'
        : 'missing installation.jsonc';
      const selectedPath = join(project.directory, filename);

      const result = project.run(['--target', 'build'], {
        ZEROPRESS_EDGE_WRANGLER_OVERRIDE: selection === 'absolute'
          ? selectedPath
          : filename,
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`${JSON.stringify(selectedPath)} is required for build`);
      expect(result.stderr).toContain('ZEROPRESS_EDGE_WRANGLER_OVERRIDE');
      expect(result.stdout + result.stderr).not.toContain('npm run config:init');
      expect(existsSync(project.overridePath)).toBe(false);
      expect(existsSync(selectedPath)).toBe(false);
      expect(existsSync(project.outputPath('build'))).toBe(false);
    },
  );

  it('keeps a missing explicit path from falling back to an existing default', () => {
    const project = createConfigProject();
    const source = JSON.stringify(installationOverride());
    writeFileSync(project.overridePath, source);

    const result = project.run(['--target', 'build'], {
      ZEROPRESS_EDGE_WRANGLER_OVERRIDE: 'missing.jsonc',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(join(project.directory, 'missing.jsonc'));
    expect(readFileSync(project.overridePath, 'utf8')).toBe(source);
    expect(existsSync(project.outputPath('build'))).toBe(false);
  });

  it('uses an existing selected override without creating the default file', () => {
    const project = createConfigProject();
    const selectedPath = join(project.directory, 'reviewed.jsonc');
    const source = JSON.stringify(installationOverride());
    writeFileSync(selectedPath, source);

    const result = project.run(['--target', 'build'], {
      ZEROPRESS_EDGE_WRANGLER_OVERRIDE: 'reviewed.jsonc',
    });

    expect(result.status).toBe(0);
    expect(readFileSync(selectedPath, 'utf8')).toBe(source);
    expect(existsSync(project.overridePath)).toBe(false);
    expect(readConfigFragment(project.outputPath('build')).name).toBe('customer-edge');
  });

  it('keeps manual initialization available without overwriting an existing file', () => {
    const project = createConfigProject();

    expect(project.run(['--init']).status).toBe(0);
    const source = readFileSync(project.overridePath, 'utf8');
    expect(source).toBe(readFileSync(EXAMPLE_OVERRIDE_PATH, 'utf8'));

    const repeated = project.run(['--init']);

    expect(repeated.status).toBe(1);
    expect(repeated.stderr).toContain('already exists and was not overwritten');
    expect(readFileSync(project.overridePath, 'utf8')).toBe(source);
  });
});
