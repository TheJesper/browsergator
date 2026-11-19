# Spec Delta

## Purpose

A skill that teaches coding and browsing agents to consult Tokengator, to prefer quota that is about to expire, and to keep the numbers fresh, without ever spending quota the user did not ask to spend.

## ADDED Requirements

### Requirement: Skill content
The package SHALL ship a skill that states when to use it, how to reach Tokengator over MCP or the command line, how to read `what_to_use`, how to choose between subscriptions for work the user has asked for, and how to refresh a stale meter by reading the provider's usage page and reporting the figures.

#### Scenario: Choosing where to run a task
- **WHEN** a user asks an agent to run a large job and more than one subscription could do it
- **THEN** the skill directs the agent to call `what_to_use` and to tell the user which subscription has quota about to expire

#### Scenario: Stale numbers
- **WHEN** `what_to_use` marks a meter stale and the agent has a browser tool
- **THEN** the skill directs the agent to read the usage page named in the catalog and call `report_usage` with the figures and the reset time

### Requirement: The skill never spends on its own
The skill SHALL instruct agents to surface expiring quota and suggest uses for it, and SHALL forbid starting work, generating content or making purchases solely to consume quota without the user's request.

#### Scenario: Quota about to expire, nothing requested
- **WHEN** a meter is `use-now` and the user has not asked for any work
- **THEN** the agent reports it and proposes options, and does not start any quota-consuming task

### Requirement: Installation
The command line SHALL install the skill into skill-directory clients and SHALL write a managed, delimited block into the global instruction file of instruction-file clients, SHALL be safe to run repeatedly, SHALL support a dry run and an uninstall, and SHALL never modify text outside its own block.

#### Scenario: Install twice
- **WHEN** the install command is run twice
- **THEN** the second run reports that everything is up to date and changes nothing

#### Scenario: Uninstall
- **WHEN** the uninstall command is run
- **THEN** only the files and blocks Tokengator installed are removed
