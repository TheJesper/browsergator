# reminders Specification

## Purpose
Reaches the person when quota is about to expire and nobody is looking at the dashboard: one reminder per quota per window, on this computer, at an address of their own, or as entries in their calendar, without ever sending more than the reminder itself.

## Requirements

### Requirement: One reminder per quota per window
The system SHALL consider a reminder due for an allowance meter when the meter is `use-now`, its account is not snoozed, its window is at least two days long, and no reminder has been raised for that meter's current window. A window SHALL be identified by the meter and its reset time, and reset times within thirty minutes of each other SHALL count as the same window. A meter that is blocked by an account-wide limit until its own reset or later SHALL NOT be due.

#### Scenario: Weekly quota enters the action horizon
- **WHEN** a weekly allowance has 38% left and resets in 14 hours
- **THEN** one reminder is due that names the account, the share left, the time to the reset and the reset moment

#### Scenario: Already raised
- **WHEN** a reminder was raised for a meter's current window and the meter is still `use-now` an hour later
- **THEN** no reminder is due for that meter

#### Scenario: Reset time reported slightly differently
- **WHEN** a reminder was raised for a window and a later reading reports the same window's reset four minutes later
- **THEN** no reminder is due for that meter

#### Scenario: Session and daily limits
- **WHEN** a five-hour or a daily meter is `use-now`
- **THEN** no reminder is due

#### Scenario: Snoozed account
- **WHEN** the account of a `use-now` meter is snoozed
- **THEN** no reminder is due

#### Scenario: Blocked past the reset
- **WHEN** a `use-now` meter's account is blocked by a session limit that reopens after the meter resets
- **THEN** no reminder is due

### Requirement: Reminder wording
A reminder SHALL state the money that is expected to expire when the account has a price, SHALL state when a closed account-wide limit reopens when one is closed, and SHALL say that the reading is old when the meter is stale. When several reminders are due at once the system SHALL deliver one message that lists at most three of them and counts the rest.

#### Scenario: Priced account
- **WHEN** a reminder is due for a meter with a value at risk of 7.39 USD
- **THEN** the reminder says that about $7.39 expires at this pace

#### Scenario: Stale reading
- **WHEN** a reminder is due for a meter whose reading is stale
- **THEN** the reminder says the reading is old and to check the real number first

#### Scenario: Five quotas due together
- **WHEN** five reminders are due at the same check
- **THEN** one message is delivered, titled with the count, listing three quotas and "And 2 more."

### Requirement: Desktop reminders
The local service SHALL, only when the `desktopReminders` setting is on and the service is not serving sample data, check for due reminders about once a minute and raise them as a notification on the computer it runs on, using the operating system's own notification command. Reminder text SHALL reach that command as an argument or an environment variable and SHALL NOT be interpolated into a shell command line or a script. The setting SHALL default to off.

#### Scenario: Setting off
- **WHEN** `desktopReminders` is off and no webhook is configured
- **THEN** no command is run and the reminder stays due

#### Scenario: Setting on
- **WHEN** `desktopReminders` is on and a reminder is due
- **THEN** one notification is raised and the reminder is not raised again for that window

#### Scenario: Hostile account name
- **WHEN** an account is named with quotes, backticks and `$(…)`
- **THEN** the notification command receives the name as data and the script it runs is unchanged

#### Scenario: Sample data
- **WHEN** the service is serving sample data
- **THEN** no reminder is delivered through any channel

#### Scenario: Sample data in the browser
- **WHEN** the dashboard shows sample data, the browser-tab route is switched on and notification permission is granted
- **THEN** no browser notification is raised

#### Scenario: Several due in the browser tab
- **WHEN** three quotas become due at the same check while only the browser-tab route is on
- **THEN** one browser notification is raised, titled with the count

#### Scenario: No notification command
- **WHEN** the platform has no standard notification command or the command is missing
- **THEN** the delivery is reported as failed with a reason and the service keeps running

### Requirement: Reminders to an address of the user's own
The system SHALL, when `TOKENGATOR_NOTIFY_URL` is set in the environment or in the environment file, post each due message to that address. Messages SHALL be plain text with the title in a `Title` header, except for Slack and Discord webhook addresses, which SHALL receive those services' JSON shape. Redirects SHALL NOT be followed.

#### Scenario: ntfy topic
- **WHEN** the address is an HTTPS ntfy topic and a reminder is due
- **THEN** one POST is made with the reminder body as text and its title in the `Title` header

#### Scenario: Slack webhook
- **WHEN** the address is a Slack incoming webhook
- **THEN** the message is posted as JSON with a `text` field

#### Scenario: Title that cannot be a header
- **WHEN** a reminder title contains characters outside printable ASCII
- **THEN** the title is sent as the first line of the body and no `Title` header is set

### Requirement: The reminder address is a credential
The reminder address SHALL use HTTPS unless its host is the local computer and SHALL NOT carry a user name or password. It SHALL NOT be stored in state, logged, or returned by any interface, and errors SHALL name its host only.

#### Scenario: Plain HTTP to another host
- **WHEN** the address is `http://` on a host other than the local computer
- **THEN** nothing is posted and the status reports the address as unusable without repeating it

#### Scenario: The address is never shown
- **WHEN** a delivery fails or the reminder status is read
- **THEN** the output contains the host of the address and not its path

### Requirement: A delivered reminder is not repeated for a record that could not be written
The service SHALL remember within the running process which reminders it has delivered, and SHALL treat a failure to write the reminder record as a warning.

#### Scenario: The record file is locked
- **WHEN** a reminder is delivered and the record file cannot be replaced
- **THEN** the check succeeds, a warning is logged, and the same reminder is not raised again by that process

### Requirement: A reminder counts once any channel took it
The system SHALL record a reminder as raised when at least one channel delivered it, and SHALL keep it due when none did. The record SHALL be a file in the Tokengator home directory that holds reminder keys only, SHALL forget windows that have ended, and SHALL be bounded. A missing or unreadable record SHALL be treated as empty.

#### Scenario: One channel fails
- **WHEN** the desktop command fails and the webhook succeeds
- **THEN** the reminder is recorded as raised

#### Scenario: Every channel fails
- **WHEN** every enabled channel fails
- **THEN** the reminder stays due and the service waits before trying again

#### Scenario: Restart
- **WHEN** the service restarts after raising a reminder
- **THEN** the reminder is not raised again for that window

### Requirement: Reminder status and test
The HTTP API SHALL report whether desktop reminders are on and supported on this system, and whether a webhook is configured, and SHALL offer a request that sends a fixed test message through the desktop channel and every configured channel and returns the outcome of each. The test request SHALL be refused while the service is serving sample data.

#### Scenario: Reading the status
- **WHEN** the status is read with desktop reminders on and a webhook configured
- **THEN** it reports both as on and names the webhook's host

#### Scenario: Sending a test
- **WHEN** a test is requested
- **THEN** the fixed test message is delivered and each channel's outcome is returned with a reason for any failure

#### Scenario: The notification command fails
- **WHEN** the system's notification command exits with an error
- **THEN** the reason given is the first line the command wrote, as one short plain line

#### Scenario: Started from another shell on Windows
- **WHEN** the service was started from PowerShell 7 and raises a Windows notification
- **THEN** the notification script uses no module command and does not inherit that shell's module path

### Requirement: One-shot reminders from the command line
The command line SHALL offer a command that checks once for due reminders, delivers them through the desktop channel and any configured webhook, records them, and exits, so that a scheduler can run it without the service. It SHALL offer a dry run that prints what is due and delivers and records nothing.

#### Scenario: Scheduled run
- **WHEN** `tokengator notify` runs with one reminder due
- **THEN** the reminder is delivered and a second run delivers nothing

#### Scenario: Dry run
- **WHEN** `tokengator notify --dry-run` runs with one reminder due
- **THEN** the reminder is printed, nothing is delivered and a later run still finds it due

### Requirement: Calendar of resets
The system SHALL provide the upcoming resets of every expiring allowance as an iCalendar document, over the HTTP API as `text/calendar` and from the command line. Each entry SHALL end at the reset, SHALL begin at the start of that window's action horizon (or now, when that has passed), SHALL carry a display alarm at its beginning, and SHALL name the account and the meter without stating how much is left.

#### Scenario: Weekly quota
- **WHEN** a weekly allowance resets in 14 hours and the feed covers 30 days
- **THEN** the calendar lists that reset and the four that follow it, one week apart

#### Scenario: Monthly quota
- **WHEN** an allowance resets on the first of each month
- **THEN** the calendar lists the first of each coming month inside the range

#### Scenario: Long and unusual names
- **WHEN** an account name contains commas, semicolons and non-ASCII letters
- **THEN** the text is escaped and no line of the document exceeds 75 octets

#### Scenario: Protected by the token
- **WHEN** an access token is configured and the calendar is requested without it
- **THEN** the request is refused

### Requirement: What the calendar leaves out
The calendar SHALL leave out meters whose quota carries over, meters without a reset, windows shorter than two days and snoozed accounts. Recurring windows SHALL be listed up to a bounded number of days ahead, and a window that opens on first use SHALL be listed once.

#### Scenario: Nothing that expires
- **WHEN** only session limits, carried-over quota and balances are tracked
- **THEN** the calendar is valid and has no entries

#### Scenario: First-use window
- **WHEN** a weekly window that opens on first use is running
- **THEN** the calendar lists its end once and no later ones
