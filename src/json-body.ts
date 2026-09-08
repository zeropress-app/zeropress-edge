export type BoundedJsonResult =
  | { ok: true; value: unknown }
  | { ok: false; kind: 'too_large' | 'invalid_json' };

export function isApplicationJsonContentType(value: string | null): boolean {
  const mediaType = (value ?? '').split(';', 1)[0].trim().toLowerCase();
  return mediaType === 'application/json';
}

export async function readBoundedJson(
  request: Request,
  maxBytes: number,
): Promise<BoundedJsonResult> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError('maxBytes must be a non-negative safe integer.');
  }

  const contentLength = request.headers.get('Content-Length');
  if (contentLength !== null && isDecimalAboveLimit(contentLength, maxBytes)) {
    await cancelStream(request.body);
    return { ok: false, kind: 'too_large' };
  }

  if (!request.body) {
    return { ok: false, kind: 'invalid_json' };
  }

  const reader = request.body.getReader();
  const utf8Validator = new TextDecoder('utf-8', { fatal: true });
  let bodyBytes: Uint8Array = new Uint8Array(Math.min(maxBytes, 4096));
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      if (value.byteLength > maxBytes - totalBytes) {
        await cancelReader(reader);
        return { ok: false, kind: 'too_large' };
      }

      utf8Validator.decode(value, { stream: true });
      const nextTotalBytes = totalBytes + value.byteLength;
      if (nextTotalBytes > bodyBytes.byteLength) {
        bodyBytes = growBuffer(bodyBytes, nextTotalBytes, maxBytes);
      }
      bodyBytes.set(value, totalBytes);
      totalBytes = nextTotalBytes;
    }

    utf8Validator.decode();
    const decodedBody = new TextDecoder('utf-8', { fatal: true })
      .decode(bodyBytes.subarray(0, totalBytes));
    return {
      ok: true,
      value: JSON.parse(decodedBody) as unknown,
    };
  } catch {
    await cancelReader(reader);
    return { ok: false, kind: 'invalid_json' };
  } finally {
    reader.releaseLock();
  }
}

function isDecimalAboveLimit(value: string, limit: number): boolean {
  if (!/^\d+$/.test(value)) {
    return false;
  }

  const normalizedValue = value.replace(/^0+/, '') || '0';
  const normalizedLimit = String(limit);
  if (normalizedValue.length !== normalizedLimit.length) {
    return normalizedValue.length > normalizedLimit.length;
  }

  return normalizedValue > normalizedLimit;
}

function growBuffer(buffer: Uint8Array, requiredBytes: number, maxBytes: number): Uint8Array {
  const nextCapacity = Math.min(
    maxBytes,
    Math.max(requiredBytes, Math.max(1, buffer.byteLength * 2)),
  );
  const nextBuffer = new Uint8Array(nextCapacity);
  nextBuffer.set(buffer);
  return nextBuffer;
}

async function cancelStream(stream: ReadableStream<Uint8Array> | null): Promise<void> {
  if (!stream) {
    return;
  }

  try {
    await stream.cancel();
  } catch {
    // Cancellation is best-effort because the stream may already be closed or locked.
  }
}

async function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // Cancellation is best-effort because the stream may already be closed.
  }
}
