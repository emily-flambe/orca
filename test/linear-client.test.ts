// ---------------------------------------------------------------------------
// LinearClient unit tests
// ---------------------------------------------------------------------------

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type Mock,
} from "vitest";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJsonResponse(
  data: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function successIssuesPage(
  nodes: unknown[],
  hasNextPage = false,
  endCursor: string | null = null,
): Response {
  return makeJsonResponse({
    data: {
      issues: {
        pageInfo: { hasNextPage, endCursor },
        nodes,
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("LinearClient", () => {
  let originalFetch: typeof globalThis.fetch;
  let mockFetch: Mock;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    mockFetch = vi.fn();
    globalThis.fetch = mockFetch;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ["setTimeout"] });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function getClient(apiKey = "test-key") {
    const { LinearClient } = await import("../src/linear/client.js");
    return new LinearClient(apiKey);
  }

  // -------------------------------------------------------------------------
  // Constructor
  // -------------------------------------------------------------------------

  it("throws if no API key is provided", async () => {
    const { LinearClient } = await import("../src/linear/client.js");
    expect(() => new LinearClient("")).toThrow(/API key is required/);
  });

  // -------------------------------------------------------------------------
  // Successful query
  // -------------------------------------------------------------------------

  it("successful query returns parsed data and sends Authorization header", async () => {
    mockFetch.mockResolvedValueOnce(
      makeJsonResponse({ data: { issueUpdate: { success: true } } }),
    );

    const client = await getClient("my-api-key");
    const result = await client.updateIssueState("issue-1", "state-1");

    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledOnce();

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(
      "my-api-key",
    );
  });

  // -------------------------------------------------------------------------
  // GraphQL errors
  // -------------------------------------------------------------------------

  it("throws with messages from GraphQL errors array", async () => {
    mockFetch.mockResolvedValueOnce(
      makeJsonResponse({
        errors: [{ message: "not found" }, { message: "permission denied" }],
      }),
    );

    const client = await getClient();
    await expect(client.updateIssueState("x", "y")).rejects.toThrow(
      /not found.*permission denied/,
    );
  });

  it("throws when response has no data field", async () => {
    mockFetch.mockResolvedValueOnce(makeJsonResponse({ something: "else" }));

    const client = await getClient();
    await expect(client.updateIssueState("x", "y")).rejects.toThrow(
      /response missing data field/,
    );
  });

  // -------------------------------------------------------------------------
  // Auth errors — no retry
  // -------------------------------------------------------------------------

  it("401 throws authentication failed and does not retry", async () => {
    mockFetch.mockResolvedValue(new Response("Unauthorized", { status: 401 }));

    const client = await getClient();
    await expect(client.updateIssueState("x", "y")).rejects.toThrow(
      /authentication failed/,
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("403 throws authentication failed and does not retry", async () => {
    mockFetch.mockResolvedValue(new Response("Forbidden", { status: 403 }));

    const client = await getClient();
    await expect(client.updateIssueState("x", "y")).rejects.toThrow(
      /authentication failed/,
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Transient errors — retries up to MAX_RETRIES=3, then throws
  // -------------------------------------------------------------------------

  it("500 retries 3 times then throws (4 total calls)", async () => {
    mockFetch.mockResolvedValue(new Response("error", { status: 500 }));

    const client = await getClient();
    // Attach .catch immediately to prevent unhandled rejection before we assert
    const promise = client.updateIssueState("x", "y").catch((e) => e);

    // Advance through all three retry backoffs: 1s, 2s, 4s
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await promise;
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/500/);
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it("429 retries 3 times then throws (4 total calls)", async () => {
    mockFetch.mockResolvedValue(new Response("rate limited", { status: 429 }));

    const client = await getClient();
    const promise = client.updateIssueState("x", "y").catch((e) => e);

    await vi.advanceTimersByTimeAsync(10_000);
    const result = await promise;
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/429/);
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it("502 retries 3 times then throws", async () => {
    mockFetch.mockResolvedValue(new Response("bad gateway", { status: 502 }));

    const client = await getClient();
    const promise = client.updateIssueState("x", "y").catch((e) => e);

    await vi.advanceTimersByTimeAsync(10_000);
    const result = await promise;
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/502/);
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it("503 retries 3 times then throws", async () => {
    mockFetch.mockResolvedValue(
      new Response("unavailable", { status: 503 }),
    );

    const client = await getClient();
    const promise = client.updateIssueState("x", "y").catch((e) => e);

    await vi.advanceTimersByTimeAsync(10_000);
    const result = await promise;
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/503/);
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  // -------------------------------------------------------------------------
  // Network error (fetch throws)
  // -------------------------------------------------------------------------

  it("network error retries then throws after exhaustion", async () => {
    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

    const client = await getClient();
    const promise = client.updateIssueState("x", "y").catch((e) => e);

    await vi.advanceTimersByTimeAsync(10_000);
    const result = await promise;
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/network error/);
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it("succeeds on second attempt after one transient error", async () => {
    mockFetch
      .mockResolvedValueOnce(new Response("error", { status: 500 }))
      .mockResolvedValueOnce(
        makeJsonResponse({ data: { issueUpdate: { success: true } } }),
      );

    const client = await getClient();
    const promise = client.updateIssueState("x", "y");

    await vi.advanceTimersByTimeAsync(2_000);
    const result = await promise;

    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------------------
  // Rate limit warning
  // -------------------------------------------------------------------------

  it("logs warning when X-RateLimit-Requests-Remaining < 500", async () => {
    const warnSpy = vi.spyOn(console, "warn");
    mockFetch.mockResolvedValueOnce(
      makeJsonResponse(
        { data: { issueUpdate: { success: true } } },
        200,
        { "X-RateLimit-Requests-Remaining": "100" },
      ),
    );

    const client = await getClient();
    await client.updateIssueState("x", "y");

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("rate limit low"));
  });

  it("does not warn when X-RateLimit-Requests-Remaining >= 500", async () => {
    const warnSpy = vi.spyOn(console, "warn");
    mockFetch.mockResolvedValueOnce(
      makeJsonResponse(
        { data: { issueUpdate: { success: true } } },
        200,
        { "X-RateLimit-Requests-Remaining": "999" },
      ),
    );

    const client = await getClient();
    await client.updateIssueState("x", "y");

    expect(warnSpy).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // fetchProjectIssues with empty array
  // -------------------------------------------------------------------------

  it("fetchProjectIssues with empty array returns [] without calling fetch", async () => {
    const client = await getClient();
    const result = await client.fetchProjectIssues([]);

    expect(result).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // fetchWorkflowStates with empty array
  // -------------------------------------------------------------------------

  it("fetchWorkflowStates with empty array returns empty Map without calling fetch", async () => {
    const client = await getClient();
    const result = await client.fetchWorkflowStates([]);

    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // createComment
  // -------------------------------------------------------------------------

  it("createComment returns true and sends correct mutation", async () => {
    mockFetch.mockResolvedValueOnce(
      makeJsonResponse({ data: { commentCreate: { success: true } } }),
    );

    const client = await getClient();
    const result = await client.createComment("issue-1", "great work");

    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledOnce();

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const reqBody = JSON.parse(init.body as string);
    expect(reqBody.variables.issueId).toBe("issue-1");
    expect(reqBody.variables.body).toBe("great work");
    expect(reqBody.query).toContain("commentCreate");
  });

  // -------------------------------------------------------------------------
  // fetchProjectIssues pagination
  // -------------------------------------------------------------------------

  it("fetchProjectIssues handles hasNextPage=true and fetches with cursor", async () => {
    const node = {
      id: "i1",
      identifier: "P-1",
      title: "T",
      description: null,
      priority: 0,
      state: { id: "s1", name: "Todo", type: "unstarted" },
      team: { id: "team-1" },
      project: { id: "proj-1", name: "Proj" },
      relations: { nodes: [] },
      inverseRelations: { nodes: [] },
      parent: null,
      children: { nodes: [] },
      labels: { nodes: [] },
    };

    mockFetch
      .mockResolvedValueOnce(successIssuesPage([node], true, "cursor1"))
      .mockResolvedValueOnce(successIssuesPage([{ ...node, id: "i2", identifier: "P-2" }], false, null));

    const client = await getClient();
    const issues = await client.fetchProjectIssues(["proj-1"]);

    expect(issues).toHaveLength(2);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Second call should include the cursor
    const [, secondInit] = mockFetch.mock.calls[1] as [string, RequestInit];
    const secondBody = JSON.parse(secondInit.body as string);
    expect(secondBody.variables.after).toBe("cursor1");
  });
});
