import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { build } from 'esbuild';
import { parse } from 'jsonc-parser';
import { Miniflare, type WorkerOptions } from 'miniflare';
import { unstable_splitSqlQuery } from 'wrangler';
import type { EdgeMailQueueMessage, Env } from '../../src/env';
import type { PublicRateLimiterBinding } from '../../src/rate-limit';
import { installSql } from './sqlite-d1';
import { publicBindings, seedPublicFixtures } from './fixtures';

type Bindings = NonNullable<WorkerOptions['config']['env']>;
type RuntimeRequestInit = { method?: string; body?: string; headers?: Record<string, string> };
const { compatibility_date: compatibilityDate } = parse(readFileSync(
  new URL('../../wrangler.jsonc', import.meta.url), 'utf8',
)) as { compatibility_date: string };
let bundledWorker: Promise<string> | undefined;
let loopbackAvailable: Promise<void> | undefined;

function checkLoopbackAccess() {
  // Surface restricted execution environments immediately; otherwise workerd
  // startup can leave mf.ready pending until every smoke test times out.
  return loopbackAvailable ??= new Promise<void>((resolve, reject) => {
    const server = createServer();
    server.once('error', (cause) => reject(new Error(
      'Edge runtime tests require permission to start a loopback server on 127.0.0.1.', { cause },
    )));
    server.listen(0, '127.0.0.1', () => server.close((error) => error ? reject(error) : resolve()));
  });
}

function bundle() {
  return bundledWorker ??= build({
    entryPoints: [fileURLToPath(new URL('../../src/index.ts', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022',
  }).then((result) => result.outputFiles[0].text);
}

const queueCaptureScript = `
  const messages = [];
  export default {
    fetch() { return Response.json(messages); },
    queue(batch) {
      for (const message of batch.messages) {
        messages.push(message.body);
        message.ack();
      }
    },
  };
`;

export async function createLocalWorker(options: {
  bindings?: Record<string, string>;
  resources?: boolean;
  rateLimits?: Partial<Record<PublicRateLimiterBinding, number>>;
} = {}) {
  await checkLoopbackAccess();
  const directory = await mkdtemp(join(tmpdir(), 'zeropress-edge-test-'));
  const outboundRequests: string[] = [];
  const bindings: Bindings = Object.fromEntries(
    Object.entries({ ...publicBindings, ...options.bindings })
      .map(([key, value]) => [key, { type: 'text', value }]),
  );
  if (options.resources !== false) {
    Object.assign(bindings, {
      EDGE_DB: { type: 'd1', id: 'test-edge-db', dev: { remote: false } },
      EDGE_KV: { type: 'kv', id: 'test-edge-kv', dev: { remote: false } },
      MAIL_QUEUE: { type: 'queue', name: 'test-edge-mail', dev: { remote: false } },
    });
    const rateLimiters: PublicRateLimiterBinding[] = [
      'COMMENT_READ_RATE_LIMITER', 'COMMENT_WRITE_RATE_LIMITER', 'COMMENT_CHALLENGE_RATE_LIMITER',
      'NEWSLETTER_READ_RATE_LIMITER', 'NEWSLETTER_SUBSCRIBE_RATE_LIMITER', 'NEWSLETTER_CHALLENGE_RATE_LIMITER',
      'FORM_READ_RATE_LIMITER', 'FORM_SUBMIT_RATE_LIMITER', 'FORM_CHALLENGE_RATE_LIMITER',
    ];
    rateLimiters.forEach((name, index) => {
      bindings[name] = { type: 'rate-limit', namespace: String(index + 1), simple: {
        limit: options.rateLimits?.[name] ?? 1000, period: 60,
      } };
    });
  }

  // Only the compatibility date comes from wrangler.jsonc. Bindings and storage
  // are disposable fixtures; credentials and external requests are excluded.
  const dev = {
    rootPath: directory,
    unsafeRegisterWorker: false,
    outboundService: { type: 'fetcher' as const, handler: (request: { url: string }): never => {
      outboundRequests.push(request.url);
      throw new Error('External requests are disabled in Edge runtime tests');
    } },
  };
  let mf: Miniflare | undefined;
  try {
    mf = new Miniflare({
      host: '127.0.0.1', port: 0, cf: false, telemetry: { enabled: false },
      resourcePersistencePath: directory,
      resourceTmpPath: join(directory, 'tmp'),
      unsafeDevRegistryPath: join(directory, 'registry'),
      unsafeEnableSharedStorage: false,
      workers: [
        {
          config: {
            name: 'edge-test', compatibilityDate,
            manifest: { mainModule: 'index.js', modules: { 'index.js': { type: 'esm', contents: await bundle() } } },
            env: bindings,
          }, dev,
        },
        {
          config: {
            name: 'mail-capture', compatibilityDate,
            manifest: { mainModule: 'capture.js', modules: { 'capture.js': { type: 'esm', contents: queueCaptureScript } } },
            triggers: [{ type: 'queue', name: 'test-edge-mail', maxBatchSize: 1, maxBatchTimeout: 0 }],
          }, dev,
        },
      ],
    });
    await mf.ready;
    const env = await mf.getBindings<Env>('edge-test');
    if (options.resources !== false) {
      // Fixture setup applies only to this fresh, disposable simulator.
      await env.EDGE_DB.batch(installSql.flatMap(unstable_splitSqlQuery)
        .map((sql) => env.EDGE_DB.prepare(sql)));
      await seedPublicFixtures(env.EDGE_DB);
    }
    const capture = await mf.getWorker('mail-capture');
    return {
      env,
      outboundRequests,
      fetch: (path: string, init?: RuntimeRequestInit) => mf!.dispatchFetch(`https://edge.example${path}`, {
        ...init, headers: { Origin: 'https://site.example', 'CF-Connecting-IP': '203.0.113.50',
          ...init?.headers },
      }),
      messages: async () => (await (await capture.fetch('https://capture.test/')).json()) as EdgeMailQueueMessage[],
      async dispose() {
        try { await mf!.dispose(); } finally { await rm(directory, { recursive: true, force: true }); }
      },
    };
  } catch (error) {
    try { await mf?.dispose(); } finally { await rm(directory, { recursive: true, force: true }); }
    throw error;
  }
}
