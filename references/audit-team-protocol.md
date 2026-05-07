# Audit-team protocol — shared by all `principle-auditor-pN` subagents

This is the single-source-of-truth for the workflow protocol shared by all 5 principle-auditor subagent definitions (`agents/principle-auditor-p{1..5}.md`). Each per-principle definition embeds ONLY the principle text + calibration notes + per-principle scope_flag handling; everything else lives here.

When this file is updated, all 5 principles inherit the change automatically — no per-file fan-out edits, no risk of drift across principles.

## Spawn-prompt context (embedded by the lead)

The lead's `/audit --team` flow embeds these variables verbatim in each teammate's spawn prompt:

- `AUDIT_RUN_DIR` — absolute path like `~/.claude/audit-runs/audit-1715000000/`
- `AGENT_NAME` — your name, e.g. `p1-a` or `p1-b`
- `WITHIN_PRINCIPLE_PEER` — name of your within-principle peer (e.g. `p1-b`) when N>1, or `null` when N=1
- `CROSS_PRINCIPLE_LEADS` — array of 4 names: lead agent for each of the OTHER 4 principles, e.g. `["p2-a", "p3-a", "p4-a", "p5-a"]`
- `AUDIT_CONTEXT` — full text of the artifact under audit, embedded verbatim. Treat this as the entire input — do NOT search for additional context.
- `ROUND_BUDGET` — 3 (default; configurable per run). Hard cap on rounds.
- `PROTOCOL_PATH` — absolute path to this file (`references/audit-team-protocol.md` resolved against the active plugin root). The lead embeds it so the teammate doesn't need to discover it.

If any of `AUDIT_RUN_DIR`, `AGENT_NAME`, `CROSS_PRINCIPLE_LEADS`, `AUDIT_CONTEXT`, or `ROUND_BUDGET` is missing from the spawn prompt, write a minimal JSON with `verdict: "FAIL"`, `key_finding: "spawn prompt missing required variables: <list>"` to `{AUDIT_RUN_DIR}/agent-{AGENT_NAME}.json`, then idle. Do not attempt the audit.

## Output protocol — single per-teammate JSON file

You write to ONE file only: `{AUDIT_RUN_DIR}/agent-{AGENT_NAME}.json`. Never write any other file. Never edit project files. Never write a shared `consensus.json` (the lead synthesises that post-aggregation).

Schema (all rounds use the same schema; you update the file each round):

```json
{
  "agent_name": "p1-a",
  "principle": "P1",
  "round": 3,
  "verdict": "PASS|FLAG|FAIL",
  "key_finding": "one-line summary, ≤140 chars",
  "full_finding": "prose with evidence quoted from AUDIT_CONTEXT",
  "scope_flag": null,
  "within_principle_vote": {
    "self": "FAIL",
    "peers": [{"name": "p1-b", "verdict": "FAIL"}],
    "agreed": true
  },
  "cross_principle_signatures": [
    {"principle": "P2", "agent": "p2-a", "agreed_with_their_finding": true,  "reason": "..."},
    {"principle": "P3", "agent": "p3-a", "agreed_with_their_finding": true,  "reason": "..."},
    {"principle": "P4", "agent": "p4-a", "agreed_with_their_finding": true,  "reason": "..."},
    {"principle": "P5", "agent": "p5-a", "agreed_with_their_finding": false, "reason": "..."}
  ],
  "calibration_notes_applied": true,
  "dissent_acknowledged": false
}
```

Per-principle notes:

- `scope_flag` is used by **P2 only** (`local|meta|ambiguous`) and **P3 only** (`content|architecture`). Other principles leave it `null`.
- `within_principle_vote.peers` is `[]` when N=1; `agreed` is `true` by convention in that case.
- For P5, the `full_finding` should include an enumerated invariant table (cause-guard vs effect-guard count) per the P5 severity rubric.

## 3-round protocol — run all rounds in one turn

**Do NOT idle between rounds.** Run the full 3-round protocol within ONE agent turn, polling the filesystem for peer JSONs between rounds.

### Round 1 — Initial verdict

1. Read `AUDIT_CONTEXT` from your spawn prompt verbatim. Do NOT re-fetch the source file from the vault — the embedded text is the single source of truth.
2. Audit the context through YOUR principle ONLY. Apply your per-principle calibration notes (in your subagent definition file). Do NOT consider other principles — those are other agents' jobs.
3. (P2 + P3 only) Pick `scope_flag` per the per-principle calibration. Lock it for the entire run.
4. Form your verdict (`PASS|FLAG|FAIL`) + a one-line `key_finding` (≤140 chars) + a `full_finding` prose with evidence quoted from `AUDIT_CONTEXT`.
5. Write `{AUDIT_RUN_DIR}/agent-{AGENT_NAME}.json` with `round: 1`. Leave `within_principle_vote.peers = []` and `cross_principle_signatures = []` initially.

### Round 2 — Within-principle vote (skip if N=1)

6. If `WITHIN_PRINCIPLE_PEER == null`: set `within_principle_vote = {self: <your verdict>, peers: [], agreed: true}` and skip to Round 3.
7. Otherwise: poll `{AUDIT_RUN_DIR}/agent-{WITHIN_PRINCIPLE_PEER}.json` until it exists with `round >= 1`. Use the timeout-guarded polling pattern in § Polling pattern below.
8. **Your `verdict` (and `scope_flag`, where applicable) is LOCKED at round 1.** Do NOT change it in round 2 or 3, regardless of any DM content from your peer. Round 2 is comparison + optional context-sharing, NOT verdict mutation. Mutating mid-reconciliation introduces the within-principle stale-read race where both peers swap verdicts and each ends up reporting `agreed: true` against the other's pre-swap state. (Empirically observed in the 2026-05-07 dogfood run on the 2026-05-04 fixture: p2-a flipped FLAG → PASS, p2-b flipped PASS → FLAG, both reported `agreed: true` — fixed by encoding the verdict-lock invariant.)
9. Read peer's `verdict` (and `scope_flag`, where applicable). Both are their round-1 frozen values.
   - **Same verdict + same scope** → `within_principle_vote = {self: <verdict>, peers: [{name: <peer>, verdict: <peer.verdict>}], agreed: true}`.
   - **Different verdict OR (P2/P3) different scope** → `agreed: false`, `dissent_acknowledged: true`, both states recorded in `peers`. Optionally DM peer ONCE for context-sharing via `SendMessage(to: <peer>, summary: "<P> dissent context", message: "I voted <X> on '<finding>'; you voted <Y>. My reasoning: <one paragraph>. (Verdicts are locked at round 1; this DM is for cross-principle round-3 context-sharing only.)")`. Do NOT wait for a response — peer cannot change verdict either.
10. Update your JSON: `round: 2`, `within_principle_vote` populated. **Do NOT touch `verdict` or `scope_flag`.**

### Round 3 — Cross-principle signature

11. Poll for ALL 4 `CROSS_PRINCIPLE_LEADS` JSONs to exist with `round >= 2`. Same timeout-guarded polling discipline. If a peer file is missing past timeout, sign them as `agreed_with_their_finding: false` with `reason: "peer JSON absent at round-3 deadline"`.
12. For EACH of the 4 cross-principle leads, read their `full_finding` and decide if you agree their finding is **internally consistent with their stated principle** (NOT whether their principle applies to your concern). Sign with `agreed_with_their_finding: true|false` + a one-line `reason`.
13. If a finding contradicts yours in a substantive way, DM the relevant peer ONCE with the conflict and propose a reconciliation question. Wait up to 60s for their reply, then sign your final stance. Do NOT mutate your own `verdict`.
14. Update your JSON: `round: 3`, `cross_principle_signatures` array populated with 4 entries.
15. Send a final completion message to the lead: `SendMessage(to: "team-lead", summary: "<P> audit complete", message: "round 3 done; verdict: <X>; within-principle agreed: <bool>; signatures: 4/4")`.
16. Idle. The TeammateIdle hook will observe completion and the lead will aggregate.

## Polling pattern — timeout-guarded (load-bearing)

Use this exact bash pattern for every "poll filesystem for peer JSON" step. The 5-minute hard timeout is non-negotiable: if a peer file doesn't materialize, set `dissent_acknowledged: true` in your own JSON and fall through to the next round (or terminate the run if you're already at round 3). Never use a bare `until test -f <path>; do sleep 5; done` — it can hang past the lead's outer timeout and force a kill with no diagnostic.

```bash
PEER_PATH="$AUDIT_RUN_DIR/agent-$WITHIN_PRINCIPLE_PEER.json"
deadline=$(($(date +%s) + 300))   # 5 min from now
TIMEOUT_HIT=false
while [ "$(date +%s)" -lt "$deadline" ]; do
  if [ -f "$PEER_PATH" ] && jq -e '.round >= 1' "$PEER_PATH" >/dev/null 2>&1; then
    break  # success
  fi
  sleep 5
done
if [ "$(date +%s)" -ge "$deadline" ]; then
  TIMEOUT_HIT=true   # peer absent — fall through with dissent_acknowledged
fi
```

For the round-3 cross-principle wait (4 leads), use the same pattern but check ALL 4 paths inside the loop and break only when all 4 are present at `round >= 2`.

## Round budget — escalation on overrun

`ROUND_BUDGET` defaults to 3. If you reach round 3 without the cross-principle peers' files materializing, set `dissent_acknowledged: true` in your JSON and idle anyway. Do NOT loop into round 4 — the lead and the `TeammateIdle` hook handle escalation. The 3-round cap is hard.

## Shutdown protocol — REQUIRED (prevents TeamDelete deadlock)

The team-lead's `TeamDelete()` step sends each teammate a `SendMessage` with body `{"type": "shutdown_request", "request_id": "...", "reason": "..."}` and waits for ALL teammates to respond before completing. Failing to respond hangs the lead's process indefinitely (and any wrapping `claude -p --plugin-dir ... /audit --team` smoke-test subprocess waiting on `proc.exited`).

**As soon as you receive a `shutdown_request`, IMMEDIATELY respond — before any other work — with:**

```json
{"to": "team-lead", "message": {"type": "shutdown_response", "request_id": "<echo the request_id from inbound>", "approve": true, "reason": "audit complete"}}
```

Use the `SendMessage` tool. Do NOT delay. Do NOT do additional audit work. After approving, your process terminates. If `shutdown_request` arrives BEFORE round-3 JSON is written (e.g. the lead is timing out the run), still respond `approve: true` — your final state in `agent-{AGENT_NAME}.json` is what matters; the lead handles partial-completion downstream via the variance metric (`partial:P3-no-peer`, etc.).

## DM-debate hygiene

- DM only via `SendMessage`. Never write to peers' JSON files.
- Refer to peers by NAME (e.g. `p2-a`), never by UUID.
- Keep DMs short and specific: one reconciliation question or one paragraph of context per DM. No status pings.
- If a peer asks YOU a question, answer once with evidence quoted from `AUDIT_CONTEXT`, then return to your protocol.

## Forbidden actions (apply to ALL principles)

- Editing or writing any file other than `{AUDIT_RUN_DIR}/agent-{AGENT_NAME}.json`.
- Running long shell commands beyond filesystem polling, file reads, and `grep` on `AUDIT_CONTEXT`.
- Reading other principles' tracker.md text and applying them — you audit through YOUR ASSIGNED PRINCIPLE ONLY.
- Looping past `ROUND_BUDGET`.
- Using the `advisor` tool — it forwards conversation transcript and breaks the per-principle isolation contract.
- Using a bare `until test -f` polling pattern without the explicit deadline guard above.
- Mutating `verdict` or `scope_flag` after round 1 (race-safety).
- Failing to respond to a `shutdown_request` (deadlock-safety).
