# Contributing to Browsergator

Issues and pull requests are welcome. Keep changes focused, preserve the client-neutral gateway boundary, and never add code that launches or owns Chrome.

Before opening a pull request, run:

```powershell
npm run lint
npm run typecheck
npm test
npm run build
```

Do not commit `.env`, tokens, runtime data, logs, or local handover notes; the repository `.gitignore` excludes these files.
