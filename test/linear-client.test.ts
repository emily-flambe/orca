import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LinearClient } from "../src/linear/client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal successful viewer response body. */
function viewerResponse() {
  return {
    data: {
      viewer: {
        id: "u1",
        name: "Alice",
        organization: { name: "Acme" },
      },
    },
  };
}

/** Build a mock Response object. */
function mockResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      ...headers,
    },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("LinearClient", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Constructor
  // -------------------------------------------------------------------------

  describe("constructor", () => {
    it("throws if apiKey is empty string", () => {
      expect(() => new LinearClient("")).toThrow("API key is required");
    });

    it("throws if apiKey is falsy (undefined cast)", () => {
      expect(() => new LinearClient(undefined as unknown as string)).toThrow(
        "API key is required",
      );
    });

    it("does not throw with a valid API key", () => {
      expect(() => new LinearClient("valid-key")).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Happy path — 200 with data
  // -------------------------------------------------------------------------

  describe("successful responses", () => {
    it("returns parsed data on 200 with data field", async () => {
      vi.mocked(fetch).mockResolvedValue(mockResponse(viewerResponse()));

      const client = new LinearClient("key");
      const result = await client.fetchViewer();

      expect(result).toEqual({
        id: "u1",
        name: "Alice",
        organizationName: "Acme",
      });
    });

    it("throws 'GraphQL errors' when response contains errors array", async () => {
      vi.mocked(fetch).mockResolvedValue(
        mockResponse({
          errors: [{ message: "Not found" }, { message: "Forbidden" }],
        }),
      );

      const client = new LinearClient("key");
      await expect(client.fetchViewer()).rejects.toThrow("GraphQL errors");
    });

    it("throws 'response missing data field' when 200 has no data", async () => {
      vi.mocked(fetch).mockResolvedValue(mockResponse({}));

      const client = new LinearClient("key");
      await expect(client.fetchViewer()).rejects.toThrow(
        "response missing data field",
      );
    });
  });

  // -------------------------------------------------------------------------
  // Auth errors — no retry
  // -------------------------------------------------------------------------

  describe("authentication errors", () => {
    it("throws 'authentication failed' on 401 without retrying", async () => {
      vi.mocked(fetch).mockResolvedValue(mockResponse({}, 401));

      const client = new LinearClient("key");
      await expect(client.fetchViewer()).rejects.toThrow(
        "authentication failed",
      );
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("throws 'authentication failed' on 403 without retrying", async () => {
      vi.mocked(fetch).mockResolvedValue(mockResponse({}, 403));

      const client = new LinearClient("key");
      await expect(client.fetchViewer()).rejects.toThrow(
        "authentication failed",
      );
      expect(fetch).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Other 4xx — no retry
  // -------------------------------------------------------------------------

  describe("non-transient client errors", () => {
    it("throws immediately on 400 without retrying", async () => {
      vi.mocked(fetch).mockResolvedValue(
        new Response("Bad request", { status: 400 }),
      );

      const client = new LinearClient("key");
      await expect(client.fetchViewer()).rejects.toThrow("HTTP 400");
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("throws immediately on 404 without retrying", async () => {
      vi.mocked(fetch).mockResolvedValue(
        new Response("Not found", { status: 404 }),
      );

      const client = new LinearClient("key");
      await expect(client.fetchViewer()).rejects.toThrow("HTTP 404");
      expect(fetch).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Transient errors — retry up to MAX_RETRIES (3)
  // -------------------------------------------------------------------------

  describe("transient errors with retry", () => {
    it("retries 429 up to MAX_RETRIES times (4 total attempts) then throws", async () => {
      vi.useFakeTimers();
      vi.mocked(fetch).mockResolvedValue(mockResponse({}, 429));

      const client = new LinearClient("key");
      const promise = client.fetchViewer();
      // Attach rejection handler BEFORE draining timers to avoid unhandled rejection
      const assertion = expect(promise).rejects.toThrow("429");
      await vi.runAllTimersAsync();
      await assertion;
      expect(fetch).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
    });

    it("retries 500 up to MAX_RETRIES times (4 total attempts) then throws", async () => {
      vi.useFakeTimers();
      vi.mocked(fetch).mockResolvedValue(mockResponse({}, 500));

      const client = new LinearClient("key");
      const promise = client.fetchViewer();
      const assertion = expect(promise).rejects.toThrow("500");
      await vi.runAllTimersAsync();
      await assertion;
      expect(fetch).toHaveBeenCalledTimes(4);
    });

    it("retries 502 up to MAX_RETRIES times (4 total attempts) then throws", async () => {
      vi.useFakeTimers();
      vi.mocked(fetch).mockResolvedValue(mockResponse({}, 502));

      const client = new LinearClient("key");
      const promise = client.fetchViewer();
      const assertion = expect(promise).rejects.toThrow("502");
      await vi.runAllTimersAsync();
      await assertion;
      expect(fetch).toHaveBeenCalledTimes(4);
    });

    it("retries 503 up to MAX_RETRIES times (4 total attempts) then throws", async () => {
      vi.useFakeTimers();
      vi.mocked(fetch).mockResolvedValue(mockResponse({}, 503));

      const client = new LinearClient("key");
      const promise = client.fetchViewer();
      const assertion = expect(promise).rejects.toThrow("503");
      await vi.runAllTimersAsync();
      await assertion;
      expect(fetch).toHaveBeenCalledTimes(4);
    });

    it("succeeds on retry after initial transient failure", async () => {
      vi.useFakeTimers();
      vi.mocked(fetch)
        .mockResolvedValueOnce(mockResponse({}, 503))
        .mockResolvedValueOnce(mockResponse(viewerResponse()));

      const client = new LinearClient("key");
      const promise = client.fetchViewer();
      await vi.runAllTimersAsync();

      const result = await promise;
      expect(result.name).toBe("Alice");
      expect(fetch).toHaveBeenCalledTimes(2);
    });
  });

  // -------------------------------------------------------------------------
  // Network errors — retry
  // -------------------------------------------------------------------------

  describe("network errors", () => {
    it("retries on network error then throws 'network error' after exhausting retries", async () => {
      vi.useFakeTimers();
      vi.mocked(fetch).mockRejectedValue(new Error("ECONNREFUSED"));

      const client = new LinearClient("key");
      const promise = client.fetchViewer();
      const assertion = expect(promise).rejects.toThrow("network error");
      await vi.runAllTimersAsync();
      await assertion;
      expect(fetch).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
    });

    it("succeeds if network error clears before retries exhausted", async () => {
      vi.useFakeTimers();
      vi.mocked(fetch)
        .mockRejectedValueOnce(new Error("ECONNREFUSED"))
        .mockResolvedValueOnce(mockResponse(viewerResponse()));

      const client = new LinearClient("key");
      const promise = client.fetchViewer();
      await vi.runAllTimersAsync();

      const result = await promise;
      expect(result.name).toBe("Alice");
      expect(fetch).toHaveBeenCalledTimes(2);
    });
  });

  // -------------------------------------------------------------------------
  // Request timeout
  // -------------------------------------------------------------------------

  describe("request timeout", () => {
    it("aborts and retries when fetch takes longer than 30 seconds", async () => {
      vi.useFakeTimers();

      // First attempt hangs (AbortError), second succeeds
      vi.mocked(fetch)
        .mockImplementationOnce(
          (_url, opts) =>
            new Promise((_resolve, reject) => {
              const signal = (opts as RequestInit).signal;
              signal?.addEventListener("abort", () => {
                const err = new Error("The operation was aborted");
                (err as Error & { name: string }).name = "AbortError";
                reject(err);
              });
            }),
        )
        .mockResolvedValueOnce(mockResponse(viewerResponse()));

      const client = new LinearClient("key");
      const promise = client.fetchViewer();
      await vi.runAllTimersAsync();

      const result = await promise;
      expect(result.name).toBe("Alice");
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it("throws timeout error after exhausting all retries", async () => {
      vi.useFakeTimers();

      // All attempts hang
      vi.mocked(fetch).mockImplementation(
        (_url, opts) =>
          new Promise((_resolve, reject) => {
            const signal = (opts as RequestInit).signal;
            signal?.addEventListener("abort", () => {
              const err = new Error("The operation was aborted");
              (err as Error & { name: string }).name = "AbortError";
              reject(err);
            });
          }),
      );

      const client = new LinearClient("key");
      const promise = client.fetchViewer();
      const assertion = expect(promise).rejects.toThrow("timed out");
      await vi.runAllTimersAsync();
      await assertion;
      expect(fetch).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
    });
  });

  // -------------------------------------------------------------------------
  // Rate limit header warning
  // -------------------------------------------------------------------------

  describe("rate limit warning", () => {
    it("logs a warning when X-RateLimit-Requests-Remaining is below 500", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.mocked(fetch).mockResolvedValue(
        mockResponse(viewerResponse(), 200, {
          "X-RateLimit-Requests-Remaining": "100",
        }),
      );

      const client = new LinearClient("key");
      await client.fetchViewer();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("rate limit low"),
      );
    });

    it("does not warn when X-RateLimit-Requests-Remaining is at or above 500", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.mocked(fetch).mockResolvedValue(
        mockResponse(viewerResponse(), 200, {
          "X-RateLimit-Requests-Remaining": "500",
        }),
      );

      const client = new LinearClient("key");
      await client.fetchViewer();

      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("does not warn when X-RateLimit-Requests-Remaining header is absent", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.mocked(fetch).mockResolvedValue(mockResponse(viewerResponse()));

      const client = new LinearClient("key");
      await client.fetchViewer();

      expect(warnSpy).not.toHaveBeenCalled();
    });
  });
});
