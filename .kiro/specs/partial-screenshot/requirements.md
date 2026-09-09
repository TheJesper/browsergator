# Requirements -- Partial (region/element) screenshots

## Introduction

The `screenshot` tool captured only the full page. Agents frequently need just a region or a
single element (a chart, an error banner, one card) -- smaller payloads, sharper focus. This
adds optional region and element clipping without changing the default full-page behaviour.

## Requirement 1 -- Region clip

**User story:** As an agent, I want to capture a specific rectangle of the page.

#### Acceptance criteria
1. WHEN `screenshot` is called with `clip {x,y,width,height}` THEN only that viewport-relative
   region SHALL be captured.
2. IF width or height is <= 0 THEN the call SHALL fail with a clear `INVALID_SCREENSHOT_CLIP`
   error.
3. WHEN a clip is used THEN the response SHALL echo the `clip` that was applied.

## Requirement 2 -- Element clip

**User story:** As an agent, I want to capture just one element without computing coordinates.

#### Acceptance criteria
1. WHEN `screenshot` is called with a `selector` or `uid` THEN the element's bounding box SHALL
   be resolved and used as the clip.
2. WHEN the element is off-screen THEN it SHALL be scrolled into view before measuring.
3. IF the element has no visible bounds THEN the call SHALL fail with `ELEMENT_NOT_FOUND`.

## Requirement 3 -- Backward compatible default

#### Acceptance criteria
1. WHEN neither `clip` nor a locator is given THEN a full-page screenshot SHALL be returned
   exactly as before (no `clip` in the response).
2. WHERE `format`/`quality` are given THEN they SHALL apply to region and element captures too.

## Requirement 4 -- Documented for agents

#### Acceptance criteria
1. WHERE the `/bg` skill lists tools THEN it SHALL show full, region-clip, and element-clip
   screenshot usage.

## Out of scope
- Full-scroll "entire document" stitching beyond CDP's `captureBeyondViewport`.
- Multiple elements in one shot.
