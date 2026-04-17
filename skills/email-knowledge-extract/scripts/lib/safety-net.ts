import { readFileSync, appendFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";

export function resolveVaultPath(): string {
  if (process.env.VAULT_PATH) return process.env.VAULT_PATH;
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || resolve(process.env.HOME!, "work/brain-os-plugin");
  const config = readFileSync(resolve(pluginRoot, "brain-os.config.md"), "utf-8");
  const match = config.match(/vault_path:\s*(.+)$/m);
  if (!match) throw new Error("brain-os.config.md missing `vault_path:` field");
  return match[1].trim();
}

export function resolveSkillRoot(): string {
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || resolve(process.env.HOME!, "work/brain-os-plugin");
  return resolve(pluginRoot, "skills/email-knowledge-extract");
}

export function runDir(runId: string): string {
  return resolve(resolveVaultPath(), "business/intelligence/email-extraction", runId);
}

function appendJsonl(path: string, obj: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(obj) + "\n");
}

export function writeSkipped(runId: string, entry: {
  msg_id: string;
  thread_id?: string;
  subject?: string;
  sender?: string;
  reason: string;
  matched_rule?: string;
}): void {
  appendJsonl(resolve(runDir(runId), "skipped.jsonl"), { ...entry, at: new Date().toISOString() });
}

export function writeRaw(runId: string, entry: {
  msg_id: string;
  thread_id?: string;
  sonnet_output: unknown;
}): void {
  appendJsonl(resolve(runDir(runId), "raw-extractions.jsonl"), { ...entry, at: new Date().toISOString() });
}

export function writeWarning(runId: string, entry: {
  msg_id: string;
  warning: string;
  [k: string]: unknown;
}): void {
  appendJsonl(resolve(runDir(runId), "warnings.jsonl"), { ...entry, at: new Date().toISOString() });
}

export function writeFailed(runId: string, entry: {
  msg_id: string;
  error: string;
  attempts: number;
  detail?: string;
}): void {
  appendJsonl(resolve(runDir(runId), "failed.jsonl"), { ...entry, at: new Date().toISOString() });
}
