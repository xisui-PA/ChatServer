/**
 * Shared runtime type guards for values that arrive as untrusted data, such as
 * parsed JSON, provider responses, and configuration files.
 */

/** Returns true when `value` is a string. */
export function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/** Returns true when `value` is a number, including `NaN` and infinities. */
export function isNumber(value: unknown): value is number {
  return typeof value === 'number';
}

/** Returns true when `value` is a boolean. */
export function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

/** Returns true for any non-null object, including arrays, dates, and maps. */
export function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

/** Returns true for non-null objects that are not arrays; functions are rejected. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return isObject(value) && !Array.isArray(value);
}

/** Returns true for functions, typed as callable so callers need no assertions. */
export function isFunction(value: unknown): value is (...args: never[]) => unknown {
  return typeof value === 'function';
}
