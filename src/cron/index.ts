import { CronExpressionParser } from "cron-parser";

function assertFiveFields(expr: string): void {
  const fields = expr.trim().split(/\s+/);
  if (expr.trim() === "" || fields.length !== 5) {
    throw new Error(
      `Invalid cron expression: expected 5 fields (minute hour dom month dow), got "${expr}"`,
    );
  }
}

/**
 * Returns the ISO string of the next fire time for the given cron expression.
 * @param cronExpr - Standard 5-field cron expression (minute hour dom month dow)
 * @param after - Reference date (defaults to now)
 * @throws If the expression is invalid
 */
export function computeNextRunAt(cronExpr: string, after?: Date): string {
  assertFiveFields(cronExpr);
  const currentDate = after ?? new Date();
  const interval = CronExpressionParser.parse(cronExpr, { currentDate });
  return interval.next().toDate().toISOString();
}

/**
 * Validates a cron expression.
 * @returns null if valid, or a descriptive error message string if invalid
 */
export function validateCronExpression(expr: string): string | null {
  try {
    assertFiveFields(expr);
    CronExpressionParser.parse(expr);
    return null;
  } catch (err) {
    if (err instanceof Error) {
      return err.message;
    }
    return "Invalid cron expression";
  }
}

/**
 * Returns a human-readable description of a cron schedule.
 * Handles common patterns; falls back to a generic description for others.
 */
export function describeCronSchedule(expr: string): string {
  // Validate first — if invalid, fall back to error notice
  try {
    CronExpressionParser.parse(expr);
  } catch {
    return `Invalid expression: ${expr}`;
  }

  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    return expr;
  }

  const [minute, hour, dom, month, dow] = parts;

  // Every minute: * * * * *
  if (
    minute === "*" &&
    hour === "*" &&
    dom === "*" &&
    month === "*" &&
    dow === "*"
  ) {
    return "Every minute";
  }

  // Every N minutes: */N * * * *
  const everyNMinutes = minute.match(/^\*\/(\d+)$/);
  if (
    everyNMinutes &&
    hour === "*" &&
    dom === "*" &&
    month === "*" &&
    dow === "*"
  ) {
    return `Every ${everyNMinutes[1]} minutes`;
  }

  // Every hour: 0 * * * *
  if (
    minute === "0" &&
    hour === "*" &&
    dom === "*" &&
    month === "*" &&
    dow === "*"
  ) {
    return "Every hour";
  }

  // Every N hours: 0 */N * * *
  const everyNHours = hour.match(/^\*\/(\d+)$/);
  if (
    minute === "0" &&
    everyNHours &&
    dom === "*" &&
    month === "*" &&
    dow === "*"
  ) {
    return `Every ${everyNHours[1]} hours`;
  }

  // Specific hour patterns require a fixed hour number and wildcard month
  const hourNum = parseInt(hour, 10);
  const isFixedHour = /^\d+$/.test(hour) && !isNaN(hourNum);

  if (minute === "0" && isFixedHour && month === "*") {
    const ampm = hourNum < 12 ? "AM" : "PM";
    const displayHour = hourNum % 12 === 0 ? 12 : hourNum % 12;
    const timeStr = `${displayHour}:00 ${ampm}`;

    // Daily at H:00: 0 H * * *
    if (dom === "*" && dow === "*") {
      return `Daily at ${timeStr}`;
    }

    // Weekly on [Day] at H:00: 0 H * * D
    const dayNames = [
      "Sunday",
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
    ];
    const dowNum = parseInt(dow, 10);
    if (
      dom === "*" &&
      /^\d+$/.test(dow) &&
      !isNaN(dowNum) &&
      dowNum >= 0 &&
      dowNum <= 6
    ) {
      return `Weekly on ${dayNames[dowNum]} at ${timeStr}`;
    }

    // Monthly on the 1st at H:00: 0 H 1 * *
    if (dom === "1" && dow === "*") {
      return `Monthly on the 1st at ${timeStr}`;
    }
  }

  // Fallback: return a generic string using the expression itself
  return `Cron: ${expr}`;
}
