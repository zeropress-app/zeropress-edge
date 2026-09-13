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
  copyFileSync(
    join(projectRoot, 'scripts/init-dev-vars.mjs'),
    join(directory, 'scripts/init-dev-vars.mjs'),
  );

  // Exercise npm scripts and hooks, replacing only Wrangler so no Worker
  // starts, uploads, or accesses Cloudflare resources.
  const bin = join(directory, 'node_modules', '.bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'wrangler'), [
    '#!/usr/bin/env node',
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    'const args = process.argv.slice(2);',
    'const index = args.indexOf("--config");',
    'const configPath = path.resolve(index === -1 ? "wrangler.jsonc" : args[index + 1]);',
    'const config = JSON.parse(fs.readFileSync(configPath, "utf8"));',
    'const localVars = fs.existsSync(".dev.vars") ? fs.readFileSync(".dev.vars", "utf8") : null;',
    'fs.writeFileSync("invocation.json", JSON.stringify({ args, configPath, config, localVars }));',
  ].join('\n'), { mode: 0o755 });

  return { directory, configPath, contents, installed };
}

function runCommand(directory: string, command: string) {
  const result = spawnSync('npm', ['run', '--silent', command], {
    cwd: directory, encoding: 'utf8', timeout: 10_000,
  });
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
    const { invocation } = runCommand(directory, command);
    expect(invocation.configPath).toBe(configPath);
    expect(invocation.config).toEqual(installed);
    expect(invocation.args[0]).toBe('deploy');
    expect(invocation.args.includes('--dry-run')).toBe(command === 'build');
    expect(readFileSync(configPath, 'utf8')).toBe(contents);
    expect(invocation.localVars).toBeNull();
    expect(existsSync(join(directory, '.dev.vars'))).toBe(false);
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
