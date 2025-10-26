/*
 * Copyright (c) 2025 William Cruttenden
 * Licensed under the Polyform Noncommercial License 1.0.0.
 * Noncommercial use permitted. Commercial use requires a separate license from the copyright holder.
 * See the LICENSE file for details.
 */

// Inject inject.js into the page context so we can monkey-patch window.fetch/XHR.
(() => {
  const s = document.createElement('script');
  s.src = chrome.runtime.getURL('inject.js');
  s.onload = () => s.remove();
  (document.head || document.documentElement).appendChild(s);
})();

// Listen for metrics snapshots posted from the injected script and persist to storage.
(function () {
  const PENDING = [];
  let flushTimer = null;

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(flush, 750);
  }

  function onMessage(ev) {
    if (ev?.source !== window) return;
    const d = ev?.data;
    if (!d || d.__sora_uv__ !== true || d.type !== 'metrics_batch' || !Array.isArray(d.items)) return;
    for (const it of d.items) PENDING.push(it);
    scheduleFlush();
  }

  async function flush() {
    flushTimer = null;
    if (!PENDING.length) return;
    const items = PENDING.splice(0, PENDING.length);
    try {
      const { metrics = { users: {} } } = await chrome.storage.local.get('metrics');
      for (const snap of items) {
        const userKey = snap.userKey || snap.pageUserKey || 'unknown';
        const userEntry = metrics.users[userKey] || (metrics.users[userKey] = { handle: snap.userHandle || snap.pageUserHandle || null, id: snap.userId || null, posts: {}, followers: [] });
        if (!Array.isArray(userEntry.followers)) userEntry.followers = [];
        if (snap.postId) {
          const post = userEntry.posts[snap.postId] || (userEntry.posts[snap.postId] = { url: snap.url || null, thumb: snap.thumb || null, snapshots: [] });
          if (!post.url && snap.url) post.url = snap.url;
          if (!post.thumb && snap.thumb) post.thumb = snap.thumb;
          if (!post.post_time && snap.created_at) post.post_time = snap.created_at; // Map creation time so dashboard can sort posts

          const s = {
            t: snap.ts || Date.now(),
            uv: snap.uv ?? null,
            likes: snap.likes ?? null,
            views: snap.views ?? null,
            comments: snap.comments ?? null,
            remixes: snap.remixes ?? null,
            shares: snap.shares ?? null,
            downloads: snap.downloads ?? null,
          };
          const last = post.snapshots[post.snapshots.length - 1];
          const same = last && last.uv === s.uv && last.likes === s.likes && last.views === s.views &&
            last.comments === s.comments && last.remixes === s.remixes && last.shares === s.shares && last.downloads === s.downloads;
          if (!same) {
            post.snapshots.push(s);
            if (post.snapshots.length > 300) post.snapshots.splice(0, post.snapshots.length - 300);
          }
          post.lastSeen = Date.now();
        }

        // Capture follower history at the user level when available
        if (snap.followers != null) {
          const fCount = Number(snap.followers);
          if (Number.isFinite(fCount)) {
            const arr = userEntry.followers;
            const t = snap.ts || Date.now();
            const lastF = arr[arr.length - 1];
            if (!lastF || lastF.count !== fCount) {
              arr.push({ t, count: fCount });
              if (arr.length > 500) arr.splice(0, arr.length - 500);
              try { console.debug('[SoraMetrics] followers persisted', { userKey, count: fCount, t }); } catch {}
            }
          }
        }
      }
      await chrome.storage.local.set({ metrics });
    } catch (e) {
      // swallow errors
    }
  }

  window.addEventListener('message', onMessage);
})();
