## ADDED Requirements

### Requirement: Spawn cloudflared tunnel on startup
The tunnel manager SHALL spawn `cloudflared tunnel run` as a child process when `orca start` is executed. The tunnel configuration (hostname, credentials) SHALL be pre-configured via the `cloudflared` CLI (one-time manual setup). The tunnel SHALL route traffic to the local Hono server.

#### Scenario: Tunnel started on orca start
- **WHEN** `orca start` is executed
- **THEN** the tunnel manager SHALL spawn a `cloudflared tunnel run` child process

#### Scenario: Tunnel connects successfully
- **WHEN** the `cloudflared` child process starts and establishes a connection
- **THEN** the tunnel manager SHALL report the tunnel as connected

### Requirement: Monitor tunnel connection status
The tunnel manager SHALL monitor the `cloudflared` child process's stdout and stderr streams for connection status messages. The tunnel manager SHALL track whether the tunnel is currently connected or disconnected based on these messages.

#### Scenario: Connection status detected from output
- **WHEN** the `cloudflared` process outputs a connection established message
- **THEN** the tunnel manager SHALL update its internal state to connected

#### Scenario: Disconnection detected from output
- **WHEN** the `cloudflared` process outputs a connection lost or error message
- **THEN** the tunnel manager SHALL update its internal state to disconnected

### Requirement: Tunnel health check
The tunnel manager SHALL expose a health check function that returns whether the tunnel is currently connected. Other modules (specifically the polling fallback) SHALL use this health check to determine whether to activate or deactivate polling.

#### Scenario: Health check returns connected
- **WHEN** the tunnel is currently connected and the health check is called
- **THEN** the health check SHALL return true

#### Scenario: Health check returns disconnected
- **WHEN** the tunnel is not connected and the health check is called
- **THEN** the health check SHALL return false

### Requirement: Graceful shutdown
The tunnel manager SHALL kill the `cloudflared` child process when the Orca scheduler shuts down (on SIGTERM or SIGINT). The shutdown handler SHALL ensure the child process is terminated before the Orca process exits.

#### Scenario: Tunnel killed on SIGTERM
- **WHEN** the Orca process receives SIGTERM
- **THEN** the tunnel manager SHALL kill the `cloudflared` child process before exiting

#### Scenario: Tunnel killed on SIGINT
- **WHEN** the Orca process receives SIGINT
- **THEN** the tunnel manager SHALL kill the `cloudflared` child process before exiting

### Requirement: Failure logging and polling fallback activation
When the `cloudflared` child process exits unexpectedly or reports connection errors, the tunnel manager SHALL log the error details. The tunnel health check SHALL report disconnected, which SHALL cause the polling fallback to activate.

#### Scenario: Cloudflared process exits unexpectedly
- **WHEN** the `cloudflared` child process exits with a non-zero exit code
- **THEN** the tunnel manager SHALL log the error and the health check SHALL return false

#### Scenario: Polling fallback activates on tunnel failure
- **WHEN** the tunnel health check returns false
- **THEN** the polling fallback in the sync module SHALL activate and begin polling Linear every 30 seconds
