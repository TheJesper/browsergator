# waste-ledger Specification

## Purpose
Keeps the record of what actually expired unused in each finished window, so that the cost of wasted quota is visible over time and improvement can be seen.

## Requirements

### Requirement: Finished windows are recorded
The system SHALL record a finished cycle whenever an allowance meter's window closes, holding the account, the meter, the window's start and end, the limit, the amount used, the unused share and, when the account has a price, the money that share represents.

#### Scenario: Window closes with quota left
- **WHEN** a weekly meter on a 100 USD per month plan closes with 70% used
- **THEN** a finished cycle is recorded with a 30% unused share worth 6.90 USD, within one cent

#### Scenario: Throttle windows are not recorded
- **WHEN** a throttle meter's window closes
- **THEN** no finished cycle is recorded

#### Scenario: Hand-kept meter with no reading in the window
- **WHEN** a window closes on a manually updated meter that received no reading during that window
- **THEN** no finished cycle is recorded, because the absence of typing says nothing about use

#### Scenario: Automatic source with no reading in the window
- **WHEN** a window closes on a meter fed by a collector or the status line and no reading arrived during that window
- **THEN** a finished cycle is recorded as fully unused and marked `estimated`

#### Scenario: Never-read meters are not recorded
- **WHEN** a window closes on a meter that never received a reading
- **THEN** no finished cycle is recorded

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

### Requirement: Totals
The system SHALL report, per currency, the money value of unused quota over the trailing 30 days, the average utilisation over the same period, and for each meter its recent cycles in order.

#### Scenario: Trailing total
- **WHEN** three cycles worth 4, 6 and 10 USD of unused quota closed in the last 30 days and one worth 20 USD closed 45 days ago
- **THEN** the trailing 30-day total is 20 USD

### Requirement: Bounded history
The system SHALL keep at most the 2,000 most recent finished cycles and SHALL keep a meter's cycles when the meter or its account is later renamed or deleted.

#### Scenario: Account deleted
- **WHEN** an account with recorded cycles is deleted
- **THEN** its cycles remain in the history under the names they had

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
