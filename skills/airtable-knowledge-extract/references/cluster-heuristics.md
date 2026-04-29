# Cluster classification heuristics

Used by `scripts/classify-clusters.mts` to assign a `type` + `dominant_table` to each connected component in a base's link graph.

Classification is **deterministic**: count how many tables in a cluster match each type's name patterns; the type with the highest count wins. Ties broken by precedence (top of list wins). Clusters with zero matches across every type fall through to `orphan`.

## Type table

| Type | Table-name patterns (case-insensitive, word boundary) | Precedence |
|------|-------------------------------------------------------|------------|
| `crm` | `contact`, `compan(y\|ies)`, `lead`, `deal`, `account`, `customer` | 1 |
| `okr` | `okrs?`, `objective`, `key result`, `krs?` | 2 |
| `decision` | `decision`, `adr` | 3 |
| `project` | `project`, `task`, `milestone`, `epic`, `sprint` | 4 |
| `knowledge-note` | `note`, `article`, `knowledge`, `wiki`, `doc` | 5 |
| `orphan` | — (fallback when no type's patterns match any table) | — |

## Algorithm

1. For each cluster `C`:
   1. For each type `T`: count tables in `C` whose `name` matches any pattern in `T`. Call it `score(T,C)`.
   2. If `max_T score(T,C) == 0` → `type = orphan`.
   3. Else: `type = argmax_T score(T,C)`, ties broken by precedence (lower number wins).
2. `dominant_table` = highest-degree table in `C` whose name matches the chosen type's patterns. Degree = count of in-cluster link-edges. Ties broken alphabetically by name.
3. For `orphan` clusters: `dominant_table` = highest-degree table; size-1 cluster → the only table.

## Single-table clusters

A cluster of size 1 with no incoming/outgoing links is `orphan` regardless of name (no signal to classify against; the name alone is unreliable). This catches lookup tables, archive tables, and stray drafts that aren't part of the operational graph.

## Why patterns over field-name heuristics

The parent story (`ai-brain#179`) settled on link-graph traversal — table-name signal only kicks in for *labeling* the cluster, not for deciding which tables belong together. Field-name heuristics (e.g., "this table has a `Status` field, must be a project tracker") drift fast across bases; table names are stable identifiers the operator chose deliberately.

## Adding new patterns

When a new cluster type emerges (e.g., `inventory`, `event`), add a row to the table above and a matching entry to `TYPE_PATTERNS` in `scripts/classify-clusters.mts`. Keep the two in lockstep. Do not parse this `.md` at runtime — it is documentation.
