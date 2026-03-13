// ---------------------------------------------------------------------------
// LinearClient tests
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LinearClient } from "../src/linear/client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockResponse(
  body: unknown,
  status = 200,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/** Minimal valid GraphQL response wrapping data. */
function dataResponse<T>(data: T, status = 200): Response {
  return mockResponse({ data }, status);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("LinearClient", () => {
  let originalFetch: typeof globalThis.fetch;
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    vi.useFakeTimers();
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
    consoleSpy.mockRestore();
    warnSpy.mockRestore();
  });

  // 1. Constructor throws on empty API key
  it("throws if apiKey is empty string", () => {
    expect(() => new LinearClient("")).toThrow("API key is required");
  });

  it("does not throw with a non-empty apiKey", () => {
    expect(() => new LinearClient("lin_api_test")).not.toThrow();
  });

  // 2. fetchProjectIssues returns [] for empty projectIds (no fetch called)
  it("fetchProjectIssues returns [] for empty projectIds without making a request", async () => {
    globalThis.fetch = vi.fn();
    const client = new LinearClient("lin_api_test");
    const result = await client.fetchProjectIssues([]);
    expect(result).toEqual([]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  // 3. fetchProjectIssues makes POST request with Authorization header
  it("fetchProjectIssues makes POST request with Authorization header", async () => {
    const issuesResponse = {
      data: {
        issues: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [],
        },
      },
    };
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify(issuesResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const client = new LinearClient("lin_api_key_abc");
    await client.fetchProjectIssues(["proj-1"]);

    expect(globalThis.fetch).toHaveBeenCalledOnce();
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.linear.app/graphql");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(
      "lin_api_key_abc",
    );
    expect(init.method).toBe("POST");
  });

  // 4. Transient errors (429, 500, 502, 503) are retried up to 3 times; after 4 failures throws
  it("retries transient HTTP 500 up to 3 times then throws", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(mockResponse("error", 500));

    const client = new LinearClient("lin_api_test");
    const promise = client.fetchProjectIssues(["proj-1"]);
    // Attach rejection handler immediately before advancing timers
    const caught = promise.catch((e: Error) => e);
    await vi.runAllTimersAsync();
    const result = await caught;
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain("500");

    // 1 initial + 3 retries = 4 total attempts
    expect(globalThis.fetch).toHaveBeenCalledTimes(4);
  });

  it("retries transient HTTP 429 up to 3 times then throws", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(mockResponse("rate limited", 429));

    const client = new LinearClient("lin_api_test");
    const promise = client.fetchProjectIssues(["proj-1"]);
    const caught = promise.catch((e: Error) => e);
    await vi.runAllTimersAsync();
    const result = await caught;
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain("429");

    expect(globalThis.fetch).toHaveBeenCalledTimes(4);
  });

  // 5. No retry on auth errors: 401 throws immediately
  it("HTTP 401 throws immediately without retrying", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(mockResponse("unauthorized", 401));

    const client = new LinearClient("lin_api_test");
    await expect(client.fetchProjectIssues(["proj-1"])).rejects.toThrow(
      "authentication failed",
    );
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("HTTP 403 throws immediately without retrying", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(mockResponse("forbidden", 403));

    const client = new LinearClient("lin_api_test");
    await expect(client.fetchProjectIssues(["proj-1"])).rejects.toThrow(
      "authentication failed",
    );
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  // 6. No retry on other 4xx: HTTP 404 throws without retrying
  it("HTTP 404 throws without retrying", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(mockResponse("not found", 404));

    const client = new LinearClient("lin_api_test");
    await expect(client.fetchProjectIssues(["proj-1"])).rejects.toThrow("404");
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  // 7. GraphQL errors: response with errors array throws
  it("GraphQL errors in response body throw with GraphQL errors message", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockResponse({ errors: [{ message: "field not found" }] }),
    );

    const client = new LinearClient("lin_api_test");
    await expect(client.fetchProjectIssues(["proj-1"])).rejects.toThrow(
      "GraphQL errors",
    );
  });

  // 8. Missing data field: response with {} throws
  it("response missing data field throws", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse({}));

    const client = new LinearClient("lin_api_test");
    await expect(client.fetchProjectIssues(["proj-1"])).rejects.toThrow(
      "missing data field",
    );
  });

  // 9. Network error: fetch throws → retried, eventually throws
  it("network error is retried then throws", async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error("ECONNREFUSED"));

    const client = new LinearClient("lin_api_test");
    const promise = client.fetchProjectIssues(["proj-1"]);
    const caught = promise.catch((e: Error) => e);
    await vi.runAllTimersAsync();
    const result = await caught;
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain("network error");
    expect(globalThis.fetch).toHaveBeenCalledTimes(4);
  });

  // 10. Rate limit warning when remaining < threshold
  it("warns when X-RateLimit-Requests-Remaining is below threshold", async () => {
    const issuesResponse = {
      data: {
        issues: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [],
        },
      },
    };
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(issuesResponse), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "X-RateLimit-Requests-Remaining": "100",
        },
      }),
    );

    const client = new LinearClient("lin_api_test");
    await client.fetchProjectIssues(["proj-1"]);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("rate limit low"),
    );
  });

  // 11. createComment makes correct mutation call and returns true
  it("createComment makes mutation call and returns true on success", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      dataResponse({ commentCreate: { success: true } }),
    );

    const client = new LinearClient("lin_api_test");
    const result = await client.createComment("issue-123", "hello world");

    expect(result).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledOnce();
    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as {
      query: string;
      variables: Record<string, unknown>;
    };
    expect(body.query).toContain("commentCreate");
    expect(body.variables).toMatchObject({
      issueId: "issue-123",
      body: "hello world",
    });
  });

  // 12. updateIssueState makes correct mutation call and returns true
  it("updateIssueState makes mutation call and returns true on success", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      dataResponse({ issueUpdate: { success: true } }),
    );

    const client = new LinearClient("lin_api_test");
    const result = await client.updateIssueState("issue-123", "state-456");

    expect(result).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledOnce();
    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as {
      query: string;
      variables: Record<string, unknown>;
    };
    expect(body.query).toContain("issueUpdate");
    expect(body.variables).toMatchObject({
      issueId: "issue-123",
      stateId: "state-456",
    });
  });
});
