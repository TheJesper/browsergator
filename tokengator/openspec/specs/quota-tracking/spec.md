# quota-tracking Specification

## Purpose
Describes how a person's AI subscriptions are represented: accounts, the meters inside them, the rules by which each meter's window resets, and how new readings and the passage of time change them.

## Requirements

### Requirement: Accounts hold meters
The system SHALL represent each subscription as an account with a provider, a label, an optional plan name, an optional price (amount, currency, month or year) and one or more meters. Each meter SHALL have a label, a role (`allowance` or `throttle`), a unit, a limit, an amount used and a reset rule.

#### Scenario: Create a custom account
- **WHEN** a user creates an account "Suno Pro" with a meter "Monthly credits" of 2,500 credits that resets monthly on day 12
- **THEN** the account is stored with that meter at 0 used and a reset time on the next 12th

#### Scenario: Reject an account without meters
- **WHEN** a client submits an account with no meters
- **THEN** the request is rejected with a message naming the missing meters and nothing is stored

### Requirement: Bounds on what is accepted
The system SHALL accept amounts, limits, prices and spend only as finite numbers from 0 to 1e12 (a limit from 1e-6), SHALL accept a window length only from one minute to 366 days, SHALL accept a date and time only in ISO 8601 form between the years 1990 and 2200, and SHALL remove control characters from names and labels (line breaks are kept in notes only). An input outside these bounds SHALL be refused with an error naming the field.

#### Scenario: Window of no length
- **WHEN** a meter is created with a reset interval of 1e-320 hours
- **THEN** it is refused with an error naming `reset.hours`

#### Scenario: A number that is not a date
- **WHEN** a meter's reset time is set to the text `1`
- **THEN** it is refused with an error naming `resetsAt`

#### Scenario: Escape sequences in a name
- **WHEN** an account is named with terminal escape sequences, a carriage return and a NUL
- **THEN** the stored name contains none of them

#### Scenario: A reset time that has passed
- **WHEN** a meter is created or edited with a reset time earlier than now and its rule is not a one-off expiry
- **THEN** it is refused with an error naming `resetsAt`, and no finished window is recorded

#### Scenario: A stored rule that cannot be stepped
- **WHEN** a state file already holds a meter with a window of no length and its reset time passes
- **THEN** the meter goes back to waiting for a reset time and every other read still works

### Requirement: Limits on part of a plan
The system SHALL let a throttle meter be marked as covering only part of a plan, such as one model family inside a weekly allowance. Such a meter SHALL be shown with its own usage and reset, SHALL never be counted as waste, and SHALL NOT mark the rest of the account as blocked when it is reached.

#### Scenario: A model-family cap is reached
- **WHEN** an account's "Weekly, Fable models" partial limit reaches 100% while its weekly allowance has 40% left
- **THEN** the partial limit is shown as blocked and the weekly allowance is not

#### Scenario: A session cap is reached
- **WHEN** an account's ordinary session throttle reaches 100%
- **THEN** the account's allowances are marked as blocked until it reopens

### Requirement: Units cover percentage-only providers
The system SHALL accept meters whose provider exposes only a utilisation percentage by using the `percent` unit with a limit of 100, and SHALL otherwise accept a numeric limit in requests, credits, tokens, characters, minutes, hours, images, US dollars or a generic count with a custom noun.

#### Scenario: Percentage-only meter
- **WHEN** a meter is created with unit `percent`
- **THEN** its limit is 100 and readings of "62% used" store 62

#### Scenario: A limit without a unit
- **WHEN** a meter is created with a limit of 500 and 150 used and no unit
- **THEN** it is refused with an error naming the unit, instead of being stored as a percentage meter at 150%

#### Scenario: Custom noun
- **WHEN** a meter is created with unit `count` and the noun "songs"
- **THEN** amounts are shown as "songs" everywhere the unit is displayed

### Requirement: Reset rules
The system SHALL support these reset rules: `rolling` (starts on first use, lasts a number of hours, then idle), `interval` (a new window every N hours after the previous one ends), `daily` (a wall-clock time in an IANA time zone), `monthly` (a day of the month and time in an IANA time zone), `once` (a single expiry with no renewal) and `none` (no clock).

#### Scenario: Monthly day beyond the month's length
- **WHEN** a meter resets monthly on day 31 and the current month has 30 days
- **THEN** the window ends on day 30 of that month at the configured time

#### Scenario: Daily reset across a daylight-saving change
- **WHEN** a meter resets daily at 00:00 in America/Los_Angeles and the zone's clocks change during the window
- **THEN** the next reset is still at 00:00 Los Angeles wall-clock time

#### Scenario: Rolling window is idle until used
- **WHEN** a rolling 5-hour meter has no active window
- **THEN** it has no reset time and is reported as idle rather than as wasting quota

#### Scenario: Unknown time zone
- **WHEN** a reset rule names a time zone the runtime does not recognise
- **THEN** the request is rejected with a message naming the zone

### Requirement: Readings update a meter
The system SHALL accept a reading for a meter as an amount used, an amount remaining, a percentage used or a percentage remaining, optionally with a new limit, a reset time or a window start. It SHALL convert the reading to the meter's unit, store the time of the reading, and keep the readings of the current window as samples.

#### Scenario: Remaining amount
- **WHEN** a meter with limit 2,500 receives a reading of 1,200 remaining
- **THEN** its amount used becomes 1,300

#### Scenario: Percentage on a counted meter
- **WHEN** a meter with limit 300 requests receives a reading of 40% used
- **THEN** its amount used becomes 120

#### Scenario: Usage beyond the limit
- **WHEN** a reading reports more used than the limit
- **THEN** the amount is stored as reported and the meter is treated as fully used

#### Scenario: Invalid reading
- **WHEN** a reading contains a negative amount, a percentage outside 0 to 100, more than one amount, or an unparseable reset time
- **THEN** it is rejected with a message naming the offending field and the meter is unchanged

### Requirement: Readings can move the window
The system SHALL treat a reading whose reset time is later than the meter's current reset time by at least half a window as the start of a new window only when the reading also reports less usage than is stored. It SHALL then close the previous window, ending it where the new one began and never later than the previous reset or the moment of the reading.

#### Scenario: Provider reports a later reset and less usage
- **WHEN** a weekly meter at 55% that resets on the 20th receives, on the 19th, a reading of 4% with a reset time on the 27th
- **THEN** the previous window is closed with 55% used, ending at the moment of the reading, and the meter continues at 4% in the window ending on the 27th

#### Scenario: Small correction to the reset time
- **WHEN** a reading's reset time differs from the stored one by less than half a window
- **THEN** the stored reset time is corrected and the window's samples are kept

### Requirement: A later date alone is a corrected date
The system SHALL take a later reset time that comes on its own, or with the same usage or more, as a correction of the date: usage is kept and no finished window is recorded.

#### Scenario: Only the date is corrected
- **WHEN** a hand-kept weekly meter at 62% receives a reading that says only that it resets four days later than stored
- **THEN** the meter keeps 62%, its reset time moves, and no finished window is recorded

#### Scenario: Later date and more usage
- **WHEN** the same meter receives a reading of 70% with a reset time four days later than stored
- **THEN** the meter holds 70% in the same window and no finished window is recorded

### Requirement: Rolling windows start on first use
A reading on an idle rolling meter SHALL start a window ending at the reading's reset time. When no reset time is given, a window of 24 hours or less SHALL start at the reading and end one window length later, and a longer window SHALL stay without a reset time until one is reported, shown as "reset time unknown".

#### Scenario: First use of a rolling window
- **WHEN** an idle rolling 5-hour meter receives a reading of 10% used with no reset time
- **THEN** a window starts at the time of the reading and ends 5 hours later

#### Scenario: A weekly window from first use, read without a reset
- **WHEN** an idle rolling 7-day meter receives a reading of 62% used with no reset time
- **THEN** the usage is stored, no reset time is invented, the meter reads "Reset time unknown: 38% left", and no finished window is ever recorded from that reading alone

### Requirement: One-off expiries and balances
The system SHALL treat a new expiry on a one-off meter as an extension or a shortening and SHALL NOT close a window for it. A balance without a clock that is given an expiry SHALL become a one-off expiry from then on. A balance SHALL NOT record a finished window.

#### Scenario: A pack is topped up
- **WHEN** a prepaid pack that expires in a month receives a reading with an expiry a year away
- **THEN** its expiry moves, the day tracking began stays, and nothing is recorded

#### Scenario: A balance is given an expiry
- **WHEN** a balance meter receives a reading with an expiry in three days
- **THEN** it is forecast and reminded about like any expiring quota, and one finished window is recorded when it expires

### Requirement: A finished window is taken back when it had not finished
The system SHALL, when a meter was rolled forward automatically and a later reading shows that its real reset is earlier than the one it was rolled to by at least half a window, remove the finished window that the roll recorded, and SHALL restore the usage that window held when the reading carries no amount of its own.

#### Scenario: Reset time typed a day early
- **WHEN** a weekly meter set to reset on Wednesday is rolled forward at that time with 62% used, and an hour later a reading says 70% used, resetting Thursday
- **THEN** the ledger holds no finished window, the meter is at 70% in the window ending Thursday, and exactly one window is recorded when Thursday comes

### Requirement: Editing keeps what a reading would keep
The system SHALL, when a meter's reset time is edited without its rule being edited in the same change, adopt the schedule from that time as a reading does, and SHALL, when a percentage meter is given a counted unit and a limit, carry the share that was used over to the new limit.

#### Scenario: Billing day supplied by editing
- **WHEN** a billing-cycle meter that was added without a billing day has its reset time edited to the 12th of next month
- **THEN** its rule becomes monthly on that day and later windows end on that day

#### Scenario: Percent to credits
- **WHEN** a percentage meter at 62% is changed to credits with a limit of 2,500
- **THEN** it holds 1,550 used

### Requirement: Windows roll over automatically
The system SHALL advance a meter whose reset time has passed without waiting for a reading. Interval, daily and monthly meters SHALL enter the next window with nothing used and be marked estimated until a new reading arrives. Rolling meters SHALL become idle. `once` meters SHALL be marked expired.

#### Scenario: Weekly meter passes its reset
- **WHEN** the reset time of an interval meter passes
- **THEN** the meter shows 0 used, a reset time one interval later, and an estimated marker

#### Scenario: Several windows pass while nothing is running
- **WHEN** three windows of a daily meter pass before the system is started again
- **THEN** the meter is placed in the current window and only the first of the passed windows is eligible to be recorded as a finished cycle

#### Scenario: Prepaid credits expire
- **WHEN** the expiry of a `once` meter passes
- **THEN** the meter is marked expired and is no longer advanced

### Requirement: Provider catalog
The system SHALL ship a catalog of provider presets with their common plans, each plan listing its meters with units, limits, roles and reset rules, a usage-page address and a short note on where to read the numbers. The catalog SHALL cover at least Claude, ChatGPT/Codex, GitHub Copilot, Google Gemini, ElevenLabs and Suno, and SHALL allow fully custom accounts.

#### Scenario: Add from a preset
- **WHEN** a user adds the catalog's GitHub Copilot Pro plan
- **THEN** an account is created with a monthly allowance meter (AI credits) that resets on the first day of each month at 00:00 UTC and the plan's list price

#### Scenario: A provider with no confirmed usage page
- **WHEN** the catalog knows only a provider's pricing page
- **THEN** the page is shown as a plan page, never as a usage page, and an account made from the preset has no usage link

#### Scenario: Presets are a starting point
- **WHEN** a user edits the limit, price or reset rule of an account created from a preset
- **THEN** the edited values are stored and the catalog is unchanged

#### Scenario: Reset anchor still needed
- **WHEN** a preset's reset depends on the user's own billing date and no billing day is given
- **THEN** the created meter is flagged as needing its reset time until the user or a reading provides it

#### Scenario: Billing day supplied
- **WHEN** a plan with a billing-cycle meter is added with billing day 12
- **THEN** that meter resets monthly on the 12th in the user's time zone

### Requirement: Documented ways to use quota
A provider preset MAY list ways the provider itself documents for putting plan quota to work unattended. Each entry SHALL have a title, one sentence saying what it is and whether it draws on the same allowance, and an HTTPS link to the provider's own documentation. The catalog SHALL NOT list anything whose purpose is to keep a rate window open or to consume quota for its own sake.

#### Scenario: Claude
- **WHEN** the catalog entry for Claude is read
- **THEN** it lists cloud sessions with a link to the provider's documentation

#### Scenario: A provider without documented ways
- **WHEN** a provider has none
- **THEN** its entry lists none and nothing is shown for it

### Requirement: Snooze
The system SHALL let a user snooze an account until a chosen time. A snoozed account SHALL remain visible but SHALL be excluded from the use-first ordering, from alerts and from the totals of value at risk until the time passes.

#### Scenario: Snoozed while travelling
- **WHEN** an account is snoozed for 3 days
- **THEN** it does not appear in the "use now" group or trigger a notification during those days, and returns automatically afterwards

### Requirement: Export and import
The system SHALL export the complete state as one JSON document and SHALL import such a document after validating it, replacing the current state only when validation succeeds.

#### Scenario: Round trip
- **WHEN** a user exports the state and imports the same document into an empty installation
- **THEN** the accounts, meters, finished cycles and spend sources are identical

#### Scenario: Invalid document
- **WHEN** an imported document fails validation
- **THEN** the current state is kept and the response names the first invalid field

#### Scenario: A backup a shell re-encoded
- **WHEN** an exported document was saved as UTF-16 or with a byte-order mark, as Windows PowerShell does on redirection
- **THEN** importing it from the command line restores the same state
