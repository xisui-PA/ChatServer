import { MAX_TOOL_ARGUMENT_CHARS, MAX_TOOL_OUTPUT_CHARS } from '../limit';
import { Tool } from './interface';

/** Executes only the functions explicitly supplied to this replier. */
export class ToolRunner {
  private readonly tools = new Map<string, Tool>();

  public constructor(tools: readonly Tool[]) {
    for (const tool of tools) {
      if (this.tools.has(tool.definition.name)) {
        throw new Error(`Duplicate tool name "${tool.definition.name}".`);
      }
      this.tools.set(tool.definition.name, tool);
    }
  }

  /** Converts argument/execution errors into data the model can act on. */
  public async execute(name: string, encodedArgs: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    try {
      if (encodedArgs.length > MAX_TOOL_ARGUMENT_CHARS) {
        throw new Error('Tool arguments exceed the size limit.');
      }
      const tool = this.tools.get(name);
      if (tool === undefined) {
        throw new Error(`Tool "${name}" is not enabled.`);
      }
      const args: unknown = JSON.parse(encodedArgs);
      const result = await tool.execute(args, signal);
      signal?.throwIfAborted();
      const output = JSON.stringify({ ok: true, result });
      if (output.length > MAX_TOOL_OUTPUT_CHARS) {
        throw new Error('Tool output exceeds the size limit.');
      }
      return output;
    } catch (error) {
      signal?.throwIfAborted();
      return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : 'Tool execution failed.' });
    }
  }
}
