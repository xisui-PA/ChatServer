/** A function declaration sent to a model through the Responses API. */
export interface ToolDefinition {
  type: 'function';
  name: string;
  description: string;
  parameters: Readonly<Record<string, unknown>>;
  strict: true;
}

/** Provider-hosted tool configuration, forwarded with its provider-specific options. */
export interface ApiToolDefinition {
  readonly type: string;
  readonly [option: string]: unknown;
}

/** Local tool selection accepts a registered name or its explicit type form. */
export type LocalToolSpec = string | { readonly type: string };

/** Hosted tool selection accepts a type shorthand or a provider configuration object. */
export type ApiToolSpec = string | ApiToolDefinition;

/** An application-managed capability. Tool results must be JSON serializable. */
export interface Tool {
  readonly definition: ToolDefinition;
  execute(args: unknown, signal?: AbortSignal): Promise<unknown>;
}

/** Validates an argument object before a tool accesses any fields. */
export function toolArguments(args: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new Error('Tool arguments must be a JSON object.');
  }
  const record = args as Record<string, unknown>;
  if (Object.keys(record).some((key) => !keys.includes(key))) {
    throw new Error('Unknown tool argument.');
  }
  return record;
}

/** Reads a bounded, nonempty string argument. */
export function stringArgument(args: Record<string, unknown>, name: string, maxLength: number): string {
  const value = args[name];
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new Error(`${name} must be a nonempty string of at most ${maxLength} characters.`);
  }
  return value.trim();
}
