import type { SchedulerDeps } from "../scheduler/types.js";

let _deps: SchedulerDeps | null = null;

export function setSchedulerDeps(deps: SchedulerDeps): void {
  _deps = deps;
}

export function getSchedulerDeps(): SchedulerDeps {
  if (!_deps)
    throw new Error(
      "Scheduler deps not initialized — call setSchedulerDeps() first",
    );
  return _deps;
}
