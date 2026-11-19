# Tasks

## 1. Core

- [ ] 1.1 Add `src/core/insights.ts`: `upcomingResets`, `expiryOutlook`, `ledgerWeeks`, `wasteBy`, `refreshList`, `countTiers`, `nextUseNow`; move the reminders' private reset stepping onto `upcomingResets`; verify with `test/core/insights.test.ts` and the unchanged reminders tests
- [ ] 1.2 Add the shared wording (`FIGURE_LABEL`, `lostText`, `utilisationText`, `trendText`, `finishLine`, `nextUseNowLine`, `readingAge`, `expiryCaption`, `paceCaption`); verify with `test/core/wording.test.ts`
- [ ] 1.3 Use the wording in the brief, `tokengator status` and `waste_report`, and add `byWeek` to `waste_report`; verify with the CLI, render and MCP tests and the examples in `docs/MCP.md`
- [ ] 1.4 Add finished windows of bundled API credits to the sample data; verify the sample stays deterministic

## 2. Dashboard

- [ ] 2.1 Add the Overview view, key 0 and the tab strip's scroll and fade; verify key, address and tab in the browser check
- [ ] 2.2 Build the seven tiles, their empty states and the filtered line; verify each in the browser check on sample data and on a state with no ledger, no prices and no spend
- [ ] 2.3 Draw the expiry columns, the weekly panels and the even-pace map at their measured width, with tables and keyboard access; verify contrast, forced colours, 400 and 320 pixels
- [ ] 2.4 Add the Tiles menu and the summary rule that each figure appears once; verify hiding, reloading and the figure returning to the summary
- [ ] 2.5 Keep focus across redraws and when the inspector closes; verify with a keyboard-only browser check

## 3. Integration

- [ ] 3.1 Update the README view list and keys, and `docs/MCP.md` for `waste_report`
- [ ] 3.2 Run an independent review of the view and resolve what it finds
- [ ] 3.3 Run `npm run lint`, `npm run typecheck`, `npm test` and `npm run build` in both the root and `tokengator/`, the browser and end-to-end checks, and `openspec validate --all --strict`
