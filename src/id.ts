export const ID_PATTERN = /^[0-9a-f]{32}$/;

export function createId(): string {
  return crypto.randomUUID().replace(/-/g, '').toLowerCase();
}
