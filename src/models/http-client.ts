import { lookup } from 'node:dns';
import { request as httpRequest, RequestOptions } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

interface ModelHttpResponse {
  status: number;
  statusText: string;
  text: string;
}

const TRANSIENT_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN',
  'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'ERR_STREAM_PREMATURE_CLOSE'
]);

/** Includes nested fetch causes and the individual failures of dual-stack connections. */
function networkErrors(error: unknown, seen = new Set<unknown>()): Record<string, unknown>[] {
  if (typeof error !== 'object' || error === null || seen.has(error) || seen.size >= 12) {
    return [];
  }
  seen.add(error);
  const record = error as Record<string, unknown>;
  return [
    record,
    ...networkErrors(record.cause, seen),
    ...(Array.isArray(record.errors) ? record.errors.flatMap((item) => networkErrors(item, seen)) : [])
  ];
}

/** Retries connection failures, not HTTP errors, invalid JSON, TLS failures, or cancellation. */
export function isTransientNetworkError(error: unknown): boolean {
  const errors = networkErrors(error);
  const codes = errors.flatMap((item) => typeof item.code === 'string' ? [item.code] : []);
  return codes.length > 0 && codes.every((code) => TRANSIENT_CODES.has(code));
}

/** Keeps the useful cause instead of hiding it behind fetch's generic TypeError. */
export function describeNetworkError(error: unknown): string {
  const details = networkErrors(error).map((item) => {
    const code = typeof item.code === 'string' ? `[${item.code}] ` : '';
    return `${code}${typeof item.message === 'string' ? item.message : 'Network error'}`;
  });
  return [...new Set(details)].join('; ') || 'Unknown network error';
}

/** Starts with IPv4 on LAN hosts, preserving all addresses for IPv6 fallback. */
const ipv4FirstLookup: NonNullable<RequestOptions['lookup']> = (hostname, options, callback) => {
  if (options.all) {
    lookup(hostname, { ...options, all: true, verbatim: false }, (error, addresses) => {
      callback(error, addresses);
    });
  } else {
    lookup(hostname, { ...options, all: false, verbatim: false }, callback);
  }
};

/** Avoids stale pooled sockets and fetch's independent timeouts for plain-HTTP model servers. */
function postHttp(url: URL, headers: Record<string, string>, body: string, signal: AbortSignal): Promise<ModelHttpResponse> {
  return new Promise((resolve, reject) => {
    const options: RequestOptions & { autoSelectFamily: boolean; autoSelectFamilyAttemptTimeout: number } = {
      method: 'POST', signal, agent: false,
      lookup: ipv4FirstLookup,
      autoSelectFamily: true,
      autoSelectFamilyAttemptTimeout: 1_000,
      headers: {
        ...headers,
        'Content-Length': Buffer.byteLength(body),
        'Accept-Encoding': 'identity',
        Connection: 'close'
      }
    };
    const req = httpRequest(url, options, (response) => {
      // No compression is requested, so body bytes are ordinary UTF-8 JSON.
      response.setEncoding('utf8');
      let text = '';
      response.on('data', (chunk: string) => {
        text += chunk;
      });
      response.on('error', reject);
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        statusText: response.statusMessage ?? '',
        text
      }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** Network retries share the caller's deadline, including response bodies and backoff. */
export async function postModelJson(
  url: string,
  headers: Record<string, string>,
  body: string,
  signal: AbortSignal
): Promise<ModelHttpResponse> {
  const endpoint = new URL(url);
  for (let attempt = 0; ; attempt += 1) {
    signal.throwIfAborted();
    try {
      if (endpoint.protocol === 'http:') {
        return await postHttp(endpoint, headers, body, signal);
      }
      const response = await fetch(url, { method: 'POST', headers, body, signal });
      return { status: response.status, statusText: response.statusText, text: await response.text() };
    } catch (error) {
      if (signal.aborted || attempt >= 2 || !isTransientNetworkError(error)) {
        throw error;
      }
      // HTTP inference may be repeated, but application tools and message sends are not.
      console.warn(`[model] transient network failure; retry ${attempt + 1}/2.`);
      await delay(500 * 2 ** attempt, undefined, { signal });
    }
  }
}
