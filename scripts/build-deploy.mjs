import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, styleText } from 'node:util';
import { unstable_getVarsForDev, unstable_readConfig } from 'wrangler';

const root = fileURLToPath(new URL('../', import.meta.url));

function readTargetEnvironment(environment, envFiles) {
  const paths = envFiles ?? [
    '.env', '.env.local',
    ...(environment === undefined ? [] : [`.env.${environment}`, `.env.${environment}.local`]),
  ];
  // Use Wrangler's dotenv expansion and precedence, without reading .dev.vars.
  // CLI environment files are loaded even when local dev-variable loading is disabled.
  const previous = process.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV;
  process.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = 'true';
  try {
    return unstable_getVarsForDev(
      undefined, paths.map((path) => resolve(root, path)), {}, environment, true,
      { required: ['CLOUDFLARE_ENV', 'WRANGLER_CI_OVERRIDE_NAME'] },
    );
  } finally {
    if (previous === undefined) delete process.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV;
    else process.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = previous;
  }
}

try {
  const [command, ...args] = process.argv.slice(2);
  if (command !== 'build' && command !== 'deploy') {
    throw new Error('Usage: node scripts/build-deploy.mjs build|deploy [Wrangler options]');
  }
  const { values, tokens } = parseArgs({
    args: args.map((arg) => arg
      .replace(/^-(e|c)=/u, '-$1')
      .replace(/^--envFile(?==|$)/u, '--env-file')
      .replace(/^--(no-)?dryRun(?==|$)/u, '--$1dry-run')),
    strict: false, tokens: true, allowNegative: true,
    options: {
      name: { type: 'string' },
      env: { type: 'string', short: 'e' },
      'env-file': { type: 'string', multiple: true },
      config: { type: 'string', short: 'c' },
      cwd: { type: 'string' },
      'dry-run': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  for (const name of ['name', 'env']) {
    if (tokens.filter((token) => token.kind === 'option' && token.name === name).length > 1) {
      throw new Error(`Specify --${name} only once.`);
    }
  }
  if (tokens.some((token) => token.kind === 'option-terminator'
    || (token.kind === 'option' && ['config', 'cwd', 'c', 'n', 'e'].includes(token.name)))) {
    throw new Error('Use --name or --env/-e with the root wrangler.jsonc. For another configuration, run Wrangler directly.');
  }
  if (command === 'build' && args.some((arg) => /^--(?:no-dry-run|dry-run=|dryRun|no-dryRun)/u.test(arg))) {
    throw new Error('npm run build always uses a dry run. Use npm run deploy to deploy.');
  }

  const dryRun = command === 'build' || values['dry-run'] === true || values['dry-run'] === 'true';
  if (!values.help) {
    // Wrangler accepts both repeated --env-file options and multiple paths after one option.
    const envFiles = [];
    let readingEnvFiles = false;
    for (const token of tokens) {
      if (token.kind === 'option') {
        readingEnvFiles = token.name === 'env-file';
        if (readingEnvFiles) envFiles.push(token.value);
      } else if (token.kind === 'positional' && readingEnvFiles) {
        envFiles.push(token.value);
      }
    }
    const environment = readTargetEnvironment(values.env, envFiles.length ? envFiles : undefined);
    const config = unstable_readConfig({
      config: resolve(root, 'wrangler.jsonc'),
      env: values.env ?? environment.CLOUDFLARE_ENV?.value,
    }, { hideWarnings: true });
    const name = environment.WRANGLER_CI_OVERRIDE_NAME?.value ?? values.name ?? config.name;
    if (typeof name !== 'string' || name.trim() === '') {
      throw new Error('Set a Worker name in wrangler.jsonc or pass --name.');
    }
    console.log(`${dryRun ? 'Validating deployment for' : 'Deploying'} Worker ${styleText('cyan', name)}.`);
  }

  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL('./bin/wrangler.js', import.meta.resolve('wrangler/package.json'))),
    'deploy', '--config', 'wrangler.jsonc', ...args,
    ...(command === 'build' ? ['--dry-run'] : []),
  ], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} catch (error) {
  console.error(styleText(['bold', 'red'], error.message, { stream: process.stderr }));
  process.exitCode = 1;
}
