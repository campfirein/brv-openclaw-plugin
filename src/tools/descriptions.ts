/**
 * Tool descriptions — duplicated from byterover-cli's MCP TOOL_DESCRIPTION
 * (see `src/server/infra/mcp/tools/brv-curate-tool.ts`). The structural
 * parity test (`test/tools/schema-parity.test.ts`) ensures the input schema
 * matches MCP exactly; this file mirrors the human-facing text.
 *
 * Minor wording drift is acceptable — the schema parity test enforces
 * structural alignment. If MCP grows new fields, update this and re-run the
 * parity test.
 */

export const BRV_CURATE_DESCRIPTION = `Store knowledge in the ByteRover context tree by writing a <bv-topic> HTML document.

Runs deterministic validation + write — no LLM provider required. The calling agent authors the HTML in its own context; ByteRover validates the structure and writes the file.

# Output contract

- Bare HTML only — first character must be \`<\`, last characters must be \`</bv-topic>\`.
- No markdown fences, no prose preamble, no trailing commentary.
- Exactly one <bv-topic> root element per call.
- All attribute names lowercase; all attribute values double-quoted.
- Do not invent elements or attributes outside the vocabulary below.

# Path format

- The \`path\` attribute on <bv-topic> is \`<domain>/<topic>\` or \`<domain>/<topic>/<subtopic>\`, snake_case segments.
- Pick descriptive domain names (1-3 words). Reuse existing domains where they fit; avoid generic names like \`misc\`, \`general\`.

# Authoring patterns (apply when the topic naturally has more than ~5 children)

- **Group related rules under a container** rather than emitting one flat list. Use \`<bv-structure>\` for static state
  (file layout, naming conventions, type system rules) and \`<bv-flow>\` for ordered steps (TDD cycle, deployment, migration).
- **Place section titles INSIDE the container as \`<h3>title</h3>\`**, immediately after the opening tag. Section titles
  outside \`<bv-*>\` containers will render with degraded layout — they MUST nest inside.
- **Use \`<bv-fact>\` for environment/setup details** (canonical file locations, stack choices, framework versions)
  rather than burying them in narrative.
- **Use \`<bv-files>\` for a "relevant paths" pointer block** when several files anchor the topic.
- **Use \`<bv-reason>\` at the end** to capture the *why* — what problem this curation prevents.
- For short topics (1-5 items), a flat list of \`<bv-rule>\` / \`<bv-decision>\` is fine. Container grouping is for richer topics.

# Operation metadata (\`meta\` field)

The optional \`meta\` field carries operation metadata that drives the HITL review pipeline. Set fields the agent can justify; omit fields the agent cannot reasonably assert.

- \`type\`: "ADD" if creating a new topic at a path no topic exists at, "UPDATE" if replacing the existing topic at this path, "MERGE" if combining new content with existing content (typically after a path-exists correction).
- \`impact\`: "high" if this curation introduces a load-bearing decision, must-rule, architectural pattern, or new domain knowledge. "low" for refinements, additions, or clarifications.
- \`reason\`: one short sentence explaining why this curation matters (shown to human reviewers).
- \`summary\`: one-line semantic summary of the topic.
- \`previousSummary\`: (UPDATE/MERGE only) one-line summary of what existed before, so reviewers can see the intent.

Omitting \`meta\` is allowed — the curate succeeds but doesn't surface for review.

# Overwrite behavior

When a topic already exists at the resolved path, the tool refuses to clobber by default and returns a structured \`path-exists\` error with the existing content inlined so you can merge. Pass \`confirmOverwrite: true\` to replace the existing topic entirely.`;

export const BRV_QUERY_DESCRIPTION = `Retrieve structured knowledge from the ByteRover context tree via BM25 search. Returns a list of matched topics with rendered markdown bodies and metadata.

Pure BM25 retrieval — no LLM, no token cost on the byterover side. The calling agent reads \`matchedDocs[].rendered_md\` for context.

# Parameters

- \`query\`: natural-language question about the codebase or project knowledge.
- \`limit\`: max matches to return (1-50, default 10).
- \`cwd\`: optional override of the working directory (defaults to the session workspace).

# Response shape

\`\`\`
{
  status: 'ok' | 'no-matches',
  matchedDocs: [{
    format: 'html' | 'markdown',
    path: string,        // e.g. "security/auth"
    rendered_md: string, // full markdown body
    score: number,       // BM25 compound score
    title: string,
  }],
  metadata: {
    durationMs: number,
    tier: number,        // 0=exact cache, 1=fuzzy cache, 2=direct search
    topScore: number,
    totalFound: number,
    skippedSharedCount: number,
  }
}
\`\`\`

\`status: 'no-matches'\` is an expected outcome (BM25 found nothing relevant), not an error.`;
