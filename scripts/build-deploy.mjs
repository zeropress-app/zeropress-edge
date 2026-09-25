import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { styleText } from 'node:util';
import { prepareDeployment } from './deployment-command.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

try {
  const { name, dryRun, args } = prepareDeployment(root, process.argv.slice(2));
  if (name !== undefined) {
    console.log(`${dryRun ? 'Validating deployment for' : 'Deploying'} Worker ${styleText('cyan', name)}.`);
  }
  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL('./bin/wrangler.js', import.meta.resolve('wrangler/package.json'))),
    ...args,
  ], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} catch (error) {
  console.error(styleText(['bold', 'red'], error.message, { stream: process.stderr }));
  process.exitCode = 1;
}
