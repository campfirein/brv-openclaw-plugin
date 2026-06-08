import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = dirname(fileURLToPath(import.meta.url));

// `@byterover/core` isn't published to npm; at build time `build.mjs` inlines it
// from the byterover-mono checkout. Tests resolve it the same way — alias to
// core's built dist (run `pnpm -F @byterover/core build` in byterover-mono once).
// Override the location with BYTEROVER_MONO_CORE_DIST.
const coreDist =
  process.env.BYTEROVER_MONO_CORE_DIST ||
  resolve(here, "..", "byterover-mono", "packages", "core", "dist", "index.js");

export default defineConfig({
  resolve: { alias: { "@byterover/core": coreDist } },
  test: { dir: "test" },
});
