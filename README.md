[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE) [![Add to Chrome](https://img.shields.io/badge/Chrome%20Extension-Add%20Now-blue?logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/sora-explore-unique-views/nijonhldjpdanckbnkjgifghnkekmljk?)

# Sora Explore - Unique Views + Metrics Dashboard

## Features:
- **Post View Counts** - Shows unique view counts right on Sora Explore, profile grids, and post pages.
- **Post Like Rate** - Displays like rate (likes ÷ unique viewers) alongside the Unique count when available.
- **Post Remix Rate** - Click into a post to see Remix Rate as RR!
- **Post Hotness** - All posts with over 25 likes are color coded with a **red to yellow** gradient based on time elapsed since posting to visually signal hotness (planned feature: incorporate engagement rate to better influence color coding and emoji assignment)
- **Super Hot!** - A post with more than 50 likes in under 1 hour will receive a special red glow and extra emojis to indicate a certified banger destined for Top
- **Best Posting Time** - All posts made within 15 minutes +/- of the current time on 1 day increments into the past receive a **green** label, allowing you to infer what engagement you could potentially attain if you were to post right now
- **Gather Mode** - Turn on Gather mode on any profile to auto-scroll and refresh Sora, auto-populating your local dashboard with current data in the background as long as it runs (runs as fast as 1-2 minute or slow as 15-17 minute intervals). Works on Top in a non-abusive fashion! Please see _notes_ section below for a tip on this Mode.
- **Analyze Mode** – Click on Analyze to view the Top feed in a _very powerful_ way, right in your browser!

Plus **DASHBOARD MODE:** Click on the extension icon to open a full-page dashboard in a new tab that lets you...
- Type-ahead search to quickly select a user (with clear selection state)
- See a colorized scatter/line chart of Like Rate (Y) vs Unique Viewers (X) over time for each post
- Hover tooltips, per-post colors, and trend lines; click a point to open the post
- Thumbnails and direct links in the post list; select up to two posts to compare
- Export all snapshots for a user as CSV
- Pair with Gather Mode for always-current data
- ALL DATA STORED 100% LOCALLY IN YOUR BROWSER AND NEVER TRANSMITTED!

---

## Load it in Chrome

Download directly from the [Chrome Web Store ](https://chromewebstore.google.com/detail/sora-explore-unique-views/nijonhldjpdanckbnkjgifghnkekmljk?)

Alternatively:
- Clone repo
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
- **Tip for Gather Mode:** Open a profile in its **own window** with **no other tabs** (can be dragged out of your way) to ensure Chrome does not put the tab to sleep. Further, consider toggling "Auto Discardable" to **X** for this tab by visiting chrome://discards/ to maximize capability.

## License
This project is licensed under the MIT License (see [LICENSE](./LICENSE)).

Contributors:
- Will ([@fancyson-ai](https://github.com/fancyson-ai))
- Topher ([@cameoed](https://github.com/cameoed))
- Skye ([@thecosmicskye](https://github.com/thecosmicskye))

Contributions are accepted under the DCO (see [CONTRIBUTING.md](./CONTRIBUTING.md)).






