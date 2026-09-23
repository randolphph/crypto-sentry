const SENSITIVE_KEY = /^(?:rpcUrl|headers?|authorization|api[-_]?token|bot[-_]?token|token|secret|password|private[-_]?key|master[-_]?encryption[-_]?key)$/i;
const MAX_STRING_LENGTH = 4_096;
const MAX_DEPTH = 8;

/**
 * Redacts credentials while keeping API request bodies useful for frontend/backend
 * integration debugging. Wallets, chain IDs, token IDs and monitor names remain visible.
 */
export function redactLogValue(value: unknown, key = '', depth = 0): unknown {
  if (SENSITIVE_KEY.test(key)) return '[REDACTED]';
  if (depth >= MAX_DEPTH) return '[TRUNCATED]';
  if (typeof value === 'string') {
    return value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}…` : value;
  }
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => redactLogValue(item, '', depth + 1));
  return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [
    entryKey,
    redactLogValue(entryValue, entryKey, depth + 1),
  ]));
}
