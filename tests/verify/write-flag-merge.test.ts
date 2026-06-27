// Behavior contract for verify.py's audit-flag writer (issue #320 AC#5).
//
// The live audit-flag.json for the-road-less-stupid carries 7 keys — the 4
// verify.py manages (flag/last_audit/audit_score/changed_by) PLUS keys written
// by the self-learn pipeline (pipeline_completed/ingested/absorbed) and the
// notebook binding (notebook_id). write_flag must MERGE: refresh the managed
// keys, preserve everything else. The pre-#320 implementation rebuilt the dict
// from scratch and silently dropped the extra keys.
//
// Tested through the public CLI (`--set-flag`), not the private function — a
// real code path that survives internal refactors (per /tdd philosophy).

import { test, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const VERIFY_PY = join(import.meta.dir, "..", "..", "skills", "verify", "scripts", "verify.py");

test("--set-flag preserves pre-existing audit-flag.json keys (merge, not clobber)", () => {
  const root = mkdtempSync(join(tmpdir(), "verify-merge-"));
  try {
    const book = join(root, "test-book");
    mkdirSync(join(book, "_validation"), { recursive: true });
    // discover_books() requires a non-_validation .md note to surface the book
    writeFileSync(join(book, "concept.md"), "# Concept\nbody\n");

    const seeded = {
      flag: "false",
      last_audit: "2020-01-01T00:00:00",
      audit_score: "old-score",
      changed_by: "seed",
      pipeline_completed: "2026-04-04T12:00:00",
      ingested: true,
      absorbed: true,
      notebook_id: "abc-123",
    };
    const flagPath = join(book, "_validation", "audit-flag.json");
    writeFileSync(flagPath, JSON.stringify(seeded, null, 2));

    execFileSync("python3", [VERIFY_PY, root, "--set-flag", "true", "test-book"], { encoding: "utf8" });

    const after = JSON.parse(readFileSync(flagPath, "utf8"));

    // managed keys refreshed
    expect(after.flag).toBe("true");
    expect(after.changed_by).toBe("user");
    expect(after.last_audit).not.toBe(seeded.last_audit);
    // audit_score preserved when not supplied (pre-existing behavior, must not regress)
    expect(after.audit_score).toBe("old-score");
    // extra keys preserved (the clobber bug this test pins)
    expect(after.pipeline_completed).toBe("2026-04-04T12:00:00");
    expect(after.ingested).toBe(true);
    expect(after.absorbed).toBe(true);
    expect(after.notebook_id).toBe("abc-123");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
