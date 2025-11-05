/*
 * Copyright (c) 2025 William Cruttenden
 * Licensed under the Polyform Noncommercial License 1.0.0.
 * Noncommercial use permitted. Commercial use requires a separate license from the copyright holder.
 * See the LICENSE file for details.
 */

// Inject inject.js into the page context so we can monkey-patch window.fetch/XHR.
(() => {
  try { console.log('[SoraUV] content: start, injecting inject.js'); } catch {}
  const s = document.createElement('script');
  s.src = chrome.runtime.getURL('inject.js');
  s.onload = () => { try { console.log('[SoraUV] content: inject.js attached'); } catch {} s.remove(); };
  (document.head || document.documentElement).appendChild(s);
})();

// Listen for metrics snapshots posted from the injected script and persist to storage.
(function () {
  const PENDING = [];
  let flushTimer = null;

  // Debug toggles
  const DEBUG = { storage: true, thumbs: true };
  const dlog = (topic, ...args) => { try { if (DEBUG[topic]) console.log('[SoraUV]', topic, ...args); } catch {} };

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
      dlog('storage', 'flush begin', { count: items.length });
      for (const snap of items) {
        const userKey = snap.userKey || snap.pageUserKey || 'unknown';
        const userEntry = metrics.users[userKey] || (metrics.users[userKey] = { handle: snap.userHandle || snap.pageUserHandle || null, id: snap.userId || null, posts: {}, followers: [] });
        if (!Array.isArray(userEntry.followers)) userEntry.followers = [];
        if (snap.postId) {
          const post = userEntry.posts[snap.postId] || (userEntry.posts[snap.postId] = { url: snap.url || null, thumb: snap.thumb || null, snapshots: [] });
          // Persist owner attribution on the post to allow dashboard integrity checks
          if (!post.ownerKey && (snap.userKey || snap.pageUserKey)) post.ownerKey = snap.userKey || snap.pageUserKey;
          if (!post.ownerHandle && (snap.userHandle || snap.pageUserHandle)) post.ownerHandle = snap.userHandle || snap.pageUserHandle;
          if (!post.ownerId && snap.userId != null) post.ownerId = snap.userId;
          if (!post.url && snap.url) post.url = snap.url;
          // Capture/refresh caption
          if (typeof snap.caption === 'string' && snap.caption) {
            if (!post.caption) post.caption = snap.caption;
            else if (post.caption !== snap.caption) post.caption = snap.caption;
          }
          // Update thumbnail when a better/different one becomes available
          if (snap.thumb) {
            if (!post.thumb) {
              post.thumb = snap.thumb;
              dlog('thumbs', 'thumb set', { postId: snap.postId, thumb: post.thumb });
            } else if (post.thumb !== snap.thumb) {
              dlog('thumbs', 'thumb update', { postId: snap.postId, old: post.thumb, new: snap.thumb });
              post.thumb = snap.thumb;
            } else {
              dlog('thumbs', 'thumb unchanged', { postId: snap.postId, thumb: post.thumb });
            }
          } else {
            dlog('thumbs', 'thumb missing in snap', { postId: snap.postId });
          }
          if (!post.post_time && snap.created_at) post.post_time = snap.created_at; // Map creation time so dashboard can sort posts
          // Relationship fields for deriving direct remix counts across metrics
          if (snap.parent_post_id != null) post.parent_post_id = snap.parent_post_id;
          if (snap.root_post_id != null) post.root_post_id = snap.root_post_id;

          const s = {
            t: snap.ts || Date.now(),
            uv: snap.uv ?? null,
            likes: snap.likes ?? null,
            views: snap.views ?? null,
            comments: snap.comments ?? null,
            // Store direct remixes; map both names for backward/forward compat
            remixes: snap.remix_count ?? snap.remixes ?? null,
            remix_count: snap.remix_count ?? snap.remixes ?? null,
            // shares/downloads removed
          };
          const last = post.snapshots[post.snapshots.length - 1];
          const same = last && last.uv === s.uv && last.likes === s.likes && last.views === s.views &&
            last.comments === s.comments && last.remix_count === s.remix_count;
          if (!same) {
            post.snapshots.push(s);
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
              try { console.debug('[SoraMetrics] followers persisted', { userKey, count: fCount, t }); } catch {}
            }
          }
        }
      }
      await chrome.storage.local.set({ metrics });
      dlog('storage', 'flush end', {});
    } catch (e) {
      // swallow errors
    }
  }

  window.addEventListener('message', onMessage);
})();
