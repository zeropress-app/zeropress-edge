type EdgeLogMetadata = Record<string, unknown>;

function compactMetadata(metadata: EdgeLogMetadata | undefined): EdgeLogMetadata | undefined {
  if (!metadata) {
    return undefined;
  }

  const entries = Object.entries(metadata).filter(([, value]) => value !== undefined);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function createEdgeLog(message: string, metadata?: EdgeLogMetadata): Record<string, unknown> {
  const compactedMetadata = compactMetadata(metadata);
  return compactedMetadata ? { message, $zeropress: compactedMetadata } : { message };
}

export function getLogErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function logError(message: string, metadata?: EdgeLogMetadata): void {
  console.error(createEdgeLog(message, metadata));
}

export function logWarn(message: string, metadata?: EdgeLogMetadata): void {
  console.warn(createEdgeLog(message, metadata));
}

export function logInfo(message: string, metadata?: EdgeLogMetadata): void {
  console.log(createEdgeLog(message, metadata));
}
