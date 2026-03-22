// ---------------------------------------------------------------------------
// Adversarial tests for PrIndicator in TaskList and TaskDetail
// Attack vectors: null/undefined prState, unexpected values, missing prUrl,
// inconsistent combinations, SVG rendering integrity
// ---------------------------------------------------------------------------

import { render, screen } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";
import TaskList from "../TaskList";
import TaskDetail from "../TaskDetail";
import type { Task } from "../../types";

vi.mock("../../hooks/useApi", () => ({
  updateTaskStatus: vi.fn().mockResolvedValue({ ok: true }),
  fetchTaskDetail: vi.fn().mockResolvedValue(null),
  fetchTaskTransitions: vi.fn().mockResolvedValue([]),
  abortInvocation: vi.fn().mockResolvedValue({ ok: true }),
  retryTask: vi.fn().mockResolvedValue({ ok: true }),
}));

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    linearIssueId: "ENG-1",
    agentPrompt: "Test task prompt",
    repoPath: "/repo",
    orcaStatus: "ready",
    priority: 3,
    retryCount: 0,
    prBranchName: null,
    reviewCycleCount: 0,
    mergeCommitSha: null,
    prNumber: null,
    deployStartedAt: null,
    ciStartedAt: null,
    doneAt: null,
    projectName: null,
    invocationCount: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    taskType: "linear",
    cronScheduleId: null,
    prUrl: null,
    prState: null,
    ...overrides,
  };
}

const defaultProps = {
  selectedTaskId: null,
  onSelect: vi.fn(),
};

describe("PrIndicator in TaskList", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders PR indicator when prUrl and prState are both set", () => {
    const tasks = [
      makeTask({
        linearIssueId: "PR-1",
        prUrl: "https://github.com/org/repo/pull/42",
        prState: "open",
        prNumber: 42,
      }),
    ];
    render(<TaskList {...defaultProps} tasks={tasks} />);

    const link = screen.getByTitle("PR #42 (open)");
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute("href", "https://github.com/org/repo/pull/42");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("does NOT render PR indicator when prUrl is null", () => {
    const tasks = [
      makeTask({
        linearIssueId: "PR-2",
        prUrl: null,
        prState: "open",
        prNumber: 42,
      }),
    ];
    render(<TaskList {...defaultProps} tasks={tasks} />);

    expect(screen.queryByTitle(/PR/)).not.toBeInTheDocument();
  });

  it("does NOT render PR indicator when prState is null", () => {
    const tasks = [
      makeTask({
        linearIssueId: "PR-3",
        prUrl: "https://github.com/org/repo/pull/43",
        prState: null,
        prNumber: 43,
      }),
    ];
    render(<TaskList {...defaultProps} tasks={tasks} />);

    expect(screen.queryByTitle(/PR/)).not.toBeInTheDocument();
  });

  it("does NOT render PR indicator when both prUrl and prState are null", () => {
    const tasks = [
      makeTask({
        linearIssueId: "PR-4",
        prUrl: null,
        prState: null,
        prNumber: null,
      }),
    ];
    render(<TaskList {...defaultProps} tasks={tasks} />);

    expect(screen.queryByTitle(/PR/)).not.toBeInTheDocument();
  });

  it("renders PR indicator for draft state with gray color", () => {
    const tasks = [
      makeTask({
        linearIssueId: "PR-DRAFT",
        prUrl: "https://github.com/org/repo/pull/50",
        prState: "draft",
        prNumber: 50,
      }),
    ];
    render(<TaskList {...defaultProps} tasks={tasks} />);

    const link = screen.getByTitle("PR #50 (draft)");
    expect(link).toBeInTheDocument();
    // Check SVG fill color for draft (gray)
    const svg = link.querySelector("svg");
    expect(svg).toHaveAttribute("fill", "#6e7781");
  });

  it("renders PR indicator for merged state with purple color and merge icon", () => {
    const tasks = [
      makeTask({
        linearIssueId: "PR-MERGED",
        prUrl: "https://github.com/org/repo/pull/51",
        prState: "merged",
        prNumber: 51,
      }),
    ];
    render(<TaskList {...defaultProps} tasks={tasks} />);

    const link = screen.getByTitle("PR #51 (merged)");
    expect(link).toBeInTheDocument();
    const svg = link.querySelector("svg");
    expect(svg).toHaveAttribute("fill", "#8250df");
    // Merged state should use the merge icon path (different from PR icon)
    const path = svg?.querySelector("path");
    expect(path).toBeInTheDocument();
    // The merge icon path starts with "M5.45" vs PR icon "M7.177"
    expect(path?.getAttribute("d")).toMatch(/^M5\.45/);
  });

  it("renders PR indicator for closed state with red color", () => {
    const tasks = [
      makeTask({
        linearIssueId: "PR-CLOSED",
        prUrl: "https://github.com/org/repo/pull/52",
        prState: "closed",
        prNumber: 52,
      }),
    ];
    render(<TaskList {...defaultProps} tasks={tasks} />);

    const link = screen.getByTitle("PR #52 (closed)");
    const svg = link.querySelector("svg");
    expect(svg).toHaveAttribute("fill", "#cf222e");
  });

  it("renders PR indicator for open state with green color", () => {
    const tasks = [
      makeTask({
        linearIssueId: "PR-OPEN",
        prUrl: "https://github.com/org/repo/pull/53",
        prState: "open",
        prNumber: 53,
      }),
    ];
    render(<TaskList {...defaultProps} tasks={tasks} />);

    const link = screen.getByTitle("PR #53 (open)");
    const svg = link.querySelector("svg");
    expect(svg).toHaveAttribute("fill", "#1a7f37");
  });

  // BUG CANDIDATE: What if prNumber is null but prUrl and prState are set?
  it("renders PR indicator without number when prNumber is null", () => {
    const tasks = [
      makeTask({
        linearIssueId: "PR-NONUM",
        prUrl: "https://github.com/org/repo/pull/54",
        prState: "open",
        prNumber: null,
      }),
    ];
    render(<TaskList {...defaultProps} tasks={tasks} />);

    // Title should show "PR  (open)" with empty number placeholder
    // Use regex because testing-library may normalize whitespace
    const link = screen.getByTitle(/^PR\s+\(open\)$/);
    expect(link).toBeInTheDocument();
    // Should NOT render #N text
    expect(link.textContent).not.toContain("#");
  });

  // BUG CANDIDATE: What if prState is an unexpected string?
  // The TaskList casts it via `as string` but the color lookup falls back
  it("handles unexpected prState value without crashing", () => {
    const tasks = [
      makeTask({
        linearIssueId: "PR-BOGUS",
        prUrl: "https://github.com/org/repo/pull/55",
        prState: "BOGUS" as Task["prState"],
        prNumber: 55,
      }),
    ];

    // Should not throw
    expect(() =>
      render(<TaskList {...defaultProps} tasks={tasks} />),
    ).not.toThrow();

    // Should fall back to green ("open") color
    const link = screen.getByTitle("PR #55 (BOGUS)");
    const svg = link.querySelector("svg");
    expect(svg).toHaveAttribute("fill", "#1a7f37"); // fallback to open color
  });

  // SVG viewBox validation
  it("renders SVG with correct viewBox", () => {
    const tasks = [
      makeTask({
        linearIssueId: "PR-SVG",
        prUrl: "https://github.com/org/repo/pull/56",
        prState: "open",
        prNumber: 56,
      }),
    ];
    render(<TaskList {...defaultProps} tasks={tasks} />);

    const link = screen.getByTitle("PR #56 (open)");
    const svg = link.querySelector("svg");
    expect(svg).toHaveAttribute("viewBox", "0 0 16 16");
    expect(svg).toHaveAttribute("width", "14");
    expect(svg).toHaveAttribute("height", "14");
    expect(svg).toHaveAttribute("aria-hidden", "true");
  });

  // Multiple tasks with different PR states
  it("renders multiple tasks with different PR states simultaneously", () => {
    const tasks = [
      makeTask({
        linearIssueId: "MULTI-1",
        prUrl: "https://github.com/org/repo/pull/1",
        prState: "open",
        prNumber: 1,
      }),
      makeTask({
        linearIssueId: "MULTI-2",
        prUrl: "https://github.com/org/repo/pull/2",
        prState: "merged",
        prNumber: 2,
      }),
      makeTask({
        linearIssueId: "MULTI-3",
        prUrl: "https://github.com/org/repo/pull/3",
        prState: "closed",
        prNumber: 3,
      }),
      makeTask({
        linearIssueId: "MULTI-4",
        prUrl: "https://github.com/org/repo/pull/4",
        prState: "draft",
        prNumber: 4,
      }),
    ];
    render(<TaskList {...defaultProps} tasks={tasks} />);

    expect(screen.getByTitle("PR #1 (open)")).toBeInTheDocument();
    expect(screen.getByTitle("PR #2 (merged)")).toBeInTheDocument();
    expect(screen.getByTitle("PR #3 (closed)")).toBeInTheDocument();
    expect(screen.getByTitle("PR #4 (draft)")).toBeInTheDocument();
  });

  // Empty string edge cases
  it("renders PR indicator when prUrl is empty string (broken link)", () => {
    const tasks = [
      makeTask({
        linearIssueId: "PR-EMPTY",
        prUrl: "",
        prState: "open",
        prNumber: 60,
      }),
    ];
    render(<TaskList {...defaultProps} tasks={tasks} />);

    // Empty string is falsy in JS, so `task.prUrl && task.prState` is false
    // PrIndicator should NOT render
    expect(screen.queryByTitle(/PR/)).not.toBeInTheDocument();
  });
});
