/**
 * Curate-guidance block injected into every assemble result.
 *
 * Tone is **command voice** — earlier docs-style wording got scrolled past.
 * Iron Law preamble + MUST/MUST-NOT list at the top, technical details
 * below. Ships every assemble (per the integration plan); the plugin does
 * NOT call record.mjs itself — the agent runs it via its shell tool.
 *
 * The guidance is **templated by the resolved scripts directory** because
 * the plugin's `recallScript` config can point anywhere (most commonly
 * mono's source, since the openclaw skill install is optional). Hardcoding
 * the path would lock users to one install layout.
 */

export interface CurateGuidanceContext {
  /** Absolute path to mono's bundled scripts directory, e.g.
   *  `/Users/.../byterover-mono/skills/byterover/scripts`. Used to compose
   *  the `node …/record.mjs …` invocations the agent runs. */
  readonly scriptsDir: string;
}

export function buildCurateGuidance(ctx: CurateGuidanceContext): string {
  const recordPath = `${ctx.scriptsDir}/record.mjs`;
  const brvPath = `${ctx.scriptsDir}/brv.mjs`;

  return `<byterover-curate-guidance>
# IRON LAW — read and obey

You are talking to a user inside OpenClaw. ByteRover is the project's
durable memory. Two rules govern every substantive turn:

1. **USE the retrieved context** when a context block is present above.
   Cite the topic path when your answer relies on it. Do not contradict a
   retrieved \`<bv-rule severity="must">\` without explicitly flagging it.

2. **CURATE new knowledge** at the END of your turn, before the final reply,
   whenever your work this turn produced any of these:
     - A decision the team should remember (e.g. "we use OAuth 2.0 with PKCE")
     - A rule or convention worth pinning ("never log full JWTs")
     - A bug root cause + the fix that resolved it
     - A non-obvious gotcha, constraint, or pattern
     - A fact the user explicitly asked you to save

   You curate by running \`record.mjs\` via your shell / code-execution tool.
   This is NOT optional for substantive turns — the user expects ByteRover
   to learn from this conversation; that only happens if you save now.

## When to SKIP curation

- The answer was a one-word reply, a greeting, or a clarifying question.
- The retrieved context already covered everything; you added no new fact.
- The user explicitly said "don't record this" or equivalent.

If any of those apply, do not curate. Otherwise: curate.

# HOW to curate — pick ONE form per topic

## Form A — Simple (one-fact topics only)

\`\`\`bash
node ${recordPath} "<domain>/<topic>" \\
  --title "<short title>" \\
  --summary "<one-line summary>" \\
  --keywords "<comma,separated,retrieval,terms>" \\
  --tags "<comma,separated,categories>" \\
  --body "<one durable paragraph>"
\`\`\`

Use Form A ONLY when the fact is genuinely one sentence (e.g. "Prod runs
Node 22 LTS"). Wrapping a single fact in \`<bv-decision>\` + \`<bv-reason>\`
+ \`<bv-rule>\` is theater.

## Form B — Rich (multi-element topics) — REQUIRED for substantive curates

For anything that carries a decision + reason, a rule + fact, a bug + fix,
or any combination of structured knowledge, you MUST use the rich form.
Form A's lone \`<bv-fact>\` wrapper is structurally wrong for these.

\`\`\`bash
node ${recordPath} "<domain>/<topic>" --html '<bv-topic
  path="<domain>/<topic>"
  title="<short title>"
  summary="<one-line semantic summary>"
  keywords="<csv retrieval terms>"
  tags="<csv categories>"
  related="@<other/topic>.html"
><bv-task>What this topic is about, one sentence.</bv-task>
<bv-decision id="d-...">The decision in one sentence.</bv-decision>
<bv-reason>Why this decision holds. The decision rots without this.</bv-reason>
<bv-rule severity="must">Verbatim project rule. Use "must" for RFC2119-MUST.</bv-rule>
<bv-fact subject="snake_case_subject" category="convention" value="extracted-form">Canonical natural-language statement.</bv-fact>
<bv-files><li>src/path/to/file.ts</li></bv-files>
</bv-topic>'
\`\`\`

# The full <bv-*> vocabulary — 19 elements, pick the right tag

Topics are HTML built from a closed set of 19 structured element types. The
engine indexes, ranks, and surfaces knowledge **by element type** — putting
a rule inside \`<bv-fact>\` or a decision inside \`<bv-highlights>\` makes it
unfindable. Use the element that matches the *kind* of knowledge.

**The most common anti-pattern: stuffing everything into \`<bv-highlights>\`
\`<li>\` items.** That produces flat topics with no structural index. Use the
specialized elements below instead.

## Container

| Element | Purpose |
|---|---|
| \`<bv-topic>\` | The root container — exactly one per file. Carries path, title, summary, keywords, tags, related. |

## Decisions and rules

| Element | Attributes | When |
|---|---|---|
| \`<bv-decision id="d-...">\` | \`id\` kebab-case | A discrete decision the team made. Pair with \`<bv-reason>\`. Body = one sentence, the decision. |
| \`<bv-reason>\` | none | The WHY behind a decision. 1-2 sentences. A decision without a reason rots fast. |
| \`<bv-rule severity="must\|should\|may" id="r-...">\` | \`severity\` (RFC 2119), \`id\` | Binding project rule. Body = verbatim rule text. |

## Facts (structured, queryable)

| Element | Attributes | When |
|---|---|---|
| \`<bv-fact subject="snake_case_subject" category="..." value="extracted-form">\` | \`subject\`, \`category\`, \`value\` | One discrete fact per element. \`category\` ∈ {\`convention\`, \`preference\`, \`project\`, \`environment\`, \`team\`, \`personal\`, \`other\`}. Body = canonical natural-language statement (NOT a label — the statement itself). |

## Action items

| Element | When |
|---|---|
| \`<bv-task>\` | The scoping element. "What this topic is about", one sentence. Almost every topic has one. |
| \`<bv-changes>\` | Things that changed in this work. \`<li>change</li>\` per item. |

## Bugs and fixes

| Element | Attributes | When |
|---|---|---|
| \`<bv-bug severity="low\|medium\|high\|critical" id="b-...">\` | \`severity\`, \`id\` | Bug record. Body = symptom + root cause. |
| \`<bv-fix id="f-...">\` | \`id\` | Fix for a bug. Body = ordered list of steps (\`<ol><li>...</li></ol>\`). |

## Patterns

| Element | Attributes | When |
|---|---|---|
| \`<bv-pattern id="p-...">\` | \`id\` | A reusable pattern (e.g. retry-with-backoff, dependency-injection shape). Body = pattern description + when to apply. |

## Structure and process

| Element | When |
|---|---|
| \`<bv-flow>\` | A process or sequence of steps. Body = natural-language description or numbered list. |
| \`<bv-structure>\` | Architecture / system shape / hierarchy. Body = \`<h3>\` + \`<ul>\` / \`<ol>\`. |
| \`<bv-dependencies>\` | Dependency relationships. \`<li>dep</li>\` per item. |
| \`<bv-highlights>\` | Key takeaways AT A GLANCE — use SPARINGLY. If you have 5+ \`<li>\` items, ask yourself if they should be structured \`<bv-fact>\` / \`<bv-rule>\` instead. |

## References and metadata

| Element | When |
|---|---|
| \`<bv-files>\` | Source files this topic touches / references. \`<li>src/path/to/file.ts</li>\` per file. |
| \`<bv-timestamp>\` | Reference date for the knowledge (ISO 8601: \`2026-06-04\` or full datetime). Use when the topic captures a point-in-time fact. |
| \`<bv-author>\` | Person who authored / decided. Optional. |

## Illustrative content

| Element | Attributes | When |
|---|---|---|
| \`<bv-examples>\` | none | Worked examples, code snippets. Wrap code in \`<pre><code>...</code></pre>\`. |
| \`<bv-diagram type="mermaid\|plantuml\|ascii\|dot\|graphviz\|other">\` | \`type\` | Verbatim diagram source. Body = the diagram text exactly as given. |

# Required structure (rich form)

Every rich topic MUST contain:

1. A scoping element: \`<bv-task>\` (or \`<h1>\` + intro paragraph).
2. At least one structural element from:
   \`<bv-decision>\`, \`<bv-bug>\`, \`<bv-fix>\`, \`<bv-changes>\`, \`<bv-files>\`,
   \`<bv-flow>\`, \`<bv-structure>\`, \`<bv-dependencies>\`, \`<bv-highlights>\`,
   \`<bv-pattern>\`, \`<bv-examples>\`, \`<bv-diagram>\`.

A rich topic containing ONLY \`<bv-fact>\` siblings is a placeholder, not a
topic. Same goes for ONLY \`<bv-highlights><li>...</li></bv-highlights>\` —
that's flat, not structured.

# <bv-topic> attributes

## Required
- \`path\` — slash-separated snake_case (e.g. \`security/auth\`). NO \`.html\`.
  Must match the positional arg to record.mjs.
- \`title\` — human-readable short title.

## Recommended
- \`summary\` — one-line semantic summary. Drives the retrieval snippet.
- \`keywords\` — CSV of retrieval terms; drives BM25 search ranking.
- \`tags\` — CSV of categories.
- \`related\` — CSV of cross-references: \`"@security/cookies.html"\` for file
  targets, \`"@ops"\` for domain targets.

## NEVER author these (system-managed; writer rejects them)

\`importance\`, \`maturity\`, \`recency\`, \`createdat\`, \`updatedat\`.

# Preservation (when the user gave you primary-source material)

- Exact rules → \`<bv-rule severity="must|should">\` verbatim.
- Code snippets → \`<pre><code>\` inside \`<bv-examples>\`.
- Diagrams → \`<bv-diagram type="mermaid|plantuml|ascii|dot|graphviz|other">\` verbatim.
- Dates → resolve relative ("last Thursday") to absolute when possible.

# Worked example — proper element variety

A "facts about AI" topic done RIGHT mixes the element types:

\`\`\`html
<bv-topic
  path="technology/ai_overview"
  title="Artificial Intelligence — overview"
  summary="History, key concepts, and modern challenges of AI."
  keywords="ai,machine learning,gan,llm,hallucination,rlhf,multimodal"
  tags="technology,ai,education"
><bv-task>Reference summary of AI history, concepts, and current challenges.</bv-task>
<bv-timestamp>2026-06-04</bv-timestamp>
<bv-fact subject="ai_origin_year" category="project" value="1956">The Dartmouth Conference in 1956 marked the formal start of AI as a field.</bv-fact>
<bv-fact subject="gan_introduction" category="project" value="2014 (Ian Goodfellow)">Generative Adversarial Networks were introduced by Ian Goodfellow in 2014.</bv-fact>
<bv-rule severity="should">LLM outputs should be verified for hallucinations before being treated as factual.</bv-rule>
<bv-pattern id="p-rlhf">Reinforcement Learning from Human Feedback (RLHF) — pair a base model with a reward model trained from human preferences; use the reward model to fine-tune the base via PPO or DPO.</bv-pattern>
<bv-structure><h3>Architecture families</h3><ul><li>Transformer (attention-based)</li><li>Diffusion (denoising)</li><li>GAN (generator + discriminator)</li><li>Neuromorphic (spiking neural networks)</li></ul></bv-structure>
<bv-examples><pre><code># A GAN training loop, conceptually
for epoch in range(N):
    real = sample_real_data()
    fake = generator(noise)
    loss_d = discriminator_loss(real, fake)
    loss_g = generator_loss(fake)
    update(loss_d, loss_g)
</code></pre></bv-examples>
</bv-topic>
\`\`\`

Compare with the WRONG shape (everything jammed into highlights):

\`\`\`html
<bv-topic ...><bv-task>...</bv-task>
<bv-highlights><li>AI started in 1956.</li><li>GANs invented 2014.</li><li>LLMs hallucinate.</li><li>RLHF is important.</li></bv-highlights></bv-topic>
\`\`\`

That second shape buries every queryable fact inside undifferentiated \`<li>\`
items. A future "what year did GANs appear?" query has no structural anchor
to find it.

# Path-exists collision (you record into an existing path)

If record.mjs returns \`A topic already exists at "<path>"\`:

1. Read the existing topic:
   \`\`\`bash
   node ${brvPath} read "<path>.html"
   \`\`\`
2. MERGE: preserve every prior \`<bv-rule>\`, \`<bv-fact>\`, \`<bv-decision>\`,
   \`<bv-bug>\`, \`<bv-fix>\`. Enrich, never shrink. Add your new facts
   alongside.
3. Re-run with \`--overwrite\`. If you see \`structural-loss\` in warnings,
   you dropped element types — add them back and retry.

# After-curate behavior

When record.mjs returns \`ok: true\`, briefly mention to the user that you
saved the knowledge (e.g. "Saved to byterover at \`security/auth\`."). Do
NOT dump the full HTML back at them — the file path is enough.

If record.mjs returns \`ok: false\`, surface the error message to the user
plainly. Do not silently retry more than once.
</byterover-curate-guidance>`;
}
