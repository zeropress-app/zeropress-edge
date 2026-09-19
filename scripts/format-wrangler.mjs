import { readFileSync, writeFileSync } from 'node:fs';
import { styleText } from 'node:util';
import { applyEdits, format, parse, printParseErrorCode } from 'jsonc-parser';

const configPath = new URL('../wrangler.jsonc', import.meta.url);

try {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) {
    throw new Error('Usage: node scripts/format-wrangler.mjs [--check]');
  }
  const contents = readFileSync(configPath, 'utf8');
  const errors = [];
  const config = parse(contents, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    const { error, offset } = errors[0];
    const lines = contents.slice(0, offset).split(/\r\n|\r|\n/u);
    throw new Error(`Invalid JSONC in wrangler.jsonc at line ${lines.length}, column ${lines.at(-1).length + 1}: ${printParseErrorCode(error)}.`);
  }
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('wrangler.jsonc must contain a JSON object.');
  }
  // Match Wrangler's resource-ID write-back, including comments and line endings.
  const formatted = applyEdits(contents, format(contents, undefined, {}));
  if (args.includes('--check') && contents !== formatted) {
    throw new Error('wrangler.jsonc is not formatted. Run npm run format:wrangler.');
  }
  if (!args.includes('--check') && contents !== formatted) {
    writeFileSync(configPath, formatted);
  }
  console.log('wrangler.jsonc is formatted.');
} catch (error) {
  console.error(styleText(['bold', 'red'], error.message, { stream: process.stderr }));
  process.exitCode = 1;
}
