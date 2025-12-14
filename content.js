/*
 * Copyright (c) 2025 Will (fancyson-ai), Topher (cameoed), Skye (thecosmicskye)
 * Licensed under the MIT License. See the LICENSE file for details.
 */

(() => {
  const p = String(location.pathname || '');
  const isDraftDetail = p === '/d' || p.startsWith('/d/');

  function injectPageScript(filename, next) {
    try {
      const s = document.createElement('script');
      s.src = chrome.runtime.getURL(filename);
      s.async = false;
      s.onload = () => {
        try {
          s.remove();
        } catch {}
        try {
          if (typeof next === 'function') next();
        } catch {}
      };
      s.onerror = () => {
        try {
          if (typeof next === 'function') next();
        } catch {}
      };
      (document.head || document.documentElement).appendChild(s);
    } catch {
      try {
        if (typeof next === 'function') next();
      } catch {}
    }
  }

  // Always inject api.js (request/body rewriter + duration dropdown enhancer).
  // Keep inject.js (heavy overlays/metrics) disabled on draft detail pages (/d/...) per performance issues.
  injectPageScript('api.js', () => {
    if (!isDraftDetail) injectPageScript('inject.js');
  });

  if (isDraftDetail) return;

  // Listen for metrics snapshots posted from the injected script and persist to storage.
  (function () {
  const PENDING = [];
  let flushTimer = null;
  let metricsCache = { users: {} }; // in-memory fallback so Analyze still works if storage is unavailable

  // Debug toggles
  const DEBUG = { storage: false, thumbs: false };
  const dlog = (topic, ...args) => { try { if (DEBUG[topic]) console.log('[SoraUV]', topic, ...args); } catch {} };

  const DEFAULT_METRICS = { users: {} };

  function normalizeMetrics(raw) {
    if (!raw || typeof raw !== 'object') return { ...DEFAULT_METRICS };
    const users = raw.users;
    if (!users || typeof users !== 'object' || Array.isArray(users)) return { ...DEFAULT_METRICS };
    return { ...raw, users };
  }

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

  (function(){
    function onMetricsRequest(ev){
      const d = ev?.data;
      if (!d || d.__sora_uv__ !== true || d.type !== 'metrics_request') return;
      const req = d.req;
      (async () => {
        try {
          const { metrics: rawMetrics } = await chrome.storage.local.get('metrics');
          const metrics = normalizeMetrics(rawMetrics) || metricsCache || { users: {} };
          metricsCache = metrics;
          // Reply back into the page
          window.postMessage({ __sora_uv__: true, type: 'metrics_response', req, metrics }, '*');
        } catch {
          // Fall back to in-memory cache if storage is unavailable
          window.postMessage({ __sora_uv__: true, type: 'metrics_response', req, metrics: metricsCache || { users:{} } }, '*');
        }
      })();
    }
    window.addEventListener('message', onMetricsRequest);
  })();

  // Listen for dashboard open requests from inject.js and relay to background
  let dashboardOpenLock = false;
  let dashboardOpenLockTimer = null;
  function openDashboardTab(opts){
    try {
      if (dashboardOpenLock) return;
      dashboardOpenLock = true;
      if (dashboardOpenLockTimer) clearTimeout(dashboardOpenLockTimer);
      dashboardOpenLockTimer = setTimeout(()=>{ dashboardOpenLock = false; }, 1000);
      const payload = {};
      if (opts?.userKey) payload.lastUserKey = opts.userKey;
      if (opts?.userHandle) payload.lastUserHandle = opts.userHandle;
      if (Object.keys(payload).length) chrome.storage.local.set(payload);
      const url = chrome.runtime.getURL('dashboard.html');
      let fallbackTimer = null;
      const openDirect = ()=>{
        if (fallbackTimer) clearTimeout(fallbackTimer);
        fallbackTimer = null;
        try { window.open(url, '_blank'); } catch {}
      };
      try {
        fallbackTimer = setTimeout(openDirect, 800);
        chrome.runtime.sendMessage({ action: 'open_dashboard' }, (resp)=>{
          if (fallbackTimer) clearTimeout(fallbackTimer);
          fallbackTimer = null;
          // If background didn't acknowledge, use direct open as a safety net
          if (chrome.runtime.lastError || !resp || resp.success !== true) {
            openDirect();
          }
        });
      } catch {
        openDirect();
      }
    } catch {
      dashboardOpenLock = false;
    }
  }

  window.addEventListener('message', function(ev) {
    const d = ev?.data;
    if (!d || d.__sora_uv__ !== true || d.type !== 'open_dashboard') return;
    const userKey = d.userKey || (d.userHandle ? `h:${String(d.userHandle).toLowerCase()}` : null);
    openDashboardTab({ userKey, userHandle: d.userHandle });
  });

  // Fallback: also listen directly for clicks on the injected dashboard button in the page DOM.
  const dashboardClickHandler = (ev)=>{
    const btn = ev.target && ev.target.closest && ev.target.closest('.sora-uv-dashboard-btn');
    if (!btn) return;
    ev.preventDefault();
    ev.stopPropagation();
    openDashboardTab({});
  };
  document.addEventListener('click', dashboardClickHandler, true);
  document.addEventListener('pointerup', dashboardClickHandler, true);
  document.addEventListener('touchend', dashboardClickHandler, true);

  let isFlushing = false;
  let needsFlush = false;

  async function flush() {
    flushTimer = null;
    
    // If already flushing, mark that we need another pass and return
    if (isFlushing) {
      needsFlush = true;
      return;
    }
    
    if (!PENDING.length) return;
    
    isFlushing = true;

    try {
      // Check purge lock to prevent overwriting dashboard purge
      try {
        const { purgeLock } = await chrome.storage.local.get('purgeLock');
        if (purgeLock && Date.now() - purgeLock < 30000) { // 30s timeout
           dlog('storage', 'purge locked, retrying', {});
           isFlushing = false;
           scheduleFlush();
           return;
        }
      } catch {}
  
      // Take current items
      const items = PENDING.splice(0, PENDING.length);
      
      try {
        const { metrics: rawMetrics } = await chrome.storage.local.get('metrics');
        const metrics = normalizeMetrics(rawMetrics || metricsCache);
        dlog('storage', 'flush begin', { count: items.length });
        for (const snap of items) {
          const userKey = snap.userKey || snap.pageUserKey || 'unknown';
          const userEntry = metrics.users[userKey] || (metrics.users[userKey] = { handle: snap.userHandle || snap.pageUserHandle || null, id: snap.userId || null, posts: {}, followers: [], cameos: [] });
          if (!userEntry.posts || typeof userEntry.posts !== 'object' || Array.isArray(userEntry.posts)) userEntry.posts = {};
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
            // Capture/refresh cameo_usernames
            if (snap.cameo_usernames != null) {
              if (Array.isArray(snap.cameo_usernames) && snap.cameo_usernames.length > 0) {
                post.cameo_usernames = snap.cameo_usernames;
              } else if (!post.cameo_usernames) {
                // Only set to null/empty if it wasn't already set (preserve existing data)
                post.cameo_usernames = null;
              }
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
            
            // IMPORTANT: Always update duration and dimensions at post level when available
            // This ensures we capture frame count data even if metrics haven't changed
            // (duration doesn't affect snapshot deduplication since we check it separately below)
            if (snap.duration != null) {
              const d = Number(snap.duration);
              if (Number.isFinite(d)) {
                const wasSet = post.duration != null;
                post.duration = d;
                if (DEBUG.storage) {
                  dlog('storage', wasSet ? 'duration updated' : 'duration set', { postId: snap.postId, duration: d });
                }
              }
            }
            if (snap.width != null) {
              const w = Number(snap.width);
              if (Number.isFinite(w)) post.width = w;
            }
            if (snap.height != null) {
              const h = Number(snap.height);
              if (Number.isFinite(h)) post.height = h;
            }
  
            const s = {
              t: snap.ts || Date.now(),
              uv: snap.uv ?? null,
              likes: snap.likes ?? null,
              views: snap.views ?? null,
              comments: snap.comments ?? null,
              // Store direct remixes; map both names for backward/forward compat
              remixes: snap.remix_count ?? snap.remixes ?? null,
              remix_count: snap.remix_count ?? snap.remixes ?? null,
              // Store duration and dimensions (frame count data)
              duration: snap.duration ?? null,
              width: snap.width ?? null,
              height: snap.height ?? null,
              // shares/downloads removed
            };
            
            // Only add a new snapshot if engagement metrics changed (don't create new snapshot just for duration)
            const last = post.snapshots[post.snapshots.length - 1];
            const same = last && last.uv === s.uv && last.likes === s.likes && last.views === s.views &&
              last.comments === s.comments && last.remix_count === s.remix_count;
            
            if (!same) {
              post.snapshots.push(s);
            } else if (last && (last.duration !== s.duration || last.width !== s.width || last.height !== s.height)) {
              // If metrics are the same but duration/dimensions changed, update the last snapshot
              // This handles backfilling duration for existing posts without creating duplicate snapshots
              last.duration = s.duration;
              last.width = s.width;
              last.height = s.height;
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
          // Capture cameo count (profile-level) if available
          if (snap.cameo_count != null) {
            const cCount = Number(snap.cameo_count);
            if (Number.isFinite(cCount)) {
              if (!Array.isArray(userEntry.cameos)) userEntry.cameos = [];
              const arr = userEntry.cameos;
              const t = snap.ts || Date.now();
              const lastC = arr[arr.length - 1];
              if (!lastC || lastC.count !== cCount) {
                arr.push({ t, count: cCount });
                try { console.debug('[SoraMetrics] cameos persisted', { userKey, count: cCount, t }); } catch {}
              }
            }
          }
        }
        try {
          await chrome.storage.local.set({ metrics });
          metricsCache = metrics; // keep a hot copy for quick responses even if storage hiccups
          
          // Debug: Verify duration is in the metrics we just saved
          if (DEBUG.storage) {
            const sampleUser = Object.values(metrics.users || {})[0];
            if (sampleUser && sampleUser.posts) {
              const postsWithDuration = Object.values(sampleUser.posts).filter(p => p.duration != null);
              dlog('storage', 'flush end', { 
                totalPosts: Object.values(metrics.users || {}).reduce((sum, u) => sum + Object.keys(u.posts || {}).length, 0),
                postsWithDuration: postsWithDuration.length 
              });
            } else {
              dlog('storage', 'flush end', {});
            }
          }
        } catch (err) {
          try { console.warn('[SoraMetrics] storage.set failed; enable unlimitedStorage or lower snapshot cap', err); } catch {}
        }
      } catch (e) {
        try { console.warn('[SoraMetrics] flush failed', e); } catch {}
      }
    } finally {
      isFlushing = false;
      if (needsFlush) {
        needsFlush = false;
        scheduleFlush();
      }
    }
  }

    window.addEventListener('message', onMessage);
  })();
})();
