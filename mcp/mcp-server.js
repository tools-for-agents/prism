#!/usr/bin/env node
// prism — MCP server (stdio JSON-RPC). The agent's data reader: hand it a JSON/JSONL blob (inline,
// or a file/URL) and get back its SHAPE, the SLICE at a path, or WHERE a key/value lives — never the
// whole thing. Pairs with scout (read the web) and lens (read code): prism reads DATA. Every call is
// byte-capped, depth-capped and token-budgeted, because it reads untrusted input.
import { createInterface } from 'node:readline';
import { shape, read, find, diff, DEFAULTS } from '../src/core.js';
import { readSource, parseData, PrismError, human } from '../src/load.js';

const PROTOCOL = '2024-11-05';

// Common input: either inline `data` (a JSON/JSONL string the agent already holds) or a `source`
// (file path / URL / "-" for stdin). Inline data is byte-capped too — an agent can paste a big blob.
async function resolveValue(a) {
  const o = {};
  if (a.max_bytes != null) o.maxBytes = Math.floor(a.max_bytes);
  if (a.depth != null) o.maxDepth = Math.floor(a.depth);
  if (a.keys != null) o.maxKeys = Math.floor(a.keys);
  if (a.format) o.format = a.format;
  let text, bytes, source;
  if (a.data != null) {
    text = String(a.data);
    bytes = Buffer.byteLength(text);
    const cap = o.maxBytes ?? DEFAULTS.maxBytes;
    if (bytes > cap) throw new PrismError(`inline data is ${human(bytes)}; prism caps input at ${human(cap)}. Raise max_bytes if you mean it.`);
    source = 'inline';
  } else if (a.source != null) {
    ({ text, bytes, source } = await readSource(a.source, o));
  } else {
    throw new PrismError('give me either `data` (a JSON/JSONL string) or `source` (a file path or URL)');
  }
  const { value, format } = parseData(text, o);
  return { value, o, meta: { source, bytes, format } };
}

const SRC_PROPS = {
  data: { type: 'string', description: 'The JSON or JSONL text to read, inline. Use this when you already hold the blob (e.g. another tool returned it).' },
  source: { type: 'string', description: 'Alternatively, a file path, an http(s) URL, or "-" for stdin.' },
  max_bytes: { type: 'integer', description: `Refuse input larger than this many bytes before parsing (default ${DEFAULTS.maxBytes}).` },
  format: { type: 'string', enum: ['json', 'jsonl', 'csv', 'tsv'], description: 'Force the parse format. JSON vs JSONL auto-detect; CSV/TSV must be chosen here (or come from a .csv/.tsv source), and become an array of row objects keyed by the header.' },
};

const tools = [
  {
    name: 'prism_shape',
    description: 'Get the SHAPE of a JSON, JSONL, CSV, or TSV blob — keys→types, array lengths, nesting — instead of the whole thing. The skeleton of a 500 KB API response is a few hundred tokens. int vs float are distinguished, a key not present in every array element is marked optional, and deep/wide structures are depth- and key-bounded so the shape stays small. Start here, then prism_read the paths you care about.',
    inputSchema: { type: 'object', properties: {
      ...SRC_PROPS,
      depth: { type: 'integer', description: `How deep to descend before truncating (default ${DEFAULTS.maxDepth}).` },
      keys: { type: 'integer', description: `Object fields shown per level before the rest become a withheld count (default ${DEFAULTS.maxKeys}).` },
    } },
    run: async (a) => { const { value, o } = await resolveValue(a); return shape(value, o); },
  },
  {
    name: 'prism_read',
    description: 'Read the value at a PATH inside a JSON, JSONL, CSV, or TSV blob, token-budgeted. Paths look like data.users[0].email or items[*].id ([*] maps over an array); a half-open slice items[0:10] (or [:10] / [100:]) takes just a window of a big array — bounds clamp, so [0:10] on a short array is fine. An index or slice bound may be NEGATIVE to count from the end: logs[-1] is the last element, logs[-20:] the last twenty. If the value fits the budget you get it verbatim; if it is too big you get its shape plus the honest size, so you can narrow the path — a slice or an index — and read again, never a silent truncation. A wrong path is reported (where it fell off, and the type actually there), not thrown.',
    inputSchema: { type: 'object', properties: {
      ...SRC_PROPS,
      path: { type: 'string', description: 'The path to read, e.g. "data.items[0].name", "users[*].id", "logs[0:20]" (a slice), "logs[-1]" (last element), or "$" for the root.' },
      tokens: { type: 'integer', description: `Token budget for the returned value (default ${DEFAULTS.budget}); over budget returns the shape instead.` },
    }, required: ['path'] },
    // NB: only set an override when the arg is present — spreading `budget: undefined` would clobber
    // the DEFAULT with undefined and send every read down the over-budget branch.
    run: async (a) => { const { value, o } = await resolveValue(a); if (a.tokens != null) o.budget = Math.floor(a.tokens); return read(value, a.path, o); },
  },
  {
    name: 'prism_find',
    description: 'Find where a key or value lives inside a JSON, JSONL, CSV, or TSV blob — returns the PATHS (the input to prism_read), breadth-first so the shallowest matches come first. Matches key names by substring and scalar values (strings by substring, numbers/bools exactly, so "1" does not match "1000"). Node- and hit-bounded: on a huge document it stops and tells you the result may be partial.',
    inputSchema: { type: 'object', properties: {
      ...SRC_PROPS,
      query: { type: 'string', description: 'The key name or value to look for.' },
      k: { type: 'integer', description: `Max hits to return (default ${DEFAULTS.maxHits}).` },
    }, required: ['query'] },
    run: async (a) => { const { value, o } = await resolveValue(a); if (a.k != null) o.maxHits = Math.floor(a.k); return find(value, a.query, o); },
  },
  {
    name: 'prism_diff',
    description: 'Compare TWO blobs — JSON, JSONL, CSV, or TSV — and get back the PATHS that changed — added, removed, or a scalar that moved — with a summary count of each. It walks the structure (objects by key, arrays by index; a value that changed type counts as changed), NOT a line diff of the pretty-printed text, so a reordered or reformatted-but-equal document reads as identical. Node- and hit-bounded. Use it to see what differs between two API responses, two configs, or a before and after.',
    inputSchema: { type: 'object', properties: {
      left: { type: 'string', description: 'The first (before) JSON or JSONL blob, inline.' },
      right: { type: 'string', description: 'The second (after) JSON or JSONL blob, inline.' },
      max_bytes: { type: 'integer', description: `Refuse either blob if larger than this many bytes (default ${DEFAULTS.maxBytes}).` },
      format: { type: 'string', enum: ['json', 'jsonl', 'csv', 'tsv'], description: 'Force the parse format for both blobs; JSON/JSONL auto-detect, CSV/TSV must be set here.' },
      k: { type: 'integer', description: `Max changes to return (default ${DEFAULTS.maxHits}); the summary counts are always complete.` },
    }, required: ['left', 'right'] },
    run: async (a) => {
      const o = {};
      if (a.max_bytes != null) o.maxBytes = Math.floor(a.max_bytes);
      if (a.format) o.format = a.format;
      if (a.k != null) o.maxHits = Math.floor(a.k);
      const cap = o.maxBytes ?? DEFAULTS.maxBytes;
      const parseSide = (s, side) => {
        const text = String(s);
        if (Buffer.byteLength(text) > cap) throw new PrismError(`the ${side} blob is ${human(Buffer.byteLength(text))}; prism caps input at ${human(cap)}.`);
        return parseData(text, o).value;
      };
      return diff(parseSide(a.left, 'left'), parseSide(a.right, 'right'), o);
    },
  },
];

// Every prism tool only READS, and every one returns content derived from data outside our trust
// boundary (a file, a URL, a blob the agent was handed) — so: readOnly, open-world. Nothing here
// writes, deletes or reaches back out; the open-world flag says "scrutinise what comes back," which
// is exactly right for untrusted data.
const ANNOTATIONS = {
  prism_shape: { readOnlyHint: true, openWorldHint: true },
  prism_read: { readOnlyHint: true, openWorldHint: true },
  prism_find: { readOnlyHint: true, openWorldHint: true },
  prism_diff: { readOnlyHint: true, openWorldHint: true },
};

const toolMap = Object.fromEntries(tools.map((t) => [t.name, t]));
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize')
    return reply(id, { protocolVersion: PROTOCOL, capabilities: { tools: {} },
      serverInfo: { name: 'prism', version: '0.1.0' } });
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/list')
    return reply(id, { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema, annotations: ANNOTATIONS[name] })) });
  if (method === 'tools/call') {
    const tool = toolMap[params?.name];
    if (!tool) return fail(id, -32602, `unknown tool: ${params?.name}`);
    // A schema that promises a check nobody performs is worse than no schema — the client trusts it.
    // Enforce required args and declared types/enums here, the same way scout does.
    const args = params?.arguments || {};
    const missing = (tool.inputSchema?.required || [])
      .filter((k) => args[k] === undefined || args[k] === null || args[k] === '');
    if (missing.length) {
      const how = missing
        .map((k) => `"${k}"${tool.inputSchema.properties?.[k]?.description ? ` (${tool.inputSchema.properties[k].description})` : ''}`)
        .join(', ');
      return fail(id, -32602, `${tool.name}: missing required argument${missing.length > 1 ? 's' : ''} ${how}`);
    }
    const props = tool.inputSchema?.properties || {};
    const kindOf = (v) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);
    const OK = {
      string: (v) => typeof v === 'string',
      number: (v) => typeof v === 'number' && Number.isFinite(v),
      integer: (v) => Number.isInteger(v),
      boolean: (v) => typeof v === 'boolean',
      array: (v) => Array.isArray(v),
      object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
    };
    const wrong = [];
    for (const [k, spec] of Object.entries(props)) {
      const v = args[k];
      if (v === undefined || v === null) continue;
      if (spec.type && OK[spec.type] && !OK[spec.type](v)) wrong.push(`"${k}" must be ${spec.type}, got ${kindOf(v)}`);
      else if (spec.enum && !spec.enum.includes(v)) wrong.push(`"${k}" must be one of ${spec.enum.join(' | ')} — got ${JSON.stringify(v)}`);
    }
    if (wrong.length) return fail(id, -32602, `${tool.name}: ${wrong.join('; ')}`);
    try {
      const result = await tool.run(args);
      return reply(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
    } catch (err) {
      // A PrismError is an expected, explained failure (bad path, over cap, syntax error) — hand its
      // message back as the tool result, not a protocol crash.
      return reply(id, { content: [{ type: 'text', text: `error: ${err.message}` }], isError: true });
    }
  }
  if (id !== undefined) fail(id, -32601, `method not found: ${method}`);
}

createInterface({ input: process.stdin }).on('line', (line) => {
  line = line.trim(); if (!line) return;
  let msg; try { msg = JSON.parse(line); } catch { return; }
  handle(msg).catch((e) => { if (msg.id !== undefined) fail(msg.id, -32603, String(e)); });
});
process.stderr.write('prism MCP server ready\n');
