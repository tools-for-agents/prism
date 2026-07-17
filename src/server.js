// prism serve — a zero-dependency HTTP server for the data-reader web view. Node's built-in http
// only. prism owns no store, so this holds exactly ONE working document in RAM for the life of the
// serve — loading a new blob replaces it, and nothing is ever written to disk. Read-only to the world
// (it never reaches the network on its own; a URL source is fetched only when you ask it to load one).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize, sep } from 'node:path';
import { shape, read, find, estTokens, DEFAULTS } from './core.js';
import { readSource, parseData, PrismError, human } from './load.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dir, '..', 'public');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

// The single working document. null until the first blob is loaded — which is the EMPTY STATE the
// UI must render honestly rather than pretend it has data.
let current = null;   // { value, bytes, format, tokens, source }

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(body));
}

function optsFrom(q) {
  const o = {};
  const n = (k, t) => { if (q[k] != null && q[k] !== '') o[t] = Math.floor(+q[k]); };
  n('depth', 'maxDepth'); n('keys', 'maxKeys'); n('tokens', 'budget'); n('k', 'maxHits'); n('max_bytes', 'maxBytes');
  if (q.format) o.format = q.format;
  return o;
}

// A digest of the loaded document — what the header bar shows. Never the document itself.
const digest = () => current && {
  bytes: current.bytes, format: current.format, tokens: current.tokens, source: current.source,
  type: shape(current.value, { maxDepth: 0 }).type,
};

// Load a blob (posted inline, or a file/URL to read) into `current`, and hand back its shape.
async function load(body, q) {
  const o = optsFrom(q);
  let text, bytes, source;
  if (body && body.length) {
    text = body;
    bytes = Buffer.byteLength(text);
    const cap = o.maxBytes ?? DEFAULTS.maxBytes;
    if (bytes > cap) throw new PrismError(`that blob is ${human(bytes)}; prism caps input at ${human(cap)}.`);
    source = 'pasted';
  } else if (q.source) {
    ({ text, bytes, source } = await readSource(q.source, o));
  } else {
    throw new PrismError('paste a JSON/JSONL blob, or give a ?source= file path or URL');
  }
  const { value, format } = parseData(text, o);
  current = { value, bytes, format, tokens: estTokens(text), source };
  return { meta: digest(), shape: shape(value, o) };
}

const needDoc = () => { if (!current) throw new PrismError('nothing loaded yet — load a blob first'); };

const api = {
  'GET /api/health': () => ({ ok: true, service: 'prism', ts: new Date().toISOString() }),
  'GET /api/current': () => (current ? { meta: digest(), shape: shape(current.value, {}) } : { empty: true }),
  'GET /api/shape': (q) => { needDoc(); return { meta: digest(), shape: shape(current.value, optsFrom(q)) }; },
  'GET /api/read': (q) => { needDoc(); return read(current.value, q.path || '$', optsFrom(q)); },
  'GET /api/find': (q) => { needDoc(); return find(current.value, q.q || '', optsFrom(q)); },
};

async function serveStatic(res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = normalize(join(PUBLIC, rel));
  // "inside PUBLIC" must mean inside it, not merely next to something spelled like it — require the
  // separator so /app/public-secrets cannot pose as /app/public (the kit-wide serveStatic fix).
  if (filePath !== PUBLIC && !filePath.startsWith(PUBLIC + sep)) { res.writeHead(403); return res.end('forbidden'); }
  try {
    const data = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    try {
      const data = await readFile(join(PUBLIC, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    } catch { res.writeHead(404); res.end('not found'); }
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0; const cap = DEFAULTS.maxBytes;
    req.on('data', (c) => { n += c.length; if (n > cap) { req.destroy(); reject(new PrismError(`request body exceeded the ${human(cap)} cap`)); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function serve(port = +process.env.PRISM_PORT || 7970) {
  const server = createServer(async (req, res) => {
    const u = new URL(req.url, 'http://localhost');
    const q = Object.fromEntries(u.searchParams);
    const route = `${req.method} ${u.pathname}`;
    try {
      if (req.method === 'POST' && u.pathname === '/api/load') {
        const body = await readBody(req);
        return json(res, 200, await load(body, q));
      }
      const handler = api[route];
      if (handler) return json(res, 200, await handler(q));
      if (u.pathname.startsWith('/api/')) return json(res, 404, { error: 'no such endpoint' });
      return serveStatic(res, u.pathname);
    } catch (e) {
      // An expected failure (bad path, over cap, syntax error) is a 400 the UI can show — not a 500.
      const code = e instanceof PrismError ? 400 : 500;
      return json(res, code, { error: e.message });
    }
  });
  server.listen(port, () => process.stderr.write(`prism serving on http://localhost:${port}\n`));
  return server;
}
