/**
 * Curate-guidance block injected into every assemble result.
 *
 * Mirrors mono's `~/.openclaw/skills/byterover/curate.md` quality bar so the
 * agent gets the same instructions whether it discovers byterover via the
 * skill markdown directly or via this context-engine plugin. The cli flavor
 * of this guidance walks the agent through a session-based `brv curate`
 * protocol; mono's `record.mjs` is one-shot, so the guidance is simpler.
 *
 * Per the integration plan, this block ships with every assemble (no
 * smart-debounce), and the agent decides when to invoke record.mjs via
 * its shell tool. The plugin does NOT call record.mjs itself.
 */

export const CURATE_GUIDANCE = `<byterover-curate-guidance>
# After this turn — save new knowledge to byterover

If your answer carried NEW knowledge that the retrieved context above did not
already cover (a decision, a rule, a bug+fix pair, a project convention, or a
non-obvious gotcha), persist it via your shell / code-execution tool. The host
conversation already returned to the user; this happens in the background.

## Skip curation when

- The retrieved context above already covered the answer (don't duplicate).
- Pure conversational filler (greetings, acknowledgments, one-word replies).
- The user explicitly asked you not to record.

## Form — pick the one that matches the topic

| The fact is… | Use the form |
|---|---|
| **A single durable fact** (one sentence, no decision/rule/fix pairing) | Simple \`--title --body\` |
| **Multi-element** (decision + reason, bug + fix, rule + fact, anything mixed) | Rich \`--html\` with a structured \`<bv-topic>\` document |

Wrapping a single fact in \`<bv-decision>\` + \`<bv-reason>\` + \`<bv-rule>\` is
theater. Conversely, the simple form's lone \`<bv-fact>\` wrapper is structurally
wrong for a topic that carries a decision, a rule, or a fix — use rich.

## Simple form (one-fact topics)

\`\`\`bash
node ~/.openclaw/skills/byterover/scripts/record.mjs "<domain>/<topic>" \\
  --title "<short title>" \\
  --summary "<one-line summary>" \\
  --keywords "<comma,separated,terms>" \\
  --tags "<comma,separated,categories>" \\
  --body "<one paragraph>"
\`\`\`

## Rich form (multi-element topics)

\`\`\`bash
node ~/.openclaw/skills/byterover/scripts/record.mjs "<domain>/<topic>" --html '<bv-topic
  path="<domain>/<topic>"
  title="<short title>"
  summary="<one-line summary>"
  keywords="<csv>"
  tags="<csv>"
  related="@<other/topic>.html"
><bv-task>What this topic is about, one sentence.</bv-task>
<bv-decision id="d-…">The decision in one sentence.</bv-decision>
<bv-reason>Why this decision holds.</bv-reason>
<bv-rule severity="must">Verbatim project rule.</bv-rule>
<bv-fact subject="snake_case_subject" category="convention" value="extracted">Canonical natural-language statement.</bv-fact>
<bv-files><li>src/path/to/file.ts</li></bv-files>
</bv-topic>'
\`\`\`

## Required <bv-topic> attributes (rich form)

| Attribute | Required | Notes |
|---|---|---|
| \`path\` | yes | Slash-separated snake_case (e.g. \`security/auth\`). No \`.html\` — the writer appends it. Must match the positional argument. |
| \`title\` | yes | Human-readable short title. |
| \`summary\` | recommended | One-line semantic summary. |
| \`tags\` | optional | Comma-separated categories: \`"security,authentication"\`. |
| \`keywords\` | optional | Comma-separated retrieval terms; drives BM25 search. |
| \`related\` | optional | Cross-references: \`"@security/cookies.html"\` for file targets, \`"@ops"\` for domain targets. |

**Never author** \`importance\`, \`maturity\`, \`recency\`, \`createdat\`, \`updatedat\` —
those are system-managed sidecar signals; the writer rejects them.

## Required structure (rich form)

Every rich topic MUST contain:

1. A scoping element: \`<bv-task>\` (or an \`<h1>\` + intro paragraph).
2. At least one structural element: \`<bv-decision>\`, \`<bv-bug>\`, \`<bv-fix>\`,
   \`<bv-changes>\`, \`<bv-files>\`, \`<bv-flow>\`, \`<bv-structure>\`,
   \`<bv-dependencies>\`, \`<bv-highlights>\`.

The validator accepts topics missing them; the search experience does not. A
topic with only \`<bv-fact>\` siblings ranks poorly.

## Preservation rules

When the body of the fact you are recording carries primary-source material,
preserve it verbatim:

- Exact rules → \`<bv-rule severity="must|should">\` verbatim text.
- Code snippets → \`<pre><code>\` inside \`<bv-examples>\`.
- Diagrams → \`<bv-diagram type="mermaid|plantuml|ascii|dot|graphviz|other">\` verbatim.
- Concrete facts → one \`<bv-fact subject="…" category="…" value="…">…</bv-fact>\` per fact.
- Dates → resolve relative ("last Thursday") to absolute when possible.

## Path-exists handling

If \`record.mjs\` returns an error like \`A topic already exists at "<path>"\`:

1. Read the existing topic:
   \`\`\`bash
   node ~/.openclaw/skills/byterover/scripts/brv.mjs read "<path>.html"
   \`\`\`
2. Merge the new facts with the existing topic — preserve every prior
   \`<bv-rule>\`, \`<bv-fact>\`, \`<bv-decision>\`, \`<bv-bug>\`, \`<bv-fix>\`. Enrich, never shrink.
3. Re-run with \`--overwrite\`. If the result includes a \`structural-loss\`
   warning, your merged HTML dropped element types — add them back and retry.
</byterover-curate-guidance>`;
