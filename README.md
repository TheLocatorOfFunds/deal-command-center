# Deal Command Center

Single-file React dashboard for tracking real estate flips and deals.

Currently tracking: **2533 County Road 102, Eureka Springs, AR**

**Live:** https://thelocatoroffunds.github.io/deal-command-center/

## Stack

- React 18 + Babel standalone, loaded from CDN
- No build step — the entire app is in `index.html` inside a `<script type="text/babel">` block
- `localStorage` for persistence (keys namespaced under `flip:2533:*`)

## Tabs

Overview (P&L) · Expenses · Tasks · Vendors · Notes · Activity Log

## Local development

```bash
python3 -m http.server 8000
```

Open http://localhost:8000 and hard-refresh (Cmd+Shift+R) to bypass cache.

## Deploy

```bash
git add index.html
git commit -m "your change"
git push
```

GitHub Pages auto-rebuilds in ~60 seconds.

## Notes for future edits

- If you change the shape of stored data, clear localStorage in DevTools → Application → Local Storage
- Babel standalone is fine at this size but gets slow past ~100KB — consider Vite if the file grows significantly
- Use a feature branch for bigger changes: `git checkout -b feature-name`

## Working with Claude Code

Clone locally, `cd` in, run `claude`. It reads this README automatically.
