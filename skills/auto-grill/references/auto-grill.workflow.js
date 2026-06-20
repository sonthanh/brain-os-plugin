export const meta = {
  name: 'auto-grill',
  description: 'Autonomously grill a topic — decompose decisions, self-answer each from vault/web/code with citations, adversarially verify grounding, surface only genuine gaps',
  phases: [
    { title: 'Decompose', detail: 'partition the topic into ARCH/PARAM decisions' },
    { title: 'Auto-answer', detail: 'one agent per decision searches vault/code/web' },
    { title: 'Verify-grounding', detail: 'skeptic re-reads each citation; ungrounded → gap' },
    { title: 'Synthesize', detail: 'split resolved vs gaps, render grill-session markdown' },
  ],
}

// ─── args (passed by the SKILL via the Workflow tool) ───────────────────────
// { topic, context, vaultPath, taskRepo, date, unattended }
// Tolerate args arriving as either a parsed object or a JSON string (the
// tool-call layer sometimes stringifies object args — parse defensively).
let A = args
if (typeof A === 'string') {
  try { A = JSON.parse(A) } catch (e) { A = {} }
}
A = A || {}
const TOPIC = A.topic || ''
const CONTEXT = A.context || ''
const VAULT = A.vaultPath || '/Users/thanhdo/work/brain'
const TASK_REPO = A.taskRepo || 'sonthanh/ai-brain'
const DATE = A.date || 'UNDATED'
const UNATTENDED = !!A.unattended

if (!TOPIC) throw new Error('auto-grill: args.topic is required')

// ─── schemas ────────────────────────────────────────────────────────────────
const DECOMPOSITION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    framing: { type: 'string', description: 'One-paragraph framing of the real problem behind the topic.' },
    sharedAxis: { type: 'string', description: 'The framing assumption candidate solutions would silently share (the axis a challenger tree would negate). Empty if not an architecture topic.' },
    storyTier: { type: 'boolean', description: 'true if locked decisions imply implementation work (code/files/scripts); false if purely analytical.' },
    decisions: {
      type: 'array',
      description: 'Every decision the topic implies. ARCH = branches the design; PARAM = single value pick.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', description: 'short stable id, e.g. D1' },
          question: { type: 'string' },
          type: { type: 'string', enum: ['ARCH', 'PARAM'] },
          why: { type: 'string', description: 'why this decision matters / what depends on it' },
        },
        required: ['id', 'question', 'type', 'why'],
      },
    },
  },
  required: ['framing', 'sharedAxis', 'storyTier', 'decisions'],
}

const ANSWER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    decisionId: { type: 'string' },
    recommendation: { type: 'string', description: 'The SINGLE best-practice answer. Grill discipline: recommend one pick, do not enumerate options as the answer.' },
    rationale: { type: 'string' },
    citations: {
      type: 'array',
      description: 'Evidence backing the recommendation. Empty array if nothing was found.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          source: { type: 'string', enum: ['vault', 'code', 'web'] },
          path: { type: 'string', description: 'absolute file path or URL actually read' },
          lines: { type: 'string', description: 'line range e.g. "12-18", empty for web' },
          quote: { type: 'string', description: 'verbatim text from the source that supports the recommendation' },
        },
        required: ['source', 'path', 'quote'],
      },
    },
    searchedButNotFound: { type: 'boolean', description: 'true if you searched vault + code (+ web) and found NO grounding evidence — the recommendation is then your prior, not evidence.' },
    confidence: { type: 'number', description: '0..1 self-rated confidence in the recommendation' },
  },
  required: ['decisionId', 'recommendation', 'rationale', 'citations', 'searchedButNotFound', 'confidence'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    decisionId: { type: 'string' },
    grounded: { type: 'boolean', description: 'true ONLY if you re-read at least one citation and it verifiably supports the recommendation. Default false when uncertain.' },
    verifiedCitations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          quoteFound: { type: 'boolean', description: 'did the verbatim quote actually exist at that path?' },
          supports: { type: 'boolean', description: 'does it genuinely support the recommendation (not tangential)?' },
          note: { type: 'string' },
        },
        required: ['path', 'quoteFound', 'supports'],
      },
    },
    reason: { type: 'string', description: 'one-line verdict rationale' },
    surfacedQuestion: { type: 'string', description: 'if NOT grounded, the precise question to put to the human. Empty if grounded.' },
  },
  required: ['decisionId', 'grounded', 'verifiedCitations', 'reason', 'surfacedQuestion'],
}

const SYNTHESIS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    markdown: { type: 'string', description: 'The full grill-session markdown body (no frontmatter — the caller adds it).' },
    gapQuestions: {
      type: 'array',
      description: 'The genuine gaps to put to the human (or file as issues in unattended mode). One per ungrounded decision plus any new gap synthesis surfaced.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          question: { type: 'string' },
          why: { type: 'string' },
          options: { type: 'array', items: { type: 'string' }, description: 'optional 2-4 candidate answers to offer the human' },
        },
        required: ['id', 'question', 'why'],
      },
    },
    recommendation: { type: 'string', description: 'one-line overall recommendation / next step' },
  },
  required: ['markdown', 'gapQuestions', 'recommendation'],
}

// ─── prompt builders ─────────────────────────────────────────────────────────
const ROLE = `You are one stage of AUTO-GRILL — a Workflow that grills a topic the way a relentless human interviewer would, except it answers its own questions from evidence and only escalates what evidence genuinely cannot settle. Discipline inherited from /grill and /grill-fast: research before asking, recommend ONE best pick per decision (never enumerate options as the answer), converge on decisions not phrasing.`

function decomposePrompt() {
  return `${ROLE}

STAGE 1 — DECOMPOSE. Partition the topic into the decisions it implies.

TOPIC: ${TOPIC}

CONTEXT (may be empty):
${CONTEXT || '(none provided)'}

VAULT ROOT: ${VAULT}  (you may grep/read it for light orientation — start at ${VAULT}/RESOLVER.md)

Do:
1. State the real problem behind the topic in one paragraph (framing) — the atomic unit of meaning before any external solution.
2. List EVERY decision the topic implies. Tag each ARCH (branches the design / changes the diagram) or PARAM (a single value pick). Give a stable id (D1, D2, …) and why it matters.
3. Name the shared framing axis: the assumption that candidate solutions would silently agree on (what a challenger would negate). Empty string if this is not an architecture/design topic.
4. Set storyTier=true if the locked decisions would imply implementation work (code, files, scripts, infra); false if purely analytical.

Return ONLY the structured object. Do not answer the decisions — that is the next stage's job.`
}

function autoAnswerPrompt(d) {
  return `${ROLE}

STAGE 2 — AUTO-ANSWER one decision. This is the autogrill core: SELF-ANSWER from evidence so the human is never asked what the vault already knows.

DECISION ${d.id} (${d.type}): ${d.question}
WHY IT MATTERS: ${d.why}
TOPIC: ${TOPIC}
VAULT ROOT: ${VAULT}

Search order (stop as soon as you have solid grounding):
1. VAULT — start at ${VAULT}/RESOLVER.md, then the relevant zone README, then grep/read specific files. Past grill-sessions (${VAULT}/daily/grill-sessions/), research reports (${VAULT}/knowledge/research/reports/), thinking/aha, and CLAUDE.md files are high-value.
2. CODE — grep the plugin/repo sources for the mechanism if the decision is about how something is built.
3. WEB — ONLY if vault + code have nothing. (You have web tools via ToolSearch.)

Then:
- Give the SINGLE best-practice recommendation for this decision (one pick, with rationale). Grill discipline: do not punt with "it depends" or a menu — commit to the best answer the evidence supports.
- For every vault/code claim, cite the exact path + line range + a VERBATIM quote you actually read. A recommendation with no citation must set searchedButNotFound=true.
- If after searching there is genuinely no grounding evidence, set searchedButNotFound=true and lower confidence — your recommendation is then a prior the human must confirm. Do NOT fabricate a citation to look grounded; the next stage re-reads every citation and will catch it.

Return ONLY the structured object.`
}

function verifyPrompt(d, ans) {
  const cites = (ans && ans.citations) || []
  return `${ROLE}

STAGE 3 — VERIFY GROUNDING (adversarial). You are a skeptic. Your job is to decide whether the recommendation is backed by REAL evidence or is the model's prior dressed up as fact. Default to NOT grounded when uncertain — a falsely-grounded answer silently buries a real gap, which is the worst failure of this system.

DECISION ${d.id}: ${d.question}
RECOMMENDATION: ${ans ? ans.recommendation : '(none)'}
searchedButNotFound (self-reported): ${ans ? ans.searchedButNotFound : 'n/a'}

CITATIONS TO CHECK (${cites.length}):
${cites.length ? cites.map((c, i) => `  [${i + 1}] ${c.source} ${c.path} ${c.lines || ''}\n      quote: "${(c.quote || '').slice(0, 240)}"`).join('\n') : '  (none provided)'}

Do:
1. For EACH citation: actually open the cited path (Read at the cited lines; for web, fetch). Confirm (a) the verbatim quote really exists there, and (b) it genuinely supports the recommendation — not merely adjacent to the topic.
2. grounded = true ONLY if at least one citation passes BOTH checks. If citations array is empty or every quote fails, grounded = false.
3. If grounded = false, write surfacedQuestion: the precise, decision-ready question to put to the human (concrete options if you can name them).

Return ONLY the structured object.`
}

function synthesizePrompt(decomp, resolved, gaps) {
  const resolvedBlock = resolved.map((r) => {
    const cites = (r.answer.citations || []).map((c) => `${c.path} ${c.lines || ''}`).join('; ')
    return `- ${r.decision.id} (${r.decision.type}): ${r.decision.question}\n  PICK: ${r.answer.recommendation}\n  EVIDENCE: ${cites}`
  }).join('\n')
  const gapBlock = gaps.map((g) => `- ${g.decision.id} (${g.decision.type}): ${g.decision.question}\n  ASK: ${g.verdict.surfacedQuestion || g.decision.question}\n  REASON: ${g.verdict.reason}`).join('\n')
  return `${ROLE}

STAGE 4 — SYNTHESIZE the grill-session document.

TOPIC: ${TOPIC}
FRAMING: ${decomp.framing}
SHARED FRAMING AXIS: ${decomp.sharedAxis || '(n/a)'}
STORY-TIER: ${decomp.storyTier}
DATE: ${DATE}
MODE: ${UNATTENDED ? 'UNATTENDED (gaps will be filed as issues, no human in the loop)' : 'INTERACTIVE (gaps will be put to the human)'}

RESOLVED FROM EVIDENCE (${resolved.length}):
${resolvedBlock || '(none)'}

GENUINE GAPS — evidence could not settle these (${gaps.length}):
${gapBlock || '(none)'}

Produce the grill-session markdown BODY (no YAML frontmatter — the caller adds it). Required sections:
- '# Frame' — the framing + the shared axis (named explicitly so it can be audited).
- '# Resolved from evidence' — a table or list of every resolved decision with its PICK and a clickable file:line citation. This is what auto-grill settled WITHOUT the human.
- '# Open gaps — needs human' — every gap as a decision-ready question with concrete options. If UNATTENDED, note these become issues on ${TASK_REPO}.
- If storyTier AND ≥3 ARCH decisions exist: add '# Candidate architectures' with ≥4 ASCII decision trees (3 axis-aligned + 1 that negates the shared framing axis), each with inline Pros/Cons — the /grill-fast discipline. Otherwise omit this section.
- '# Recommended pick' — one overall recommendation / next step.
- '# Grounding metric' — "Resolved X/Y decisions from vault evidence; surfaced Z gaps." Use the real counts above.

Also return gapQuestions (the human-facing questions, one per gap, with options if nameable) and a one-line recommendation.

Grill discipline reminders: recommend ONE pick per resolved decision; never micro-edit phrasing; every evidence claim must carry a citation that exists. Return ONLY the structured object.`
}

// ─── Phase 1: DECOMPOSE ──────────────────────────────────────────────────────
phase('Decompose')
const decomposition = await agent(decomposePrompt(), { label: 'decompose', schema: DECOMPOSITION_SCHEMA })
const decisions = (decomposition && decomposition.decisions) || []
if (!decisions.length) {
  return { topic: TOPIC, error: 'decomposition produced no decisions', decomposition }
}
const archN = decisions.filter((d) => d.type === 'ARCH').length
log(`Decomposed → ${decisions.length} decisions (${archN} ARCH / ${decisions.length - archN} PARAM)`)

// ─── Phase 2+3: AUTO-ANSWER → VERIFY-GROUNDING (pipeline, no barrier) ─────────
const answered = await pipeline(
  decisions,
  (d) => agent(autoAnswerPrompt(d), { label: `answer:${d.id}`, phase: 'Auto-answer', schema: ANSWER_SCHEMA }),
  (ans, d) => agent(verifyPrompt(d, ans), { label: `verify:${d.id}`, phase: 'Verify-grounding', schema: VERDICT_SCHEMA })
    .then((v) => ({ decision: d, answer: ans, verdict: v })),
)

const ok = answered.filter(Boolean)
const resolved = ok.filter((a) => a.verdict && a.verdict.grounded)
const gaps = ok.filter((a) => !a.verdict || !a.verdict.grounded)
log(`Grounding gate → ${resolved.length}/${ok.length} resolved from evidence · ${gaps.length} surfaced as genuine gaps`)

// ─── Phase 4: SYNTHESIZE ─────────────────────────────────────────────────────
phase('Synthesize')
const synthesis = await agent(synthesizePrompt(decomposition, resolved, gaps), { label: 'synthesize', schema: SYNTHESIS_SCHEMA })

return {
  topic: TOPIC,
  date: DATE,
  unattended: UNATTENDED,
  storyTier: !!(decomposition && decomposition.storyTier),
  metric: { total: ok.length, resolved: resolved.length, gaps: gaps.length },
  framing: decomposition.framing,
  sharedAxis: decomposition.sharedAxis,
  resolved: resolved.map((r) => ({
    id: r.decision.id,
    type: r.decision.type,
    question: r.decision.question,
    pick: r.answer.recommendation,
    citations: r.answer.citations,
    verifiedCitations: r.verdict.verifiedCitations,
  })),
  gaps: gaps.map((g) => ({
    id: g.decision.id,
    type: g.decision.type,
    question: g.decision.question,
    surfacedQuestion: g.verdict ? g.verdict.surfacedQuestion : g.decision.question,
    reason: g.verdict ? g.verdict.reason : 'verify stage failed',
  })),
  markdown: synthesis.markdown,
  gapQuestions: synthesis.gapQuestions,
  recommendation: synthesis.recommendation,
}
