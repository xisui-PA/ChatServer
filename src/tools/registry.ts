import { CalculateTool } from './calculate';
import { CurrentTimeTool } from './current-time';
import { LocalToolSpec, Tool } from './interface';
import { ReadUrlTool } from './read-url';
import { WebSearchTool } from './web-search';

export const DEFAULT_TOOL_NAMES: readonly string[] = ['web_search', 'read_url', 'calculate', 'current_time'];

const factories = new Map<string, () => Tool>([
  ['web_search', () => new WebSearchTool()],
  ['read_url', () => new ReadUrlTool()],
  ['calculate', () => new CalculateTool()],
  ['current_time', () => new CurrentTimeTool()]
]);

/** Registers a tool implementation, including replacement search backends. */
export function registerTool(name: string, factory: () => Tool): void {
  factories.set(name, factory);
}

export function hasTool(name: string): boolean {
  return factories.has(name);
}

export function listTools(): string[] {
  return [...factories.keys()].sort();
}

/** Normalizes local selection syntax and validates names against the registered tools. */
export function parseLocalTools(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error('localTools must be an array of registered tool names or objects with a type.');
  }
  const names = value.map((entry: unknown, index) => {
    let name: unknown = entry;
    if (typeof entry === 'object' && entry !== null && !Array.isArray(entry)) {
      if (Object.keys(entry).some((key) => key !== 'type')) {
        throw new Error(`localTools[${index}] supports only the type field.`);
      }
      name = 'type' in entry ? entry.type : undefined;
    }
    if (typeof name !== 'string' || !hasTool(name)) {
      throw new Error(`localTools[${index}] must name a registered tool. Available: ${listTools().join(', ')}.`);
    }
    return name;
  });
  return [...new Set(names)];
}

/** Creates a per-replier tool set; an empty list disables tool calling. */
export function createTools(specs: readonly LocalToolSpec[] = DEFAULT_TOOL_NAMES): Tool[] {
  return parseLocalTools(specs).map((name) => {
    const factory = factories.get(name);
    if (factory === undefined) {
      throw new Error(`Unknown tool "${name}". Available: ${listTools().join(', ')}.`);
    }
    const tool = factory();
    if (tool.definition.name !== name) {
      throw new Error(`Tool "${name}" has a mismatching function name.`);
    }
    return tool;
  });
}
