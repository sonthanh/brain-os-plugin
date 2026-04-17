---
title: "Email Knowledge Extract — Entity Schema"
type: reference
tags: [email-knowledge-extract, schema]
---

# Entity Schema

The Sonnet extraction prompt must return **one JSON object per email** matching this shape. `write-pages.ts` validates against this schema with zod before any page write.

## Top-level shape

```json
{
  "email_id": "string (Gmail message id)",
  "one_line": "string (<= 200 chars; English; factual summary)",
  "people":    [ /* Person[] */ ],
  "companies": [ /* Company[] */ ],
  "meetings":  [ /* Meeting[] */ ],
  "decisions": [ /* Decision[] */ ],
  "skip":        "boolean (true if no entity worth extracting)",
  "skip_reason": "string | null"
}
```

Rule: if `skip=true`, the four arrays must be empty. If `skip=false`, at least one of the arrays must contain an entry.

## Person

```json
{
  "name":       "string (canonical display name)",
  "email":      "string (lowercase; empty string if unknown)",
  "role":       "string (role / company affiliation as observed in this email)",
  "worth_page": "boolean",
  "reason":     "string (why worth_page is true/false)"
}
```

`worth_page=true` heuristic (applied by Sonnet):
- Person appears across **2+ email threads** in recent history, OR
- Person is the counterparty in a decision (amount, commitment, contract), OR
- Person is on a recurring team-interaction cadence (weekly sync, project standing meeting).

Personal-only contacts (travel, OTP receivers, one-off form submitters) → `worth_page=false`.

## Company

```json
{
  "name":       "string (canonical company name)",
  "domain":     "string (primary domain, lowercased; empty string if unknown)",
  "context":    "string (role relative to us — partner, client, vendor, prospect, etc.)",
  "worth_page": "boolean",
  "reason":     "string"
}
```

`worth_page=true` heuristic:
- Company appears across **3+ email threads**, OR
- Is the counterparty of a decision (payment, contract, deal), OR
- Is tagged in partner/distributor/client lists we track.

Internal companies (domains listed in `{vault}/context/email-extract.md` → `## Internal Domains`, spliced into the prompt at runtime) — see `phase0-patches.md` Patch 3 — are omitted from `companies[]` entirely. They may appear in `decisions[].actors` when they're the subject of a decision.

## Meeting

```json
{
  "uid":       "string (calendar event UID; empty if not a calendar invite)",
  "subject":   "string",
  "date":      "string (YYYY-MM-DD; empty if unknown)",
  "attendees": ["string (email, lowercased)"],
  "context":   "string (agenda / purpose as observed)"
}
```

Accept calendar invites (`.ics` attachment OR `Content-Type: text/calendar`) and meeting-note emails (report@, recap emails). Reject generic thread scheduling unless a specific time commitment is fixed.

## Decision

```json
{
  "text":   "string (English summary of the decision, <= 240 chars)",
  "amount": "string (e.g., 'EUR 14138', 'USD 899'; empty if no monetary amount)",
  "type":   "enum: 'financial' | 'strategic' | 'operational'",
  "actors": ["string (person name; refer back to people[] when possible)"]
}
```

`financial` = any payment, invoice, commitment with a number. `strategic` = policy, partnership scope, direction. `operational` = process change, tool adoption, workflow decision.

## Validation rules (enforced in `scripts/lib/sanity-check.ts`)

1. JSON must parse (parse_error otherwise).
2. All required fields present with declared types (schema_error otherwise).
3. `skip=true` ⇔ all entity arrays empty.
4. `email_id` matches the caller-provided id (schema_error on mismatch).
5. Each `decisions[].type` ∈ enum above.
6. All `email` fields are lowercase; trimmed.
7. **Patch 3 check**: for each entry in `companies[]` whose `domain` ∈ internal-team list AND no matching `decisions[].actors` references that company as subject → emit WARN (do NOT strip). See `phase0-patches.md`.

## Empty output is legitimate

`skip=false` with all arrays empty is a schema error; but `skip=true` with a clear `skip_reason` is a valid outcome (written to JSONL as `extracted_empty`, not a retry case).
