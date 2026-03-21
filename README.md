# @byterover/byterover

ByteRover context engine plugin for [OpenClaw](https://github.com/openclaw/openclaw). Integrates the [brv CLI](https://www.byterover.dev) as a context engine that curates conversation knowledge and retrieves relevant context for each prompt — giving your AI agent persistent, queryable memory.

## Table of contents

- [What it does](#what-it-does)
- [Prerequisites](#prerequisites)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [How it works](#how-it-works)
- [Development](#development)
- [Project structure](#project-structure)
- [License](#license)

## What it does

When you chat with an OpenClaw agent, the conversation is ephemeral — older messages get compacted or lost as the context window fills up. ByteRover changes that by:

1. **Curating every turn** — after each conversation turn, the plugin feeds the new messages to `brv curate`, which extracts and stores facts, decisions, technical details, and preferences worth remembering
2. **Querying on demand** — before each new prompt is sent to the LLM, the plugin runs `brv query` with the user's message to retrieve curated knowledge relevant to the current request
3. **Injecting context** — retrieved knowledge is appended to the system prompt so the LLM has the right context without the user needing to repeat themselves

The result: your agent remembers what matters, forgets what doesn't, and retrieves context that's actually relevant to what you're asking about right now.

## Prerequisites

- [OpenClaw](https://github.com/openclaw/openclaw) with plugin context engine support
- Node.js 22+
- [brv CLI](https://www.byterover.dev) installed and available on your `PATH` (or provide a custom path via config). The brv path depends on how you installed it:
  - **curl**: the default path is `~/.brv-cli/bin/brv`
  - **npm**: run `which brv` to find the path, then set it via `brvPath` in the plugin config

## Quick start

### 1. Install the plugin

```bash
openclaw plugins install @byterover/byterover
```

For local development, link your working copy instead:

```bash
openclaw plugins install --link /path/to/brv-openclaw-plugin
```

### 2. Configure the context engine slot

```bash
openclaw config set plugins.slots.contextEngine byterover
```

### 3. Set plugin options

Point the plugin to your brv binary and project directory:

```bash
openclaw config set plugins.entries.byterover.config.brvPath /path/to/brv
openclaw config set plugins.entries.byterover.config.cwd /path/to/your/project
```

### 4. Verify

```bash
openclaw plugins list
```

You should see `byterover` listed and enabled. Restart OpenClaw, then start a conversation — you'll see `[byterover] Plugin loaded` in the gateway logs.

### 5. Uninstall (if needed)

```bash
openclaw plugins uninstall byterover
openclaw config set plugins.slots.contextEngine ""
```

## Configuration

ByteRover is configured through `plugins.entries.byterover.config` in your OpenClaw config file (`~/.openclaw/openclaw.json`):

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
          "brvPath": "/usr/local/bin/brv",
          "cwd": "/path/to/your/project",
          "queryTimeoutMs": 12000,
          "curateTimeoutMs": 60000
        }
      }
    }
  }
}
```

### Options


| Option            | Type     | Default         | Description                                                                                                                                   |
| ----------------- | -------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `brvPath`         | `string` | `"brv"`         | Path to the brv CLI binary. Defaults to resolving `brv` from `PATH`.                                                                          |
| `cwd`             | `string` | `process.cwd()` | Working directory for brv commands. Must be a project with `.brv/` initialized.                                                               |
| `queryTimeoutMs`  | `number` | `12000`         | Timeout in milliseconds for `brv query` calls. The effective assemble deadline is capped at 10,000 ms to stay within the agent ready timeout. |
| `curateTimeoutMs` | `number` | `60000`         | Timeout in milliseconds for `brv curate` calls.                                                                                               |


## How it works

ByteRover hooks into three points in the OpenClaw context engine lifecycle:

### `afterTurn` — curate conversation knowledge

After each conversation turn completes, the plugin:

1. Extracts new messages from the turn (skipping pre-prompt messages)
2. Strips OpenClaw metadata (sender info, timestamps, tool results) to get clean text
3. Serializes messages with sender attribution
4. Sends the text to `brv curate --detach` for asynchronous knowledge extraction

Curation runs in detached mode — the brv daemon queues the work and the CLI returns immediately, so it never blocks the conversation.

### `assemble` — retrieve relevant context

Before each prompt is sent to the LLM, the plugin:

1. Takes the current user message (or falls back to scanning message history)
2. Strips metadata and skips trivially short queries (< 5 chars)
3. Runs `brv query` with a 10-second deadline
4. Wraps the result in a `<byterover-context>` block and injects it as a system prompt addition

If the query times out or fails, the conversation proceeds without context — it's always best-effort.

### `compact` — delegated to runtime

ByteRover does not own compaction. The plugin sets `ownsCompaction: false`, so OpenClaw's built-in sliding-window compaction handles context window management as usual.

### `ingest` — no-op

Ingestion is handled by `afterTurn` in batch (all new messages from the turn at once), so the per-message `ingest` hook is a no-op.

## Development

```bash
# Install dependencies
npm install

# Type check
npx tsc --noEmit

# Run tests
npx vitest run --dir test

# Link for local testing with OpenClaw
openclaw plugins install --link .
openclaw config set plugins.slots.contextEngine byterover
```

### Testing locally

1. Initialize a brv project: `cd /your/project && brv init`
2. Link the plugin and configure as shown in [Quick start](#quick-start)
3. Restart OpenClaw
4. Send a few messages — check gateway logs for:
  - `[byterover] Plugin loaded` — plugin registered
  - `afterTurn curating N new messages` — curation running
  - `assemble injecting systemPromptAddition` — context being retrieved and injected

## Project structure

```
index.ts                    # Plugin entry point and registration
openclaw.plugin.json        # Plugin manifest (id, kind, config schema)
src/
  context-engine.ts         # ByteRoverContextEngine — implements ContextEngine
  brv-process.ts            # brv CLI spawning (query, curate) with timeout/abort
  message-utils.ts          # Metadata stripping and message text extraction
  types.ts                  # Standalone type definitions (structurally compatible with openclaw/plugin-sdk)
```

## License

MIT