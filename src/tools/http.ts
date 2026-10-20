import { MAX_WEB_DECODED_BYTES, MAX_WEB_DOWNLOAD_BYTES, MAX_WEB_REDIRECTS, WEB_REQUEST_TIMEOUT_MS } from '../limit';
import { lookup } from 'node:dns';
import { request as httpRequest, RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';

const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['192.88.99.0', 24], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
] as const) {
  blocked.addSubnet(address, prefix, 'ipv4');
}
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
blocked.addSubnet('2001::', 23, 'ipv6');
blocked.addSubnet('2001:db8::', 32, 'ipv6');
blocked.addSubnet('2002::', 16, 'ipv6');

/** Accepts only globally routable IP addresses, including at connection time. */
function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    return !blocked.check(address, 'ipv4');
  }
  return family === 6 && globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}

/** Validates each initial URL and redirect before initiating a request. */
export function publicUrl(value: string): URL {
  const url = new URL(value);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
    (url.port !== '' && url.port !== '80' && url.port !== '443') ||
    host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
    (isIP(host) !== 0 && !isPublicAddress(host))) {
    throw new Error('Only public HTTP(S) URLs on standard web ports are supported.');
  }
  url.hash = '';
  return url;
}

/** Validates and pins DNS results, preventing private-network redirects or DNS rebinding. */
const publicLookup: NonNullable<RequestOptions['lookup']> = (hostname, _options, callback) => {
  lookup(hostname, { all: true }, (error, addresses) => {
    if (error !== null) {
      callback(error, '', 4);
      return;
    }
    if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
      callback(new Error('URL resolves to a non-public address.'), '', 4);
      return;
    }
    const selected = addresses.find(({ family }) => family === 4) ?? addresses[0];
    callback(null, selected.address, selected.family);
  });
};

interface Page {
  url: string;
  contentType: string;
  text: string;
}

interface Download {
  location?: string;
  contentType: string;
  body: Buffer;
}

/** Reads a single response, bounding transfer size before decoding or parsing. */
function download(url: URL, signal: AbortSignal): Promise<Download> {
  return new Promise((resolve, reject) => {
    const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const options: RequestOptions & { autoSelectFamily: boolean } = {
      method: 'GET',
      signal,
      lookup: publicLookup,
      autoSelectFamily: false,
      agent: false,
      headers: {
        'User-Agent': 'ChatServer/1.0',
        Accept: 'text/html, application/xhtml+xml, text/plain, text/markdown, application/json',
        'Accept-Encoding': 'gzip, deflate, br'
      }
    };
    const req = request(url, options, (response) => {
      const status = response.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
        resolve({ location: response.headers.location, contentType: '', body: Buffer.alloc(0) });
        response.destroy();
        return;
      }
      const contentType = response.headers['content-type'] ?? '';
      if (status !== 200) {
        reject(new Error(`Web request returned HTTP ${status}.`));
        response.destroy();
        return;
      }
      if (!/^(text\/(html|plain|markdown)|application\/(xhtml\+xml|json))(?:;|$)/i.test(contentType)) {
        reject(new Error('Only HTML, plain text, Markdown, and JSON pages can be read.'));
        response.destroy();
        return;
      }
      const encoding = (response.headers['content-encoding'] ?? 'identity').toLowerCase().trim();
      const body = encoding === 'identity' ? response
        : encoding === 'gzip' ? response.pipe(createGunzip())
          : encoding === 'deflate' ? response.pipe(createInflate())
            : encoding === 'br' ? response.pipe(createBrotliDecompress()) : undefined;
      if (body === undefined) {
        reject(new Error('Unsupported response compression.'));
        response.destroy();
        return;
      }
      const fail = (error: Error) => {
        reject(error);
        body.destroy();
        response.destroy();
      };
      let transferred = 0;
      response.on('data', (chunk: Buffer) => {
        transferred += chunk.length;
        if (transferred > MAX_WEB_DOWNLOAD_BYTES) {
          fail(new Error(`Page exceeds the ${MAX_WEB_DOWNLOAD_BYTES / (1024 * 1024)} MiB download limit.`));
        }
      });
      response.on('error', fail);
      response.on('aborted', () => fail(new Error('Page download was interrupted.')));
      const chunks: Buffer[] = [];
      let size = 0;
      body.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_WEB_DECODED_BYTES) {
          fail(new Error(`Page exceeds the ${MAX_WEB_DECODED_BYTES / (1024 * 1024)} MiB decoded size limit.`));
        } else {
          chunks.push(chunk);
        }
      });
      body.on('error', fail);
      body.on('end', () => resolve({ contentType, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** Downloads public web text with a shared deadline and at most five redirects. */
export async function readPublicPage(value: string, signal?: AbortSignal): Promise<Page> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) {
    controller.abort();
  }
  const timer = setTimeout(cancel, WEB_REQUEST_TIMEOUT_MS);
  try {
    let url = publicUrl(value);
    for (let redirects = 0; redirects <= MAX_WEB_REDIRECTS; redirects += 1) {
      const result = await download(url, controller.signal);
      if (result.location !== undefined) {
        url = publicUrl(new URL(result.location, url).toString());
        continue;
      }
      const charset = /charset\s*=\s*["']?([^;\s"']+)/i.exec(result.contentType)?.[1] ?? 'utf-8';
      return {
        url: url.toString(),
        contentType: result.contentType,
        text: new TextDecoder(charset).decode(result.body)
      };
    }
    throw new Error('Page exceeded the redirect limit.');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}
