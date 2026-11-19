# local-service Specification

## Purpose
The local process that stores the state and serves the dashboard, the HTTP API and the MCP endpoint, together with the command-line interface that starts and drives it.

## Requirements

### Requirement: Loopback by default
The service SHALL listen on 127.0.0.1 unless configured otherwise and SHALL refuse to start on a non-loopback address unless an access token is configured.

#### Scenario: Default start
- **WHEN** the service starts with no configuration
- **THEN** it listens on 127.0.0.1 port 4777 and prints the address to open

#### Scenario: Exposed without a token
- **WHEN** the service is told to listen on 0.0.0.0 and no token is set
- **THEN** it exits with an error explaining that a token is required

### Requirement: Request validation
The service SHALL reject requests whose Host header is not one of its own addresses, SHALL reject state-changing requests that carry an Origin other than its own, and SHALL accept request bodies only as JSON up to 256 KB. The one request that carries a whole state document, an import, SHALL instead be accepted up to 16 MB, so that a document the service exported can always be imported back.

#### Scenario: DNS rebinding attempt
- **WHEN** a request arrives with Host `evil.example`
- **THEN** it is answered with 403 and no data

#### Scenario: Cross-site write
- **WHEN** a POST arrives with Origin `https://evil.example`
- **THEN** it is answered with 403 and nothing changes

#### Scenario: Oversized body
- **WHEN** a request body exceeds 256 KB
- **THEN** it is answered with 413 and nothing changes

#### Scenario: Restoring a large backup
- **WHEN** a state with a year of history exports to more than 256 KB and that export is posted to the import route
- **THEN** it is imported

### Requirement: Optional access token
The service SHALL, when a token is configured, require it on the API, the event stream and the MCP endpoint, as a bearer header or as a session cookie obtained by presenting the token once, SHALL compare tokens in constant time, and SHALL never accept a token in a query string.

#### Scenario: Missing token
- **WHEN** a token is configured and a request to the API carries none
- **THEN** it is answered with 401

#### Scenario: Opening the dashboard with the token
- **WHEN** the dashboard is opened with the token in the address fragment
- **THEN** the dashboard exchanges it for a same-site, HTTP-only session cookie and removes the fragment from the address

#### Scenario: Token in a query string
- **WHEN** a request carries the token only as a query parameter
- **THEN** it is answered with 401

### Requirement: Durable state
The service SHALL store its state as a single JSON document in the Tokengator home directory, SHALL replace the document atomically on every change, SHALL serialise concurrent writers from different processes so that no update is lost, and SHALL refuse to overwrite a document it cannot parse, keeping it aside and reporting where it is.

#### Scenario: Two writers
- **WHEN** the service and a CLI command update different meters at the same moment
- **THEN** both updates are present afterwards

#### Scenario: Corrupt document
- **WHEN** the stored document is not valid JSON
- **THEN** the service starts with an empty state, leaves the corrupt file in place under a new name and reports that name

#### Scenario: Change made by another process
- **WHEN** another process changes the stored document while the service is running
- **THEN** connected dashboards are told to refresh within five seconds

### Requirement: A stored document always loads
The service SHALL refuse any input that would leave a number in the state that is not finite, and SHALL never write a state document that it could not read back. When a change would produce such a document it SHALL be refused, the file SHALL stay as it was, and nothing SHALL be set aside as corrupt.

#### Scenario: A reading that overflows
- **WHEN** a reading with `used` 1e308 and `limit` 1e-300 is reported
- **THEN** it is answered with a validation error and the state file is unchanged

#### Scenario: An import with a number too large to represent
- **WHEN** an imported document contains a sample or a spend entry of 1e999
- **THEN** the import succeeds without that figure and the stored document loads again

#### Scenario: Defence in depth
- **WHEN** a change that passed validation would still serialise to a document the service cannot load
- **THEN** the write is refused and the previous file is untouched

#### Scenario: A file a Windows tool re-encoded
- **WHEN** the state file or the environment file starts with a byte-order mark, as UTF-8 or as UTF-16
- **THEN** it is read as the text it holds, and the state file is not set aside as corrupt

### Requirement: Private home directory
The service SHALL create its home directory, its state file and its record of reminders readable and writable by the owning user only, and `doctor` SHALL say so when the environment file can be read by other users.

#### Scenario: First start
- **WHEN** the service creates its home directory on a POSIX system
- **THEN** the directory has no permissions for group or others

#### Scenario: Readable environment file
- **WHEN** the environment file has permissions for group or others
- **THEN** `doctor` says it can be read by other users and how to make it private

### Requirement: Collector switches are atomic
Switching a collector on or off SHALL be one change to the stored list, made under the same lock as every other change, and the answer SHALL report what was stored.

#### Scenario: Several switched at once
- **WHEN** five collectors are switched on at the same moment
- **THEN** all five are stored as on

### Requirement: HTTP API
The service SHALL provide a JSON API to read the full state, create, update and delete accounts and meters, record readings and quick updates, manage spend sources and entries, read the catalog, export and import state, run collectors and read their status, together with a server-sent event stream that announces every change. Errors SHALL use a consistent JSON shape with a code and a message.

#### Scenario: Read state
- **WHEN** a client requests the state
- **THEN** it receives accounts, spend sources, finished cycles, settings and collector status as JSON, with windows already rolled forward to the current time

#### Scenario: Validation error
- **WHEN** a client submits a meter with a negative limit
- **THEN** it receives status 400 with a code and a message naming the field

### Requirement: Command line
The command line SHALL start the service, print the current situation in the terminal, record a quick update, add an account from the catalog, run the stdio MCP server, handle Claude Code status line input, manage collectors, print connection snippets, install the agent skill and report the paths and sources it found.

#### Scenario: Status in the terminal
- **WHEN** the user runs the status command
- **THEN** the terminal lists allowance meters in "use first" order with share left, time to reset and value at risk, and exits with code 0

#### Scenario: Machine-readable status
- **WHEN** the status command is run with the JSON option
- **THEN** it prints the same information as one JSON document

#### Scenario: Unknown command
- **WHEN** an unknown command is given
- **THEN** usage help is printed and the exit code is non-zero

#### Scenario: Snippets on Windows
- **WHEN** connection snippets are printed on Windows for an installation under `C:\Users\me`
- **THEN** the path in them is written with forward slashes, so that neither Git Bash nor PowerShell changes it

#### Scenario: A shim that is not on the search path
- **WHEN** the command was started through a project-local shim, or from a clone
- **THEN** the snippets name the built entry point in full rather than the short command name

#### Scenario: Writing a document without a shell
- **WHEN** export or calendar is run with an output file
- **THEN** the file is written as UTF-8 by the command itself

#### Scenario: A command for schedulers
- **WHEN** the paths report is printed
- **THEN** it includes the command with the absolute paths of the runtime and the entry point, for schedulers that search no user directories

### Requirement: Nothing sensitive in logs
The service SHALL log to standard error only, SHALL never log credentials, tokens, authorization headers, cookies or request bodies, and SHALL keep standard output of the stdio MCP server free of anything but protocol messages.

#### Scenario: Collector fails with an authorisation error
- **WHEN** a collector's request is refused by the provider
- **THEN** the log names the collector and the status code and contains no credential
