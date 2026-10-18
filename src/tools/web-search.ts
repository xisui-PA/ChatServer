import { parseDocument } from 'htmlparser2';
import { HtmlNode, htmlText, walkHtml } from './html';
import { readPublicPage, publicUrl } from './http';
import { Tool, ToolDefinition, stringArgument, toolArguments } from './interface';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** Search backend contract; DuckDuckGo can be replaced without changing the tool. */
export interface WebSearchProvider {
  readonly name: string;
  search(query: string, signal?: AbortSignal): Promise<SearchResult[]>;
}

function hasClass(node: HtmlNode, className: string): boolean {
  return 'attribs' in node && (node.attribs.class ?? '').split(/\s+/).includes(className);
}

/** Searches DuckDuckGo's non-JavaScript HTML results; no API key is needed. */
export class DuckDuckGoSearchProvider implements WebSearchProvider {
  public readonly name = 'duckduckgo';

  public async search(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
    const endpoint = new URL('https://html.duckduckgo.com/html/');
    endpoint.searchParams.set('q', query);
    const page = await readPublicPage(endpoint.toString(), signal);
    const document = parseDocument(page.text);
    const results: SearchResult[] = [];
    const seen = new Set<string>();
    for (const node of walkHtml(document)) {
      if (!('attribs' in node) || !hasClass(node, 'result__a')) {
        continue;
      }
      let url: URL;
      try {
        url = new URL(node.attribs.href, page.url);
        const target = url.searchParams.get('uddg');
        if ((url.hostname === 'duckduckgo.com' || url.hostname.endsWith('.duckduckgo.com')) && target) {
          url = new URL(target);
        }
        url = publicUrl(url.toString());
      } catch {
        continue;
      }
      if (seen.has(url.toString())) {
        continue;
      }
      seen.add(url.toString());
      let row: HtmlNode = node;
      while (row.parent && !hasClass(row, 'result')) {
        row = row.parent;
      }
      let snippet = '';
      for (const candidate of walkHtml(row)) {
        if (hasClass(candidate, 'result__snippet')) {
          snippet = htmlText(candidate, 1000);
          break;
        }
      }
      results.push({ title: htmlText(node, 300), url: url.toString(), snippet });
      if (results.length === 5) {
        break;
      }
    }
    if (results.length === 0 && ![...walkHtml(document)].some((node) => hasClass(node, 'no-results'))) {
      throw new Error('DuckDuckGo returned no readable results; it may be presenting a bot challenge.');
    }
    return results;
  }
}

export class WebSearchTool implements Tool {
  public readonly definition: ToolDefinition = {
    type: 'function',
    name: 'web_search',
    description: 'Search the public web for current information. Returns up to 5 titles, URLs, and snippets. Use read_url to read sources and cite their URLs.',
    parameters: {
      type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false
    },
    strict: true
  };

  public constructor(private readonly provider: WebSearchProvider = new DuckDuckGoSearchProvider()) {}

  public async execute(args: unknown, signal?: AbortSignal): Promise<unknown> {
    const values = toolArguments(args, ['query']);
    const query = stringArgument(values, 'query', 500);
    return { provider: this.provider.name, query, results: await this.provider.search(query, signal) };
  }
}
