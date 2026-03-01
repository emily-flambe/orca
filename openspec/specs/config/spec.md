## MODIFIED Requirements

### Requirement: Required configuration validation
The system SHALL validate that `ORCA_DEFAULT_CWD` is set and points to an existing directory. The system SHALL also validate that `ORCA_LINEAR_API_KEY`, `ORCA_LINEAR_WEBHOOK_SECRET`, `ORCA_LINEAR_PROJECT_IDS`, and `ORCA_TUNNEL_HOSTNAME` are set and non-empty. If any required variable is missing or invalid, the application SHALL exit with a clear error message.

#### Scenario: Missing required config
- **WHEN** `ORCA_DEFAULT_CWD` is not set
- **THEN** the application SHALL exit with error "ORCA_DEFAULT_CWD is required and must be a valid directory path"

#### Scenario: Missing Linear API key
- **WHEN** `ORCA_LINEAR_API_KEY` is not set
- **THEN** the application SHALL exit with error "ORCA_LINEAR_API_KEY is required"

#### Scenario: Missing Linear webhook secret
- **WHEN** `ORCA_LINEAR_WEBHOOK_SECRET` is not set
- **THEN** the application SHALL exit with error "ORCA_LINEAR_WEBHOOK_SECRET is required"

#### Scenario: Missing Linear project IDs
- **WHEN** `ORCA_LINEAR_PROJECT_IDS` is not set
- **THEN** the application SHALL exit with error "ORCA_LINEAR_PROJECT_IDS is required"

#### Scenario: Missing tunnel hostname
- **WHEN** `ORCA_TUNNEL_HOSTNAME` is not set
- **THEN** the application SHALL exit with error "ORCA_TUNNEL_HOSTNAME is required"

### Requirement: Configuration defaults
The following defaults SHALL be used when variables are not set:

| Variable | Default |
|---|---|
| `ORCA_CONCURRENCY_CAP` | 3 |
| `ORCA_SESSION_TIMEOUT_MIN` | 45 |
| `ORCA_MAX_RETRIES` | 3 |
| `ORCA_BUDGET_WINDOW_HOURS` | 4 |
| `ORCA_BUDGET_MAX_COST_USD` | 10.00 |
| `ORCA_SCHEDULER_INTERVAL_SEC` | 10 |
| `ORCA_CLAUDE_PATH` | "claude" |
| `ORCA_DEFAULT_MAX_TURNS` | 200 |
| `ORCA_REVIEW_MAX_TURNS` | 100 |
| `ORCA_RESUME_ON_MAX_TURNS` | true |
| `ORCA_APPEND_SYSTEM_PROMPT` | "" |
| `ORCA_DISALLOWED_TOOLS` | "" |
| `ORCA_PORT` | 3000 |
| `ORCA_DB_PATH` | "./orca.db" |
| `ORCA_LINEAR_READY_STATE_TYPE` | "unstarted" |

#### Scenario: Default values applied
- **WHEN** the application starts with no `.env` file (except required vars)
- **THEN** `ORCA_CONCURRENCY_CAP` SHALL be 3, `ORCA_SESSION_TIMEOUT_MIN` SHALL be 45, `ORCA_LINEAR_READY_STATE_TYPE` SHALL be "unstarted", and all other defaults SHALL apply

## ADDED Requirements

### Requirement: JSON array validation for project IDs
The system SHALL parse `ORCA_LINEAR_PROJECT_IDS` as a JSON array of strings. The parsed value MUST be a non-empty array where every element is a non-empty string. If the value is not valid JSON, not an array, empty, or contains non-string elements, the application SHALL exit with a descriptive error.

#### Scenario: Valid JSON array of project IDs
- **WHEN** `ORCA_LINEAR_PROJECT_IDS` is set to `["proj_abc123", "proj_def456"]`
- **THEN** the config SHALL parse it as an array of two project ID strings

#### Scenario: Invalid JSON format
- **WHEN** `ORCA_LINEAR_PROJECT_IDS` is set to `not-json`
- **THEN** the application SHALL exit with error "ORCA_LINEAR_PROJECT_IDS must be a valid JSON array of strings"

#### Scenario: Empty JSON array
- **WHEN** `ORCA_LINEAR_PROJECT_IDS` is set to `[]`
- **THEN** the application SHALL exit with error "ORCA_LINEAR_PROJECT_IDS must contain at least one project ID"

#### Scenario: Array with non-string elements
- **WHEN** `ORCA_LINEAR_PROJECT_IDS` is set to `[123, 456]`
- **THEN** the application SHALL exit with error "ORCA_LINEAR_PROJECT_IDS must be a valid JSON array of strings"
