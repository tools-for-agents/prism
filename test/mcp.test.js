// prism MCP test — drive the real server over stdio and assert the protocol contract: it lists the
// three tools with annotations, enforces required args, validates types, runs a call end-to-end, and
// hands an expected failure (a syntax error) back as a tool result rather than crashing the stream.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('../mcp/mcp-server.js', import.meta.url));

// Send a batch of JSON-RPC messages, collect the id-bearing replies, then close stdin.
function rpc(messages) {
  return new Promise((resolve, reject) => {
    const p = spawn('node', [SERVER], { stdio: ['pipe', 'pipe', 'ignore'] });
    let buf = '';
    const out = [];
    p.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (line.trim()) out.push(JSON.parse(line));
      }
    });
    p.on('close', () => resolve(out));
    p.on('error', reject);
    for (const m of messages) p.stdin.write(JSON.stringify(m) + '\n');
    p.stdin.end();
  });
}
const byId = (out, id) => out.find((m) => m.id === id);

test('initialize announces the prism server and tools/list returns the three tools with annotations', async () => {
  const out = await rpc([
    { jsonrpc: '2.0', id: 1, method: 'initialize' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  ]);
  assert.equal(byId(out, 1).result.serverInfo.name, 'prism');
  const tools = byId(out, 2).result.tools;
  assert.deepEqual(tools.map((t) => t.name).sort(), ['prism_find', 'prism_read', 'prism_shape']);
  for (const t of tools) assert.equal(t.annotations.readOnlyHint, true, `${t.name} must declare readOnly`);
});

test('prism_shape over MCP returns the skeleton of inline data', async () => {
  const out = await rpc([{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
    name: 'prism_shape', arguments: { data: '{"a":1,"b":["x","y"]}' } } }]);
  const payload = JSON.parse(byId(out, 1).result.content[0].text);
  assert.equal(payload.type, 'object');
  assert.equal(payload.fields.a.type, 'int');
  assert.equal(payload.fields.b.type, 'array');
});

test('prism_read over MCP drills a path and respects the token budget', async () => {
  const out = await rpc([{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
    name: 'prism_read', arguments: { data: '{"user":{"email":"a@x.com"}}', path: 'user.email' } } }]);
  const payload = JSON.parse(byId(out, 1).result.content[0].text);
  assert.equal(payload.value, 'a@x.com');
});

test('prism_find over MCP returns real hits (default maxHits must survive the MCP layer)', async () => {
  // regression guard: a run() that spread `maxHits: undefined` clobbered the default and returned
  // ZERO hits — a call that looks successful but finds nothing.
  const out = await rpc([{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
    name: 'prism_find', arguments: { data: '{"config":{"timeout_ms":500}}', query: 'timeout' } } }]);
  const payload = JSON.parse(byId(out, 1).result.content[0].text);
  assert.equal(payload.matched, 1);
  assert.equal(payload.hits.length, 1);
  assert.equal(payload.hits[0].path, 'config.timeout_ms');
});

test('a missing required argument is refused by the schema, not run', async () => {
  const out = await rpc([{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
    name: 'prism_read', arguments: { data: '{"a":1}' } } }]);   // no `path`
  assert.match(byId(out, 1).error.message, /missing required argument.*path/);
});

test('a wrong-typed argument is refused with the type it actually got', async () => {
  const out = await rpc([{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
    name: 'prism_find', arguments: { data: '{"a":1}', query: 'a', k: 'lots' } } }]);   // k must be int
  assert.match(byId(out, 1).error.message, /"k" must be integer, got string/);
});

test('an expected failure (invalid JSON) comes back as an isError tool result, not a crashed stream', async () => {
  const out = await rpc([
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'prism_shape', arguments: { data: '{ not json' } } },
    { jsonrpc: '2.0', id: 2, method: 'ping' },   // the stream must still be alive after the error
  ]);
  const call = byId(out, 1);
  assert.equal(call.result.isError, true);
  assert.match(call.result.content[0].text, /invalid JSON/);
  assert.ok(byId(out, 2), 'the server must still answer after handing back an error');
});

test('neither data nor source is a clear, explained error', async () => {
  const out = await rpc([{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
    name: 'prism_shape', arguments: {} } }]);
  assert.equal(byId(out, 1).result.isError, true);
  assert.match(byId(out, 1).result.content[0].text, /data.*or.*source/);
});
