export const meta = {
  name: 'self-learn-extract',
  description: 'Phase 1 EXTRACT fan-out — one agent per chapter extracts atomic concepts from its own chapter file (text kept out of main context), writes notes via note_writer.py against a Phase-0 closed category enum, then a barrier pass back-links each note',
  phases: [
    { title: 'Phase 0', detail: 'one agent parses the epub, writes each chapter to a temp file, derives the closed category taxonomy' },
    { title: 'Phase 1', detail: 'one agent per chapter reads ONLY its file, extracts concepts, writes notes via note_writer.py' },
    { title: 'Phase 1b', detail: 'one barrier agent fills each ## Related block from the global slug list' },
  ],
}

// ─── args (passed by the SKILL via the Workflow tool) ─────────────────────────
// { bookSlug, epubPath, vaultPath, bookTitle, author }
//
// Architecture (issue #321): the whole point is keeping chapter text OUT of main
// context. Phase 0 writes chapters to temp files and returns only a small manifest
// + a CLOSED category enum; each Phase-1 worker Reads its own file. Phase 0 owning
// the taxonomy is what prevents parallel category drift. The Workflow runtime has
// no shell / no new Date(), so epub parsing + temp-file writes run INSIDE the
// Phase-0 agent (which has Bash), not from orchestrator JS.
//
// Tolerate args arriving as either a parsed object or a JSON string (house style).
let A = args
if (typeof A === 'string') {
  try { A = JSON.parse(A) } catch (e) { A = {} }
}
A = A || {}
const BOOK_SLUG = A.bookSlug || ''
const EPUB_PATH = A.epubPath || ''
const VAULT = A.vaultPath || '/Users/thanhdo/work/brain'
const BOOK_TITLE = A.bookTitle || ''
const AUTHOR = A.author || ''

if (!BOOK_SLUG) throw new Error('self-learn.workflow: args.bookSlug is required')
if (!EPUB_PATH) throw new Error('self-learn.workflow: args.epubPath is required')

const BOOK_DIR = `${VAULT}/knowledge/raw/${BOOK_SLUG}`
// Resolve the self-learn scripts dir the same way every SKILL.md does.
const PLUGIN_GLOB = '${CLAUDE_PLUGIN_ROOT:-$(ls -d ~/.claude/plugins/cache/brain-os-marketplace/brain-os/*/ 2>/dev/null | sort -V | tail -1)}'
const SCRIPTS_HINT = `PLUGIN_ROOT="${PLUGIN_GLOB}"; PLUGIN_ROOT="\${PLUGIN_ROOT%/}"; SCRIPTS="$PLUGIN_ROOT/skills/self-learn/scripts"`

// ─── schemas ──────────────────────────────────────────────────────────────────
const MANIFEST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    chapters: {
      type: 'array',
      description: 'One row per substantive chapter, in spine order. NO chapter body text here — text lives only in the temp file at path.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          index: { type: 'number', description: 'chapter index from epub_parser.py' },
          title: { type: 'string' },
          path: { type: 'string', description: 'absolute path to the temp file this chapter text was written to' },
          wordCount: { type: 'number' },
        },
        required: ['index', 'title', 'path', 'wordCount'],
      },
    },
    categories: {
      type: 'array',
      description: 'The CLOSED category taxonomy derived from chapter BODIES (kebab-case). Every Phase-1 note must fall into one of these; this is the enum that prevents per-worker drift.',
      items: { type: 'string' },
    },
  },
  required: ['chapters', 'categories'],
}

const EXTRACT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    notes: {
      type: 'array',
      description: 'One row per atomic concept written for THIS chapter. Slugs only — no note body text (kept out of main context).',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          slug: { type: 'string', description: 'the note filename slug (note_writer.py slugify of the title)' },
          category: { type: 'string', description: 'MUST be one of the Phase-0 enum, unless newCategory is set' },
          title: { type: 'string' },
          newCategory: { type: 'boolean', description: 'escape hatch: true ONLY if no enum category fits and a new one was genuinely needed' },
        },
        required: ['slug', 'category', 'title'],
      },
    },
  },
  required: ['notes'],
}

const BACKLINK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    updated: { type: 'array', description: 'slugs whose ## Related block was edited', items: { type: 'string' } },
  },
  required: ['updated'],
}

const ROLE = `You are one stage of SELF-LEARN Phase 1 (EXTRACT) — turning a book into atomic Obsidian concept notes. Discipline: chapter text is kept OUT of the orchestrator's context; each worker touches only its own chapter; categories come from a single closed taxonomy so notes never fragment (decision-making vs decisions).`

// ─── prompt builders ──────────────────────────────────────────────────────────
function phase0Prompt() {
  return `${ROLE}

PHASE 0 — PARSE + TAXONOMY (you are the only agent that sees the whole book).

Do, using Bash:
1. Resolve scripts: ${SCRIPTS_HINT}
2. Parse the epub: \`python3 "$SCRIPTS/lib/epub_parser.py" "${EPUB_PATH}" --json\` → an array of {title,text,index,word_count}.
3. Create ONE temp dir: \`TMP=$(mktemp -d)\`. For each chapter, write its \`text\` to \`$TMP/ch-<index>.txt\`. (Do this so each Phase-1 worker can Read only its own chapter — the book text must NOT travel through the orchestrator.)
4. Derive a CLOSED category taxonomy (kebab-case, ~5-9 buckets) from the chapter BODIES, not just titles — titles under-determine the concepts. These become the only categories Phase-1 may use.

Return the manifest: chapters:[{index,title,path:"$TMP/ch-<index>.txt",wordCount}] and categories:[...]. Do NOT include any chapter body text in the return.`
}

function extractPrompt(row, categories) {
  return `${ROLE}

PHASE 1 — EXTRACT one chapter. Read ONLY your chapter file; do not read any other chapter or the epub.

CHAPTER ${row.index}: ${row.title}
CHAPTER FILE (Read THIS path, nothing else): ${row.path}
BOOK NOTES ROOT: ${BOOK_DIR}
BOOK: "${BOOK_TITLE}"  AUTHOR: "${AUTHOR}"

CLOSED CATEGORY ENUM — every note MUST use exactly one of these (kebab-case):
${categories.length ? categories.map((c) => `  - ${c}`).join('\n') : '  (none supplied — fall back to one descriptive kebab-case category)'}
Only if NO enum category genuinely fits, set newCategory=true and name a new kebab-case category — but prefer the enum; drift is the failure this design prevents.

Do:
1. Read ONLY ${row.path}. Identify atomic concepts: named frameworks, core principles, processes/rituals, mental models, distinctions, actionable tools (one concept per note, ~100 words).
2. Write EACH note with note_writer.py (do NOT hand-roll markdown — the script guarantees frontmatter + ## Key Insight + ## Related structure):
   ${SCRIPTS_HINT}
   Build a JSON array of {category,title,content,key_insight,related,chapter:${row.index},tags} and pipe it:
   \`echo "$JSON" | python3 "$SCRIPTS/lib/note_writer.py" "${BOOK_DIR}"\`
   category MUST be from the enum above. Leave \`related\` best-effort (the Phase-1b barrier fills cross-chapter links).
3. Return slugs only: notes:[{slug,category,title}] (slug = note_writer's kebab-case of the title). Do NOT return note body text.`
}

function backlinkPrompt(allNotes) {
  const list = allNotes.map((n) => `  - ${n.slug} [${n.category}] ${n.title}`).join('\n')
  return `${ROLE}

PHASE 1b — BACK-LINK (barrier; runs after every chapter is written). You now have the GLOBAL slug list a single worker never had.

ALL NOTES (${allNotes.length}):
${list}

BOOK NOTES ROOT: ${BOOK_DIR}

Do:
1. For each note, Edit ONLY its \`## Related\` block (under ${BOOK_DIR}/<category>/<slug>.md) to link 2-4 genuinely related notes — prefer same-category and cross-chapter connections — using [[slug]] wikilinks. Replace the placeholder "- (none yet)" where real relations exist.
2. Do not touch frontmatter, the body, or ## Key Insight. Do not create notes.

Return updated:[slug,...] for the notes you edited.`
}

// ─── Phase 0: PARSE + TAXONOMY (one agent) ────────────────────────────────────
phase('Phase 0')
const manifest = await agent(phase0Prompt(), { label: 'parse+taxonomy', phase: 'Phase 0', schema: MANIFEST_SCHEMA })
const chapters = (manifest && Array.isArray(manifest.chapters)) ? manifest.chapters : []
const categories = (manifest && Array.isArray(manifest.categories)) ? manifest.categories : []
if (!chapters.length) {
  return { bookSlug: BOOK_SLUG, error: 'Phase 0 produced no chapters', categories }
}
log(`Phase 0 → ${chapters.length} chapters · ${categories.length}-category closed taxonomy`)

// ─── Phase 1: EXTRACT (parallel — one agent per chapter) ──────────────────────
phase('Phase 1')
const perChapter = await parallel(
  chapters.map((row) => () =>
    agent(extractPrompt(row, categories), { label: `extract:ch-${row.index}`, phase: 'Phase 1', schema: EXTRACT_SCHEMA })
      .then((r) => ((r && Array.isArray(r.notes)) ? r.notes.map((n) => ({ slug: n.slug, category: n.category, title: n.title, chapter: row.index })) : [])),
  ),
)
const allNotes = perChapter.filter(Boolean).flat()
log(`Phase 1 → ${allNotes.length} notes across ${chapters.length} chapters`)

// ─── Phase 1b: BACK-LINK (barrier, one agent over the global slug list) ───────
phase('Phase 1b')
let relatedUpdated = []
if (allNotes.length) {
  const back = await agent(backlinkPrompt(allNotes), { label: 'backlink', phase: 'Phase 1b', schema: BACKLINK_SCHEMA })
  relatedUpdated = (back && Array.isArray(back.updated)) ? back.updated : []
}
log(`Phase 1b → back-linked ${relatedUpdated.length} notes`)

// Category breakdown for parity (SET must match the fixture; counts in a soft band).
const categoryCounts = {}
allNotes.forEach((n) => { categoryCounts[n.category] = (categoryCounts[n.category] || 0) + 1 })

// Return slugs/categories/titles only — NO chapter or note body text in main context.
return {
  bookSlug: BOOK_SLUG,
  categories,
  noteCount: allNotes.length,
  categoryCounts,
  notes: allNotes,
  relatedUpdated: relatedUpdated.length,
}
