export const INTERNAL_DOMAINS = [
  "emvn.co",
  "melosy.net",
  "melosy.com",
  "melosymusic.com",
  "musicmaster.io",
  "tunebot.io",
  "songgen.ai",
  "cremi.ai",
  "cremi.com",
  "dzus.vn",
];

export interface ExtractionResult {
  email_id: string;
  one_line: string;
  people: PersonResult[];
  companies: CompanyResult[];
  meetings: MeetingResult[];
  decisions: DecisionResult[];
  skip: boolean;
  skip_reason: string | null;
}

export interface PersonResult {
  name: string;
  email: string;
  role: string;
  worth_page: boolean;
  reason: string;
}

export interface CompanyResult {
  name: string;
  domain: string;
  context: string;
  worth_page: boolean;
  reason: string;
}

export interface MeetingResult {
  uid: string;
  subject: string;
  date: string;
  attendees: string[];
  context: string;
}

export interface DecisionResult {
  text: string;
  amount: string;
  type: "financial" | "strategic" | "operational";
  actors: string[];
}

export type ValidateError =
  | { kind: "parse_error"; detail: string }
  | { kind: "schema_error"; detail: string };

export type ValidateOutcome =
  | { ok: true; result: ExtractionResult }
  | { ok: false; error: ValidateError };

function isString(x: unknown): x is string {
  return typeof x === "string";
}

function isBool(x: unknown): x is boolean {
  return typeof x === "boolean";
}

function isStrArray(x: unknown): x is string[] {
  return Array.isArray(x) && x.every(isString);
}

function validatePerson(p: any, idx: number): string | null {
  if (!p || typeof p !== "object") return `people[${idx}] not an object`;
  if (!isString(p.name))       return `people[${idx}].name missing/not-string`;
  if (!isString(p.email))      return `people[${idx}].email missing/not-string`;
  if (!isString(p.role))       return `people[${idx}].role missing/not-string`;
  if (!isBool(p.worth_page))   return `people[${idx}].worth_page missing/not-boolean`;
  if (!isString(p.reason))     return `people[${idx}].reason missing/not-string`;
  return null;
}

function validateCompany(c: any, idx: number): string | null {
  if (!c || typeof c !== "object") return `companies[${idx}] not an object`;
  if (!isString(c.name))       return `companies[${idx}].name missing/not-string`;
  if (!isString(c.domain))     return `companies[${idx}].domain missing/not-string`;
  if (!isString(c.context))    return `companies[${idx}].context missing/not-string`;
  if (!isBool(c.worth_page))   return `companies[${idx}].worth_page missing/not-boolean`;
  if (!isString(c.reason))     return `companies[${idx}].reason missing/not-string`;
  return null;
}

function validateMeeting(m: any, idx: number): string | null {
  if (!m || typeof m !== "object") return `meetings[${idx}] not an object`;
  if (!isString(m.uid))         return `meetings[${idx}].uid missing/not-string`;
  if (!isString(m.subject))     return `meetings[${idx}].subject missing/not-string`;
  if (!isString(m.date))        return `meetings[${idx}].date missing/not-string`;
  if (!isStrArray(m.attendees)) return `meetings[${idx}].attendees missing/not-string[]`;
  if (!isString(m.context))     return `meetings[${idx}].context missing/not-string`;
  return null;
}

function validateDecision(d: any, idx: number): string | null {
  if (!d || typeof d !== "object") return `decisions[${idx}] not an object`;
  if (!isString(d.text))       return `decisions[${idx}].text missing/not-string`;
  if (!isString(d.amount))     return `decisions[${idx}].amount missing/not-string`;
  if (!["financial","strategic","operational"].includes(d.type)) return `decisions[${idx}].type invalid`;
  if (!isStrArray(d.actors))   return `decisions[${idx}].actors missing/not-string[]`;
  return null;
}

export function validate(rawText: string, expectedEmailId: string): ValidateOutcome {
  let data: any;
  try {
    data = JSON.parse(rawText);
  } catch (e) {
    return { ok: false, error: { kind: "parse_error", detail: String(e) } };
  }
  if (!data || typeof data !== "object") {
    return { ok: false, error: { kind: "schema_error", detail: "top-level not an object" } };
  }
  if (!isString(data.email_id)) return fail("email_id missing/not-string");
  if (data.email_id !== expectedEmailId) return fail(`email_id mismatch: expected ${expectedEmailId}, got ${data.email_id}`);
  if (!isString(data.one_line)) return fail("one_line missing/not-string");
  if (!isBool(data.skip))       return fail("skip missing/not-boolean");
  if (data.skip_reason !== null && !isString(data.skip_reason)) return fail("skip_reason must be null or string");
  for (const key of ["people","companies","meetings","decisions"] as const) {
    if (!Array.isArray(data[key])) return fail(`${key} not an array`);
  }
  for (let i = 0; i < data.people.length; i++)    { const e = validatePerson(data.people[i], i);     if (e) return fail(e); }
  for (let i = 0; i < data.companies.length; i++) { const e = validateCompany(data.companies[i], i); if (e) return fail(e); }
  for (let i = 0; i < data.meetings.length; i++)  { const e = validateMeeting(data.meetings[i], i);  if (e) return fail(e); }
  for (let i = 0; i < data.decisions.length; i++) { const e = validateDecision(data.decisions[i], i); if (e) return fail(e); }
  if (data.skip === true) {
    if (data.people.length || data.companies.length || data.meetings.length || data.decisions.length) {
      return fail("skip=true but entity arrays non-empty");
    }
  }
  return { ok: true, result: data as ExtractionResult };
}

function fail(detail: string): ValidateOutcome {
  return { ok: false, error: { kind: "schema_error", detail } };
}

export function isExtractedEmpty(r: ExtractionResult): boolean {
  return !r.skip && r.people.length === 0 && r.companies.length === 0 && r.meetings.length === 0 && r.decisions.length === 0;
}

export interface Warning {
  msg_id: string;
  warning: string;
  [k: string]: unknown;
}

const INTERNAL_NAME_TOKENS = Array.from(new Set(INTERNAL_DOMAINS.map((d) => d.split(".")[0])));

export function patch3Warnings(r: ExtractionResult): Warning[] {
  const out: Warning[] = [];
  for (const c of r.companies) {
    const domain = (c.domain || "").toLowerCase();
    const name = (c.name || "").toLowerCase();
    const domainMatch = !!domain && INTERNAL_DOMAINS.some((d) => domain === d || domain.endsWith("." + d));
    const nameParts = name.split(/[^a-z0-9]+/).filter(Boolean);
    const nameMatch = !domainMatch && nameParts.some((p) => INTERNAL_NAME_TOKENS.includes(p));
    if (!domainMatch && !nameMatch) continue;
    const subjectInDecision = r.decisions.some((d) =>
      d.actors.some((a) => a.trim().toLowerCase() === c.name.trim().toLowerCase())
    );
    if (!subjectInDecision) {
      out.push({
        msg_id: r.email_id,
        warning: "internal_team_as_company",
        company: c.name,
        domain: domain || null,
      });
    }
  }
  return out;
}
