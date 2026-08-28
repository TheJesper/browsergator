# Browsergator Open-Source Launch — Teamroom Brief

**Date:** 2026-08-28
**Convened by:** Jesper via orchestrator
**Session type:** DevKit teamroom, `session start collaborative`
**Topic:** "Open-source marketing plan for Browsergator (multi-agent Chrome MCP gateway)"

---

## Attendees

| Role | Agent | Job in this session |
|------|-------|--------------------|
| **Strategy lead** | **promotor** (NEW — to be spec'd, see §B) | Decides overall strategy, picks channels, sets narrative arc, greenlights video/reel plan |
| **Content/social** | `hoffbits_root` | Blog posts (hoffbits.com), social-copy for X/LinkedIn/Reddit/HN/PH, tie-in with other Conzeon projects |
| **Web/landing-page** | `vsc_root` (very-smooth-code, vs-code.com) | Adds Browsergator entry to vs-code.com dev-tools hub, writes technical landing page, code snippets |
| **Founder** | Jesper | Vision, brand-voice sign-off, budget for paid video-gen APIs |

---

## Pre-session investigation (in flight)

- Fork investigating: **does Browsergator solve a real problem?** (personas, alternatives, adoption blockers, marketing-angle-verdict). Result → `docs/PROBLEM-FIT-ANALYSIS.md`. Orchestrator will attach to teamroom kickoff message when it lands.

---

## What promotor must decide (agenda)

1. **Positioning:** OSS-first library vs OSS-freemium (paid managed gateway later)?
2. **Narrative angle:** "one browser, many agents" vs "stop paying per-agent CDP" vs "share Chrome without leaking auth cookies"?
3. **Channel mix:**
   - Product Hunt launch date
   - HN Show HN post
   - Reddit (`/r/mcp`, `/r/LocalLLaMA`, `/r/programming`, `/r/webdev`)
   - Twitter/X threads (whose account — hoffbits, jesper, or promotor voice?)
   - LinkedIn (Conzeon-account? personal?)
   - **TikTok / Reels** — demo-videos of multi-agent choreography
4. **Video/reel strategy** (see §A):
   - Screen-recorded demos (multi-agent working same Chrome, no conflicts)
   - Explainer reels (30-60s, TikTok-ready)
   - Long-form YouTube demo (5-10 min)
5. **KPI to optimise:** GitHub stars? npm-downloads? Discord signups? gateway-managed-service email-signups?
6. **Timeline:** launch date + content-cadence

---

## §A — Video-gen / screen-recording capability requirements

Jespers ask (verbatim): *"promotor should be able to make videos, promotion reels and videos... record screen demo screens and everything. BIG NO LIMITS! Add public music... put on TikTok. We can subscribe to video-gen for speaker but need screen-recording for demos as well."*

**Concrete tools needed for promotor:**

| Capability | Free/OSS option | Paid option | Rec |
|-----------|-----------------|-------------|-----|
| Screen recording (headless-capable) | OBS Studio + ffmpeg CLI, `puppeteer.screencast()`, Playwright video | ScreenStudio, Loom API | **OBS-CLI + ffmpeg** (free, scriptable, no limits) |
| AI voice-over | Piper (OSS, on-device), Coqui TTS | ElevenLabs (best quality), OpenAI TTS | **ElevenLabs subscription** for hero-videos; Piper for iteration |
| Video composition (cuts, transitions, music-overlay) | ffmpeg, MoviePy (Python), Remotion (React-based, code-driven) | Adobe Premiere API, Descript | **Remotion** (code-driven = agents can programatically compose reels) |
| Public-domain / royalty-free music | Pixabay Music API, YouTube Audio Library, Free Music Archive, Kevin MacLeod | Epidemic Sound, Artlist | **Pixabay + FMA** (free, licenced for TikTok/commercial) |
| AI-generated video (b-roll, motion) | Stable-Video-Diffusion (self-host) | Runway ML, Pika, Sora, Kling | **Runway/Pika** for hero-shots; skip for demo-focused content |
| Speaker/avatar | HeyGen free-tier, D-ID | HeyGen full, Synthesia | Optional — depends on brand-voice decision |
| Auto-caption (TikTok requires) | Whisper.cpp | Descript, CapCut cloud | **Whisper.cpp** (free, on-device) |

**Recommended stack for promotor MVP:**
- `ffmpeg` + `OBS-CLI` for screen-capture pipeline
- `Remotion` for programmatic reel-composition
- `ElevenLabs` API sub for voice-over
- `Whisper.cpp` for auto-captioning
- `Pixabay Music API` for royalty-free background music
- Output: TikTok/YouTube-Shorts-ready 1080×1920, `.mp4`

**Storage:** raw recordings + rendered videos → `W:/code/promotor/renders/` (or S3 bucket if we go there later)

---

## §B — Promotor agent — role spec (to be created)

**Location:** `W:/code/promotor/` (new repo — needs adding to repo-registry + agent-registry)

**Identity:**
- Name: Promotor
- Role: Marketing strategist + video-producer for Conzeon OSS projects
- Persona: Confident growth-hacker, data-driven, taste for viral hooks
- Voice: Casual, no corporate-speak, sharp headlines
- Reports-to: Jesper

**Responsibilities:**
1. Own launch-strategies for each OSS project (Browsergator, Skissify, Mdeye, OctoTerm, DevKit)
2. Author positioning docs + narrative arcs
3. Delegate content-production to hoffbits (blog/social) and vsc (landing pages)
4. Produce videos/reels autonomously (screen-record demos, add voice-over, music, captions)
5. Track launch KPIs, adjust strategy
6. Coordinate cross-project promo (bundle plays, cross-referencing)

**Tools/capabilities:**
- All video-gen stack from §A
- BlabCast for cross-agent coord
- Analytics access (Umami — see recipe)
- Publishing access (via hoffbits for social, vsc for web)

**NOT in scope:**
- Doesn't run production ads (Jespers decision + budget)
- Doesn't manage community/support (separate role later)

---

## Session structure (proposed)

- **Round 1:** Read problem-fit analysis → each attendee shares 2-3 min take
- **Round 2:** Promotor proposes strategy (positioning + channel-mix + timeline)
- **Round 3:** Hoffbits + vsc scope content-workload for their side
- **Round 4:** Video-plan decisions (which demos, how many, tools budget)
- **Output:** Written launch-plan committed to `docs/MARKETING-LAUNCH-PLAN.md` + task-list in Covers per attendee

---

## Deferred/parking-lot

- Managed-gateway paid tier (post-launch feedback)
- Promotor cross-project usage for OctoTerm, Skissify, Mdeye launches
- Community/Discord/support role (needs separate agent)
- Sponsor tier, cross-license bundle (mentioned in orchestrator memory)
