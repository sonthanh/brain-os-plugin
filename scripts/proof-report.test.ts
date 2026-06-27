import { test, expect, describe } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import {
  parseAcceptanceBullets,
  parseEvidenceFromComment,
  classifyAc,
  computeProof,
  renderProofReport,
  buildResultsToStory,
  fromClosedStory,
  type GhReader,
  type AcBullet,
  type EvidenceLine,
} from "./proof-report";

// Synthetic, structurally-faithful fixtures (this repo is public — no real issue
// bodies). story-proven mirrors a closed story with all ACs verified; story-partial
// mirrors one with only some verified. The renderer was ALSO validated live against
// real GitHub stories (#196 PROVEN / #301 PARTIAL) — read-only, nothing committed.
const FIX = `${import.meta.dir}/fixtures/proof-report`;
const loadFixture = (name: string) => Bun.file(`${FIX}/${name}.json`).json();
const fakeReader = (fixture: any): GhReader => ({ async view() { return fixture; } });
const NOW = "2026-06-27 00:00:00 UTC";

// ── §3.1 parent-AC parsing (with tick state) ────────────────────────────────
describe("parseAcceptanceBullets", () => {
  test("captures id, tick, stripped criterion, coveredBy, evidenceUrl", () => {
    const body = [
      "## Acceptance",
      "",
      "- [x] **AC#1** — Gate A: /slice refuses to file children — [evidence ↗](https://x/issues/196#issuecomment-1) covered by #199",
      "- [ ] **AC#2** — second criterion with no evidence link yet",
    ].join("\n");
    const b = parseAcceptanceBullets(body);
    expect(b.length).toBe(2);
    expect(b[0]).toMatchObject({
      id: 1,
      ticked: true,
      text: "Gate A: /slice refuses to file children",
      coveredBy: [199],
      evidenceUrl: "https://x/issues/196#issuecomment-1",
    });
    expect(b[1]).toMatchObject({ id: 2, ticked: false, coveredBy: [] });
    expect(b[1].evidenceUrl).toBeUndefined();
  });

  test("rejects hyphen-instead-of-emdash and bare AC# (per §3.1)", () => {
    const body = [
      "- [ ] **AC#1** - hyphen not em-dash",
      "- [ ] AC#2 — missing bold",
    ].join("\n");
    expect(parseAcceptanceBullets(body)).toEqual([]);
  });

  test("proven-story body → 9 AC bullets (ids 1-8,10), all ticked", async () => {
    const j = await loadFixture("story-proven");
    const b = parseAcceptanceBullets(j.body);
    expect(b.map((x) => x.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 10]);
    expect(b.every((x) => x.ticked)).toBe(true);
  });
});

// ── §3.3 / §3.5 evidence parsing ────────────────────────────────────────────
describe("parseEvidenceFromComment", () => {
  test("parses §3.3 parent-form, §3.5 self-verified and self-deferred", () => {
    const body = [
      "Acceptance verified: AC#1 — replayed prior story; commit abc1234",
      "Self acceptance verified: AC#2 — bun test: 12 pass, 0 fail",
      "Self acceptance deferred: AC#3 — live-ops only, not a code change",
    ].join("\n");
    const ev = parseEvidenceFromComment(body, { commentUrl: "u", sourceIssue: 9 });
    expect(ev).toEqual([
      { acId: 1, kind: "verified", text: "replayed prior story; commit abc1234", commentUrl: "u", sourceIssue: 9 },
      { acId: 2, kind: "self-verified", text: "bun test: 12 pass, 0 fail", commentUrl: "u", sourceIssue: 9 },
      { acId: 3, kind: "deferred", text: "live-ops only, not a code change", commentUrl: "u", sourceIssue: 9 },
    ]);
  });

  test("anchors are disjoint — a Self line is not double-counted as parent-form", () => {
    const ev = parseEvidenceFromComment("Self acceptance verified: AC#7 — ok");
    expect(ev.length).toBe(1);
    expect(ev[0].kind).toBe("self-verified");
  });

  test("rejects hyphen and missing-prefix lines", () => {
    const body = [
      "Acceptance verified: AC#1 - hyphen",
      "AC#1 verified — looks good",
    ].join("\n");
    expect(parseEvidenceFromComment(body)).toEqual([]);
  });
});

// ── join + verdict ──────────────────────────────────────────────────────────
describe("classifyAc + computeProof", () => {
  const ac = (id: number, ticked: boolean): AcBullet => ({ id, text: `c${id}`, ticked, coveredBy: [] });
  const ev = (acId: number, kind: EvidenceLine["kind"]): EvidenceLine => ({ acId, kind, text: "t" });

  test("verified wins over tick state", () => {
    expect(classifyAc(ac(1, false), [ev(1, "verified")])).toBe("verified");
    expect(classifyAc(ac(1, true), [ev(1, "self-verified")])).toBe("verified");
  });
  test("deferred when only a deferred line exists", () => {
    expect(classifyAc(ac(1, false), [ev(1, "deferred")])).toBe("deferred");
  });
  test("ticked-no-evidence vs unverified", () => {
    expect(classifyAc(ac(1, true), [])).toBe("ticked-no-evidence");
    expect(classifyAc(ac(1, false), [])).toBe("unverified");
  });

  test("overall PROVEN / PARTIAL / UNPROVEN", () => {
    const story = (acceptance: AcBullet[], evidence: EvidenceLine[]) => ({
      parent: { number: 1, title: "t", url: "u", acceptance },
      evidence,
      generatedAt: NOW,
    });
    expect(computeProof(story([ac(1, true), ac(2, true)], [ev(1, "verified"), ev(2, "verified")])).overall).toBe("PROVEN");
    expect(computeProof(story([ac(1, true), ac(2, false)], [ev(1, "verified")])).overall).toBe("PARTIAL");
    expect(computeProof(story([ac(1, false)], [])).overall).toBe("UNPROVEN");
  });

  test("deferred ACs are excluded from in-scope; all-verified-rest → PROVEN", () => {
    const r = computeProof({
      parent: { number: 1, title: "t", url: "u", acceptance: [ac(1, true), ac(2, false)] },
      evidence: [ev(1, "verified"), ev(2, "deferred")],
      generatedAt: NOW,
    });
    expect(r.overall).toBe("PROVEN");
    expect(r.counts).toMatchObject({ total: 2, inScope: 1, verified: 1, deferred: 1, unproven: 0 });
  });
});

// ── live replay (the e2e of the renderer, fixture-injected — no network) ─────
describe("fromClosedStory (synthetic fixtures)", () => {
  test("proven story → PROVEN, all 9 ACs verified", async () => {
    const story = await fromClosedStory(9001, "owner/repo", NOW, fakeReader(await loadFixture("story-proven")));
    const r = computeProof(story);
    expect(r.overall).toBe("PROVEN");
    expect(r.counts).toMatchObject({ total: 9, inScope: 9, verified: 9, unproven: 0 });
    const md = renderProofReport(story);
    expect(md).toContain("## Verdict: ✅ PROVEN");
    expect(md).toContain("AC#1");
    expect(md).toMatch(/9\/9 in-scope acceptance criteria verified/);
  });

  test("partial story → PARTIAL, exactly AC#1/2/4 verified", async () => {
    const story = await fromClosedStory(9301, "owner/repo", NOW, fakeReader(await loadFixture("story-partial")));
    const r = computeProof(story);
    expect(r.overall).toBe("PARTIAL");
    expect(r.counts.total).toBe(7);
    expect(r.counts.verified).toBe(3);
    const verifiedIds = r.acProofs.filter((p) => p.verdict === "verified").map((p) => p.ac.id).sort();
    expect(verifiedIds).toEqual([1, 2, 4]);
    expect(renderProofReport(story)).toContain("## Verdict: ⚠️ PARTIAL");
  });
});

// ── in-process adapter (autodev Workflow path) ───────────────────────────────
describe("buildResultsToStory", () => {
  const parent = {
    number: 500,
    title: "Story: autodev demo",
    url: "https://x/500",
    body: "## Acceptance\n\n- [ ] **AC#1** — render proof\n- [ ] **AC#2** — wire chain\n",
  };
  test("passed child → verified AC; escalated child → unproven AC", () => {
    const story = buildResultsToStory({
      goal: "demo",
      parent,
      generatedAt: NOW,
      results: [
        { issue: 501, coversAc: [1], status: "pass", testSummary: "bun test: 8 pass", commit: "deadbee" },
        { issue: 502, coversAc: [2], status: "escalated" },
      ],
    });
    const r = computeProof(story);
    expect(r.overall).toBe("PARTIAL");
    const byId = Object.fromEntries(r.acProofs.map((p) => [p.ac.id, p.verdict]));
    expect(byId[1]).toBe("verified");
    expect(byId[2]).toBe("unverified");
    const md = renderProofReport(story);
    expect(md).toContain("bun test: 8 pass; commit deadbee");
    expect(md).toContain("# Proof report — demo");
  });

  test("dryRun renders the DRY-RUN banner", () => {
    const story = buildResultsToStory({
      goal: "demo",
      parent,
      generatedAt: NOW,
      dryRun: true,
      results: [{ issue: 501, coversAc: [1, 2], status: "pass(dry)" }],
    });
    expect(renderProofReport(story)).toContain("**DRY RUN**");
  });
});

// ── CLI: --build-results mode (integration via spawn) ────────────────────────
describe("CLI --build-results", () => {
  test("renders a report from a build-results JSON file and writes --out", async () => {
    const tmp = join(tmpdir(), "autodev-cli-build.json");
    const out = join(tmpdir(), "autodev-cli-out.md");
    await Bun.write(
      tmp,
      JSON.stringify({
        goal: "cli demo",
        dryRun: true,
        parent: { number: 9, title: "S", url: "u", body: "## Acceptance\n- [ ] **AC#1** — x\n" },
        results: [{ issue: 10, coversAc: [1], status: "pass(dry)", testSummary: "ran" }],
      }),
    );
    const proc = Bun.spawn(
      ["bun", "run", `${import.meta.dir}/proof-report.ts`, "--build-results", tmp, "--out", out],
      { stdout: "pipe", stderr: "pipe" },
    );
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    expect(stdout).toContain("# Proof report — cli demo");
    expect(stdout).toContain("**DRY RUN**");
    const written = await Bun.file(out).text();
    expect(written).toContain("AC#1");
    // cleanup
    await Bun.file(tmp).delete().catch(() => {});
    await Bun.file(out).delete().catch(() => {});
  });
});
