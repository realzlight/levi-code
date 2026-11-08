import { getSearchApiKey } from '../mcp.js';

// Common conversational noise phrases to strip from search queries
const NOISE_PHRASES = [
  /^(?:can you\s+)?(?:please\s+)?(?:how\s+(?:do|can|to|should)\s+(?:i|we|you)\s+)/i,
  /^(?:what\s+is\s+the\s+(?:best|recommended)\s+way\s+to\s+)/i,
  /^(?:what\s+is\s+)/i,
  /^(?:tell\s+me\s+about\s+)/i,
  /^(?:show\s+me\s+(?:how\s+to\s+)?)/i,
  /^(?:find\s+(?:me\s+)?(?:out\s+)?)/i,
  /^(?:look\s+up\s+)/i,
  /^(?:search\s+(?:for\s+)?)/i,
  /\b(?:in\s+my\s+project|for\s+my\s+app|in\s+my\s+code)\b/gi,
  /\b(?:step\s+by\s+step|tutorial|guide\s+for\s+beginners)\b/gi,
  /\b(?:please|kindly|thanks|thank\s+you)\b/gi
];

// Technical domain shortcuts
const DOMAIN_MAP = {
  mdn: 'developer.mozilla.org',
  github: 'github.com',
  stackoverflow: 'stackoverflow.com',
  so: 'stackoverflow.com',
  npm: 'npmjs.com',
  pypi: 'pypi.org',
  crates: 'crates.io',
  pkg: 'pkg.go.dev'
};

/**
 * Clean and optimize a raw user/agent search query into high-density keywords.
 */
export function optimizeSearchQuery(raw, { site } = {}) {
  let q = String(raw || '').trim();
  if (!q) return '';

  // Extract site: operator if already embedded in query
  const siteMatch = q.match(/\bsite:([^\s]+)/i);
  let targetSite = site || (siteMatch ? siteMatch[1] : null);
  if (siteMatch) {
    q = q.replace(siteMatch[0], '').trim();
  }

  // Handle error messages: if query contains stack trace or error code, isolate it in quotes
  const errorMatch = q.match(/\b([A-Z][a-zA-Z0-9_]+Error|ERR_[A-Z0-9_]+|ENOSPC|ENOENT|EACCES|exit code \d+)\b/);

  // Strip conversational noise phrases
  for (const rx of NOISE_PHRASES) {
    q = q.replace(rx, ' ');
  }

  // Collapse whitespace
  q = q.replace(/\s+/g, ' ').trim();

  // If we found an error identifier and query doesn't have quotes, quote the error token
  if (errorMatch && !q.includes('"')) {
    q = q.replace(errorMatch[1], `"${errorMatch[1]}"`);
  }

  // Check for domain shortcuts at end of query (e.g. "grid css mdn" -> site:developer.mozilla.org)
  for (const [shortcut, domain] of Object.entries(DOMAIN_MAP)) {
    const rx = new RegExp(`\\b${shortcut}\\b`, 'i');
    if (rx.test(q) && !targetSite) {
      targetSite = domain;
      q = q.replace(rx, '').trim();
      break;
    }
  }

  // Append targetSite if specified
  if (targetSite) {
    targetSite = targetSite.replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
    q = `${q} site:${targetSite}`;
  }

  return q.replace(/\s+/g, ' ').trim();
}

/**
 * Format raw Serper JSON data into high-density, token-efficient Markdown (0 LLM tokens).
 */
export function formatSearchResults(data, { query = '', maxResults = 5 } = {}) {
  let parsed = data;
  if (typeof data === 'string') {
    try {
      parsed = JSON.parse(data);
    } catch {
      // If plain text or pre-formatted, return sanitized snippet
      return data.slice(0, 2500);
    }
  }

  if (!parsed || typeof parsed !== 'object') {
    return 'No search results found.';
  }

  const lines = [];
  const qStr = query || parsed.searchParameters?.q || '';
  lines.push(`# Search Results: "${qStr}"`);

  // 1. Direct Answer Box (Google instant answer / featured snippet)
  if (parsed.answerBox) {
    const box = parsed.answerBox;
    const answer = box.answer || box.snippet || box.title || '';
    if (answer) {
      lines.push('\n### [Direct Answer]');
      lines.push(`> ${answer.trim().replace(/\n+/g, ' ')}`);
      if (box.link) lines.push(`Source: ${box.link}`);
    }
  }

  // 2. Knowledge Graph (Quick entity facts)
  if (parsed.knowledgeGraph) {
    const kg = parsed.knowledgeGraph;
    if (kg.title) {
      const desc = kg.description || '';
      lines.push(`\n**${kg.title}**${kg.type ? ` (${kg.type})` : ''}: ${desc}`);
      if (kg.website) lines.push(`Official: ${kg.website}`);
    }
  }

  // 3. Top Organic Results
  const organic = Array.isArray(parsed.organic) ? parsed.organic.slice(0, maxResults) : [];
  if (organic.length) {
    lines.push('\n### Organic Results');
    for (let i = 0; i < organic.length; i++) {
      const item = organic[i];
      const title = item.title || 'Untitled';
      const link = item.link || '';
      const date = item.date ? ` (${item.date})` : '';
      let snippet = (item.snippet || '').trim().replace(/\s+/g, ' ');

      // Include attributes if present (e.g. stars, version, author)
      if (item.attributes && typeof item.attributes === 'object') {
        const attrs = Object.entries(item.attributes).map(([k, v]) => `${k}: ${v}`).join(' | ');
        if (attrs) snippet += ` [${attrs}]`;
      }

      lines.push(`\n**[${i + 1}] ${title}**${date}`);
      if (link) lines.push(`URL: ${link}`);
      if (snippet) lines.push(`> ${snippet}`);
    }
  } else if (!parsed.answerBox && !parsed.knowledgeGraph) {
    lines.push('\nNo organic matches found. Try broadening the search keywords.');
  }

  // 4. People Also Ask (Questions as hints)
  const paa = Array.isArray(parsed.peopleAlsoAsk) ? parsed.peopleAlsoAsk.slice(0, 2) : [];
  if (paa.length) {
    lines.push('\n### Related Questions');
    for (const q of paa) {
      if (q.question) {
        const ans = q.snippet ? `: ${q.snippet.slice(0, 100)}...` : '';
        lines.push(`- ${q.question}${ans}`);
      }
    }
  }

  return lines.join('\n').trim();
}

/**
 * Execute Google Search via Serper API natively over HTTPS.
 * Eliminates npx / child_process overhead and latency.
 */
export async function executeSerperSearch(rawQuery, { num = 8, site } = {}) {
  const apiKey = getSearchApiKey();
  if (!apiKey) {
    return {
      ok: false,
      error: 'Serper API key is not configured. Set it using: /search:api <your-api-key>'
    };
  }

  const query = optimizeSearchQuery(rawQuery, { site });
  if (!query) {
    return { ok: false, error: 'Empty search query.' };
  }

  const payload = { q: query, num: Math.min(Math.max(num, 3), 10) };

  try {
    const res = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: {
        'X-API-KEY': apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000)
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      return { ok: false, error: `Serper API error (${res.status}): ${errBody.slice(0, 200)}` };
    }

    const data = await res.json();
    const formatted = formatSearchResults(data, { query, maxResults: 5 });
    return { ok: true, query, content: formatted, raw: data };
  } catch (err) {
    return { ok: false, error: `Search request failed: ${err.message}` };
  }
}

/**
 * Extract clean, high-density text/markdown from raw HTML or web page content.
 * Strips script tags, navigation, footers, SVGs, and cookie boilerplate without external deps.
 */
export function extractCleanWebContent(content, { url = '', maxLength = 4500 } = {}) {
  if (!content || typeof content !== 'string') return '';

  let text = content;

  // 1. Remove dangerous or non-content HTML blocks
  text = text.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  text = text.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');
  text = text.replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, '');
  text = text.replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, '');
  text = text.replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '');
  text = text.replace(/<nav\b[^<]*(?:(?!<\/nav>)<[^<]*)*<\/nav>/gi, '');
  text = text.replace(/<footer\b[^<]*(?:(?!<\/footer>)<[^<]*)*<\/footer>/gi, '');
  text = text.replace(/<header\b[^<]*(?:(?!<\/header>)<[^<]*)*<\/header>/gi, '');

  // 2. Convert standard tags to Markdown equivalents
  text = text.replace(/<h[1-2][^>]*>(.*?)<\/h[1-2]>/gi, '\n\n## $1\n');
  text = text.replace(/<h[3-6][^>]*>(.*?)<\/h[3-6]>/gi, '\n\n### $1\n');
  text = text.replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, '\n```\n$1\n```\n');
  text = text.replace(/<code[^>]*>(.*?)<\/code>/gi, '`$1`');
  text = text.replace(/<li[^>]*>(.*?)<\/li>/gi, '\n- $1');
  text = text.replace(/<p[^>]*>(.*?)<\/p>/gi, '\n\n$1');
  text = text.replace(/<br\s*\/?>/gi, '\n');

  // 3. Strip remaining HTML tags
  text = text.replace(/<[^>]+>/g, ' ');

  // 4. Decode common HTML entities
  text = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');

  // 5. Clean up redundant whitespace and blank lines
  text = text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .join('\n\n');

  // 6. Header attribution
  const header = url ? `# Content from: ${url}\n\n` : '';

  // 7. Bound to maxLength cleanly at paragraph boundary
  if (text.length > maxLength) {
    const cut = text.lastIndexOf('\n\n', maxLength);
    const end = cut > maxLength * 0.7 ? cut : maxLength;
    text = text.slice(0, end) + '\n\n[... Remaining content truncated for token efficiency]';
  }

  return header + text;
}
