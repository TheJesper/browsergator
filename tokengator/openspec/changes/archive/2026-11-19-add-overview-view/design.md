# Design: Overview view

## D19. Overview: a hub that states each figure once

**Name and place.** "Overview", the first tab, key `0`, address `#overview`. "Dashboard" is what the whole
application is called in the specs, and "Boxes" would be confused with "Board". The Queue stays the first
screen on a first visit, because "the first screen answers what do I use now" is a requirement the Queue
meets with more room; the view last used is restored, so a person who prefers the Overview lands on it.

**What each tile answers.** Every tile cuts across subscriptions (the Board already gives one card per
subscription) and earns its place against the goal of not letting quota expire unused:

| Tile | Question | Form |
| --- | --- | --- |
| Use before the reset | Which quota do I go and use now, and how hard? | Queue rows, a rate line |
| What expires, and when | How much value expires on which day? | 30 columns, hatched, credits lane |
| Finished windows | Am I still losing money, and is it improving? | Two figures, two panels on one 12-week axis |
| Needs attention | Which numbers are too old to act on, and which limits are closed? | A list with Update, Refresh or the reopening time |
| Every quota against an even pace | Which quotas sit below even pace, and how far? | Scatter with HTML marks, table fallback |
| Plan fit, last 90 days | Which subscriptions do I keep under-using? | Ranked rows, share used first |
| API spend this month | Is pay-as-you-go spend on budget? | Bullet rows |

Left out on purpose: a hero number (the summary sentence already leads), rings and gauges (they compare
badly and the research found them everywhere for the wrong goal), a weekday by hour heatmap (twelve resets
in 168 cells, and the sample's resets depend on load time), streaks and leaderboards (they reward burning
quota), per-meter sparklines (Board and History have them), and anything that needs data that is not
stored (money at risk over time, forecast accuracy).

**Each figure once.** On the Overview the summary strip keeps its sentence, its connection state and the
next reset. It leaves out a figure while the tile that states it is shown: the money at risk across all
windows (always in "What expires"), the money expired and the share used (in "Finished windows") and the
stale count (in "Needs attention"). Hiding a tile puts its figure back in the strip, and so does a filter
that leaves out every finished window on record: the tile then says that no window matches, not that
nothing expired.

**Filters.** The category, text and "Hide used up" filters scope every tile; the category and text filters
also scope finished windows, matched through the live account when it still exists. A line says the tiles
are filtered while the sentence counts everything. Sort and the Timeline horizon do not apply: each tile's
order carries its meaning.

**Grid.** Two columns from 720 pixels of pane width, one below; every tile takes one cell, and an odd last
tile takes the whole row, so no cell is ever empty. The pane, not the window, decides, so a docked
inspector at 1280 pixels gives two columns of about 410 pixels and at 1040 pixels one column. No
reordering and no resizing: the order is the meaning, and a keyboard alternative to dragging is not worth
its cost. Hiding is enough flexibility.

**Charts are drawn at their real width.** Tiles are built first, then each chart slot is measured and its
SVG drawn with one unit per CSS pixel, so labels stay 11 pixels from 320 to 1440. A ResizeObserver redraws
only the charts when a slot's width changes by 8 pixels or more, keeping focus by stable element ids.

**Colour still means state.** Columns that will expire are hatched orange; what did expire is solid orange,
with its estimated part outlined; the share used is the "used" blue. On the even-pace map a quota is
orange when part of it is expected to expire and a neutral ink otherwise, and its shape gives its tier,
so running hot and used up are never repainted in a colour that means something else. A window too new to
forecast counts as nothing expected to expire. In forced colours, where every colour becomes the same
system ink, a mark expected to expire is a filled disc and one with nothing expected to expire a hollow
ring, and the legend keys are drawn the same way. Providers are told apart by name and position only.

**The first seven days.** A quiet bracket above the expiry chart spans its first seven days, the span the
"Next 7 days" figure adds up. The figure itself is page text, so the drawing carries no number that the
page does not also state.

**Marks that can take focus are HTML.** The even-pace marks are buttons positioned over the SVG, because
focus on an SVG element is lost on every rebuild. Column hit areas are pointer-only; their keyboard
equivalent is the tile's table, whose quota cells open the inspector. The button that shows a table is
always labelled "Table" and is pressed while the table is shown; it is hidden where a narrow tile already
draws the table in the chart's place. Each table sits in a named region that takes focus, so it can be
scrolled sideways by keyboard. The total for the next seven days is written in the page above the expiry
chart, not in the drawing, so it is read out and stays when the table is shown.

**Needs attention.** Closed rate limits come first and always have a place among the five entries: the
Queue, which the tile's link opens for the readings that do not fit, does not list them. Closed limits
beyond five are linked to the Board.

**One wording.** `lostText`, `utilisationText`, `trendText`, `finishLine`, the chart captions and the
figure labels live in `src/core/wording.ts`. The brief, `tokengator status` and `waste_report` use them, so
"about $39 expired, 80% used over 15 windows" reads the same everywhere.
