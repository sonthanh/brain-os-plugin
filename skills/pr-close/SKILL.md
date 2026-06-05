---
name: pr-close
description: "Close or merge a pull request the right way — run the 4-step hygiene sequence in order: reviewer-summary comment → squash-merge (PR title as the commit subject) → delete the remote branch → close linked tracker issues. Use whenever the user closes, merges, wraps up, lands, or finishes a PR, or says things like 'close this PR', 'merge and clean up', 'land this', 'wrap up the PR' — even if they don't spell out all four steps. The order is load-bearing; don't improvise it."
---

# pr-close — Land a PR with full hygiene

Closing a PR is four distinct chores, and the order matters. This skill runs them as one reliable sequence so nothing gets half-done — a merged PR with a dangling branch, or a shipped fix whose issue stays open, is exactly the drift this prevents.

## Config

The PR's commits land in the **code repo** (`brain-os-plugin`, `ai-leaders-vietnam`, whatever `gh repo view` reports). Linked issues usually live in a **separate tracker repo** — `gh_task_repo` in `${CLAUDE_PLUGIN_ROOT}/brain-os.config.md` (default `sonthanh/ai-brain`). That split is load-bearing for step 4: a bare `Closes #N` resolves against the *code* repo and silently does nothing.

## The sequence (run in this exact order)

The order is not cosmetic:
- The **comment comes first** because it reviews the still-open PR — after merge the diff is harder to talk about.
- **Squash before branch-delete** so the squash commit still references the branch's work.
- **Issue-close last** because it depends on the squash commit body carrying the close reference.

### 0. Gather context (read-only)

Run the prep script — it fetches PR metadata and builds the two strings that are easy to get wrong (the verbatim squash subject and the cross-repo close block), emitting them as JSON so the load-bearing logic is centralized + unit-tested, not improvised:

```bash
bun "${CLAUDE_PLUGIN_ROOT}/skills/pr-close/scripts/pr-close.ts" prepare \
  --pr <N> --tracker <gh_task_repo>
# → { number, title, subject, headRef, linkedIssues:[{repo,num}], closesBlock, ... }
```

Then read the human-judgment inputs for the review comment:

```bash
gh pr diff <N>            # what changed
gh pr checks <N>          # what CI verified (feeds "what was tested")
```

If `linkedIssues` is empty (the PR body declared no `Closes` / `Fixes` / `Resolves`), ask the user which tracker issue this lands — don't guess.

### Plan preview (before anything irreversible)

Merging is a destructive action on a remote — hard to undo. Show the user the plan and get a quick go-ahead, unless they already said "just merge it":

```
About to land PR #<N> "<title>":
  1. Comment:  <2-3 line reviewer summary>
  2. Squash-merge → subject "<PR title>", body closes <tracker>#<M>
  3. Delete branch <headRefName>
  4. Close <tracker>#<M> (+ strip status:* labels)
Proceed?
```

### 1. Reviewer-summary comment

Post a short review on the still-open PR: **what changed** (from the diff / commits) and **what was tested** (from `gh pr checks` + any testing notes in the PR). This is the durable record of why the merge was safe.

```bash
gh pr comment <N> --body "<what changed> · Tested: <what was verified>"
```

### 2 + 3. Squash-merge with PR title as subject, and delete the branch

One command does the squash (step 2) and the branch delete (step 3) in the correct order. Use the `subject` and `closesBlock` from the prep script — they carry the verbatim title and the cross-repo close reference, so a bare `Closes #N` (which would no-op against the code repo) can't sneak in:

```bash
gh pr merge <N> --squash --delete-branch \
  --subject "<subject from prepare>" \
  --body "<1-line summary>

<closesBlock from prepare>"
```

Pass `--subject` so the PR title verbatim becomes the squash subject — without it, gh appends ` (#N)`. `--delete-branch` removes the remote branch only *after* the merge lands.

### 4. Close the linked tracker issue(s) — via the central helper, not inline

Cross-repo `Closes <repo>#N` **does not always auto-fire**, so closing is not optional cleanup — it is a required step. Use the central close helper; never inline `gh issue close` (the helper also strips ghost `status:*` labels that a bare close leaves behind, and is idempotent if the merge already auto-closed the issue):

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/gh-tasks/close-issue.sh" <M>
```

Run it once per linked issue (use each `num` from `linkedIssues`). Note: `close-issue.sh` is hardwired to the default tracker `sonthanh/ai-brain`; if your `gh_task_repo` differs, close with `gh issue close <M> --repo <gh_task_repo> --reason completed` and strip any `status:*` labels yourself.

### Verify (fail loud)

Confirm each step actually took — a silent half-merge is the failure mode this skill exists to kill:

```bash
gh pr view <N> --json state,mergedAt              # state == MERGED
git ls-remote --heads origin <headRefName>        # empty output == branch gone
gh issue view <M> --repo <gh_task_repo> --json state   # state == CLOSED
```

If any check fails, say so explicitly and stop — do not log `pass`.

## Closing WITHOUT merging (abandon a PR)

If the user is rejecting / abandoning rather than landing: post a comment with the reason, run `gh pr close <N> --delete-branch`, and **leave linked issues open** — the work isn't done, so do NOT run `close-issue.sh`.

## Rules

- **Order is load-bearing.** Comment → squash → branch-delete → issue-close. Don't reorder to "save a step."
- **Cross-repo close reference.** `Closes <gh_task_repo>#N`, with the explicit repo prefix — a bare `Closes #N` targets the code repo and no-ops.
- **`close-issue.sh` is the only close site.** It strips `status:*` labels and is idempotent on already-closed issues. Inlining `gh issue close` re-leaks the ghost labels it was built to fix.
- **Plan preview before the merge** unless the user pre-authorized ("just merge"). Merging is the one irreversible step here.
- **PR title verbatim as the squash subject** — pass `--subject` so it doesn't drift.

## Outcome log

Append one line to `{vault}/daily/skill-outcomes/pr-close.log` (per `skill-spec.md § 11`):

```
{date} | pr-close | merge | {code_repo} | PR#{N} | commit:{squash-hash} | {result} | issue={M} args="{pr-title}"
```

- `result`: `pass` (all four steps verified), `partial` (merged but a follow-up step — branch delete or issue close — needed a manual retry), `fail` (merge blocked or PR rejected).
- For the abandon path use action `close` instead of `merge`, and `issue=none`.
