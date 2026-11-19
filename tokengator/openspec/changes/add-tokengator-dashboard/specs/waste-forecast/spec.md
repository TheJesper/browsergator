# Spec Delta

## Purpose

Turns raw meter readings into the answer the product exists for: how much of each quota will expire unused, what that is worth, how urgent it is, and which quota to use first.

## ADDED Requirements

### Requirement: Projected unused share
The system SHALL project, for every allowance meter with an active window, the share of the limit that will be used by the reset if the pace of the current window continues, and SHALL report the remainder as the projected unused share. Early in a window the projection SHALL lean towards full use so that a few minutes of data cannot predict a large loss.

#### Scenario: Behind pace halfway through
- **WHEN** half of a window has elapsed and 20% of the limit has been used
- **THEN** the projected unused share is between 55% and 60%

#### Scenario: Window just started
- **WHEN** 1% of a window has elapsed and nothing has been used
- **THEN** the projected unused share is below 20%

#### Scenario: Ahead of pace
- **WHEN** half of a window has elapsed and 80% of the limit has been used
- **THEN** the projected unused share is 0

#### Scenario: Quota that carries over
- **WHEN** a meter is marked as carrying unused quota into the next window
- **THEN** its projected unused share is 0 and it never contributes to value at risk

### Requirement: Value at risk
The system SHALL express the projected unused share of an allowance meter as money when its account has a price: the price per month, scaled by the window's length relative to a month and by the meter's value share, multiplied by the projected unused share. Amounts SHALL be kept in the account's currency and totals SHALL be reported per currency without conversion.

#### Scenario: Weekly window on a monthly price
- **WHEN** an account costs 100 USD per month and its weekly meter with value share 1 projects 40% unused
- **THEN** the value at risk is 9.20 USD, within one cent

#### Scenario: No price
- **WHEN** an account has no price
- **THEN** value at risk is absent for its meters and they are omitted from money totals

#### Scenario: Mixed currencies
- **WHEN** one account is priced in USD and another in SEK
- **THEN** totals are reported separately for USD and SEK

### Requirement: Urgency tiers
The system SHALL assign every allowance meter exactly one tier: `use-now` (at least 10% left, the reset within the action horizon and a projected unused share of at least 5%), `behind` (projected unused share of at least 15%), `hot` (pace would exhaust the limit well before the reset), `on-pace`, `spent` (at least 98% used), `fresh` (less than 5% of the window elapsed), `idle` (no active window or reset time unknown), `balance` (no clock) or `expired`.

#### Scenario: Weekly meter on its last day
- **WHEN** a weekly meter has 38% left and resets in 14 hours
- **THEN** its tier is `use-now`

#### Scenario: Last day but on pace
- **WHEN** a weekly meter has 12% left, resets in 20 hours and has been used evenly all week
- **THEN** its tier is `on-pace`, not `use-now`

#### Scenario: Monthly meter mid-cycle and behind
- **WHEN** a monthly meter is 50% through its window with 20% used
- **THEN** its tier is `behind`

#### Scenario: A window that just opened
- **WHEN** 2% of a window has elapsed
- **THEN** its tier is `fresh`, no forecast is shown for it and it reports no value at risk

#### Scenario: Fully used is a success state
- **WHEN** a meter is 99% used with two days to its reset
- **THEN** its tier is `spent` and it reports no value at risk

#### Scenario: Burning too fast
- **WHEN** 30% of a window has elapsed and 75% of the limit has been used
- **THEN** its tier is `hot` and the system reports the time at which the limit is expected to run out

### Requirement: Action horizon scales with the window
The system SHALL use an action horizon of 15% of the window's length, never less than 2 hours and never more than 72 hours, when deciding whether a meter is `use-now`.

#### Scenario: Weekly window
- **WHEN** a meter has a 7-day window
- **THEN** its action horizon is about 25 hours

#### Scenario: Monthly window
- **WHEN** a meter has a 30-day window
- **THEN** its action horizon is 72 hours

### Requirement: Required pace
The system SHALL report, for allowance meters that are `use-now` or `behind`, how many times faster than the pace of the current window the remaining quota would have to be used to finish it before the reset.

#### Scenario: Catching up
- **WHEN** 60% of a window has elapsed and 30% has been used
- **THEN** the required pace is reported as 3.5 times the current pace

#### Scenario: Nothing used yet
- **WHEN** nothing has been used in the window
- **THEN** no multiple is reported and the remaining amount per day is reported instead

### Requirement: Throttle state
The system SHALL report throttle meters as `open`, `blocked` (at least 98% used, with the time they reopen) or `idle`, SHALL never count them as waste, and SHALL attach a blocked throttle to the allowance meters of the same account so that "use now" guidance says when using becomes possible.

#### Scenario: Session cap reached
- **WHEN** an account's 5-hour session meter is 100% used and reopens in 70 minutes while its weekly meter is `use-now`
- **THEN** the weekly meter's guidance states that the account is blocked for 70 minutes

### Requirement: Staleness
The system SHALL mark a meter stale when its last reading is older than 20% of its window length, bounded between 30 minutes and 48 hours, or when it has never had a reading, and SHALL carry that marker into every summary of the meter.

#### Scenario: Old weekly reading
- **WHEN** a weekly meter was last read 3 days ago
- **THEN** it is marked stale and its summary says when it was last updated

### Requirement: Orderings
The system SHALL order allowance meters by "use first" by default: tier in the order use-now, behind, hot, on-pace, fresh, idle, balance, spent, expired, then by time to reset ascending, then by value at risk descending. It SHALL also offer orderings by soonest reset, most left, most value at risk, name and least recently updated.

#### Scenario: Two meters that need using
- **WHEN** one `use-now` meter resets in 3 hours and another in 20 hours
- **THEN** the one resetting in 3 hours is first

#### Scenario: Snoozed and stale items
- **WHEN** an account is snoozed
- **THEN** its meters are placed after all non-snoozed meters in the "use first" ordering

### Requirement: One wording everywhere
The system SHALL produce the headline and explanation of a meter's state from the same rules in the dashboard, the command line and the MCP server, so that a person and an agent read the same sentence about the same meter.

#### Scenario: Same sentence in two places
- **WHEN** the dashboard shows "Use now: 38% left, resets in 14h" for a meter
- **THEN** the MCP `what_to_use` tool and the CLI status output use the same headline for that meter at the same moment
