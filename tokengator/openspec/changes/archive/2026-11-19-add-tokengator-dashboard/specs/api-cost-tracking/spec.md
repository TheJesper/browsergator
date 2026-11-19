# Spec Delta

## Purpose

Optional tracking of pay-as-you-go API spend next to the subscriptions, so the same screen shows both what is being wasted and what is being spent.

## ADDED Requirements

### Requirement: Spend sources
The system SHALL let a user add spend sources, each with a provider, a label, a currency and an optional monthly budget, and SHALL work normally when there are none.

#### Scenario: Add a source with a budget
- **WHEN** a user adds "OpenAI API" in USD with a monthly budget of 50
- **THEN** the source appears in the Costs view with 0 spent of 50

#### Scenario: No sources
- **WHEN** no spend source exists
- **THEN** the Costs view explains that cost tracking is optional and how to add a source, and no other view is affected

### Requirement: Daily entries
The system SHALL store spend as one total per calendar day per source, SHALL let an entry set or add to a day's total, and SHALL keep at most the most recent 400 days per source.

#### Scenario: Set a day's total
- **WHEN** an entry sets 2026-11-18 to 3.40 on a source that already has 2.10 for that day
- **THEN** the day's total is 3.40

#### Scenario: Add to a day
- **WHEN** an entry adds 1.25 to a day whose total is 2.10
- **THEN** the day's total is 3.35

### Requirement: Month-to-date and projection
The system SHALL report for each source the spend of the current calendar month, the daily average over the days elapsed, a straight-line projection to the end of the month and, when a budget is set, the share of the budget used and whether the projection exceeds it.

#### Scenario: Projection over budget
- **WHEN** a source with a budget of 50 has spent 30 after 10 days of a 30-day month
- **THEN** the projection is 90 and the source is flagged as heading over budget

### Requirement: Costs are not waste
The system SHALL keep API spend out of every waste figure: spend SHALL never contribute to value at risk, urgency tiers or the waste ledger.

#### Scenario: High spend, no waste
- **WHEN** a spend source is over budget and no allowance meter is behind pace
- **THEN** the summary reports nothing at risk
