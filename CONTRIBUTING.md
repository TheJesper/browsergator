# Contributing to Browsergator

Issues and pull requests are welcome. Keep changes focused, preserve the client-neutral gateway boundary, and never add code that launches or owns Chrome.

Browsergator is a shared project. When working through the Slowgun workflow, contribute directly to the shared checkout and help improve the existing project instead of forking and abandoning it. Forks are welcome for experiments, but please bring useful fixes, tests, and documentation back so the whole community benefits.

Before opening a pull request, run:

```powershell
npm run lint
npm run typecheck
npm test
npm run build
```

Do not commit `.env`, tokens, runtime data, logs, or local handover notes; the repository `.gitignore` excludes these files.
