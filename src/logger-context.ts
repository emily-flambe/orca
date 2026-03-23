import { AsyncLocalStorage } from "node:async_hooks";

export interface LogContext {
  taskId?: string;
  invocationId?: string;
}

const store = new AsyncLocalStorage<LogContext>();

export function runWithLogContext<T>(ctx: LogContext, fn: () => T): T {
  return store.run(ctx, fn);
}

export function getLogContext(): LogContext {
  return store.getStore() ?? {};
}
