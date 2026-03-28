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

export interface MonitorSystemMetadata {
  type: "system";
  timestamp: string;
  draining: boolean;
  drainingForSeconds?: number;
  activeSessions: number;
}

/**
 * Writes a NDJSON snapshot of all tasks to disk.
 * The first line is a system metadata header (type: 'system').
 * Each subsequent line is a JSON object with key task fields.
 * Failed tasks include lastFailureReason truncated to 80 chars.
 */
export async function writeMonitorSnapshot(
  tasks: MonitorTask[],
  systemMeta: MonitorSystemMetadata,
  filePath?: string,
): Promise<void> {
  const targetPath = filePath ?? DEFAULT_SNAPSHOT_FILE;

  const taskLines = tasks.map((task) => {
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

  const systemLine = JSON.stringify(systemMeta);

  try {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    const content =
      taskLines.length > 0
        ? systemLine + "\n" + taskLines.join("\n") + "\n"
        : systemLine + "\n";
    await fs.writeFile(targetPath, content, "utf8");
  } catch (err) {
    logger.error(`writeMonitorSnapshot: failed to write snapshot: ${err}`);
  }
}
