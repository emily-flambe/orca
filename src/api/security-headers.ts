import type { MiddlewareHandler } from "hono";

/**
 * Hono middleware that sets security headers on every response.
 */
export function securityHeaders(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    c.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' https://upload.wikimedia.org https://commons.wikimedia.org; connect-src 'self'",
    );
    c.header("X-Frame-Options", "DENY");
    c.header("X-Content-Type-Options", "nosniff");
    c.header(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains",
    );
    c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  };
}
