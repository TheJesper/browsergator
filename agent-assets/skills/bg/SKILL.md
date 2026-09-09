---
name: bg
description: "Connect to and drive the shared Browsergator browser -- one always-on Chrome that many agents share over MCP. Use when you need to open/close/read/drive browser tabs, or when the user says 'use the shared browser', 'connect to browsergator', or '/bg'. Any agent can work on any tab; coordination (per-tab FIFO + leases) prevents collisions."
triggers:
  - "/bg"
  - "use the shared browser"
  - "connect to browsergator"
  - "drive a tab"
  - "open a tab"
---

# bg -- shared agent browser

You are connected (or should connect) to **Browsergator**: one long-lived, dedicated Chrome
that many agents share over MCP. Agents are ephemeral clients; the browser and gateway stay
running. You can add, remove, read, and drive tabs -- the same tab or different tabs as other
agents.

## If the browser is down (READ THIS FIRST)

If `list_tabs` fails with "not connected", or you cannot reach the gateway, the shared Chrome
is not up. **Do NOT invent your own `chrome --remote-debugging-port` command.** Improvising a
launch with a different `--user-data-dir` creates a second, conflicting profile and breaks the
shared setup for everyone.

There is exactly ONE way to (re)start the shared Chrome. It is safe to run any number of times
by any agent -- it does nothing if Chrome is already up (idempotent):

```
npm run chrome        # from the Browsergator repo
# or, from anywhere:
node <browsergator-repo>/scripts/launch-chrome.mjs
```

That launcher owns the correct profile (`<home>/.cache/browsergator/chrome-profile`), binds the
loopback debug port, and starts Chrome detached and windowless. After it reports the port is up,
the gateway reconnects automatically within a few seconds -- then retry `list_tabs`.

Rules when the browser is down:
- Run the launcher above. Never hand-roll a `chrome.exe --remote-debugging-port` command.
- Never pass a different `--user-data-dir`. The profile is fixed and shared.
- The gateway auto-reconnects; you do NOT restart the gateway to fix a browser outage.
- If the launcher is missing, tell the user to run it from the Browsergator repo -- do not
  substitute your own command.

## Connection

The gateway speaks Streamable HTTP MCP:

- Endpoint: `http://127.0.0.1:8788/mcp`
- Auth: `Authorization: Bearer <BROWSER_GATEWAY_TOKEN>` (env var; never hardcode the value)
- MCP server id: `browser-gateway`

If your client is not registered yet, see `docs/CLIENT-COMPATIBILITY.md` in the Browsergator
repo for the exact `codex mcp add` / `claude mcp add-json` / `gemini mcp add` command.

## Golden rules

1. **`list_tabs` FIRST.** Never assume a tab exists. Discover current tabs and their `pageId`s.
2. **Reference tabs by explicit `pageId`.** Every page-scoped tool needs `pageId`.
3. **Pass your identity** on coordinated calls: `agentId`, `taskId`, `leaseOwnerId`. These are
   distinct from the MCP session -- use stable logical values (e.g.
   `agentId=<tool>:<project>:<agent>`, `leaseOwnerId=<taskId>:<attempt>`).
4. **Reads are free; writes are serialized.** Reads (`snapshot`, `evaluate`, `get_storage`)
   flow anytime. Mutations on one tab are FIFO-queued. Sensitive tabs may require a lease.
5. **Don't fight another agent.** If a tab is `protected` or you need exclusivity, `claim_tab`
   (lease) before writing; `release_tab` when done. Respect `writeNeedsConfirm` from
   `classify_environment` on prod-looking hosts.

## Typical flow

```
list_tabs                                  -> find the tab you want, note its pageId
open_tab { url }                           -> or create a new one (returns pageId)
navigate { pageId, url, waitUntil }        -> go somewhere
snapshot { pageId }                        -> read the accessibility tree
screenshot { pageId }                      -> full-page PNG/JPEG
screenshot { pageId, clip:{x,y,width,height} }  -> capture a region only
screenshot { pageId, selector }            -> capture just one element (auto-clips to its box)
evaluate { pageId, expression }            -> read a value from the page
click / fill / type_text / press_key { pageId, ... }  -> drive it (queued per tab)
classify_environment { pageId }            -> check local/test/prod before risky writes
claim_tab / release_tab { pageId, ... }    -> exclusive lease for sensitive work
close_tab { pageId }                       -> close ONLY tabs you should close
```

## Etiquette on a shared browser

- Do not close tabs other agents/users may be using unless asked.
- Prefer opening your own tab for scratch work; close it when finished.
- On prod hosts (`classify_environment` -> tier `prod`), treat writes as high-risk and confirm.
- Never start or stop Chrome by hand. If it is down, run the ONE launcher above
  (`npm run chrome`) -- never a custom `chrome --remote-debugging-port` command with a
  different profile.
