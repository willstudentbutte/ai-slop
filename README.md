[![License: Polyform Noncommercial 1.0.0](https://img.shields.io/badge/license-Polyform%20Noncommercial%201.0.0-blue.svg)](./LICENSE)

# Sora Explore - Unique Views + Metrics Dashboard

Shows unique view counts right on Sora Explore, profile grids, and post pages.
Now also displays like rate (likes ÷ unique viewers) alongside the Unique count when available. Hover the badge to see raw likes/views.

Click the extension icon to open a full-page dashboard (new tab) that lets you:
- Type-ahead search to quickly select a user (with clear selection state)
- See a colorized scatter/line chart of Like Rate (Y) vs Unique Viewers (X) over time for each post
- Hover tooltips, per-post colors, and trend lines; click a point to open the post
- Thumbnails and direct links in the post list; select up to two posts to compare
- Export all snapshots for a user as CSV

## Load it in Chrome
- Open `chrome://extensions`, flip on **Developer mode**.
- Hit **Load unpacked** and point it at the `sora-unique-views` folder.
- Pin the icon if you want it handy in the toolbar.

## Use it
- Browse Explore, your profile, or any `/p/s_*` post.
- The extension sniffs feed responses and drops a `Unique: *` badge on each card plus a sticky badge on the post detail view. When likes and unique viewers are present, the badge shows `Unique: <count> • <like-rate%>`. Hover to see `Likes` and `Views`.
- When you view explore feeds or profile feeds, the extension records snapshots for each visible post: `unique`, `likes`, `views`, and a timestamp. These are stored locally in `chrome.storage.local` and power the dashboard.

### Dashboard notes
- X-axis is Unique Viewers; Y-axis is Like Rate (%). As a post reaches a broader audience, points often drift rightwards (more unique) while Y can trend down.
- Select up to 2 posts to compare. Others remain in the background for context.
- Data is stored locally on your machine. Clearing site data or extension storage removes it.
- If you tweak code, just hit the **Reload** button in `chrome://extensions` to see your changes.

## Notes
- Content script injects `inject.js` so it can hook `fetch`/XHR in the page context.
- Runs fully locally-no background worker, no external calls.

## License
This project is licensed under the Polyform Noncommercial License 1.0.0 (see [LICENSE](./LICENSE)).

- ✅ You may use, modify, and share for **noncommercial** purposes.
- 🚫 **Commercial** use requires a separate paid license (see [LICENSE-COMMERCIAL](./LICENSE-COMMERCIAL); contact william@cruttenden.dev).

Contributions are accepted under the DCO (see [CONTRIBUTING.md](./CONTRIBUTING.md)).

