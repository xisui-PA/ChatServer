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
import { AudioFile, ImageFile } from '../messagers/interface';
import { createTranscription, TranscriptionModel } from './transcriptions-client';
import { createSpeech, SpeechModel } from './speech-client';
import { generatedImages, ImageGenerationPolicy } from './image-generation';
import { isObject, isRecord, isString } from '../type-guards';

/** Per-request generation settings; never mutate a shared model's defaults. */
export interface GenerationOptions {
  localTools?: readonly Tool[];
  apiTools?: readonly ApiToolSpec[];
  /** Delivers final-response citations without mixing metadata into model text. */
  onCitations?: (citations: readonly ResponseCitation[]) => void;
  /** Receives completed images only after the entire generation succeeds. */
  onImages?: (images: readonly ImageFile[]) => void;
  /** Persists validated artifacts immediately, before further model work or formatting repair. */
  onGeneratedImages?: (images: readonly ImageFile[]) => Promise<void>;
  imageGeneration?: ImageGenerationPolicy;
  reasoningEffort?: ResponseRequest['reasoningEffort'];
}

/** Completed artifacts survive complete-generation retries without another image charge. */
interface GeneratedImageState {
  images: ImageFile[];
  output: ResponseItem[];
}

/** A configured model that accepts text or multimodal input and returns text. */
export interface TextModel {
  /** Missing means false; enabled models retrieve images through native tool results. */
  readonly supportsImageToolResults?: boolean;
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
    private readonly timeoutMs: number,
    public readonly supportsImageToolResults = false
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
    const configured = parseApiTools(options.apiTools ?? []);
    const imageGeneration = options.imageGeneration ?? new ImageGenerationPolicy({}, configured);
    const apiTools = imageGeneration.tools(configured);
    assertInputBudget(input, instructions, [...localTools.map((tool) => tool.definition), ...apiTools]);
    const generated: GeneratedImageState = { images: [], output: [] };
    const generation = { ...options, localTools, apiTools, imageGeneration, generated };
    const result = await withModelRetries(() => this.generateOnce(input, instructions, signal, generation), signal);
    options.onCitations?.(result.citations);
    options.onImages?.(result.images ?? []);
    return result.outputText;
  }

  /** Each attempt starts a fresh tool cycle and gets the provider's generation timeout. */
  private async generateOnce(
    input: string | readonly ResponseItem[],
    instructions: string,
    signal: AbortSignal | undefined,
    options: Omit<GenerationOptions, 'apiTools'> & { apiTools: readonly ApiToolDefinition[]; generated: GeneratedImageState }
  ): Promise<ResponseResult & { images?: readonly ImageFile[] }> {
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
      return await this.generateWithTools(input, instructions, localTools, apiTools, controller.signal,
        options.reasoningEffort, options.imageGeneration, options.generated, options.onGeneratedImages);
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
    reasoningEffort: ResponseRequest['reasoningEffort'],
    imageGeneration: ImageGenerationPolicy | undefined,
    generated: GeneratedImageState,
    onGeneratedImages?: GenerationOptions['onGeneratedImages']
  ): Promise<ResponseResult & { images: readonly ImageFile[] }> {
    const runner = new ToolRunner(localTools);
    const initial: ResponseItem[] = [
      ...(isString(input) ? [{ role: 'user', content: input }] : input),
      ...generated.output
    ];
    if (generated.images.length > 0) {
      instructions += '\nAn image was already generated for this request before a later model round failed. Its output is included as context and the application will deliver the same image with your final reply. Do not generate another image or claim image generation is unavailable; finish the reply using this completed artifact.';
    }
    const turns: ResponseItem[][] = [];
    const localDefinitions = localTools.map((tool) => tool.definition);
    const definitions = [...localDefinitions, ...apiTools];
    const citations = new Map<string, ResponseCitation>();
    const images = generated.images;
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
      let available = [
        ...(usedCalls < MAX_MODEL_TOOL_CALLS ? localDefinitions : []),
        ...(usedApiCalls < MAX_MODEL_TOOL_CALLS ? apiTools : [])
      ];
      const reservation = images.length === 0 && available.some((tool) => tool.type === 'image_generation')
        ? await imageGeneration?.reserve() : undefined;
      if (reservation === undefined) {
        available = available.filter((tool) => tool.type !== 'image_generation');
      }
      // A reserved slot plus max_tool_calls=1 bounds image charges before execution.
      // On a network error the slot stays consumed because provider execution is unknown.
      let result: ResponseResult;
      try {
        signal.throwIfAborted();
        result = await createResponse({
          baseUrl: this.baseUrl,
          model: this.modelId,
          apiKey: this.apiKey,
          input: history,
          instructions,
          reasoningEffort,
          timeoutMs: this.timeoutMs,
          signal,
          tools: available.length > 0 ? available : definitions.filter((tool) => tool.type !== 'image_generation'),
          toolChoice: available.length === 0 ? 'none' : 'auto',
          maxToolCalls: reservation !== undefined ? 1 :
            available.some((tool) => tool.type !== 'function') ? MAX_MODEL_TOOL_CALLS - usedApiCalls : undefined
        });
      } catch (error) {
        if (error instanceof ResponsesApiError && error.status !== undefined &&
          error.status >= 400 && error.status < 500 && error.status !== 408) {
          // A rejected request never started image generation; ambiguous errors retain the slot.
          await reservation?.finish(0);
        }
        throw error;
      }
      const raw = result.raw;
      if (!isObject(raw) || !('output' in raw) || !Array.isArray(raw.output) ||
        !raw.output.every((item: unknown) => isRecord(item))) {
        throw new Error('Tool-capable models must return a Responses API output array.');
      }
      const output = raw.output as ResponseItem[];
      const imageCalls = output.filter((item) => item.type === 'image_generation_call');
      await reservation?.finish(imageCalls.length);
      if (imageCalls.length > 0 && reservation === undefined) {
        throw new Error('Provider generated images without an available image generation quota.');
      }
      if (reservation !== undefined && output.filter((item) => isString(item.type) &&
        item.type.endsWith('_call') && item.type !== 'function_call').length > 1) {
        throw new Error('Provider exceeded the reserved image generation tool call budget.');
      }
      const completed = generatedImages(imageCalls, imageGeneration?.size);
      if (completed.length > 0) {
        images.push(...completed);
        generated.output.push(...imageCalls);
        await onGeneratedImages?.(completed);
      }
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
      usedApiCalls += output.filter((item) => isString(item.type) &&
        item.type.endsWith('_call') && item.type !== 'function_call').length;
      if (usedApiCalls > MAX_MODEL_TOOL_CALLS) {
        throw new Error('Model exceeded the provider-hosted tool call budget.');
      }
      const calls = output.filter((item) => item.type === 'function_call');
      if (calls.length === 0) {
        if (!result.outputText && images.length === 0) {
          throw new Error('Model returned neither tool calls nor final text.');
        }
        return { ...result, citations: [...citations.values()], images };
      }
      if (usedCalls >= MAX_MODEL_TOOL_CALLS) {
        throw new Error('Model continued calling tools after the tool budget was exhausted.');
      }
      const turn = [...output];
      const imageParts: Record<string, unknown>[] = [];
      for (const call of calls) {
        if (!isString(call.call_id) || !call.call_id || !isString(call.name) ||
          !isString(call.arguments) || callIds.has(call.call_id)) {
          throw new Error('Model returned a malformed or duplicate function call.');
        }
        callIds.add(call.call_id);
        const toolOutput = usedCalls < MAX_MODEL_TOOL_CALLS
          ? await runner.execute(call.name, call.arguments, signal)
          : { output: JSON.stringify({ ok: false, error: 'Tool budget exhausted; answer using existing results.' }), images: [] };
        usedCalls += 1;
        const content: Record<string, unknown>[] = [];
        for (const image of toolOutput.images) {
          content.push({ type: 'input_text', text: JSON.stringify({
            imageId: image.id, messageId: image.messageId, senderId: image.senderId,
            senderName: image.senderName, timestamp: image.timestamp,
            origin: image.origin, deliveryStatus: image.deliveryStatus
          }) });
          content.push({ type: 'input_image', image_url: image.dataUrl, detail: 'auto' });
        }
        const text = boundedText(toolOutput.output, TOOL_RESULT_TOKENS);
        if (this.supportsImageToolResults && content.length > 0) {
          turn.push({ type: 'function_call_output', call_id: call.call_id,
            output: [{ type: 'input_text', text }, ...content] });
        } else {
          turn.push({ type: 'function_call_output', call_id: call.call_id, output: text });
          imageParts.push(...content);
        }
      }
      if (imageParts.length > 0) {
        turn.push({ role: 'user', content: imageParts });
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
      const model = provider?.models.find((model) => model.id === modelId);
      if (provider === undefined || model === undefined) {
        throw new Error(`Model "${reference}" is not configured in models.json. Use chatserver-models add first.`);
      }
      return { reference, provider, model };
    });
    const keys = new Map<string, string>();
    for (const { reference, provider, model } of bindings) {
      let apiKey = keys.get(provider.provider);
      if (apiKey === undefined) {
        apiKey = await getModelApiKey(provider.provider);
        keys.set(provider.provider, apiKey);
      }
      registry.models.set(reference, new ProviderModel(
        provider.baseUrl, model.id, apiKey, resolveModelTimeoutMs(provider.timeoutMs), model.supportsImageToolResults ?? false
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
