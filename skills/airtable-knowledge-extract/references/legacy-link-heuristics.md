# Legacy-link detection heuristics

Used by `scripts/legacy-link-detector.mts` to flag link edges that are likely stale and prune them from the cluster set before downstream extract.

A link edge `(source_table → target_table)` via field `F` is **legacy** when both heuristics fire:

1. **Sparse** — fewer than `SPARSE_THRESHOLD` of source-table records carry the link.
2. **Broken** — target table has zero usable records (every record empty, or every record archived).

## Tunable parameters

| Parameter | Default | Meaning |
|-----------|---------|---------|
| `SPARSE_THRESHOLD` | `0.10` (10%) | Edge is sparse when `linked_count / total_source_records < SPARSE_THRESHOLD`. Total of zero source records is treated as sparse=true (dead link). |
| `ARCHIVED_FIELD_PATTERN` | `/^(archived?|is.?archived)$/i` | Field-name pattern that marks a record as archived when the value is truthy (`true`, non-empty string, non-zero number). |

Override `SPARSE_THRESHOLD` per call via `detectLegacyLinks(baseId, { sparseThreshold: 0.05 })`. Tighter threshold (smaller number) = fewer edges flagged as legacy.

## Empty vs archived

- **Target empty** = `records.length === 0`, OR every record has `Object.keys(fields).length === 0`. Airtable's Records API omits empty fields from the `fields` object, so an unused record collapses to `fields: {}`.
- **Target archived** = `records.length > 0` AND every record has at least one field matching `ARCHIVED_FIELD_PATTERN` set to a truthy value. A single live record is enough to flip `archived` back to false.
- **Target broken** = `target_empty || target_archived`.

## Algorithm

1. Fetch table schema via Meta API, build link graph (reuses `buildLinkGraph` + `findComponents` from `classify-clusters.mts`).
2. Enumerate every directed link edge `(source_id, field_id, target_id)` from `multipleRecordLinks` fields. Skip self-links.
3. Fetch all records (paginated by `offset`) for every distinct table that appears as either side of any edge.
4. Per edge: compute `sparse_ratio`, `sparse`, `target_empty`, `target_archived`, `broken`, `legacy = sparse && broken`.
5. Build pruned adjacency: drop both directions for every legacy edge. Re-compute connected components on the pruned graph.
6. Emit `metrics/legacy-links.json` (full per-edge data) + `out/airtable-cleanup-tasks.md` (per-base human-readable cleanup recs) under `<cacheDir>/<runId>/`.

## Why prune symmetrically

`buildLinkGraph` is undirected — each `multipleRecordLinks` field adds both `source→target` and `target→source` entries. When pruning a legacy edge, drop both sides so `findComponents` sees the partition. Otherwise the half-pruned graph keeps the cluster connected and the legacy split is silent.

## Suggested action wording

`out/airtable-cleanup-tasks.md` includes a one-line action per legacy edge. Choose by reason:

| Sparse | Empty | Archived | Suggested action |
|--------|-------|----------|------------------|
| ✓ | ✓ | — | Drop the link field on source — target table is unused. |
| ✓ | — | ✓ | Drop the link field on source, or migrate the few linking records to the active table. |
| ✓ | ✓ | ✓ | Drop the link field on source AND archive/delete the target table. |

The detector emits the action; the operator reviews + executes manually. No autonomous Airtable writes.
