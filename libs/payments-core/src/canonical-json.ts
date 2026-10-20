import { NonCanonicalValueError } from './errors';

/**
 * Serializes a JSON-like value to ONE canonical string, so that two requests that mean the same
 * thing produce the same bytes (Module 3.4):
 *
 * - object keys are sorted (UTF-16 code unit order, which is deterministic everywhere)
 * - no whitespace
 * - array order is preserved (order is meaning in an array)
 * - numbers use JavaScript's shortest round-trip form; -0 becomes 0; 1.0 and 1 are the same number
 *
 * It is deliberately strict. Anything that has no single obvious canonical form throws
 * NonCanonicalValueError instead of being silently dropped or coerced (as JSON.stringify would do
 * with undefined or NaN), because a hash that ignores part of the request would let two different
 * payments share one idempotency key.
 */
export function canonicalize(value: unknown): string {
  return serialize(value, '$', new Set());
}

function serialize(value: unknown, path: string, ancestors: Set<object>): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new NonCanonicalValueError(path, `${value} is not a finite number`);
      }
      return JSON.stringify(value);
    case 'object':
      return serializeObject(value, path, ancestors);
    default:
      throw new NonCanonicalValueError(path, `${typeof value} is not a JSON value`);
  }
}

function serializeObject(value: object, path: string, ancestors: Set<object>): string {
  if (ancestors.has(value)) {
    throw new NonCanonicalValueError(path, 'circular reference');
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      // Array.from visits holes as undefined, which then throws, instead of skipping them.
      const items = Array.from(value, (item, index) => serialize(item, `${path}[${index}]`, ancestors));
      return `[${items.join(',')}]`;
    }

    const proto = Object.getPrototypeOf(value) as unknown;
    if (proto !== Object.prototype && proto !== null) {
      throw new NonCanonicalValueError(path, 'only plain objects and arrays are allowed (no Date, Map, class instances...)');
    }

    const record = value as Record<string, unknown>;
    const members = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${serialize(record[key], `${path}.${key}`, ancestors)}`);
    return `{${members.join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}
