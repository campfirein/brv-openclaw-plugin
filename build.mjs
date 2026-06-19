#!/usr/bin/env node
/**
 * Bundle the plugin into a single self-contained `dist/index.js` with
 * `@byterover/core` inlined.
 *
 * Why bundle (not tsc): `@byterover/core` is NOT published to npm, so a plain
 * `tsc` build would emit `require("@byterover/core")` that consumers can't
 * resolve. We inline core (it's `child_process`-free) so the published artifact
 * is standalone AND passes OpenClaw's install scanner (no `child_process`
 * anywhere in dist). Recall runs in-process via core; record stays an agent
 * tool. See docs / src/recall.ts.
 *
 * Build-time dependency: byterover-mono must be present (default: sibling repo
 * `../byterover-mono`; override with BYTEROVER_MONO_CORE → core's src/index.ts).
 * The published dist needs none of this.
 */
import { build } from "esbuild";
import { rmSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const coreEntry =
  process.env.BYTEROVER_MONO_CORE ||
  resolve(here, "..", "byterover-mono", "packages", "core", "src", "index.ts");

if (!existsSync(coreEntry)) {
  console.error(
    `✗ @byterover/core source not found at:\n    ${coreEntry}\n` +
      `  Place byterover-mono as a sibling repo, or set BYTEROVER_MONO_CORE to core's src/index.ts.`,
  );
  process.exit(1);
}

// Map Node16/NodeNext-style relative `./x.js` specifiers to their `.ts` source
// (covers both this plugin's src and byterover-mono core's internal imports).
const resolveTsPlugin = {
  name: "resolve-ts",
  setup(b) {
    b.onResolve({ filter: /^\.\.?\// }, (args) => {
      if (!args.path.endsWith(".js")) return undefined;
      const cand = resolve(dirname(args.importer), `${args.path.slice(0, -3)}.ts`);
      return existsSync(cand) ? { path: cand } : undefined;
    });
  },
};

// Clean dist so no stale file (e.g. an old recall-spawn.js with child_process)
// lingers for OpenClaw's scanner to flag.
rmSync(resolve(here, "dist"), { recursive: true, force: true });

await build({
  entryPoints: [resolve(here, "index.ts")],
  outfile: resolve(here, "dist", "index.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  external: ["openclaw"], // host-provided peer dependency — never bundle it
  alias: { "@byterover/core": coreEntry },
  plugins: [resolveTsPlugin],
  // Some transitive deps (e.g. ws) `require()` optional native addons under ESM.
  banner: {
    js: "import{createRequire as __cr}from'module';const require=__cr(import.meta.url);",
  },
  logLevel: "info",
});

console.log("✓ bundled → dist/index.js (core inlined; recall in-process; no child_process)");
