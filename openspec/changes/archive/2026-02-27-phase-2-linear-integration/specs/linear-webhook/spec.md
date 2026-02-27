## ADDED Requirements

### Requirement: Webhook HTTP endpoint
The system SHALL expose a Hono POST endpoint at `/api/webhooks/linear` for receiving Linear webhook events. The endpoint SHALL accept JSON request bodies.

#### Scenario: POST request received
- **WHEN** a POST request is sent to `/api/webhooks/linear`
- **THEN** the endpoint SHALL process the request body as a Linear webhook event

#### Scenario: Non-POST request rejected
- **WHEN** a GET request is sent to `/api/webhooks/linear`
- **THEN** the endpoint SHALL respond with a 405 Method Not Allowed status

### Requirement: HMAC-SHA256 signature verification
The webhook endpoint SHALL verify every incoming request using HMAC-SHA256 signature verification. The signature SHALL be computed over the raw request body using `ORCA_LINEAR_WEBHOOK_SECRET` as the key and compared against the signature provided in the request headers by Linear. Requests with invalid or missing signatures SHALL be rejected with a 401 Unauthorized status.

#### Scenario: Valid signature accepted
- **WHEN** a webhook request arrives with a valid HMAC-SHA256 signature matching the request body and `ORCA_LINEAR_WEBHOOK_SECRET`
- **THEN** the endpoint SHALL accept and process the request

#### Scenario: Invalid signature rejected
- **WHEN** a webhook request arrives with an HMAC-SHA256 signature that does not match
- **THEN** the endpoint SHALL respond with 401 Unauthorized and SHALL NOT process the event

#### Scenario: Missing signature rejected
- **WHEN** a webhook request arrives without a signature header
- **THEN** the endpoint SHALL respond with 401 Unauthorized and SHALL NOT process the event

### Requirement: Issue event parsing
The webhook endpoint SHALL parse incoming events and identify issue events of type create, update, and remove. The endpoint SHALL extract the issue data including `id`, `identifier`, `title`, `priority`, `state`, `relations`, and `inverseRelations` from the event payload.

#### Scenario: Issue create event parsed
- **WHEN** a webhook delivers an event with action "create" and type "Issue"
- **THEN** the endpoint SHALL parse the issue data and pass it to the sync module

#### Scenario: Issue update event parsed
- **WHEN** a webhook delivers an event with action "update" and type "Issue"
- **THEN** the endpoint SHALL parse the issue data including updated fields and pass it to the sync module

#### Scenario: Issue remove event parsed
- **WHEN** a webhook delivers an event with action "remove" and type "Issue"
- **THEN** the endpoint SHALL parse the issue identifier and pass the removal event to the sync module

### Requirement: Project filter for incoming events
The webhook endpoint SHALL ignore issues that do not belong to any of the configured projects in `ORCA_LINEAR_PROJECT_IDS`. Only events for issues in configured projects SHALL be forwarded to the sync module.

#### Scenario: Issue in configured project processed
- **WHEN** a webhook delivers an event for an issue belonging to a project in `ORCA_LINEAR_PROJECT_IDS`
- **THEN** the endpoint SHALL forward the event to the sync module for processing

#### Scenario: Issue not in configured project ignored
- **WHEN** a webhook delivers an event for an issue belonging to a project NOT in `ORCA_LINEAR_PROJECT_IDS`
- **THEN** the endpoint SHALL ignore the event and respond with 200 without processing

### Requirement: Successful processing response
The webhook endpoint SHALL return a 200 OK status after successfully processing a valid webhook event. This confirms receipt to Linear and prevents redelivery.

#### Scenario: Successful processing returns 200
- **WHEN** a valid webhook event is received, verified, and processed successfully
- **THEN** the endpoint SHALL respond with 200 OK
