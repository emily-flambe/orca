// ---------------------------------------------------------------------------
// Dependency graph — in-memory adjacency lists for blocking relations
// ---------------------------------------------------------------------------

import type { LinearIssue } from "./client.js";

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

import { createLogger } from "../logger.js";
const logger = createLogger("graph");

// ---------------------------------------------------------------------------
// DependencyGraph
// ---------------------------------------------------------------------------

export class DependencyGraph {
  /** Maps an issue ID to the set of issue IDs that block it. */
  private blockedBy: Map<string, Set<string>> = new Map();

  /** Maps an issue ID to the set of issue IDs it blocks. */
  private blocks: Map<string, Set<string>> = new Map();

  // -------------------------------------------------------------------------
  // 3.2 rebuild
  // -------------------------------------------------------------------------

  /**
   * Clear and rebuild the graph from a full set of Linear issues.
   * Processes both `relations` (type "blocks" means this issue blocks the
   * related issue) and `inverseRelations` (type "blocks" means this issue
   * IS blocked by the source issue).
   */
  rebuild(issues: LinearIssue[]): void {
    this.blockedBy = new Map();
    this.blocks = new Map();

    for (const issue of issues) {
      // relations where type === "blocks": this issue blocks the related issue
      for (const rel of issue.relations) {
        if (rel.type === "blocks") {
          this.addEdge(issue.id, rel.issueId);
        }
      }

      // inverseRelations where type === "blocks": this issue IS blocked by
      // the source issue
      for (const rel of issue.inverseRelations) {
        if (rel.type === "blocks") {
          this.addEdge(rel.issueId, issue.id);
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // 3.3 isDispatchable
  // -------------------------------------------------------------------------

  /**
   * Returns true if the task has no blockers or all blockers have status
   * "done". The `getStatus` callback resolves a task ID to its Orca status.
   */
  isDispatchable(
    taskId: string,
    getStatus: (id: string) => string | undefined,
  ): boolean {
    const blockers = this.blockedBy.get(taskId);
    if (!blockers || blockers.size === 0) {
      return true;
    }

    for (const blockerId of blockers) {
      const status = getStatus(blockerId);
      if (status !== "done") {
        return false;
      }
    }

    return true;
  }

  // -------------------------------------------------------------------------
  // 3.4 computeEffectivePriority
  // -------------------------------------------------------------------------

  /**
   * Compute effective priority by walking `blocks` edges transitively.
   * Returns the minimum real priority (1-4) among the task itself and all
   * tasks it transitively blocks.
   *
   * Priority 0 (no priority) is treated as Infinity so it never wins the
   * min comparison. If only unprioritized tasks are found, returns the
   * task's own raw priority via `getPriority`.
   */
  computeEffectivePriority(
    taskId: string,
    getPriority: (id: string) => number,
  ): number {
    const visited = new Set<string>();
    const minBlocked = this.walkBlocks(taskId, getPriority, visited);
    const own = getPriority(taskId);
    const ownEffective = own === 0 ? Infinity : own;
    const result = Math.min(ownEffective, minBlocked);

    // If everything was unprioritized (Infinity), fall back to raw priority
    return result === Infinity ? own : result;
  }

  /**
   * Recursively walk `blocks` edges, returning the minimum real priority
   * found among all transitively blocked tasks (excluding the starting task
   * itself — that is handled by the caller).
   */
  private walkBlocks(
    taskId: string,
    getPriority: (id: string) => number,
    visited: Set<string>,
  ): number {
    visited.add(taskId);

    const blocked = this.blocks.get(taskId);
    if (!blocked || blocked.size === 0) {
      return Infinity;
    }

    let min = Infinity;

    for (const blockedId of blocked) {
      if (visited.has(blockedId)) {
        logger.warn(`cycle detected in dependency graph: ${taskId} -> ${blockedId}`);
        continue;
      }

      const p = getPriority(blockedId);
      const effective = p === 0 ? Infinity : p;
      min = Math.min(min, effective);

      // Recurse into tasks blocked by this one
      const transitive = this.walkBlocks(blockedId, getPriority, visited);
      min = Math.min(min, transitive);
    }

    return min;
  }

  // -------------------------------------------------------------------------
  // 3.5 Incremental updates
  // -------------------------------------------------------------------------

  /** Add a blocking relation: blockerId blocks blockedId. */
  addRelation(blockerId: string, blockedId: string): void {
    this.addEdge(blockerId, blockedId);
  }

  /** Remove a blocking relation: blockerId no longer blocks blockedId. */
  removeRelation(blockerId: string, blockedId: string): void {
    const blockedSet = this.blocks.get(blockerId);
    if (blockedSet) {
      blockedSet.delete(blockedId);
      if (blockedSet.size === 0) {
        this.blocks.delete(blockerId);
      }
    }

    const blockerSet = this.blockedBy.get(blockedId);
    if (blockerSet) {
      blockerSet.delete(blockerId);
      if (blockerSet.size === 0) {
        this.blockedBy.delete(blockedId);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /** Add a directed edge: blockerId blocks blockedId, updating both maps. */
  private addEdge(blockerId: string, blockedId: string): void {
    let blockedSet = this.blocks.get(blockerId);
    if (!blockedSet) {
      blockedSet = new Set();
      this.blocks.set(blockerId, blockedSet);
    }
    blockedSet.add(blockedId);

    let blockerSet = this.blockedBy.get(blockedId);
    if (!blockerSet) {
      blockerSet = new Set();
      this.blockedBy.set(blockedId, blockerSet);
    }
    blockerSet.add(blockerId);
  }
}
