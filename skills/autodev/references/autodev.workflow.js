export const meta = {
  name: 'autodev',
  description:
    'Ultimate autonomous goal→proof loop: auto-grill a fuzzy goal (decompose → self-answer → verify-grounding) → escalate ungrounded gaps as HITL → slice grounded decisions into a parent PRD + tracer-bullet children → implement each (TDD) with an evaluator regenerate-loop → render a per-AC PROOF report. All agents Opus. --dry-run files/edits nothing.',
  phases: [
    { title: 'Grill', detail: 'decompose goal → self-answer from vault/code/web → verify grounding' },
    { title: 'Slice', detail: 'synthesize PRD + tracer-bullet children (rung-0 first, AC coverage gate)' },
    { title: 'Implement', detail: 'per child: branch + TDD red-green' },
    { title: 'Evaluate', detail: 'verify vs child AC → regenerate on fail (K iters) → land or escalate' },
    { title: 'Report', detail: 'proof-report.ts renders per-AC proof from the run results + outcome log' },
  ],
}

// ── args (passed by the SKILL via the Workflow tool; tolerate stringified) ───
let A = args
if (typeof A === 'string') { try { A = JSON.parse(A) } catch (e) { A = {} } }
A = A || {}
const GOAL = A.goal || ''
const CONTEXT = A.context || ''
const VAULT = A.vaultPath || '/Users/thanhdo/work/brain'
const TASK_REPO = A.taskRepo || 'sonthanh/ai-brain'
const DATE = A.date || 'UNDATED'
const DRY = !!A.dryRun
const MAX_CHILDREN = A.maxChildren || 5
const MODEL = 'opus' // user directive: Opus everywhere for autonomous loops
const PLUGIN_ROOT = A.pluginRoot || '' // absolute path to brain-os-plugin (SKILL resolves CLAUDE_PLUGIN_ROOT)
const AREA = A.area || 'plugin-brain-os'
const AREA_REPO = A.areaRepoPath || '~/work/brain-os-plugin' // cwd for implementation edits
const DESIGN_REF = A.designRef || '' // e.g. daily/grill-sessions/<file>.md
const BUDGET_FLOOR = 60000

if (!GOAL) throw new Error('autodev: args.goal is required')

const RULES = `Rules: edit ONLY source repos (never ~/.claude/plugins/ installed copies). TS+bun for any new script (+ a .test.ts). Match existing file style. Surgical edits only. Never remove protected SKILL.md scaffold lines (frontmatter, "## Usage", "## Outcome log").`

// ── schemas ─────────────────────────────────────────────────────────────────
// GRILL schemas adapted from skills/auto-grill/references/auto-grill.workflow.js
// (kept lean — autodev only needs grounded decisions + gaps, not the synthesized
// grill markdown). Keep the grounding discipline byte-faithful; re-sync via /improve
// if auto-grill's grounding prompts evolve.
const DECOMPOSITION_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['framing', 'storyTier', 'decisions'],
  properties: {
    framing: { type: 'string' },
    storyTier: { type: 'boolean', description: 'true if locked decisions imply implementation work (code/files/scripts); false if purely analytical.' },
    decisions: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['id', 'question', 'type', 'why'],
        properties: {
          id: { type: 'string' }, question: { type: 'string' },
          type: { type: 'string', enum: ['ARCH', 'PARAM'] }, why: { type: 'string' },
        },
      },
    },
  },
}
const ANSWER_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['decisionId', 'recommendation', 'rationale', 'citations', 'searchedButNotFound', 'confidence'],
  properties: {
    decisionId: { type: 'string' }, recommendation: { type: 'string' }, rationale: { type: 'string' },
    citations: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['source', 'path', 'quote'],
      properties: { source: { type: 'string', enum: ['vault', 'code', 'web'] }, path: { type: 'string' }, lines: { type: 'string' }, quote: { type: 'string' } } } },
    searchedButNotFound: { type: 'boolean' }, confidence: { type: 'number' },
  },
}
const VERDICT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['decisionId', 'grounded', 'reason', 'surfacedQuestion'],
  properties: {
    decisionId: { type: 'string' },
    grounded: { type: 'boolean', description: 'true ONLY if a re-read citation verifiably supports the recommendation. Default false when uncertain.' },
    reason: { type: 'string' }, surfacedQuestion: { type: 'string' },
  },
}
const SLICE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['parent', 'children'],
  properties: {
    parent: {
      type: 'object', additionalProperties: false,
      required: ['title', 'body', 'acIds', 'liveE2eAcIds'],
      properties: {
        title: { type: 'string', description: 'imperative story title, e.g. "Story: <what it delivers>"' },
        body: { type: 'string', description: 'full parent PRD markdown: ## User Story, ## Settled Decisions, ## Sub-issues (placeholder), ## Acceptance (bullet AC, ≥1 carrying the literal token (LIVE E2E)), ## Out of Scope, ## Open questions' },
        acIds: { type: 'array', items: { type: 'number' }, description: 'every AC#N integer present in ## Acceptance' },
        liveE2eAcIds: { type: 'array', items: { type: 'number' }, description: 'the AC#N integers whose bullet carries (LIVE E2E)' },
      },
    },
    children: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['title', 'coversAc', 'rung0', 'body'],
        properties: {
          title: { type: 'string' },
          coversAc: { type: 'array', items: { type: 'number' }, description: 'parent AC#N ids this child satisfies; empty = pure-component' },
          rung0: { type: 'boolean', description: 'true for the single child covering the live-e2e AC — ships first, all siblings blocked by it' },
          body: { type: 'string', description: 'child issue body: ## Parent, ## What to build, ## Acceptance, ## Covers AC (one "- AC#N" per id), ## Files, ## Observable, ## Blocked by' },
          weight: { type: 'string', enum: ['quick', 'heavy'] },
        },
      },
    },
  },
}
const FILED_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['parent', 'children'],
  properties: {
    parent: { type: 'object', additionalProperties: false, required: ['number', 'url'], properties: { number: { type: ['number', 'string'] }, url: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } } },
    children: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['number', 'coversAc'], properties: { number: { type: ['number', 'string'] }, url: { type: 'string' }, title: { type: 'string' }, coversAc: { type: 'array', items: { type: 'number' } }, rung0: { type: 'boolean' } } } },
  },
}
const IMPL_SCHEMA = { type: 'object', additionalProperties: false, required: ['summary'], properties: { summary: { type: 'string' }, filesChanged: { type: 'array', items: { type: 'string' } }, commit: { type: 'string' } } }
const EVAL_SCHEMA = { type: 'object', additionalProperties: false, required: ['pass', 'errors'], properties: { pass: { type: 'boolean' }, errors: { type: 'array', items: { type: 'string' } }, testSummary: { type: 'string' }, commit: { type: 'string' } } }

// ── prompt builders ───────────────────────────────────────────────────────
const GRILL_ROLE = `You are the GRILL stage of /autodev — autonomous grilling inherited from /auto-grill: research before asking, recommend ONE best pick per decision (never enumerate options), converge on decisions not phrasing. You answer your own questions from evidence and only surface what evidence cannot settle.`

const decomposePrompt = () => `${GRILL_ROLE}

DECOMPOSE the goal into the decisions it implies.
GOAL: ${GOAL}
CONTEXT: ${CONTEXT || '(none)'}
VAULT ROOT: ${VAULT} (start at ${VAULT}/RESOLVER.md for light orientation)

1. State the real problem in one paragraph (framing).
2. List EVERY decision the goal implies. Tag ARCH (branches the design) or PARAM (single value). id D1,D2,…; why it matters.
3. storyTier=true if locked decisions imply implementation work (code/files/scripts); false if purely analytical.
Return ONLY the structured object. Do not answer the decisions yet.`

const autoAnswerPrompt = (d) => `${GRILL_ROLE}

AUTO-ANSWER one decision from evidence so the human is never asked what the vault/code already knows.
DECISION ${d.id} (${d.type}): ${d.question}
WHY: ${d.why}
GOAL: ${GOAL}
VAULT ROOT: ${VAULT}

Search order (stop when solidly grounded): 1) VAULT (${VAULT}/RESOLVER.md → zone READMEs → grep/read; past grills, research, thinking/aha, CLAUDE.md are high-value). 2) CODE (grep the repo sources). 3) WEB only if vault+code have nothing.
Give the SINGLE best recommendation with rationale. Cite every vault/code claim: exact path + line range + a VERBATIM quote you actually read. No citation → set searchedButNotFound=true (your recommendation is then a prior). Do NOT fabricate citations — the next stage re-reads them. Return ONLY the structured object.`

const verifyPrompt = (d, ans) => `${GRILL_ROLE}

VERIFY GROUNDING (adversarial skeptic). Decide if the recommendation is backed by REAL evidence or the model's prior dressed up as fact. Default NOT grounded when uncertain — a falsely-grounded answer silently buries a real gap.
DECISION ${d.id}: ${d.question}
RECOMMENDATION: ${ans ? ans.recommendation : '(none)'}
CITATIONS: ${ans && ans.citations && ans.citations.length ? JSON.stringify(ans.citations.map((c) => ({ path: c.path, lines: c.lines, quote: (c.quote || '').slice(0, 200) }))) : '(none)'}

For EACH citation: actually open the cited path at the cited lines (Read; web → fetch). Confirm the quote exists AND genuinely supports the recommendation. grounded=true ONLY if ≥1 citation passes both. If not grounded, write surfacedQuestion (the precise decision-ready question for the human). Return ONLY the structured object.`

const slicePrompt = (decomp, resolved) => `You are the SLICE stage of /autodev. Convert the GROUNDED decisions into a parent PRD + tracer-bullet child issues, following skills/slice/SKILL.md discipline EXACTLY.
GOAL: ${GOAL}
FRAMING: ${decomp.framing}
GROUNDED DECISIONS (use ONLY these — ungrounded gaps were escalated to humans, do NOT invent answers for them):
${resolved.map((r) => `- ${r.decision.id} (${r.decision.type}): ${r.decision.question}\n  PICK: ${r.answer.recommendation}`).join('\n')}

Produce:
1. PARENT PRD body with sections: ## User Story · ## Settled Decisions (from the picks above) · ## Sub-issues (placeholder "- [ ] TBD") · ## Acceptance · ## Out of Scope · ## Open questions (empty for AFK children).
   - ## Acceptance MUST use bullet-AC form: "- [ ] **AC#1** — <criterion>" (em-dash U+2014). At LEAST ONE AC bullet MUST carry the literal token (LIVE E2E) at end of line — the smallest end-to-end check that empirically proves the abstraction. Set acIds + liveE2eAcIds to match the body exactly.
2. 2–${MAX_CHILDREN} tracer-bullet CHILDREN (thin vertical slices, each demoable). Each child body: ## Parent · ## What to build · ## Acceptance · ## Covers AC (one "- AC#N" line per parent AC it satisfies; empty section for pure-component children) · ## Files · ## Observable (a user-visible surface — HARD requirement) · ## Blocked by.
   - COVERAGE: every parent AC#N MUST appear in some child's ## Covers AC. The child covering the (LIVE E2E) AC has rung0=true and ships first; mark all other children "## Blocked by - <rung-0>".
${RULES}
Return ONLY the structured object.`

const filePrompt = (slice, rung0Title) => `FILE the /autodev story to ${TASK_REPO} via the central filer, following skills/slice/SKILL.md Steps 2.4 + 6 + 7. PLUGIN_ROOT=${PLUGIN_ROOT}.
CRITICAL: file the EXACT bodies below VERBATIM. They already passed the deterministic AC-coverage + (LIVE E2E) gates — do NOT re-synthesize, rewrite, or "improve" them, or you ship content the gates never validated. Write each body to a temp file and pass it with --body-file to preserve backticks/newlines.
1. File the PARENT (title "${slice.parent.title}"): bash "${PLUGIN_ROOT}/scripts/gh-tasks/create-task-issue.sh" --title "<title>" --body-file <parent-body-tmpfile> --area "${AREA}" --owner human --priority p2 --weight heavy --status ready --type plan ; then bash "${PLUGIN_ROOT}/scripts/gh-tasks/transition-status.sh" <parent-N> --to in-progress. Capture parent number + node id.
2. File CHILDREN topologically — RUNG-0 FIRST ("${rung0Title}"), then siblings (each child's "## Blocked by" must reference the rung-0 number). create-task-issue.sh --owner bot --status ready (rung-0) / --status blocked (siblings) --area "${AREA}", --body-file per child. After each, addSubIssue GraphQL link to the parent.
3. Edit the parent's ## Sub-issues to list the real child numbers.
PARENT BODY (verbatim): ${JSON.stringify(slice.parent.body)}
CHILDREN (file in this order; body verbatim): ${JSON.stringify((slice.children || []).map((c) => ({ title: c.title, coversAc: c.coversAc, rung0: c.rung0, weight: c.weight, body: c.body })))}
Return {parent:{number,url,title,body}, children:[{number,url,title,coversAc,rung0}]} — body = the verbatim parent body you filed.`

const implementPrompt = (c, branch) => `Implement /autodev child #${c.number} ("${c.title}") in repo ${AREA_REPO} on branch ${branch}.
1. git -C ${AREA_REPO} checkout main && git -C ${AREA_REPO} checkout -b ${branch} (checkout if exists).
2. Read the child issue body / acceptance: ${JSON.stringify(c.body ? c.body.slice(0, 1200) : c.title)}.
3. /tdd discipline: red-green per artifact type — failing test FIRST for code, then minimal code; surgical edit for SKILL.md/doc. One behavior at a time.
4. git add -A && git commit on ${branch} (do NOT push). Conventional message referencing #${c.number}. Capture the short SHA.
${RULES}
Return {summary, filesChanged, commit}.`

const fixPrompt = (c, branch, errors) => `Evaluator REJECTED /autodev child #${c.number} on branch ${branch} in ${AREA_REPO}. Fix every failing check, re-run the failing commands locally to confirm, then commit on the SAME branch. Do NOT broaden scope.
Errors: ${JSON.stringify(errors)}
${RULES} Return {summary, filesChanged, commit}.`

const evaluatePrompt = (c, branch) => `Independent EVALUATOR for /autodev child #${c.number}, branch ${branch}, repo ${AREA_REPO}. You did NOT write this code — be adversarial. PASS only if ALL hold:
1. Every acceptance criterion in the child body actually holds — RUN the verifying command (bun test / grep / file inspection). For live-AC bullets (## Covers AC intersects a parent (LIVE E2E) AC), a test that MOCKS the live integration the AC demands is a FAIL.
2. bun test (in ${AREA_REPO}, for touched scripts) is green — RUN it.
3. No protected SKILL.md scaffold line removed; no eval count dropped.
4. Smallest viable change, no scope creep beyond #${c.number}.
Child body: ${JSON.stringify(c.body ? c.body.slice(0, 1200) : c.title)}.
Run the real commands. Collect every failure into errors[] (empty iff all pass). Put a one-line "test names + pass/fail counts" into testSummary, and the commit SHA into commit. Return {pass, errors, testSummary, commit}.`

const landPrompt = (c, branch, parentN) => `/autodev child #${c.number} passed evaluation on branch ${branch} in ${AREA_REPO}. Land it: git -C ${AREA_REPO} push -u origin ${branch}; open a PR (gh pr create --base main --head ${branch} --title "[autodev] ${c.title}" --body "Closes ${TASK_REPO}#${c.number}\\n\\n<summary + which AC passed>"). Then post the §3.3 evidence comment on the parent for each covered AC: gh issue comment ${parentN} -R ${TASK_REPO} --body "Acceptance verified: AC#<m> — <test summary; commit SHA>". Finally git -C ${AREA_REPO} checkout main. Return {pr}.`

const escalatePrompt = (c, errors) => `/autodev child #${c.number} FAILED evaluation after max regenerate iterations in ${AREA_REPO}. Do NOT open a green PR. Re-label HITL + leave open: gh issue edit ${c.number} -R ${TASK_REPO} --remove-label owner:bot --add-label owner:human ; bash "${PLUGIN_ROOT}/scripts/gh-tasks/transition-status.sh" ${c.number} --to ready ; gh issue comment ${c.number} -R ${TASK_REPO} --body "autodev auto-impl escalated after K iters. Unresolved: <errors>. Branch left local for inspection." Errors: ${JSON.stringify(errors)}. Then git -C ${AREA_REPO} checkout main. Return a one-line confirmation.`

const gapIssuePrompt = (g) => `File a HITL gap issue to ${TASK_REPO} (escalate-not-break: evidence could not settle this decision, so a human must). bash "${PLUGIN_ROOT}/scripts/gh-tasks/create-task-issue.sh" --title "[autodev gap] ${g.decision.question}" --body "## Why\\n${g.verdict ? g.verdict.reason : ''}\\n\\n## Question\\n${g.verdict ? g.verdict.surfacedQuestion : g.decision.question}\\n\\n## Source goal\\n${GOAL}\\n${DESIGN_REF ? '\\nDesign: ' + DESIGN_REF : ''}" --area "${AREA}" --owner human --priority p2 --weight quick --status ready. Return a one-line confirmation.`

const reportPrompt = (data) => `Render the /autodev PROOF report by SHELLING the deterministic renderer (do NOT hand-write the proof — proof-report.ts is the SSOT).
1. Write this JSON to a temp file (e.g. /tmp/autodev-proof-${DATE}.json):
${JSON.stringify(data.payload)}
2. Run: bun run "${PLUGIN_ROOT}/scripts/proof-report.ts" --build-results <tmpfile> --out "${VAULT}/daily/autodev-reports/${DATE}-${data.slug}.md". The renderer prints the markdown to stdout and writes it to --out; its exit code is 1 on UNPROVEN, 0 otherwise.
3. COMPLETENESS CRITIC: append a "## Completeness critic" section to the report file answering "what did this run miss — a decision left ungrounded, an AC unverified, an escalated child, a gap filed?".
4. Append EXACTLY ONE row to ${VAULT}/daily/skill-outcomes/autodev.log:
   "${DATE} | autodev | ${DRY ? 'dry' : 'run'} | ~/work/brain-os-plugin | daily/autodev-reports/${DATE}-${data.slug}.md | commit:<plugin-HEAD-short or N/A> | <result> | goal=\\"${GOAL.slice(0, 60)}\\" resolved=${data.resolved} gaps=${data.gaps} children=${data.children} implemented=${data.implemented} escalated=${data.escalated} verdict=<PROVEN|PARTIAL|UNPROVEN>"
   result: pass if verdict PROVEN; partial if PARTIAL or any escalated/gaps; fail if UNPROVEN or the run errored.
${DRY ? '5. DRY RUN — do NOT commit/push anything; the report + log row stay local for inspection.' : '5. Commit + push the vault report: git -C "' + VAULT + '" add daily/autodev-reports daily/skill-outcomes/autodev.log && git -C "' + VAULT + '" commit -m "autodev: proof report ' + DATE + '" && git -C "' + VAULT + '" pull --rebase && git -C "' + VAULT + '" push.'}
Return one line: the verdict + the report path.`

// ── evaluator regenerate loop (per child, sequential) ───────────────────────
async function implementWithEvaluator(c, parentN) {
  const K = 3
  const branch = `autodev/issue-${c.number}`
  await agent(implementPrompt(c, branch), { label: `impl:${c.number}`, phase: 'Implement', model: MODEL, schema: IMPL_SCHEMA })
  let errors = [], lastSummary = '', lastCommit = ''
  for (let i = 1; i <= K; i++) {
    const v = await agent(evaluatePrompt(c, branch), { label: `eval:${c.number}#${i}`, phase: 'Evaluate', model: MODEL, schema: EVAL_SCHEMA })
    if (v && v.pass) {
      lastSummary = v.testSummary || 'evaluated GREEN'; lastCommit = v.commit || ''
      const landed = await agent(landPrompt(c, branch, parentN), { label: `land:${c.number}`, phase: 'Evaluate', model: MODEL })
      return { issue: c.number, title: c.title, coversAc: c.coversAc, status: 'pass', testSummary: lastSummary, commit: lastCommit, url: landed && landed.pr }
    }
    errors = (v && v.errors) || ['evaluator returned no verdict']
    if (i === K) break
    log(`#${c.number} eval fail (iter ${i}/${K}) — regenerating`)
    await agent(fixPrompt(c, branch, errors), { label: `fix:${c.number}#${i}`, phase: 'Evaluate', model: MODEL, schema: IMPL_SCHEMA })
  }
  await agent(escalatePrompt(c, errors), { label: `escalate:${c.number}`, phase: 'Evaluate', model: MODEL })
  log(`#${c.number} escalated after ${K} iters`)
  return { issue: c.number, title: c.title, coversAc: c.coversAc, status: 'escalated', errors }
}

const slugify = (s) => (s || 'goal').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)

// ======================= PIPELINE =======================
phase('Grill')
const decomposition = await agent(decomposePrompt(), { label: 'decompose', phase: 'Grill', model: MODEL, schema: DECOMPOSITION_SCHEMA })
const decisions = (decomposition && decomposition.decisions) || []
if (!decisions.length) return { stoppedAfter: 'grill', error: 'decomposition produced no decisions', decomposition }
log(`Grill: ${decisions.length} decisions (${decisions.filter((d) => d.type === 'ARCH').length} ARCH)`)

const answered = await pipeline(
  decisions,
  (d) => agent(autoAnswerPrompt(d), { label: `answer:${d.id}`, phase: 'Grill', model: MODEL, schema: ANSWER_SCHEMA }),
  (ans, d) => agent(verifyPrompt(d, ans), { label: `verify:${d.id}`, phase: 'Grill', model: MODEL, schema: VERDICT_SCHEMA }).then((v) => ({ decision: d, answer: ans, verdict: v })),
)
const ok = answered.filter(Boolean)
const resolved = ok.filter((a) => a.verdict && a.verdict.grounded)
const gaps = ok.filter((a) => !a.verdict || !a.verdict.grounded)
// escalate-not-break: a decision whose auto-answer/verify agent DIED (null entry,
// terminal API error after retries) was never evaluated — it is neither grounded nor
// a surfaced gap. Silently dropping it would build on an incomplete picture. Treat it
// as a gap so it is escalated to a human, never silently lost.
decisions.forEach((d, i) => {
  if (!answered[i]) gaps.push({ decision: d, answer: null, verdict: { grounded: false, reason: 'auto-answer/verify agent failed (no verdict) — escalated to human', surfacedQuestion: d.question } })
})
log(`Grounding gate: ${resolved.length}/${ok.length} grounded · ${gaps.length} gaps (${decisions.length - answered.filter(Boolean).length} died→escalated)`)

// ── SEAM: escalate-not-break ────────────────────────────────────────────────
if (!decomposition.storyTier) {
  log('Reflection-tier goal — no implementation surface. Surfacing decisions only, no slice/impl.')
  return { stoppedAfter: 'grill', reason: 'reflection-tier', resolved: resolved.length, gaps: gaps.length, framing: decomposition.framing }
}
if (!DRY) {
  for (const g of gaps) await agent(gapIssuePrompt(g), { label: `gap:${g.decision.id}`, phase: 'Grill', model: MODEL })
} else if (gaps.length) {
  log(`(dry) would file ${gaps.length} HITL gap issue(s): ${gaps.map((g) => g.decision.id).join(', ')}`)
}
if (resolved.length === 0) {
  log('No grounded decisions — honest no-op. Every decision became a human gap; nothing to build autonomously.')
  return { stoppedAfter: 'grill', reason: 'all-gaps', resolved: 0, gaps: gaps.length }
}

phase('Slice')
const slice = await agent(slicePrompt(decomposition, resolved), { label: 'slice:synth', phase: 'Slice', model: MODEL, schema: SLICE_SCHEMA })
// null-guard: the slice agent can die (terminal API error / session limit) and return
// null. Fail to the report gracefully rather than deref slice.parent.
if (!slice || !slice.parent) {
  log('Slice synthesis returned null (agent died) — cannot build. Stopping before any filing.')
  return { stoppedAfter: 'slice', error: 'slice-synth-failed', resolved: resolved.length, gaps: gaps.length }
}
// deterministic AC-coverage gate (slice/SKILL.md Step 2.5)
const parentAcIds = (slice.parent.acIds || [])
const coveredAc = new Set((slice.children || []).flatMap((c) => c.coversAc || []))
const uncovered = parentAcIds.filter((id) => !coveredAc.has(id))
if (uncovered.length) {
  log(`Slice AC-coverage gate FAILED — uncovered parent AC: ${uncovered.map((n) => 'AC#' + n).join(', ')}`)
  return { stoppedAfter: 'slice', error: 'ac-coverage', uncovered }
}
if (!(slice.parent.liveE2eAcIds || []).length) {
  log('Slice missing a (LIVE E2E) AC — refusing to build an unfalsifiable story.')
  return { stoppedAfter: 'slice', error: 'no-live-e2e-ac' }
}
// rung-0 MUST cover the (LIVE E2E) AC (slice/SKILL.md §4.5) — don't blindly trust the
// LLM-set rung0 flag. Prefer a child that the flag marks AND that actually covers a
// live-e2e AC; fall back to any child covering a live-e2e AC; only then to the flag.
const liveSet = new Set(slice.parent.liveE2eAcIds || [])
const coversLive = (c) => (c.coversAc || []).some((a) => liveSet.has(a))
const kids = slice.children || []
const rung0 =
  kids.find((c) => c.rung0 && coversLive(c)) ||
  kids.find((c) => coversLive(c)) ||
  kids.find((c) => c.rung0) ||
  kids[0]
const ordered = [rung0, ...kids.filter((c) => c !== rung0)]
log(`Slice: parent "${slice.parent.title}" + ${kids.length} children (rung-0: "${rung0 ? rung0.title : '?'}"${rung0 && !coversLive(rung0) ? ' — WARN: rung-0 covers no live-e2e AC' : ''})`)

let parentRef, childRefs
if (DRY) {
  parentRef = { number: 'DRY-parent', url: 'dry-run', title: slice.parent.title, body: slice.parent.body }
  childRefs = ordered.map((c, i) => ({ ...c, number: `DRY-${i + 1}`, url: 'dry-run' }))
} else {
  const filed = await agent(filePrompt(slice, rung0 ? rung0.title : ''), { label: 'slice:file', phase: 'Slice', model: MODEL, schema: FILED_SCHEMA })
  parentRef = { ...filed.parent, body: filed.parent.body || slice.parent.body, title: filed.parent.title || slice.parent.title }
  // attach the synthesized child bodies back onto the filed refs by title match for impl context
  childRefs = (filed.children || []).map((fc) => {
    const spec = ordered.find((c) => c.title === fc.title) || {}
    return { ...spec, ...fc }
  })
}

// Process rung-0 FIRST regardless of the filer's return order — its result gates
// whether siblings are even attempted (slice/SKILL.md §4.5: if the architectural
// anchor fails, don't burn work on a broken foundation; reframe cheaply instead).
childRefs.sort((a, b) => (b.rung0 ? 1 : 0) - (a.rung0 ? 1 : 0))

phase('Implement')
const results = []
for (const c of childRefs) {
  if (DRY) {
    results.push({ issue: c.number, title: c.title, coversAc: c.coversAc || [], status: 'pass(dry)', testSummary: '(dry-run — not implemented)' })
    continue
  }
  if (budget.total && budget.remaining() < BUDGET_FLOOR) { log(`budget floor — deferring remaining ${childRefs.length - results.length} child(ren)`); break }
  const res = await implementWithEvaluator(c, parentRef.number)
  results.push(res)
  // rung-0 escalated → STOP. Siblings are all blocked-by rung-0; building them on a
  // failed architectural anchor is exactly what §4.5 forbids. Leave them ready+OPEN.
  if (c.rung0 && res.status === 'escalated') {
    log(`rung-0 #${c.number} escalated — halting sibling implementation (cheap reframe per §4.5). ${childRefs.length - results.length} sibling(s) left ready for human.`)
    break
  }
}

phase('Report')
const slug = slugify(GOAL)
const proofPayload = {
  goal: GOAL,
  dryRun: DRY,
  designRef: DESIGN_REF || undefined,
  parent: { number: parentRef.number, title: parentRef.title, url: parentRef.url, body: parentRef.body },
  results: results.map((r) => ({ issue: r.issue, title: r.title, coversAc: r.coversAc || [], status: r.status, testSummary: r.testSummary, commit: r.commit, url: r.url })),
}
const report = await agent(reportPrompt({
  payload: proofPayload, slug,
  resolved: resolved.length, gaps: gaps.length, children: childRefs.length,
  implemented: results.filter((r) => r.status === 'pass').length,
  escalated: results.filter((r) => r.status === 'escalated').length,
}), { label: 'report', phase: 'Report', model: MODEL })

return {
  goal: GOAL,
  dryRun: DRY,
  resolved: resolved.length,
  gaps: gaps.length,
  children: childRefs.length,
  implemented: results.filter((r) => r.status === 'pass').length,
  escalated: results.filter((r) => r.status === 'escalated').length,
  deferred: childRefs.length - results.length,
  reportPath: `daily/autodev-reports/${DATE}-${slug}.md`,
  report,
}
