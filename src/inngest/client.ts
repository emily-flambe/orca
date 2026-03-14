import { Inngest } from "inngest";
import { schemas } from "./events.js";

// Single shared Inngest client instance.
// Configure via env vars: INNGEST_EVENT_KEY, INNGEST_SIGNING_KEY, INNGEST_BASE_URL
export const inngest = new Inngest({
  id: "orca",
  schemas,
});

// Inngest functions registry — populate as workflows are built
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const inngestFunctions: any[] = [];
