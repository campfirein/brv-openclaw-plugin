# @byterover/byterover

ByteRover context engine plugin for OpenClaw, mono build. It recalls curated
knowledge in-process from ByteRover's centralized data directory and exposes
`brv_record` so the agent can write durable memory through a first-class tool.

## What It Does

1. `assemble` runs in-process recall and injects `<byterover-context>` when
   matching topics exist.
2. `assemble` always injects `<byterover-curate-guidance>` so the agent knows
   when and how to preserve durable knowledge.
3. The plugin registers `brv_record`; there is no `afterTurn` auto-curate flow.

This follows ByteRover v4 skill behavior: query before thinking, then curate
only knowledge with durable value after implementation.

## What To Record

Record:

- Decisions and the reasoning behind them.
- Rules, conventions, and preferences worth pinning.
- Bug symptoms, root causes, and fixes.
- Non-obvious gotchas, constraints, or reusable workflow/design patterns.
- Facts the user explicitly asked the agent to remember.
- Durable new results produced after ByteRover recall had no relevant topic for
  the user's question.

Skip:

- General explanations, definitions, summaries, or facts the user did not ask
  the agent to remember.
- Details already obvious from code, git history, or files just edited.
- Pure acknowledgements, greetings, or clarifying questions with no durable
  content.
- Knowledge already covered by retrieved ByteRover context.
- Unrelated retrieved context; do not save irrelevant hits just because recall
  returned them.

## Prerequisites

- OpenClaw with plugin context engine support.
- Node.js 22+.
- A sibling `byterover-mono` checkout for local build and tests, because
  `@byterover/core` is bundled at build time.

By default the build reads:

```bash
../byterover-mono/packages/core/src/index.ts
```

Override that path with `BYTEROVER_MONO_CORE` when needed. The published
runtime bundle is standalone and does not require the `brv` CLI at runtime.

## Quick Start

Install from the package registry:

```bash
openclaw plugins install @byterover/byterover
openclaw config set plugins.slots.contextEngine byterover
```

For local development:

```bash
cd /path/to/brv-openclaw-plugin
npm install
npm run build
openclaw plugins install --link /path/to/brv-openclaw-plugin
openclaw config set plugins.slots.contextEngine byterover
```

OpenClaw's install validator expects compiled runtime output at
`dist/index.js`, so rebuild before linking after source edits.

## Configuration

Configure the plugin through `plugins.entries.byterover.config`:

```json
{
  "plugins": {
    "slots": {
      "contextEngine": "byterover"
    },
    "entries": {
      "byterover": {
        "enabled": true,
        "config": {
          "cwd": "/path/to/your/project",
          "recallLimit": 5
        }
      }
    }
  }
}
```

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `cwd` | `string` | OpenClaw workspace fallback | Project working directory used to resolve the centralized ByteRover context tree when session workspace resolution is unavailable. |
| `recallLimit` | `number` | `5` | Top-N cap on recall hits. |
| `recallScript` | `string` | none | Deprecated no-op retained for compatibility with the older script-backed mono prototype. |
| `recallTimeoutMs` | `number` | none | Deprecated no-op; recall is in-process and this timeout is ignored. |
| `queryTimeoutMs` | `number` | none | Deprecated no-op legacy alias from the CLI-flavored plugin. |

## How It Works

### `assemble`

Before each model call, the engine extracts the latest user query, resolves the
workspace's ByteRover context tree, searches it through `@byterover/core`, and
injects matching topic HTML inside `<byterover-context>`.

The same system-prompt addition always includes `<byterover-curate-guidance>`.
That guidance tells the agent to call `brv_record` only for durable memory,
matching the v4 skill state in `byterover-mono`.

### `brv_record`

The plugin registers a first-class agent tool named `brv_record`. The agent
authors one `<bv-topic>` HTML document and passes it to the tool with a
slash-separated topic path. The tool writes through `@byterover/core` in-process.

### `ingest`

`ingest` is intentionally a no-op. Mono recording is explicit through
`brv_record`; the plugin does not batch-curate every turn.

### `compact`

ByteRover does not own compaction. `ownsCompaction` is `false`, so the runtime
keeps its normal compaction behavior.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

Tests resolve `@byterover/core` from the sibling mono checkout's built dist:

```bash
../byterover-mono/packages/core/dist/index.js
```

Override that with `BYTEROVER_MONO_CORE_DIST` when needed.

## Project Structure

```text
index.ts                    # Plugin entry point and tool registration
build.mjs                   # esbuild bundle with @byterover/core inlined
openclaw.plugin.json        # Plugin manifest and config schema
src/context-engine.ts       # ContextEngine implementation
src/curate-guidance.ts      # v4-aligned curation guidance block
src/recall.ts               # In-process recall
src/record.ts               # brv_record tool and in-process write path
src/message-utils.ts        # Query/content extraction helpers
src/types.ts                # OpenClaw-compatible local types
```

## License

[Elastic License 2.0 (ELv2)](./LICENSE)
