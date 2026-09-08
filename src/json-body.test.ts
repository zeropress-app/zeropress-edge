import { describe, expect, it, vi } from 'vitest';
import { isApplicationJsonContentType, readBoundedJson } from './json-body';

const textEncoder = new TextEncoder();

describe('isApplicationJsonContentType', () => {
  it('accepts application/json with case and parameters', () => {
    expect(isApplicationJsonContentType('application/json')).toBe(true);
    expect(isApplicationJsonContentType('Application/JSON; Charset=UTF-8')).toBe(true);
  });

  it('rejects other or prefix-matching media types', () => {
    expect(isApplicationJsonContentType('application/jsonp')).toBe(false);
    expect(isApplicationJsonContentType('application/problem+json')).toBe(false);
    expect(isApplicationJsonContentType(null)).toBe(false);
  });
});

describe('readBoundedJson', () => {
  it('parses JSON at the exact byte limit', async () => {
    const body = textEncoder.encode('{"ok":true}');
    const request = createStreamRequest([body], {
      'Content-Length': String(body.byteLength),
    });

    await expect(readBoundedJson(request, body.byteLength)).resolves.toEqual({
      ok: true,
      value: { ok: true },
    });
  });

  it('decodes UTF-8 characters split across stream chunks', async () => {
    const body = textEncoder.encode('{"value":"한글"}');
    const splitIndex = body.indexOf(0xed) + 1;
    const request = createStreamRequest([
      body.slice(0, splitIndex),
      body.slice(splitIndex),
    ]);

    await expect(readBoundedJson(request, body.byteLength)).resolves.toEqual({
      ok: true,
      value: { value: '한글' },
    });
  });

  it('parses a body delivered as many tiny chunks', async () => {
    const body = textEncoder.encode(JSON.stringify({ value: 'x'.repeat(8192) }));
    const request = createStreamRequest(Array.from(body, (byte) => new Uint8Array([byte])));

    await expect(readBoundedJson(request, body.byteLength)).resolves.toEqual({
      ok: true,
      value: { value: 'x'.repeat(8192) },
    });
  });

  it('rejects a valid decimal Content-Length above the limit without reading the body', async () => {
    const pull = vi.fn();
    const cancel = vi.fn();
    const request = createStreamRequest([textEncoder.encode('{}')], {
      'Content-Length': '999999999999999999999999999999',
    }, { pull, cancel });

    await expect(readBoundedJson(request, 1024)).resolves.toEqual({
      ok: false,
      kind: 'too_large',
    });
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('does not trust a smaller declared Content-Length', async () => {
    const cancel = vi.fn();
    const request = createStreamRequest([
      textEncoder.encode('123'),
      textEncoder.encode('456'),
    ], {
      'Content-Length': '2',
    }, { cancel });

    await expect(readBoundedJson(request, 5)).resolves.toEqual({
      ok: false,
      kind: 'too_large',
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('returns too_large when stream cancellation fails', async () => {
    const request = createStreamRequest([textEncoder.encode('{}')], {
      'Content-Length': '3',
    }, {
      cancel: async () => {
        throw new Error('cancel failed');
      },
    });

    await expect(readBoundedJson(request, 2)).resolves.toEqual({
      ok: false,
      kind: 'too_large',
    });
  });

  it('ignores a non-decimal Content-Length and counts the actual bytes', async () => {
    const body = textEncoder.encode('{"ok":true}');
    const request = createStreamRequest([body], {
      'Content-Length': '1e6',
    });

    await expect(readBoundedJson(request, body.byteLength)).resolves.toEqual({
      ok: true,
      value: { ok: true },
    });
  });

  it('accepts a zero-padded Content-Length at the byte limit', async () => {
    const body = textEncoder.encode('{}');
    const request = createStreamRequest([body], {
      'Content-Length': '0002',
    });

    await expect(readBoundedJson(request, body.byteLength)).resolves.toEqual({
      ok: true,
      value: {},
    });
  });

  it('counts multibyte UTF-8 input by bytes instead of JavaScript string length', async () => {
    const body = textEncoder.encode('"💾"');
    const cancel = vi.fn();
    const request = createStreamRequest([body], undefined, { cancel });

    expect('"💾"'.length).toBeLessThan(body.byteLength);
    await expect(readBoundedJson(request, body.byteLength - 1)).resolves.toEqual({
      ok: false,
      kind: 'too_large',
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('returns invalid_json for malformed UTF-8', async () => {
    const cancel = vi.fn();
    const request = createStreamRequest([
      new Uint8Array([0x22, 0xc3]),
      new Uint8Array([0x28, 0x22]),
    ], undefined, { cancel });

    await expect(readBoundedJson(request, 4)).resolves.toEqual({
      ok: false,
      kind: 'invalid_json',
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('returns invalid_json for syntactically invalid JSON', async () => {
    const request = createStreamRequest([textEncoder.encode('{"value":}')]);

    await expect(readBoundedJson(request, 64)).resolves.toEqual({
      ok: false,
      kind: 'invalid_json',
    });
  });

  it('returns invalid_json when the request has no body', async () => {
    const request = new Request('https://example.com/api', { method: 'POST' });

    await expect(readBoundedJson(request, 64)).resolves.toEqual({
      ok: false,
      kind: 'invalid_json',
    });
  });

  it('rejects invalid maximum byte limits', async () => {
    const request = createStreamRequest([textEncoder.encode('{}')]);

    await expect(readBoundedJson(request, -1)).rejects.toThrow(RangeError);
  });
});

type StreamHooks = {
  pull?: () => void;
  cancel?: () => void | Promise<void>;
};

function createStreamRequest(
  chunks: Uint8Array[],
  headers?: HeadersInit,
  hooks: StreamHooks = {},
): Request {
  let chunkIndex = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      hooks.pull?.();
      if (chunkIndex < chunks.length) {
        controller.enqueue(chunks[chunkIndex]);
        chunkIndex += 1;
        return;
      }

      controller.close();
    },
    cancel() {
      return hooks.cancel?.();
    },
  }, {
    highWaterMark: 0,
  });

  return new Request('https://example.com/api', {
    method: 'POST',
    headers,
    body,
    duplex: 'half',
  } as RequestInit);
}
