import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { parse } from 'jsonc-parser';
import { afterEach, describe, expect, it } from 'vitest';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const packageJson = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'));
const configuration = parse(readFileSync(join(projectRoot, 'wrangler.jsonc'), 'utf8'));
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createFixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'zeropress-edge-config-')));
  directories.push(directory);
  const configPath = join(directory, 'wrangler.jsonc');
  const installed = {
    ...configuration,
    name: 'installed-edge-worker',
    d1_databases: [{
      binding: 'EDGE_DB', database_name: 'installed-edge-database',
      database_id: '11111111-1111-4111-8111-111111111111', remote: false,
    }],
    kv_namespaces: [{ binding: 'EDGE_KV', id: 'a'.repeat(32), remote: false }],
    queues: { producers: [{ binding: 'MAIL_QUEUE', queue: 'installed-edge-mail', remote: false }] },
  };
  const contents = JSON.stringify(installed, null, 2);
  writeFileSync(configPath, contents);
  writeFileSync(join(directory, 'package.json'), JSON.stringify({
    name: 'edge-deployment-test', private: true, type: 'commonjs',
    scripts: packageJson.scripts,
  }));
  mkdirSync(join(directory, 'scripts'));
  for (const script of ['init-dev-vars.mjs', 'build-deploy.mjs']) {
    copyFileSync(join(projectRoot, 'scripts', script), join(directory, 'scripts', script));
  }

  // Exercise npm scripts and hooks, replacing only Wrangler so no Worker
  // starts, uploads, or accesses Cloudflare resources.
  const bin = join(directory, 'node_modules', '.bin');
  mkdirSync(bin, { recursive: true });
  const wrangler = join(directory, 'node_modules', 'wrangler');
  mkdirSync(join(wrangler, 'bin'), { recursive: true });
  writeFileSync(join(wrangler, 'package.json'), JSON.stringify({ main: 'index.cjs' }));
  writeFileSync(join(wrangler, 'index.cjs'), [
    `const wrangler = require(${JSON.stringify(fileURLToPath(import.meta.resolve('wrangler')))});`,
    'exports.unstable_readConfig = wrangler.unstable_readConfig;',
    'exports.unstable_getVarsForDev = wrangler.unstable_getVarsForDev;',
  ].join('\n'));
  const mock = [
    '#!/usr/bin/env node',
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    'const args = process.argv.slice(2);',
    'const index = args.indexOf("--config");',
    'const configPath = path.resolve(index === -1 ? "wrangler.jsonc" : args[index + 1]);',
    'const config = JSON.parse(fs.readFileSync(configPath, "utf8"));',
    'const localVars = fs.existsSync(".dev.vars") ? fs.readFileSync(".dev.vars", "utf8") : null;',
    'fs.writeFileSync("invocation.json", JSON.stringify({ args, configPath, config, localVars }));',
    'process.exitCode = Number(process.env.TEST_WRANGLER_EXIT_CODE || 0);',
  ].join('\n');
  writeFileSync(join(bin, 'wrangler'), mock, { mode: 0o755 });
  writeFileSync(join(wrangler, 'bin', 'wrangler.js'), mock);

  return { directory, configPath, contents, installed };
}

function executeCommand(directory: string, command: string, args: string[] = [], env: NodeJS.ProcessEnv = {}) {
  return spawnSync('npm', ['run', '--silent', command, '--', ...args], {
    cwd: directory, encoding: 'utf8', timeout: 10_000,
    env: {
      ...process.env, CLOUDFLARE_ENV: undefined, WRANGLER_CI_OVERRIDE_NAME: undefined,
      WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: join(directory, 'wrangler.log'),
      FORCE_COLOR: undefined, NO_COLOR: '1', ...env,
    },
  });
}

function runCommand(directory: string, command: string, args: string[] = [], env: NodeJS.ProcessEnv = {}) {
  const result = executeCommand(directory, command, args, env);
  expect(result.status, result.stderr || result.error?.message).toBe(0);
  return {
    invocation: JSON.parse(readFileSync(join(directory, 'invocation.json'), 'utf8')),
    output: result.stdout + result.stderr,
  };
}

describe('Cloudflare deployment configuration', () => {
  it('preserves Dashboard variables without supplying deployment values', () => {
    expect(configuration.keep_vars).toBe(true);
    expect(configuration).not.toHaveProperty('vars');
  });

  it.each(['build', 'deploy'])('%s uses the resource identities written by Cloudflare', (command) => {
    const { directory, configPath, contents, installed } = createFixture();
    const { invocation, output } = runCommand(directory, command);
    expect(invocation.configPath).toBe(configPath);
    expect(invocation.config).toEqual(installed);
    expect(invocation.args[0]).toBe('deploy');
    expect(invocation.args.includes('--dry-run')).toBe(command === 'build');
    expect(output).toContain(`${command === 'build' ? 'Validating deployment for' : 'Deploying'} Worker ${installed.name}.`);
    expect(readFileSync(configPath, 'utf8')).toBe(contents);
    expect(invocation.localVars).toBeNull();
    expect(existsSync(join(directory, '.dev.vars'))).toBe(false);
  });

  it.each([
    { args: ['--name', 'cli-edge'], env: {}, name: 'cli-edge' },
    { args: ['--env', 'staging'], env: {}, name: 'environment-edge' },
    { args: ['-e', 'staging', '--name=cli-edge'], env: {}, name: 'cli-edge' },
    { args: [], env: { CLOUDFLARE_ENV: 'staging' }, name: 'environment-edge' },
    { args: ['--env=staging', '--name', 'cli-edge'], env: { WRANGLER_CI_OVERRIDE_NAME: 'builds-edge' }, name: 'builds-edge' },
  ])('shows the effective target for $args and $env', ({ args, env, name }) => {
    const { directory, configPath, installed } = createFixture();
    writeFileSync(configPath, JSON.stringify({ ...installed, env: { staging: { ...installed, name: 'environment-edge' } } }));
    const { invocation, output } = runCommand(directory, 'deploy', args, env);
    expect(output).toContain(`Deploying Worker ${name}.`);
    expect(invocation.args).toEqual(['deploy', '--config', 'wrangler.jsonc', ...args]);
  });

  it('uses Wrangler environment-name suffixes when no environment name is set', () => {
    const { directory, configPath, installed } = createFixture();
    const { name: _name, ...environment } = installed;
    writeFileSync(configPath, JSON.stringify({ ...installed, env: { staging: environment } }));
    expect(runCommand(directory, 'build', ['--env', 'staging']).output)
      .toContain(`Validating deployment for Worker ${installed.name}-staging.`);
  });

  it('uses Wrangler dotenv expansion and file precedence for target selection', () => {
    const { directory } = createFixture();
    writeFileSync(join(directory, '.env'), 'TARGET_PREFIX=base\nWRANGLER_CI_OVERRIDE_NAME=${TARGET_PREFIX}-edge\n');
    writeFileSync(join(directory, '.env.local'), 'TARGET_PREFIX=local\nWRANGLER_CI_OVERRIDE_NAME=${TARGET_PREFIX}-edge\n');
    writeFileSync(join(directory, '.dev.vars'), 'WRANGLER_CI_OVERRIDE_NAME=development-only-edge\n');
    expect(runCommand(directory, 'deploy').output).toContain('Deploying Worker local-edge.');
    expect(runCommand(directory, 'deploy', [], { WRANGLER_CI_OVERRIDE_NAME: 'ci-edge' }).output)
      .toContain('Deploying Worker ci-edge.');

    writeFileSync(join(directory, '.env.preview'), 'WRANGLER_CI_OVERRIDE_NAME=preview-edge\n');
    expect(runCommand(directory, 'build', ['--env', 'preview']).output)
      .toContain('Validating deployment for Worker preview-edge.');
  });

  it.each([
    ['--env-file', 'first.env', '--envFile=last.env'],
    ['--env-file', 'first.env', 'last.env'],
  ])('reads explicit environment files %j when dev-variable loading is disabled', (...args) => {
    const { directory } = createFixture();
    writeFileSync(join(directory, 'first.env'), 'WRANGLER_CI_OVERRIDE_NAME=first-edge\n');
    writeFileSync(join(directory, 'last.env'), 'WRANGLER_CI_OVERRIDE_NAME=last-edge\n');
    const { output } = runCommand(directory, 'deploy', args, {
      CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false',
    });
    expect(output).toContain('Deploying Worker last-edge.');
  });

  it('resolves an environment selected in .env while CLI selection takes precedence', () => {
    const { directory, configPath, installed } = createFixture();
    writeFileSync(configPath, JSON.stringify({
      ...installed, env: {
        staging: { ...installed, name: 'staging-edge' },
        preview: { ...installed, name: 'preview-edge' },
      },
    }));
    writeFileSync(join(directory, '.env'), 'CLOUDFLARE_ENV=staging\n');
    expect(runCommand(directory, 'deploy').output).toContain('Deploying Worker staging-edge.');
    expect(runCommand(directory, 'deploy', ['--env=preview']).output).toContain('Deploying Worker preview-edge.');
  });

  it('honors a negated deployment dry run in the displayed action', () => {
    const { directory } = createFixture();
    expect(runCommand(directory, 'deploy', ['--dry-run', '--no-dry-run']).output)
      .toContain('Deploying Worker installed-edge-worker.');
  });

  it('passes deployment options and Wrangler failures through', () => {
    const { directory } = createFixture();
    const result = executeCommand(directory, 'deploy', ['--dry-run', '--outdir', 'output'], { TEST_WRANGLER_EXIT_CODE: '7' });
    expect(result.status).toBe(7);
    expect(result.stdout).toContain('Validating deployment for Worker installed-edge-worker.');
    expect(JSON.parse(readFileSync(join(directory, 'invocation.json'), 'utf8')).args)
      .toEqual(['deploy', '--config', 'wrangler.jsonc', '--dry-run', '--outdir', 'output']);
  });

  it.each([
    { args: [], name: 'installed-edge-worker' },
    { args: ['--env=staging'], name: 'environment-edge' },
    { args: ['-e=staging', '--name=cli-edge'], name: 'cli-edge' },
    { args: ['--env=staging', '--name=cli-edge', '--env-file=deployment.env'], name: 'builds-edge' },
  ])('prints the same $name target that installed Wrangler selects for $args in a real dry run', ({ args, name }) => {
    const { directory, configPath, installed } = createFixture();
    writeFileSync(configPath, JSON.stringify({ ...installed, env: { staging: { ...installed, name: 'environment-edge' } } }));
    mkdirSync(join(directory, 'src'));
    writeFileSync(join(directory, 'src/index.ts'), 'export default { fetch() { return new Response("test"); } };');
    writeFileSync(join(directory, 'deployment.env'), 'WRANGLER_CI_OVERRIDE_NAME=builds-edge\n');
    const realWrangler = fileURLToPath(new URL('./bin/wrangler.js', import.meta.resolve('wrangler/package.json')));
    writeFileSync(join(directory, 'node_modules/wrangler/bin/wrangler.js'), [
      'const { spawnSync } = require("node:child_process");',
      `const result = spawnSync(process.execPath, [${JSON.stringify(realWrangler)}, ...process.argv.slice(2)], { stdio: 'inherit' });`,
      'process.exitCode = result.status ?? 1;',
    ].join('\n'));
    const outputPath = join(directory, 'wrangler-output.jsonl');
    const result = executeCommand(directory, 'build', args, {
      WRANGLER_OUTPUT_FILE_PATH: outputPath,
    });
    expect(result.status, result.stderr || result.error?.message).toBe(0);
    const deployment = readFileSync(outputPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
      .find((event) => event.type === 'deploy');
    expect(deployment.worker_name).toBe(name);
    expect(result.stdout).toContain(`Validating deployment for Worker ${deployment.worker_name}.`);
    expect(result.stdout).toContain('--dry-run: exiting now.');
  }, 15_000);

  it.each([
    ['build', ['--no-dry-run']],
    ['build', ['--dry-run=false']],
    ['build', ['--', '--no-dry-run']],
    ['deploy', ['--config', 'other.jsonc']],
    ['deploy', ['--cwd', '..']],
    ['deploy', ['--name', 'first', '--name', 'second']],
  ] as const)('rejects ambiguous or unsafe %s arguments %j before calling Wrangler', (command, args) => {
    const { directory } = createFixture();
    const result = executeCommand(directory, command, [...args]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/dry run|root wrangler.jsonc|only once/u);
    expect(existsSync(join(directory, 'invocation.json'))).toBe(false);
  });

  it('stops on invalid configuration before calling Wrangler', () => {
    const { directory, configPath } = createFixture();
    writeFileSync(configPath, '{"name":');
    const result = executeCommand(directory, 'deploy');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Expected');
    expect(existsSync(join(directory, 'invocation.json'))).toBe(false);
  });
});

describe('Local development variables', () => {
  it('initializes defaults and private, persistent secrets before starting Wrangler', () => {
    const { directory } = createFixture();
    const { invocation, output } = runCommand(directory, 'dev');
    expect(invocation.args[0]).toBe('dev');
    const values = parseEnv(invocation.localVars);
    expect(values).toEqual({
      ALLOWED_ORIGINS: 'http://localhost:3000',
      COMMENTS_ENABLED: 'true',
      NEWSLETTER_ENABLED: 'false',
      FORMS_ENABLED: 'false',
      EDGE_MAINTENANCE_MODE: 'false',
      EDGE_TOKEN_SIGNING_SECRET: expect.stringMatching(/^[a-f0-9]{64}$/),
      IP_HASH_SECRET: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(output).not.toContain(values.EDGE_TOKEN_SIGNING_SECRET);
    expect(output).not.toContain(values.IP_HASH_SECRET);
    if (process.platform !== 'win32') {
      expect(statSync(join(directory, '.dev.vars')).mode & 0o077).toBe(0);
    }

    const rerun = runCommand(directory, 'dev');
    expect(rerun.invocation.localVars).toBe(invocation.localVars);
    expect(readFileSync(join(directory, '.dev.vars'), 'utf8')).toBe(invocation.localVars);

    const other = createFixture();
    const otherValues = parseEnv(runCommand(other.directory, 'dev').invocation.localVars);
    expect(new Set([
      values.EDGE_TOKEN_SIGNING_SECRET, values.IP_HASH_SECRET,
      otherValues.EDGE_TOKEN_SIGNING_SECRET, otherValues.IP_HASH_SECRET,
    ]).size).toBe(4);
  });

  it.each(['.dev.vars', '.env', '.env.local'].flatMap((file) => [
    { file, label: 'empty', contents: '' },
    { file, label: 'partially configured', contents: 'COMMENTS_ENABLED=false\nCUSTOM_SETTING=kept\n' },
  ]))('preserves $file when $label', ({ file, contents }) => {
    const { directory } = createFixture();
    writeFileSync(join(directory, file), contents);
    const { invocation } = runCommand(directory, 'dev');
    expect(invocation.args[0]).toBe('dev');
    expect(readFileSync(join(directory, file), 'utf8')).toBe(contents);
    expect(invocation.localVars).toBe(file === '.dev.vars' ? contents : null);
    expect(existsSync(join(directory, '.dev.vars'))).toBe(file === '.dev.vars');
  });
});
