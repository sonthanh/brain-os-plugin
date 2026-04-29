# /airtable-knowledge-extract — Opus 4.6 reviewer prompt

The reviewer (`scripts/review-slice.mts`) renders this template into a single
prompt per batch. The static prefix (`meta_rubric`, `examples`, `rubric_questions`)
is concatenated BEFORE the dynamic `batch` section so Anthropic's prompt cache
can hit on the prefix across batches in the same run.

Output contract: STRICT JSON only. No prose, no preamble, no fenced code blocks.
Schema:

```json
{
  "slices": [
    {
      "slice_id": "string — must match input slice_id verbatim",
      "score": 0.0,
      "pass": true,
      "reasoning": "one-paragraph judgment grounded in the meta-rubric criteria",
      "fail_modes": ["link-mismatch", "fact-invented", "schema-fail", "missing-entity", "slug-collision", "frontmatter-drift"]
    }
  ],
  "batch": {
    "pass_rate": 0.0,
    "pass": true
  }
}
```

Rules:

- Every slice in the input batch MUST have a verdict in `slices[]` with the
  same `slice_id`. Order matches input.
- `score` ∈ [0, 1]. `pass` is `true` iff `score ≥ 0.9` for that slice.
- `fail_modes` is empty when `pass: true`. Otherwise enumerate every applicable
  tag from the closed vocabulary below; do not invent new tags.
- `batch.pass_rate` = (count where `pass: true`) / (total slices). Compute this
  yourself; do not approximate.
- `batch.pass` is set by the runtime against the configured threshold (default
  0.95). The reviewer SHOULD still emit a value; the runtime overrides.

Closed `fail_modes` vocabulary:

- `link-mismatch` — extracted entity references a `[[wikilink]]` to a slug that
  doesn't appear elsewhere in the batch, or omits a record-link present in the
  source subgraph.
- `fact-invented` — entity body or frontmatter contains a claim with no support
  in the source subgraph.
- `schema-fail` — entity is missing required fields (`type`, `slug`, `body`,
  `source_record_ids`) or has malformed values.
- `missing-entity` — a substantive source record from the subgraph produced no
  entity (and no logged-skip reason).
- `slug-collision` — two entities of the same `type` share the same `slug`.
- `frontmatter-drift` — frontmatter values contradict the source record (wrong
  date, wrong owner, fabricated industry, etc.).

# Task

You are an expert reviewer of Airtable→vault knowledge extractions. Judge each
slice in the batch against the meta-rubric criteria. Use the per-base examples
as anchors for the *style* of correct extraction; use the per-base rubric
questions to sanity-check whether the vault would answer them after this slice
imports.

# Meta-rubric (frozen WHAT)

{{meta_rubric}}

# Per-base examples (HOW — corrected examples bank)

{{examples}}

# Per-base rubric questions

{{rubric_questions}}

# Batch slices

{{batch}}

Output strict JSON only.
