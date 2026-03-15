// ---------------------------------------------------------------------------
// Stuck-task reconciliation tests (EMI-321)
// ---------------------------------------------------------------------------
//
// Tests for runReconciliation() in src/inngest/workflows/reconcile-stuck-tasks.ts.
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach, vi } from "vitest";
import { createDb, type OrcaDb } from "../src/db/index.js";
import { insertTask, insertInvocation, getTask } from "../src/db/queries.js";
import type { TaskStatus } from "../src/db/schema.js";
import type { OrcaConfig } from "../src/config/index.js";

const mockInngestSend = vi.fn().mockResolvedValue(undefined);
vi.mock("../src/inngest/client.js", () => ({
  inngest: { send: mockInngestSend },
}));

vi.mock("../src/session-handles.js", () => ({
  activeHandles: new Map(),
  sweepExitedHandles: vi.fn(),
}));

const { runReconciliation } = await import(
  "../src/inngest/workflows/reconcile-stuck-tasks.js"
);
