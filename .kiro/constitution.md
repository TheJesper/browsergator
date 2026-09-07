# Browsergator constitution

The durable principles behind Browsergator. Specs, code, and operational choices bend to
this document; when a spec conflicts with it, this wins. Keep it short -- it is a compass,
not a manual.

## Vision

One always-on browser that any number of AI agents can work in together -- adding tabs,
removing tabs, reading and driving the same or different tabs -- without stepping on each
other and without anyone babysitting it. Agents come and go; the browser and the gateway
stay. No fuss ("slipp astrul"): it starts itself, stays logged in, and just works.

## Target audience

Every developer who works with agents. Not one team, not one client -- the setup must be
generic enough that anyone running Codex, Claude Code, Gemini, Copilot, or any MCP client
can point it at the same shared browser and be productive in minutes. Tens of thousands may
clone or fork it.

## Core principles

1. **Shared, durable browser.** One dedicated Chrome, long-lived, shared by all agents. It
   survives any single agent connecting or disconnecting. Agents are ephemeral clients.

2. **Any agent, any tab, full add/remove.** Every agent can list, open, close, read, and
   drive tabs -- the same tab or different tabs. Coordination (not restriction) keeps them
   from colliding: per-tab FIFO for mutations, leases for sensitive tabs, reads flow freely.

3. **No astrul -- it just runs.** Starts at logon, restarts on failure, needs no manual
   profile creation, no window flicker, no log spam. The happy path requires zero operator
   steps after install.

4. **The gateway never owns the browser's life.** Browsergator connects to Chrome over CDP;
   it never launches, kills, or reconfigures a browser. Chrome's lifecycle belongs to a
   separate launcher/service. (AGENTS.md rule 1.)

5. **Isolated from your private browsing.** The shared browser uses a dedicated, persistent
   profile separate from your everyday Chrome. Logins persist across restarts so agents work
   authenticated; your private profile is never touched. (Chrome 136+ also mandates this.)

6. **Loopback and least privilege by default.** Control ports bind to loopback; a bearer
   token gates `/mcp`; Origin/Host are restricted to loopback. Security gates are not
   weakened without a documented review.

7. **Distinct identities.** MCP session, `agentId`, `taskId`, `browserSessionId`,
   `browserContextId`, `pageId`, and `leaseOwnerId` are separate concepts. Never collapse the
   MCP connection into agent or lease identity.

8. **Nothing secret in the repo.** Tokens, cookies, and profiles live outside version
   control. The public repo carries only placeholders and test fixtures. It is meant to be
   cloned and forked freely.

9. **Cross-platform, no hardcoded paths.** Windows, macOS, and Linux are first-class. Paths
   and interpreters are derived at runtime (home dir, `process.execPath`, PATH) -- never a
   hardcoded username or install location.

10. **Portable and honest.** Prefer one portable Node script over per-OS shell scripts.
    Prefer connecting over spawning. Prefer fewer dependencies. Say what is verified and what
    is not.

## How this maps to the specs

- `cross-platform-launcher` -- portable launcher, `.env`, per-OS docs, CI (principles 9, 10).
- `shared-agent-browser` -- always-on shared Chrome + gateway, zero-setup profile, windowless
  start, quiet logs (principles 1, 2, 3, 4, 5, 8).
