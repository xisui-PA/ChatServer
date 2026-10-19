import { getModelApiKey } from './credentials';
import { findProvider, loadModels } from './model-store';
import { parseModelReference } from './reference';
import { createResponse, ResponseItem, ResponseRequest, resolveModelTimeoutMs } from './responses-client';
import { Tool } from '../tools/interface';
import { ToolRunner } from '../tools/runner';

/** Per-request generation settings; never mutate a shared model's defaults. */
export interface GenerationOptions {
  tools?: readonly Tool[];
  reasoningEffort?: ResponseRequest['reasoningEffort'];
}

/** A configured model that accepts text or multimodal input and returns text. */
export interface TextModel {
  generate(
    input: string | readonly ResponseItem[],
    instructions: string,
    signal?: AbortSignal,
    options?: GenerationOptions
  ): Promise<string>;
}

/** A model bound to its provider endpoint and credential. */
class ProviderModel implements TextModel {
  public constructor(
    private readonly baseUrl: string,
    private readonly modelId: string,
    private readonly apiKey: string,
    private readonly timeoutMs: number
  ) {}

  public async generate(
    input: string | readonly ResponseItem[],
    instructions: string,
    signal?: AbortSignal,
    options: GenerationOptions = {}
  ): Promise<string> {
    const tools = options.tools ?? [];
    if (tools.length === 0) {
      const result = await createResponse({
        baseUrl: this.baseUrl,
        model: this.modelId,
        apiKey: this.apiKey,
        input,
        instructions,
        reasoningEffort: options.reasoningEffort,
        timeoutMs: this.timeoutMs,
        signal
      });
      return result.outputText;
    }
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) {
      controller.abort();
    }
    const timer = setTimeout(cancel, this.timeoutMs);
    try {
      return await this.generateWithTools(input, instructions, tools, controller.signal, options.reasoningEffort);
    } catch (error) {
      if (controller.signal.aborted && !signal?.aborted) {
        throw new Error(`Model "${this.modelId}" timed out after ${this.timeoutMs} ms.`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
    }
  }

  /** Replays every output item, executes calls locally, and returns only final text. */
  private async generateWithTools(
    input: string | readonly ResponseItem[],
    instructions: string,
    tools: readonly Tool[],
    signal: AbortSignal,
    reasoningEffort: ResponseRequest['reasoningEffort']
  ): Promise<string> {
    const runner = new ToolRunner(tools);
    const history: ResponseItem[] = typeof input === 'string'
      ? [{ role: 'user', content: input }] : [...input];
    const maxCalls = 8;
    let usedCalls = 0;
    const callIds = new Set<string>();
    // At most eight tool-producing rounds, followed by one tool-free final answer.
    for (let round = 0; round <= maxCalls; round += 1) {
      signal.throwIfAborted();
      const result = await createResponse({
        baseUrl: this.baseUrl,
        model: this.modelId,
        apiKey: this.apiKey,
        input: history,
        instructions,
        reasoningEffort,
        timeoutMs: this.timeoutMs,
        signal,
        tools: tools.map((tool) => tool.definition),
        toolChoice: usedCalls >= maxCalls ? 'none' : 'auto'
      });
      const raw = result.raw;
      if (typeof raw !== 'object' || raw === null || !('output' in raw) || !Array.isArray(raw.output) ||
        !raw.output.every((item: unknown) => typeof item === 'object' && item !== null && !Array.isArray(item))) {
        throw new Error('Tool-capable models must return a Responses API output array.');
      }
      const output = raw.output as ResponseItem[];
      const calls = output.filter((item) => item.type === 'function_call');
      if (calls.length === 0) {
        if (!result.outputText) {
          throw new Error('Model returned neither tool calls nor final text.');
        }
        return result.outputText;
      }
      if (usedCalls >= maxCalls) {
        throw new Error('Model continued calling tools after the tool budget was exhausted.');
      }
      history.push(...output);
      for (const call of calls) {
        if (typeof call.call_id !== 'string' || !call.call_id || typeof call.name !== 'string' ||
          typeof call.arguments !== 'string' || callIds.has(call.call_id)) {
          throw new Error('Model returned a malformed or duplicate function call.');
        }
        callIds.add(call.call_id);
        const toolOutput = usedCalls < maxCalls
          ? await runner.execute(call.name, call.arguments, signal)
          : JSON.stringify({ ok: false, error: 'Tool budget exhausted; answer using existing results.' });
        usedCalls += 1;
        history.push({ type: 'function_call_output', call_id: call.call_id, output: toolOutput });
      }
    }
    throw new Error('Tool calling exceeded the round limit.');
  }
}

/** Resolves configured model IDs and credentials once, before transports start. */
export class ModelRegistry {
  private readonly models = new Map<string, TextModel>();

  public static async load(
    configDir: string,
    references: readonly string[]
  ): Promise<ModelRegistry> {
    const registry = new ModelRegistry();
    if (references.length === 0) {
      return registry;
    }
    const file = await loadModels(configDir);
    const bindings = [...new Set(references)].map((reference) => {
      const { provider: providerName, modelId } = parseModelReference(reference);
      const provider = findProvider(file, providerName);
      if (provider === undefined || !provider.models.some((model) => model.id === modelId)) {
        throw new Error(`Model "${reference}" is not configured in models.json. Use chatserver-models add first.`);
      }
      return { reference, provider, modelId };
    });
    const keys = new Map<string, string>();
    for (const { reference, provider, modelId } of bindings) {
      let apiKey = keys.get(provider.provider);
      if (apiKey === undefined) {
        apiKey = await getModelApiKey(provider.provider);
        keys.set(provider.provider, apiKey);
      }
      registry.models.set(reference, new ProviderModel(
        provider.baseUrl, modelId, apiKey, resolveModelTimeoutMs(provider.timeoutMs)
      ));
    }
    return registry;
  }

  public get(reference: string): TextModel {
    const model = this.models.get(reference);
    if (model === undefined) {
      throw new Error(`Model "${reference}" has not been loaded.`);
    }
    return model;
  }
}
