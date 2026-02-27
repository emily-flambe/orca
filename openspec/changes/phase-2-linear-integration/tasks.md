## 1. Config Updates

- [ ] 1.1 Add Linear and tunnel config variables to `OrcaConfig` interface: `linearApiKey`, `linearWebhookSecret`, `linearProjectIds` (string[]), `linearReadyStateType`, `tunnelHostname`
- [ ] 1.2 Update `loadConfig()` to validate new required vars (`ORCA_LINEAR_API_KEY`, `ORCA_LINEAR_WEBHOOK_SECRET`, `ORCA_LINEAR_PROJECT_IDS`, `ORCA_TUNNEL_HOSTNAME`) and parse `ORCA_LINEAR_PROJECT_IDS` as JSON array
- [ ] 1.3 Add default for `ORCA_LINEAR_READY_STATE_TYPE` ("unstarted")
- [ ] 1.4 Update `.env.example` with new variables

## 2. Linear API Client

- [ ] 2.1 Create `src/linear/client.ts` — typed GraphQL request helper with `Authorization` header and error handling
- [ ] 2.2 Implement `fetchProjectIssues(projectIds)` — paginated query with `first: 25`, returns issues with id, identifier, title, priority, state (id, name, type), relations, inverseRelations
- [ ] 2.3 Implement `fetchWorkflowStates(teamIds)` — fetch team workflow states, return map of state type → state ID for write-back
- [ ] 2.4 Implement `updateIssueState(issueId, stateId)` — GraphQL mutation via `issueUpdate`
- [ ] 2.5 Implement rate limit monitoring: read `X-RateLimit-Requests-Remaining` header, log warnings below 500

## 3. Dependency Graph

- [ ] 3.1 Create `src/linear/graph.ts` — `DependencyGraph` class with `blockedBy` and `blocks` adjacency maps
- [ ] 3.2 Implement `rebuild(issues)` — populate graph from Linear issue relations/inverseRelations
- [ ] 3.3 Implement `isDispatchable(taskId)` — check all blockers have status "done"
- [ ] 3.4 Implement `computeEffectivePriority(taskId, priorities)` — transitive walk with cycle detection via visited set
- [ ] 3.5 Implement incremental update methods: `addRelation`, `removeRelation` for webhook events

## 4. Linear Sync Module

- [ ] 4.1 Create `src/linear/sync.ts` — `fullSync(db, client, graph, config)`: fetch all issues, upsert into tasks table, rebuild dependency graph
- [ ] 4.2 Implement upsert logic: create task with empty `agent_prompt` if not exists, update priority/state if exists
- [ ] 4.3 Implement `processWebhookEvent(db, client, graph, config, event)` — handle issue create/update/remove events
- [ ] 4.4 Implement conflict resolution: `resolveConflict(taskId, linearStateType, db)` — Linear wins, including killing running sessions
- [ ] 4.5 Implement write-back: `writeBackStatus(client, taskId, orcaTransition, stateMap)` — update Linear issue state on Orca transitions
- [ ] 4.6 Implement write-back loop prevention: expected-change Map with 10s TTL, check before processing webhooks

## 5. Linear Webhook Endpoint

- [ ] 5.1 Create `src/linear/webhook.ts` — Hono route handler for `POST /api/webhooks/linear`
- [ ] 5.2 Implement HMAC-SHA256 signature verification using `ORCA_LINEAR_WEBHOOK_SECRET`
- [ ] 5.3 Parse webhook payload, filter by configured project IDs, pass valid events to sync module
- [ ] 5.4 Return 200 on success, 401 on invalid signature

## 6. Tunnel Manager

- [ ] 6.1 Create `src/tunnel/index.ts` — spawn `cloudflared tunnel run` as child process
- [ ] 6.2 Implement stdout/stderr monitoring for connection status
- [ ] 6.3 Expose health check function: `isTunnelConnected()` → boolean
- [ ] 6.4 Implement shutdown: kill cloudflared process on `stop()`

## 7. Polling Fallback

- [ ] 7.1 Create `src/linear/poller.ts` — timer-based poller that fetches issues updated since last sync every 30s
- [ ] 7.2 Implement activation/deactivation tied to tunnel health check
- [ ] 7.3 Integrate with sync module: pass fetched issues through same upsert/conflict logic

## 8. Scheduler Modifications

- [ ] 8.1 Update tick function to filter blocked tasks via `graph.isDispatchable()`
- [ ] 8.2 Update tick function to sort by effective priority via `graph.computeEffectivePriority()`
- [ ] 8.3 Add guard: skip tasks with empty `agent_prompt`
- [ ] 8.4 Add write-back call in dispatch handler (ready→dispatched → Linear "started")
- [ ] 8.5 Add write-back call in completion handler (done → Linear "completed", failed permanent → "canceled", retry → "unstarted")

## 9. CLI Updates

- [ ] 9.1 Implement `orca prompt <issueId> "<text>"` command — update `agent_prompt` in tasks table
- [ ] 9.2 Update `orca start` to initialize Linear client, fetch workflow states, run full sync
- [ ] 9.3 Update `orca start` to create Hono app with webhook route and start HTTP server
- [ ] 9.4 Update `orca start` to spawn tunnel and start polling fallback monitor
- [ ] 9.5 Update shutdown handler to kill tunnel process

## 10. Integration Testing

- [ ] 10.1 Test Linear client with mock GraphQL responses: issue fetch, workflow state fetch, issue update
- [ ] 10.2 Test dependency graph: build from relations, isDispatchable, computeEffectivePriority, cycle detection
- [ ] 10.3 Test conflict resolution: all 4 cases (running→unstarted, ready→completed, done→unstarted, any→canceled)
- [ ] 10.4 Test write-back loop prevention: expected-change TTL, echo detection
- [ ] 10.5 Test webhook HMAC verification: valid signature, invalid signature, missing header
- [ ] 10.6 Test polling fallback: activation on tunnel down, deactivation on tunnel up
