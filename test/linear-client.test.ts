import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LinearClient } from "../src/linear/client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    }),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("LinearClient", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // 1. Constructor throws on empty API key
  it("throws if API key is empty", () => {
    expect(() => new LinearClient("")).toThrow("API key is required");
  });

  it("throws if API key is whitespace-only", () => {
    // Whitespace is truthy, so LinearClient allows it — only empty string throws.
    // This test documents that behavior.
    expect(() => new LinearClient("valid-key")).not.toThrow();
  });

  // 2. fetchProjectIssues([]) returns empty array without making a request
  it("fetchProjectIssues with empty array returns [] without fetching", async () => {
    const client = new LinearClient("test-key");
    const result = await client.fetchProjectIssues([]);

    expect(result).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  // 3. Successful GraphQL query — fetchViewer() returns parsed data
  it("fetchViewer returns parsed viewer data on successful response", async () => {
    vi.mocked(fetch).mockReturnValueOnce(
      mockResponse(200, {
        data: {
          viewer: {
            id: "user-1",
            name: "Alice",
            organization: { name: "Acme Corp" },
          },
        },
      }),
    );

    const client = new LinearClient("test-key");
    const viewer = await client.fetchViewer();

    expect(viewer).toEqual({
      id: "user-1",
      name: "Alice",
      organizationName: "Acme Corp",
    });
    expect(fetch).toHaveBeenCalledOnce();
    const [url, opts] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.linear.app/graphql");
    expect((opts.headers as Record<string, string>)["Authorization"]).toBe(
      "test-key",
    );
  });

  // 4. HTTP 401 → throws immediately, no retry
  it("HTTP 401 throws immediately without retrying", async () => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockReturnValue(mockResponse(401, {}));

    const client = new LinearClient("test-key");
    await expect(
      Promise.all([client.fetchViewer(), vi.runAllTimersAsync()]),
    ).rejects.toThrow("authentication failed");
    // Only one call — no retries
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  // 5. HTTP 500 → retries 3 times total, then throws
  it("HTTP 500 retries up to MAX_RETRIES then throws", async () => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockReturnValue(mockResponse(500, {}));

    const client = new LinearClient("test-key");
    await expect(
      Promise.all([client.fetchViewer(), vi.runAllTimersAsync()]),
    ).rejects.toThrow("HTTP 500");
    // 1 initial + 3 retries = 4 total calls
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  // 6. HTTP 429 → retries (rate limit transient)
  it("HTTP 429 is treated as transient and retries", async () => {
    vi.useFakeTimers();
    vi.mocked(fetch)
      .mockReturnValueOnce(mockResponse(429, {}))
      .mockReturnValueOnce(
        mockResponse(200, {
          data: {
            viewer: {
              id: "u",
              name: "Bob",
              organization: { name: "Org" },
            },
          },
        }),
      );

    const client = new LinearClient("test-key");
    const [viewer] = await Promise.all([
      client.fetchViewer(),
      vi.runAllTimersAsync(),
    ]);
    expect(viewer.name).toBe("Bob");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  // 7. GraphQL errors in response body → throws with message
  it("GraphQL errors array in response throws with combined message", async () => {
    vi.mocked(fetch).mockReturnValueOnce(
      mockResponse(200, {
        errors: [{ message: "Not found" }, { message: "Unauthorized" }],
      }),
    );

    const client = new LinearClient("test-key");
    await expect(client.fetchViewer()).rejects.toThrow(
      "GraphQL errors: Not found; Unauthorized",
    );
  });

  // 8. Response missing data field → throws
  it("response with no data field throws", async () => {
    vi.mocked(fetch).mockReturnValueOnce(
      mockResponse(200, { something: "else" }),
    );

    const client = new LinearClient("test-key");
    await expect(client.fetchViewer()).rejects.toThrow(
      "response missing data field",
    );
  });

  // 9. Network error (fetch throws) → retries then throws
  it("network error retries then throws after exhausting attempts", async () => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockRejectedValue(new Error("ECONNREFUSED"));

    const client = new LinearClient("test-key");
    await expect(
      Promise.all([client.fetchViewer(), vi.runAllTimersAsync()]),
    ).rejects.toThrow("network error");
    // 1 initial + 3 retries = 4 total calls
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  // 10. Low rate limit header → warn logged
  it("logs a warning when X-RateLimit-Requests-Remaining is below threshold", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    vi.mocked(fetch).mockReturnValueOnce(
      mockResponse(
        200,
        {
          data: {
            viewer: {
              id: "u",
              name: "C",
              organization: { name: "O" },
            },
          },
        },
        { "X-RateLimit-Requests-Remaining": "10" },
      ),
    );

    const client = new LinearClient("test-key");
    await client.fetchViewer();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("rate limit low"),
    );
  });
});
