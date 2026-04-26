---
name: vault-default-english
description: Vault content defaults to English unless audience is explicitly non-English
type: feedback
expected_tier: claude-md
last_validated: 2026-04-26
---

# Vault default language: English

## Rule

All notes written into `~/work/brain/` (the vault) must be in English by default. Switch to another language only when the file is content output for an explicitly non-English audience — e.g., AI Leaders Vietnam content drafts, which target a Vietnamese audience.

## Why

The vault is read by tools (grep, embeddings-based search, /research synthesis) that perform best on a single dominant language. Mixed-language content fragments retrieval and breaks the compounding effect of search over time — a query in English misses Vietnamese content covering the same topic, and vice versa. The exception for explicit-audience content is intentional: the audience is the customer, not the index.

## How to apply

This is a global commitment that applies across every conversation operating in the vault — not path-scoped (every vault path is in scope), not a multi-step workflow, not deterministic from tool inputs alone (judging "audience" needs context). Belongs in `~/work/brain/CLAUDE.md` as a short section so it auto-loads into every session that touches the vault.
