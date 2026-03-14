// Side-effect import: load .env BEFORE constructing the Inngest client.
// This module is imported at ESM parse time (before cli/index.ts calls loadConfig).
// Without this, INNGEST_BASE_URL is missing and the SDK defaults to Inngest Cloud.
import "dotenv/config";
import { Inngest } from "inngest";
import { schemas } from "./events.js";

export const inngest = new Inngest({
  id: "orca",
  schemas,
});

export type InngestClient = typeof inngest;
