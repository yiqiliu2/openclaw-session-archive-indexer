import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/core";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

/**
 * Session Archive Indexer plugin
 *
 * Makes archived session transcripts (.deleted.*, .reset.*) visible to the
 * built-in memory indexer by creating hardlinks with .jsonl extension in the
 * same sessions directory. The memory system's listSessionFilesForAgent()
 * only picks up files ending in .jsonl — hardlinks satisfy this filter
 * without interfering with the session store (which tracks by sessions.json).
 *
 * Every hour (configurable), scans for:
 *   - New archived sessions -> creates hardlinks
 *   - Changed active sessions or new memory files -> triggers reindex
 * This ensures the memory index stays fresh without manual intervention.
 */

const LINK_PREFIX = "_arch_";
const STATE_FILE = "session-archive-indexer-state.json";

type PluginConfig = {
  enabled?: boolean;
  intervalMinutes?: number;
  includeDeleted?: boolean;
  includeReset?: boolean;
};

type FileSnapshot = { mtimeMs: number; size: number };

type LinkState = {
  /** Map of hardlink name -> source file basename */
  links: Record<string, string>;
  /** Track file mtimes/sizes for change detection */
  fileSnapshots: Record<string, FileSnapshot>;
  lastScanMs: number;
};

function resolveConfig(pluginConfig?: Record<string, unknown>): Required<PluginConfig> {
  const cfg = (pluginConfig ?? {}) as PluginConfig;
  return {
    enabled: cfg.enabled !== false,
    intervalMinutes: cfg.intervalMinutes ?? 60,
    includeDeleted: cfg.includeDeleted !== false,
    includeReset: cfg.includeReset !== false,
  };
}

function isArchivedSession(
  name: string,
  cfg: Required<PluginConfig>,
): boolean {
  if (cfg.includeDeleted && /\.jsonl\.deleted\.\d{4}-/.test(name)) return true;
  if (cfg.includeReset && /\.jsonl\.reset\.\d{4}-/.test(name)) return true;
  return false;
}

/** Deterministic hardlink name from source file basename */
function hardlinkName(srcBasename: string): string {
  const m = srcBasename.match(
    /^(.+?)\.jsonl\.(deleted|reset)\.(\d{4}-\d{2}-\d{2}T[\d-]+(?:\.\d+)?Z?)$/,
  );
  if (!m) {
    return LINK_PREFIX + srcBasename.replace(/\.jsonl\./, "_").replace(/[^a-zA-Z0-9_.-]/g, "_") + ".jsonl";
  }
  const [, base, type, ts] = m;
  const safeTs = ts.replace(/[:.]/g, "-");
  return `${LINK_PREFIX}${base}_${type}_${safeTs}.jsonl`;
}

async function loadState(stateDir: string): Promise<LinkState> {
  try {
    const raw = await fs.readFile(path.join(stateDir, STATE_FILE), "utf-8");
    const parsed = JSON.parse(raw);
    return {
      links: parsed.links ?? {},
      fileSnapshots: parsed.fileSnapshots ?? {},
      lastScanMs: parsed.lastScanMs ?? 0,
    };
  } catch {
    return { links: {}, fileSnapshots: {}, lastScanMs: 0 };
  }
}

async function saveState(stateDir: string, state: LinkState): Promise<void> {
  await fs.writeFile(
    path.join(stateDir, STATE_FILE),
    JSON.stringify(state, null, 2),
    "utf-8",
  );
}

type ScanResult = {
  archiveLinksCreated: number;
  archiveLinksRemoved: number;
  totalArchiveLinks: number;
  changedSessionFiles: string[];
  newSessionFiles: string[];
  changedMemoryFiles: string[];
  newMemoryFiles: string[];
};

async function scanAndLink(
  stateDir: string,
  workspaceDir: string,
  cfg: Required<PluginConfig>,
  log: { info: (msg: string) => void; debug?: (msg: string) => void },
): Promise<ScanResult> {
  const result: ScanResult = {
    archiveLinksCreated: 0,
    archiveLinksRemoved: 0,
    totalArchiveLinks: 0,
    changedSessionFiles: [],
    newSessionFiles: [],
    changedMemoryFiles: [],
    newMemoryFiles: [],
  };

  const agentsDir = path.join(stateDir, "agents");
  let agentDirs: string[];
  try {
    agentDirs = (await fs.readdir(agentsDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return result;
  }

  const state = await loadState(stateDir);
  const seenLinks = new Set<string>();

  for (const agentId of agentDirs) {
    const sessionsDir = path.join(agentsDir, agentId, "sessions");
    let entries: { name: string; isFile: boolean }[];
    try {
      entries = (await fs.readdir(sessionsDir, { withFileTypes: true }))
        .filter((e) => e.isFile() || e.isSymbolicLink())
        .map((e) => ({ name: e.name, isFile: e.isFile() }));
    } catch {
      continue;
    }

    const archived = entries
      .map((e) => e.name)
      .filter((name) => isArchivedSession(name, cfg));

    const existingLinks = new Set(
      entries.map((e) => e.name).filter((name) => name.startsWith(LINK_PREFIX)),
    );

    // Create hardlinks for archived sessions
    for (const srcName of archived) {
      const linkName = hardlinkName(srcName);
      seenLinks.add(`${agentId}/${linkName}`);

      if (existingLinks.has(linkName)) {
        state.links[`${agentId}/${linkName}`] = srcName;
        continue;
      }

      try {
        await fs.link(
          path.join(sessionsDir, srcName),
          path.join(sessionsDir, linkName),
        );
        state.links[`${agentId}/${linkName}`] = srcName;
        result.archiveLinksCreated++;
      } catch (err: any) {
        if (err?.code !== "EEXIST") {
          log.debug?.(`Failed to create hardlink ${linkName}: ${err?.message}`);
        }
      }
    }

    // Clean up stale hardlinks
    for (const linkName of existingLinks) {
      const key = `${agentId}/${linkName}`;
      if (!seenLinks.has(key)) {
        try {
          await fs.unlink(path.join(sessionsDir, linkName));
          delete state.links[key];
          result.archiveLinksRemoved++;
        } catch {}
      }
    }

    // Detect changed/new active session files (non-archive .jsonl)
    const activeSessionFiles = entries
      .map((e) => e.name)
      .filter(
        (name) =>
          name.endsWith(".jsonl") &&
          !name.startsWith(LINK_PREFIX) &&
          !isArchivedSession(name, cfg),
      );

    for (const name of activeSessionFiles) {
      const absPath = path.join(sessionsDir, name);
      const key = `session:${agentId}/${name}`;
      try {
        const stat = await fs.stat(absPath);
        const prev = state.fileSnapshots[key];
        if (!prev) {
          result.newSessionFiles.push(absPath);
        } else if (prev.mtimeMs !== stat.mtimeMs || prev.size !== stat.size) {
          result.changedSessionFiles.push(absPath);
        }
        state.fileSnapshots[key] = {
          mtimeMs: stat.mtimeMs,
          size: stat.size,
        };
      } catch {}
    }
  }

  // Detect changed/new memory files in workspace
  try {
    const memoryDir = path.join(workspaceDir, "memory");
    const memFiles = await listFilesRecursive(memoryDir, [".md", ".txt", ".json"]);
    for (const absPath of memFiles) {
      const key = `memory:${path.relative(workspaceDir, absPath)}`;
      try {
        const stat = await fs.stat(absPath);
        const prev = state.fileSnapshots[key];
        if (!prev) {
          result.newMemoryFiles.push(absPath);
        } else if (prev.mtimeMs !== stat.mtimeMs || prev.size !== stat.size) {
          result.changedMemoryFiles.push(absPath);
        }
        state.fileSnapshots[key] = {
          mtimeMs: stat.mtimeMs,
          size: stat.size,
        };
      } catch {}
    }
  } catch {}

  // Clean state entries for links that no longer exist
  for (const key of Object.keys(state.links)) {
    if (!seenLinks.has(key)) delete state.links[key];
  }

  result.totalArchiveLinks = seenLinks.size;
  state.lastScanMs = Date.now();
  await saveState(stateDir, state);

  return result;
}

async function listFilesRecursive(
  dir: string,
  extensions: string[],
): Promise<string[]> {
  const results: string[] = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...(await listFilesRecursive(full, extensions)));
      } else if (
        entry.isFile() &&
        extensions.some((ext) => entry.name.endsWith(ext))
      ) {
        results.push(full);
      }
    }
  } catch {}
  return results;
}

const sessionArchiveIndexerPlugin = {
  id: "session-archive-indexer",
  name: "Session Archive Indexer",
  description:
    "Indexes archived/deleted/reset session transcripts into memory search. " +
    "Hourly scan detects new/changed sessions and memory files and triggers reindex.",
  configSchema: emptyPluginConfigSchema(),

  register(api: OpenClawPluginApi) {
    const cfg = resolveConfig(api.pluginConfig);
    if (!cfg.enabled) {
      api.logger.info("Session archive indexer disabled by config");
      return;
    }

    const stateDir = api.runtime.state.resolveStateDir(process.env, os.homedir());
    const workspaceDir = path.join(stateDir, "workspace");

    let intervalHandle: ReturnType<typeof setInterval> | null = null;

    async function runScanCycle(reason: string) {
      const result = await scanAndLink(stateDir, workspaceDir, cfg, api.logger);

      const hasArchiveChanges =
        result.archiveLinksCreated > 0 || result.archiveLinksRemoved > 0;
      const hasContentChanges =
        result.changedSessionFiles.length > 0 ||
        result.newSessionFiles.length > 0 ||
        result.changedMemoryFiles.length > 0 ||
        result.newMemoryFiles.length > 0;

      if (hasArchiveChanges) {
        api.logger.info(
          `[${reason}] Archive scan: +${result.archiveLinksCreated} linked, ` +
            `-${result.archiveLinksRemoved} removed (${result.totalArchiveLinks} total)`,
        );
      }

      if (hasContentChanges) {
        const parts: string[] = [];
        if (result.newSessionFiles.length)
          parts.push(`${result.newSessionFiles.length} new sessions`);
        if (result.changedSessionFiles.length)
          parts.push(`${result.changedSessionFiles.length} changed sessions`);
        if (result.newMemoryFiles.length)
          parts.push(`${result.newMemoryFiles.length} new memory files`);
        if (result.changedMemoryFiles.length)
          parts.push(`${result.changedMemoryFiles.length} changed memory files`);
        api.logger.info(`[${reason}] Changes detected: ${parts.join(", ")}. Triggering reindex.`);
      }

      // Trigger memory reindex if anything changed
      if (hasArchiveChanges || hasContentChanges) {
        try {
          // Use the CLI to trigger reindex (works across process boundary)
          await api.runtime.system.runCommandWithTimeout(
            ["openclaw", "memory", "index"],
            { timeoutMs: 120_000 },
          );
        } catch (err: any) {
          api.logger.warn(`Reindex trigger failed: ${err?.message}`);
        }
      }
    }

    api.on("gateway_start", async () => {
      api.logger.info(
        `Session archive indexer starting (interval=${cfg.intervalMinutes}m, ` +
          `deleted=${cfg.includeDeleted}, reset=${cfg.includeReset})`,
      );

      // Initial scan
      await runScanCycle("startup");

      // Periodic scan
      intervalHandle = setInterval(
        () => runScanCycle("periodic"),
        cfg.intervalMinutes * 60_000,
      );
      if (intervalHandle.unref) intervalHandle.unref();
    });

    api.on("gateway_stop", async () => {
      if (intervalHandle) {
        clearInterval(intervalHandle);
        intervalHandle = null;
      }
    });

    // Re-scan shortly after session reset/new (session gets archived)
    api.registerHook(
      "before_reset",
      async () => {
        setTimeout(() => runScanCycle("session-reset"), 3000);
      },
      { name: "session-archive-indexer-reset" },
    );

    // Register CLI subcommand for manual operations
    api.registerCli(
      ({ program }) => {
        const cmd = program
          .command("session-archives")
          .description("Manage session archive indexing");

        cmd
          .command("scan")
          .description("Force scan and reindex if changes found")
          .action(async () => {
            console.log("Scanning...");
            const result = await scanAndLink(stateDir, workspaceDir, cfg, {
              info: (msg) => console.log(msg),
              debug: (msg) => console.log(`  ${msg}`),
            });

            console.log(
              `Archives: +${result.archiveLinksCreated} linked, ` +
                `-${result.archiveLinksRemoved} removed (${result.totalArchiveLinks} total)`,
            );
            console.log(
              `Sessions: ${result.newSessionFiles.length} new, ${result.changedSessionFiles.length} changed`,
            );
            console.log(
              `Memory: ${result.newMemoryFiles.length} new, ${result.changedMemoryFiles.length} changed`,
            );

            const hasChanges =
              result.archiveLinksCreated > 0 ||
              result.changedSessionFiles.length > 0 ||
              result.newSessionFiles.length > 0 ||
              result.changedMemoryFiles.length > 0 ||
              result.newMemoryFiles.length > 0;

            if (hasChanges) {
              console.log("Triggering reindex...");
              const { execSync } = await import("node:child_process");
              execSync("openclaw memory index", { stdio: "inherit" });
            } else {
              console.log("No changes detected.");
            }
          });

        cmd
          .command("status")
          .description("Show archive indexer state")
          .action(async () => {
            const state = await loadState(stateDir);
            const linkCount = Object.keys(state.links).length;
            const snapshotCount = Object.keys(state.fileSnapshots).length;
            const lastScan = state.lastScanMs
              ? new Date(state.lastScanMs).toISOString()
              : "never";
            console.log(`Archived sessions linked: ${linkCount}`);
            console.log(`Files tracked: ${snapshotCount}`);
            console.log(`Last scan: ${lastScan}`);
            if (linkCount > 0) {
              console.log("\nLinked archives:");
              for (const [key, src] of Object.entries(state.links)) {
                console.log(`  ${key} -> ${src}`);
              }
            }
          });

        cmd
          .command("clean")
          .description("Remove all hardlinks created by this plugin")
          .action(async () => {
            const state = await loadState(stateDir);
            let removed = 0;
            for (const key of Object.keys(state.links)) {
              const [agentId, linkName] = key.split("/", 2);
              const linkPath = path.join(
                stateDir,
                "agents",
                agentId,
                "sessions",
                linkName,
              );
              try {
                await fs.unlink(linkPath);
                removed++;
              } catch {}
            }
            await saveState(stateDir, { links: {}, fileSnapshots: {}, lastScanMs: 0 });
            console.log(`Removed ${removed} hardlinks. State cleared.`);
          });
      },
      { commands: ["session-archives"] },
    );
  },
};

export default sessionArchiveIndexerPlugin;
