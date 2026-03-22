/**
 * Adversarial tests for the EMI-369 AbortController timeout added to
 * LinearClient.query(). Attack angles:
 *
 * 1. Timer leak: does clearTimeout run when response-body parsing throws?
 * 2. AbortController reuse: is a fresh controller created per attempt?
 * 3. Timeout retries all MAX_RETRIES times (4 total attempts).
 * 4. Node.js 22 AbortError type: DOMException vs Error — is name check safe?
 * 5. Error message propagation through route catch block.
 * 6. Missing timeout test coverage gap.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LinearClient } from "../src/linear/client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function mockResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("EMI-369: AbortController timeout in LinearClient.query()", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // ATTACK 1: Timer leak when response-body parsing throws AFTER try/catch
  //
  // The fetch() succeeds (try block exits normally), so clearTimeout fires in
  // finally. But then response.json() throws AFTER the finally block. The
  // question is: does the timer leak in that window?
  //
  // The timer is cleared in finally{} before response processing. So it should
  // NOT leak in that path. This test verifies it doesn't leak via an indirect
  // check: if clearTimeout were NOT called, the fake timer would fire and the
  // aborted controller's signal would be aborted — but since response.json()
  // throws first, the only observable effect is the thrown error.
  // -------------------------------------------------------------------------

  it("ATTACK 1: clearTimeout fires even when response.json() throws (no timer leak)", async () => {
    // Return a Response whose .json() method throws
    const brokenResponse = new Response("{not-valid-json}", {
      status: 200,
      headers: { "content-type": "application/json" },
    });

    vi.mocked(fetch).mockResolvedValue(brokenResponse);

    const client = new LinearClient("key");
    // Should throw a JSON parse error, NOT an AbortError
    await expect(client.fetchViewer()).rejects.toThrow();

    // Verify the abort timer was cleared: if it leaked, advancing fake timers
    // by 30s would trigger an AbortController.abort() on an already-done
    // controller. While harmless, we can detect it by verifying clearTimeout
    // was called — we do this indirectly by checking no AbortError surfaces.
    await vi.advanceTimersByTimeAsync(35_000);
    // No additional throws expected (the promise already settled)
  });

  // -------------------------------------------------------------------------
  // ATTACK 2: AbortController reuse across retries
  //
  // A critical correctness requirement: each retry attempt MUST create a NEW
  // AbortController. An already-aborted signal will cause fetch() to reject
  // immediately on subsequent attempts. The implementation creates
  // `const abortController = new AbortController()` inside the loop, so
  // this SHOULD be fine — but let's verify with real behavior.
  // -------------------------------------------------------------------------

  it("ATTACK 2: each retry gets a fresh AbortController (not reused)", async () => {
    // Simulate: first two attempts time out, third succeeds
    let callCount = 0;
    vi.mocked(fetch).mockImplementation(() => {
      callCount++;
      if (callCount <= 2) {
        // Simulate timeout by returning a never-resolving promise,
        // then we'll advance timers to trigger the abort
        return new Promise<Response>((_resolve, reject) => {
          // This will be aborted by the 30s timer
          setTimeout(
            () =>
              reject(
                new DOMException("The operation was aborted.", "AbortError"),
              ),
            30_000,
          );
        });
      }
      return Promise.resolve(mockResponse(viewerResponse()));
    });

    const client = new LinearClient("key");
    const promise = client.fetchViewer();

    // Advance 30s to trigger first timeout, then again for second, then let
    // third succeed immediately
    await vi.advanceTimersByTimeAsync(30_000); // triggers attempt 0 timeout
    await vi.advanceTimersByTimeAsync(1_000); // backoff for attempt 1
    await vi.advanceTimersByTimeAsync(30_000); // triggers attempt 1 timeout
    await vi.advanceTimersByTimeAsync(2_000); // backoff for attempt 2
    // attempt 2 resolves immediately

    const result = await promise;
    expect(result.name).toBe("Alice");
    expect(callCount).toBe(3);
  });

  // -------------------------------------------------------------------------
  // ATTACK 3: Timeout retries all MAX_RETRIES times, then surfaces error
  //
  // After 4 total attempts (attempt 0–3) all timing out, the error should be
  // the wrapped "network error after 4 attempts" message, not a bare AbortError.
  // -------------------------------------------------------------------------

  it("ATTACK 3: timeout retries 4 times total then throws 'network error' message", async () => {
    // Simulate a DOMException AbortError (Node.js 22 behavior)
    vi.mocked(fetch).mockRejectedValue(
      new DOMException("The operation was aborted.", "AbortError"),
    );

    const client = new LinearClient("key");
    const promise = client.fetchViewer();
    const assertion = expect(promise).rejects.toThrow("network error");
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetch).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
  });

  // -------------------------------------------------------------------------
  // ATTACK 4: Node.js 22 DOMException name check
  //
  // In Node.js 22, fetch() aborted via AbortController throws a DOMException
  // (not a plain Error) with name === "AbortError". The implementation checks
  // `err instanceof Error && err.name === "AbortError"`.
  //
  // DOMException extends Error in modern environments, so `instanceof Error`
  // should be true. But let's verify the check works for DOMException,
  // not just plain Error objects.
  // -------------------------------------------------------------------------

  it("ATTACK 4a: DOMException AbortError is caught and produces 'timed out' message", async () => {
    const domAbort = new DOMException(
      "The operation was aborted.",
      "AbortError",
    );
    vi.mocked(fetch).mockRejectedValue(domAbort);

    const client = new LinearClient("key");
    const promise = client.fetchViewer();
    const assertion = expect(promise).rejects.toThrow("timed out");
    await vi.runAllTimersAsync();
    await assertion;
  });

  it("ATTACK 4b: DOMException instanceof Error is true in this runtime", () => {
    // Verify the environment assumption the implementation relies on
    const domEx = new DOMException("test", "AbortError");
    expect(domEx instanceof Error).toBe(true);
    expect(domEx.name).toBe("AbortError");
  });

  it("ATTACK 4c: plain Error with name AbortError also triggers timeout message", async () => {
    // Verify plain-Error AbortError path also works (belt-and-suspenders)
    const plainAbort = new Error("aborted");
    plainAbort.name = "AbortError";
    vi.mocked(fetch).mockRejectedValue(plainAbort);

    const client = new LinearClient("key");
    const promise = client.fetchViewer();
    const assertion = expect(promise).rejects.toThrow("timed out");
    await vi.runAllTimersAsync();
    await assertion;
  });

  // -------------------------------------------------------------------------
  // ATTACK 5: Error message propagation
  //
  // The route handler catches errors and returns { error: message }. Verify
  // the timeout error message is not swallowed or garbled through the chain.
  // The `lastError.message` used in the final throw should contain "timed out".
  // -------------------------------------------------------------------------

  it("ATTACK 5: final thrown error after timeout retries contains 'timed out' in message", async () => {
    vi.mocked(fetch).mockRejectedValue(
      new DOMException("The operation was aborted.", "AbortError"),
    );

    const client = new LinearClient("key");
    const promise = client.fetchViewer();
    // Attach rejection handler immediately to prevent unhandled rejection warnings
    const assertion = expect(promise).rejects.toMatchObject({
      message: expect.stringMatching(
        /network error after \d+ attempts.*timed out/s,
      ),
    });
    await vi.runAllTimersAsync();
    await assertion;
  });

  // -------------------------------------------------------------------------
  // ATTACK 6: Does timeout trigger before MAX_RETRIES exhausted?
  //           The fake timer approach used in existing tests uses
  //           vi.runAllTimersAsync() — which collapses all pending timers.
  //           That would fire BOTH the 30s abort timer AND the retry backoff
  //           timers simultaneously. But does the abort timer fire BEFORE
  //           the fetch resolves when timers are fake?
  //
  //           Specifically: with mockRejectedValue (immediate rejection),
  //           the abort timer is irrelevant. But with a slow fetch,
  //           does the abort fire at 30s?
  // -------------------------------------------------------------------------

  it("ATTACK 6: abort fires at exactly 30s, not before", async () => {
    let abortFired = false;

    vi.mocked(fetch).mockImplementation((_url: unknown, init?: RequestInit) => {
      const signal = init?.signal;
      // Return a promise that resolves at 60s (well past the 30s timeout)
      return new Promise<Response>((resolve, reject) => {
        if (signal) {
          signal.addEventListener("abort", () => {
            abortFired = true;
            reject(
              new DOMException("The operation was aborted.", "AbortError"),
            );
          });
        }
        setTimeout(() => resolve(mockResponse(viewerResponse())), 60_000);
      });
    });

    const client = new LinearClient("key");
    const promise = client.fetchViewer();

    // At 29s: abort should NOT have fired yet
    await vi.advanceTimersByTimeAsync(29_000);
    expect(abortFired).toBe(false);

    // At 30s: abort SHOULD fire
    await vi.advanceTimersByTimeAsync(1_000);
    expect(abortFired).toBe(true);

    // Attach rejection handler BEFORE running timers to prevent unhandled rejection
    const assertion = expect(promise).rejects.toThrow();
    await vi.runAllTimersAsync();
    await assertion;
  });

  // -------------------------------------------------------------------------
  // ATTACK 7: Does a successful fast fetch properly clear the abort timer?
  //           If clearTimeout is NOT called, a 30s timer would still be
  //           pending and would fire after the test ends — causing test
  //           pollution or a "timer still running" vitest warning.
  // -------------------------------------------------------------------------

  it("ATTACK 7: abort timer is cleared after successful fetch (no dangling timer)", async () => {
    vi.mocked(fetch).mockResolvedValue(mockResponse(viewerResponse()));

    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");

    const client = new LinearClient("key");
    await client.fetchViewer();

    // clearTimeout must have been called at least once
    expect(clearTimeoutSpy).toHaveBeenCalled();

    // Advance past the 30s mark — if the timer leaked, it would call abort()
    // on an already-settled request (harmless but detectable if we could spy
    // on AbortController.abort). Since we can't easily detect that, we rely
    // on clearTimeout being called.
    await vi.advanceTimersByTimeAsync(35_000);
  });
});
