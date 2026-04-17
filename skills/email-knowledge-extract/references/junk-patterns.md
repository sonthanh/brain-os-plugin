---
title: "Email Knowledge Extract — Junk Pre-Filter Patterns"
type: reference
tags: [email-knowledge-extract, junk-filter]
---

# Junk Pre-Filter Patterns

Target: ~30% of Gmail messages skipped **before** Sonnet extraction. Every skip = saved quota.

## Evaluation order

`junk-filter.ts::evaluate(msg)` returns `{ skip: boolean, reason: string, matched_rule?: string }`.

1. Walk **force-extract** rules first. First match wins → `skip=false`, `reason="force-extract: <rule.reason>"`, `matched_rule` set.
2. If no force-extract matches, walk **skip** rules. First match wins → `skip=true`, `reason="skip: <rule.reason>"`.
3. Else → `skip=false`, `reason="default"` (pass through to Sonnet).

Intent: a payment receipt labeled `CATEGORY_UPDATES` by Gmail would match the label-skip rule, BUT the `sender: @stripe` force-extract rule wins first → the message is extracted.

## Scopes

| scope     | compare against                                             |
|-----------|-------------------------------------------------------------|
| `sender`  | `From` header (lowercased email only, domain included)       |
| `subject` | `Subject` header (raw; no case normalization)                 |
| `header`  | presence-check on any raw RFC-822 header name (e.g., `List-ID`) |
| `label`   | Gmail `labelIds[]` array from `messages.get(format='full')`  |

## Actions

- `skip` — message is logged to `business/intelligence/email-extraction/<run_id>/skipped.jsonl` and never passed to Sonnet.
- `force-extract` — message is passed to Sonnet regardless of any skip rule that might otherwise match.

## Patterns

| scope   | regex                                                          | action         | reason |
|---------|----------------------------------------------------------------|----------------|--------|
| label   | `CATEGORY_SOCIAL`                                              | skip           | Gmail social (LinkedIn, FB, Twitter notifications) |
| label   | `CATEGORY_PROMOTIONS`                                          | skip           | Gmail promotions (marketing; payment force-extract wins) |
| label   | `CATEGORY_FORUMS`                                              | skip           | Gmail forums (mailing lists) |
| label   | `CATEGORY_UPDATES`                                             | skip           | Gmail updates (auto-reports; currency/payment patterns escape via force-extract) |
| sender  | `linkedin\.com$`                                               | skip           | belt-and-suspenders vs CATEGORY_SOCIAL |
| sender  | `noreply@github\.com`                                          | skip           | GitHub bot notifications |
| sender  | `(notifications@\|noreply@).*jira`                             | skip           | JIRA bot notifications |
| sender  | `noreply@namecheap\.com`                                       | skip           | domain renewal notices |
| sender  | `noreply@tcbs\.com\.vn`                                        | skip           | TCBS statements |
| sender  | `noreply@skool\.com`                                           | skip           | Skool community noise |
| sender  | `noreply@swissquote\.ch`                                       | skip           | Swissquote booking confirmations (non-business) |
| sender  | `@(techcombank\|stripe\|wise\|airwallex\|paypal\|revolut)\.`    | force-extract  | payment signal |
| sender  | `@(amadea\|umg\|fuga\|onerpm)\.`                                | force-extract  | known distributor/partner (override even if mis-labeled) |
| subject | `^(OTP\|Verification code\|One-time code\|Your code is)`       | skip           | security codes |
| subject | `^\[?(Delivery\|Undelivered\|Mail delivery)\b`                  | skip           | bounce / delivery receipts |
| subject | `(\$\|EUR\|VND\|USD\|GBP)\s*[0-9]{2,}`                          | force-extract  | monetary amount in subject |
| subject | `\b(payment\|invoice\|receipt\|statement\|remittance)\b`       | force-extract  | financial thread |
| subject | `\b(contract\|agreement\|NDA\|MOU)\b`                          | force-extract  | legal / commercial thread |
| header  | `List-ID`                                                       | skip           | bulk mailer |
| header  | `Auto-Submitted`                                                | skip           | RFC 3834 auto-response |

## Maintenance

- New patterns proposed by `/improve email-knowledge` cycle → appended as new rows; the table is parsed by `scripts/lib/junk-filter.ts` (split-on-pipe, first table in file).
- Escape `|` inside regex as `\|` (Markdown-table reserved).
- Escape backticks inside regex by using inline-code rows (not used in current table).
- Compile regexes case-insensitive by default; override with `(?-i)` prefix if case matters (rare).

## Parser contract

`junk-filter.ts` must:

1. Load this file (`references/junk-patterns.md`), find first table.
2. Parse rows; split into `force_extract` and `skip` lists, preserving order.
3. Compile regexes (cache in-process).
4. `evaluate(msg)` returns `{ skip, reason, matched_rule? }` per evaluation order above.
5. On ambiguous row (unknown scope or unparseable regex) → throw at load time, don't skip silently.
