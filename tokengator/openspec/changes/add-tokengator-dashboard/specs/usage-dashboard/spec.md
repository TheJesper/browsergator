# Spec Delta

## Purpose

The web interface a person keeps open to see, at a glance, which quota to go and use before it resets, and to keep the numbers current with as little effort as possible.

## ADDED Requirements

### Requirement: The first screen answers "what do I use now"
The dashboard SHALL open on a ranked queue of allowance meters grouped by urgency tier in "use first" order, with the most urgent meter first, and SHALL show above it a summary of how many meters need using now, the money at risk, the next reset and the money lost over the trailing 30 days.

#### Scenario: Something is about to expire
- **WHEN** a meter is in the `use-now` tier
- **THEN** it is the first row of the queue under a "Use now" heading and the summary counts it and its value at risk

#### Scenario: Nothing needs attention
- **WHEN** no meter is `use-now` or `behind`
- **THEN** the summary says so in words and the queue starts with the on-pace group

### Requirement: Forecast bar
The dashboard SHALL draw each allowance meter as one bar divided into the share used, the share projected to be used by the reset and the share projected to expire, with a marker at the elapsed share of the window, and SHALL state the same three figures as text next to the bar.

#### Scenario: Behind pace
- **WHEN** a meter has 42% used, is projected to reach 71% and is 60% through its window
- **THEN** the bar shows a 42% used segment, a 29% projected segment, a 29% expiring segment and a marker at 60%, and the text reads the same numbers

#### Scenario: Estimated or stale data
- **WHEN** a meter is estimated or stale
- **THEN** its bar is visibly marked as uncertain and the text says when it was last updated

### Requirement: View modes
The dashboard SHALL offer six views of the same data: Queue, Board (one card per account with all its meters), Timeline (meters placed at their reset time on a time axis), Table (one sortable row per meter), Costs and History. The selected view SHALL be restored on the next visit and SHALL be addressable in the page address.

#### Scenario: Switching view
- **WHEN** the user selects Timeline
- **THEN** the same meters are shown on a time axis and the page address identifies the Timeline view

#### Scenario: Returning later
- **WHEN** the user reopens the dashboard without a view in the address
- **THEN** the view they last used is shown

### Requirement: Timeline horizon
The Timeline view SHALL let the user choose a horizon of 24 hours, 7 days or 30 days, SHALL place each allowance meter's reset on that axis with the share and value that would expire at that moment, and SHALL list meters whose reset lies beyond the horizon separately.

#### Scenario: Cluster of resets
- **WHEN** three meters reset within the same morning on a 7-day horizon
- **THEN** all three appear at that position, each on its own row with its expiring share

### Requirement: Inspector
The dashboard SHALL show, for a selected meter, its usage over the current window against an even-pace line with the projection to the reset, the numbers behind the forecast, the meter's recent finished cycles, the other meters of the same account, and the actions to update, edit, snooze, copy and open the provider's usage page.

#### Scenario: Open a meter
- **WHEN** the user selects a row in the queue
- **THEN** the inspector shows that meter's chart, figures, history and actions without leaving the view

### Requirement: Sorting and filtering
The dashboard SHALL let the user order meters by use first, soonest reset, most left, most value at risk, name or least recently updated, filter them by free text and by provider category, and hide meters that are used up. The chosen ordering and filters SHALL apply to the Queue, Board, Timeline and Table views alike.

#### Scenario: Sort by value at risk
- **WHEN** the user chooses "most value at risk"
- **THEN** every view lists the meter with the highest value at risk first

#### Scenario: Filter by text
- **WHEN** the user types "cla" in the filter
- **THEN** only meters whose account, provider, plan or meter name contains "cla" remain

### Requirement: Quick entry
The dashboard SHALL accept a one-line update naming an account, optionally a meter, an amount (a percentage or a number, used or left) and optionally a reset time, SHALL show how it understood the line before anything is saved, and SHALL save it on confirmation.

#### Scenario: Percentage used
- **WHEN** the user enters "claude weekly 62%"
- **THEN** the preview reads "Claude, Weekly: 62% used, 38% left" and confirming stores that reading

#### Scenario: Amount left with a reset
- **WHEN** the user enters "suno 1200 left resets in 9d"
- **THEN** the preview shows 1,200 credits left and a reset nine days from now

#### Scenario: Ambiguous or unknown account
- **WHEN** the line matches no account or more than one
- **THEN** nothing is saved and the candidates are offered for selection

### Requirement: Quick entry refuses what it cannot read
Quick entry SHALL refuse a line rather than guess: a word that only begins like a weekday or a month SHALL NOT be read as one, a date the calendar does not have SHALL NOT slide into the next month, and a comma in a number SHALL be read only as a thousands separator.

#### Scenario: A word that is not a day
- **WHEN** the user enters "copilot 40% resets monthly"
- **THEN** nothing is saved and the answer says "monthly" was not understood

#### Scenario: The 31st of November
- **WHEN** the user enters "copilot 40% resets nov 31"
- **THEN** nothing is saved

#### Scenario: Decimal comma
- **WHEN** the user enters "suno 1,5k left"
- **THEN** nothing is saved, while "suno 1,200 left" stores 1,200 left

### Requirement: Copy actions
The dashboard SHALL provide, for every meter and account, actions that copy a one-line status, a Markdown summary, the JSON record and an agent prompt, and SHALL provide a "copy brief" action that copies a Markdown summary of everything that needs using. Each copy SHALL be confirmed visibly, and when the clipboard is unavailable the text SHALL be shown selected so it can be copied by hand.

#### Scenario: Copy a status line
- **WHEN** the user chooses "copy status" on a meter
- **THEN** the clipboard holds one line with the account, the meter, the share left, the reset countdown and the value at risk, and a confirmation appears

#### Scenario: Clipboard refused
- **WHEN** the browser refuses clipboard access
- **THEN** the text appears in a selected field with an instruction to copy it

### Requirement: Adding and editing
The dashboard SHALL let the user add an account from the catalog or from scratch, edit every field of an account and its meters, and delete an account or meter after an in-page confirmation that names what will be removed.

#### Scenario: Add from the catalog
- **WHEN** the user picks a provider and plan from the catalog and confirms
- **THEN** the account appears in every view with the preset's meters

#### Scenario: Delete needs confirmation
- **WHEN** the user chooses delete on an account
- **THEN** nothing is removed until they confirm in a dialog that names the account

### Requirement: Connect panel
The dashboard SHALL show ready-to-copy instructions for connecting MCP clients over HTTP and stdio, for the Claude Code status line integration and for installing the agent skill, with the running instance's own address filled in.

#### Scenario: Copy an MCP configuration
- **WHEN** the user opens Connect and copies the Claude Code entry
- **THEN** the clipboard holds a command that registers this instance's MCP address

### Requirement: Live updates
The dashboard SHALL reflect changes made through the API, the MCP server, the CLI or collectors within five seconds without a reload, SHALL update countdowns at least once a minute and every second during the final hour, and SHALL show whether it is connected.

#### Scenario: An agent reports usage
- **WHEN** an agent reports a reading over MCP while the dashboard is open
- **THEN** the affected row updates within five seconds

#### Scenario: Connection lost
- **WHEN** the connection to the local service drops
- **THEN** the dashboard says it is offline, keeps the last data visible and reconnects automatically

### Requirement: A warning comes with something to do
The inspector SHALL, for a meter that is `use-now` or `behind` and whose provider has documented ways to use quota unattended, list those ways with their links and say when the catalog was checked. It SHALL also show the account's own notes.

#### Scenario: Weekly limit about to reset
- **WHEN** the inspector shows a Claude weekly limit that is `use-now`
- **THEN** it lists the provider's documented ways to use the quota, each linking to the provider's page

#### Scenario: Nothing at risk
- **WHEN** the inspector shows a meter that is on pace
- **THEN** no such list is shown

### Requirement: Alerts
The dashboard SHALL show the number of `use-now` meters in the page title, and SHALL, only after the user opts in, raise a browser notification when a reminder becomes due (see the `reminders` capability), at most once per meter per window. It SHALL NOT raise a browser notification while desktop reminders are on, since the service raises the same reminder.

#### Scenario: Meter enters the action horizon
- **WHEN** notifications are enabled and a weekly meter becomes `use-now`
- **THEN** one notification names the account, the share left and the time to reset

#### Scenario: Notifications not enabled
- **WHEN** the user has not opted in
- **THEN** no permission prompt and no notification appears

#### Scenario: Desktop reminders on
- **WHEN** browser notifications and desktop reminders are both on and a meter becomes `use-now`
- **THEN** the dashboard raises no browser notification

### Requirement: Reminder settings in one place
The dashboard SHALL offer one panel that shows every way a reminder can reach the user: in the browser tab, on this computer, at an address of their own, and in their calendar. It SHALL let the user switch the first two on and off, send a test, and copy the calendar address or open the calendar file, and SHALL show the host of a configured webhook address and never the address. On sample data the panel SHALL say which of these need the local service.

#### Scenario: Switching on desktop reminders
- **WHEN** the user switches on reminders on this computer
- **THEN** the setting is saved, a test notification is sent and its outcome is shown in the panel

#### Scenario: Sample data
- **WHEN** the panel is opened on sample data
- **THEN** the desktop and webhook rows say they need the local service and the calendar can be copied as text

### Requirement: Themes
The dashboard SHALL provide a light and a dark theme built on one greyed Solarized palette, SHALL follow the system setting by default, SHALL remember an explicit choice, and SHALL keep body text at a contrast of at least 4.5:1 and meaningful graphical marks at least 3:1 against their background in both themes.

#### Scenario: System in dark mode
- **WHEN** the system prefers dark and the user has made no choice
- **THEN** the dark theme is used

#### Scenario: Explicit choice
- **WHEN** the user selects the light theme while the system prefers dark
- **THEN** the light theme is used now and on the next visit

### Requirement: State is never colour alone
The dashboard SHALL pair every colour-coded state with a text label or icon, SHALL give every chart a text equivalent, SHALL keep keyboard focus visible, and SHALL reduce motion when the system asks for it.

#### Scenario: Tier without colour
- **WHEN** the page is viewed in greyscale
- **THEN** each meter's tier is still readable from its label

#### Scenario: Reduced motion
- **WHEN** the system requests reduced motion
- **THEN** bars and panels change without animation

### Requirement: Keyboard operation
The dashboard SHALL be fully operable by keyboard and SHALL provide shortcuts to switch views, focus the filter, open quick entry, copy the brief, add an account, move through rows, open the inspector and show the list of shortcuts. Shortcuts SHALL be inactive while a text field has focus.

#### Scenario: Switch view by key
- **WHEN** the user presses 3 outside a text field
- **THEN** the Timeline view is shown

#### Scenario: Typing in a field
- **WHEN** the user types "3" in the filter field
- **THEN** the character is entered and the view does not change

### Requirement: Narrow screens
The dashboard SHALL remain usable at a width of 400 CSS pixels: the page SHALL not scroll sideways, rows SHALL stack, and the inspector SHALL open over the list.

#### Scenario: Phone width
- **WHEN** the viewport is 400 pixels wide
- **THEN** every view fits without horizontal page scrolling and all actions remain reachable

### Requirement: Empty state and sample data
The dashboard SHALL, when there are no accounts, offer the catalog and the automatic sources detected on the machine, and SHALL offer a sample-data mode that is clearly labelled, changes nothing on disk and can be left at any time. When the local service cannot be reached at all the dashboard SHALL run on sample data and say so.

#### Scenario: First run
- **WHEN** the dashboard opens with no accounts
- **THEN** it shows how to add the first subscription and a control to try sample data

#### Scenario: Sample data is labelled
- **WHEN** sample data is shown
- **THEN** a persistent label says the figures are examples
