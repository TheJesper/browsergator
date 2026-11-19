# mcp-server Specification

## Purpose
Lets AI agents read the same quota picture a person sees and keep it current: which subscription to spend, what is about to expire, and a way to report fresh numbers.

## Requirements

### Requirement: Two transports, one state
The system SHALL expose its MCP server over Streamable HTTP at `/mcp` on the local service and over stdio from the command line, and both SHALL read and write the same stored state.

#### Scenario: Report over stdio, read over HTTP
- **WHEN** an agent reports a reading through the stdio server while the local service is running
- **THEN** a client of the HTTP server and the dashboard see the new reading

#### Scenario: Stdio without the service
- **WHEN** the stdio server is started while the local service is not running
- **THEN** its tools still work against the stored state

### Requirement: Both generations of the protocol
The MCP server SHALL serve the 2026-07-28 revision of the protocol and SHALL keep serving clients that open with the earlier `initialize` handshake, from the same tool, resource and prompt definitions, over both transports. Over HTTP neither generation SHALL use a session id. A reading reported by a client of the 2026-07-28 revision SHALL be attributed to the client name carried in that request.

#### Scenario: A client of the current revision
- **WHEN** a client pinned to 2026-07-28 connects over HTTP and reports usage
- **THEN** the call succeeds without a handshake and the reading's source names that client

#### Scenario: A client that only knows the handshake
- **WHEN** a client opens with `initialize` at revision 2025-11-25
- **THEN** it is served, lists the same tools, and receives plain JSON answers without a session id

#### Scenario: A client that can speak either
- **WHEN** a client that probes for the newer revision connects
- **THEN** it negotiates 2026-07-28

#### Scenario: Headers that contradict the body
- **WHEN** a request of the current revision names one tool in its routing header and another in its body
- **THEN** the request is refused

### Requirement: Use-first guidance for agents
The MCP server SHALL provide a `what_to_use` tool that returns allowance meters in "use first" order with each meter's tier, share left, time to reset, value at risk, required pace, staleness, any blocking throttle and a one-sentence recommendation, as readable text and as structured data.

#### Scenario: Choosing a subscription for a large task
- **WHEN** an agent calls `what_to_use`
- **THEN** the first entry is the meter with the most urgent quota and its text says how much is left and when it resets

#### Scenario: Nothing at risk
- **WHEN** no meter is `use-now` or `behind`
- **THEN** the tool says nothing is at risk and still lists the meters in order

### Requirement: Reading tools
The MCP server SHALL provide tools to list accounts with their meters and forecasts, to get one account in full including samples and recent cycles, to list the provider catalog with usage-page addresses and reading notes, to report the waste ledger totals and to report API costs.

#### Scenario: Catalog tells an agent where to look
- **WHEN** an agent calls `list_catalog` for a provider
- **THEN** the result includes the address of the provider's usage page and which figures to read from it

#### Scenario: A provider filled by a status line
- **WHEN** an agent asks the catalog about a provider whose own tool pushes readings through a status line
- **THEN** the result says so and lists only collector ids that the refresh tool accepts

### Requirement: Reporting usage
The MCP server SHALL provide a `report_usage` tool that records a reading for a meter identified by account and meter name, key or id, accepting used or remaining amounts or percentages and an optional reset time or minutes until reset, and a `quick_update` tool that accepts the same one-line form as the dashboard's quick entry.

#### Scenario: Agent reads a usage page
- **WHEN** an agent calls `report_usage` with account "suno", remaining 1200 and a reset time
- **THEN** the meter is updated, marked as reported by an agent, and the result states the new forecast

#### Scenario: Ambiguous account
- **WHEN** the account name matches more than one account
- **THEN** nothing is changed and the result lists the candidates with their ids

#### Scenario: Unknown meter
- **WHEN** the meter name matches no meter of the account
- **THEN** nothing is changed and the result lists the account's meters

### Requirement: Managing accounts
The MCP server SHALL provide tools to add an account from a catalog preset or from a custom definition, to update an account or meter, and to remove an account. Removal SHALL require an explicit confirmation argument and SHALL otherwise describe what would be removed.

#### Scenario: Remove without confirmation
- **WHEN** an agent calls `remove_account` without the confirmation argument
- **THEN** nothing is removed and the result names the account and its meters

### Requirement: Resources and prompt
The MCP server SHALL expose a Markdown brief of the current situation and the full state as JSON as resources, and SHALL expose a prompt that asks the model to plan how to use the quota at risk with the work the user has in mind.

#### Scenario: Read the brief
- **WHEN** a client reads the brief resource
- **THEN** it receives the same Markdown the dashboard's "copy brief" produces at that moment

### Requirement: Safe and descriptive tools
Every tool SHALL declare whether it only reads, SHALL validate its input and answer invalid input with a message that names the field and the accepted values, and SHALL never include credentials, tokens or file contents from the user's machine in its output.

#### Scenario: Invalid percentage
- **WHEN** `report_usage` is called with a used percentage of 140
- **THEN** the result is an error naming the field and the accepted range and nothing is changed

### Requirement: Refreshing from collectors
The MCP server SHALL provide a tool that runs the enabled collectors on demand and reports, per collector, whether it succeeded and which meters changed.

#### Scenario: Refresh
- **WHEN** an agent calls `refresh_usage`
- **THEN** each enabled collector runs once and the result lists updated meters and any failure reasons
