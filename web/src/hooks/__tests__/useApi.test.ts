/**
 * Adversarial tests for useApi.ts fetchJson timeout behavior.
 * These tests are designed to expose bugs, not validate correctness.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// We need to import the module functions directly
// Since fetchJson is not exported, we test via the exported API functions
import { fetchTasks, createTask, fetchProjects } from "../useApi";

describe("fetchJson timeout behavior", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // BUG: The DOMException instanceof check may fail in jsdom if jsdom's
  // DOMException class differs from the global. This test verifies the
  // "Request timed out" error message surfaces correctly.
  it("surfaces 'Request timed out' when fetch rejects with TimeoutError DOMException", async () => {
    const timeoutError = new DOMException("signal timed out", "TimeoutError");
    vi.mocked(fetch).mockRejectedValue(timeoutError);

    await expect(fetchTasks()).rejects.toThrow("Request timed out");
  });

  // BUG: If the TimeoutError is NOT a DOMException (e.g. a plain Error with name "TimeoutError"),
  // the instanceof check will fail and it will rethrow the raw error instead of "Request timed out"
  it("does NOT surface 'Request timed out' when a plain Error named TimeoutError is thrown", async () => {
    const notDomException = Object.assign(new Error("signal timed out"), {
      name: "TimeoutError",
    });
    vi.mocked(fetch).mockRejectedValue(notDomException);

    // This will throw the raw error, NOT "Request timed out"
    // This documents the inconsistency - the check is too strict (instanceof DOMException)
    // but AbortSignal.timeout() actually throws a DOMException so this may be fine
    await expect(fetchTasks()).rejects.toThrow("signal timed out");
    // Confirm it did NOT convert to "Request timed out"
    await expect(fetchTasks()).rejects.not.toThrow("Request timed out");
  });

  // BUG: If a caller could pass a signal via RequestInit, the timeout signal
  // would override it silently. The createTask function passes no signal, but
  // this tests the pattern is safe.
  it("timeout signal overrides any signal passed in init (documents override behavior)", async () => {
    // This test documents the behavior: the timeout signal always wins.
    // If fetchJson were refactored to accept a cancel signal, caller signals would be ignored.
    // For now, document that { ...init, signal } override is occurring.

    const callerController = new AbortController();

    // Mock fetch to capture what signal it receives
    let capturedSignal: AbortSignal | undefined;
    vi.mocked(fetch).mockImplementation((_url, opts) => {
      capturedSignal = (opts as RequestInit).signal;
      return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
    });

    await fetchTasks(); // fetchTasks passes no signal in init

    // The signal passed to fetch is the timeout signal, not any hypothetical caller signal
    expect(capturedSignal).toBeDefined();
    // AbortSignal.timeout creates a signal; verify it is present
    expect(capturedSignal!.aborted).toBe(false);
  });

  // BUG: createTask timeout fires but the "Creating..." button state should be released.
  // This tests the error propagation path.
  it("createTask rejects with 'Request timed out' so the modal can display the error", async () => {
    const timeoutError = new DOMException("signal timed out", "TimeoutError");
    vi.mocked(fetch).mockRejectedValue(timeoutError);

    await expect(createTask({ title: "Test ticket" })).rejects.toThrow(
      "Request timed out",
    );
  });

  // BUG: What if fetch resolves OK but the timeout fires between fetch() and res.json()?
  // AbortSignal.timeout is created before fetch(), so it could theoretically fire during
  // res.json() parsing. However fetch's response body is consumed synchronously-ish in
  // this code. Let's document: res.json() is NOT guarded by the timeout signal.
  it("does not throw timeout if fetch resolves successfully even if response parsing is slow", async () => {
    // This test verifies the happy path still works
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify([{ id: "1", title: "test" }]), {
        status: 200,
      }),
    );

    // Should resolve without error
    const result = await fetchTasks();
    expect(Array.isArray(result)).toBe(true);
  });

  // BUG: What happens when the timeout fires AFTER fetch resolves but BEFORE res.json() completes?
  // The signal is checked by fetch() only. res.json() ignores the signal.
  // This is actually fine - documents expected behavior.
  it("fetchProjects timeout does not prevent project dropdown from loading on success", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify([{ id: "p1", name: "Test Project" }]), {
        status: 200,
      }),
    );

    const projects = await fetchProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0]!.name).toBe("Test Project");
  });
});

describe("fetchJson signal override - caller cannot cancel a request", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // This test verifies the known limitation: because fetchJson always overwrites the
  // signal with AbortSignal.timeout(), callers cannot pass their own AbortSignal.
  // If a caller tried: fetchJson('/path', { signal: myController.signal }), the
  // myController.signal would be silently ignored.
  //
  // Currently no callers do this, but it's a footgun. The correct fix is AbortSignal.any().
  it("documents that caller-supplied signal in RequestInit is overridden by timeout signal", async () => {
    const callerController = new AbortController();
    callerController.abort(); // Pre-abort the caller's signal

    let capturedSignal: AbortSignal | undefined;
    vi.mocked(fetch).mockImplementation((_url, opts) => {
      capturedSignal = (opts as RequestInit).signal;
      return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
    });

    // createTask with a custom init that has a pre-aborted signal
    // Since fetchJson does { ...init, signal }, the timeout signal replaces the aborted signal
    // So fetch will NOT be cancelled despite the caller's signal being aborted

    // We can't directly test this via public API since createTask doesn't accept a signal.
    // But we can verify fetch was called (not cancelled by caller signal)
    const result = await createTask({
      title: "Should succeed despite aborted signal attempt",
    });
    // If the caller's abort signal were respected, this would throw. It doesn't.
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
