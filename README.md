# 🔻 prism

**The agent's data reader.** Point it at a JSON or JSONL blob — a file, a URL, or a string you already
hold — and get back its **shape** and the **slice you asked for**, never the whole thing. What scout does
for a web page and lens does for a source file, prism does for structured data.

Part of [tools-for-agents](https://github.com/tools-for-agents). Zero dependencies — the Node standard
library and nothing else. CLI + MCP.

---

## Why

An agent that gets handed a 200 KB API response has three bad options: paste it all into the context
window, guess at its structure, or write a throwaway script to poke at it. prism is the fourth option.

```bash
# the SHAPE of a big response — a few hundred tokens instead of the whole payload
curl -s https://api.example.com/users | prism shape -
```
```json
{
  "type": "object",
  "keys": 4,
  "fields": {
    "page":  { "type": "int", "sample": 2 },
    "total": { "type": "int", "sample": 1284 },
    "users": { "type": "array", "len": 50, "sampled": 20,
      "of": { "type": "object", "keys": 4, "fields": {
        "id":    { "type": "int" },
        "name":  { "type": "string" },
        "email": { "type": "string" },
        "roles": { "type": "array", "len": 2, "of": { "type": "string" } } } } }
  }
}
```

Now you know where everything is. Read exactly what you need:

```bash
prism read  users.json --path 'data.users[*].email'   # every email, and nothing else
prism find  config.json "timeout"                       # where does 'timeout' live? → the paths
```

## The three verbs

| Command | Gives you | For |
|---|---|---|
| `prism shape <src>` | the skeleton: keys→types, array lengths, nesting | seeing the structure of a blob you've never met |
| `prism read <src> --path P` | the subtree at path `P`, token-budgeted | pulling out just the part you need |
| `prism find <src> "<q>"` | the **paths** where a key/value lives | locating something in a big document |

**Sources** (`<src>`): a file path, an `http(s)://` URL, or `-` for stdin. **Paths**: `data.items[0].name`,
`users[*].id` (`[*]` maps over an array), `$` for the root. JSON and JSONL/NDJSON are both auto-detected.

## It is built to read *untrusted* data

prism reads blobs an agent did not write, so every operation is **bounded** — the same discipline that
keeps a sandbox safe:

- **Byte-capped before parse.** A file bigger than the cap (64 MB default) is refused up front, not read
  into memory to find out. `JSON.parse` is all-or-nothing; a 2 GB file handed to it is a frozen process.
- **Depth- and key-bounded.** `shape` stops descending at a depth and shows a fixed number of keys per
  level, so the shape of a pathologically deep or wide document is still small.
- **Token-budgeted.** An over-budget `read` hands back the value's *shape* and its honest size — never a
  silently truncated body that looks complete.
- **Node-bounded search.** `find` visits at most a fixed number of nodes, and says so if it stopped early.

Every clipped or empty answer carries the size of the whole (`"withheld": 9960`, `"len": 2000`), because
"20 results" and "20 of 1284 results" are different facts.

## Install

```bash
node --version          # 22+; nothing to npm install
npm test                # node --test
node src/cli.js shape package.json
npm run mcp             # the MCP server, stdio JSON-RPC
```

### MCP

Three tools — `prism_shape`, `prism_read`, `prism_find` — each read-only and open-world. Pass a blob inline
as `data`, or point at a file/URL with `source`:

```json
{ "name": "prism_read",
  "arguments": { "data": "{\"user\":{\"email\":\"a@x.com\"}}", "path": "user.email" } }
```

## License

MIT
