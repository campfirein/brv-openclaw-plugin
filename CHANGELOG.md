# Changelog

## 2.0.0

**Tool-mode adaptation (ENG-2853).** Migrates the OpenClaw context engine plugin to the tool-mode `brv` CLI shipping in byterover-cli M1-M4 + brv-bridge v2 (ENG-2852). Curate becomes agent-initiated via a registered `brv-curate` tool; auto-curate from `afterTurn` is dropped.

### Breaking

- **`afterTurn` no longer auto-curates.** The legacy flow serialized turn messages and called `bridge.persist(text)` so byterover's own LLM could author topic HTML. Tool-mode `brv` has no byterover-side LLM. `afterTurn` is now a no-op stub returning `Promise<void>`. The calling agent invokes the registered `brv-curate` tool directly during a turn when its content is worth saving.

- **Minimum peer dependency:** `byterover-cli` must be the tool-mode-capable version (M3 MCP migration onward). Plugin's `peerDependencies.byterover-cli` documents the minimum.

- **`@byterover/brv-bridge` peer dep bumped to `^2.0.0`.** Plugins on bridge v1 will fail to construct the agent tools (the v2 surface — `persistHtml`, `queryEnvelope` — doesn't exist on v1).

### Added

- **`brv-curate` agent tool** — registered via `api.registerTool` in `register(api)`. The agent submits `{html, meta?, confirmOverwrite?, cwd?}`; the tool calls `bridge.persistHtml(...)` and returns the structured result. Success / validation-failed / bridge-error paths all surface as `jsonResult({...})`; the tool never throws.

- **`brv-query` agent tool** — registered alongside curate. The agent submits `{query, limit?, cwd?}`; the tool calls `bridge.queryEnvelope(...)` and returns the raw `QueryToolModeResult` envelope for the agent to read `matchedDocs[].rendered_md` directly.

- **`assemble` always injects curate guidance.** A new `<byterover-curate-guidance>` block is appended to `systemPromptAddition` every turn (even when recall surfaces no content), naming the four trigger conditions — decisions, patterns, facts, rules — so the agent knows when to call `brv-curate`.

- **Schema parity test** — `test/tools/schema-parity.test.ts` asserts the typebox-derived JSON Schema for each tool's parameters matches the zod-derived JSON Schema from MCP (byterover-cli) on every shared field. Catches drift between the two host surfaces at CI time. v1 allowlist: `meta` is typebox-only (MCP catches up in byterover-cli M4 curate-metadata).

- **`@sinclair/typebox`** runtime dep — OpenClaw expects `parameters: TSchema` (typebox) on tool registrations. The MCP side uses zod; parity test prevents drift.

### Changed

- **`OpenClawPluginApi.registerTool` context type widened.** Previously typed as `(ctx: { sessionKey: string }) => unknown`; now structurally compatible with `OpenClawPluginToolContext` from openclaw-official so tool factories can read `workspaceDir`, `agentDir`, etc. Uses structural typing — OpenClaw may add new fields without breaking compile.

- **Plugin registers a single `ByteRoverContextEngine` instance** that owns the `BrvBridge`; the bridge is shared via `engine.getBridge()` between the context engine slot (used by `assemble`) and the agent tool factories. Single set of timeouts, logger, paths.

- **`ByteRoverContextEngine.info.version`** bumped to `2.0.0`.

### Deprecated / Removed

- **`serializeMessagesForCurate`, `extractSenderInfo`, `stripAssistantTags`** — only used by the removed `afterTurn` auto-curate pipeline. Deleted.

- **`zod-to-json-schema` devDep** — replaced by zod v4's built-in `z.toJSONSchema()` in the parity test.

### Migration

Existing users who relied on `afterTurn` auto-curate must:

1. Update to `byterover-cli` ≥ M3 (MCP migration) version.
2. Update both `@byterover/byterover` and `@byterover/brv-bridge` to v2.0.0 in the same `npm update` cycle (v1 ↔ v2 versions are incompatible).
3. Their agent will see the `brv-curate` tool in its tool list and the curate-guidance block in its system prompt. The agent decides when to curate; the plugin no longer pushes content automatically.

If post-release telemetry shows under-curation (agent not calling `brv-curate` when it should), file a follow-up to add a queue + reminder mechanism — out of scope for v1.

### Compatibility

- Minimum byterover-cli: M3 MCP migration onward (tool-mode `brv curate` session protocol + `brv query --format json` envelope).
- Minimum `@byterover/brv-bridge`: `^2.0.0`.
- OpenClaw plugin API: unchanged (`pluginApi >= 2026.3.22`).

### Test plan

- `npm test`: 49/49 passing (was 23; +26 covering tool factories, schema parity, `afterTurn` no-op, `assemble` guidance injection).
- Schema parity test catches typebox ↔ zod drift on every CI run (already caught one drift during development — `html` field missing `minLength: 1`).
- Manual smoke (post-publish): configure an OpenClaw project with byterover-cli + bridge v2, run the agent, verify it calls `brv-curate` after producing a decision/pattern/fact/rule.
