import { CalculateTool } from './calculate';
import { CurrentTimeTool } from './current-time';
import { Tool } from './interface';
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

/** Creates a per-replier tool set; an empty list disables tool calling. */
export function createTools(names: readonly string[] = DEFAULT_TOOL_NAMES): Tool[] {
  return [...new Set(names)].map((name) => {
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
