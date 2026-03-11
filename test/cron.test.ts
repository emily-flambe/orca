// ---------------------------------------------------------------------------
// Cron utility tests — adversarial coverage
// ---------------------------------------------------------------------------

import { describe, test, expect } from "vitest";
import {
  computeNextRunAt,
  validateCronExpression,
  describeCronSchedule,
} from "../src/cron/index.js";

// ---------------------------------------------------------------------------
// computeNextRunAt
// ---------------------------------------------------------------------------

describe("computeNextRunAt", () => {
  test("returns a valid ISO string for common expression", () => {
    const result = computeNextRunAt("* * * * *");
    // Must parse as a valid date
    expect(isNaN(Date.parse(result))).toBe(false);
    // Must be an ISO string (ends with Z or +HH:MM)
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  test("returned time is in the future relative to after", () => {
    const after = new Date("2025-01-15T12:00:00.000Z");
    const result = computeNextRunAt("* * * * *", after);
    const next = new Date(result);
    expect(next.getTime()).toBeGreaterThan(after.getTime());
  });

  test("* * * * * fires within 60 seconds of after", () => {
    const after = new Date("2025-06-01T08:30:45.000Z");
    const result = computeNextRunAt("* * * * *", after);
    const next = new Date(result);
    const diffSeconds = (next.getTime() - after.getTime()) / 1000;
    expect(diffSeconds).toBeGreaterThan(0);
    expect(diffSeconds).toBeLessThanOrEqual(60);
  });

  test("works with explicit after date for 0 9 * * 1 (weekly)", () => {
    // Monday 2025-01-13 09:00 UTC — next Monday at 09:00 should be 2025-01-20
    const after = new Date("2025-01-13T09:01:00.000Z");
    const result = computeNextRunAt("0 9 * * 1", after);
    const next = new Date(result);
    // Should be a Monday
    expect(next.getUTCDay()).toBe(1);
    // Should be after the reference date
    expect(next.getTime()).toBeGreaterThan(after.getTime());
  });

  test("works with explicit after date on same minute boundary", () => {
    // If after is exactly at the boundary, next fire should still be in the future
    const after = new Date("2025-03-10T14:00:00.000Z");
    const result = computeNextRunAt("0 14 * * *", after);
    const next = new Date(result);
    expect(next.getTime()).toBeGreaterThan(after.getTime());
  });

  test("throws for invalid expression", () => {
    expect(() => computeNextRunAt("invalid")).toThrow();
  });

  test("throws for empty string", () => {
    expect(() => computeNextRunAt("")).toThrow();
  });

  test("throws for 4-field expression", () => {
    expect(() => computeNextRunAt("* * * *")).toThrow();
  });

  test("throws for out-of-range minute (60)", () => {
    expect(() => computeNextRunAt("60 * * * *")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// validateCronExpression
// ---------------------------------------------------------------------------

describe("validateCronExpression", () => {
  test("returns null for * * * * *", () => {
    expect(validateCronExpression("* * * * *")).toBeNull();
  });

  test("returns null for 0 9 * * 1 (weekly Monday 9am)", () => {
    expect(validateCronExpression("0 9 * * 1")).toBeNull();
  });

  test("returns null for */15 * * * * (every 15 minutes)", () => {
    expect(validateCronExpression("*/15 * * * *")).toBeNull();
  });

  test("returns null for 0 0 1 1 * (yearly)", () => {
    expect(validateCronExpression("0 0 1 1 *")).toBeNull();
  });

  test("returns a string for 'invalid'", () => {
    const result = validateCronExpression("invalid");
    expect(typeof result).toBe("string");
    expect(result).not.toBeNull();
    expect(result!.length).toBeGreaterThan(0);
  });

  test("returns a string for 4-field expression", () => {
    const result = validateCronExpression("* * * *");
    expect(result).not.toBeNull();
    expect(typeof result).toBe("string");
    expect(result!.length).toBeGreaterThan(0);
  });

  test("returns a string for minute 60 out of range", () => {
    const result = validateCronExpression("60 * * * *");
    expect(typeof result).toBe("string");
    expect(result).not.toBeNull();
    expect(result!.length).toBeGreaterThan(0);
  });

  test("returns a string for hour 24 out of range", () => {
    const result = validateCronExpression("0 24 * * *");
    expect(typeof result).toBe("string");
    expect(result).not.toBeNull();
  });

  test("returns null for valid step expressions (*/5 */2 * * *)", () => {
    expect(validateCronExpression("*/5 */2 * * *")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// describeCronSchedule
// ---------------------------------------------------------------------------

describe("describeCronSchedule", () => {
  test("* * * * * returns 'Every minute'", () => {
    expect(describeCronSchedule("* * * * *")).toBe("Every minute");
  });

  test("*/2 * * * * contains '2 minutes'", () => {
    const result = describeCronSchedule("*/2 * * * *");
    expect(result).toContain("2 minutes");
  });

  test("*/15 * * * * contains '15 minutes'", () => {
    const result = describeCronSchedule("*/15 * * * *");
    expect(result).toContain("15 minutes");
  });

  test("0 * * * * returns 'Every hour'", () => {
    expect(describeCronSchedule("0 * * * *")).toBe("Every hour");
  });

  test("0 9 * * * contains '9' and 'AM'", () => {
    const result = describeCronSchedule("0 9 * * *");
    expect(result).toContain("9");
    expect(result).toContain("AM");
  });

  test("0 0 * * * uses 12 for midnight (not 0:00 AM)", () => {
    // Hour 0 mod 12 === 0, displayHour should be 12, not 0
    const result = describeCronSchedule("0 0 * * *");
    expect(result).toContain("12");
    expect(result).toContain("AM");
  });

  test("0 12 * * * returns PM for noon", () => {
    const result = describeCronSchedule("0 12 * * *");
    expect(result).toContain("PM");
  });

  test("0 9 * * 1 contains 'Monday' or 'Weekly'", () => {
    const result = describeCronSchedule("0 9 * * 1");
    const hasMonday = result.includes("Monday");
    const hasWeekly = result.includes("Weekly");
    expect(hasMonday || hasWeekly).toBe(true);
  });

  test("0 9 * * 0 describes Sunday", () => {
    const result = describeCronSchedule("0 9 * * 0");
    expect(result).toContain("Sunday");
  });

  test("0 9 * * 6 describes Saturday", () => {
    const result = describeCronSchedule("0 9 * * 6");
    expect(result).toContain("Saturday");
  });

  test("0 9 1 * * contains 'Monthly' or '1st'", () => {
    const result = describeCronSchedule("0 9 1 * *");
    const hasMonthly = result.includes("Monthly");
    const hasFirst = result.includes("1st");
    expect(hasMonthly || hasFirst).toBe(true);
  });

  test("invalid expression returns error notice", () => {
    const result = describeCronSchedule("not-a-cron");
    expect(result.toLowerCase()).toContain("invalid");
  });

  test("*/1 * * * * is treated as every 1 minute (not 'Every minute')", () => {
    // */1 is technically valid and means every minute, but it matches
    // the everyNMinutes branch (not the "Every minute" branch).
    // The implementation returns "Every 1 minutes" — this is arguably
    // a description flaw (should say "Every minute" or "Every 1 minute").
    const result = describeCronSchedule("*/1 * * * *");
    // At minimum it should not crash and should mention "1"
    expect(result).toContain("1");
  });

  test("order: 0 * * * * (every hour) does not accidentally match every-minute", () => {
    // Regression: if order of checks were wrong, '0 * * * *' could fall through wrong branch
    const result = describeCronSchedule("0 * * * *");
    expect(result).not.toBe("Every minute");
    expect(result).toBe("Every hour");
  });

  test("0 */2 * * * (every 2 hours) contains '2 hours'", () => {
    const result = describeCronSchedule("0 */2 * * *");
    expect(result).toContain("2 hours");
  });

  test("month-specific expression does not produce generic description", () => {
    // '0 9 * JAN *' only fires in January — must NOT return 'Daily at 9:00 AM'
    const result = describeCronSchedule("0 9 * JAN *");
    expect(result).not.toBe("Daily at 9:00 AM");
    // Should fall back to the generic Cron: prefix
    expect(result).toContain("9");
  });

  test("* * * JAN * does not return 'Every minute'", () => {
    // Only fires in January — 'Every minute' is misleading
    const result = describeCronSchedule("* * * JAN *");
    expect(result).not.toBe("Every minute");
  });

  test("0 9 * 1 * does not return 'Daily at 9:00 AM'", () => {
    // Fires at 9am but only in January (month=1)
    const result = describeCronSchedule("0 9 * 1 *");
    expect(result).not.toBe("Daily at 9:00 AM");
  });
});
