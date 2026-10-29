import { MAX_MODEL_TOOL_CALLS, MODEL_INPUT_TOKENS, TOOL_RESULT_TOKENS } from '../limit';
import { getModelApiKey } from './credentials';
import { findProvider, loadModels } from './model-store';
import { parseModelReference } from './reference';
import { createResponse, ResponseCitation, ResponseItem, ResponseRequest, ResponseResult, ResponsesApiError, resolveModelTimeoutMs } from './responses-client';
import { ApiToolDefinition, ApiToolSpec, Tool } from '../tools/interface';
import { parseApiTools } from '../tools/api';
import { ToolRunner } from '../tools/runner';
import { assertInputBudget, boundedText, modelInputTokens } from './input-budget';
import { withModelRetries } from './retry';
import { AudioFile } from '../messagers/interface';
import { createTranscription, TranscriptionModel } from './transcriptions-client';
import { createSpeech, SpeechModel } from './speech-client';

/** Per-request generation settings; never mutate a shared model's defaults. */
export interface GenerationOptions {
  localTools?: readonly Tool[];
  apiTools?: readonly ApiToolSpec[];
  /** Delivers final-response citations without mixing metadata into model text. */
  onCitations?: (citations: readonly ResponseCitation[]) => void;
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
class ProviderModel implements TextModel, TranscriptionModel, SpeechModel {
  public constructor(
    private readonly baseUrl: string,
    private readonly modelId: string,
    private readonly apiKey: string,
    private readonly timeoutMs: number
  ) {}

  public transcribe(audio: AudioFile, signal?: AbortSignal): Promise<string> {
    return withModelRetries(() => createTranscription({
      baseUrl: this.baseUrl, model: this.modelId, apiKey: this.apiKey,
      audio, timeoutMs: this.timeoutMs, signal
    }), signal);
  }

  public synthesize(text: string, options?: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<AudioFile> {
    return withModelRetries(() => createSpeech({ baseUrl: this.baseUrl, model: this.modelId, apiKey: this.apiKey,
      text, options, timeoutMs: this.timeoutMs, signal }), signal);
  }

  public async generate(
    input: string | readonly ResponseItem[],
    instructions: string,
    signal?: AbortSignal,
    options: GenerationOptions = {}
  ): Promise<string> {
    const localTools = options.localTools ?? [];
    const apiTools = parseApiTools(options.apiTools ?? []);
    assertInputBudget(input, instructions, [...localTools.map((tool) => tool.definition), ...apiTools]);
    const generation = { ...options, localTools, apiTools };
    const result = await withModelRetries(() => this.generateOnce(input, instructions, signal, generation), signal);
    options.onCitations?.(result.citations);
    return result.outputText;
  }

  /** Each attempt starts a fresh tool cycle and gets the provider's generation timeout. */
  private async generateOnce(
    input: string | readonly ResponseItem[],
    instructions: string,
    signal: AbortSignal | undefined,
    options: Omit<GenerationOptions, 'apiTools'> & { apiTools: readonly ApiToolDefinition[] }
  ): Promise<ResponseResult> {
    const localTools = options.localTools ?? [];
    const apiTools = options.apiTools ?? [];
    if (localTools.length === 0 && apiTools.length === 0) {
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
      return result;
    }
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) {
      controller.abort();
    }
    const timer = setTimeout(cancel, this.timeoutMs);
    try {
      return await this.generateWithTools(input, instructions, localTools, apiTools, controller.signal, options.reasoningEffort);
    } catch (error) {
      if (controller.signal.aborted && !signal?.aborted) {
        throw new ResponsesApiError(`Model "${this.modelId}" timed out after ${this.timeoutMs} ms.`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
    }
  }

  /** Replays every output item and executes only configured local function calls. */
  private async generateWithTools(
    input: string | readonly ResponseItem[],
    instructions: string,
    localTools: readonly Tool[],
    apiTools: readonly ApiToolDefinition[],
    signal: AbortSignal,
    reasoningEffort: ResponseRequest['reasoningEffort']
  ): Promise<ResponseResult> {
    const runner = new ToolRunner(localTools);
    const initial: ResponseItem[] = typeof input === 'string'
      ? [{ role: 'user', content: input }] : [...input];
    const turns: ResponseItem[][] = [];
    const localDefinitions = localTools.map((tool) => tool.definition);
    const definitions = [...localDefinitions, ...apiTools];
    const citations = new Map<string, ResponseCitation>();
    let usedCalls = 0;
    let usedApiCalls = 0;
    const callIds = new Set<string>();
    // Local rounds share a call budget; the final answer may still use hosted tools.
    for (let round = 0; round <= MAX_MODEL_TOOL_CALLS; round += 1) {
      signal.throwIfAborted();
      let history = [...initial, ...turns.flat()];
      // Remove entire completed rounds, keeping calls paired with their results.
      while (turns.length > 1 && modelInputTokens(history, instructions, definitions) > MODEL_INPUT_TOKENS) {
        turns.shift();
        history = [...initial, ...turns.flat()];
      }
      if (modelInputTokens(history, instructions, definitions) > MODEL_INPUT_TOKENS) {
        turns.length = 0;
        history = [...initial, { role: 'user', content: 'Tool history exceeded the input budget. Answer from the conversation and report that the tool results could not be retained.' }];
        usedCalls = MAX_MODEL_TOOL_CALLS;
        usedApiCalls = MAX_MODEL_TOOL_CALLS;
      }
      assertInputBudget(history, instructions, definitions);
      const available = [
        ...(usedCalls < MAX_MODEL_TOOL_CALLS ? localDefinitions : []),
        ...(usedApiCalls < MAX_MODEL_TOOL_CALLS ? apiTools : [])
      ];
      const result = await createResponse({
        baseUrl: this.baseUrl,
        model: this.modelId,
        apiKey: this.apiKey,
        input: history,
        instructions,
        reasoningEffort,
        timeoutMs: this.timeoutMs,
        signal,
        tools: available.length > 0 ? available : definitions,
        toolChoice: available.length === 0 ? 'none' : 'auto',
        maxToolCalls: apiTools.length > 0 && usedApiCalls < MAX_MODEL_TOOL_CALLS
          ? MAX_MODEL_TOOL_CALLS - usedApiCalls : undefined
      });
      const raw = result.raw;
      if (typeof raw !== 'object' || raw === null || !('output' in raw) || !Array.isArray(raw.output) ||
        !raw.output.every((item: unknown) => typeof item === 'object' && item !== null && !Array.isArray(item))) {
        throw new Error('Tool-capable models must return a Responses API output array.');
      }
      const output = raw.output as ResponseItem[];
      for (const citation of result.citations) {
        citations.set(citation.url, citation);
      }
      const needsClient = output.find((item) => item.type === 'mcp_approval_request' ||
        item.type === 'custom_tool_call' || item.type === 'computer_call' || item.type === 'local_shell_call' ||
        item.type === 'apply_patch_call' || (item.type === 'tool_search_call' && item.execution === 'client'));
      if (needsClient !== undefined) {
        throw new Error(`Provider tool output "${String(needsClient.type)}" requires unsupported client execution or approval.`);
      }
      // Hosted calls execute at the provider; retain their items but never run them locally.
      usedApiCalls += output.filter((item) => typeof item.type === 'string' &&
        item.type.endsWith('_call') && item.type !== 'function_call').length;
      if (usedApiCalls > MAX_MODEL_TOOL_CALLS) {
        throw new Error('Model exceeded the provider-hosted tool call budget.');
      }
      const calls = output.filter((item) => item.type === 'function_call');
      if (calls.length === 0) {
        if (!result.outputText) {
          throw new Error('Model returned neither tool calls nor final text.');
        }
        return { ...result, citations: [...citations.values()] };
      }
      if (usedCalls >= MAX_MODEL_TOOL_CALLS) {
        throw new Error('Model continued calling tools after the tool budget was exhausted.');
      }
      const turn = [...output];
      for (const call of calls) {
        if (typeof call.call_id !== 'string' || !call.call_id || typeof call.name !== 'string' ||
          typeof call.arguments !== 'string' || callIds.has(call.call_id)) {
          throw new Error('Model returned a malformed or duplicate function call.');
        }
        callIds.add(call.call_id);
        const toolOutput = usedCalls < MAX_MODEL_TOOL_CALLS
          ? await runner.execute(call.name, call.arguments, signal)
          : JSON.stringify({ ok: false, error: 'Tool budget exhausted; answer using existing results.' });
        usedCalls += 1;
        turn.push({ type: 'function_call_output', call_id: call.call_id, output: boundedText(toolOutput, TOOL_RESULT_TOKENS) });
      }
      turns.push(turn);
    }
    throw new Error('Tool calling exceeded the round limit.');
  }
}

/** Resolves configured model IDs and credentials once, before transports start. */
export class ModelRegistry {
  private readonly models = new Map<string, ProviderModel>();

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

  public getTranscriber(reference: string): TranscriptionModel {
    const model = this.models.get(reference);
    if (model === undefined) {
      throw new Error(`STT model "${reference}" has not been loaded.`);
    }
    return model;
  }

  public getSynthesizer(reference: string): SpeechModel {
    const model = this.models.get(reference);
    if (model === undefined) {
      throw new Error(`TTS model "${reference}" has not been loaded.`);
    }
    return model;
  }
}
