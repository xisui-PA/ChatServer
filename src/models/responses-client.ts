import { ToolDefinition } from '../tools/interface';

export const DEFAULT_MODEL_TIMEOUT_MS = 180_000;

/** Validates durations against Node's timer range, including programmatic callers. */
export function resolveModelTimeoutMs(value: unknown = DEFAULT_MODEL_TIMEOUT_MS): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new Error('Model timeout must be an integer from 1 to 2147483647 milliseconds.');
  }
  return value;
}

/** A Responses API input/output item, preserved across tool round trips. */
export type ResponseItem = Record<string, unknown>;

/**
 * Options for a single OpenAI Responses API call.
 */
export interface ResponseRequest {
  /** Base URL of the API, for example `https://api.openai.com/v1`. */
  baseUrl: string;
  /** Model identifier, for example `gpt-4.1-mini`. */
  model: string;
  /** Bearer token used for authorization. */
  apiKey: string;
  /** Prompt or conversation input sent as `input`. */
  input: string | readonly ResponseItem[];
  /** Application-managed function declarations available during generation. */
  tools?: readonly ToolDefinition[];
  /** Disable further tool calls when the per-reply budget has been consumed. */
  toolChoice?: 'auto' | 'none';
  /** Optional system instructions. */
  instructions?: string;
  /** Explicit reasoning effort; omitted preserves provider/model defaults. */
  reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Extra request headers. */
  headers?: Record<string, string>;
  /** Request timeout in milliseconds. Defaults to 3 minutes. */
  timeoutMs?: number;
  /** Optional caller cancellation, in addition to the request timeout. */
  signal?: AbortSignal;
}

/**
 * Result of a Responses API call.
 */
export interface ResponseResult {
  /** Response identifier, when the server returned one. */
  id?: string;
  /** Concatenated text from the response's output items. */
  outputText: string;
  /** Complete decoded response body. */
  raw: unknown;
}

/**
 * Raised when a Responses API call fails.
 */
export class ResponsesApiError extends Error {
  public readonly status?: number;
  public readonly body?: string;

  public constructor(message: string, status?: number, body?: string) {
    super(message);
    this.name = 'ResponsesApiError';
    this.status = status;
    this.body = body;
  }
}

/**
 * Returns true for plain JSON objects (not null, arrays, or primitives).
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Builds the endpoint used for Responses API calls.
 */
export function responsesEndpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/responses`;
}

/**
 * Extracts assistant text from a Responses API payload.
 *
 * Handles the documented `output` array with `output_text` content parts, and falls
 * back to a top-level `output_text` string for compatible servers that use it.
 */
export function extractOutputText(payload: unknown): string {
  if (!isRecord(payload)) {
    return '';
  }

  if (typeof payload.output_text === 'string') {
    return payload.output_text.trim();
  }

  if (!Array.isArray(payload.output)) {
    return '';
  }

  const parts: string[] = [];
  for (const item of payload.output) {
    if (!isRecord(item) || !Array.isArray(item.content)) {
      continue;
    }
    for (const content of item.content) {
      if (isRecord(content) && content.type === 'output_text' && typeof content.text === 'string') {
        parts.push(content.text);
      }
    }
  }

  return parts.join('\n').trim();
}

/**
 * Sends one prompt through the Responses API and returns the text it produced.
 */
export async function createResponse(request: ResponseRequest): Promise<ResponseResult> {
  const url = responsesEndpoint(request.baseUrl);
  const timeoutMs = resolveModelTimeoutMs(request.timeoutMs);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  request.signal?.addEventListener('abort', cancel, { once: true });
  if (request.signal?.aborted) {
    controller.abort();
  }
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  const body: Record<string, unknown> = {
    model: request.model,
    input: request.input
  };
  if (request.tools !== undefined && request.tools.length > 0) {
    body.tools = request.tools;
    body.tool_choice = request.toolChoice ?? 'auto';
    // Replay the complete output locally, including any encrypted reasoning.
    body.store = false;
    body.include = ['reasoning.encrypted_content'];
  }
  if (request.reasoningEffort !== undefined) {
    body.reasoning = { effort: request.reasoningEffort };
  }
  if (request.instructions !== undefined) {
    body.instructions = request.instructions;
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${request.apiKey}`,
    ...request.headers
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal
    });

    const text = await response.text();

    if (!response.ok) {
      throw new ResponsesApiError(
        `Request to ${url} failed with HTTP ${response.status} ${response.statusText}.`,
        response.status,
        text
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new ResponsesApiError(
        `Response from ${url} was not valid JSON: ${(error as Error).message}`,
        response.status,
        text
      );
    }

    if (isRecord(parsed) && ((parsed.error !== undefined && parsed.error !== null) || parsed.status === 'failed' || parsed.status === 'incomplete')) {
      throw new ResponsesApiError(`Response from ${url} did not complete successfully.`, response.status);
    }
    const result: ResponseResult = { outputText: extractOutputText(parsed), raw: parsed };
    if (isRecord(parsed) && typeof parsed.id === 'string') {
      result.id = parsed.id;
    }
    return result;
  } catch (error) {
    if (error instanceof ResponsesApiError) {
      throw error;
    }
    if (request.signal?.aborted) {
      throw new ResponsesApiError(`Request to ${url} was cancelled.`);
    }
    if ((error as Error).name === 'AbortError') {
      throw new ResponsesApiError(`Request to ${url} timed out after ${timeoutMs} ms.`);
    }
    throw new ResponsesApiError(`Request to ${url} failed: ${(error as Error).message}`);
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener('abort', cancel);
  }
}
