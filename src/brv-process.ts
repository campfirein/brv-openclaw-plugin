import { spawn } from "node:child_process";
import { accessSync, existsSync, readFileSync, constants as fsConstants } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import type { PluginLogger } from "./types.js";

/**
 * On Windows, node scripts installed via npm cannot be spawned directly
 * (EFTYPE), and using `shell: true` causes cmd.exe to mangle arguments.
 * Resolve the underlying JS entry point and invoke it via node instead.
 */
function resolveWin32Command(name: string): { command: string; prependArgs: string[] } {
  if (process.platform !== "win32") {
    return { command: name, prependArgs: [] };
  }

  // If the configured path is a .cmd shim (e.g. npm global install), parse it
  // to find the JS entry point it wraps and run that directly with node.
  if (name.endsWith(".cmd")) {
    const jsEntry = resolveJsFromCmdShim(name);
    if (jsEntry) {
      return { command: process.execPath, prependArgs: [jsEntry] };
    }
  }

  // Bare name like "brv": search PATH for the extensionless script file.
  if (!isAbsolute(name)) {
    for (const dir of (process.env.PATH || "").split(delimiter)) {
      // npm creates both `brv` (shell script) and `brv.cmd` on Windows.
      // Check for a .cmd shim first so we can extract the real JS path.
      const cmdCandidate = join(dir, name + ".cmd");
      const jsEntry = resolveJsFromCmdShim(cmdCandidate);
      if (jsEntry) {
        return { command: process.execPath, prependArgs: [jsEntry] };
      }
    }
  }

  return { command: name, prependArgs: [] };
}

/** Parse an npm .cmd shim to extract the JS entry point it wraps. */
function resolveJsFromCmdShim(cmdPath: string): string | undefined {
  try {
    const content = readFileSync(cmdPath, "utf8");
    // npm .cmd shims contain a line like:
    //   "%dp0%\node_modules\@scope\pkg\bin\run.js" %*
    //   "%~dp0\node_modules\pkg\bin\cli.js" %*
    const match = content.match(/"%(?:~dp0|dp0)%\\(node_modules\\[^"]+\.(?:js|cjs|mjs))"/i);
    if (match) {
      const resolved = join(dirname(cmdPath), match[1]);
      accessSync(resolved, fsConstants.R_OK);
      return resolved;
    }
  } catch {}
  return undefined;
}

// ---------------------------------------------------------------------------
// Types — brv CLI JSON output shapes
// ---------------------------------------------------------------------------

/** Wrapper envelope for all brv --format json responses. */
export type BrvJsonResponse<T = unknown> = {
  command: string;
  success: boolean;
  timestamp: string;
  data: T;
};

export type BrvCurateResult = {
  status: "completed" | "queued" | "error";
  event?: string;
  message?: string;
  taskId?: string;
  logId?: string;
  changes?: {
    created?: string[];
    updated?: string[];
  };
  error?: string;
};

export type BrvQueryResult = {
  status: "completed" | "error";
  event?: string;
  taskId?: string;
  result?: string;
  content?: string;
  message?: string;
  error?: string;
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export type BrvProcessConfig = {
  /** Path to the brv binary. Defaults to "brv". */
  brvPath?: string;
  /** Working directory for brv commands. Defaults to process.cwd(). */
  cwd?: string;
  /** Timeout for query calls in ms. Defaults to 12_000. */
  queryTimeoutMs?: number;
  /** Timeout for curate calls in ms. Defaults to 60_000. */
  curateTimeoutMs?: number;
};

// ---------------------------------------------------------------------------
// Core spawning utility
// ---------------------------------------------------------------------------

function runBrv(params: {
  brvPath: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  logger: PluginLogger;
  signal?: AbortSignal;
  maxOutputChars?: number;
}): Promise<{ stdout: string; stderr: string }> {
  const maxOutput = params.maxOutputChars ?? 512_000;

  params.logger.debug?.(
    `spawn: ${params.brvPath} ${params.args.join(" ")} (cwd=${params.cwd}, timeout=${params.timeoutMs}ms)`,
  );

  return new Promise((resolve, reject) => {
    let settled = false;

    function settle(
      outcome: "resolve" | "reject",
      value: { stdout: string; stderr: string } | Error,
    ) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (outcome === "resolve") {
        resolve(value as { stdout: string; stderr: string });
      } else {
        reject(value);
      }
    }

    const { command, prependArgs } = resolveWin32Command(params.brvPath);
    const child = spawn(command, [...prependArgs, ...params.args], {
      cwd: params.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      settle(
        "reject",
        new Error(
          `brv ${params.args[0]} timed out after ${params.timeoutMs}ms`,
        ),
      );
    }, params.timeoutMs);

    // External cancellation via AbortSignal (used by assemble deadline)
    if (params.signal) {
      if (params.signal.aborted) {
        child.kill("SIGKILL");
        settle("reject", new Error(`brv ${params.args[0]} aborted`));
      } else {
        params.signal.addEventListener(
          "abort",
          () => {
            child.kill("SIGKILL");
            settle("reject", new Error(`brv ${params.args[0]} aborted`));
          },
          { once: true },
        );
      }
    }

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > maxOutput) {
        child.kill("SIGKILL");
        settle(
          "reject",
          new Error(`brv ${params.args[0]} output exceeded ${maxOutput} chars`),
        );
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        // ENOENT can mean the binary wasn't found OR the cwd doesn't exist.
        if (!existsSync(params.cwd)) {
          settle(
            "reject",
            new Error(
              `Working directory "${params.cwd}" does not exist. ` +
                `Set cwd in plugin config to a valid brv-initialized directory.`,
            ),
          );
        } else {
          settle(
            "reject",
            new Error(
              `ByteRover CLI not found at "${params.brvPath}". ` +
                `Install it (https://www.byterover.dev) or set brvPath in plugin config.`,
            ),
          );
        }
        return;
      }
      params.logger.warn(`spawn error: ${err.message}`);
      settle("reject", err);
    });

    child.on("close", (code) => {
      if (code === 0) {
        params.logger.debug?.(
          `exit 0 (stdout=${stdout.length} chars, stderr=${stderr.length} chars)`,
        );
        settle("resolve", { stdout, stderr });
      } else {
        const errMsg = `brv ${params.args[0]} failed (exit ${code}): ${stderr || stdout}`;
        params.logger.warn(errMsg);
        settle("reject", new Error(errMsg));
      }
    });
  });
}

/**
 * Parse the last complete JSON object from brv's newline-delimited JSON output.
 * brv streams events as NDJSON; the final line with `status: "completed"` is the result.
 */
export function parseLastJsonLine<T>(stdout: string): BrvJsonResponse<T> {
  const lines = stdout.trim().split("\n").filter(Boolean);
  // Walk backwards to find the final completed result
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]) as BrvJsonResponse<T>;
      return parsed;
    } catch {
      // Skip non-JSON lines (shouldn't happen with --format json, but be safe)
    }
  }
  throw new Error("No valid JSON in brv output");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run `brv curate` with the given context text.
 * Uses --detach for fire-and-forget (non-blocking) curation.
 */
export async function brvCurate(params: {
  config: BrvProcessConfig;
  logger: PluginLogger;
  context: string;
  files?: string[];
  detach?: boolean;
  cwd: string;
}): Promise<BrvJsonResponse<BrvCurateResult>> {
  const brvPath = params.config.brvPath ?? "brv";
  const cwd = params.cwd;
  const timeoutMs = params.config.curateTimeoutMs ?? 60_000;

  const args = ["curate", "--format", "json"];
  if (params.detach) {
    args.push("--detach");
  }
  if (params.files) {
    for (const f of params.files) {
      args.push("-f", f);
    }
  }
  // "--" terminates flags so user text starting with "-" isn't parsed as a brv option
  args.push("--", params.context);

  const { stdout } = await runBrv({
    brvPath,
    args,
    cwd,
    timeoutMs,
    logger: params.logger,
  });
  return parseLastJsonLine<BrvCurateResult>(stdout);
}

/**
 * Run `brv query` and return the synthesized answer.
 */
export async function brvQuery(params: {
  config: BrvProcessConfig;
  logger: PluginLogger;
  query: string;
  signal?: AbortSignal;
  cwd: string;
}): Promise<BrvJsonResponse<BrvQueryResult>> {
  const brvPath = params.config.brvPath ?? "brv";
  const cwd = params.cwd;
  const timeoutMs = params.config.queryTimeoutMs ?? 12_000;

  // "--" terminates flags so user text starting with "-" isn't parsed as a brv option
  const args = ["query", "--format", "json", "--", params.query];

  const { stdout } = await runBrv({
    brvPath,
    args,
    cwd,
    timeoutMs,
    logger: params.logger,
    signal: params.signal,
  });
  return parseLastJsonLine<BrvQueryResult>(stdout);
}
