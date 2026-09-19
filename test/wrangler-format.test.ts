import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'jsonc-parser';
import { afterEach, beforeEach, expect, it } from 'vitest';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const source = `{
  // Installation settings
  "name": "custom-edge",
  "keep_vars": true,
  "triggers": { "crons": ["0 * * * *", "23 18 * * *"] },
  "kv_namespaces": [{ "binding": "EDGE_KV", "id": "${'a'.repeat(32)}", }],
}
`;
let directory: string;
let configPath: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'edge-wrangler-format-'));
  configPath = join(directory, 'wrangler.jsonc');
  mkdirSync(join(directory, 'scripts'));
  mkdirSync(join(directory, 'node_modules'));
  copyFileSync(join(projectRoot, 'scripts/format-wrangler.mjs'), join(directory, 'scripts/format-wrangler.mjs'));
  symlinkSync(join(projectRoot, 'node_modules/jsonc-parser'), join(directory, 'node_modules/jsonc-parser'), 'junction');
  writeFileSync(configPath, source);
});

afterEach(() => rmSync(directory, { recursive: true, force: true }));

function run(...args: string[]) {
  return spawnSync(process.execPath, ['scripts/format-wrangler.mjs', ...args], {
    cwd: directory, encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, FORCE_COLOR: undefined, NO_COLOR: '1' },
  });
}

it.each(['\n', '\r\n'])('matches installed Wrangler write-back formatting with %j line endings', (eol) => {
  const contents = source.replaceAll('\n', eol);
  writeFileSync(configPath, contents);
  const patch = spawnSync(process.execPath, [
    '--input-type=module', '-e',
    'import { experimental_patchConfig } from "wrangler"; experimental_patchConfig(process.argv[1], {}, false);',
    configPath,
  ], {
    cwd: projectRoot, encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: join(directory, 'wrangler.log') },
  });
  expect(patch.status, patch.stderr).toBe(0);
  const expected = readFileSync(configPath, 'utf8');
  writeFileSync(configPath, contents);
  const result = run();
  expect(result.status, result.stderr).toBe(0);
  expect(readFileSync(configPath, 'utf8')).toBe(expected);
  expect(parse(expected)).toEqual(parse(contents));
  expect(expected).toContain('// Installation settings');
  expect(run().status).toBe(0);
  expect(readFileSync(configPath, 'utf8')).toBe(expected);
});

it('checks without writing and fixes formatting on explicit request', () => {
  const check = run('--check');
  expect(check.status).toBe(1);
  expect(check.stderr).toContain('Run npm run format:wrangler.');
  expect(readFileSync(configPath, 'utf8')).toBe(source);
  expect(run().status).toBe(0);
  expect(run('--check').status).toBe(0);
});

it.each(['{"name":"custom-edge", "keep_vars":}', '[]'])('leaves invalid configuration untouched: %s', (contents) => {
  writeFileSync(configPath, contents);
  for (const args of [[], ['--check']]) {
    const result = run(...args);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Invalid JSONC|must contain a JSON object/u);
    expect(readFileSync(configPath, 'utf8')).toBe(contents);
  }
});
