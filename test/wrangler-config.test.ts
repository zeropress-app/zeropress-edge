import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

describe('Cloudflare deployment configuration', () => {
  it('preserves Dashboard variables without supplying deployment values', () => {
    expect(configuration.keep_vars).toBe(true);
    expect(configuration).not.toHaveProperty('vars');
  });

  it.each(['build', 'deploy'])('%s uses the resource identities written by Cloudflare', (command) => {
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
      scripts: { [command]: packageJson.scripts[command] },
    }));

    // Only the root configuration is available. A recording CLI replaces
    // Wrangler so the deploy script cannot upload or access Cloudflare.
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
      'fs.writeFileSync("invocation.json", JSON.stringify({ args, configPath, config }));',
    ].join('\n'), { mode: 0o755 });

    const result = spawnSync('npm', ['run', '--silent', command], {
      cwd: directory, encoding: 'utf8', timeout: 10_000,
    });
    expect(result.status, result.stderr).toBe(0);
    const invocation = JSON.parse(readFileSync(join(directory, 'invocation.json'), 'utf8'));
    expect(invocation.configPath).toBe(configPath);
    expect(invocation.config).toEqual(installed);
    expect(invocation.args[0]).toBe('deploy');
    expect(invocation.args.includes('--dry-run')).toBe(command === 'build');
    expect(readFileSync(configPath, 'utf8')).toBe(contents);
  });
});
