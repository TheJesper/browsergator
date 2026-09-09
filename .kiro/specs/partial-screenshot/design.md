# Design -- Partial screenshots

## Overview

Extend `screenshot` with an optional region (`clip`) or element locator, resolved to a CDP
`Page.captureScreenshot` clip. Default (no options) is unchanged full-page capture.

## Changes

| File | Change |
|------|--------|
| `src/types.ts` | `ScreenshotClip`, `ScreenshotOptions {format,quality,clip,locator}`; `ScreenshotResult.clip?`; driver signature -> `screenshot(pageId, options)` |
| `src/errors.ts` | add `INVALID_SCREENSHOT_CLIP` |
| `src/cdp/websocket-cdp-driver.ts` | accept options; `elementRect()` resolves a locator's bounding box (reusing `evaluateInteraction` + `getBoundingClientRect`, scrolls into view); pass `clip {x,y,width,height,scale:1}` to CDP; validate positive dims; echo clip |
| `src/gateway.ts` | pass options through |
| `src/mcp/server.ts` | schema gains `clip`, `selector`, `uid`; builds a locator; summary includes clip |
| `test/helpers/mock-browser-driver.ts` | mock honours clip; a locator yields a fixed rect |
| `test/screenshot.test.ts` | full / clip / element / jpeg |
| `agent-assets/skills/bg/SKILL.md` | document the three shapes |

## Decisions

- **Element -> clip via bounding box.** Reuse the existing element-resolution path
  (`evaluateInteraction`), call `scrollIntoView` then `getBoundingClientRect`, and clip to that
  rect. Simpler and more predictable than CDP `fromNode` and consistent with click/hover.
- **`clip` and `locator` mutually exclusive** at the call site; if both are somehow present,
  explicit `clip` wins (documented). The MCP layer only sets a locator when selector/uid given.
- **`scale: 1`** on the CDP clip to avoid DPR surprises.
- **Validation** of positive width/height -> `INVALID_SCREENSHOT_CLIP` before calling CDP.

## Testing

- Unit (mock): full has no clip; explicit clip echoed; locator resolves to a rect; jpeg mime.
- Live (real Chrome, example.com): full vs clip vs element -- clipped byte sizes are strictly
  smaller than full-page, and element clip returns the resolved bounding box. Verified.
