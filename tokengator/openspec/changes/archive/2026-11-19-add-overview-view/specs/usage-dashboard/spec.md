## ADDED Requirements

### Requirement: Overview view
The dashboard SHALL offer an Overview view, first among the views and reached with the key 0, made of tiles: what to use before its reset, what expires and when, finished windows week by week, readings to refresh, every quota against an even pace, plan fit over 90 days and API spend this month. It SHALL apply the category and text filters to every tile, finished windows included, and "Hide used up" to current windows.

#### Scenario: Switch to the Overview by key
- **WHEN** the user presses 0 outside a text field
- **THEN** the Overview is shown and the page address identifies it

#### Scenario: The Queue still opens first
- **WHEN** the dashboard is opened for the first time with no view in the address
- **THEN** the Queue is shown

#### Scenario: A filtered Overview
- **WHEN** the user selects the Music category on the Overview
- **THEN** every tile counts only music subscriptions, their finished windows included, and one line says the tiles are filtered while the summary sentence counts everything

### Requirement: Each figure once on the Overview
While the Overview is shown, the summary SHALL keep its sentence, its connection state and the next reset, and SHALL leave out the money at risk across all windows, the money expired in the last 30 days, the share used and the stale count while the tile that states each figure is shown. Hiding a tile SHALL put its figure back in the summary.

#### Scenario: Figures move into tiles
- **WHEN** the Overview is shown with every tile
- **THEN** the money at risk across all windows, the money expired in the last 30 days and the share used each appear once, in a tile, and the summary sentence still names the money at risk now

#### Scenario: A hidden tile gives its figure back
- **WHEN** the user hides "Finished windows"
- **THEN** the summary shows the money expired in the last 30 days again, labelled and worded as the tile states it

#### Scenario: A filter that no finished window matches
- **WHEN** windows are on record and the user types a filter that none of them matches
- **THEN** "Finished windows" says that no finished window matches the filter, not that nothing has expired, and the summary shows the money expired in the last 30 days

### Requirement: Use before the reset
The Overview SHALL lead with at most four quotas to use now, each as a queue row with the time to its reset as the largest figure, and SHALL say for the first how much an hour or a day uses it up before the reset, allowing for a closed session limit. With none to use now it SHALL show up to three quotas behind pace and when the first will need using; with neither it SHALL say that nothing is going to waste.

#### Scenario: A weekly limit resets tonight
- **WHEN** a weekly limit with 38% left resets in 14 hours and is to use now
- **THEN** it is the first entry, tinted, with the time to reset as its largest figure, and the line under the entries gives the share an hour that uses it up

#### Scenario: Nothing to do
- **WHEN** no quota is to use now or behind pace
- **THEN** the tile says nothing is going to waste right now

### Requirement: What expires and when
The Overview SHALL chart, for each of the next 30 days in the viewer's time zone, the money expected to expire at that day's resets, hatched as a forecast, with plan money and dollar credits in separate lanes on separate scales. It SHALL state the money at risk across all windows, the total for the next seven days in text above the chart, and the money at risk in windows that reset after 30 days with the number of quotas behind it, and SHALL count quotas without a price in words.

#### Scenario: Credits beside plan money
- **WHEN** plan quotas and bundled API credits both have money at risk within 30 days
- **THEN** the credits are drawn in their own lane with their own scale and no figure on the tile adds the two

#### Scenario: The next seven days without the chart
- **WHEN** the user shows the table of "What expires, and when", or reads the tile with a screen reader
- **THEN** the total for the next seven days is still stated above it

#### Scenario: A new window
- **WHEN** a quota's window has just started and it resets within 30 days
- **THEN** the table lists it with "too early" under "Will expire" and no money at risk

#### Scenario: Money after 30 days
- **WHEN** an on-pace quarterly quota that resets in 40 days has money at risk
- **THEN** the table's "After 30 days" row counts that quota beside the amount

#### Scenario: Quota that carries over or is snoozed
- **WHEN** a quota's unused part carries over, or its subscription is snoozed
- **THEN** it adds no money to the chart, and the caption counts the snoozed quotas

#### Scenario: No prices
- **WHEN** no tracked subscription has a price
- **THEN** each column counts the quotas that lose at least 5% at that day's resets and the caption says prices are missing

### Requirement: Finished windows on the Overview
The Overview SHALL show the money expired in the last 30 days with its change from the 30 days before, the share of each window used on average over the last 30 days, and both week by week for twelve weeks on one axis, with their table, as soon as any of the twelve weeks holds a finished window. Expired money SHALL be solid with its estimated part outlined, and a week in which no window closed SHALL have no column rather than a zero.

#### Scenario: A week without a record
- **WHEN** no window closed in one of the last twelve weeks
- **THEN** that week has no column and its table row says no window closed

#### Scenario: A new ledger
- **WHEN** windows closed in only one of the last twelve weeks
- **THEN** the weekly charts and their table are shown

#### Scenario: Estimated credits in a week
- **WHEN** the 52 USD of credits that expired in a week all come from windows nobody read near their end
- **THEN** the week's table row gives the credits as "about $52"

#### Scenario: The current week matches the figure
- **WHEN** the share used is drawn week by week
- **THEN** the point for the current week equals the share used over the last 30 days

### Requirement: Needs attention on the Overview
A "Needs attention" tile SHALL list the readings too old to act on and the quotas whose reset time is unknown: never-read quotas first, then those without a reset time, then the most overdue relative to how often each quota should be read. Each entry SHALL open its quota and offer an update, or a refresh where an automatic source feeds it.

#### Scenario: The most overdue first
- **WHEN** a daily quota was read 10 hours ago and a monthly quota 3 days ago
- **THEN** the daily quota comes first, because its reading is further past how often a daily quota should be read

#### Scenario: A stale reading fed by a collector
- **WHEN** a quota fed by an enabled collector has a reading older than it should be
- **THEN** its entry offers Refresh, and a quota kept by hand offers Update

### Requirement: Closed limits and overflow in Needs attention
The "Needs attention" tile SHALL list closed rate limits with the time they reopen, first and always within its at most five entries, since the Queue does not list rate limits. It SHALL link the readings that do not fit to the Queue sorted by last update, counting only those, and the closed limits that do not fit to the Board.

#### Scenario: A closed rate limit
- **WHEN** a rate limit is used up and its window has not reset
- **THEN** the tile lists it as blocked with the time until it reopens

#### Scenario: More stale readings than room
- **WHEN** six readings are stale and one rate limit is closed
- **THEN** the tile lists the closed limit and four readings, and its link says "2 more in the Queue"

### Requirement: Every quota against an even pace
The Overview SHALL place every allowance quota with a running window at its share of the window gone and its share used, beside an even-pace diagonal, with its state's shape, coloured orange only when part of it is expected to expire and neutral otherwise. A window too new to forecast SHALL count as nothing expected to expire. Selecting a quota SHALL draw its projection to the reset. Below 360 pixels of chart width, or above 60 quotas, a table SHALL replace the chart.

#### Scenario: Behind pace is orange
- **WHEN** one quota is behind pace and another is running hot
- **THEN** the first is drawn orange with the behind-pace shape, the second in the neutral ink with the running-hot shape, and the legend names both

#### Scenario: A new window is not orange
- **WHEN** a quota has used 2% with 3% of its window gone, too early to forecast
- **THEN** it is drawn in the neutral ink and its table row leaves "Will expire" empty

#### Scenario: A phone
- **WHEN** the viewport is 320 pixels wide
- **THEN** the tile shows the table of quotas instead of the chart

### Requirement: Plan fit on the Overview
The Overview SHALL rank subscriptions by the plan money their finished windows left unused over the last 90 days, at most six, each with its average share used and its number of windows, with dollar credits as a separate figure and amounts that include estimated windows given as approximate whole units. A subscription without a price SHALL show the share its windows left unused instead of money, and SHALL say that nothing expired only when its windows were used up.

#### Scenario: Estimated windows in a total
- **WHEN** a subscription's 90-day total of 54.97 USD includes estimated windows
- **THEN** its figure reads "about $55"

#### Scenario: No price set
- **WHEN** a subscription without a price used 60% of each of its finished windows
- **THEN** its row says 40% was left unused and that no price is set

### Requirement: Opening a subscription from Plan fit
Selecting a Plan fit row whose subscription still exists SHALL open its meter with the most expired money, or another of its quotas when that meter is gone, whatever the filters hide.

#### Scenario: Used up quotas hidden
- **WHEN** "Hide used up" is on and a subscription's meter with the most expired money is used up now
- **THEN** the subscription's row still opens that meter

### Requirement: API spend on the Overview
When API spend sources exist and no category or text filter is on, the Overview SHALL show each source's spend this month against its budget and projection, marking a projection over budget as heading over without the colour reserved for blocked.

#### Scenario: Heading over budget
- **WHEN** a source has spent 49 of a 60 USD budget and is projected at 78
- **THEN** its row says it is heading over budget

### Requirement: Overview charts have text and keyboard equivalents
Every Overview chart SHALL have a caption from the shared wording and a table that can be shown in its place and stays shown after a redraw. Every quota a tile shows SHALL be reachable by keyboard and open the inspector, and closing the inspector SHALL return focus to the control that opened it, also after a redraw.

#### Scenario: Back to the mark
- **WHEN** the user opens a quota from the even-pace chart by keyboard, the page redraws, and the user presses Esc
- **THEN** focus is on the same mark

#### Scenario: A table in place of a chart
- **WHEN** the user shows the table of "What expires, and when" and the page redraws
- **THEN** the table is still shown, the Table button is announced as pressed, and each quota in it opens the inspector

#### Scenario: J and K on the Overview
- **WHEN** the user presses J repeatedly on the Overview, where several tiles show the same quota
- **THEN** focus visits every quota shown once, in the order each first appears, and from an even-pace mark J moves on to the next quota in that order

#### Scenario: A tooltip put away
- **WHEN** a focused chart mark shows its tooltip and the user presses Esc
- **THEN** the tooltip goes, focus stays on the mark, and a second Esc closes the inspector

#### Scenario: A tile link to another view
- **WHEN** the user activates "5 more in the Queue" in a tile
- **THEN** the Queue is shown with focus on its first row, or on its tab when it has no rows

### Requirement: Overview tables
The control that shows an Overview table SHALL keep the label "Table" and state whether the table is shown as its pressed state, and SHALL be hidden while a narrow tile already draws the table in the chart's place. Every Overview table SHALL scroll sideways inside its tile, reachable and scrollable by keyboard and named for a screen reader.

#### Scenario: A narrow even-pace tile
- **WHEN** the even-pace tile is narrower than its chart needs and draws its table instead
- **THEN** it offers no Table button, since there is no chart to switch back to

#### Scenario: A wide table on a wide screen
- **WHEN** the table of "What expires, and when" is wider than its tile
- **THEN** the user can move focus to it and scroll it sideways with the arrow keys to reach every column

### Requirement: Hiding Overview tiles
The Overview SHALL let the user hide each tile except "Use before the reset" and "What expires, and when" from a Tiles menu, SHALL remember the choice on the next visit, and SHALL lay out the remaining tiles in two columns or one depending on the width available, with no empty cell and in the same order for the eye and the keyboard.

#### Scenario: A hidden tile stays hidden
- **WHEN** the user hides "Every quota against an even pace" and reloads the page
- **THEN** it stays hidden and no cell of the grid is left empty

#### Scenario: Inspector docked
- **WHEN** the inspector is docked on a 1280 pixel screen
- **THEN** the tiles form two columns with no empty cell

## MODIFIED Requirements

### Requirement: View modes
The dashboard SHALL offer seven views of the same data: Overview (tiles that sum up what to use, what expires and what expired), Queue, Board (one card per account with all its meters), Timeline (meters placed at their reset time on a time axis), Table (one sortable row per meter), Costs and History. The selected view SHALL be restored on the next visit and SHALL be addressable in the page address.

#### Scenario: Switching view
- **WHEN** the user selects Timeline
- **THEN** the same meters are shown on a time axis and the page address identifies the Timeline view

#### Scenario: Returning later
- **WHEN** the user reopens the dashboard without a view in the address
- **THEN** the view they last used is shown

#### Scenario: Seven tabs on a phone
- **WHEN** the viewport is 400 pixels wide and the user presses 6
- **THEN** the History tab is scrolled into view inside the tab strip, and the strip fades only at an edge where tabs are hidden

### Requirement: Sorting and filtering
The dashboard SHALL let the user order meters by use first, soonest reset, most left, most value at risk, name or least recently updated, filter them by free text and by provider category, and hide meters that are used up. The chosen ordering SHALL apply to the Queue, Board, Timeline and Table views alike, and the filters to those views and to the Overview.

#### Scenario: Sort by value at risk
- **WHEN** the user chooses "most value at risk"
- **THEN** every view lists the meter with the highest value at risk first

#### Scenario: Order on the Timeline
- **WHEN** an order other than soonest reset is chosen and the Timeline is shown
- **THEN** the rows inside the horizon follow the chosen order, and each row's position on the axis still shows when it resets

#### Scenario: A category that is no longer in use
- **WHEN** the chosen category has no account left, because the last one was removed or the data source changed
- **THEN** the category filter is cleared and the user's quotas are listed

#### Scenario: Filter by text
- **WHEN** the user types "cla" in the filter
- **THEN** only meters whose account, provider, plan or meter name contains "cla" remain

### Requirement: Hiding names
The dashboard SHALL offer a setting that hides account names for screen sharing. While it is on, no account name and no identifier made from one SHALL be readable in any view, in the summary, in the inspector, in a menu, in a chart label or in a tooltip.

#### Scenario: Sharing a screen
- **WHEN** the user switches on "Hide names"
- **THEN** the summary's next-reset sentence, every row, card and table cell, the inspector's agent hint and the row menus show no account name, the two-letter chip beside each name shows no letters, and the plan and price are hidden with the name

#### Scenario: A tooltip on a chart
- **WHEN** names are hidden and the pointer rests on a day of the Overview's expiry chart
- **THEN** the tooltip names the meters that reset that day without their account names

#### Scenario: Native tooltips and accessible names
- **WHEN** names are hidden
- **THEN** no native tooltip and no accessible name of a row, card, chart mark, the details pane or their buttons names an account, since neither can be blurred
