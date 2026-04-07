---
name: research
description: "Use when needing to research a topic from the web — scans X and web for state-of-the-art thinking from top voices, synthesizes into bullet points with citations, and optionally ingests into vault"
---

## Vault Location
**Vault path:** Read from `${CLAUDE_PLUGIN_ROOT}/brain-os.config.md`

# /research [topic] [--depth quick|deep] [--ingest] [--platforms web,x,youtube,reddit] [--voices person1,person2]

## Behavior

Research agent optimized for tracking cutting-edge thinking from top voices: plan → person-specific + topic searches across platforms → synthesize into cited weekly digest → optionally ingest to vault.

**Default behavior: X-first, voice-driven.** Generic web articles are low-signal. Prioritize original thinking from researchers, engineers, and founders who are actually building.

## Parameters

| Param | Default | Description |
|-------|---------|-------------|
| `topic` | required | What to research |
| `--depth` | `quick` | `quick` = 5-8 searches, `deep` = 15-20 searches with subagents |
| `--ingest` | false | Save findings to vault for `/think`, `/connect`, `/emerge` |
| `--platforms` | `x,web` | Comma-separated: `x`, `web`, `youtube`, `reddit`, `linkedin`, `all` |
| `--voices` | auto-discover | Comma-separated key people to track; merged with Voices Registry |
| `--lang` | `en` | Language hint for search queries |

## Voices Registry

Maintain a living table of key voices in `{vault}/knowledge/research/voices.md`. Auto-populated on first run, user can add/remove anytime.

### Default Voices (auto-seeded for AI Engineering)
```markdown
| Person | Affiliation | Focus | X Handle |
|--------|------------|-------|----------|
| Andrej Karpathy | ex-OpenAI/Tesla | Autoresearch, agentic engineering | @karpathy |
| Harrison Chase | LangChain | Agent harness patterns, flow engineering | @hwchase17 |
| Swyx (Shawn Wang) | Latent Space | AI Engineer role, agent engineering | @swyx |
| Simon Willison | Independent | LLM tooling, practical AI, MCP | @simonw |
| Jediah Katz | Cursor | Context engineering, dynamic discovery | @jediahkatz |
| Tobi Lütke | Shopify | AI-first org transformation | @tobi |
| Dex Horthy | HumanLayer | 12-Factor Agents, production patterns | @dexhorthy |
| Anthropic team | Anthropic | Claude, MCP, multi-agent research | @AnthropicAI |
| OpenAI team | OpenAI | Codex, deep research, reasoning | @OpenAI |
```

User adds voices via: `/research --add-voice "Name, Affiliation, Focus, @handle"`

## Phase 1: PLAN

1. Read `{vault}/knowledge/research/voices.md` — load tracked voices
2. Merge with any `--voices` override
3. Decompose `topic` into 2-4 angles (not generic subtopics — think: paradigm shifts, tools, architecture patterns, org transformation)
4. For EACH angle, generate:
   - **Voice-specific queries**: `"{person_name} {topic_angle}" site:x.com`
   - **Topic queries**: `"{topic_angle} 2026 latest" site:x.com`
   - **Web deep-dives**: for blog posts, papers, repos linked from X posts

## Phase 2: SEARCH

### Search Strategy — X-first

**Round 1: Voice tracking (highest signal)**
For each tracked voice relevant to the topic:
```
WebSearch: "{person_name} {topic}" site:x.com
```
This catches their latest takes, threads, and announcements.

**Round 2: Topic scanning**
```
WebSearch: "{topic_angle} site:x.com 2026"
WebSearch: "{topic_angle} new approach paradigm 2026"
```
This discovers new voices and conversations not yet in registry.

**Round 3: Deep-dives (web)**
For high-signal X posts that reference blogs/repos/papers:
```
WebFetch: extract key points from linked blog/repo
WebSearch: "{specific_concept_from_X} explained 2026"
```

**Round 4 (if --platforms includes youtube/reddit):**
```
WebSearch: "{topic} site:youtube.com podcast 2026"
WebSearch: "{topic} site:reddit.com discussion 2026"
```

### Quick mode
5-8 WebSearch calls: focus on voice tracking + topic scanning.

### Deep mode
Spawn up to 3 subagents in parallel:
- Agent 1: Voice tracking (all registered voices)
- Agent 2: Topic angle scanning on X
- Agent 3: Deep-dive web/youtube/reddit
Each writes to `{vault}/knowledge/research/reports/research-findings-{slug}-{n}.md`

## Phase 3: SYNTHESIZE

1. Cluster findings by theme (not by person)
2. For each finding: one bullet, one line, one source link
3. For breakthrough ideas: include a short quote (< 15 words) from the original post
4. Build a Voices table with each person's current focus
5. End with Open Questions

### Output Format

```markdown
# {Topic}: State of the Art — Week of YYYY-MM-DD

## Paradigm Shifts
- **{shift name}** — {one-line explanation} ([Person on X](url))
- ...

## Key Approaches & Patterns
- **{pattern name}** — {what it is, why it matters} ([Source](url))
- ...

## Tools & Infrastructure
- **{tool}** — {what's new} ([Source](url))
- ...

## Org Transformation Signals
- **{company/person}** — {what they did/said} ([Source](url))
- ...

## Key Voices & Current Focus
| Person | Affiliation | Current Focus | Follow |
|--------|------------|---------------|--------|
| ... | ... | ... | [@handle](url) |

*Add your own voices to this table as you discover them.*

## Open Questions
- {what remains unclear, contradictory, or worth watching}

---
*Sources: {n} searches across {platforms} | Voices tracked: {n}*
```

Save to: `{vault}/knowledge/research/reports/YYYY-MM-DD-research-{slug}.md`

After saving, update `{vault}/_index.md` — add entry under Research Reports with one-line summary.

## Phase 4: INGEST (optional, only with --ingest)

If `--ingest` flag is set:
1. Convert key findings into atomic vault notes
2. Save to `{vault}/knowledge/research/findings/{slug}/`
3. Each note = one finding, tagged `source: "research-{date}"`
4. Link to related vault concepts if they exist

### Research Note Template
```markdown
---
source: "research-{date}"
topic: "{topic}"
url: "{source_url}"
voice: "{person_name}"
signal: {high|medium|low}
tags: [{tags}]
---

# {Finding Title}

{1-2 sentences: the finding, precise and factual}

## Implication
{Why this matters — one sentence}

## Related
- [[related-vault-note-if-exists]]
```

## Integration with Other Skills

| After research... | Use skill | Why |
|-------------------|-----------|-----|
| Reflect on findings | `/think` | Deep thinking about implications |
| Connect to existing knowledge | `/connect {topic} {domain}` | Find bridges between research and vault |
| Surface hidden patterns | `/emerge` | Let vault + new research reveal insights |
| Generate ideas from research | `/ideas-gen` | Cross-domain brainstorming |
| Write content from research | Use writing skills | Research as input for content |

## Weekly Usage Pattern

```
# Monday morning: scan what happened last week
/research "AI engineering" --depth deep --platforms x,web --ingest

# Midweek: deep dive on something specific from Monday's scan
/research "autoresearch autonomous loops" --depth deep --platforms x,web,youtube

# Ad-hoc: check a specific person's latest thinking
/research "context engineering" --voices "Jediah Katz, Anthropic"
```

## Examples

```
/research "AI agents state of the art"
/research "agentic engineering" --depth deep --platforms x,web,youtube
/research "MCP protocol ecosystem" --voices "Simon Willison, Anthropic" --ingest
/research "AI transformation enterprise" --platforms all --lang vi
/research --add-voice "Yann LeCun, Meta, AI skeptic counterpoint, @ylecun"
```

## Guardrails

- **Never fabricate sources** — every bullet must have a real URL from WebSearch results
- **X-first** — original posts from builders > blog rewrites > generic articles
- **Recency bias** — prefer this month's sources; flag anything older than 3 months
- **Signal hierarchy** — primary source (X post, blog, repo) > analysis > opinion > news summary
- **One line per bullet** — if it needs a paragraph, it's not distilled enough
- **Quotes < 15 words** — only for truly original phrasing worth preserving
- **Copyright** — never reproduce long quotes, only short factual extractions
- **Max searches**: quick=8, deep=20
