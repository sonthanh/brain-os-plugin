#!/usr/bin/env tsx
/**
 * Compose the Sonnet extraction prompt for a run:
 *   1. Read `prompts/extract.md` (generic template).
 *   2. Splice the user's internal-domains list into the Patch 3 placeholder.
 *   3. Splice the user's few-shot examples into the Few-Shot placeholder.
 *   4. Print composed prompt to stdout (SKILL.md captures it as $PROMPT_PREFIX).
 *
 * Contract: the composed output is the STABLE PREFIX across a run. It must not
 * change between batches, or prompt caching breaks.
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import { resolveSkillRoot } from "./lib/safety-net.js";
import { loadUserConfig } from "./lib/user-config.js";

function composePrompt(): string {
  const template = readFileSync(resolve(resolveSkillRoot(), "prompts/extract.md"), "utf-8");
  const { internal_domains, few_shot } = loadUserConfig();

  const domainsBlock = internal_domains.length
    ? internal_domains.map((d) => "`" + d + "`").join(", ")
    : "(none configured — Patch 3 will not fire)";

  const fewShotBlock = few_shot.trim()
    ? few_shot.replace(/<!--[\s\S]*?-->/g, "").trim()
    : "(no few-shot examples configured — extractions may be less consistent; add them to `{vault}/context/email-extract.md`)";

  return template
    .replace("{{INTERNAL_DOMAINS_LIST}}", domainsBlock)
    .replace("{{FEW_SHOT_EXAMPLES}}", fewShotBlock);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.stdout.write(composePrompt());
}

export { composePrompt };
