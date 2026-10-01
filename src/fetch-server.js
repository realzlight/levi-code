#!/data/data/com.termux/files/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

function htmlToMarkdown(html) {
  let text = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, '');

  text = text.replace(/<h[1-6][^>]*>(.*?)<\/h[1-6]>/gi, '\n\n# $1\n\n');
  text = text.replace(/<p[^>]*>(.*?)<\/p>/gi, '\n\n$1\n\n');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<li[^>]*>(.*?)<\/li>/gi, '\n* $1');
  text = text.replace(/<a\s+(?:[^>]*?\s+)?href=["']([^"']*)["'][^>]*>(.*?)<\/a>/gi, '[$2]($1)');
  text = text.replace(/<[^>]+>/g, '');
  text = text.replace(/&nbsp;/g, ' ')
             .replace(/&amp;/g, '&')
             .replace(/&lt;/g, '<')
             .replace(/&gt;/g, '>')
             .replace(/&quot;/g, '"');
  text = text.replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
  return text;
}

const server = new Server(
  { name: '@modelcontextprotocol/server-fetch', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'fetch',
        description: 'Fetches a URL and returns its content as readable markdown/text or raw HTML.',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'URL to fetch' },
            max_length: { type: 'number', description: 'Maximum character length to return (default: 5000)' },
            start_index: { type: 'number', description: 'Start index for content slice (default: 0)' },
            raw: { type: 'boolean', description: 'Return raw HTML if true, clean text/markdown if false' }
          },
          required: ['url']
        }
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== 'fetch') {
    throw new Error(`Unknown tool: ${request.params.name}`);
  }

  const { url, max_length = 5000, start_index = 0, raw = false } = request.params.arguments || {};
  if (!url) throw new Error('URL is required');

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });

    if (!res.ok) {
      return {
        isError: true,
        content: [{ type: 'text', text: `HTTP Error ${res.status}: ${res.statusText}` }]
      };
    }

    const html = await res.text();
    let content = raw ? html : htmlToMarkdown(html);
    const totalLength = content.length;

    if (start_index > 0) {
      content = content.slice(start_index);
    }
    if (content.length > max_length) {
      content = content.slice(0, max_length) + `\n\n... (truncated: showing ${max_length} of ${totalLength} chars. Use start_index to read more)`;
    }

    return {
      content: [{ type: 'text', text: content }]
    };
  } catch (err) {
    return {
      isError: true,
      content: [{ type: 'text', text: `Fetch failed: ${err.message}` }]
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
