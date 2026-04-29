# /airtable-knowledge-extract — Sonnet worker prompt variants

The worker (`scripts/extract-slice.mts`) selects the variant matching `cluster.type` from this file at runtime. Each variant block is delimited by an h2 header (`## <type>`) — the runtime parses these and substitutes `{{seed_record_id}}`, `{{cluster_id}}`, and `{{subgraph}}` before invoking Sonnet.

## Output contract (applies to every variant)

Output STRICT JSON only. No prose, no preamble, no fenced code blocks. Schema:

```json
{
  "entities": [
    {
      "type": "person | company | meeting | objective | key-result | decision | project | task | note | entity",
      "slug": "kebab-case-id",
      "frontmatter": { "field": "value", "...": "..." },
      "body": "markdown body",
      "source_record_ids": ["recXXX", "recYYY"]
    }
  ]
}
```

Rules every variant follows:

- One entity per logical thing (person, meeting, decision, etc.). One Airtable record may map to one entity; one entity may aggregate multiple records (rare).
- `slug` is unique within `type`. Use kebab-case. Avoid timestamps unless the entity is time-anchored (meetings, decisions).
- `body` is markdown. Use `[[other-slug]]` to reference any other entity in the same subgraph — preserves Airtable record-link relationships in vault form.
- `source_record_ids` MUST cover every Airtable record that contributed to the entity. The runtime uses these for dedup and for the `sources:` frontmatter field.
- Every record in the subgraph MUST appear as `source_record_ids` on at least one entity.
- Do NOT invent fields. If the Airtable record doesn't have a piece of info, omit the frontmatter key.

## crm

Cluster type: CRM. Tables: contacts, companies, leads, deals, accounts, customers, meetings.

Possible entity types: `person`, `company`, `meeting`.

Conventions:

- Person `slug`: full name kebab-case (`alice-smith`). Frontmatter: `role`, `company` (as `[[company-slug]]`), `email` if present.
- Company `slug`: short company handle (`acme-corp`). Frontmatter: `industry`, `stage` if present.
- Meeting `slug`: `<yyyy-mm-dd>-<short-topic>` (`2026-04-29-q2-strategy`). Frontmatter: `date`, `attendees` (list of `[[person-slug]]`).

Subgraph (cluster {{cluster_id}}, seed {{seed_record_id}}):

{{subgraph}}

Output strict JSON only.

## okr

Cluster type: OKR. Tables: objectives, key results.

Possible entity types: `objective`, `key-result`.

Conventions:

- Objective `slug`: `<period>-<short-name>` (`2026-q2-launch-mvp`). Frontmatter: `period`, `owner` (as `[[person-slug]]` if attributable), `key_results` (list of `[[kr-slug]]`).
- Key-result `slug`: `<objective-slug>-kr-<n>`. Frontmatter: `objective` (as `[[objective-slug]]`), `target`, `current`.

Subgraph (cluster {{cluster_id}}, seed {{seed_record_id}}):

{{subgraph}}

Output strict JSON only.

## decision

Cluster type: decision (ADR-style records).

Possible entity types: `decision`.

Conventions:

- `slug`: `<yyyy-mm-dd>-<short-title>` (`2026-04-27-adopt-bun`).
- Frontmatter: `date`, `status` (`accepted` | `proposed` | `superseded`), `participants` (list of `[[person-slug]]` if known).
- Body sections (use these h2 headers when source data supports them): `## Context`, `## Decision`, `## Rationale`, `## Consequences`.

Subgraph (cluster {{cluster_id}}, seed {{seed_record_id}}):

{{subgraph}}

Output strict JSON only.

## project

Cluster type: project. Tables: projects, tasks, milestones, epics, sprints.

Possible entity types: `project`, `task`.

Conventions:

- Project `slug`: kebab-case project handle. Frontmatter: `status`, `owner` (as `[[person-slug]]`), `tasks` (list of `[[task-slug]]`).
- Task `slug`: `<project-slug>-task-<n>`. Frontmatter: `project` (as `[[project-slug]]`), `status`, `assignee` (as `[[person-slug]]` if known).

Subgraph (cluster {{cluster_id}}, seed {{seed_record_id}}):

{{subgraph}}

Output strict JSON only.

## knowledge-note

Cluster type: knowledge-note. Tables: notes, articles, knowledge entries, wiki, docs.

Possible entity types: `note`.

Conventions:

- `slug`: kebab-case title.
- Frontmatter: `topic`, `tags` (list).
- Body: short atomic note. Use `[[wikilinks]]` to related notes in the cluster.

Subgraph (cluster {{cluster_id}}, seed {{seed_record_id}}):

{{subgraph}}

Output strict JSON only.

## orphan

Cluster type: orphan. No recognized table-name pattern matched.

Possible entity types: `entity` (generic fallback).

Conventions:

- `slug`: kebab-case primary field of the seed record (or `entity-<recordId>` if no readable primary).
- Body: brief summary of the record's fields and links.
- Frontmatter: any obvious key/value pairs from the source record.

Subgraph (cluster {{cluster_id}}, seed {{seed_record_id}}):

{{subgraph}}

Output strict JSON only.
