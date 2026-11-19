## ADDED Requirements

### Requirement: Weekly totals
The system SHALL report, for a requested number of weeks starting Monday in the viewer's time zone, the number of finished windows, the plan money and dollar credits that expired, the part of that money that is estimated, and the share used over the 30 days ending with that week. A week in which no window closed SHALL be reported as having no record, not as zero.

#### Scenario: An empty week
- **WHEN** windows closed in weeks one and three of a three-week span and none in week two
- **THEN** week two reports zero windows and no money, and its share used is that of the 30 days ending with it

### Requirement: Totals per subscription
The system SHALL total finished windows per subscription over a period, keeping plan money and dollar credits apart, under the names recorded on the latest window, ordered by the plan money that expired in the preferred currency, then in other currencies, then by credits, then by the lower share used.

#### Scenario: A deleted subscription
- **WHEN** a subscription with finished windows is deleted
- **THEN** its total still appears under the name it had

## MODIFIED Requirements

### Requirement: Confidence of a record
The system SHALL mark a finished cycle `measured` when the last reading of the window was fresh at the moment it closed, and `estimated` otherwise, and SHALL show estimated figures as approximate wherever they appear, a money total that includes estimated cycles as a whole amount after "about".

#### Scenario: Reading shortly before the reset
- **WHEN** a weekly meter is read one hour before it resets
- **THEN** the finished cycle is `measured`

#### Scenario: Reading days before the reset
- **WHEN** a weekly meter was last read four days before it resets
- **THEN** the finished cycle is `estimated`

#### Scenario: One figure everywhere
- **WHEN** the money expired in the last 30 days includes estimated windows and amounts to 39.02 USD
- **THEN** the dashboard, the brief, the command line status and the MCP waste report all state "about $39"
