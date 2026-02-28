import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { securityHeaders } from "../src/api/security-headers.js";

function createTestApp(): Hono {
  const app = new Hono();
  app.use("*", securityHeaders());
  app.get("/test", (c) => c.json({ ok: true }));
  app.get("/html", (c) => c.html("<h1>hello</h1>"));
  return app;
}

describe("securityHeaders middleware", () => {
  const app = createTestApp();

  const EXPECTED_HEADERS = {
    "content-security-policy":
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' https://upload.wikimedia.org https://commons.wikimedia.org; connect-src 'self'",
    "x-frame-options": "DENY",
    "x-content-type-options": "nosniff",
    "strict-transport-security": "max-age=31536000; includeSubDomains",
    "referrer-policy": "strict-origin-when-cross-origin",
  };

  for (const [header, expected] of Object.entries(EXPECTED_HEADERS)) {
    it(`sets ${header}`, async () => {
      const res = await app.request("/test");
      expect(res.headers.get(header)).toBe(expected);
    });
  }

  it("sets all security headers on HTML responses too", async () => {
    const res = await app.request("/html");
    for (const [header, expected] of Object.entries(EXPECTED_HEADERS)) {
      expect(res.headers.get(header)).toBe(expected);
    }
  });

  it("does not interfere with response body", async () => {
    const res = await app.request("/test");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });
});
