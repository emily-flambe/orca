import type { OrcaConfig } from "../config/index.js";
import type { OrcaDb } from "../db/index.js";
import type { DependencyGraph } from "../linear/graph.js";
import type { LinearClient, WorkflowStateMap } from "../linear/client.js";

export interface SchedulerDeps {
  db: OrcaDb;
  config: OrcaConfig;
  graph: DependencyGraph;
  client: LinearClient;
  stateMap: WorkflowStateMap;
}
