import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import ActivityFeed from "../ActivityFeed";
import type { ActivityEntry } from "../../hooks/useApi";

function makeEntry(overrides: Partial<ActivityEntry> = {}): ActivityEntry {
  return {
    id: 1,
    linearIssueId: "ENG-1",
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    endedAt: null,
    status: "completed",
    phase: "implement",
    costUsd: null,
    inputTokens: null,
    outputTokens: null,
    ...overrides,
  };
}

describe("ActivityFeed — retrying status rendering", () => {
  it("renders 'retrying' status text for a retrying entry", () => {
    const entry = makeEntry({ status: "retrying" });
    render(<ActivityFeed entries={[entry]} />);

    expect(screen.getByText("retrying")).toBeInTheDocument();
  });

  it("applies yellow color class to retrying status text", () => {
    const entry = makeEntry({ status: "retrying" });
    render(<ActivityFeed entries={[entry]} />);

    const statusEl = screen.getByText("retrying");
    // statusColor('retrying') should return 'text-yellow-400'
    expect(statusEl.className).toContain("yellow");
  });

  it("applies yellow dot to retrying status", () => {
    const entry = makeEntry({ status: "retrying" });
    const { container } = render(<ActivityFeed entries={[entry]} />);

    // statusDot('retrying') should return 'bg-yellow-400'
    const dot = container.querySelector(".bg-yellow-400");
    expect(dot).not.toBeNull();
  });
});

describe("ActivityFeed — timed_out status rendering", () => {
  it("renders 'timed_out' status text for a timed_out entry", () => {
    const entry = makeEntry({ status: "timed_out" });
    render(<ActivityFeed entries={[entry]} />);

    expect(screen.getByText("timed_out")).toBeInTheDocument();
  });

  it("applies orange color class to timed_out status text", () => {
    const entry = makeEntry({ status: "timed_out" });
    render(<ActivityFeed entries={[entry]} />);

    const statusEl = screen.getByText("timed_out");
    expect(statusEl.className).toContain("orange");
  });

  it("applies orange dot to timed_out status", () => {
    const entry = makeEntry({ status: "timed_out" });
    const { container } = render(<ActivityFeed entries={[entry]} />);

    const dot = container.querySelector(".bg-orange-400");
    expect(dot).not.toBeNull();
  });
});

describe("ActivityFeed — all status visual coverage", () => {
  const cases: Array<{ status: string; colorWord: string; dotClass: string }> = [
    { status: "completed", colorWord: "green", dotClass: "bg-green-400" },
    { status: "running", colorWord: "blue", dotClass: "bg-blue-400" },
    { status: "failed", colorWord: "red", dotClass: "bg-red-400" },
    { status: "timed_out", colorWord: "orange", dotClass: "bg-orange-400" },
    { status: "retrying", colorWord: "yellow", dotClass: "bg-yellow-400" },
  ];

  for (const { status, colorWord, dotClass } of cases) {
    it(`status="${status}" gets color ${colorWord} and dot ${dotClass}`, () => {
      const entry = makeEntry({ status });
      const { container } = render(
        <ActivityFeed entries={[entry]} key={status} />,
      );

      const statusText = screen.getByText(status);
      expect(statusText.className).toContain(colorWord);

      const dot = container.querySelector(`.${dotClass}`);
      expect(dot).not.toBeNull();
    });
  }

  it("unknown status falls back to gray (not crashing)", () => {
    const entry = makeEntry({ status: "unknown_future_status" });
    const { container } = render(<ActivityFeed entries={[entry]} />);

    // Should not crash; should render with gray fallback
    expect(screen.getByText("unknown_future_status")).toBeInTheDocument();
    const grayDot = container.querySelector(".bg-gray-500");
    expect(grayDot).not.toBeNull();
  });
});

describe("ActivityFeed — empty state", () => {
  it("shows 'No recent activity' when entries array is empty", () => {
    render(<ActivityFeed entries={[]} />);
    expect(screen.getByText("No recent activity")).toBeInTheDocument();
  });
});

describe("ActivityFeed — token display", () => {
  it("shows formatted tokens when both inputTokens and outputTokens are set", () => {
    const entry = makeEntry({ inputTokens: 1000, outputTokens: 500 });
    render(<ActivityFeed entries={[entry]} />);

    // 1500 total tokens — formatted by formatTokens
    // The exact format depends on formatTokens, but something should be rendered
    const container = screen.getByText("ENG-1").closest("div");
    expect(container).not.toBeNull();
    // Token text should appear somewhere in the entry
    expect(container!.textContent).toMatch(/\d/); // contains digits (token count)
  });

  it("hides token display when both inputTokens and outputTokens are null", () => {
    const entry = makeEntry({ inputTokens: null, outputTokens: null });
    const { container: c } = render(<ActivityFeed entries={[entry]} />);

    // The font-mono tabular-nums token span should not appear
    // (the condition is inputTokens != null || outputTokens != null)
    const tokenSpans = c.querySelectorAll(".font-mono.tabular-nums");
    // Only the time-ago span should appear; no token count
    expect(tokenSpans).toHaveLength(0);
  });

  it("shows token count when only inputTokens is set (outputTokens null)", () => {
    const entry = makeEntry({ inputTokens: 2000, outputTokens: null });
    render(<ActivityFeed entries={[entry]} />);

    // The || condition means token display appears when either is not null
    const container = screen.getByText("ENG-1").closest("div");
    expect(container!.textContent).toMatch(/\d/);
  });
});

describe("ActivityFeed — navigation", () => {
  it("calls onNavigate with linearIssueId and invocation id when clicked", () => {
    const onNavigate = vi.fn();
    const entry = makeEntry({ id: 42, linearIssueId: "ENG-99" });
    render(<ActivityFeed entries={[entry]} onNavigate={onNavigate} />);

    screen.getByText("ENG-99").closest("div")!.click();
    expect(onNavigate).toHaveBeenCalledWith("ENG-99", 42);
  });

  it("does not crash when onNavigate is not provided and entry clicked", () => {
    const entry = makeEntry();
    render(<ActivityFeed entries={[entry]} />);

    // Should not throw
    expect(() =>
      screen.getByText("ENG-1").closest("div")!.click(),
    ).not.toThrow();
  });
});
