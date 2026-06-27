export const meta = {
  name: 'verify-audit',
  description: 'Per-question NotebookLM audit judge — fan out one agent per question, each judges its own notes-derived answer against an inline oracle answer at a threshold; reduce to a pass-rate + audited verdict + weak-topic clusters',
  phases: [
    { title: 'Judge', detail: 'one agent per question scores its notes-answer vs the inline oracle answer at the threshold' },
  ],
}

// ─── args (passed by the SKILL via the Workflow tool) ─────────────────────────
// { items:[{qid,question,topic,oracleAnswer,noteScope}], bookPath, threshold }
//
// Architecture (issue #320, Option A): the NotebookLM oracle batch runs SEQUENTIALLY
// in the SKILL/Bash layer (rate-limited, run_validation.py), OUTSIDE this fan-out.
// Each item arrives with its OWN oracle answer inline — no worker ever reads
// oracle.jsonl off disk, so no other question's oracle answer or topic notes can
// leak into its context. The Workflow runtime has no fs/subprocess; only the
// per-question judge + the pure-JS reduce run here.
//
// threshold is a PARAMETER so the same runner serves verify (95) and self-learn (90).
//
// Tolerate args arriving as either a parsed object or a JSON string (the tool-call
// layer sometimes stringifies object args — parse defensively, matching house style).
let A = args
if (typeof A === 'string') {
  try { A = JSON.parse(A) } catch (e) { A = {} }
}
A = A || {}
const ITEMS = Array.isArray(A.items) ? A.items : []
const BOOK_PATH = A.bookPath || ''
const THRESHOLD = typeof A.threshold === 'number' ? A.threshold : 95

if (!ITEMS.length) throw new Error('verify.workflow: args.items is required (non-empty array)')
if (!BOOK_PATH) throw new Error('verify.workflow: args.bookPath is required')

// ─── per-question judge schema (minimal — keeps worker output out of main ctx) ─
const JUDGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    qid: { type: 'string', description: 'the question id, echoed back verbatim' },
    score: { type: 'number', description: '0..100 semantic-equivalence score of the NOTES-derived answer vs the oracle answer' },
    pass: { type: 'boolean', description: 'self-assessed score >= threshold (advisory; the reduce re-derives the authoritative gate from score)' },
    gap: { type: 'string', description: 'one line naming what the notes omit or get wrong vs the oracle; empty string if fully covered' },
  },
  required: ['qid', 'score', 'pass', 'gap'],
}

const ROLE = `You are one judge in VERIFY — an independent audit of book notes against a NotebookLM oracle. You see exactly ONE question, the note scope that should answer it, and the oracle's answer to that one question. You do NOT see any other question or any other oracle answer. Score how well the NOTES (not your own world knowledge) answer the question relative to the oracle.`

function judgePrompt(item) {
  const scope = Array.isArray(item.noteScope) ? item.noteScope : (item.noteScope ? [item.noteScope] : [])
  const scopeList = scope.length
    ? scope.map((s) => `  - ${s}`).join('\n')
    : '  (no narrower scope given — read only the notes plausibly about this question, not the whole book)'
  return `${ROLE}

QUESTION (qid=${item.qid}, topic=${item.topic || 'n/a'}):
${item.question}

BOOK NOTES ROOT: ${BOOK_PATH}
NOTE SCOPE — read ONLY these notes (slugs/paths relative to the book root). Do not read outside this scope:
${scopeList}

ORACLE ANSWER (source-of-truth from the full book; the ONLY oracle you may use):
"""
${item.oracleAnswer || '(no oracle answer provided)'}
"""

Do:
1. Read ONLY the scoped notes under the book root and form the answer they support.
2. Compare that notes-answer to the ORACLE ANSWER for semantic equivalence — same concepts, names, numbers, distinctions. Judge the NOTES, not your prior knowledge.
3. score = 0..100. The pass threshold is ${THRESHOLD}: set pass = (score >= ${THRESHOLD}).
4. gap = one line naming what the notes omit or get wrong vs the oracle; empty string if the notes fully cover it.

Echo qid="${item.qid}". Return ONLY the structured object.`
}

// ─── Phase: JUDGE (one agent per question — the fan-out) ──────────────────────
phase('Judge')
log(`Judging ${ITEMS.length} questions at threshold ${THRESHOLD} (1 agent/question)`)

const judged = await parallel(
  ITEMS.map((item) => () =>
    agent(judgePrompt(item), { label: `judge:${item.qid}`, phase: 'Judge', schema: JUDGE_SCHEMA })
      .then((j) => (j
        ? { qid: String(j.qid || item.qid), score: Number(j.score), gap: j.gap || '', topic: item.topic || '' }
        : null)),
  ),
)

// ─── Reduce (pure JS): pass-rate, weak clusters, audited gate ─────────────────
const ok = judged.filter(Boolean)
// Authoritative gate is score >= threshold (NOT the worker's advisory `pass`),
// so passRate / audited / perQuestion.pass can never disagree with each other.
const perQuestion = ok.map((p) => ({ qid: p.qid, score: p.score, pass: p.score >= THRESHOLD, gap: p.gap }))
const passing = perQuestion.filter((p) => p.pass).length
const passRate = ITEMS.length ? passing / ITEMS.length : 0
// audited ONLY when EVERY question was judged AND every score met the threshold.
// A judge that died (null) leaves ok.length < ITEMS.length → cannot be audited.
const audited = ok.length === ITEMS.length && perQuestion.every((p) => p.score >= THRESHOLD)

// Cluster failures by topic so the SKILL's inbox report can name weak areas.
const clusters = {}
ok.forEach((p) => {
  if (p.score >= THRESHOLD) return
  const topic = p.topic || 'uncategorized'
  if (!clusters[topic]) clusters[topic] = { topic, failCount: 0, qids: [] }
  clusters[topic].failCount += 1
  clusters[topic].qids.push(p.qid)
})
const weakClusters = Object.values(clusters).sort((a, b) => b.failCount - a.failCount)

log(`Audit: ${passing}/${ITEMS.length} ≥${THRESHOLD} · audited=${audited} · ${weakClusters.length} weak topic(s)`)

return { passRate, audited, perQuestion, weakClusters }
