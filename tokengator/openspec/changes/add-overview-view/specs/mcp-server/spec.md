## MODIFIED Requirements

### Requirement: Reading tools
The MCP server SHALL provide tools to list accounts with their meters and forecasts, to get one account in full including samples and recent cycles, to list the provider catalog with usage-page addresses and reading notes, to report the waste ledger totals and, when asked, the same totals week by week, and to report API costs.

#### Scenario: Catalog tells an agent where to look
- **WHEN** an agent calls `list_catalog` for a provider
- **THEN** the result includes the address of the provider's usage page and which figures to read from it

#### Scenario: A provider filled by a status line
- **WHEN** an agent asks the catalog about a provider whose own tool pushes readings through a status line
- **THEN** the result says so and lists only collector ids that the refresh tool accepts

#### Scenario: Waste week by week
- **WHEN** an agent calls `waste_report` with `byWeek` set
- **THEN** the structured result holds one entry per week with the windows closed, the money expired and the share used over the trailing 30 days, the figures the Overview's weekly panels show
