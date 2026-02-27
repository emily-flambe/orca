## ADDED Requirements

### Requirement: Environment-based configuration
The system SHALL read configuration from a `.env` file in the project root using `dotenv`. All variables SHALL be prefixed with `ORCA_`.

#### Scenario: Config loaded from .env
- **WHEN** the application starts and a `.env` file exists with `ORCA_CONCURRENCY_CAP=5`
- **THEN** the concurrency cap SHALL be set to 5

#### Scenario: Missing .env file
- **WHEN** the application starts and no `.env` file exists
- **THEN** all settings SHALL use their default values

### Requirement: Required configuration validation
The system SHALL validate that `ORCA_DEFAULT_CWD` is set and points to an existing directory. If missing or invalid, the application SHALL exit with a clear error message.

#### Scenario: Missing required config
- **WHEN** `ORCA_DEFAULT_CWD` is not set
- **THEN** the application SHALL exit with error "ORCA_DEFAULT_CWD is required and must be a valid directory path"

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
| `ORCA_DEFAULT_MAX_TURNS` | 20 |
| `ORCA_APPEND_SYSTEM_PROMPT` | "" |
| `ORCA_DISALLOWED_TOOLS` | "" |
| `ORCA_PORT` | 3000 |
| `ORCA_DB_PATH` | "./orca.db" |

#### Scenario: Default values applied
- **WHEN** the application starts with no `.env` file (except required vars)
- **THEN** `ORCA_CONCURRENCY_CAP` SHALL be 3, `ORCA_SESSION_TIMEOUT_MIN` SHALL be 45, and all other defaults SHALL apply

### Requirement: Type validation
Integer config values SHALL be validated as positive integers. Numeric config values (cost) SHALL be validated as positive numbers. Invalid values SHALL cause the application to exit with a descriptive error.

#### Scenario: Invalid integer config
- **WHEN** `ORCA_CONCURRENCY_CAP` is set to "abc"
- **THEN** the application SHALL exit with error "ORCA_CONCURRENCY_CAP must be a positive integer"
