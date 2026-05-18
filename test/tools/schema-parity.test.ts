/**
 * Schema-parity guard between OpenClaw plugin (typebox) and MCP tool
 * (zod). Compares the JSON Schema shapes of the SHARED fields so the
 * agent sees the same input contract regardless of host.
 *
 * Out-of-band: OpenClaw plugin's `brv-curate` includes a `meta` field
 * that the current MCP schema doesn't have (forward-compat for M4
 * curate-metadata). The parity check operates on the field *intersection*
 * and asserts that no MCP-only field is missing from the typebox side.
 *
 * When MCP gains `meta` (post-M4), add it to the MCP_* schemas below and
 * remove the `meta` from the `KNOWN_TYPEBOX_ONLY_FIELDS` allowlist.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { BrvCurateParameters } from "../../src/tools/brv-curate.js";
import { BrvQueryParameters } from "../../src/tools/brv-query.js";

// ---------------------------------------------------------------------------
// Hand-copied MCP zod schemas — keep in sync with byterover-cli's
// src/server/infra/mcp/tools/brv-{curate,query}-tool.ts. The schema-parity
// test fails loudly when MCP drifts so we can catch it during plugin review.
// ---------------------------------------------------------------------------

const MCP_BrvCurateInputSchema = z
  .object({
    confirmOverwrite: z.boolean().optional(),
    cwd: z.string().optional(),
    html: z.string().min(1),
  })
  .strict();

const MCP_BrvQueryInputSchema = z.object({
  cwd: z.string().optional(),
  limit: z.number().int().min(1).max(50).optional(),
  query: z.string(),
});

// Fields that the typebox (OpenClaw) side has but MCP doesn't yet. Tracks
// forward-compat plumbing; shrink as MCP catches up.
const KNOWN_TYPEBOX_ONLY_FIELDS = {
  "brv-curate": new Set(["meta"]),
  "brv-query": new Set<string>(),
};

// ---------------------------------------------------------------------------
// Comparison helpers
// ---------------------------------------------------------------------------

type JsonSchemaObject = {
  properties?: Record<string, unknown>;
  required?: string[];
};

function asJsonSchema(value: unknown): JsonSchemaObject {
  // zod-to-json-schema emits `{$schema, type: "object", properties, required, additionalProperties}`;
  // typebox schemas are themselves JSON Schema. Both have `properties` + `required`.
  return value as JsonSchemaObject;
}

/** Strip noise that legitimately differs between the libraries (descriptions,
 *  $schema URIs, $ref tables) — we only assert on the structural shape.
 *  Stringify + reparse first to drop typebox's Symbol-keyed marker properties. */
function normalizeFieldShape(field: unknown): unknown {
  if (typeof field !== "object" || field === null) return field;
  const plain = JSON.parse(JSON.stringify(field)) as Record<string, unknown>;
  delete plain.description;
  delete plain.$schema;
  delete plain.$id;
  // Both libraries sometimes emit `additionalProperties: false` for strict objects;
  // typebox doesn't unless told. Drop for the per-field check so strict/non-strict
  // doesn't cause spurious failures.
  delete plain.additionalProperties;
  return plain;
}

function assertSharedFieldsMatch(
  toolName: "brv-curate" | "brv-query",
  typeboxSchema: unknown,
  zodSchema: unknown,
): void {
  const tb = asJsonSchema(typeboxSchema);
  const zs = asJsonSchema(zodSchema);

  const tbProps = tb.properties ?? {};
  const zsProps = zs.properties ?? {};

  // 1. Every MCP property must exist on the typebox side (no missing fields).
  for (const fieldName of Object.keys(zsProps)) {
    expect(tbProps[fieldName], `${toolName}: typebox schema is missing MCP field "${fieldName}"`).toBeDefined();
  }

  // 2. Every typebox-only property must be on the allowlist (no accidental extras).
  const allowed = KNOWN_TYPEBOX_ONLY_FIELDS[toolName];
  for (const fieldName of Object.keys(tbProps)) {
    if (fieldName in zsProps) continue;
    expect(
      allowed.has(fieldName),
      `${toolName}: typebox has unknown extra field "${fieldName}" — add to KNOWN_TYPEBOX_ONLY_FIELDS or remove from typebox`,
    ).toBe(true);
  }

  // 3. Shared fields: normalize and compare.
  for (const fieldName of Object.keys(zsProps)) {
    const tbField = normalizeFieldShape(tbProps[fieldName]);
    const zsField = normalizeFieldShape(zsProps[fieldName]);
    expect(tbField, `${toolName}.${fieldName}: typebox ↔ zod shape drift`).toEqual(zsField);
  }

  // 4. `required` sets must match for shared fields.
  const sharedRequired = (tb.required ?? []).filter((f) => f in zsProps).sort();
  const zsRequired = (zs.required ?? []).sort();
  expect(sharedRequired, `${toolName}: required-field drift on shared fields`).toEqual(zsRequired);
}

// ---------------------------------------------------------------------------
// brv-curate
// ---------------------------------------------------------------------------

describe("schema parity — brv-curate", () => {
  it("typebox schema covers every MCP zod field", () => {
    const zSchema = z.toJSONSchema(MCP_BrvCurateInputSchema);
    assertSharedFieldsMatch("brv-curate", BrvCurateParameters, zSchema);
  });
});

// ---------------------------------------------------------------------------
// brv-query
// ---------------------------------------------------------------------------

describe("schema parity — brv-query", () => {
  it("typebox schema exactly matches MCP zod (no extras, no missing)", () => {
    const zSchema = z.toJSONSchema(MCP_BrvQueryInputSchema);
    assertSharedFieldsMatch("brv-query", BrvQueryParameters, zSchema);
  });
});
