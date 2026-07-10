import { test, expect } from "bun:test";

// Deliberate red test — one-shot E2E of the autofix listener (reverted right after).
test("ci-canary: deliberate failure to exercise autofix listener", () => {
  expect(1).toBe(2);
});
