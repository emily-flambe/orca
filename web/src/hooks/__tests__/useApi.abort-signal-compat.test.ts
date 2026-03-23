/**
 * Tests for AbortSignal.timeout compatibility.
 *
 * AbortSignal.timeout() requires:
 * - Chrome 103+ (released June 2022)
 * - Firefox 100+ (released May 2022)
 * - Safari 16+ (released September 2022)
 * - Node.js 17.3+
 *
 * Vite's default build target includes browsers older than this (Safari 14, Chrome 87).
 * If AbortSignal.timeout is unavailable, fetchJson will crash with TypeError instead
 * of a graceful timeout error.
 *
 * These tests expose that behavior.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchTasks } from "../useApi";

describe("AbortSignal.timeout compatibility", () => {
  let originalTimeout: typeof AbortSignal.timeout;

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    originalTimeout = AbortSignal.timeout;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Restore AbortSignal.timeout
    AbortSignal.timeout = originalTimeout;
  });

  it("degrades gracefully when AbortSignal.timeout is unavailable (older browsers)", async () => {
    // Simulate Safari 14 / Chrome 87 environment
    // @ts-ignore
    AbortSignal.timeout = undefined;

    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify([]), { status: 200 }),
    );

    // Expected: should succeed (without timeout protection) or throw a friendly error
    // Actual: crashes with TypeError: AbortSignal.timeout is not a function

    // THIS TEST WILL FAIL - it documents the desired behavior that doesn't exist yet
    await expect(fetchTasks()).resolves.toEqual([]);
  });
});
