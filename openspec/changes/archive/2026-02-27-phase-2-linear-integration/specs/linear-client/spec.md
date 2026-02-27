## ADDED Requirements

### Requirement: Linear API authentication
The Linear client SHALL authenticate all requests to `https://api.linear.app/graphql` by including the `ORCA_LINEAR_API_KEY` value as an `Authorization` header. The client SHALL fail immediately with a descriptive error if the API key is missing or empty.

#### Scenario: Successful authentication
- **WHEN** the Linear client sends a request with a valid `ORCA_LINEAR_API_KEY`
- **THEN** the request SHALL include the header `Authorization: <key>` and the API SHALL return a successful response

#### Scenario: Authentication failure
- **WHEN** the Linear API responds with a 401 Unauthorized status
- **THEN** the client SHALL NOT retry the request and SHALL propagate the authentication error to the caller

### Requirement: Fetch project issues with pagination
The Linear client SHALL provide a `fetchProjectIssues` function that queries all issues from the configured project IDs. The query SHALL request the fields: `id`, `identifier`, `title`, `priority`, `state` (with `id`, `name`, `type`), `relations`, and `inverseRelations`. Pagination SHALL use `first: 25` per page and follow `endCursor` until `hasNextPage` is false.

#### Scenario: Single page of issues
- **WHEN** `fetchProjectIssues` is called and the project has 10 issues
- **THEN** the client SHALL return all 10 issues in a single request with `first: 25`

#### Scenario: Multi-page pagination
- **WHEN** `fetchProjectIssues` is called and the project has 60 issues
- **THEN** the client SHALL make 3 paginated requests (25 + 25 + 10) following `endCursor` and return all 60 issues

#### Scenario: Issues from multiple projects
- **WHEN** `fetchProjectIssues` is called with multiple project IDs
- **THEN** the client SHALL fetch and return issues from all configured projects

### Requirement: Fetch and cache workflow states
The Linear client SHALL provide a `fetchWorkflowStates` function that retrieves all workflow states for a team, returning `id`, `name`, and `type` for each state. Workflow states SHALL be fetched and cached on startup. The cache SHALL provide a mapping from state type to state UUID for use during write-back operations.

#### Scenario: Workflow states cached on startup
- **WHEN** the Linear client initializes
- **THEN** it SHALL fetch workflow states and cache the state type to UUID mapping

#### Scenario: State type lookup from cache
- **WHEN** the sync module needs the UUID for state type "completed"
- **THEN** the client SHALL return the cached UUID without making an additional API request

### Requirement: Update issue workflow state
The Linear client SHALL provide an `updateIssueState` function that sends an `issueUpdate` GraphQL mutation to change the workflow state of an issue. The function SHALL accept an issue ID and a target state ID.

#### Scenario: Successful state update
- **WHEN** `updateIssueState` is called with a valid issue ID and state ID
- **THEN** the client SHALL send the `issueUpdate` mutation and the issue's workflow state SHALL be updated in Linear

#### Scenario: State update failure
- **WHEN** the `issueUpdate` mutation fails with a non-transient error
- **THEN** the client SHALL log the error and propagate it to the caller

### Requirement: Rate limit monitoring
The Linear client SHALL read the `X-RateLimit-Requests-Remaining` header from every API response. When the remaining request count drops below 500, the client SHALL log a warning including the current remaining count.

#### Scenario: Rate limit warning threshold
- **WHEN** the `X-RateLimit-Requests-Remaining` header value is 499 or lower
- **THEN** the client SHALL log a warning message including the remaining count

#### Scenario: Rate limit above threshold
- **WHEN** the `X-RateLimit-Requests-Remaining` header value is 500 or higher
- **THEN** the client SHALL NOT log a rate limit warning

### Requirement: Error handling with retry
The Linear client SHALL retry requests that fail with transient errors (network errors, 5xx status codes, 429 rate limit). Retries SHALL use exponential backoff. The client SHALL NOT retry requests that fail with authentication errors (401) or client errors (4xx other than 429).

#### Scenario: Retry on transient server error
- **WHEN** a request fails with a 500 Internal Server Error
- **THEN** the client SHALL retry the request with exponential backoff

#### Scenario: Retry on rate limit
- **WHEN** a request fails with a 429 Too Many Requests status
- **THEN** the client SHALL retry the request with exponential backoff

#### Scenario: No retry on auth error
- **WHEN** a request fails with a 401 Unauthorized status
- **THEN** the client SHALL NOT retry and SHALL immediately propagate the error

#### Scenario: No retry on client error
- **WHEN** a request fails with a 400 Bad Request status
- **THEN** the client SHALL NOT retry and SHALL immediately propagate the error
