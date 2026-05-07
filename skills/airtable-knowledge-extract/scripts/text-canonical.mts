#!/usr/bin/env bun
/**
 * text-canonical.mts — Shared text canonicalisation primitive (#251).
 *
 * Used by:
 *   - extract-text-field-entities.mts (S5b): dedup key + slug source
 *   - emit-edges.mts (S7): from/to slug derivation
 *
 * The single-source-of-truth normalisation guarantees that the slug emitted
 * for value V on a Person page (`john-doe.md`) matches the slug emitted for
 * value V in an edge endpoint (`{from: "john-doe"}`). Drift between the two
 * would create orphan slug references in the entity graph.
 *
 * Operations (in order):
 *   1. NFKC normalise — collapses Unicode compatibility variants (e.g.
 *      half-width to full-width, ligatures, ﬃ → ffi).
 *   2. Trim leading + trailing whitespace.
 *   3. Collapse internal whitespace runs to single ASCII space.
 *   4. Lowercase.
 *
 * Pure: no I/O, no side effects. Cheap enough to call per record per field.
 */
export function canonicalName(s: string): string {
  return s.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}
