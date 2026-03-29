import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createLogger } from "../logger.js";

const logger = createLogger("monitor-snapshot");

export const DEFAULT_SNAPSHOT_FILE = path.join(
  process.cwd(),
  "tmp",
  "task-monitor-snapshot.ndjson",
);

interface MonitorTask {
  linearIssueId: string;
  orcaStatus: string;
  lifecycleStage: string | null;
  currentPhase: string | null;
  retryCount: number;
  updatedAt: string;
  lastFailureReason?: string | null;
  lastFailedPhase?: string | null;
  lastFailedAt?: string | null;
}

/**
 * Writes a NDJSON snapshot of all tasks to disk.
 * Each line is a JSON object with key task fields.
 * Failed tasks include lastFailureReason truncated to 80 chars.
 * If drainingForSeconds is provided, a metadata line is prepended.
 */
export async function writeMonitorSnapshot(
  tasks: MonitorTask[],
  filePath?: string,
  meta?: { drainingForSeconds?: number },
): Promise<void> {
  const targetPath = filePath ?? DEFAULT_SNAPSHOT_FILE;

  const lines = tasks.map((task) => {
    const entry: Record<string, unknown> = {
      id: task.linearIssueId,
      status: task.orcaStatus,
      lifecycleStage: task.lifecycleStage,
      currentPhase: task.currentPhase,
      retryCount: task.retryCount,
      updatedAt: task.updatedAt,
    };

    if (task.lifecycleStage === "failed") {
      entry.failedPhase = task.lastFailedPhase ?? null;
      entry.failedAt = task.lastFailedAt ?? null;
      entry.failureReason = task.lastFailureReason
        ? task.lastFailureReason.slice(0, 80)
        : null;
    }

    return JSON.stringify(entry);
  });

  const allLines: string[] = [];

  if (meta?.drainingForSeconds !== undefined) {
    allLines.push(
      JSON.stringify({
        _type: "meta",
        drainingForSeconds: meta.drainingForSeconds,
        timestamp: new Date().toISOString(),
      }),
    );
  }

  allLines.push(...lines);

  try {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, allLines.join("\n") + "\n", "utf8");
  } catch (err) {
    logger.error(`writeMonitorSnapshot: failed to write snapshot: ${err}`);
  }
}
