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
- **THEN** the structured result holds one entry per week with the windows closed, the plan money and dollar credits expired each with its estimated part, and the share used over the trailing 30 days, the figures the Overview's weekly panels show

#### Scenario: The weeks cover the period
- **WHEN** an agent calls `waste_report` on a Thursday for the last 7 days with `byWeek` set
- **THEN** the weeks run from the Monday of the week before to the current week, so every window the totals count falls in one of them

#### Scenario: A period longer than half a year
- **WHEN** an agent calls `waste_report` for the last 365 days with `byWeek` set
- **THEN** the result holds the latest 26 weeks, and the documentation says the weeks stop at 26

#### Scenario: Estimates are flagged per total
- **WHEN** the dollar credits that expired come from a window nobody read near its end and the plan money from measured windows
- **THEN** the waste report marks the credits as estimated and the plan money as exact, and its text gives the credits as "about" a whole amount

#### Scenario: Nothing priced
- **WHEN** windows closed partly unused in the period and none of them has a price
- **THEN** the waste report text says that no money is counted rather than giving an amount of zero
