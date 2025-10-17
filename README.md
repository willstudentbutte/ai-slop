[![License: Polyform Noncommercial 1.0.0](https://img.shields.io/badge/license-Polyform%20Noncommercial%201.0.0-blue.svg)](./LICENSE)

# Sora Explore - Unique Views

Shows unique view counts right on Sora Explore, profile grids, and post pages.

## Load it in Chrome
- Open `chrome://extensions`, flip on **Developer mode**.
- Hit **Load unpacked** and point it at the `sora-unique-views` folder.
- Pin the icon if you want it handy in the toolbar.

## Use it
- Browse Explore, your profile, or any `/p/s_*` post.
- The extension sniffs feed responses and drops a `Unique: *` badge on each card plus a sticky badge on the post detail view.
- If you tweak code, just hit the **Reload** button in `chrome://extensions` to see your changes.

## Notes
- Content script injects `inject.js` so it can hook `fetch`/XHR in the page context.
- Runs fully locally-no background worker, no external calls.

## License
This project is licensed under the Polyform Noncommercial License 1.0.0 (see [LICENSE](./LICENSE)).

- ✅ You may use, modify, and share for **noncommercial** purposes.
- 🚫 **Commercial** use requires a separate paid license (see [LICENSE-COMMERCIAL](./LICENSE-COMMERCIAL); contact william@cruttenden.dev).

Contributions are accepted under the DCO (see [CONTRIBUTING.md](./CONTRIBUTING.md)).

