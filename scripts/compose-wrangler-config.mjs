import {
  constants,
  copyFileSync,
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { parse, printParseErrorCode } from 'jsonc-parser';

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = resolve(SCRIPT_DIRECTORY, '..');
export const BASE_CONFIG_PATH = join(PROJECT_ROOT, 'wrangler.base.jsonc');
export const DEFAULT_OVERRIDE_PATH = join(PROJECT_ROOT, 'wrangler.override.jsonc');
export const EXAMPLE_OVERRIDE_PATH = join(
  PROJECT_ROOT,
  'wrangler.override.example.jsonc',
);

export const OUTPUT_PATHS = {
  build: join(PROJECT_ROOT, '.wrangler.build.jsonc'),
  dev: join(PROJECT_ROOT, '.wrangler.dev.jsonc'),
  'remote-dev': join(PROJECT_ROOT, '.wrangler.remote-dev.jsonc'),
  deploy: join(PROJECT_ROOT, '.wrangler.generated.jsonc'),
};

const REMOTE_BINDING_COLLECTIONS = [
  ['d1_databases'],
  ['kv_namespaces'],
  ['queues', 'producers'],
];

const KEYED_ARRAYS = new Map([
  ['d1_databases', 'binding'],
  ['kv_namespaces', 'binding'],
  ['queues.producers', 'binding'],
  ['ratelimits', 'name'],
]);

const VENDOR_OWNED_OVERRIDE_KEYS = new Map([
  ['main', 'the Worker entry point'],
  ['compatibility_date', 'the reviewed runtime compatibility date'],
  ['compatibility_flags', 'the reviewed runtime compatibility flags'],
  ['keep_vars', 'the dashboard-variable preservation policy'],
  ['vars', 'dashboard-owned plaintext variables'],
  ['env', 'environment selection; generate one installation config instead'],
  ['build', 'the package build pipeline'],
  ['no_bundle', 'the package bundling policy'],
  ['base_dir', 'the package module resolution base'],
]);

export const INSTALLATION_RATE_LIMIT_BINDINGS = [
  'COMMENT_READ_RATE_LIMITER',
  'COMMENT_WRITE_RATE_LIMITER',
  'COMMENT_CHALLENGE_RATE_LIMITER',
  'NEWSLETTER_READ_RATE_LIMITER',
  'NEWSLETTER_SUBSCRIBE_RATE_LIMITER',
  'NEWSLETTER_CHALLENGE_RATE_LIMITER',
  'FORM_READ_RATE_LIMITER',
  'FORM_SUBMIT_RATE_LIMITER',
  'FORM_CHALLENGE_RATE_LIMITER',
];

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value);
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function describePath(path) {
  return path.length === 0 ? '<root>' : path.join('.');
}

function indexKeyedArray(items, key, path) {
  const indexed = new Map();
  for (const item of items) {
    if (
      !isPlainObject(item)
      || typeof item[key] !== 'string'
      || item[key] === ''
    ) {
      throw new TypeError(
        `${describePath(path)} entries must have a non-empty ${key}.`,
      );
    }
    if (indexed.has(item[key])) {
      throw new TypeError(
        `${describePath(path)} contains duplicate ${key} `
        + `${JSON.stringify(item[key])}.`,
      );
    }
    indexed.set(item[key], item);
  }
  return indexed;
}

function mergeKeyedArray(base, override, path, key) {
  if (override.length === 0) return [];

  const baseIndex = indexKeyedArray(base, key, path);
  indexKeyedArray(override, key, path);
  const result = base.map((item) => clone(item));

  for (const overrideItem of override) {
    const itemKey = overrideItem[key];
    const existingIndex = result.findIndex((item) => item[key] === itemKey);
    if (overrideItem.$remove === true) {
      const extraKeys = Object.keys(overrideItem).filter(
        (candidate) => candidate !== key && candidate !== '$remove',
      );
      if (extraKeys.length > 0) {
        throw new TypeError(
          `${describePath(path)} ${JSON.stringify(itemKey)} cannot combine `
          + '$remove with other fields.',
        );
      }
      if (!baseIndex.has(itemKey)) {
        throw new TypeError(
          `${describePath(path)} cannot remove unknown ${key} ${JSON.stringify(itemKey)}.`,
        );
      }
      result.splice(existingIndex, 1);
      continue;
    }

    const cleanOverride = Object.fromEntries(
      Object.entries(overrideItem).filter(([candidate]) => candidate !== '$remove'),
    );
    if (existingIndex === -1) {
      result.push(clone(cleanOverride));
    } else {
      result[existingIndex] = mergeConfigValue(
        result[existingIndex],
        cleanOverride,
        [...path, itemKey],
      );
    }
  }
  return result;
}

function mergeConfigValue(base, override, path) {
  if (Array.isArray(override)) {
    const keyedBy = KEYED_ARRAYS.get(path.join('.'));
    if (keyedBy) {
      if (!Array.isArray(base)) {
        throw new TypeError(
          `${describePath(path)} must be an array in the base config.`,
        );
      }
      return mergeKeyedArray(base, override, path, keyedBy);
    }
    return clone(override);
  }

  if (isPlainObject(base) && isPlainObject(override)) {
    const result = clone(base);
    for (const [key, value] of Object.entries(override)) {
      if (path.length === 0 && key === '$schema') continue;
      result[key] = Object.hasOwn(result, key)
        ? mergeConfigValue(result[key], value, [...path, key])
        : clone(value);
    }
    return result;
  }

  return clone(override);
}

function assertOverrideOwnership(base, override) {
  if (!isPlainObject(override)) {
    throw new TypeError('The Wrangler override must contain one JSON object.');
  }
  for (const [key, description] of VENDOR_OWNED_OVERRIDE_KEYS) {
    if (Object.hasOwn(override, key)) {
      throw new TypeError(
        `wrangler.override.jsonc cannot override ${key} (${description}).`,
      );
    }
  }
  if (Array.isArray(override.ratelimits)) {
    for (const binding of override.ratelimits) {
      if (!isPlainObject(binding) || !Object.hasOwn(binding, 'simple')) continue;
      const baseBinding = base.ratelimits?.find((candidate) => (
        isPlainObject(candidate) && candidate.name === binding.name
      ));
      if (!baseBinding || !isDeepStrictEqual(binding.simple, baseBinding.simple)) {
        throw new TypeError(
          'wrangler.override.jsonc cannot change ratelimits.simple '
          + '(the reviewed quota policy).',
        );
      }
    }
  }

  const pending = [override];
  while (pending.length > 0) {
    const value = pending.pop();
    if (Array.isArray(value)) {
      pending.push(...value);
      continue;
    }
    if (!isPlainObject(value)) continue;
    if (Object.hasOwn(value, 'migrations_dir')) {
      throw new TypeError(
        'wrangler.override.jsonc cannot configure a Wrangler migrations directory.',
      );
    }
    pending.push(...Object.values(value));
  }
}

export function composeWranglerConfig(base, override = {}) {
  if (!isPlainObject(base)) {
    throw new TypeError('The Wrangler base must contain one JSON object.');
  }
  assertOverrideOwnership(base, override);
  return mergeConfigValue(base, override, []);
}

function collectionAt(config, path) {
  let current = config;
  for (const segment of path) {
    if (!isPlainObject(current)) return undefined;
    current = current[segment];
  }
  return Array.isArray(current) ? current : undefined;
}

function isPlaceholder(value) {
  if (typeof value !== 'string') return true;
  const normalized = value.trim().toLowerCase();
  return normalized === ''
    || normalized.startsWith('<')
    || normalized.includes('replace-with');
}

function explicitChoice(override, path, key, expected) {
  const collection = collectionAt(override, path);
  if (!collection) return { kind: 'missing' };
  if (collection.length === 0) return { kind: 'removed' };
  const item = collection.find((candidate) => (
    isPlainObject(candidate) && candidate[key] === expected
  ));
  if (!item) return { kind: 'missing' };
  return item.$remove === true
    ? { kind: 'removed' }
    : { kind: 'configured', item };
}

function requireExplicitChoice(errors, override, input) {
  const choice = explicitChoice(override, input.path, input.key, input.expected);
  const label = `${input.path.join('.')} ${input.expected}`;
  if (choice.kind === 'missing') {
    const alternative = input.optional ? ' or removed' : '';
    errors.push(`${label} must be explicitly configured${alternative}.`);
    return;
  }
  if (choice.kind === 'removed') {
    if (!input.optional) {
      errors.push(`${label} is required and cannot be removed.`);
    }
    return;
  }
  const value = choice.item[input.field];
  if (isPlaceholder(value) || (input.validate && !input.validate(value))) {
    errors.push(`${label}.${input.field} must contain an installation value.`);
  }
  if (input.remote && typeof choice.item.remote !== 'boolean') {
    errors.push(`${label}.remote must explicitly be true or false.`);
  }
}

function forEachRemoteBinding(config, visit) {
  for (const path of REMOTE_BINDING_COLLECTIONS) {
    const collection = collectionAt(config, path);
    if (!collection) continue;
    for (const binding of collection) {
      if (isPlainObject(binding)) visit(binding);
    }
  }
}

export function forceLocalBindings(config) {
  const result = clone(config);
  forEachRemoteBinding(result, (binding) => {
    binding.remote = false;
  });
  return result;
}

export function stripDevelopmentBindingFields(config) {
  const result = clone(config);
  forEachRemoteBinding(result, (binding) => {
    delete binding.remote;
  });
  return result;
}

function hasRemoteBinding(config) {
  let found = false;
  forEachRemoteBinding(config, (binding) => {
    if (binding.remote === true) found = true;
  });
  return found;
}

export function validateInstallationConfig(config, override, options = {}) {
  const errors = [];
  if (!Object.hasOwn(override, 'name')) {
    errors.push('name must be explicitly selected by the installation override.');
  }
  if (
    isPlaceholder(config.name)
    || !/^[a-z0-9](?:[a-z0-9-]{0,253}[a-z0-9])?$/u.test(
      config.name,
    )
  ) {
    errors.push('name must contain a deployable Cloudflare Worker name.');
  }
  if (config.main !== 'src/index.ts') {
    errors.push('main must remain src/index.ts.');
  }
  if (config.keep_vars !== true || Object.hasOwn(config, 'vars')) {
    errors.push('dashboard variables require keep_vars=true and no vars object.');
  }
  if (Object.hasOwn(config, 'env')) {
    errors.push('generated deployment configs cannot contain env.');
  }

  requireExplicitChoice(errors, override, {
    path: ['d1_databases'],
    key: 'binding',
    expected: 'EDGE_DB',
    field: 'database_name',
    optional: false,
    remote: true,
  });
  requireExplicitChoice(errors, override, {
    path: ['kv_namespaces'],
    key: 'binding',
    expected: 'EDGE_KV',
    field: 'id',
    optional: true,
    remote: true,
    validate: (value) => /^[0-9a-f]{32}$/iu.test(value)
      && value !== '00000000000000000000000000000000',
  });
  requireExplicitChoice(errors, override, {
    path: ['queues', 'producers'],
    key: 'binding',
    expected: 'MAIL_QUEUE',
    field: 'queue',
    optional: true,
    remote: true,
  });
  for (const name of INSTALLATION_RATE_LIMIT_BINDINGS) {
    requireExplicitChoice(errors, override, {
      path: ['ratelimits'],
      key: 'name',
      expected: name,
      field: 'namespace_id',
      optional: true,
      validate: (value) => /^[0-9]+$/u.test(value),
    });
  }

  const database = config.d1_databases?.find((item) => item.binding === 'EDGE_DB');
  if (!database || isPlaceholder(database.database_name)) {
    errors.push('The generated config must contain the EDGE_DB database_name.');
  }
  if (options.requireRemote === true && !hasRemoteBinding(config)) {
    errors.push(
      'remote development requires at least one binding with remote=true.',
    );
  }

  if (errors.length > 0) {
    throw new TypeError(
      `Installation configuration is incomplete:\n- ${errors.join('\n- ')}`,
    );
  }
}

export function readConfigFragment(configPath) {
  const source = readFileSync(configPath, 'utf8');
  const parseErrors = [];
  const config = parse(source, parseErrors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (parseErrors.length > 0) {
    const first = parseErrors[0];
    const beforeError = source.slice(0, first.offset);
    const line = beforeError.split('\n').length;
    const lastNewline = beforeError.lastIndexOf('\n');
    const column = first.offset - lastNewline;
    throw new TypeError(
      `${configPath} contains invalid JSONC: `
      + `${printParseErrorCode(first.error)} at ${line}:${column}.`,
    );
  }
  if (!isPlainObject(config)) {
    throw new TypeError(`${configPath} must contain one JSON object.`);
  }
  return config;
}

function configuredOverridePath() {
  const configured = process.env.ZEROPRESS_EDGE_WRANGLER_OVERRIDE;
  if (!configured) return DEFAULT_OVERRIDE_PATH;
  return isAbsolute(configured)
    ? configured
    : resolve(process.cwd(), configured);
}

function initializeOverride() {
  if (process.env.ZEROPRESS_EDGE_WRANGLER_OVERRIDE) {
    throw new TypeError(
      'Unset ZEROPRESS_EDGE_WRANGLER_OVERRIDE before initializing the default override.',
    );
  }
  if (existsSync(DEFAULT_OVERRIDE_PATH)) {
    throw new TypeError(
      'wrangler.override.jsonc already exists and was not overwritten.',
    );
  }
  copyFileSync(
    EXAMPLE_OVERRIDE_PATH,
    DEFAULT_OVERRIDE_PATH,
    constants.COPYFILE_EXCL,
  );
  console.log(
    'Created wrangler.override.jsonc from wrangler.override.example.jsonc. '
    + 'Edit it to replace every placeholder and review all installation values. '
    + 'Track it only in the private deployment repository.',
  );
}

function parseArguments(args) {
  if (args.length === 1 && args[0] === '--init') return { init: true };
  if (
    args.length === 2
    && args[0] === '--target'
    && Object.hasOwn(OUTPUT_PATHS, args[1])
  ) {
    return { init: false, target: args[1] };
  }
  throw new TypeError(
    'Usage: node scripts/compose-wrangler-config.mjs --init | '
    + '--target <build|dev|remote-dev|deploy>',
  );
}

function invalidateGeneratedConfig(outputPath) {
  for (const candidate of [outputPath, `${outputPath}.tmp`]) {
    if (existsSync(candidate)) unlinkSync(candidate);
  }
}

export function readRequiredInstallationOverride(target, overridePath) {
  if (!existsSync(overridePath)) {
    if (
      process.env.ZEROPRESS_EDGE_WRANGLER_OVERRIDE
      || overridePath !== DEFAULT_OVERRIDE_PATH
    ) {
      throw new TypeError(
        `Installation override ${JSON.stringify(overridePath)} is required for ${target}. `
        + 'Provide the file at that path or update ZEROPRESS_EDGE_WRANGLER_OVERRIDE.',
      );
    }
    initializeOverride();
  }
  return readConfigFragment(overridePath);
}

export function writeGeneratedConfig(target) {
  const outputPath = OUTPUT_PATHS[target];
  invalidateGeneratedConfig(outputPath);

  const overridePath = configuredOverridePath();
  const base = readConfigFragment(BASE_CONFIG_PATH);
  const override = readRequiredInstallationOverride(target, overridePath);
  let config = composeWranglerConfig(base, override);
  validateInstallationConfig(config, override, {
    requireRemote: target === 'remote-dev',
  });
  config = target === 'dev'
    ? forceLocalBindings(config)
    : target === 'remote-dev'
      ? config
      : stripDevelopmentBindingFields(config);

  const banner = [
    '// Generated by scripts/compose-wrangler-config.mjs.',
    '// Do not edit.',
    '',
  ].join('\n');
  const temporaryOutputPath = `${outputPath}.tmp`;
  writeFileSync(
    temporaryOutputPath,
    `${banner}${JSON.stringify(config, null, 2)}\n`,
    'utf8',
  );
  renameSync(temporaryOutputPath, outputPath);
  const relativeOutputPath = outputPath.slice(PROJECT_ROOT.length + 1);
  console.log(
    `Generated ${relativeOutputPath} from wrangler.base.jsonc`
    + ' and the installation override.',
  );
}

function main() {
  const command = parseArguments(process.argv.slice(2));
  if (command.init) initializeOverride();
  else writeGeneratedConfig(command.target);
}

const invokedUrl = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : null;
if (import.meta.url === invokedUrl) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
