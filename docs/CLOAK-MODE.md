# Cloak mode

The inspected `W:/code/microtools/cloakbrowser-fetch` implementation is a draft Python wrapper around `cloakbrowser.launch()`. Each call creates a browser, opens one page, fetches content, and closes the browser. It can reuse a `cf_clearance` cookie, proxy, and `humanize=True`, but it does not provide a persistent identity or shared controller.

Therefore it is not linked into the MVP gateway. Reusing the current function would contradict the required coherent-session fingerprint and singleton lifecycle.

## Planned adapter

A future `CloakBrowserDriver` will be a separate long-lived worker with an explicit session identity containing compatible user agent/client hints, OS, viewport, locale, timezone, proxy geography, and cookie jar. The gateway contract remains page-ID based; the adapter must report capability differences rather than pretending to support raw CDP features it lacks.

The adapter must rate-limit per origin, never rotate mutually inconsistent identity attributes inside a session, and surface CAPTCHA as `NEEDS_HUMAN`. It must not solve or bypass CAPTCHA automatically.

`natural` mode is orthogonal: it controls reproducible timing, pointer paths, click-point variation, gradual scrolling, and visual/DOM stability waits. It can run over the normal driver or a future cloak driver.
