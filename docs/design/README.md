# Design sources (week 4)

Files from the Claude Design project "Dexxer X-account визуали" (`claude.ai/design/p/527a6278-…`), pulled on 22.09.2026 through DesignSync. **Status: inspiration, not a spec** — the implementation adapts them to the app's business logic (real fields, states, MVP limits), see `claude-design-prompt.md`.

| File | What it is |
|---|---|
| `Dexxer App.dc.html` | Mobile app screens and components at 390×844, dark only (IBM Plex Sans/Mono, accent `#7A5CFF`). Open locally together with `support.js` (the canvas runtime) |
| `tokens.json` | Colours, type scale, spacing, radii, layout constants — the source for `app/src/theme` |
| `Dexxer X Visuals.dc.html` | Visuals for the X account (a 1600×900 card, banner, avatar) — brand tone, not UI |
| `reference-2026-09-22.png` | A reference screenshot uploaded to the project on 22.09 |
| `claude-design-prompt.md` | A prompt with the screen structure, fields and states for the next design iteration |

Rule: app components read only tokens; no hex value is written directly in components.
