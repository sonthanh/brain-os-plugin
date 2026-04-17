---
title: "Email Knowledge Extract — Phase 0 Patches"
type: reference
tags: [email-knowledge-extract, patches, phase0]
source_grill: "daily/grill-sessions/2026-04-17-email-knowledge-extract-skill-design.md"
source_eval: "daily/eval-reports/2026-04-14-email-pipeline"
---

# Phase 0 Patches

Three extraction gaps surfaced in the Phase 0 100-email eval (Sonnet-only, 82/100). Each patch has a **WHY** (what Sonnet missed), a **WHERE** (prompt vs post-processor), and a **HOW TO VALIDATE** (synthetic test case for dry-run).

## Patch 1 — Payment notification extraction

**Why.** Sonnet's default skip threshold drops payment receipts that carry real business signal. Phase 0 misses included Amadea EUR 14,138 and Brand X USD 899 — both verifiable money flows, both dropped.

**Where.** Prompt only. The judgment "this receipt has business meaning" is NLP over body content — can't live in deterministic TS.

**Prompt text** (section in `prompts/extract.md`):

> **Payment notification handling.** If the email contains a payment confirmation, invoice, or statement AND mentions a monetary amount (>= USD 10 or equivalent), you MUST extract a `decision` entry with `type: "financial"`, `amount` set, and `actors` including payer + payee. Do NOT skip payment emails just because the sender domain is automated (e.g., stripe, amadea, paypal). The junk pre-filter already honored a force-extract rule to get this email to you — respect that signal.

**How to validate.**

Synthetic email:
```
From: notify@stripe.com
Subject: Payment received: USD 899
Body: Your customer Brand X has paid USD 899 on 2026-04-15. Transfer to EMVN bank account completed.
```

Expected output:
```json
{
  "skip": false,
  "decisions": [{
    "text": "Brand X paid USD 899 to EMVN",
    "amount": "USD 899",
    "type": "financial",
    "actors": ["Brand X", "EMVN"]
  }]
}
```

## Patch 2 — CC-chain actor extraction

**Why.** Sonnet misses actors buried in signature blocks and quoted reply chains. Phase 0 misses included TAJ/VTV tender reps (named only in bottom signatures) and Nhi/My Nguyen in Indiesonics threads (visible only in quoted reply history).

**Where.** Prompt only. Requires parsing signature blocks and quoted-reply markers — pure NLP, no deterministic TS equivalent.

**Prompt text** (section in `prompts/extract.md`):

> **Actor extraction from full body.** Read the entire email body, including:
> 1. Signature blocks — typically below a line of dashes (`---`, `—`, or blank-line separator), often containing name, role, company, phone.
> 2. Quoted reply chains — lines prefixed with `>` or sections headed `On {date}, {person} wrote:`. Extract every distinct actor named in the thread, not just the immediate sender.
>
> When the body is bilingual (Vietnamese + English), attend to both — Vietnamese signature blocks often carry the real counterparty name while English header/subject is auto-generated.

**How to validate.**

Synthetic email:
```
From: info@taj.vn
Subject: Re: VTV tender response
Body:
Thank you for the update.

On 2026-04-10 Hoang Minh <hoang.minh@vtv.vn> wrote:
> Confirming the meeting for next week.

Regards,
Le Thi Hoa
Tender coordinator, TAJ Group
+84 912 345 678
```

Expected output (people[] must include BOTH Hoang Minh AND Le Thi Hoa):
```json
{
  "people": [
    {"name": "Hoang Minh", "email": "hoang.minh@vtv.vn", "role": "VTV", "worth_page": true, "reason": "named in quoted reply"},
    {"name": "Le Thi Hoa", "email": "",                 "role": "Tender coordinator at TAJ Group", "worth_page": true, "reason": "signature block"}
  ]
}
```

## Patch 3 — No EMVN self-reference as external company

**Why.** Sonnet occasionally adds EMVN / Melosy / Tunebot / Cremi / MusicMaster / SongGen to `companies[]` as if they were external counterparties. They're our internal teams — listing them as counterparties inflates noise and misleads later synthesis.

**Where.** Prompt (nuanced rule) + TS passive WARN log (drift-detection telemetry). TS does **NOT** auto-strip — that would kill the legitimate "EMVN as subject of decision" cases.

**Prompt text** (section in `prompts/extract.md`):

> **Internal team handling.** The following are OUR internal teams, not external entities: `emvn.co`, `melosy.net`, `melosymusic.com`, `musicmaster.io`, `tunebot.io`, `songgen.ai`, `cremi.ai`, `cremi.com`, `dzus.vn`.
>
> - Do NOT add them to `companies[]` as counterparty context.
> - DO include them in `decisions[].actors` when they are the subject of a decision (e.g., "EMVN to pay supplier X", "MusicMaster adopted pricing tier Y"). In that case, the corresponding `companies[]` entry is still omitted.
> - People on these domains → `people[]` entries may still be included (they're internal actors we track).

**Where (TS side).** `scripts/lib/sanity-check.ts`:

```
for each company in result.companies[]:
  if company.domain ∈ INTERNAL_DOMAINS:
    if no decision in result.decisions[] has this company.name in actors[] as subject:
      emit WARN { msg_id, warning: 'internal_team_as_company', company: name, domain }
      # Do NOT strip. Patch-3 drift signal feeds /improve cycle.
```

WARN payload is written to `business/intelligence/email-extraction/<run_id>/warnings.jsonl` (gitignored; safety-net path).

**How to validate.**

Synthetic email that SHOULD trigger WARN:
```
From: bd@emvn.co
Subject: Discussion with UMG
Body: Had a meeting with UMG to discuss their Q2 statement. Will follow up with both UMG and EMVN ops team.
```

Bad output (should warn):
```json
{
  "companies": [
    {"name": "UMG",  "domain": "umg.com",  "worth_page": true,  "reason": "..."},
    {"name": "EMVN", "domain": "emvn.co",  "worth_page": false, "reason": "..."}  // ← triggers WARN
  ]
}
```

Good output (no warn):
```json
{
  "companies": [
    {"name": "UMG", "domain": "umg.com", "worth_page": true, "reason": "..."}
  ]
  // EMVN not present — it's the protagonist, not a counterparty
}
```

Synthetic email that SHOULD NOT warn (EMVN legitimately in decision):
```
From: finance@emvn.co
Subject: Payment to Amadea approved
Body: EMVN approved the EUR 14,138 transfer to Amadea for Q1 reconciliation.
```

Acceptable output:
```json
{
  "companies": [
    {"name": "Amadea", "domain": "amadea.com", "worth_page": true, "reason": "..."}
  ],
  "decisions": [{
    "text": "EMVN approved EUR 14,138 payment to Amadea",
    "amount": "EUR 14138",
    "type": "financial",
    "actors": ["EMVN", "Amadea"]   // EMVN listed as actor/subject — OK
  }]
}
```

No WARN because EMVN isn't in `companies[]`.

## Drift telemetry

Each patch's effectiveness is observable via:
- Patch 1: count of `decisions[].type=financial` per 1000 emails (should rise vs Phase 0 baseline).
- Patch 2: count of `people[]` entries per email (should rise; compare against the 100-email Phase 0 sample).
- Patch 3: count of WARN events in `warnings.jsonl` (should be near zero; any WARN is a drift flag for /improve).

`/improve email-knowledge` cycle reads these counts from the outcome log + warnings.jsonl to propose prompt-patch v2.
