# Spec Delta

## Purpose

Fills meters automatically wherever a provider offers a dependable source for current usage, so that numbers stay fresh without typing, while keeping every credential out of storage, logs and output.

## ADDED Requirements

### Requirement: Collector registry
The system SHALL maintain a registry of collectors, each identified by an id and described by its provider, the kind of source it reads (local file, documented API, undocumented API or pushed data), what it needs to run and whether those needs are currently met, and SHALL report that list without revealing any credential.

#### Scenario: List collectors
- **WHEN** a client requests the collector list
- **THEN** each collector is listed with its source kind, whether it is enabled, whether its requirements are met and the time and outcome of its last run

#### Scenario: Requirement missing
- **WHEN** a collector needs an environment variable that is not set
- **THEN** it is listed as unavailable with the variable's name and no value

### Requirement: Collectors are opt-in
The system SHALL run a collector only after the user has enabled it, and SHALL label collectors that rely on undocumented endpoints as such wherever they are offered.

#### Scenario: Detected but not enabled
- **WHEN** a collector's local source exists on the machine and the collector is not enabled
- **THEN** nothing is read and the dashboard offers to enable it

#### Scenario: Undocumented source
- **WHEN** a collector that uses an undocumented endpoint is offered
- **THEN** its description says the endpoint is undocumented and may stop working

### Requirement: Scheduling and isolation
The system SHALL run enabled collectors when the service starts, then periodically at each collector's own interval, and on demand, SHALL give each run a time limit, and SHALL isolate failures so that one failing collector never prevents the others from running or the service from serving.

#### Scenario: One collector fails
- **WHEN** one collector times out during a refresh
- **THEN** the other collectors' readings are applied and the failed one reports its reason and is retried at its next interval

#### Scenario: Repeated failures
- **WHEN** a collector fails several times in a row
- **THEN** the gap before its next attempt grows, up to one hour

### Requirement: Readings from collectors
The system SHALL apply a collector's result as readings on the matching account and meters, creating the account from the catalog preset on first success, marking each updated meter with the collector as its source, and leaving meters the collector did not report untouched.

#### Scenario: First successful run
- **WHEN** an enabled collector returns readings and no matching account exists
- **THEN** an account is created from the provider's preset and the readings are applied to it

#### Scenario: Manual meter alongside collected ones
- **WHEN** an account has a meter the collector does not report
- **THEN** that meter keeps its value and source

### Requirement: Credentials stay outside
The system SHALL read provider credentials only from the process environment or from an environment file in the Tokengator home directory at the moment of a request, and SHALL never write them to the state, logs, API responses, MCP output or error messages.

#### Scenario: Export after collecting
- **WHEN** the state is exported after collectors have run
- **THEN** the export contains no credential

#### Scenario: Provider rejects a key
- **WHEN** a provider answers with an authorisation error
- **THEN** the collector's status says the credential was rejected and names the variable, without its value

### Requirement: Outbound requests are narrow
A collector SHALL contact only its provider's own host over HTTPS, SHALL not follow redirects to another host, and SHALL send a credential only to the host it belongs to.

#### Scenario: Redirect to another host
- **WHEN** a provider's response redirects to a different host
- **THEN** the collector stops, sends nothing to that host and reports the failure

### Requirement: Claude Code status line input
The command line SHALL accept Claude Code's status line JSON on standard input, record the rate-limit windows it contains as readings on the Claude account, and print a one-line status showing the share left and time to reset of the most urgent window. It SHALL print a line and exit successfully even when the input has no rate-limit data or the state cannot be written.

#### Scenario: Status line with rate limits
- **WHEN** the status line command receives input containing the five-hour and seven-day windows
- **THEN** both meters are updated with their used percentage and reset time and one line is printed

#### Scenario: Input without rate limits
- **WHEN** the input has no rate-limit data
- **THEN** nothing is changed, a line is still printed and the exit code is 0

### Requirement: Local session logs
A collector SHALL be able to read the most recent rate-limit snapshot from Codex session logs on the local machine without contacting any server, ignoring snapshots whose windows have already ended.

#### Scenario: Recent snapshot
- **WHEN** the newest session log holds a rate-limit snapshot whose weekly window is still open
- **THEN** the Codex account's weekly meter is set to that snapshot's used percentage and reset time

#### Scenario: Only old snapshots
- **WHEN** every snapshot found refers to windows that have ended
- **THEN** no reading is applied and the collector reports that no current data was found
