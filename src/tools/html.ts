import { MAX_HTML_NODES, MAX_WEB_TEXT_CHARS, MAX_WEB_TITLE_CHARS } from '../limit';
import { parseDocument } from 'htmlparser2';

export type HtmlNode = ReturnType<typeof parseDocument>['children'][number];

/** Traverses parsed HTML iteratively to handle deeply nested pages. */
export function* walkHtml(root: HtmlNode): Generator<HtmlNode> {
  const pending: HtmlNode[] = [root];
  let visited = 0;
  while (pending.length && visited < MAX_HTML_NODES) {
    const node = pending.pop();
    if (node === undefined) {
      break;
    }
    visited += 1;
    yield node;
    if ('children' in node) {
      for (let i = node.children.length - 1; i >= 0; i -= 1) {
        pending.push(node.children[i]);
      }
    }
  }
}

/** Extracts readable text, excluding executable content and navigation. */
export function htmlText(root: HtmlNode, limit = MAX_WEB_TEXT_CHARS): string {
  const ignored = new Set(['script', 'style', 'noscript', 'template', 'nav', 'footer', 'header', 'svg']);
  const blocks = new Set(['p', 'div', 'br', 'li', 'h1', 'h2', 'h3', 'h4', 'pre', 'section', 'article', 'tr']);
  const pending: HtmlNode[] = [root];
  const parts: string[] = [];
  let length = 0;
  let visited = 0;
  while (pending.length && length < limit && visited < MAX_HTML_NODES) {
    const node = pending.pop();
    if (node === undefined) {
      break;
    }
    visited += 1;
    if ('name' in node && ignored.has(node.name)) {
      continue;
    }
    if (node.type === 'text') {
      const text = node.data.replace(/\s+/g, ' ').slice(0, limit - length);
      parts.push(text);
      length += text.length;
    } else if ('name' in node && blocks.has(node.name)) {
      parts.push('\n');
      length += 1;
    }
    if ('children' in node) {
      for (let i = node.children.length - 1; i >= 0; i -= 1) {
        pending.push(node.children[i]);
      }
    }
  }
  return parts.join('').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Parses an HTML page into a title and bounded article/main/body text. */
export function readableHtml(html: string): { title: string; text: string } {
  const document = parseDocument(html);
  let title = '';
  let article: HtmlNode | undefined;
  let main: HtmlNode | undefined;
  let body: HtmlNode | undefined;
  for (const node of walkHtml(document)) {
    if ('name' in node) {
      if (node.name === 'title') {
        title = htmlText(node, MAX_WEB_TITLE_CHARS);
      } else if (node.name === 'article' && article === undefined) {
        article = node;
      } else if (node.name === 'main' && main === undefined) {
        main = node;
      } else if (node.name === 'body') {
        body = node;
      }
    }
  }
  return { title, text: htmlText(article ?? main ?? body ?? document) };
}
