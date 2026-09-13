import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const existingFiles = ['.dev.vars', '.env', '.env.local'];

if (!existingFiles.some((name) => existsSync(new URL(name, root)))) {
  const contents = [
    '# Local development values only.',
    'ALLOWED_ORIGINS=http://localhost:3000',
    'COMMENTS_ENABLED=true',
    'NEWSLETTER_ENABLED=false',
    'FORMS_ENABLED=false',
    'EDGE_MAINTENANCE_MODE=false',
    `EDGE_TOKEN_SIGNING_SECRET=${randomBytes(32).toString('hex')}`,
    `IP_HASH_SECRET=${randomBytes(32).toString('hex')}`,
    '',
  ].join('\n');

  try {
    writeFileSync(new URL('.dev.vars', root), contents, { flag: 'wx', mode: 0o600 });
    console.log('Created .dev.vars for local development.');
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
}
