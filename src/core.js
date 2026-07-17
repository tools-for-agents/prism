// prism core — read structured DATA the way scout reads the web and lens reads code:
// give back the SHAPE and the SLICE you asked for, never the whole blob.
//
// The three things an agent does with a big JSON/JSONL response:
//   shape(v)          → the skeleton: keys→types, array lengths, nesting — the "90% smaller" view
//   read(v, path)     → drill to one path and get that subtree, token-budgeted
//   find(v, query)    → where does this key/value live? → the paths, so you know what to read
//
// THE THREAT MODEL IS THE POINT. prism reads UNTRUSTED data — an API response, a log, a file an
// agent did not write. So every operation is BOUNDED: input bytes are capped before parse (a 2 GB
// file cannot OOM the process), traversal visits at most a fixed number of nodes, and output is
// token-budgeted. A tool that summarises untrusted data by trying to hold all of it in memory is a
// one-request DoS against the agent that called it. (Same lesson anvil's 40 GB diff taught the kit.)

const KB = 1024, MB = 1024 * KB;

// Defaults — every one is a hard ceiling, overridable per call.
export const DEFAULTS = {
  maxBytes: 64 * MB,      // never read more than this from a file/stream/URL before parsing
  maxDepth: 6,            // how deep shape() and read() descend before saying "truncated"
  maxKeys: 40,            // object fields shown per level (the rest become a withheld count)
  sample: 20,            // array elements sampled to infer a merged element shape
  budget: 1800,          // token budget for read() output (scout's default; lower-is-tighter)
  maxNodes: 200000,      // nodes find() will visit before it stops and says so
  maxHits: 50,           // matches find() returns
};

// ~4 chars/token, the estimate the rest of the kit uses (scout/lens). Good enough to budget on.
export const estTokens = (s) => Math.ceil(String(s).length / 4);

// ── the type of a value, at prism's granularity ──────────────────────────────
// int vs float matters to an agent shaping an id column vs a price; null and empty are their own
// things because "the key exists and is null" and "the key is missing" are different facts.
function kindOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  const t = typeof v;
  if (t === 'number') return Number.isInteger(v) ? 'int' : 'float';
  if (t === 'object') return 'object';
  if (t === 'boolean') return 'bool';
  return t; // 'string'
}

// ── shape: the skeleton of a value ───────────────────────────────────────────
// Returns a small JSON-serialisable descriptor. Depth-, key- and sample-capped so the descriptor of
// a 500 MB document is still a few hundred tokens. This is the headline move: the shape of the data
// instead of the data.
export function shape(value, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  return shapeAt(value, 0, o);
}

function shapeAt(v, depth, o) {
  const k = kindOf(v);
  if (k === 'string') {
    const d = { type: 'string', len: v.length };
    // a short string IS its own best shape; a long one is described, not dumped
    if (v.length <= 60) d.sample = v;
    return d;
  }
  if (k === 'int' || k === 'float' || k === 'bool' || k === 'null') {
    const d = { type: k };
    if (k !== 'null') d.sample = v; // one concrete value is worth more than the word "number"
    return d;
  }
  if (k === 'array') {
    const len = v.length;
    if (len === 0) return { type: 'array', len: 0, of: 'empty' };
    if (depth >= o.maxDepth) return { type: 'array', len, truncated: true };
    const n = Math.min(len, o.sample);
    const elems = [];
    for (let i = 0; i < n; i++) elems.push(shapeAt(v[i], depth + 1, o));
    const merged = mergeShapes(elems);
    const out = { type: 'array', len, of: merged };
    if (n < len) out.sampled = n; // be honest that `of` came from a sample, not all N
    return out;
  }
  // object
  const keys = Object.keys(v);
  if (depth >= o.maxDepth) return { type: 'object', keys: keys.length, truncated: true };
  const shown = keys.slice(0, o.maxKeys);
  const fields = {};
  for (const key of shown) fields[key] = shapeAt(v[key], depth + 1, o);
  const out = { type: 'object', keys: keys.length, fields };
  if (keys.length > shown.length) out.withheld = keys.length - shown.length; // scout's contract
  return out;
}

// Merge the shapes of several array elements into ONE representative element shape. Homogeneous
// arrays (the common case — a list of the same record) collapse to a single clean shape; a key that
// is not in every element is marked optional; genuinely mixed elements are reported as such rather
// than pretending the first one is the whole truth.
function mergeShapes(shapes) {
  // One sampled element already IS the representative shape — return it verbatim. Re-deriving it
  // (rebuilding an array's shape from its inner `of`) double-processes the nesting and drops flags
  // like `truncated`, which is how a deep single-element chain lost its depth cap.
  if (shapes.length === 1) return shapes[0];
  const types = [...new Set(shapes.map((s) => s.type))];
  if (types.length > 1) return { type: 'mixed', types: types.sort(), sampled: shapes.length };
  const type = types[0];
  if (type === 'object') {
    const total = shapes.length;
    const count = new Map();      // key -> how many elements had it
    const perKey = new Map();     // key -> its shapes across elements
    let maxKeys = 0;
    for (const s of shapes) {
      const fk = Object.keys(s.fields || {});
      maxKeys = Math.max(maxKeys, s.keys ?? fk.length);
      for (const key of fk) {
        count.set(key, (count.get(key) || 0) + 1);
        if (!perKey.has(key)) perKey.set(key, []);
        perKey.get(key).push(s.fields[key]);
      }
    }
    const fields = {};
    for (const [key, shs] of perKey) {
      const f = mergeShapes(shs);
      if (count.get(key) < total) f.optional = true; // present in some elements, not all
      fields[key] = f;
    }
    return { type: 'object', keys: maxKeys, fields };
  }
  if (type === 'array') {
    const maxLen = Math.max(...shapes.map((s) => s.len || 0));
    if (shapes.some((s) => s.truncated)) return { type: 'array', len: maxLen, truncated: true };
    // merge the element-shapes of the nested arrays too, so [[...],[...]] describes its inner element
    const inners = shapes.map((s) => s.of).filter((x) => x && x !== 'empty');
    return { type: 'array', len: maxLen, of: inners.length ? mergeShapes(inners) : 'empty' };
  }
  // scalars: one shape stands for all; keep a sample if present
  const withSample = shapes.find((s) => 'sample' in s);
  return withSample ? { type, sample: withSample.sample } : { type };
}

// ── path parsing & resolution ────────────────────────────────────────────────
// Grammar (small on purpose): dot-separated keys, [n] for an array index, [*] to map over every
// element of an array.  users.0.name  ·  users[0].name  ·  data.items[*].id
export function parsePath(path) {
  if (path == null || path === '' || path === '$' || path === '.') return [];
  const acc = [];
  const re = /\[\*\]|\[\d+\]|[^.[\]]+/g;
  let m;
  while ((m = re.exec(path))) {
    const t = m[0];
    if (t === '[*]') acc.push({ wild: true });
    else if (/^\[\d+\]$/.test(t)) acc.push({ index: +t.slice(1, -1) });
    else if (/^\d+$/.test(t)) acc.push({ index: +t }); // bare number segment = index
    else acc.push({ key: t });
  }
  return acc;
}

// Walk the accessors. A [*] turns the result into a collection: everything after it is applied to
// each element and gathered. Returns { ok, value } or { ok:false, at } naming where the walk fell off
// (a wrong key is a fact the agent needs, not an exception to swallow).
function resolve(value, acc, i = 0, trail = '') {
  if (i >= acc.length) return { ok: true, value };
  const a = acc[i];
  if (a.wild) {
    if (!Array.isArray(value)) return { ok: false, at: trail || '$', want: 'array for [*]', got: kindOf(value) };
    const out = [];
    for (let j = 0; j < value.length; j++) {
      const r = resolve(value[j], acc, i + 1, `${trail}[${j}]`);
      if (r.ok) out.push(r.value); // elements that don't have the tail are simply skipped
    }
    return { ok: true, value: out, collected: true };
  }
  if (a.index != null) {
    if (!Array.isArray(value)) return { ok: false, at: trail || '$', want: 'array', got: kindOf(value) };
    if (a.index >= value.length) return { ok: false, at: `${trail}[${a.index}]`, want: `index < ${value.length}`, got: 'out of range' };
    return resolve(value[a.index], acc, i + 1, `${trail}[${a.index}]`);
  }
  // key
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, at: trail || '$', want: `object with key "${a.key}"`, got: kindOf(value) };
  }
  if (!(a.key in value)) return { ok: false, at: trail ? `${trail}.${a.key}` : a.key, want: 'existing key', got: 'missing' };
  return resolve(value[a.key], acc, i + 1, trail ? `${trail}.${a.key}` : a.key);
}

// ── read: the subtree at a path, token-budgeted ──────────────────────────────
// If the subtree fits the budget, you get it verbatim. If it doesn't, you get its SHAPE plus the
// honest size, because a silently half-serialised object is a lie about what the data is. Either way
// the caller can act: read it, or narrow the path and read again.
export function read(value, path, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const acc = parsePath(path);
  const r = resolve(value, acc);
  if (!r.ok) {
    return { path: path || '$', found: false, error: `no value at ${r.at} — expected ${r.want}, found ${r.got}` };
  }
  const sub = r.value;
  const json = safeStringify(sub, o.maxBytes);
  // Unserialisable (too deeply nested for JSON.stringify, which is recursive and will stack-overflow
  // where our depth-bounded shape() will not) — hand back the shape, never the raw value the caller
  // would then have to serialise itself and crash on.
  if (json == null) {
    return { path: path || '$', found: true, type: kindOf(sub), complete: false,
      note: 'the value at this path is too deeply nested to serialise — showing its shape instead. Read a shallower sub-path.',
      shape: shape(sub, o) };
  }
  const tokens = estTokens(json);
  const base = { path: path || '$', found: true, type: kindOf(sub), tokens };
  if (r.collected) base.count = Array.isArray(sub) ? sub.length : undefined;
  if (tokens <= o.budget) return { ...base, complete: true, value: sub };
  // over budget: hand back the shape instead of a truncated body, and say why
  return {
    ...base,
    complete: false,
    withheld_tokens: tokens - o.budget,
    note: `the value at this path is ~${tokens} tokens, over the ${o.budget}-token budget — showing its shape instead. Narrow the path (e.g. add [0] or a key) and read again, or raise --tokens.`,
    shape: shape(sub, o),
  };
}

// JSON.stringify, but a value whose serialisation would blow past the byte cap (a pathological
// self-similar structure, a giant string table) is not something we hand back whole.
function safeStringify(v, cap) {
  let out;
  try { out = JSON.stringify(v, null, 2); }
  catch { return null; }   // stack overflow on deep nesting, or a value JSON can't represent
  if (out == null) return String(v);
  return out.length > cap ? out.slice(0, cap) : out;
}

// ── find: where does a key or value live? ────────────────────────────────────
// Breadth-first so the shallowest (usually most useful) matches come first, bounded at maxNodes so a
// huge document cannot make the search itself the DoS. Matches on key name (substring, case-
// insensitive) and on scalar values (string substring; exact for number/bool). Returns PATHS — the
// input to read() — not the values themselves.
export function find(value, query, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const q = String(query ?? '').toLowerCase();
  if (!q) return { query: String(query ?? ''), hits: [], matched: 0, error: 'empty query' };
  const hits = [];
  let visited = 0, matched = 0, truncated = false;
  const queue = [{ v: value, path: '$', key: null }];
  while (queue.length) {
    const { v, path, key } = queue.shift();
    if (visited++ >= o.maxNodes) { truncated = true; break; }
    // a matching KEY on the way in
    if (key != null && String(key).toLowerCase().includes(q)) {
      matched++;
      if (hits.length < o.maxHits) hits.push({ path, kind: 'key', type: kindOf(v), preview: previewOf(v) });
    }
    const k = kindOf(v);
    if (k === 'string' || k === 'int' || k === 'float' || k === 'bool') {
      if (scalarMatches(v, q)) {
        matched++;
        if (hits.length < o.maxHits) hits.push({ path, kind: 'value', type: k, preview: previewOf(v) });
      }
    } else if (k === 'array') {
      for (let i = 0; i < v.length; i++) queue.push({ v: v[i], path: `${path}[${i}]`, key: null });
    } else if (k === 'object') {
      for (const key2 of Object.keys(v)) queue.push({ v: v[key2], path: path === '$' ? key2 : `${path}.${key2}`, key: key2 });
    }
  }
  return {
    query: String(query ?? ''),
    matched,
    returned: hits.length,
    ...(matched > hits.length ? { withheld: matched - hits.length } : {}),
    ...(truncated ? { truncated: true, visited, note: `stopped after visiting ${visited} nodes — there may be more; narrow with a more specific query` } : {}),
    hits,
  };
}

function scalarMatches(v, qLower) {
  if (typeof v === 'string') return v.toLowerCase().includes(qLower);
  return String(v).toLowerCase() === qLower; // numbers/bools: exact, so "1" doesn't match "1000"
}

function previewOf(v) {
  const k = kindOf(v);
  if (k === 'string') return v.length <= 60 ? v : v.slice(0, 57) + '…';
  if (k === 'int' || k === 'float' || k === 'bool') return v;
  if (k === 'null') return null;
  if (k === 'array') return `[${v.length} items]`;
  return `{${Object.keys(v).length} keys}`;
}
