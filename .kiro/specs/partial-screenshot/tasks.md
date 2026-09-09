# Tasks -- Partial screenshots

- [x] 1. Types: ScreenshotClip / ScreenshotOptions / ScreenshotResult.clip; driver signature (R1,R2,R3)
- [x] 2. errors.ts: INVALID_SCREENSHOT_CLIP (R1.2)
- [x] 3. Driver: options + elementRect(); clip validation; echo clip (R1,R2)
- [x] 4. Gateway: pass options through (R3)
- [x] 5. MCP server: clip/selector/uid schema; build locator; summary includes clip (R1,R2)
- [x] 6. Mock driver: honour clip + locator rect (tests)
- [x] 7. test/screenshot.test.ts: full/clip/element/jpeg (R1,R2,R3)
- [x] 8. bg skill: document full/region/element usage (R4)
- [x] 9. Verify: build+typecheck+lint; unit tests; LIVE full/clip/element on real Chrome (all smaller than full)
- [ ] 10. Commit + push (TheJesper), switch gh back

## Definition of done
- Region and element screenshots work; full-page default unchanged; documented in /bg; tests green; live-verified.
