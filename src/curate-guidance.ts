/**
 * Curate-guidance block injected into every assemble result.
 *
 * Tone is **command voice** — earlier docs-style wording got scrolled past.
 * Iron Law preamble + MUST/MUST-NOT list at the top, technical details
 * below. Ships every assemble (per the integration plan); the agent records by
 * calling the first-class `brv_record` tool.
 */

export interface CurateGuidanceContext {
  /** Reserved for future host-specific wording. */
  readonly scriptsDir?: string;
}

export function buildCurateGuidance(_ctx: CurateGuidanceContext): string {
  return `<byterover-curate-guidance>
# IRON LAW — read and obey

You are talking to a user inside OpenClaw. ByteRover is the project's
durable memory. Follow the same v4 skill contract:

1. **QUERY before you think / use retrieved context.** When a context block is
   present above, read it before drafting your answer.
   Cite the topic path when your answer relies on it. Do not contradict a
   retrieved \`<bv-rule severity="must">\` without explicitly flagging it.

2. **CURATE after you implement.** At the end of a turn, record only knowledge
   with durable value:
     - Decisions and the reasoning behind them.
     - Rules, conventions, and preferences worth pinning.
     - Bug symptoms, root causes, and fixes.
     - Non-obvious gotchas, constraints, or reusable workflow/design patterns.
     - A fact the user explicitly asked you to remember.

   Use the **\`brv_record\`** tool to save it. The model authors the
   \`<bv-topic>\` HTML; ByteRover only persists it deterministically.

## When to SKIP curation

- Pure greetings, acknowledgements ("ok"/"thanks"), or one-word replies.
- Clarifying questions with no durable content of their own.
- General explanations, definitions, facts, or summaries that the user did not
  ask you to remember.
- Details already obvious from code, git history, or files you just edited.
- Knowledge already covered by retrieved ByteRover context.
- Any turn where the user explicitly said not to record it.

If the turn produced a decision, gotcha, reusable workflow/design pattern,
bug+fix, convention, or explicit remember-this fact, record it. Otherwise skip.

## Language and sensitivity

- Match the user's language for human-readable topic content: body text,
  list items, title, and summary.
- Keep schema names in English: tag names, attribute names, enum values,
  fact subjects, and the topic path.
- Never put secrets in topic titles or prose. Title and prose are
  public-by-contract in redacted views. Put sensitive specifics in
  <bv-fact> elements; facts default restricted unless you explicitly set
  disclosure="public".

# HOW to curate — call the \`brv_record\` tool

Author the topic as a \`<bv-topic>\` HTML document, then call the tool:

\`\`\`
brv_record({
  path: "<domain>/<topic>",          // slash-separated snake_case; NO ".html"
  html: "<bv-topic path=\\"<domain>/<topic>\\" title=\\"<short title>\\"
           summary=\\"<one-line semantic summary>\\"
           keywords=\\"<csv retrieval terms>\\" tags=\\"<csv categories>\\"
           related=\\"@<other/topic>.html\\"
         ><bv-task>What this topic is about, one sentence.</bv-task>
         <bv-decision id=\\"d-...\\">The decision in one sentence.</bv-decision>
         <bv-reason>Why this decision holds. The decision rots without this.</bv-reason>
         <bv-rule severity=\\"must\\">Verbatim project rule.</bv-rule>
         <bv-fact subject=\\"snake_case_subject\\" category=\\"convention\\" value=\\"extracted-form\\">Canonical natural-language statement.</bv-fact>
         <bv-files><li>src/path/to/file.ts</li></bv-files>
         </bv-topic>"
})
\`\`\`

- \`path\` MUST match the \`<bv-topic path="…">\` attribute.
- \`overwrite: true\` ONLY when updating an existing path (merge first — see below).
- \`brv_record\` always receives rich HTML. For one durable fact, keep the topic
  small but still structured: \`<bv-task>\`, one concise \`<bv-highlights>\` or
  \`<bv-structure>\`, and one \`<bv-fact>\`. Do not force \`<bv-decision>\` or
  \`<bv-reason>\` unless it is actually a decision or the reason matters.
- The HTML string itself is bare HTML: first character \`<\`, last characters
  \`</bv-topic>\`. Do not wrap it in markdown fences.

# The full <bv-*> vocabulary — 19 elements, pick the right tag

Topics are HTML built from a closed set of 19 structured element types. The
engine indexes, ranks, and surfaces knowledge **by element type** — putting
a rule inside \`<bv-fact>\` or a decision inside \`<bv-highlights>\` makes it
unfindable. Use the element that matches the *kind* of knowledge.

**The most common anti-patterns: stuffing everything into one \`<bv-fact>\`,
or dumping unrelated claims into \`<bv-highlights>\` list items.** That produces
flat topics with weak structural search. Use the specialized elements below.

## Container

| Element | Purpose |
|---|---|
| \`<bv-topic>\` | The root container — exactly one per file. Carries path, title, summary, keywords, tags, related. |

## Decisions and rules

| Element | Attributes | When |
|---|---|---|
| \`<bv-decision id="d-...">\` | \`id\` kebab-case | A discrete decision the team made. Pair with \`<bv-reason>\`. Body = one sentence, the decision. |
| \`<bv-reason>\` | none | The WHY behind a decision. 1-2 sentences. A decision without a reason rots fast. |
| \`<bv-rule severity="must\|should\|info" id="r-...">\` | \`severity\`, \`id\` | Binding project rule or guidance. Body = verbatim rule text. |

## Facts (structured, queryable)

| Element | Attributes | When |
|---|---|---|
| \`<bv-fact subject="snake_case_subject" category="..." value="extracted-form" disclosure="public">\` | \`subject\`, \`category\`, \`value\`, \`disclosure\` | One discrete fact per element. \`category\` ∈ {\`convention\`, \`preference\`, \`project\`, \`environment\`, \`team\`, \`personal\`, \`other\`}. Body = canonical natural-language statement (NOT a label — the statement itself). Omit \`disclosure\` unless the fact is safe to share publicly; omission defaults to restricted. |

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

## Regex patterns

| Element | Attributes | When |
|---|---|---|
| \`<bv-pattern description="..." flags="...">\` | \`description\`, \`flags\` | Regex patterns only. Body = the regex literal. For workflow/design patterns, use \`<bv-structure>\` or \`<bv-examples>\`. |

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
   \`<bv-flow>\`, \`<bv-structure>\`, \`<bv-dependencies>\`, \`<bv-highlights>\`.

A rich topic containing ONLY \`<bv-fact>\` siblings is a placeholder, not a
topic. Same goes for ONLY \`<bv-highlights><li>...</li></bv-highlights>\` —
that's flat, not structured.

# <bv-topic> attributes

## Required
- \`path\` — slash-separated snake_case (e.g. \`security/auth\`). NO \`.html\`.
  Must match the \`path\` argument passed to \`brv_record\`.
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

- Exact rules → \`<bv-rule severity="must|should|info">\` verbatim.
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
<bv-structure><h3>Architecture families</h3><ul><li>Transformer (attention-based)</li><li>Diffusion (denoising)</li><li>GAN (generator + discriminator)</li><li>Neuromorphic (spiking neural networks)</li></ul><h3>Feedback-tuning workflow</h3><p>RLHF pairs a base model with a reward model trained from human preferences, then fine-tunes the base via PPO or DPO.</p></bv-structure>
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

If \`brv_record\` reports a topic already exists at "<path>":

1. Use the existing topic's content — it's often already in the retrieved
   context block above.
2. MERGE: preserve every prior \`<bv-rule>\`, \`<bv-fact>\`, \`<bv-decision>\`,
   \`<bv-bug>\`, \`<bv-fix>\`. Enrich, never shrink. Add your new facts
   alongside.
3. Call \`brv_record\` again with the same \`path\`, the merged \`html\`, and
   \`overwrite: true\`. If the result warns \`structural-loss\`, you dropped
   element types — add them back and retry.

# After-curate behavior

When \`brv_record\` succeeds, briefly mention to the user that you saved the
knowledge (e.g. "Saved to byterover at \`security/auth\`."). Do NOT dump the
full HTML back at them — the saved path is enough.

If \`brv_record\` fails, surface the error message to the user plainly. Do
not silently retry more than once.
</byterover-curate-guidance>`;
}
