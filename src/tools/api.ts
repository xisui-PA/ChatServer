import { ApiToolDefinition } from './interface';

/** Validates the shared shape; the selected provider validates tool-specific options. */
export function parseApiTools(value: unknown): ApiToolDefinition[] {
  if (!Array.isArray(value)) {
    throw new Error('apiTools must be an array of tool type strings or provider-hosted tool objects.');
  }
  return value.map((entry: unknown, index) => {
    const tool = typeof entry === 'string' ? { type: entry } : entry;
    if (typeof tool !== 'object' || tool === null || Array.isArray(tool) ||
      !('type' in tool) || typeof tool.type !== 'string' || !/^\S+$/.test(tool.type)) {
      throw new Error(`apiTools[${index}] must be a nonempty tool type string or an object with a type, without whitespace in the type.`);
    }
    if (tool.type === 'function' || tool.type === 'custom') {
      throw new Error(`apiTools[${index}]: "${tool.type}" requires application execution; use registered localTools instead.`);
    }
    return { ...tool, type: tool.type };
  });
}
