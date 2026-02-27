## 1. Config Updates

- [x] 1.1 Add Linear and tunnel config variables to `OrcaConfig` interface: `linearApiKey`, `linearWebhookSecret`, `linearProjectIds` (string[]), `linearReadyStateType`, `tunnelHostname`
- [x] 1.2 Update `loadConfig()` to validate new required vars (`ORCA_LINEAR_API_KEY`, `ORCA_LINEAR_WEBHOOK_SECRET`, `ORCA_LINEAR_PROJECT_IDS`, `ORCA_TUNNEL_HOSTNAME`) and parse `ORCA_LINEAR_PROJECT_IDS` as JSON array
- [x] 1.3 Add default for `ORCA_LINEAR_READY_STATE_TYPE` ("unstarted")
- [x] 1.4 Update `.env.example` with new variables

## 2. Linear API Client

- [x] 2.1 Create `src/linear/client.ts` — typed GraphQL request helper with `Authorization` header and error handling
- [x] 2.2 Implement `fetchProjectIssues(projectIds)` — paginated query with `first: 25`, returns issues with id, identifier, title, priority, state (id, name, type), relations, inverseRelations
- [x] 2.3 Implement `fetchWorkflowStates(teamIds)` — fetch team workflow states, return map of state type → state ID for write-back
- [x] 2.4 Implement `updateIssueState(issueId, stateId)` — GraphQL mutation via `issueUpdate`
- [x] 2.5 Implement rate limit monitoring: read `X-RateLimit-Requests-Remaining` header, log warnings below 500

## 3. Dependency Graph

- [x] 3.1 Create `src/linear/graph.ts` — `DependencyGraph` class with `blockedBy` and `blocks` adjacency maps
- [x] 3.2 Implement `rebuild(issues)` — populate graph from Linear issue relations/inverseRelations
- [x] 3.3 Implement `isDispatchable(taskId)` — check all blockers have status "done"
- [x] 3.4 Implement `computeEffectivePriority(taskId, priorities)` — transitive walk with cycle detection via visited set
- [x] 3.5 Implement incremental update methods: `addRelation`, `removeRelation` for webhook events

## 4. Linear Sync Module

- [x] 4.1 Create `src/linear/sync.ts` — `fullSync(db, client, graph, config)`: fetch all issues, upsert into tasks table, rebuild dependency graph
- [x] 4.2 Implement upsert logic: create task with empty `agent_prompt` if not exists, update priority/state if exists
- [x] 4.3 Implement `processWebhookEvent(db, client, graph, config, event)` — handle issue create/update/remove events
- [x] 4.4 Implement conflict resolution: `resolveConflict(taskId, linearStateType, db)` — Linear wins, including killing running sessions
- [x] 4.5 Implement write-back: `writeBackStatus(client, taskId, orcaTransition, stateMap)` — update Linear issue state on Orca transitions
- [x] 4.6 Implement write-back loop prevention: expected-change Map with 10s TTL, check before processing webhooks

## 5. Linear Webhook Endpoint

- [x] 5.1 Create `src/linear/webhook.ts` — Hono route handler for `POST /api/webhooks/linear`
- [x] 5.2 Implement HMAC-SHA256 signature verification using `ORCA_LINEAR_WEBHOOK_SECRET`
- [x] 5.3 Parse webhook payload, filter by configured project IDs, pass valid events to sync module
- [x] 5.4 Return 200 on success, 401 on invalid signature

## 6. Tunnel Manager

- [x] 6.1 Create `src/tunnel/index.ts` — spawn `cloudflared tunnel run` as child process
- [x] 6.2 Implement stdout/stderr monitoring for connection status
- [x] 6.3 Expose health check function: `isTunnelConnected()` → boolean
- [x] 6.4 Implement shutdown: kill cloudflared process on `stop()`

## 7. Polling Fallback

- [x] 7.1 Create `src/linear/poller.ts` — timer-based poller that fetches issues updated since last sync every 30s
- [x] 7.2 Implement activation/deactivation tied to tunnel health check
- [x] 7.3 Integrate with sync module: pass fetched issues through same upsert/conflict logic

## 8. Scheduler Modifications

- [x] 8.1 Update tick function to filter blocked tasks via `graph.isDispatchable()`
- [x] 8.2 Update tick function to sort by effective priority via `graph.computeEffectivePriority()`
- [x] 8.3 Add guard: skip tasks with empty `agent_prompt`
- [x] 8.4 Add write-back call in dispatch handler (ready→dispatched → Linear "started")
- [x] 8.5 Add write-back call in completion handler (done → Linear "completed", failed permanent → "canceled", retry → "unstarted")

## 9. CLI Updates

- [x] 9.1 Implement `orca prompt <issueId> "<text>"` command — update `agent_prompt` in tasks table
- [x] 9.2 Update `orca start` to initialize Linear client, fetch workflow states, run full sync
- [x] 9.3 Update `orca start` to create Hono app with webhook route and start HTTP server
- [x] 9.4 Update `orca start` to spawn tunnel and start polling fallback monitor
- [x] 9.5 Update shutdown handler to kill tunnel process

## 10. Integration Testing

- [x] 10.1 Test Linear client with mock GraphQL responses: issue fetch, workflow state fetch, issue update
- [x] 10.2 Test dependency graph: build from relations, isDispatchable, computeEffectivePriority, cycle detection
- [x] 10.3 Test conflict resolution: all 4 cases (running→unstarted, ready→completed, done→unstarted, any→canceled)
- [x] 10.4 Test write-back loop prevention: expected-change TTL, echo detection
- [x] 10.5 Test webhook HMAC verification: valid signature, invalid signature, missing header
- [x] 10.6 Test polling fallback: activation on tunnel down, deactivation on tunnel up
