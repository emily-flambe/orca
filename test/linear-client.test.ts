import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LinearClient } from "../src/linear/client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal successful GraphQL response. */
function okResponse(data: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

function errorResponse(status: number): Response {
  return new Response(JSON.stringify({ error: "fail" }), { status });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("LinearClient", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // 1. Constructor throws if no API key
  it("throws if constructed without an API key", () => {
    expect(() => new LinearClient("")).toThrow("API key is required");
  });

  // 2. fetchProjectIssues with empty array returns [] without calling fetch
  it("fetchProjectIssues([]) returns empty array without calling fetch", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy;

    const client = new LinearClient("lin_api_test");
    const result = await client.fetchProjectIssues([]);

    expect(result).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // 3. Successful GraphQL query — correct headers, returns data
  it("successful query sends correct Authorization and Content-Type headers", async () => {
    const issueData = {
      issues: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [],
      },
    };
    const fetchSpy = vi.fn().mockResolvedValue(okResponse(issueData));
    globalThis.fetch = fetchSpy;

    const client = new LinearClient("lin_api_test");
    const result = await client.fetchProjectIssues(["proj-1"]);

    expect(result).toEqual([]);
    expect(fetchSpy).toHaveBeenCalledOnce();

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("lin_api_test");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  // 4. HTTP 401 → throws immediately, does not retry
  it("HTTP 401 throws authentication error without retrying", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(errorResponse(401));
    globalThis.fetch = fetchSpy;

    const client = new LinearClient("lin_api_test");
    await expect(client.fetchProjectIssues(["proj-1"])).rejects.toThrow(
      "authentication failed",
    );
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  // 5. HTTP 403 → throws immediately, does not retry
  it("HTTP 403 throws authentication error without retrying", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(errorResponse(403));
    globalThis.fetch = fetchSpy;

    const client = new LinearClient("lin_api_test");
    await expect(client.fetchProjectIssues(["proj-1"])).rejects.toThrow(
      "authentication failed",
    );
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  // 6. HTTP 500 → retries up to MAX_RETRIES (4 total attempts), then throws
  it("HTTP 500 retries 4 total attempts then throws", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(errorResponse(500));
    globalThis.fetch = fetchSpy;

    const client = new LinearClient("lin_api_test");

    // Run timers concurrently with the promise to avoid unhandled rejection window
    await Promise.all([
      expect(client.fetchProjectIssues(["proj-1"])).rejects.toThrow(/HTTP 500.*4 attempt/i),
      vi.runAllTimersAsync(),
    ]);

    // initial + 3 retries = 4
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });

  // 7. HTTP 429 → retries up to MAX_RETRIES
  it("HTTP 429 retries 4 total attempts then throws", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(errorResponse(429));
    globalThis.fetch = fetchSpy;

    const client = new LinearClient("lin_api_test");

    await Promise.all([
      expect(client.fetchProjectIssues(["proj-1"])).rejects.toThrow(/HTTP 429.*4 attempt/i),
      vi.runAllTimersAsync(),
    ]);

    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });

  // 8. Network error → retries, throws after exhaustion
  it("network error retries 4 total attempts then throws", async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    globalThis.fetch = fetchSpy;

    const client = new LinearClient("lin_api_test");

    await Promise.all([
      expect(client.fetchProjectIssues(["proj-1"])).rejects.toThrow(/network error/i),
      vi.runAllTimersAsync(),
    ]);

    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });

  // 9. GraphQL errors in response body → throws with message including error text
  it("GraphQL errors in response body throws with the error message", async () => {
    const body = JSON.stringify({
      errors: [{ message: "Field not found: badField" }],
    });
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    globalThis.fetch = fetchSpy;

    const client = new LinearClient("lin_api_test");
    await expect(client.fetchProjectIssues(["proj-1"])).rejects.toThrow(
      "Field not found: badField",
    );
  });

  // 10. Response missing data field → throws
  it("response missing data field throws", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    globalThis.fetch = fetchSpy;

    const client = new LinearClient("lin_api_test");
    await expect(client.fetchProjectIssues(["proj-1"])).rejects.toThrow(
      "response missing data field",
    );
  });

  // 11. Rate limit warning logged when X-RateLimit-Requests-Remaining < 500
  it("logs a rate limit warning when X-RateLimit-Requests-Remaining is low", async () => {
    const issueData = {
      issues: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [],
      },
    };
    const fetchSpy = vi.fn().mockResolvedValue(
      okResponse(issueData, { "X-RateLimit-Requests-Remaining": "42" }),
    );
    globalThis.fetch = fetchSpy;

    const warnSpy = vi.spyOn(console, "warn");
    const client = new LinearClient("lin_api_test");
    await client.fetchProjectIssues(["proj-1"]);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("rate limit low"),
    );
  });

  // 12. fetchProjectIssues with empty projectIds returns [] without calling fetch
  it("fetchProjectIssues with empty projectIds returns [] without fetch (alias of test 2)", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy;

    const client = new LinearClient("lin_api_test");
    const result = await client.fetchProjectIssues([]);

    expect(result).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
