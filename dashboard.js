/* Dashboard for Sora Metrics */
(function(){
  'use strict';

  const $ = (sel, el=document) => el.querySelector(sel);
  const $$ = (sel, el=document) => Array.from(el.querySelectorAll(sel));
  const TOP_TODAY_KEY = '__top_today__';
  const TOP_TODAY_WINDOW_MS = 24 * 60 * 60 * 1000;
  const TOP_TODAY_MIN_UNIQUE_VIEWS = 100;
  const TOP_TODAY_MIN_LIKES = 15;
  const SITE_ORIGIN = 'https://sora.chatgpt.com';
  const absUrl = (u, pid) => {
    if (!u && pid) return `${SITE_ORIGIN}/p/${pid}`;
    if (!u) return null;
    if (/^https?:\/\//i.test(u)) return u;
    if (u.startsWith('/')) return SITE_ORIGIN + u;
    return SITE_ORIGIN + '/' + u;
  };
  const COLORS = [
    '#7dc4ff','#ff8a7a','#ffd166','#95e06c','#c792ea','#64d3ff','#ffa7c4','#9fd3c7','#f6bd60','#84a59d','#f28482'
  ];
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const ESC_MAP = { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' };
  const esc = (s)=> String(s).replace(/[&<>"']/g, (c)=> ESC_MAP[c] || c);
  
  // Blend two hex colors (50/50 mix)
  function blendColors(color1, color2){
    const hex1 = color1.replace('#', '');
    const hex2 = color2.replace('#', '');
    const r1 = parseInt(hex1.substr(0, 2), 16);
    const g1 = parseInt(hex1.substr(2, 2), 16);
    const b1 = parseInt(hex1.substr(4, 2), 16);
    const r2 = parseInt(hex2.substr(0, 2), 16);
    const g2 = parseInt(hex2.substr(2, 2), 16);
    const b2 = parseInt(hex2.substr(4, 2), 16);
    const r = Math.round((r1 + r2) / 2);
    const g = Math.round((g1 + g2) / 2);
    const b = Math.round((b1 + b2) / 2);
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
  }
  
  // Convert plural to singular
  function singularize(word){
    if (word.endsWith('s') && word.length > 1) {
      return word.slice(0, -1);
    }
    return word;
  }

  // (thumbnails are provided by the collector; no auto-rewrite here)

  function fmt(n){
    if (n == null || !isFinite(n)) return '-';
    if (n >= 1e6) return (n/1e6).toFixed(n%1e6?1:0)+'M';
    if (n >= 1e3) return (n/1e3).toFixed(n%1e3?1:0)+'K';
    return String(n);
  }

  // Fixed-two-decimal formatter with K/M suffixes
  function fmt2(n){
    const v = Number(n);
    if (!isFinite(v)) return '-';
    if (v >= 1e6) return (v/1e6).toFixed(2)+'M';
    if (v >= 1e3) return (v/1e3).toFixed(2)+'K';
    return v.toFixed(2);
  }
  // Fixed-zero-decimal formatter with K/M suffixes
  function fmt0(n){
    const v = Number(n);
    if (!isFinite(v)) return '-';
    if (v >= 1e6) return (v/1e6).toFixed(0)+'M';
    if (v >= 1e3) return (v/1e3).toFixed(0)+'K';
    return Math.round(v).toString();
  }
  // For counts where we want 2 decimals with K/M, but no decimals below 1K
  function fmtK2OrInt(n){
    const v = Number(n);
    if (!isFinite(v)) return '-';
    if (Math.abs(v) >= 1e6) return (v/1e6).toFixed(2)+'M';
    if (Math.abs(v) >= 1e3) return (v/1e3).toFixed(2)+'K';
    return Math.round(v).toString();
  }

  function num(v){ const n = Number(v); return isFinite(n) ? n : 0; }
  function interactionsOfSnap(s){
    if (!s) return 0;
    const likes = num(s.likes);
    const comments = num(s.comments ?? s.reply_count); // non-recursive
    // Exclude remixes, shares, and downloads
    return likes + comments;
  }

  function likeRate(likes, uv){
    const a = Number(likes), b = Number(uv);
    if (!isFinite(a) || !isFinite(b) || b <= 0) return null;
    return (a / b) * 100;
  }
  function interactionRate(snap){
    if (!snap) return null;
    const uv = Number(snap.uv);
    if (!isFinite(uv) || uv <= 0) return null;
    const inter = interactionsOfSnap(snap);
    return (inter / uv) * 100;
  }
  function remixRate(likes, remixes){
    const l = Number(likes);
    const r = Number(remixes);
    if (!isFinite(l) || l <= 0 || !isFinite(r) || r < 0) return null;
    return ((r / l) * 100).toFixed(2);
  }

  // Get latest snapshot by timestamp; fallback to last array entry
  function latestSnapshot(snaps){
    if (!Array.isArray(snaps) || snaps.length === 0) return null;
    let best = null, bestT = -Infinity, sawT = false;
    for (const s of snaps){
      const t = Number(s?.t);
      if (isFinite(t)){
        sawT = true;
        if (t > bestT){ bestT = t; best = s; }
      }
    }
    if (sawT && best) return best;
    return snaps[snaps.length - 1] || null;
  }

  // Find latest available remix count (from whichever field) for a post
  function latestRemixCountForPost(post){
    try {
      const snaps = Array.isArray(post?.snapshots) ? post.snapshots : [];
      for (let i = snaps.length - 1; i >= 0; i--){
        const v = Number(snaps[i]?.remix_count ?? snaps[i]?.remixes);
        if (isFinite(v)) return v;
      }
    } catch {}
    return 0;
  }

  // Timestamp helpers
  function toTs(v){
    if (typeof v === 'number' && isFinite(v)){
      // Normalize seconds to milliseconds if needed
      // Heuristic: timestamps before year ~2001 in ms are < 1e12
      // If it's < 1e11, likely seconds
      const n = v < 1e11 ? v * 1000 : v;
      return n;
    }
    if (typeof v === 'string' && v.trim()){
      const s = v.trim();
      if (/^\d+$/.test(s)){
        const n = Number(s);
        return n < 1e11 ? n*1000 : n;
      }
      const d = Date.parse(s);
      if (!isNaN(d)) return d; // ms
    }
    return 0;
  }
  // Strict post time lookup: only consider explicit post time fields; everything else sorts last
  function getPostTimeStrict(p){
    // Only accept explicit post time; do NOT infer from snapshots in this strict mode
    const candidates = [
      p?.post_time,
      p?.postTime,
      p?.post?.post_time,
      p?.post?.postTime,
      p?.meta?.post_time,
    ];
    for (const c of candidates){
      const t = toTs(c);
      if (t) return t;
    }
    return 0; // unknown -> sort to bottom
  }
  // Loose post time lookup for recency filters: allow snapshot-time fallback
  function getPostTimeForRecency(p){
    const strict = getPostTimeStrict(p);
    if (strict) return strict;
    const snaps = Array.isArray(p?.snapshots) ? p.snapshots : [];
    let best = Infinity;
    for (const s of snaps){
      const t = toTs(s?.t);
      if (t && t < best) best = t;
    }
    return best < Infinity ? best : 0;
  }
  function isTopTodayKey(k){ return k === TOP_TODAY_KEY; }
  function buildTopTodayUser(metrics){
    const now = Date.now();
    const cutoff = now - TOP_TODAY_WINDOW_MS;
    const posts = {};
    for (const [userKey, user] of Object.entries(metrics?.users || {})){
      for (const [pid, p] of Object.entries(user?.posts || {})){
        const t = getPostTimeForRecency(p);
        if (!t || t < cutoff) continue;

        // Threshold filter for "Top Today": require some minimum engagement.
        const last = latestSnapshot(p?.snapshots);
        const uv = num(last?.uv);
        const likes = num(last?.likes);
        if (uv < TOP_TODAY_MIN_UNIQUE_VIEWS) continue;
        if (likes < TOP_TODAY_MIN_LIKES) continue;

        // Prefer the entry with more snapshots if we see duplicates
        const existing = posts[pid];
        if (existing){
          const a = Array.isArray(existing.snapshots) ? existing.snapshots.length : 0;
          const b = Array.isArray(p.snapshots) ? p.snapshots.length : 0;
          if (b <= a) continue;
        }
        // Avoid mutating stored data; ensure ownerHandle is present for labeling.
        const ownerHandle = p?.ownerHandle || user?.handle || (userKey.startsWith('h:') ? userKey.slice(2) : '') || null;
        posts[pid] = ownerHandle && !p?.ownerHandle ? { ...p, ownerHandle } : p;
      }
    }
    return { handle: 'Top Today', id: null, posts, followers: [], cameos: [], __specialKey: TOP_TODAY_KEY };
  }
  function resolveUserForKey(metrics, userKey){
    if (isTopTodayKey(userKey)) return buildTopTodayUser(metrics);
    return metrics?.users?.[userKey] || null;
  }
  const DBG_SORT = false; // hide noisy sorting logs by default

  // Reconcile posts for the selected user:
  // - If a post has an ownerKey different from this user, move it to that owner user bucket.
  // - If ownerKey is missing but ownerId exists, derive key as id:<ownerId> and move there.
  // - If both ownerKey and ownerId are missing, move the post to the 'unknown' user bucket.
  async function pruneMismatchedPostsForUser(metrics, userKey){
    try {
      const user = metrics?.users?.[userKey];
      if (!user || !user.posts) return { moved: [], kept: 0 };
      const moved = [];
      const keep = {};
      const keys = Object.keys(user.posts);
      const total = keys.length;
      // Helpers to compare against this user's canonical identity
      const curHandle = (user.handle || (userKey.startsWith('h:') ? userKey.slice(2) : '') || '').toLowerCase();
      const curId = (user.id || (userKey.startsWith('id:') ? userKey.slice(3) : '') || '').toString();
      for (const pid of keys){
        const p = user.posts[pid];
        const ownerKey = (p && p.ownerKey) ? String(p.ownerKey) : null;
        const ownerId = (p && p.ownerId) ? String(p.ownerId) : null;
        const ownerHandle = (p && p.ownerHandle) ? String(p.ownerHandle).toLowerCase() : null;
        let targetKey = null;
        if (ownerKey && ownerKey !== userKey){
          targetKey = ownerKey;
        } else if (ownerId && curId && ownerId !== curId){
          // Explicit id mismatch → move to owner id bucket
          targetKey = `id:${ownerId}`;
        } else if (ownerHandle && curHandle && ownerHandle !== curHandle){
          // Explicit handle mismatch → move to owner handle bucket
          targetKey = `h:${ownerHandle}`;
        }

        if (targetKey && targetKey !== userKey){
          // Ensure target user bucket exists
          if (!metrics.users[targetKey]){
            const guessedHandle = targetKey.startsWith('h:') ? targetKey.slice(2) : (p.ownerHandle || null);
            const guessedId = targetKey.startsWith('id:') ? targetKey.slice(3) : (p.ownerId || null);
            metrics.users[targetKey] = { handle: guessedHandle, id: guessedId, posts: {}, followers: [] };
          }
          // Optionally normalize the ownerKey on the post
          if (!p.ownerKey && targetKey !== 'unknown') p.ownerKey = targetKey;
          metrics.users[targetKey].posts[pid] = p;
          moved.push({ pid, from: userKey, to: targetKey, ownerKey: ownerKey || null, ownerId: ownerId || null, ownerHandle: p.ownerHandle || null });
          // do not include in keep
        } else {
          // If owner info absent, infer owner as current user instead of moving to unknown
          if (!ownerKey && !ownerId && !p.ownerHandle){
            p.ownerKey = userKey;
            if (!p.ownerHandle && curHandle) p.ownerHandle = curHandle;
            if (!p.ownerId && curId) p.ownerId = curId;
          }
          keep[pid] = p; // stay under current user
        }
      }
      if (moved.length){
        metrics.users[userKey].posts = keep;
        try { console.info('[Dashboard] reconciled posts', { userKey, total, moved: moved.length }); } catch {}
        // Log each moved item for traceability
        try { moved.forEach(it=> console.info('[Dashboard] moved post', it)); } catch {}
        await chrome.storage.local.set({ metrics });
      } else {
        try { console.info('[Dashboard] no mismatched or owner-missing posts found', { userKey, total }); } catch {}
      }
      return { moved, kept: Object.keys(metrics.users[userKey].posts).length };
    } catch (e) {
      try { console.warn('[Dashboard] pruneMismatchedPostsForUser failed', e); } catch {}
      return { moved: [], kept: 0 };
    }
  }

  // Remove posts that are missing data for the selected user.
  // Definition: no snapshots OR every snapshot lacks all known metrics (uv, views, likes, comments, remixes).
  async function pruneEmptyPostsForUser(metrics, userKey){
    try {
      const user = metrics?.users?.[userKey];
      if (!user || !user.posts) return { removed: [] };
      const removed = [];
      const keep = {};
      const keys = Object.keys(user.posts);
      const hasAnyMetric = (s)=>{
        if (!s) return false;
        const fields = ['uv','views','likes','comments','remix_count'];
        for (const k of fields){ if (s[k] != null && isFinite(Number(s[k]))) return true; }
        return false;
      };
      for (const pid of keys){
        const p = user.posts[pid];
        const snaps = Array.isArray(p?.snapshots) ? p.snapshots : [];
        const valid = snaps.length > 0 && snaps.some(hasAnyMetric);
        if (!valid){
          removed.push(pid);
        } else {
          keep[pid] = p;
        }
      }
      if (removed.length){
        metrics.users[userKey].posts = keep;
        try { console.info('[Dashboard] pruned empty posts', { userKey, removedCount: removed.length, removed }); } catch {}
        await chrome.storage.local.set({ metrics });
      }
      return { removed };
    } catch(e){
      try { console.warn('[Dashboard] pruneEmptyPostsForUser failed', e); } catch {}
      return { removed: [] };
    }
  }
  // Try to reclaim posts from the 'unknown' bucket that clearly belong to the selected user.
  async function reclaimFromUnknownForUser(metrics, userKey){
    try {
      const user = metrics?.users?.[userKey];
      const unk = metrics?.users?.unknown;
      if (!user || !unk || !unk.posts) return { moved: 0 };
      const curHandle = (user.handle || (userKey.startsWith('h:') ? userKey.slice(2) : '') || '').toLowerCase();
      const curId = (user.id || (userKey.startsWith('id:') ? userKey.slice(3) : '') || '').toString();
      let moved = 0;
      for (const [pid, p] of Object.entries(unk.posts)){
        const oKey = p.ownerKey ? String(p.ownerKey) : null;
        const oId = p.ownerId ? String(p.ownerId) : null;
        const oHandle = p.ownerHandle ? String(p.ownerHandle).toLowerCase() : null;
        const matchByKey = oKey && oKey === userKey;
        const matchById = oId && curId && oId === curId;
        const matchByHandle = oHandle && curHandle && oHandle === curHandle;
        if (matchByKey || matchById || matchByHandle){
          if (!metrics.users[userKey].posts) metrics.users[userKey].posts = {};
          metrics.users[userKey].posts[pid] = p;
          // Normalize
          if (!p.ownerKey) p.ownerKey = userKey;
          if (!p.ownerHandle && curHandle) p.ownerHandle = curHandle;
          if (!p.ownerId && curId) p.ownerId = curId;
          delete unk.posts[pid];
          moved++;
        }
      }
      if (moved){
        try { console.info('[Dashboard] reclaimed posts from unknown', { userKey, moved }); } catch {}
        await chrome.storage.local.set({ metrics });
      }
      return { moved };
    } catch(e){
      try { console.warn('[Dashboard] reclaimFromUnknown failed', e); } catch {}
      return { moved: 0 };
    }
  }

  // Fallback: derive a comparable numeric from the post ID (assumes hex-like GUID after 's_')
  function pidBigInt(pid){
    try{
      const m = /^s_([0-9a-fA-F]+)/.exec(pid || '');
      if (!m) return 0n;
      return BigInt('0x' + m[1]);
    } catch { return 0n; }
  }

  async function loadMetrics(){
    const { metrics = { users:{} } } = await chrome.storage.local.get('metrics');
    return metrics;
  }



  function buildUserOptions(metrics){
    const sel = $('#userSelect');
    sel.innerHTML = '';

    // "Top Today" virtual option (last 24h across all users)
    {
      const topToday = buildTopTodayUser(metrics);
      const opt = document.createElement('option');
      opt.value = TOP_TODAY_KEY;
      opt.textContent = `${topToday.handle} (${Object.keys(topToday.posts||{}).length})`;
      sel.appendChild(opt);
    }

    let entries = Object.entries(metrics.users);
    // Sort by post count (most to least), pushing 'unknown' to the end
    const users = entries.sort((a,b)=>{
      const ax = a[0]==='unknown' ? 1 : 0;
      const bx = b[0]==='unknown' ? 1 : 0;
      if (ax !== bx) return ax - bx;
      const aCount = Object.keys(a[1].posts||{}).length;
      const bCount = Object.keys(b[1].posts||{}).length;
      if (aCount !== bCount) return bCount - aCount; // Descending order
      // If same post count, sort alphabetically
      const A = (a[1].handle||a[0]||'').toLowerCase();
      const B = (b[1].handle||b[0]||'').toLowerCase();
      return A.localeCompare(B);
    });
    for (const [key, u] of users){
      const opt = document.createElement('option');
      opt.value = key;
      const postCount = Object.keys(u.posts||{}).length;
      opt.textContent = `${u.handle || key} (${postCount})`;
      sel.appendChild(opt);
    }
    return users.length ? users[0][0] : null;
  }

  function filterUsersByQuery(metrics, q){
    const res = [];
    const needle = q.trim().toLowerCase();
    for (const [key, u] of Object.entries(metrics.users)){
      const name = (u.handle || key || '').toLowerCase();
      if (!needle || name.includes(needle)) res.push([key,u]);
    }
    res.sort((a,b)=>{
      const aCount = Object.keys(a[1].posts||{}).length;
      const bCount = Object.keys(b[1].posts||{}).length;
      if (aCount !== bCount) return bCount - aCount; // Descending order
      // If same post count, sort alphabetically
      return (a[1].handle||a[0]||'').localeCompare(b[1].handle||b[0]||'');
    });
    return res;
  }

  // Helper function to build post label with cameo info
  function buildPostLabel(post, userHandle) {
    const cap = (typeof post?.caption === 'string' && post.caption) ? post.caption.trim() : null;
    const cameos = Array.isArray(post?.cameo_usernames) ? post.cameo_usernames.filter(c => typeof c === 'string' && c.trim()) : [];
    const owner = userHandle || post?.ownerHandle || '';
    const captionText = cap || post.id || '';
    
    if (owner && cameos.length > 0) {
      const cameoList = cameos.join(', ');
      return `${owner} cast ${cameoList} - ${captionText}`;
    } else if (owner) {
      return `${owner} - ${captionText}`;
    } else {
      return captionText;
    }
  }

  function truncateForPurgeCaption(text){
    const clean = (typeof text === 'string' ? text.trim() : '') || 'this post';
    if (clean.length <= 100) return clean;
    return clean.slice(0, 100) + '...';
  }

  function buildPostsList(user, colorFor, visibleSet, opts={}){
    const wrap = $('#posts');
    wrap.innerHTML='';
    if (!user) return;
    // Build and sort: known-dated posts first (newest → oldest), undated go to bottom
    const mapped = Object.entries(user.posts||{}).map(([pid,p])=>{
      const last = latestSnapshot(p.snapshots) || {};
      const first = p.snapshots?.[0] || {};
      const rawPT = p?.post_time ?? p?.postTime ?? p?.post?.post_time ?? p?.post?.postTime ?? p?.meta?.post_time ?? null;
      const postTime = getPostTimeStrict(p) || 0;
      const rate = interactionRate(last);
      const bi = pidBigInt(pid);
      const views = num(last?.views);
      const cap = (typeof p?.caption === 'string' && p.caption) ? p.caption.trim() : null;
      const cameos = Array.isArray(p?.cameo_usernames) ? p.cameo_usernames.filter(c => typeof c === 'string' && c.trim()) : [];
      const owner = user?.__specialKey === TOP_TODAY_KEY ? (p?.ownerHandle || '') : (user?.handle || '');
      
      // Build label with cameo info: "owner cameoed cameo1, cameo2 - caption"
      let label, title;
      const captionText = cap || pid;
      if (owner && cameos.length > 0) {
        const cameoList = cameos.join(', ');
        label = `${owner} cast ${cameoList} - ${captionText}`;
        title = label;
      } else if (owner) {
        label = `${owner} - ${captionText}`;
        title = label;
      } else {
        label = captionText;
        title = captionText;
      }
      
      if (DBG_SORT){
        try { console.log(`[Dashboard] sort pid=${pid} raw=${rawPT} norm=${postTime} pidBI=${bi.toString()}`); } catch {}
      }
      return { pid, url: absUrl(p.url, pid), thumb: p.thumb, label, title, last, first, postTime, pidBI: bi, rate, cameos, owner, caption: cap, views };
    });
    // Sort newest first assuming larger post_time is newer
    const withTs = mapped.filter(x=>x.postTime>0).sort((a,b)=>b.postTime - a.postTime);
    const noTs  = mapped.filter(x=>x.postTime<=0).sort((a,b)=>{
      if (a.pidBI === b.pidBI) return a.pid.localeCompare(b.pid);
      return a.pidBI < b.pidBI ? 1 : -1; // descending: bigger id => newer first
    });
    const posts = withTs.concat(noTs);

    // If a list-action filter is active, surface selected posts to top.
    let orderedPosts = posts;
    const activeActionId = opts.activeActionId || null;
    if (activeActionId && visibleSet && visibleSet.size > 0 && visibleSet.size < posts.length) {
      const pidToPost = new Map(posts.map(p=>[p.pid, p]));
      const bottomComparator = (a,b)=>{
        const dv = a.views - b.views;
        if (dv !== 0) return dv;
        const dt = (a.postTime || 0) - (b.postTime || 0);
        if (dt !== 0) return dt;
        if (a.pidBI === b.pidBI) return a.pid.localeCompare(b.pid);
        return a.pidBI < b.pidBI ? -1 : 1;
      };
      const topComparator = (a,b)=>{
        const dv = b.views - a.views;
        if (dv !== 0) return dv;
        const dt = (b.postTime || 0) - (a.postTime || 0);
        if (dt !== 0) return dt;
        if (a.pidBI === b.pidBI) return b.pid.localeCompare(a.pid);
        return a.pidBI < b.pidBI ? 1 : -1;
      };

      let selectedOrdered = [];
      if (activeActionId === 'top5' || activeActionId === 'top10') {
        selectedOrdered = posts.filter(p=>visibleSet.has(p.pid)).slice().sort(topComparator);
      } else if (activeActionId === 'bottom5' || activeActionId === 'bottom10') {
        const now = Date.now();
        const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
        const withAge = posts.map(p=>({ ...p, ageMs: p.postTime ? now - p.postTime : Infinity }));
        const olderThan24h = withAge.filter(x=>x.ageMs > TWENTY_FOUR_HOURS_MS).sort(bottomComparator);
        const allSorted = withAge.slice().sort(bottomComparator);
        for (const it of olderThan24h) {
          if (visibleSet.has(it.pid)) selectedOrdered.push(pidToPost.get(it.pid));
        }
        for (const it of allSorted) {
          if (visibleSet.has(it.pid) && !selectedOrdered.find(p=>p.pid===it.pid)) {
            selectedOrdered.push(pidToPost.get(it.pid));
          }
        }
      } else if (activeActionId === 'stale') {
        const now = Date.now();
        const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
        selectedOrdered = posts
          .filter(p=>visibleSet.has(p.pid))
          .slice()
          .sort((a,b)=>{
            const at = toTs(a.last?.t) || 0;
            const bt = toTs(b.last?.t) || 0;
            const aAge = at ? now - at : Infinity;
            const bAge = bt ? now - bt : Infinity;
            const dAge = bAge - aAge; // most stale first
            if (dAge !== 0) return dAge;
            return bottomComparator(a,b);
          })
          .filter(p=>{
            const t = toTs(p.last?.t) || 0;
            const ageMs = t ? now - t : Infinity;
            return ageMs > TWENTY_FOUR_HOURS_MS;
          });
      } else {
        // last5/last10 or other actions: keep default newest-first order.
        selectedOrdered = posts.filter(p=>visibleSet.has(p.pid));
      }

      const unselected = posts.filter(p=>!visibleSet.has(p.pid));
      orderedPosts = [];
      orderedPosts.push(...selectedOrdered);
      if (selectedOrdered.length && unselected.length) orderedPosts.push({ __separator: true });
      orderedPosts.push(...unselected);
    }

    // Update metric cards (sum of latest values for visible posts)
    try{
      const uniqueViewsEl = $('#uniqueViewsTotal');
      const totalViewsEl = $('#totalViewsTotal');
      const likesEl = $('#likesTotal');
      const repliesEl = $('#repliesTotal');
      const remixesEl = $('#remixesTotal');
      const interEl = $('#interactionsTotal');
      const cameosEl = $('#userCameosTotal');
      const followersEl = $('#userFollowersTotal');
      let totalUniqueViews = 0, totalViews = 0, totalLikes = 0, totalReplies = 0, totalRemixes = 0, totalInteractions = 0;
      const current = visibleSet ? Array.from(visibleSet) : [];
      for (const pid of current){
        const post = user.posts?.[pid];
        const last = latestSnapshot(post?.snapshots);
        totalUniqueViews += num(last?.uv);
        totalViews += num(last?.views);
        totalLikes += num(last?.likes);
        totalReplies += num(last?.comments); // non-recursive
        totalRemixes += num(latestRemixCountForPost(post));
        totalInteractions += interactionsOfSnap(last);
      }
      if (uniqueViewsEl) uniqueViewsEl.textContent = fmt2(totalUniqueViews);
      if (totalViewsEl) totalViewsEl.textContent = fmt2(totalViews);
      if (likesEl) likesEl.textContent = fmt2(totalLikes);
      if (repliesEl) repliesEl.textContent = fmtK2OrInt(totalReplies);
      if (remixesEl) remixesEl.textContent = fmt2(totalRemixes);
      if (interEl) interEl.textContent = fmt2(totalInteractions);
      // Update cameos and followers from user data (not post data)
      if (cameosEl) {
        const cameosArr = Array.isArray(user.cameos) ? user.cameos : [];
        const lastCameo = cameosArr.length > 0 ? cameosArr[cameosArr.length - 1] : null;
        cameosEl.textContent = lastCameo ? fmtK2OrInt(lastCameo.count) : '0';
      }
      if (followersEl) {
        const followersArr = Array.isArray(user.followers) ? user.followers : [];
        const lastFollower = followersArr.length > 0 ? followersArr[followersArr.length - 1] : null;
        followersEl.textContent = lastFollower ? fmtK2OrInt(lastFollower.count) : '0';
      }
    } catch {}

    for (let i=0;i<orderedPosts.length;i++){
      const p = orderedPosts[i];
      if (p && p.__separator) {
        const sep = document.createElement('div');
        sep.className = 'posts-separator';
        wrap.appendChild(sep);
        continue;
      }
      const row = document.createElement('div');
      row.className='post';
      row.dataset.pid = p.pid;
      const color = typeof colorFor === 'function' ? colorFor(p.pid) : COLORS[i % COLORS.length];
      const thumbStyle = p.thumb ? `background-image:url('${p.thumb.replace(/'/g,"%27")}')` : '';
      
      // Create thumb div
      const thumbDiv = document.createElement('div');
      thumbDiv.className = 'thumb';
      thumbDiv.style.cssText = thumbStyle;
      const dotDiv = document.createElement('div');
      dotDiv.className = 'dot';
      dotDiv.style.background = color;
      thumbDiv.appendChild(dotDiv);
      
      // Create meta div
      const metaDiv = document.createElement('div');
      metaDiv.className = 'meta';
      
      // Create id div with link
      const idDiv = document.createElement('div');
      idDiv.className = 'id';
      const link = document.createElement('a');
      link.href = p.url;
      link.target = '_blank';
      link.rel = 'noopener';
      link.title = p.title;
      
      // Build link content with styled spans
      if (p.owner) {
        const ownerSpan = document.createElement('span');
        ownerSpan.textContent = p.owner;
        ownerSpan.style.fontWeight = '800';
        link.appendChild(ownerSpan);
        
        if (p.cameos && p.cameos.length > 0) {
          const cameoWord = document.createElement('span');
          cameoWord.textContent = ' cast ';
          cameoWord.style.fontWeight = '300';
          link.appendChild(cameoWord);
          
          p.cameos.forEach((cameo, idx) => {
            const cameoSpan = document.createElement('span');
            cameoSpan.textContent = cameo;
            cameoSpan.style.fontWeight = '800';
            link.appendChild(cameoSpan);
            
            if (idx < p.cameos.length - 1) {
              const comma = document.createElement('span');
              comma.textContent = ', ';
              comma.style.fontWeight = '300';
              link.appendChild(comma);
            }
          });
        }
        
        const sep = document.createElement('span');
        sep.textContent = ' - ';
        sep.style.fontWeight = '300';
        link.appendChild(sep);
        
        const captionSpan = document.createElement('span');
        captionSpan.textContent = p.caption || p.pid;
        captionSpan.style.fontWeight = '300';
        link.appendChild(captionSpan);
      } else {
        const captionSpan = document.createElement('span');
        captionSpan.textContent = p.caption || p.pid;
        captionSpan.style.fontWeight = '300';
        link.appendChild(captionSpan);
      }
      
      idDiv.appendChild(link);
      
      // Create stats div
      const statsDiv = document.createElement('div');
      statsDiv.className = 'stats';
      statsDiv.textContent = `Unique ${fmt(p.last?.uv)} • Likes ${fmt(p.last?.likes)} • IR ${p.rate==null?'-':p.rate.toFixed(1)+'%'}`;
      
      metaDiv.appendChild(idDiv);
      metaDiv.appendChild(statsDiv);
      
      // Create toggle div
      const toggleDiv = document.createElement('div');
      toggleDiv.className = 'toggle';
      toggleDiv.dataset.pid = p.pid;
      toggleDiv.textContent = 'Hide';

      // Create purge button (shown on hover)
      const purgeBtn = document.createElement('button');
      purgeBtn.type = 'button';
      purgeBtn.className = 'post-purge-btn';
      purgeBtn.title = 'Purge data for this post';
      purgeBtn.textContent = '×';
      purgeBtn.addEventListener('click', (e)=>{
        e.preventDefault();
        e.stopPropagation();
        const snippet = truncateForPurgeCaption(p.caption || p.label || p.pid);
        if (opts.onPurge) opts.onPurge(p.pid, snippet);
      });
      
      row.appendChild(thumbDiv);
      row.appendChild(metaDiv);
      row.appendChild(toggleDiv);
      row.appendChild(purgeBtn);
      
      if (visibleSet && !visibleSet.has(p.pid)) { row.classList.add('hidden'); toggleDiv.textContent = 'Show'; }
      wrap.appendChild(row);
    }
    // Hover interactions to dim non-hovered rows and sync chart highlight
    wrap.addEventListener('mouseover', (e)=>{
      const el = e.target.closest('.post');
      if (!el) return;
      wrap.classList.add('is-hovering');
      $$('.post', wrap).forEach(r=>r.classList.remove('hover'));
      el.classList.add('hover');
      if (opts.onHover) opts.onHover(el.dataset.pid);
    });
    wrap.addEventListener('mouseleave', ()=>{
      wrap.classList.remove('is-hovering');
      $$('.post', wrap).forEach(r=>r.classList.remove('hover'));
      if (opts.onHover) opts.onHover(null);
    });
  }

  function computeTotalsForUser(user){
    const res = { views:0, uniqueViews:0, likes:0, replies:0, remixes:0, interactions:0 };
    if (!user || !user.posts) return res;
    for (const [pid, p] of Object.entries(user.posts)){
      const last = latestSnapshot(p?.snapshots);
      if (!last) continue;
      res.views += num(last?.views);
      res.uniqueViews += num(last?.uv);
      res.likes += num(last?.likes);
      res.replies += num(last?.comments);
      res.remixes += num(latestRemixCountForPost(p));
      res.interactions += interactionsOfSnap(last);
    }
    return res;
  }

  function computeTotalsForUsers(userKeys, metrics){
    const res = { views:0, uniqueViews:0, likes:0, replies:0, remixes:0, interactions:0, cameos:0, followers:0 };
    for (const userKey of userKeys){
      const user = metrics?.users?.[userKey];
      if (!user) continue;
      const userTotals = computeTotalsForUser(user);
      res.views += userTotals.views;
      res.uniqueViews += userTotals.uniqueViews;
      res.likes += userTotals.likes;
      res.replies += userTotals.replies;
      res.remixes += userTotals.remixes;
      res.interactions += userTotals.interactions;
      // Get latest cast in count
      const cameosArr = Array.isArray(user.cameos) ? user.cameos : [];
      if (cameosArr.length > 0){
        const lastCameo = cameosArr[cameosArr.length - 1];
        res.cameos += num(lastCameo?.count);
      }
      // Get latest followers count
      const followersArr = Array.isArray(user.followers) ? user.followers : [];
      if (followersArr.length > 0){
        const lastFollower = followersArr[followersArr.length - 1];
        res.followers += num(lastFollower?.count);
      }
    }
    return res;
  }

  function computeSeriesForUser(user, selectedPIDs, colorFor, useUniqueViews = true){
    const series=[];
    const entries = Object.entries(user.posts||{});
    for (let i=0;i<entries.length;i++){
      const [pid, p] = entries[i];
      const pts = [];
      for (const s of (p.snapshots||[])){
        const r = interactionRate(s);
        const viewValue = useUniqueViews ? s.uv : s.views;
        if (viewValue != null && r != null) pts.push({ x:viewValue, y:r, t:s.t });
      }
      const color = typeof colorFor === 'function' ? colorFor(pid) : COLORS[i % COLORS.length];
      const owner = user?.__specialKey === TOP_TODAY_KEY ? (p?.ownerHandle || '') : (user?.handle || '');
      const label = buildPostLabel({ ...p, id: pid }, owner);
      if (pts.length) series.push({ id: pid, label, color, points: pts, highlighted: selectedPIDs.includes(pid) });
    }
    return series;
  }

  function makeColorMap(user){
    const pids = Object.keys(user.posts||{}).sort();
    const map = new Map();
    pids.forEach((pid, idx)=> map.set(pid, COLORS[idx % COLORS.length]));
    return (pid) => map.get(pid) || COLORS[0];
  }

  function extent(arr, acc){
    let lo= Infinity, hi=-Infinity;
    for (const v of arr){
      const x = acc(v);
      if (x==null || !isFinite(x)) continue;
      if (x<lo) lo=x; if (x>hi) hi=x;
    }
    if (lo===Infinity) lo=0; if (hi===-Infinity) hi=1;
    if (lo===hi){ hi = hi+1; lo = Math.max(0, lo-1); }
    return [lo,hi];
  }

  function makeChart(canvas, xAxisLabel = 'Unique viewers', tooltipLabel = 'Unique'){
    const ctx = canvas.getContext('2d');
    const DPR = Math.max(1, window.devicePixelRatio||1);
    let W = canvas.clientWidth||canvas.width, H = canvas.clientHeight||canvas.height;
    // plot area margins
    const M = { left:50, top:20, right:30, bottom:40 };
    function resize(){
      W = canvas.clientWidth||canvas.width; H = canvas.clientHeight||canvas.height;
      canvas.width = Math.floor(W*DPR); canvas.height = Math.floor(H*DPR); ctx.setTransform(DPR,0,0,DPR,0,0);
      draw();
    }
    const state = { series:[], x:[0,1], y:[0,1], zoomX:null, zoomY:null, hover:null, hoverSeries:null };
    let hoverCb = null;

    function setData(series){
      state.series = series.map(s=>({
        ...s,
        points: [...s.points].sort((a,b)=>a.t-b.t)
      }));
      const xs=[], ys=[];
      for (const s of state.series){
        for (const p of s.points){ xs.push(p.x); ys.push(p.y); }
      }
      state.x = extent(xs, d=>d);
      state.y = extent(ys, d=>d);
      draw();
    }

    function mapX(x){ const [a,b]=(state.zoomX||state.x); return M.left + ( (x-a)/(b-a) ) * (W - (M.left+M.right)); }
    function mapY(y){ const [a,b]=(state.zoomY||state.y); return H - M.bottom - ( (y-a)/(b-a) ) * (H - (M.top+M.bottom)); }
    function clampToPlot(px, py){
      const x = Math.max(M.left, Math.min(W - M.right, px));
      const y = Math.max(M.top, Math.min(H - M.bottom, py));
      return [x,y];
    }

    function grid(){
      ctx.strokeStyle = '#25303b'; ctx.lineWidth=1; ctx.setLineDash([4,4]);
      // verticals (x)
      for (let i=0;i<6;i++){ const x = M.left + i*(W-(M.left+M.right))/5; ctx.beginPath(); ctx.moveTo(x, M.top); ctx.lineTo(x, H - M.bottom); ctx.stroke(); }
      // horizontals (y)
      for (let i=0;i<6;i++){ const y = M.top + i*(H-(M.top+M.bottom))/5; ctx.beginPath(); ctx.moveTo(M.left, y); ctx.lineTo(W - M.right, y); ctx.stroke(); }
      ctx.setLineDash([]);
    }

    function axes(){
      const xDomain = state.zoomX || state.x;
      const yDomain = state.zoomY || state.y;
      ctx.strokeStyle = '#607080'; ctx.lineWidth=1.5; ctx.beginPath(); ctx.moveTo(50,20); ctx.lineTo(50,H-40); ctx.lineTo(W-30,H-40); ctx.stroke();
      ctx.fillStyle = '#a7b0ba'; ctx.font = '12px system-ui, -apple-system, Segoe UI, Roboto, Arial';
      // ticks
      const xticks = 5, yticks=5;
      for (let i=0;i<=xticks;i++){
        const x = M.left + i*(W-(M.left+M.right))/xticks; const v = xDomain[0] + i*(xDomain[1]-xDomain[0])/xticks;
        ctx.fillText(fmt(Math.round(v)), x-10, H - (M.bottom - 18));
      }
      for (let i=0;i<=yticks;i++){
        const y = H - M.bottom - i*(H-(M.top+M.bottom))/yticks; const v = yDomain[0] + i*(yDomain[1]-yDomain[0])/yticks;
        ctx.fillText((Math.round(v*10)/10)+'%', 10, y+4);
      }
      // labels
      ctx.fillStyle = '#e8eaed'; ctx.font = 'bold 13px system-ui, -apple-system, Segoe UI, Roboto, Arial';
      ctx.fillText(xAxisLabel, W/2-50, H-6);
      ctx.save(); ctx.translate(12, H/2+20); ctx.rotate(-Math.PI/2); ctx.fillText('Interaction rate (%)', 0,0); ctx.restore();
    }

    function drawSeries(){
      const muted = '#38424c';
      const anyHover = !!state.hoverSeries;
      for (const s of state.series){
        const color = (anyHover && state.hoverSeries !== s.id) ? muted : s.color;
        // line
        if (s.points.length>1){
          ctx.strokeStyle = color; ctx.lineWidth = s.highlighted ? 2.2 : 1.2; ctx.beginPath();
          for (let i=0;i<s.points.length;i++){
            const p = s.points[i]; const x = mapX(p.x), y = mapY(p.y);
            if (i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
          }
          ctx.stroke();
        }
        // points
        for (const p of s.points){
          const x = mapX(p.x), y = mapY(p.y);
          const isHover = state.hover && state.hover.pid === s.id && state.hover.i === p.t;
          ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x,y, isHover?4.2:2.4, 0, Math.PI*2); ctx.fill();
          if (isHover){ ctx.strokeStyle = '#ffffffaa'; ctx.lineWidth=1; ctx.beginPath(); ctx.arc(x,y, 6, 0, Math.PI*2); ctx.stroke(); }
        }
      }
    }

    function draw(){
      ctx.clearRect(0,0,canvas.width,canvas.height);
      grid(); axes(); drawSeries();
    }

    // hover and click
    const tooltip = $('#tooltip');
    let rafPending = null;
    let lastHover = null;
    
    // Calculate distance from point to line segment
    function pointToLineDistance(px, py, x1, y1, x2, y2) {
      const A = px - x1;
      const B = py - y1;
      const C = x2 - x1;
      const D = y2 - y1;
      const dot = A * C + B * D;
      const lenSq = C * C + D * D;
      let param = -1;
      if (lenSq !== 0) param = dot / lenSq;
      let xx, yy;
      if (param < 0) {
        xx = x1;
        yy = y1;
      } else if (param > 1) {
        xx = x2;
        yy = y2;
      } else {
        xx = x1 + param * C;
        yy = y1 + param * D;
      }
      const dx = px - xx;
      const dy = py - yy;
      return Math.hypot(dx, dy);
    }

    function nearestLine(mx, my) {
      let best = null, bd = Infinity;
      const invMapX = (px) => {
        const [a,b] = (state.zoomX||state.x);
        return a + ((px - M.left)/(W - (M.left+M.right))) * (b-a);
      };
      const mouseX = invMapX(mx);
      for (const s of state.series) {
        if (s.points.length < 2) continue;
        for (let i = 0; i < s.points.length - 1; i++) {
          const p1 = s.points[i];
          const p2 = s.points[i + 1];
          const x1 = mapX(p1.x), y1 = mapY(p1.y);
          const x2 = mapX(p2.x), y2 = mapY(p2.y);
          // Skip if both points are outside plot
          if ((x1 < M.left && x2 < M.left) || (x1 > W - M.right && x2 > W - M.right) ||
              (y1 < M.top && y2 < M.top) || (y1 > H - M.bottom && y2 > H - M.bottom)) continue;
          const d = pointToLineDistance(mx, my, x1, y1, x2, y2);
          if (d < bd && d < 6) {
            bd = d;
            // Interpolate value at mouse x position
            let interpX = mouseX;
            let interpY = null;
            if (mouseX >= Math.min(p1.x, p2.x) && mouseX <= Math.max(p1.x, p2.x)) {
              if (p1.x === p2.x) {
                interpY = p1.y;
              } else {
                const t = (mouseX - p1.x) / (p2.x - p1.x);
                interpY = p1.y + (p2.y - p1.y) * t;
              }
            } else if (mouseX < Math.min(p1.x, p2.x)) {
              interpX = Math.min(p1.x, p2.x);
              interpY = p1.x < p2.x ? p1.y : p2.y;
            } else {
              interpX = Math.max(p1.x, p2.x);
              interpY = p1.x > p2.x ? p1.y : p2.y;
            }
            best = { pid: s.id, label: s.label || s.id, x: interpX, y: interpY, t: interpX, color: s.color, highlighted: s.highlighted, url: s.url, profileUrl: s.profileUrl, isLineHover: true };
          }
        }
      }
      return best;
    }

    function nearest(mx,my){
      let best=null, bd=Infinity;
      for (const s of state.series){
        for (const p of s.points){
          const x = mapX(p.x), y = mapY(p.y);
          // ignore points outside plot
          if (x < M.left || x > W - M.right || y < M.top || y > H - M.bottom) continue;
          const d = Math.hypot(mx-x,my-y);
          if (d<bd && d<16) { bd=d; best = { pid: s.id, label: s.label || s.id, x:p.x, y:p.y, t:p.t, color:s.color, highlighted:s.highlighted, url: s.url, profileUrl: s.profileUrl }; }
        }
      }
      return best;
    }

    function showTooltip(h, clientX, clientY){
      if (!h){ tooltip.style.display='none'; return; }
      tooltip.style.display='block';
      // Truncate label if longer than 150 chars (allow wrapping to multiple lines)
      let labelText = h.label || h.pid || '';
      if (labelText.length > 150) {
        labelText = labelText.substring(0, 150) + '...';
      }
      const header = `<div style="display:flex;align-items:flex-start;gap:6px"><span class="dot" style="background:${h.color};flex-shrink:0;margin-top:2px"></span><strong title="${esc(h.label||h.pid)}" style="word-wrap:break-word;overflow-wrap:break-word">${esc(labelText)}</strong></div>`;
      const body = `<div>${tooltipLabel}: ${fmt(h.x)} • IR: ${h.y.toFixed(1)}%</div>`;
      tooltip.innerHTML = header + body;
      const vw = window.innerWidth || document.documentElement.clientWidth || 0;
      const width = tooltip.offsetWidth || 0;
      let left = clientX + 12;
      if (left + width > vw - 8){
        left = clientX - 12 - width;
        if (left < 8) left = 8;
      }
      tooltip.style.left = left + 'px';
      tooltip.style.top  = (clientY + 12) + 'px';
    }

    function handleMouseMove(e){
      if (rafPending) return;
      rafPending = requestAnimationFrame(()=>{
        rafPending = null;
        const rect = canvas.getBoundingClientRect();
        const mx = (e.clientX - rect.left) * (canvas.width/rect.width) / DPR;
        const my = (e.clientY - rect.top) * (canvas.height/rect.height) / DPR;
        if (drag){ drag.x1 = mx; drag.y1 = my; draw(); drawDragRect(drag); showTooltip(null); return; }
        const h = nearest(mx,my);
        let lineHover = null;
        if (!h) {
          lineHover = nearestLine(mx, my);
        }
        const hoverKey = h ? `${h.pid}-${h.t}` : (lineHover ? `${lineHover.pid}-line` : null);
        const prev = state.hoverSeries;
        state.hover = h || lineHover;
        // If no point hover, check for line hover
        if (!h) {
          state.hoverSeries = lineHover?.pid || null;
        } else {
          state.hoverSeries = h?.pid || null;
        }
        // Clear hoverSeries if not hovering over anything
        if (!h && !lineHover) {
          state.hoverSeries = null;
        }
        // Only skip redraw if both hover key and hoverSeries haven't changed
        if (hoverKey === lastHover && prev === state.hoverSeries) {
          showTooltip(h || lineHover, e.clientX, e.clientY);
          return;
        }
        lastHover = hoverKey;
        if (hoverCb && prev !== state.hoverSeries) hoverCb(state.hoverSeries);
        draw();
        showTooltip(h || lineHover, e.clientX, e.clientY);
      });
    }

    // Zoom drag state
    let drag = null; // {x0,y0,x1,y1}

    canvas.addEventListener('mousemove', handleMouseMove);
    canvas.addEventListener('mouseleave', ()=>{ rafPending = null; lastHover = null; state.hover=null; state.hoverSeries=null; if (hoverCb) hoverCb(null); draw(); showTooltip(null); });
    canvas.addEventListener('click', (e)=>{
      if (state.hover && state.hover.url) {
        window.open(state.hover.url, '_blank');
        return;
      }
      // If no point was clicked, check for line clicks
      const rect = canvas.getBoundingClientRect();
      const mx = (e.clientX - rect.left) * (canvas.width/rect.width) / DPR;
      const my = (e.clientY - rect.top) * (canvas.height/rect.height) / DPR;
      const lineHit = nearestLine(mx, my);
      if (lineHit) {
        const url = lineHit.url || lineHit.profileUrl;
        if (url) window.open(url, '_blank');
      }
    });

    canvas.addEventListener('mousedown', (e)=>{
      const rect = canvas.getBoundingClientRect();
      let x0 = (e.clientX - rect.left) * (canvas.width/rect.width) / DPR;
      let y0 = (e.clientY - rect.top) * (canvas.height/rect.height) / DPR;
      // allow starting outside; we'll clamp on render/mouseup
      drag = { x0, y0, x1: null, y1: null };
    });
    window.addEventListener('mouseup', (e)=>{
      if (!drag) return;
      const rect = canvas.getBoundingClientRect();
      let x1 = (e.clientX - rect.left) * (canvas.width/rect.width) / DPR;
      let y1 = (e.clientY - rect.top) * (canvas.height/rect.height) / DPR;
      // clamp both ends to plot for decision and mapping
      const [cx0, cy0] = clampToPlot(drag.x0, drag.y0);
      const [cx1, cy1] = clampToPlot(x1, y1);
      drag.x1 = cx1; drag.y1 = cy1; // store clamped end for consistent rectangle draw
      const minW = 10, minH = 10;
      const w = Math.abs(cx1 - cx0), h = Math.abs(cy1 - cy0);
      if (w > minW && h > minH){
        // convert to data space
        const [X0,X1] = [cx0, cx1].sort((a,b)=>a-b);
        const [Y0,Y1] = [cy0, cy1].sort((a,b)=>a-b);
        const invMapX = (px)=>{ const [a,b]=(state.zoomX||state.x); return a + ( (px - M.left)/(W - (M.left+M.right)) ) * (b-a); };
        const invMapY = (py)=>{ const [a,b]=(state.zoomY||state.y); return a + ( ( (H - M.bottom) - py)/(H - (M.top+M.bottom)) ) * (b-a); };
        state.zoomX = [invMapX(X0), invMapX(X1)];
        state.zoomY = [invMapY(Y1), invMapY(Y0)];
      }
      drag = null; draw(); showTooltip(null);
    });

    function drawDragRect(d){
      if (!d || d.x1==null || d.y1==null) return;
      ctx.save(); ctx.strokeStyle = '#7dc4ff'; ctx.fillStyle = '#7dc4ff22'; ctx.lineWidth=1; ctx.setLineDash([4,3]);
      // clamp rect to plot area for rendering
      const x0 = Math.max(M.left, Math.min(W - M.right, d.x0));
      const y0 = Math.max(M.top,  Math.min(H - M.bottom, d.y0));
      const x1 = Math.max(M.left, Math.min(W - M.right, d.x1));
      const y1 = Math.max(M.top,  Math.min(H - M.bottom, d.y1));
      const x = Math.min(x0,x1), y = Math.min(y0,y1), w = Math.abs(x1-x0), h = Math.abs(y1-y0);
      ctx.strokeRect(x,y,w,h); ctx.fillRect(x,y,w,h); ctx.restore();
    }

    // Double-click to reset zoom
    canvas.addEventListener('dblclick', ()=>{ state.zoomX=null; state.zoomY=null; draw(); });

    window.addEventListener('resize', resize);
    resize();
    function resetZoom(){ state.zoomX=null; state.zoomY=null; draw(); }
    function setHoverSeries(pid){ state.hoverSeries = pid || null; draw(); }
    function onHover(cb){ hoverCb = cb; }
    function getZoom(){ return { x: state.zoomX ? [...state.zoomX] : null, y: state.zoomY ? [...state.zoomY] : null }; }
    function setZoom(z){ if (!z) return; if (z.x && isFinite(z.x[0]) && isFinite(z.x[1])) state.zoomX = [z.x[0], z.x[1]]; if (z.y && isFinite(z.y[0]) && isFinite(z.y[1])) state.zoomY = [z.y[0], z.y[1]]; draw(); }
    function setAxisLabels(xAxis, tooltip){ xAxisLabel = xAxis; tooltipLabel = tooltip; draw(); }
    return { setData, resetZoom, setHoverSeries, onHover, getZoom, setZoom, setAxisLabels };
  }

function makeTimeChart(canvas, tooltipSelector = '#viewsTooltip', yAxisLabel = 'Views', yFmt = fmt){
    const ctx = canvas.getContext('2d');
    const DPR = Math.max(1, window.devicePixelRatio||1);
    let W = canvas.clientWidth||canvas.width, H = canvas.clientHeight||canvas.height;
    const M = { left:58, top:20, right:30, bottom:40 };
    function resize(){
      W = canvas.clientWidth||canvas.width; H = canvas.clientHeight||canvas.height;
      canvas.width = Math.floor(W*DPR); canvas.height = Math.floor(H*DPR); ctx.setTransform(DPR,0,0,DPR,0,0);
      draw();
    }
    const state = { series:[], x:[0,1], y:[0,1], zoomX:null, zoomY:null, hover:null, hoverSeries:null, comparisonLine:null };
    let hoverCb = null;

    function setData(series){
      state.series = series.map(s=>({
        ...s,
        points: [...s.points].sort((a,b)=>a.t-b.t)
      }));
      const xs=[], ys=[];
      for (const s of state.series){
        for (const p of s.points){ xs.push(p.x); ys.push(p.y); }
      }
      state.x = extent(xs, d=>d);
      state.y = extent(ys, d=>d);
      draw();
    }

    function mapX(x){ const [a,b]=(state.zoomX||state.x); return M.left + ( (x-a)/(b-a||1) ) * (W - (M.left+M.right)); }
    function mapY(y){ const [a,b]=(state.zoomY||state.y); return H - M.bottom - ( (y-a)/(b-a||1) ) * (H - (M.top+M.bottom)); }
    function clampToPlot(px, py){
      const x = Math.max(M.left, Math.min(W - M.right, px));
      const y = Math.max(M.top, Math.min(H - M.bottom, py));
      return [x,y];
    }
    function grid(){
      ctx.strokeStyle = '#25303b'; ctx.lineWidth=1; ctx.setLineDash([4,4]);
      for (let i=0;i<6;i++){ const x = M.left + i*(W-(M.left+M.right))/5; ctx.beginPath(); ctx.moveTo(x, M.top); ctx.lineTo(x, H - M.bottom); ctx.stroke(); }
      for (let i=0;i<6;i++){ const y = M.top + i*(H-(M.top+M.bottom))/5; ctx.beginPath(); ctx.moveTo(M.left, y); ctx.lineTo(W - M.right, y); ctx.stroke(); }
      ctx.setLineDash([]);
    }
    function fmtDate(t){ try { const d=new Date(t); return d.toLocaleDateString(undefined,{month:'short',day:'2-digit'}); } catch { return String(t); } }
    function fmtDateTime(t){
      try {
        const d = new Date(t);
        const ds = d.toLocaleDateString(undefined,{month:'short',day:'2-digit'});
        const ts = d.toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'});
        return ds+" "+ts;
      } catch { return String(t); }
    }
    function axes(){
      const xDomain = state.zoomX || state.x;
      const yDomain = state.zoomY || state.y;
      ctx.strokeStyle = '#607080'; ctx.lineWidth=1.5; ctx.beginPath(); ctx.moveTo(M.left,M.top); ctx.lineTo(M.left,H-M.bottom); ctx.lineTo(W-M.right,H-M.bottom); ctx.stroke();
      ctx.fillStyle = '#a7b0ba'; ctx.font = '12px system-ui, -apple-system, Segoe UI, Roboto, Arial';
      const xticks=5, yticks=5;
      const tickVals = [];
      for (let i=0;i<=xticks;i++) tickVals.push(Math.round(xDomain[0] + i*(xDomain[1]-xDomain[0])/xticks));
      for (let i=0;i<=xticks;i++){
        const x = M.left + i*(W-(M.left+M.right))/xticks; const v = tickVals[i];
        const label = fmtDate(v);
        const off = 24;
        ctx.fillText(label, x-off, H - (M.bottom - 18));
      }
      for (let i=0;i<=yticks;i++){
        const y = H - M.bottom - i*(H-(M.top+M.bottom))/yticks; const v = yDomain[0] + i*(yDomain[1]-yDomain[0])/yticks;
        ctx.fillText(yFmt(v), 10, y+4);
      }
      ctx.fillStyle = '#e8eaed'; ctx.font = 'bold 13px system-ui, -apple-system, Segoe UI, Roboto, Arial';
      ctx.fillText('Time', W/2-20, H-6);
      ctx.save(); ctx.translate(12, H/2+20); ctx.rotate(-Math.PI/2); ctx.fillText(yAxisLabel || 'Views', 0,0); ctx.restore();
    }
    // Interpolate/extrapolate value for a series at a given x (time)
    function getValueAtX(series, x){
      if (!series.points || series.points.length === 0) return null;
      const pts = series.points;
      // Find the two points that bracket x, or use nearest if outside range
      let before = null, after = null;
      for (let i = 0; i < pts.length; i++){
        if (pts[i].x <= x) before = pts[i];
        if (pts[i].x >= x && !after) after = pts[i];
      }
      // If x is before all points, use first point (extrapolate backward)
      if (!before && after) return after.y;
      // If x is after all points, use last point (extrapolate forward)
      if (before && !after) return before.y;
      // If we have both, interpolate
      if (before && after){
        if (before.x === after.x) return before.y;
        const t = (x - before.x) / (after.x - before.x);
        return before.y + (after.y - before.y) * t;
      }
      // Fallback to first point
      return pts[0]?.y ?? null;
    }
    
    // Find two nearest series vertically at mouse x position
    function findNearestTwoSeries(mx, my){
      if (state.series.length < 2) return null;
      const invMapX = (px) => {
        const [a,b] = (state.zoomX||state.x);
        return a + ((px - M.left)/(W - (M.left+M.right))) * (b-a);
      };
      const mouseX = invMapX(mx);
      const candidates = [];
      for (const s of state.series){
        const val = getValueAtX(s, mouseX);
        if (val == null) continue;
        const y = mapY(val);
        if (y < M.top || y > H - M.bottom) continue;
        const dist = Math.abs(my - y);
        candidates.push({ series: s, y, val, dist });
      }
      if (candidates.length < 2) return null;
      candidates.sort((a,b) => a.dist - b.dist);
      return {
        top: candidates[0].y < candidates[1].y ? candidates[0] : candidates[1],
        bottom: candidates[0].y < candidates[1].y ? candidates[1] : candidates[0],
        x: mx,
        mouseX
      };
    }
    
    // Calculate distance from point to line segment
    function pointToLineDistance(px, py, x1, y1, x2, y2) {
      const A = px - x1;
      const B = py - y1;
      const C = x2 - x1;
      const D = y2 - y1;
      const dot = A * C + B * D;
      const lenSq = C * C + D * D;
      let param = -1;
      if (lenSq !== 0) param = dot / lenSq;
      let xx, yy;
      if (param < 0) {
        xx = x1;
        yy = y1;
      } else if (param > 1) {
        xx = x2;
        yy = y2;
      } else {
        xx = x1 + param * C;
        yy = y1 + param * D;
      }
      const dx = px - xx;
      const dy = py - yy;
      return Math.hypot(dx, dy);
    }

    function nearestLine(mx, my) {
      let best = null, bd = Infinity;
      const invMapX = (px) => {
        const [a,b] = (state.zoomX||state.x);
        return a + ((px - M.left)/(W - (M.left+M.right))) * (b-a);
      };
      const mouseX = invMapX(mx);
      for (const s of state.series) {
        if (s.points.length < 2) continue;
        for (let i = 0; i < s.points.length - 1; i++) {
          const p1 = s.points[i];
          const p2 = s.points[i + 1];
          const x1 = mapX(p1.x), y1 = mapY(p1.y);
          const x2 = mapX(p2.x), y2 = mapY(p2.y);
          // Skip if both points are outside plot
          if ((x1 < M.left && x2 < M.left) || (x1 > W - M.right && x2 > W - M.right) ||
              (y1 < M.top && y2 < M.top) || (y1 > H - M.bottom && y2 > H - M.bottom)) continue;
          const d = pointToLineDistance(mx, my, x1, y1, x2, y2);
          if (d < bd && d < 6) {
            bd = d;
            // Interpolate value at mouse x position
            let interpX = mouseX;
            let interpY = null;
            if (mouseX >= Math.min(p1.x, p2.x) && mouseX <= Math.max(p1.x, p2.x)) {
              if (p1.x === p2.x) {
                interpY = p1.y;
              } else {
                const t = (mouseX - p1.x) / (p2.x - p1.x);
                interpY = p1.y + (p2.y - p1.y) * t;
              }
            } else if (mouseX < Math.min(p1.x, p2.x)) {
              interpX = Math.min(p1.x, p2.x);
              interpY = p1.x < p2.x ? p1.y : p2.y;
            } else {
              interpX = Math.max(p1.x, p2.x);
              interpY = p1.x > p2.x ? p1.y : p2.y;
            }
            best = { pid: s.id, label: s.label || s.id, x: interpX, y: interpY, t: interpX, color: s.color, url: s.url, profileUrl: s.profileUrl, isLineHover: true };
          }
        }
      }
      return best;
    }

    function nearest(mx,my){
      let best=null, bd=Infinity;
      for (const s of state.series){
        for (const p of s.points){
          const x = mapX(p.x), y = mapY(p.y);
          if (x < M.left || x > W - M.right || y < M.top || y > H - M.bottom) continue;
          const d = Math.hypot(mx-x,my-y);
          if (d < bd && d < 16){
            bd = d;
            best = { pid: s.id, label: s.label || s.id, x: p.x, y: p.y, t: p.t, color: s.color, url: s.url, profileUrl: s.profileUrl };
          }
        }
      }
      return best;
    }
    const tooltip = $(tooltipSelector);
    let rafPending = null;
    let lastHover = null;
    
    function showTooltip(h, clientX, clientY, comparisonData){
      if (comparisonData){
        const diff = Math.abs(comparisonData.top.val - comparisonData.bottom.val);
        const unit = yAxisLabel || 'Views';
        const unitLower = singularize(unit.toLowerCase());
        const isViewsPerPerson = unit === 'Views Per Person';
        const diffFormatted = isViewsPerPerson ? Number(diff).toFixed(2) : fmt(Math.ceil(diff));
        const topColor = comparisonData.top.series.color || '#7dc4ff';
        const bottomColor = comparisonData.bottom.series.color || '#7dc4ff';
        tooltip.style.display='block';
        tooltip.innerHTML = `<div style="display:flex;align-items:center;gap:8px">
          <div style="position:relative;width:20px;height:20px;">
            <span class="dot" style="position:absolute;left:0;top:0;width:16px;height:16px;background:${topColor};z-index:2;"></span>
            <span class="dot" style="position:absolute;left:8px;top:0;width:16px;height:16px;background:${bottomColor};z-index:1;"></span>
          </div>
          <strong>${diffFormatted} ${unitLower} gap</strong>
        </div>`;
        const vw = window.innerWidth || document.documentElement.clientWidth || 0;
        const width = tooltip.offsetWidth || 0;
        let left = clientX + 12;
        if (left + width > vw - 8){
          left = clientX - 12 - width;
          if (left < 8) left = 8;
        }
        tooltip.style.left = left + 'px';
        tooltip.style.top = (clientY + 12) + 'px';
        return;
      }
      if (!h){ tooltip.style.display='none'; return; }
      tooltip.style.display='block';
      // Check if this is a profile line (has profileUrl)
      if (h.profileUrl) {
        // Extract handle from label (e.g., "@handle's Views" -> "@handle")
        let handle = h.label || h.pid || '';
        handle = handle.replace(/'s (Views|Likes|Cast in|Followers)$/i, '').trim();
        if (!handle.startsWith('@')) handle = '@' + handle;
        const unit = yAxisLabel || 'Views';
        const unitLower = unit.toLowerCase();
        const dateStr = fmtDateTime(h.x);
        // Format number with commas
        const numStr = Math.round(h.y).toLocaleString();
        // Truncate handle if longer than 150 chars (allow wrapping to multiple lines)
        let displayHandle = handle;
        let displayText = `${displayHandle} ${numStr} ${unitLower}`;
        if (displayText.length > 150) {
          displayHandle = displayHandle.length > 150 ? displayHandle.substring(0, 150) + '...' : displayHandle;
          displayText = `${displayHandle} ${numStr} ${unitLower}`;
          if (displayText.length > 150) {
            displayText = displayText.substring(0, 150) + '...';
          }
        }
        tooltip.innerHTML = `<div style="display:flex;align-items:flex-start;gap:6px"><span class="dot" style="background:${h.color};flex-shrink:0;margin-top:2px"></span><strong title="${esc(handle)} ${numStr} ${unitLower}" style="word-wrap:break-word;overflow-wrap:break-word">${esc(displayText)}</strong></div><div style="color:#a7b0ba;font-size:11px;margin-top:2px">on ${dateStr}</div>`;
      } else {
        // Truncate label if longer than 150 chars (allow wrapping to multiple lines)
        let labelText = h.label || h.pid || '';
        if (labelText.length > 150) {
          labelText = labelText.substring(0, 150) + '...';
        }
        const header = `<div style="display:flex;align-items:flex-start;gap:6px"><span class="dot" style="background:${h.color};flex-shrink:0;margin-top:2px"></span><strong title="${esc(h.label||h.pid)}" style="word-wrap:break-word;overflow-wrap:break-word">${esc(labelText)}</strong></div>`;
        const unit = yAxisLabel || 'Views';
        const body = `<div>${fmtDateTime(h.x)} • ${unit}: ${yFmt(h.y)}</div>`;
        tooltip.innerHTML = header + body;
      }
      const vw = window.innerWidth || document.documentElement.clientWidth || 0;
      const width = tooltip.offsetWidth || 0;
      let left = clientX + 12;
      if (left + width > vw - 8){
        left = clientX - 12 - width;
        if (left < 8) left = 8;
      }
      tooltip.style.left = left + 'px';
      tooltip.style.top = (clientY + 12) + 'px';
    }
    
    function handleMouseMove(e){
      if (rafPending) return;
      rafPending = requestAnimationFrame(()=>{
        rafPending = null;
        const rect=canvas.getBoundingClientRect();
        const mx=(e.clientX-rect.left)*(canvas.width/rect.width)/DPR; const my=(e.clientY-rect.top)*(canvas.height/rect.height)/DPR;
        if (drag){ drag.x1=mx; drag.y1=my; draw(); drawDragRect(drag); showTooltip(null); state.comparisonLine=null; return; }
        
        const h = nearest(mx,my);
        let lineHover = null;
        if (!h) {
          lineHover = nearestLine(mx, my);
        }
        const hoverKey = h ? `${h.pid}-${h.t}` : (lineHover ? `${lineHover.pid}-line` : null);
        const prev=state.hoverSeries;
        state.hover=h || lineHover;
        
        // Always check for line hover to update hoverSeries for dimming effect
        if (!h) {
          state.hoverSeries = lineHover?.pid || null;
        } else {
          state.hoverSeries = h?.pid || null;
        }
        // Clear hoverSeries if not hovering over anything
        if (!h && !lineHover) {
          state.hoverSeries = null;
        }
        
        // Check if we're in comparison mode (2+ series) and find nearest two
        // Only show comparison line if NOT hovering over a specific point or line
        const comparison = (!h && !lineHover && state.series.length >= 2) ? findNearestTwoSeries(mx, my) : null;
        if (comparison && mx >= M.left && mx <= W - M.right){
          state.comparisonLine = comparison;
          // Redraw if hoverSeries changed to update dimming
          if (prev !== state.hoverSeries) {
            if (hoverCb) hoverCb(state.hoverSeries);
          }
          draw();
          showTooltip(null, e.clientX, e.clientY, comparison);
          lastHover = hoverKey;
          return;
        }
        
        state.comparisonLine = null;
        // Only skip redraw if both hover key and hoverSeries haven't changed
        if (hoverKey === lastHover && prev === state.hoverSeries) {
          showTooltip(h || lineHover, e.clientX, e.clientY);
          return;
        }
        lastHover = hoverKey;
        if (hoverCb && prev!==state.hoverSeries) hoverCb(state.hoverSeries);
        draw();
        showTooltip(h || lineHover, e.clientX, e.clientY);
      });
    }
    
    let drag=null;
    canvas.addEventListener('mousemove', handleMouseMove);
    canvas.addEventListener('mouseleave', ()=>{ rafPending = null; lastHover = null; state.hover=null; state.hoverSeries=null; state.comparisonLine=null; if (hoverCb) hoverCb(null); draw(); showTooltip(null); });
    // Track recent double-click to avoid opening posts while resetting zoom
    let lastDblClickTs = 0;
    canvas.addEventListener('dblclick', ()=>{ lastDblClickTs = Date.now(); state.zoomX=null; state.zoomY=null; draw(); });
    canvas.addEventListener('click', (e)=>{
      if (Date.now() - lastDblClickTs < 250) return; // ignore clicks immediately after dblclick
      if (state.hover && state.hover.url) {
        window.open(state.hover.url,'_blank');
        return;
      }
      // If no point was clicked, check for line clicks
      const rect = canvas.getBoundingClientRect();
      const mx = (e.clientX - rect.left) * (canvas.width/rect.width) / DPR;
      const my = (e.clientY - rect.top) * (canvas.height/rect.height) / DPR;
      const lineHit = nearestLine(mx, my);
      if (lineHit) {
        const url = lineHit.url || lineHit.profileUrl;
        if (url) window.open(url, '_blank');
      }
    });
    canvas.addEventListener('mousedown',(e)=>{
      const rect=canvas.getBoundingClientRect(); let x0=(e.clientX-rect.left)*(canvas.width/rect.width)/DPR; let y0=(e.clientY-rect.top)*(canvas.height/rect.height)/DPR; drag={x0,y0,x1:null,y1:null};
    });
    window.addEventListener('mouseup',(e)=>{
      if (!drag) return; const rect=canvas.getBoundingClientRect(); let x1=(e.clientX-rect.left)*(canvas.width/rect.width)/DPR; let y1=(e.clientY-rect.top)*(canvas.height/rect.height)/DPR;
      const [cx0,cy0]=clampToPlot(drag.x0,drag.y0); const [cx1,cy1]=clampToPlot(x1,y1);
      drag.x1=cx1; drag.y1=cy1; const minW=10,minH=10; const w=Math.abs(cx1-cx0), h=Math.abs(cy1-cy0);
      if (w>minW && h>minH){ const [X0,X1]=[cx0,cx1].sort((a,b)=>a-b); const [Y0,Y1]=[cy0,cy1].sort((a,b)=>a-b);
        const invMapX=(px)=>{ const [a,b]=(state.zoomX||state.x); return a + ((px-M.left)/(W-(M.left+M.right)))*(b-a); };
        const invMapY=(py)=>{ const [a,b]=(state.zoomY||state.y); return a + (((H-M.bottom)-py)/(H-(M.top+M.bottom)))*(b-a); };
        state.zoomX=[invMapX(X0),invMapX(X1)]; state.zoomY=[invMapY(Y1),invMapY(Y0)]; }
      drag=null; draw(); showTooltip(null);
    });
    function drawDragRect(d){ if (!d||d.x1==null||d.y1==null) return; ctx.save(); ctx.strokeStyle='#7dc4ff'; ctx.fillStyle='#7dc4ff22'; ctx.lineWidth=1; ctx.setLineDash([4,3]);
      const x0=Math.max(M.left,Math.min(W-M.right,d.x0)); const y0=Math.max(M.top,Math.min(H-M.bottom,d.y0)); const x1=Math.max(M.left,Math.min(W-M.right,d.x1)); const y1=Math.max(M.top,Math.min(H-M.bottom,d.y1));
      const x=Math.min(x0,x1), y=Math.min(y0,y1), w=Math.abs(x1-x0), h=Math.abs(y1-y0); ctx.strokeRect(x,y,w,h); ctx.fillRect(x,y,w,h); ctx.restore(); }
    function drawComparisonLine(){
      if (!state.comparisonLine) return;
      const cl = state.comparisonLine;
      const x = Math.max(M.left, Math.min(W - M.right, cl.x));
      const topY = Math.max(M.top, Math.min(H - M.bottom, cl.top.y));
      const bottomY = Math.max(M.top, Math.min(H - M.bottom, cl.bottom.y));
      ctx.save();
      const topColor = cl.top.series.color || '#7dc4ff';
      const bottomColor = cl.bottom.series.color || '#7dc4ff';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([]); // No dash pattern, we'll draw segments manually
      
      // Calculate line length and segment size
      const lineLength = Math.abs(bottomY - topY);
      const dashLength = 4;
      const gapLength = 4;
      const segmentLength = dashLength + gapLength;
      const numSegments = Math.ceil(lineLength / segmentLength);
      
      // Draw alternating colored dashes
      const startY = Math.min(topY, bottomY);
      for (let i = 0; i < numSegments; i++) {
        const yStart = startY + (i * segmentLength);
        const yEnd = Math.min(startY + (i * segmentLength) + dashLength, startY + lineLength);
        
        if (yStart >= startY + lineLength) break;
        
        // Alternate colors: even segments use top color, odd use bottom color
        ctx.strokeStyle = (i % 2 === 0) ? topColor : bottomColor;
        ctx.beginPath();
        ctx.moveTo(x, yStart);
        ctx.lineTo(x, yEnd);
        ctx.stroke();
      }
      ctx.restore();
    }
    
    function drawSeries(){
      const muted='#38424c'; const anyHover=!!state.hoverSeries;
      for (const s of state.series){ const color=(anyHover && state.hoverSeries!==s.id)?muted:s.color; if (s.points.length>1){ ctx.strokeStyle=color; ctx.lineWidth=1.4; ctx.beginPath();
        for (let i=0;i<s.points.length;i++){ const p=s.points[i]; const x=mapX(p.x), y=mapY(p.y); if (i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);} ctx.stroke(); }
        for (const p of s.points){ const x=mapX(p.x), y=mapY(p.y); const isHover=state.hover && state.hover.pid===s.id && state.hover.i===p.t; ctx.fillStyle=color; ctx.beginPath(); ctx.arc(x,y,isHover?4.2:2.4,0,Math.PI*2); ctx.fill(); if (isHover){ ctx.strokeStyle='#ffffffaa'; ctx.lineWidth=1; ctx.beginPath(); ctx.arc(x,y,6,0,Math.PI*2); ctx.stroke(); } }
      }
    }
    function draw(){ ctx.clearRect(0,0,canvas.width,canvas.height); grid(); axes(); drawSeries(); drawComparisonLine(); }
    window.addEventListener('resize', resize); resize();
    function resetZoom(){ state.zoomX=null; state.zoomY=null; draw(); }
    function setHoverSeries(pid){ state.hoverSeries=pid||null; draw(); }
    function onHover(cb){ hoverCb=cb; }
    function getZoom(){ return { x: state.zoomX ? [...state.zoomX] : null, y: state.zoomY ? [...state.zoomY] : null }; }
    function setZoom(z){ if (!z) return; if (z.x && isFinite(z.x[0]) && isFinite(z.x[1])) state.zoomX = [z.x[0], z.x[1]]; if (z.y && isFinite(z.y[0]) && isFinite(z.y[1])) state.zoomY = [z.y[0], z.y[1]]; draw(); }
    function setYAxisLabel(label){ yAxisLabel = label; draw(); }
    return { setData, resetZoom, setHoverSeries, onHover, getZoom, setZoom, setYAxisLabel };
  }

  // First 24 hours views chart (x-axis = minutes since post creation, y-axis = views)
  function makeFirst24HoursChart(canvas, tooltipSelector = '#first24HoursTooltip', yAxisLabel = 'Views', yFmt = fmt){
    const ctx = canvas.getContext('2d');
    const DPR = Math.max(1, window.devicePixelRatio||1);
    let W = canvas.clientWidth||canvas.width, H = canvas.clientHeight||canvas.height;
    const M = { left:58, top:20, right:30, bottom:40 };
    function resize(){
      W = canvas.clientWidth||canvas.width; H = canvas.clientHeight||canvas.height;
      canvas.width = Math.floor(W*DPR); canvas.height = Math.floor(H*DPR); ctx.setTransform(DPR,0,0,DPR,0,0);
      draw();
    }
    const state = { series:[], x:[0,1], y:[0,1], zoomX:null, zoomY:null, hover:null, hoverSeries:null, comparisonLine:null, timeWindowMinutes:1440 };
    let hoverCb = null;

    function setData(series, timeWindowMinutes = 1440){
      state.timeWindowMinutes = timeWindowMinutes;
      // Filter and transform points: x = minutes since post creation, y = views
      state.series = series.map(s=>({
        ...s,
        points: s.points
          .filter(p => {
            if (!s.postTime || !p.t) return false;
            const minutesSinceCreation = (p.t - s.postTime) / (60 * 1000);
            return minutesSinceCreation >= 0 && minutesSinceCreation <= timeWindowMinutes;
          })
          .map(p => {
            const minutesSinceCreation = (p.t - s.postTime) / (60 * 1000);
            return { x: minutesSinceCreation, y: p.y, t: p.t, originalX: p.x };
          })
          .sort((a,b)=>a.x-b.x)
      }));
      const xs=[], ys=[];
      for (const s of state.series){
        for (const p of s.points){ xs.push(p.x); ys.push(p.y); }
      }
      state.x = extent(xs, d=>d);
      state.y = extent(ys, d=>d);
      if (state.x[0] === Infinity) state.x = [0, timeWindowMinutes];
      if (state.y[0] === Infinity) state.y = [0, 1];
      draw();
    }

    function mapX(x){ const [a,b]=(state.zoomX||state.x); return M.left + ( (x-a)/(b-a||1) ) * (W - (M.left+M.right)); }
    function mapY(y){ const [a,b]=(state.zoomY||state.y); return H - M.bottom - ( (y-a)/(b-a||1) ) * (H - (M.top+M.bottom)); }
    function clampToPlot(px, py){
      const x = Math.max(M.left, Math.min(W - M.right, px));
      const y = Math.max(M.top, Math.min(H - M.bottom, py));
      return [x,y];
    }
    function grid(){
      ctx.strokeStyle = '#25303b'; ctx.lineWidth=1; ctx.setLineDash([4,4]);
      for (let i=0;i<6;i++){ const x = M.left + i*(W-(M.left+M.right))/5; ctx.beginPath(); ctx.moveTo(x, M.top); ctx.lineTo(x, H - M.bottom); ctx.stroke(); }
      for (let i=0;i<6;i++){ const y = M.top + i*(H-(M.top+M.bottom))/5; ctx.beginPath(); ctx.moveTo(M.left, y); ctx.lineTo(W - M.right, y); ctx.stroke(); }
      ctx.setLineDash([]);
    }
    function fmtTime(minutes){
      if (minutes < 60) return `${Math.round(minutes)}m`;
      const hours = Math.floor(minutes / 60);
      const mins = Math.round(minutes % 60);
      if (mins === 0) return `${hours}h`;
      return `${hours}h ${mins}m`;
    }
    function axes(){
      const xDomain = state.zoomX || state.x;
      const yDomain = state.zoomY || state.y;
      ctx.strokeStyle = '#607080'; ctx.lineWidth=1.5; ctx.beginPath(); ctx.moveTo(M.left,M.top); ctx.lineTo(M.left,H-M.bottom); ctx.lineTo(W-M.right,H-M.bottom); ctx.stroke();
      ctx.fillStyle = '#a7b0ba'; ctx.font = '12px system-ui, -apple-system, Segoe UI, Roboto, Arial';
      const xticks=5, yticks=5;
      const tickVals = [];
      for (let i=0;i<=xticks;i++) tickVals.push(xDomain[0] + i*(xDomain[1]-xDomain[0])/xticks);
      for (let i=0;i<=xticks;i++){
        const x = M.left + i*(W-(M.left+M.right))/xticks; const v = tickVals[i];
        const label = fmtTime(v);
        const off = label.length * 6;
        ctx.fillText(label, x-off/2, H - (M.bottom - 18));
      }
      for (let i=0;i<=yticks;i++){
        const y = H - M.bottom - i*(H-(M.top+M.bottom))/yticks; const v = yDomain[0] + i*(yDomain[1]-yDomain[0])/yticks;
        ctx.fillText(yFmt(v), 10, y+4);
      }
      ctx.fillStyle = '#e8eaed'; ctx.font = 'bold 13px system-ui, -apple-system, Segoe UI, Roboto, Arial';
      ctx.fillText('Time Since Creation', W/2-60, H-6);
      ctx.save(); ctx.translate(12, H/2+20); ctx.rotate(-Math.PI/2); ctx.fillText(yAxisLabel || 'Unique Views', 0,0); ctx.restore();
    }
    // Interpolate/extrapolate value for a series at a given x (time)
    function getValueAtX(series, x){
      if (!series.points || series.points.length === 0) return null;
      const pts = series.points;
      let before = null, after = null;
      for (let i = 0; i < pts.length; i++){
        if (pts[i].x <= x) before = pts[i];
        if (pts[i].x >= x && !after) after = pts[i];
      }
      if (!before && after) return after.y;
      if (before && !after) return before.y;
      if (before && after){
        if (before.x === after.x) return before.y;
        const t = (x - before.x) / (after.x - before.x);
        return before.y + (after.y - before.y) * t;
      }
      return pts[0]?.y ?? null;
    }
    
    // Find two nearest series vertically at mouse x position
    function findNearestTwoSeries(mx, my){
      if (state.series.length < 2) return null;
      const invMapX = (px) => {
        const [a,b] = (state.zoomX||state.x);
        return a + ((px - M.left)/(W - (M.left+M.right))) * (b-a);
      };
      const mouseX = invMapX(mx);
      const candidates = [];
      for (const s of state.series){
        const val = getValueAtX(s, mouseX);
        if (val == null) continue;
        const y = mapY(val);
        if (y < M.top || y > H - M.bottom) continue;
        const dist = Math.abs(my - y);
        candidates.push({ series: s, y, val, dist });
      }
      if (candidates.length < 2) return null;
      candidates.sort((a,b) => a.dist - b.dist);
      return {
        top: candidates[0].y < candidates[1].y ? candidates[0] : candidates[1],
        bottom: candidates[0].y < candidates[1].y ? candidates[1] : candidates[0],
        x: mx,
        mouseX
      };
    }
    
    // Calculate distance from point to line segment
    function pointToLineDistance(px, py, x1, y1, x2, y2) {
      const A = px - x1;
      const B = py - y1;
      const C = x2 - x1;
      const D = y2 - y1;
      const dot = A * C + B * D;
      const lenSq = C * C + D * D;
      let param = -1;
      if (lenSq !== 0) param = dot / lenSq;
      let xx, yy;
      if (param < 0) {
        xx = x1;
        yy = y1;
      } else if (param > 1) {
        xx = x2;
        yy = y2;
      } else {
        xx = x1 + param * C;
        yy = y1 + param * D;
      }
      const dx = px - xx;
      const dy = py - yy;
      return Math.hypot(dx, dy);
    }

    function nearestLine(mx, my) {
      let best = null, bd = Infinity;
      const invMapX = (px) => {
        const [a,b] = (state.zoomX||state.x);
        return a + ((px - M.left)/(W - (M.left+M.right))) * (b-a);
      };
      const mouseX = invMapX(mx);
      for (const s of state.series) {
        if (s.points.length < 2) continue;
        for (let i = 0; i < s.points.length - 1; i++) {
          const p1 = s.points[i];
          const p2 = s.points[i + 1];
          const x1 = mapX(p1.x), y1 = mapY(p1.y);
          const x2 = mapX(p2.x), y2 = mapY(p2.y);
          if ((x1 < M.left && x2 < M.left) || (x1 > W - M.right && x2 > W - M.right) ||
              (y1 < M.top && y2 < M.top) || (y1 > H - M.bottom && y2 > H - M.bottom)) continue;
          const d = pointToLineDistance(mx, my, x1, y1, x2, y2);
          if (d < bd && d < 6) {
            bd = d;
            let interpX = mouseX;
            let interpY = null;
            if (mouseX >= Math.min(p1.x, p2.x) && mouseX <= Math.max(p1.x, p2.x)) {
              if (p1.x === p2.x) {
                interpY = p1.y;
              } else {
                const t = (mouseX - p1.x) / (p2.x - p1.x);
                interpY = p1.y + (p2.y - p1.y) * t;
              }
            } else if (mouseX < Math.min(p1.x, p2.x)) {
              interpX = Math.min(p1.x, p2.x);
              interpY = p1.x < p2.x ? p1.y : p2.y;
            } else {
              interpX = Math.max(p1.x, p2.x);
              interpY = p1.x > p2.x ? p1.y : p2.y;
            }
            best = { pid: s.id, label: s.label || s.id, x: interpX, y: interpY, t: interpX, color: s.color, url: s.url, profileUrl: s.profileUrl, isLineHover: true, minutesSinceCreation: interpX, originalTime: s.postTime ? s.postTime + interpX * 60 * 1000 : null };
          }
        }
      }
      return best;
    }

    function nearest(mx,my){
      let best=null, bd=Infinity;
      for (const s of state.series){
        for (const p of s.points){
          const x = mapX(p.x), y = mapY(p.y);
          if (x < M.left || x > W - M.right || y < M.top || y > H - M.bottom) continue;
          const d = Math.hypot(mx-x,my-y);
          if (d < bd && d < 16){
            bd = d;
            best = { pid: s.id, label: s.label || s.id, x: p.x, y: p.y, t: p.t, color: s.color, url: s.url, profileUrl: s.profileUrl, minutesSinceCreation: p.x, originalTime: p.t };
          }
        }
      }
      return best;
    }
    const tooltip = $(tooltipSelector);
    let rafPending = null;
    let lastHover = null;
    
    function showTooltip(h, clientX, clientY, comparisonData){
      if (comparisonData){
        const diff = Math.abs(comparisonData.top.val - comparisonData.bottom.val);
        const unit = yAxisLabel || 'Views';
        const unitLower = singularize(unit.toLowerCase());
        const isViewsPerPerson = unit === 'Views Per Person';
        const diffFormatted = isViewsPerPerson ? Number(diff).toFixed(2) : fmt(Math.ceil(diff));
        const topColor = comparisonData.top.series.color || '#7dc4ff';
        const bottomColor = comparisonData.bottom.series.color || '#7dc4ff';
        tooltip.style.display='block';
        tooltip.innerHTML = `<div style="display:flex;align-items:center;gap:8px">
          <div style="position:relative;width:20px;height:20px;">
            <span class="dot" style="position:absolute;left:0;top:0;width:16px;height:16px;background:${topColor};z-index:2;"></span>
            <span class="dot" style="position:absolute;left:8px;top:0;width:16px;height:16px;background:${bottomColor};z-index:1;"></span>
          </div>
          <strong>${diffFormatted} ${unitLower} gap</strong>
        </div>`;
        const vw = window.innerWidth || document.documentElement.clientWidth || 0;
        const width = tooltip.offsetWidth || 0;
        let left = clientX + 12;
        if (left + width > vw - 8){
          left = clientX - 12 - width;
          if (left < 8) left = 8;
        }
        tooltip.style.left = left + 'px';
        tooltip.style.top = (clientY + 12) + 'px';
        return;
      }
      if (!h){ tooltip.style.display='none'; return; }
      tooltip.style.display='block';
      if (h.profileUrl) {
        let handle = h.label || h.pid || '';
        handle = handle.replace(/'s (Views|Likes|Cast in|Followers)$/i, '').trim();
        if (!handle.startsWith('@')) handle = '@' + handle;
        const unit = yAxisLabel || 'Unique Views';
        const unitLower = unit.toLowerCase();
        const timeStr = fmtTime(h.minutesSinceCreation || 0);
        const numStr = Math.round(h.y).toLocaleString();
        // Truncate if longer than 150 chars (allow wrapping to multiple lines)
        let displayText = `${handle} ${numStr} ${unitLower}`;
        if (displayText.length > 150) {
          displayText = displayText.substring(0, 150) + '...';
        }
        tooltip.innerHTML = `<div style="display:flex;align-items:flex-start;gap:6px"><span class="dot" style="background:${h.color};flex-shrink:0;margin-top:2px"></span><strong title="${esc(handle)} ${numStr} ${unitLower}" style="word-wrap:break-word;overflow-wrap:break-word">${esc(displayText)}</strong></div><div style="color:#a7b0ba;font-size:11px;margin-top:2px">${timeStr} after creation</div>`;
      } else {
        // Truncate label if longer than 150 chars (allow wrapping to multiple lines)
        let labelText = h.label || h.pid || '';
        if (labelText.length > 150) {
          labelText = labelText.substring(0, 150) + '...';
        }
        const header = `<div style="display:flex;align-items:flex-start;gap:6px"><span class="dot" style="background:${h.color};flex-shrink:0;margin-top:2px"></span><strong title="${esc(h.label||h.pid)}" style="word-wrap:break-word;overflow-wrap:break-word">${esc(labelText)}</strong></div>`;
        const unit = yAxisLabel || 'Unique Views';
        const timeStr = fmtTime(h.minutesSinceCreation || 0);
        const body = `<div>${timeStr} after creation • ${unit}: ${yFmt(h.y)}</div>`;
        tooltip.innerHTML = header + body;
      }
      const vw = window.innerWidth || document.documentElement.clientWidth || 0;
      const width = tooltip.offsetWidth || 0;
      let left = clientX + 12;
      if (left + width > vw - 8){
        left = clientX - 12 - width;
        if (left < 8) left = 8;
      }
      tooltip.style.left = left + 'px';
      tooltip.style.top = (clientY + 12) + 'px';
    }
    
    function handleMouseMove(e){
      if (rafPending) return;
      rafPending = requestAnimationFrame(()=>{
        rafPending = null;
        const rect=canvas.getBoundingClientRect();
        const mx=(e.clientX-rect.left)*(canvas.width/rect.width)/DPR; const my=(e.clientY-rect.top)*(canvas.height/rect.height)/DPR;
        if (drag){ drag.x1=mx; drag.y1=my; draw(); drawDragRect(drag); showTooltip(null); state.comparisonLine=null; return; }
        
        const h = nearest(mx,my);
        let lineHover = null;
        if (!h) {
          lineHover = nearestLine(mx, my);
        }
        const hoverKey = h ? `${h.pid}-${h.t}` : (lineHover ? `${lineHover.pid}-line` : null);
        const prev=state.hoverSeries;
        state.hover=h || lineHover;
        
        if (!h) {
          state.hoverSeries = lineHover?.pid || null;
        } else {
          state.hoverSeries = h?.pid || null;
        }
        if (!h && !lineHover) {
          state.hoverSeries = null;
        }
        
        const comparison = (!h && !lineHover && state.series.length >= 2) ? findNearestTwoSeries(mx, my) : null;
        if (comparison && mx >= M.left && mx <= W - M.right){
          state.comparisonLine = comparison;
          if (prev !== state.hoverSeries) {
            if (hoverCb) hoverCb(state.hoverSeries);
          }
          draw();
          showTooltip(null, e.clientX, e.clientY, comparison);
          lastHover = hoverKey;
          return;
        }
        
        state.comparisonLine = null;
        if (hoverKey === lastHover && prev === state.hoverSeries) {
          showTooltip(h || lineHover, e.clientX, e.clientY);
          return;
        }
        lastHover = hoverKey;
        if (hoverCb && prev!==state.hoverSeries) hoverCb(state.hoverSeries);
        draw();
        showTooltip(h || lineHover, e.clientX, e.clientY);
      });
    }
    
    let drag=null;
    canvas.addEventListener('mousemove', handleMouseMove);
    canvas.addEventListener('mouseleave', ()=>{ rafPending = null; lastHover = null; state.hover=null; state.hoverSeries=null; state.comparisonLine=null; if (hoverCb) hoverCb(null); draw(); showTooltip(null); });
    let lastDblClickTs = 0;
    canvas.addEventListener('dblclick', ()=>{ lastDblClickTs = Date.now(); state.zoomX=null; state.zoomY=null; draw(); });
    canvas.addEventListener('click', (e)=>{
      if (Date.now() - lastDblClickTs < 250) return;
      if (state.hover && state.hover.url) {
        window.open(state.hover.url,'_blank');
        return;
      }
      const rect = canvas.getBoundingClientRect();
      const mx = (e.clientX - rect.left) * (canvas.width/rect.width) / DPR;
      const my = (e.clientY - rect.top) * (canvas.height/rect.height) / DPR;
      const lineHit = nearestLine(mx, my);
      if (lineHit) {
        const url = lineHit.url || lineHit.profileUrl;
        if (url) window.open(url, '_blank');
      }
    });
    canvas.addEventListener('mousedown',(e)=>{
      const rect=canvas.getBoundingClientRect(); let x0=(e.clientX-rect.left)*(canvas.width/rect.width)/DPR; let y0=(e.clientY-rect.top)*(canvas.height/rect.height)/DPR; drag={x0,y0,x1:null,y1:null};
    });
    window.addEventListener('mouseup',(e)=>{
      if (!drag) return; const rect=canvas.getBoundingClientRect(); let x1=(e.clientX-rect.left)*(canvas.width/rect.width)/DPR; let y1=(e.clientY-rect.top)*(canvas.height/rect.height)/DPR;
      const [cx0,cy0]=clampToPlot(drag.x0,drag.y0); const [cx1,cy1]=clampToPlot(x1,y1);
      drag.x1=cx1; drag.y1=cy1; const minW=10,minH=10; const w=Math.abs(cx1-cx0), h=Math.abs(cy1-cy0);
      if (w>minW && h>minH){ const [X0,X1]=[cx0,cx1].sort((a,b)=>a-b); const [Y0,Y1]=[cy0,cy1].sort((a,b)=>a-b);
        const invMapX=(px)=>{ const [a,b]=(state.zoomX||state.x); return a + ((px-M.left)/(W-(M.left+M.right)))*(b-a); };
        const invMapY=(py)=>{ const [a,b]=(state.zoomY||state.y); return a + (((H-M.bottom)-py)/(H-(M.top+M.bottom)))*(b-a); };
        state.zoomX=[invMapX(X0),invMapX(X1)]; state.zoomY=[invMapY(Y1),invMapY(Y0)]; }
      drag=null; draw(); showTooltip(null);
    });
    function drawDragRect(d){ if (!d||d.x1==null||d.y1==null) return; ctx.save(); ctx.strokeStyle='#7dc4ff'; ctx.fillStyle='#7dc4ff22'; ctx.lineWidth=1; ctx.setLineDash([4,3]);
      const x0=Math.max(M.left,Math.min(W-M.right,d.x0)); const y0=Math.max(M.top,Math.min(H-M.bottom,d.y0)); const x1=Math.max(M.left,Math.min(W-M.right,d.x1)); const y1=Math.max(M.top,Math.min(H-M.bottom,d.y1));
      const x=Math.min(x0,x1), y=Math.min(y0,y1), w=Math.abs(x1-x0), h=Math.abs(y1-y0); ctx.strokeRect(x,y,w,h); ctx.fillRect(x,y,w,h); ctx.restore(); }
    function drawComparisonLine(){
      if (!state.comparisonLine) return;
      const cl = state.comparisonLine;
      const x = Math.max(M.left, Math.min(W - M.right, cl.x));
      const topY = Math.max(M.top, Math.min(H - M.bottom, cl.top.y));
      const bottomY = Math.max(M.top, Math.min(H - M.bottom, cl.bottom.y));
      ctx.save();
      const topColor = cl.top.series.color || '#7dc4ff';
      const bottomColor = cl.bottom.series.color || '#7dc4ff';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([]);
      
      const lineLength = Math.abs(bottomY - topY);
      const dashLength = 4;
      const gapLength = 4;
      const segmentLength = dashLength + gapLength;
      const numSegments = Math.ceil(lineLength / segmentLength);
      
      const startY = Math.min(topY, bottomY);
      for (let i = 0; i < numSegments; i++) {
        const yStart = startY + (i * segmentLength);
        const yEnd = Math.min(startY + (i * segmentLength) + dashLength, startY + lineLength);
        
        if (yStart >= startY + lineLength) break;
        
        ctx.strokeStyle = (i % 2 === 0) ? topColor : bottomColor;
        ctx.beginPath();
        ctx.moveTo(x, yStart);
        ctx.lineTo(x, yEnd);
        ctx.stroke();
      }
      ctx.restore();
    }
    
    function drawSeries(){
      const muted='#38424c'; const anyHover=!!state.hoverSeries;
      for (const s of state.series){ const color=(anyHover && state.hoverSeries!==s.id)?muted:s.color; if (s.points.length>1){ ctx.strokeStyle=color; ctx.lineWidth=1.4; ctx.beginPath();
        for (let i=0;i<s.points.length;i++){ const p=s.points[i]; const x=mapX(p.x), y=mapY(p.y); if (i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);} ctx.stroke(); }
        for (const p of s.points){ const x=mapX(p.x), y=mapY(p.y); const isHover=state.hover && state.hover.pid===s.id && state.hover.i===p.t; ctx.fillStyle=color; ctx.beginPath(); ctx.arc(x,y,isHover?4.2:2.4,0,Math.PI*2); ctx.fill(); if (isHover){ ctx.strokeStyle='#ffffffaa'; ctx.lineWidth=1; ctx.beginPath(); ctx.arc(x,y,6,0,Math.PI*2); ctx.stroke(); } }
      }
    }
    function draw(){ ctx.clearRect(0,0,canvas.width,canvas.height); grid(); axes(); drawSeries(); drawComparisonLine(); }
    window.addEventListener('resize', resize); resize();
    function resetZoom(){ state.zoomX=null; state.zoomY=null; draw(); }
    function setHoverSeries(pid){ state.hoverSeries=pid||null; draw(); }
    function onHover(cb){ hoverCb=cb; }
    function getZoom(){ return { x: state.zoomX ? [...state.zoomX] : null, y: state.zoomY ? [...state.zoomY] : null }; }
    function setZoom(z){ if (!z) return; if (z.x && isFinite(z.x[0]) && isFinite(z.x[1])) state.zoomX = [z.x[0], z.x[1]]; if (z.y && isFinite(z.y[0]) && isFinite(z.y[1])) state.zoomY = [z.y[0], z.y[1]]; draw(); }
    function setYAxisLabel(label){ yAxisLabel = label; draw(); }
    return { setData, resetZoom, setHoverSeries, onHover, getZoom, setZoom, setYAxisLabel };
  }

  // Followers time chart (multi-series, Y-axis = Followers)
  function makeFollowersChart(canvas){
    const ctx = canvas.getContext('2d');
    const DPR = Math.max(1, window.devicePixelRatio||1);
    let W = canvas.clientWidth||canvas.width, H = canvas.clientHeight||canvas.height;
    const M = { left:58, top:20, right:30, bottom:40 };
    function resize(){ W=canvas.clientWidth||canvas.width; H=canvas.clientHeight||canvas.height; canvas.width=Math.floor(W*DPR); canvas.height=Math.floor(H*DPR); ctx.setTransform(DPR,0,0,DPR,0,0); draw(); }
    const state = { series:[], x:[0,1], y:[0,1], zoomX:null, zoomY:null, hover:null, hoverSeries:null, comparisonLine:null };
    let hoverCb = null;
    
    // Interpolate/extrapolate value for a series at a given x (time)
    function getValueAtX(series, x){
      if (!series.points || series.points.length === 0) return null;
      const pts = series.points;
      let before = null, after = null;
      for (let i = 0; i < pts.length; i++){
        if (pts[i].x <= x) before = pts[i];
        if (pts[i].x >= x && !after) after = pts[i];
      }
      if (!before && after) return after.y;
      if (before && !after) return before.y;
      if (before && after){
        if (before.x === after.x) return before.y;
        const t = (x - before.x) / (after.x - before.x);
        return before.y + (after.y - before.y) * t;
      }
      return pts[0]?.y ?? null;
    }
    
    // Find two nearest series vertically at mouse x position
    function findNearestTwoSeries(mx, my){
      if (state.series.length < 2) return null;
      const invMapX = (px) => {
        const [a,b] = (state.zoomX||state.x);
        return a + ((px - M.left)/(W - (M.left+M.right))) * (b-a);
      };
      const mouseX = invMapX(mx);
      const candidates = [];
      for (const s of state.series){
        const val = getValueAtX(s, mouseX);
        if (val == null) continue;
        const y = mapY(val);
        if (y < M.top || y > H - M.bottom) continue;
        const dist = Math.abs(my - y);
        candidates.push({ series: s, y, val, dist });
      }
      if (candidates.length < 2) return null;
      candidates.sort((a,b) => a.dist - b.dist);
      return {
        top: candidates[0].y < candidates[1].y ? candidates[0] : candidates[1],
        bottom: candidates[0].y < candidates[1].y ? candidates[1] : candidates[0],
        x: mx,
        mouseX
      };
    }
    function setData(series){ state.series = series.map(s=>({...s, points: [...s.points].sort((a,b)=>a.t-b.t)})); const xs=[], ys=[]; for (const s of state.series){ for (const p of s.points){ xs.push(p.x); ys.push(p.y); } } state.x=extent(xs,d=>d); state.y=extent(ys,d=>d); draw(); }
    function mapX(x){ const [a,b]=(state.zoomX||state.x); return M.left + ((x-a)/(b-a||1))*(W-(M.left+M.right)); }
    function mapY(y){ const [a,b]=(state.zoomY||state.y); return H - M.bottom - ((y-a)/(b-a||1))*(H-(M.top+M.bottom)); }
    function clampToPlot(px,py){ const x=Math.max(M.left,Math.min(W-M.right,px)); const y=Math.max(M.top,Math.min(H-M.bottom,py)); return [x,y]; }
    function grid(){ ctx.strokeStyle='#25303b'; ctx.lineWidth=1; ctx.setLineDash([4,4]); for (let i=0;i<6;i++){ const x=M.left+i*(W-(M.left+M.right))/5; ctx.beginPath(); ctx.moveTo(x,M.top); ctx.lineTo(x,H-M.bottom); ctx.stroke(); } for (let i=0;i<6;i++){ const y=M.top+i*(H-(M.top+M.bottom))/5; ctx.beginPath(); ctx.moveTo(M.left,y); ctx.lineTo(W-M.right,y); ctx.stroke(); } ctx.setLineDash([]); }
    function fmtDate(t){ try { const d=new Date(t); return d.toLocaleDateString(undefined,{month:'short',day:'2-digit'}); } catch { return String(t); } }
    function fmtDateTime(t){ try { const d=new Date(t); const ds=d.toLocaleDateString(undefined,{month:'short',day:'2-digit'}); const ts=d.toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'}); return ds+" "+ts; } catch { return String(t);} }
    function axes(){
      const xDomain=state.zoomX||state.x; const yDomain=state.zoomY||state.y;
      ctx.strokeStyle='#607080'; ctx.lineWidth=1.5; ctx.beginPath(); ctx.moveTo(M.left,M.top); ctx.lineTo(M.left,H-M.bottom); ctx.lineTo(W-M.right,H-M.bottom); ctx.stroke();
      ctx.fillStyle='#a7b0ba'; ctx.font='12px system-ui, -apple-system, Segoe UI, Roboto, Arial';
      const xticks=5, yticks=5;
      const tickVals=[]; for (let i=0;i<=xticks;i++){ tickVals.push(Math.round(xDomain[0]+i*(xDomain[1]-xDomain[0])/xticks)); }
      for (let i=0;i<=xticks;i++){
        const x=M.left+i*(W-(M.left+M.right))/xticks; const v=tickVals[i]; const label = fmtDate(v); const off = 24; ctx.fillText(label, x-off, H-(M.bottom-18));
      }
      for (let i=0;i<=yticks;i++){ const y=H-M.bottom - i*(H-(M.top+M.bottom))/yticks; const v=yDomain[0]+i*(yDomain[1]-yDomain[0])/yticks; ctx.fillText(fmt2(v), 10, y+4); }
      ctx.fillStyle='#e8eaed'; ctx.font='bold 13px system-ui, -apple-system, Segoe UI, Roboto, Arial'; ctx.fillText('Time', W/2-20, H-6); ctx.save(); ctx.translate(12,H/2+20); ctx.rotate(-Math.PI/2); ctx.fillText('Followers',0,0); ctx.restore();
    }
    function drawComparisonLine(){
      if (!state.comparisonLine) return;
      const cl = state.comparisonLine;
      const x = Math.max(M.left, Math.min(W - M.right, cl.x));
      const topY = Math.max(M.top, Math.min(H - M.bottom, cl.top.y));
      const bottomY = Math.max(M.top, Math.min(H - M.bottom, cl.bottom.y));
      ctx.save();
      const topColor = cl.top.series.color || '#ffd166';
      const bottomColor = cl.bottom.series.color || '#ffd166';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([]); // No dash pattern, we'll draw segments manually
      
      // Calculate line length and segment size
      const lineLength = Math.abs(bottomY - topY);
      const dashLength = 4;
      const gapLength = 4;
      const segmentLength = dashLength + gapLength;
      const numSegments = Math.ceil(lineLength / segmentLength);
      
      // Draw alternating colored dashes
      const startY = Math.min(topY, bottomY);
      for (let i = 0; i < numSegments; i++) {
        const yStart = startY + (i * segmentLength);
        const yEnd = Math.min(startY + (i * segmentLength) + dashLength, startY + lineLength);
        
        if (yStart >= startY + lineLength) break;
        
        // Alternate colors: even segments use top color, odd use bottom color
        ctx.strokeStyle = (i % 2 === 0) ? topColor : bottomColor;
        ctx.beginPath();
        ctx.moveTo(x, yStart);
        ctx.lineTo(x, yEnd);
        ctx.stroke();
      }
      ctx.restore();
    }
    
    function drawSeries(){
      const muted='#38424c'; const anyHover=!!state.hoverSeries;
      for (const s of state.series){
        const color=(anyHover && state.hoverSeries!==s.id)?muted:s.color;
        if (s.points.length>1){
          ctx.strokeStyle=color||'#ffd166'; ctx.lineWidth=1.6; ctx.beginPath();
          for (let i=0;i<s.points.length;i++){
            const p=s.points[i]; const x=mapX(p.x), y=mapY(p.y);
            if (i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
          }
          ctx.stroke();
        }
        for (const p of s.points){
          const x=mapX(p.x), y=mapY(p.y);
          const isHover=state.hover && state.hover.id===s.id && state.hover.t===p.t;
          ctx.fillStyle=color||'#ffd166'; ctx.beginPath(); ctx.arc(x,y,isHover?4.2:2.4,0,Math.PI*2); ctx.fill();
          if (isHover){
            ctx.strokeStyle='#ffffffaa'; ctx.lineWidth=1; ctx.beginPath(); ctx.arc(x,y,6,0,Math.PI*2); ctx.stroke();
          }
        }
      }
    }
    function draw(){ ctx.clearRect(0,0,canvas.width,canvas.height); grid(); axes(); drawSeries(); drawComparisonLine(); }
    const tooltip = $('#followersTooltip');
    let rafPending = null;
    let lastHover = null;
    
    // Calculate distance from point to line segment
    function pointToLineDistance(px, py, x1, y1, x2, y2) {
      const A = px - x1;
      const B = py - y1;
      const C = x2 - x1;
      const D = y2 - y1;
      const dot = A * C + B * D;
      const lenSq = C * C + D * D;
      let param = -1;
      if (lenSq !== 0) param = dot / lenSq;
      let xx, yy;
      if (param < 0) {
        xx = x1;
        yy = y1;
      } else if (param > 1) {
        xx = x2;
        yy = y2;
      } else {
        xx = x1 + param * C;
        yy = y1 + param * D;
      }
      const dx = px - xx;
      const dy = py - yy;
      return Math.hypot(dx, dy);
    }

    function nearestLine(mx, my) {
      let best = null, bd = Infinity;
      const invMapX = (px) => {
        const [a,b] = (state.zoomX||state.x);
        return a + ((px - M.left)/(W - (M.left+M.right))) * (b-a);
      };
      const mouseX = invMapX(mx);
      for (const s of state.series) {
        if (s.points.length < 2) continue;
        for (let i = 0; i < s.points.length - 1; i++) {
          const p1 = s.points[i];
          const p2 = s.points[i + 1];
          const x1 = mapX(p1.x), y1 = mapY(p1.y);
          const x2 = mapX(p2.x), y2 = mapY(p2.y);
          // Skip if both points are outside plot
          if ((x1 < M.left && x2 < M.left) || (x1 > W - M.right && x2 > W - M.right) ||
              (y1 < M.top && y2 < M.top) || (y1 > H - M.bottom && y2 > H - M.bottom)) continue;
          const d = pointToLineDistance(mx, my, x1, y1, x2, y2);
          if (d < bd && d < 6) {
            bd = d;
            // Interpolate value at mouse x position
            let interpX = mouseX;
            let interpY = null;
            if (mouseX >= Math.min(p1.x, p2.x) && mouseX <= Math.max(p1.x, p2.x)) {
              if (p1.x === p2.x) {
                interpY = p1.y;
              } else {
                const t = (mouseX - p1.x) / (p2.x - p1.x);
                interpY = p1.y + (p2.y - p1.y) * t;
              }
            } else if (mouseX < Math.min(p1.x, p2.x)) {
              interpX = Math.min(p1.x, p2.x);
              interpY = p1.x < p2.x ? p1.y : p2.y;
            } else {
              interpX = Math.max(p1.x, p2.x);
              interpY = p1.x > p2.x ? p1.y : p2.y;
            }
            best = { id: s.id, label: s.label || s.id, x: interpX, y: interpY, t: interpX, color: s.color, url: s.url, profileUrl: s.profileUrl, isLineHover: true };
          }
        }
      }
      return best;
    }

    function nearest(mx,my){
      let best=null,bd=Infinity;
      for (const s of state.series){
        for (const p of s.points){
          const x=mapX(p.x), y=mapY(p.y);
          if (x<M.left||x>W-M.right||y<M.top||y>H-M.bottom) continue;
          const d=Math.hypot(mx-x,my-y);
          if (d<bd && d<16){
            bd=d;
            best={ id:s.id, label:s.label||s.id, x:p.x, y:p.y, t:p.t, color:s.color, url: s.url, profileUrl: s.profileUrl };
          }
        }
      }
      return best;
    }
    function showTooltip(h,cx,cy,comparisonData){
      if (comparisonData){
        const diff = Math.abs(comparisonData.top.val - comparisonData.bottom.val);
        const diffRounded = Math.ceil(diff);
        const topColor = comparisonData.top.series.color || '#ffd166';
        const bottomColor = comparisonData.bottom.series.color || '#ffd166';
        tooltip.style.display='block';
        tooltip.innerHTML = `<div style="display:flex;align-items:center;gap:8px">
          <div style="position:relative;width:20px;height:20px;">
            <span class="dot" style="position:absolute;left:0;top:0;width:16px;height:16px;background:${topColor};z-index:2;"></span>
            <span class="dot" style="position:absolute;left:8px;top:0;width:16px;height:16px;background:${bottomColor};z-index:1;"></span>
          </div>
          <strong>${fmt(diffRounded)} follower gap</strong>
        </div>`;
        const vw = window.innerWidth || document.documentElement.clientWidth || 0;
        const width = tooltip.offsetWidth || 0;
        let left = cx + 12;
        if (left + width > vw - 8){
          left = cx - 12 - width;
          if (left < 8) left = 8;
        }
        tooltip.style.left = left + 'px';
        tooltip.style.top = (cy + 12) + 'px';
        return;
      }
      if (!h){ tooltip.style.display='none'; return; }
      tooltip.style.display='block';
      // Check if this is a profile line (has profileUrl)
      if (h.profileUrl) {
        // Extract handle from label (e.g., "@handle's Followers" -> "@handle")
        let handle = h.label || h.id || '';
        handle = handle.replace(/'s Followers$/i, '').trim();
        if (!handle.startsWith('@')) handle = '@' + handle;
        const dateStr = fmtDateTime(h.x);
        // Format number with commas
        const numStr = Math.round(h.y).toLocaleString();
        tooltip.innerHTML = `<div style="display:flex;align-items:center;gap:6px"><span class="dot" style="background:${h.color||'#ffd166'}"></span><strong>${esc(handle)} ${numStr} followers</strong></div><div style="color:#a7b0ba;font-size:11px;margin-top:2px">on ${dateStr}</div>`;
      } else {
        const header = `<div style="display:flex;align-items:center;gap:6px"><span class="dot" style="background:${h.color||'#ffd166'}"></span><strong>${esc(h.label||'Followers')}</strong></div>`;
        const body = `<div>${fmtDateTime(h.x)} • Followers: ${fmt2(h.y)}</div>`;
        tooltip.innerHTML = header + body;
      }
      const vw = window.innerWidth || document.documentElement.clientWidth || 0;
      const width = tooltip.offsetWidth || 0;
      let left = cx + 12;
      if (left + width > vw - 8){
        left = cx - 12 - width;
        if (left < 8) left = 8;
      }
      tooltip.style.left = left + 'px';
      tooltip.style.top = (cy + 12) + 'px';
    }
    
    function handleMouseMove(e){
      if (rafPending) return;
      rafPending = requestAnimationFrame(()=>{
        rafPending = null;
        const rect=canvas.getBoundingClientRect();
        const mx=(e.clientX-rect.left)*(canvas.width/rect.width)/DPR; const my=(e.clientY-rect.top)*(canvas.height/rect.height)/DPR;
        if (drag){ drag.x1=mx; drag.y1=my; draw(); drawDragRect(drag); showTooltip(null); state.comparisonLine=null; return; }
        
        const h=nearest(mx,my);
        let lineHover = null;
        if (!h) {
          lineHover = nearestLine(mx, my);
        }
        const hoverKey = h ? `${h.id}-${h.t}` : (lineHover ? `${lineHover.id}-line` : null);
        const prev=state.hoverSeries;
        state.hover=h || lineHover;
        
        // Always check for line hover to update hoverSeries for dimming effect
        if (!h) {
          state.hoverSeries = lineHover?.id || null;
        } else {
          state.hoverSeries = h?.id || null;
        }
        // Clear hoverSeries if not hovering over anything
        if (!h && !lineHover) {
          state.hoverSeries = null;
        }
        
        // Check if we're in comparison mode (2+ series) and find nearest two
        // Only show comparison line if NOT hovering over a specific point or line
        const comparison = (!h && !lineHover && state.series.length >= 2) ? findNearestTwoSeries(mx, my) : null;
        if (comparison && mx >= M.left && mx <= W - M.right){
          state.comparisonLine = comparison;
          // Redraw if hoverSeries changed to update dimming
          if (prev !== state.hoverSeries) {
            if (hoverCb) hoverCb(state.hoverSeries);
          }
          draw();
          showTooltip(null, e.clientX, e.clientY, comparison);
          lastHover = hoverKey;
          return;
        }
        
        state.comparisonLine = null;
        // Only skip redraw if both hover key and hoverSeries haven't changed
        if (hoverKey === lastHover && prev === state.hoverSeries) {
          showTooltip(h || lineHover, e.clientX, e.clientY);
          return;
        }
        lastHover = hoverKey;
        if (hoverCb && prev!==state.hoverSeries) hoverCb(state.hoverSeries);
        draw();
        showTooltip(h || lineHover, e.clientX, e.clientY);
      });
    }
    
    let drag=null;
    canvas.addEventListener('mousemove', handleMouseMove);
    canvas.addEventListener('mouseleave', ()=>{ rafPending = null; lastHover = null; state.hover=null; state.hoverSeries=null; state.comparisonLine=null; if (hoverCb) hoverCb(null); draw(); showTooltip(null); });
    canvas.addEventListener('mousedown',(e)=>{ const rect=canvas.getBoundingClientRect(); let x0=(e.clientX-rect.left)*(canvas.width/rect.width)/DPR; let y0=(e.clientY-rect.top)*(canvas.height/rect.height)/DPR; drag={x0,y0,x1:null,y1:null}; });
    window.addEventListener('mouseup',(e)=>{ if (!drag) return; const rect=canvas.getBoundingClientRect(); let x1=(e.clientX-rect.left)*(canvas.width/rect.width)/DPR; let y1=(e.clientY-rect.top)*(canvas.height/rect.height)/DPR; const [cx0,cy0]=clampToPlot(drag.x0,drag.y0); const [cx1,cy1]=clampToPlot(x1,y1); drag.x1=cx1; drag.y1=cy1; const minW=10,minH=10; const w=Math.abs(cx1-cx0), h=Math.abs(cy1-cy0); if (w>minW && h>minH){ const [X0,X1]=[cx0,cx1].sort((a,b)=>a-b); const [Y0,Y1]=[cy0,cy1].sort((a,b)=>a-b); const invMapX=(px)=>{ const [a,b]=(state.zoomX||state.x); return a + ((px-M.left)/(W-(M.left+M.right)))*(b-a); }; const invMapY=(py)=>{ const [a,b]=(state.zoomY||state.y); return a + (((H-M.bottom)-py)/(H-(M.top+M.bottom)))*(b-a); }; state.zoomX=[invMapX(X0),invMapX(X1)]; state.zoomY=[invMapY(Y1),invMapY(Y0)]; } drag=null; draw(); showTooltip(null); });
    function drawDragRect(d){ if (!d||d.x1==null||d.y1==null) return; ctx.save(); ctx.strokeStyle='#7dc4ff'; ctx.fillStyle='#7dc4ff22'; ctx.lineWidth=1; ctx.setLineDash([4,3]); const x0=Math.max(M.left,Math.min(W-M.right,d.x0)); const y0=Math.max(M.top,Math.min(H-M.bottom,d.y0)); const x1=Math.max(M.left,Math.min(W-M.right,d.x1)); const y1=Math.max(M.top,Math.min(H-M.bottom,d.y1)); const x=Math.min(x0,x1), y=Math.min(y0,y1), w=Math.abs(x1-x0), h=Math.abs(y1-y0); ctx.strokeRect(x,y,w,h); ctx.fillRect(x,y,w,h); ctx.restore(); }
    canvas.addEventListener('dblclick', ()=>{ state.zoomX=null; state.zoomY=null; draw(); });
    canvas.addEventListener('click', (e)=>{
      if (state.hover && state.hover.url) {
        window.open(state.hover.url, '_blank');
        return;
      }
      if (state.hover && state.hover.profileUrl) {
        window.open(state.hover.profileUrl, '_blank');
        return;
      }
      // If no point was clicked, check for line clicks
      const rect = canvas.getBoundingClientRect();
      const mx = (e.clientX - rect.left) * (canvas.width/rect.width) / DPR;
      const my = (e.clientY - rect.top) * (canvas.height/rect.height) / DPR;
      const lineHit = nearestLine(mx, my);
      if (lineHit) {
        const url = lineHit.url || lineHit.profileUrl;
        if (url) window.open(url, '_blank');
      }
    });
    window.addEventListener('resize', resize);
    resize();
    function resetZoom(){ state.zoomX=null; state.zoomY=null; draw(); }
    function setHoverSeries(id){ state.hoverSeries=id||null; draw(); }
    function onHover(cb){ hoverCb=cb; }
    function getZoom(){ return { x: state.zoomX ? [...state.zoomX] : null, y: state.zoomY ? [...state.zoomY] : null }; }
    function setZoom(z){ if (!z) return; if (z.x && isFinite(z.x[0]) && isFinite(z.x[1])) state.zoomX = [z.x[0], z.x[1]]; if (z.y && isFinite(z.y[0]) && isFinite(z.y[1])) state.zoomY = [z.y[0], z.y[1]]; draw(); }
    return { setData, resetZoom, setHoverSeries, onHover, getZoom, setZoom };
  }

  // Legend removed — left list serves as legend

  function exportCSV(user){
    const lines = ['post_id,timestamp,unique,likes,views,interaction_rate'];
    for (const [pid,p] of Object.entries(user.posts||{})){
      for (const s of (p.snapshots||[])){
        const rate = interactionRate(s);
        lines.push([pid, s.t, s.uv??'', s.likes??'', s.views??'', rate==null?'':rate.toFixed(4)].join(','));
      }
    }
    const blob = new Blob([lines.join('\n')], {type:'text/csv'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href=url; a.download='sora_metrics.csv'; a.click();
    setTimeout(()=>URL.revokeObjectURL(url), 1000);
  }

  // Escape CSV field (handle commas, quotes, newlines)
  function escapeCSV(str) {
    if (str == null) return '';
    const s = String(str);
    if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  // Format timestamp for CSV
  function fmtTimestamp(ts) {
    if (!ts) return '';
    const t = toTs(ts);
    if (!t) return '';
    try {
      return new Date(t).toISOString();
    } catch {
      return String(t);
    }
  }

  async function exportAllDataCSV(){
    try {
      const metrics = await loadMetrics();
      const allLines = [];
      
      // === SHEET 1: Posts Summary (one row per post with latest snapshot) ===
      const postsHeader = [
        'User Key', 'User Handle', 'User ID', 
        'Post ID', 'Post URL', 'Post Time', 'Post Time (ISO)', 'Caption',
        'Thumbnail URL', 'Parent Post ID', 'Root Post ID', 'Last Seen Timestamp',
        'Owner Key', 'Owner Handle', 'Owner ID',
        'Latest Snapshot Timestamp', 'Unique Views', 'Total Views', 'Likes', 'Comments', 'Remixes',
        'Interaction Rate %', 'Remix Rate %', 'Like Rate %',
        'Snapshot Count', 'First Snapshot Timestamp', 'Last Snapshot Timestamp'
      ];
      allLines.push('=== POSTS SUMMARY (Latest Snapshot Per Post) ===');
      allLines.push(postsHeader.map(escapeCSV).join(','));
      
      for (const [userKey, user] of Object.entries(metrics.users || {})){
        const handle = user.handle || '';
        const userId = user.id || '';
        
        for (const [pid, post] of Object.entries(user.posts || {})){
          const latest = latestSnapshot(post.snapshots);
          const postTimeRaw = getPostTimeStrict(post);
          const postTime = fmtTimestamp(postTimeRaw);
          const postTimeISO = postTimeRaw ? new Date(postTimeRaw).toISOString() : '';
          const latestTime = latest ? fmtTimestamp(latest.t) : '';
          
          const uv = latest?.uv ?? '';
          const views = latest?.views ?? '';
          const likes = latest?.likes ?? '';
          const comments = latest?.comments ?? latest?.reply_count ?? '';
          const remixes = latest?.remix_count ?? latest?.remixes ?? '';
          
          const ir = interactionRate(latest);
          const rr = remixRate(likes, remixes);
          const lr = likeRate(likes, uv);
          
          const caption = (typeof post.caption === 'string' && post.caption) ? post.caption.replace(/\n/g, ' ').replace(/\r/g, '') : '';
          const thumb = post.thumb || '';
          const url = post.url || `${SITE_ORIGIN}/p/${pid}`;
          const ownerKey = post.ownerKey || userKey;
          const ownerHandle = post.ownerHandle || handle;
          const ownerId = post.ownerId || userId;
          const parentPostId = post.parent_post_id || '';
          const rootPostId = post.root_post_id || '';
          const lastSeen = post.lastSeen ? fmtTimestamp(post.lastSeen) : '';
          
          const snaps = Array.isArray(post.snapshots) ? post.snapshots : [];
          const snapshotCount = snaps.length;
          const firstSnapshot = snaps.length > 0 ? fmtTimestamp(snaps[0]?.t) : '';
          const lastSnapshot = latest ? fmtTimestamp(latest.t) : '';
          
          allLines.push([
            userKey, handle, userId,
            pid, url, postTime, postTimeISO, caption,
            thumb, parentPostId, rootPostId, lastSeen,
            ownerKey, ownerHandle, ownerId,
            latestTime, uv, views, likes, comments, remixes,
            ir != null ? ir.toFixed(2) : '', rr != null ? rr : '', lr != null ? lr.toFixed(2) : '',
            snapshotCount, firstSnapshot, lastSnapshot
          ].map(escapeCSV).join(','));
        }
      }
      
      // === SHEET 2: Post Snapshots (all historical data) ===
      allLines.push('');
      allLines.push('=== POST SNAPSHOTS (Complete Historical Timeline) ===');
      const snapshotsHeader = [
        'User Key', 'User Handle', 'User ID',
        'Post ID', 'Post URL', 'Post Caption', 'Post Time',
        'Owner Key', 'Owner Handle', 'Owner ID',
        'Snapshot Timestamp', 'Snapshot Timestamp (ISO)', 'Snapshot Age (minutes)',
        'Unique Views', 'Total Views', 'Likes', 'Comments', 'Remixes',
        'Interaction Rate %', 'Remix Rate %', 'Like Rate %',
        'Views Change', 'Likes Change', 'Comments Change', 'Remixes Change'
      ];
      allLines.push(snapshotsHeader.map(escapeCSV).join(','));
      
      for (const [userKey, user] of Object.entries(metrics.users || {})){
        const handle = user.handle || '';
        const userId = user.id || '';
        
        for (const [pid, post] of Object.entries(user.posts || {})){
          const snaps = Array.isArray(post.snapshots) ? post.snapshots : [];
          const postTimeRaw = getPostTimeStrict(post);
          const postTime = fmtTimestamp(postTimeRaw);
          const caption = (typeof post.caption === 'string' && post.caption) ? post.caption.replace(/\n/g, ' ').replace(/\r/g, '') : '';
          const url = post.url || `${SITE_ORIGIN}/p/${pid}`;
          const ownerKey = post.ownerKey || userKey;
          const ownerHandle = post.ownerHandle || handle;
          const ownerId = post.ownerId || userId;
          
          let prevViews = null, prevLikes = null, prevComments = null, prevRemixes = null;
          
          for (const snap of snaps){
            const t = snap.t ? Number(snap.t) : null;
            const tFormatted = t ? fmtTimestamp(t) : '';
            const tISO = t ? new Date(t).toISOString() : '';
            const ageMin = t && postTimeRaw ? Math.floor((t - postTimeRaw) / 60000) : '';
            
            const uv = snap.uv ?? '';
            const views = snap.views ?? '';
            const likes = snap.likes ?? '';
            const comments = snap.comments ?? snap.reply_count ?? '';
            const remixes = snap.remix_count ?? snap.remixes ?? '';
            
            const ir = interactionRate(snap);
            const rr = remixRate(likes, remixes);
            const lr = likeRate(likes, uv);
            
            const viewsChange = prevViews != null && views !== '' ? (Number(views) - Number(prevViews)) : '';
            const likesChange = prevLikes != null && likes !== '' ? (Number(likes) - Number(prevLikes)) : '';
            const commentsChange = prevComments != null && comments !== '' ? (Number(comments) - Number(prevComments)) : '';
            const remixesChange = prevRemixes != null && remixes !== '' ? (Number(remixes) - Number(prevRemixes)) : '';
            
            allLines.push([
              userKey, handle, userId,
              pid, url, caption, postTime,
              ownerKey, ownerHandle, ownerId,
              tFormatted, tISO, ageMin,
              uv, views, likes, comments, remixes,
              ir != null ? ir.toFixed(2) : '', rr != null ? rr : '', lr != null ? lr.toFixed(2) : '',
              viewsChange, likesChange, commentsChange, remixesChange
            ].map(escapeCSV).join(','));
            
            if (views !== '') prevViews = Number(views);
            if (likes !== '') prevLikes = Number(likes);
            if (comments !== '') prevComments = Number(comments);
            if (remixes !== '') prevRemixes = Number(remixes);
          }
        }
      }
      
      // === SHEET 3: User Followers History ===
      allLines.push('');
      allLines.push('=== USER FOLLOWERS HISTORY (Complete Timeline) ===');
      const followersHeader = [
        'User Key', 'User Handle', 'User ID', 
        'Timestamp', 'Timestamp (ISO)', 'Follower Count', 'Follower Change', 'Days Since First'
      ];
      allLines.push(followersHeader.map(escapeCSV).join(','));
      
      for (const [userKey, user] of Object.entries(metrics.users || {})){
        const handle = user.handle || '';
        const userId = user.id || '';
        const followers = Array.isArray(user.followers) ? user.followers : [];
        
        let firstTimestamp = null;
        let prevCount = null;
        
        for (const entry of followers){
          const t = entry.t ? Number(entry.t) : null;
          const tFormatted = t ? fmtTimestamp(t) : '';
          const tISO = t ? new Date(t).toISOString() : '';
          const count = entry.count ?? '';
          
          if (firstTimestamp === null && t) firstTimestamp = t;
          const daysSinceFirst = firstTimestamp && t ? ((t - firstTimestamp) / (24 * 60 * 60 * 1000)).toFixed(2) : '';
          const followerChange = prevCount != null && count !== '' ? (Number(count) - Number(prevCount)) : '';
          
          allLines.push([
            userKey, handle, userId,
            tFormatted, tISO, count, followerChange, daysSinceFirst
          ].map(escapeCSV).join(','));
          
          if (count !== '') prevCount = Number(count);
        }
      }
      
      // === SHEET 4: User Cast in History ===
      allLines.push('');
      allLines.push('=== USER CAST IN HISTORY (Complete Timeline) ===');
      const cameosHeader = [
        'User Key', 'User Handle', 'User ID',
        'Timestamp', 'Timestamp (ISO)', 'Cast in Count', 'Cast in Change', 'Days Since First'
      ];
      allLines.push(cameosHeader.map(escapeCSV).join(','));
      
      for (const [userKey, user] of Object.entries(metrics.users || {})){
        const handle = user.handle || '';
        const userId = user.id || '';
        const cameos = Array.isArray(user.cameos) ? user.cameos : [];
        
        let firstTimestamp = null;
        let prevCount = null;
        
        for (const entry of cameos){
          const t = entry.t ? Number(entry.t) : null;
          const tFormatted = t ? fmtTimestamp(t) : '';
          const tISO = t ? new Date(t).toISOString() : '';
          const count = entry.count ?? '';
          
          if (firstTimestamp === null && t) firstTimestamp = t;
          const daysSinceFirst = firstTimestamp && t ? ((t - firstTimestamp) / (24 * 60 * 60 * 1000)).toFixed(2) : '';
          const castInChange = prevCount != null && count !== '' ? (Number(count) - Number(prevCount)) : '';
          
          allLines.push([
            userKey, handle, userId,
            tFormatted, tISO, count, castInChange, daysSinceFirst
          ].map(escapeCSV).join(','));
          
          if (count !== '') prevCount = Number(count);
        }
      }
      
      // === SHEET 5: Users Summary ===
      allLines.push('');
      allLines.push('=== USERS SUMMARY (Aggregated Totals) ===');
      const usersHeader = [
        'User Key', 'User Handle', 'User ID', 
        'Post Count', 'Total Snapshots',
        'Latest Follower Count', 'Latest Follower Timestamp', 'Follower History Points',
        'Latest Cast in Count', 'Latest Cast in Timestamp', 'Cast in History Points',
        'Total Views (Latest)', 'Total Likes (Latest)', 'Total Comments (Latest)', 'Total Remixes (Latest)',
        'Total Interactions (Latest)', 'Average Interaction Rate %', 'Average Remix Rate %',
        'First Post Time', 'Last Post Time', 'Post Time Span (days)'
      ];
      allLines.push(usersHeader.map(escapeCSV).join(','));
      
      for (const [userKey, user] of Object.entries(metrics.users || {})){
        const handle = user.handle || '';
        const userId = user.id || '';
        const postCount = Object.keys(user.posts || {}).length;
        
        let totalSnapshots = 0;
        let firstPostTime = null;
        let lastPostTime = null;
        let totalIR = 0;
        let irCount = 0;
        let totalRR = 0;
        let rrCount = 0;
        
        for (const [pid, post] of Object.entries(user.posts || {})){
          const snaps = Array.isArray(post.snapshots) ? post.snapshots : [];
          totalSnapshots += snaps.length;
          
          const postTime = getPostTimeStrict(post);
          if (postTime) {
            if (!firstPostTime || postTime < firstPostTime) firstPostTime = postTime;
            if (!lastPostTime || postTime > lastPostTime) lastPostTime = postTime;
          }
          
          const latest = latestSnapshot(snaps);
          if (latest) {
            const ir = interactionRate(latest);
            if (ir != null) { totalIR += ir; irCount++; }
            
            const likes = latest.likes;
            const remixes = latest.remix_count ?? latest.remixes;
            const rr = remixRate(likes, remixes);
            if (rr != null) { totalRR += Number(rr); rrCount++; }
          }
        }
        
        const followers = Array.isArray(user.followers) ? user.followers : [];
        const latestFollowers = followers.length > 0 ? (followers[followers.length - 1]?.count ?? '') : '';
        const latestFollowersTime = followers.length > 0 ? fmtTimestamp(followers[followers.length - 1]?.t) : '';
        const followerHistoryPoints = followers.length;
        
        const cameos = Array.isArray(user.cameos) ? user.cameos : [];
        const latestCameos = cameos.length > 0 ? (cameos[cameos.length - 1]?.count ?? '') : '';
        const latestCameosTime = cameos.length > 0 ? fmtTimestamp(cameos[cameos.length - 1]?.t) : '';
        const cameoHistoryPoints = cameos.length;
        
        const totals = computeTotalsForUser(user);
        const avgIR = irCount > 0 ? (totalIR / irCount).toFixed(2) : '';
        const avgRR = rrCount > 0 ? (totalRR / rrCount).toFixed(2) : '';
        
        const firstPostTimeFormatted = firstPostTime ? fmtTimestamp(firstPostTime) : '';
        const lastPostTimeFormatted = lastPostTime ? fmtTimestamp(lastPostTime) : '';
        const postTimeSpan = firstPostTime && lastPostTime ? ((lastPostTime - firstPostTime) / (24 * 60 * 60 * 1000)).toFixed(2) : '';
        
        allLines.push([
          userKey, handle, userId,
          postCount, totalSnapshots,
          latestFollowers, latestFollowersTime, followerHistoryPoints,
          latestCameos, latestCameosTime, cameoHistoryPoints,
          totals.views, totals.likes, totals.replies, totals.remixes,
          totals.interactions, avgIR, avgRR,
          firstPostTimeFormatted, lastPostTimeFormatted, postTimeSpan
        ].map(escapeCSV).join(','));
      }
      
      // Create and download CSV
      const csvContent = allLines.join('\n');
      const blob = new Blob([csvContent], {type:'text/csv;charset=utf-8;'});
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
      a.download = `sora_all_data_export_${timestamp}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      console.error('[Dashboard] Export all data failed', e);
      alert('Export failed. Please check the console for details.');
    }
  }

  // Parse CSV line handling quoted fields
  function parseCSVLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;
    
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      const nextChar = line[i + 1];
      
      if (char === '"') {
        if (inQuotes && nextChar === '"') {
          current += '"';
          i++; // Skip next quote
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === ',' && !inQuotes) {
        result.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    result.push(current.trim());
    return result;
  }

  // Convert ISO timestamp string back to milliseconds timestamp
  function parseTimestamp(tsStr) {
    if (!tsStr || tsStr === '') return null;
    const d = Date.parse(tsStr);
    if (!isNaN(d)) return d;
    return toTs(tsStr);
  }

  async function importDataCSV(file) {
    try {
      const text = await file.text();
      const lines = text.split('\n').map(l => l.trim()).filter(l => l);
      
      if (lines.length === 0) {
        alert('CSV file is empty.');
        return;
      }

      // Load existing metrics
      const existingMetrics = await loadMetrics();
      const metrics = {
        users: JSON.parse(JSON.stringify(existingMetrics.users || {}))
      };

      let currentSection = null;
      let headerRow = null;
      let sectionStartIdx = 0;
      const stats = {
        postsAdded: 0,
        postsUpdated: 0,
        snapshotsAdded: 0,
        snapshotsSkipped: 0,
        followersAdded: 0,
        followersSkipped: 0,
        cameosAdded: 0,
        cameosSkipped: 0,
        usersAdded: 0,
        usersUpdated: 0
      };

      // Process each line
      let dataStartIdx = -1;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        
        // Check for section headers
        if (line.startsWith('===') && line.endsWith('===')) {
          // Process previous section if any
          if (currentSection && headerRow && dataStartIdx >= 0 && i > dataStartIdx) {
            const sectionRows = lines.slice(dataStartIdx, i).filter(r => r && r.trim());
            await processSection(currentSection, headerRow, sectionRows, metrics, stats);
          }
          
          // Determine new section
          if (line.includes('POSTS SUMMARY')) {
            currentSection = 'posts_summary';
          } else if (line.includes('POST SNAPSHOTS')) {
            currentSection = 'snapshots';
          } else if (line.includes('USER FOLLOWERS HISTORY')) {
            currentSection = 'followers';
          } else if (line.includes('USER CAST IN HISTORY')) {
            currentSection = 'cameos';
          } else if (line.includes('USERS SUMMARY')) {
            currentSection = 'users_summary';
          } else {
            currentSection = null;
          }
          
          headerRow = null;
          dataStartIdx = -1;
          continue;
        }
        
        // First non-header line after section marker is the header
        if (currentSection && !headerRow && !line.startsWith('===')) {
          headerRow = parseCSVLine(line);
          dataStartIdx = i + 1; // Data starts after header
          continue;
        }
      }
      
      // Process last section
      if (currentSection && headerRow && dataStartIdx >= 0) {
        const sectionRows = lines.slice(dataStartIdx).filter(r => r && r.trim());
        await processSection(currentSection, headerRow, sectionRows, metrics, stats);
      }

      // Save merged metrics
      await chrome.storage.local.set({ metrics });
      
      // Show success message with stats
      const message = `Import completed!\n\n` +
        `Posts: ${stats.postsAdded} added, ${stats.postsUpdated} updated\n` +
        `Snapshots: ${stats.snapshotsAdded} added, ${stats.snapshotsSkipped} skipped (duplicates)\n` +
        `Followers: ${stats.followersAdded} added, ${stats.followersSkipped} skipped (duplicates)\n` +
        `Cast in: ${stats.cameosAdded} added, ${stats.cameosSkipped} skipped (duplicates)\n` +
        `Users: ${stats.usersAdded} added, ${stats.usersUpdated} updated`;
      
      alert(message);
      
      // Reload the dashboard
      window.location.reload();
      
    } catch (e) {
      console.error('[Dashboard] Import failed', e);
      alert('Import failed: ' + (e.message || 'Unknown error. Please check the console for details.'));
    }
  }

  async function processSection(section, header, rows, metrics, stats) {
    if (!header || header.length === 0) return;
    
    // Create column index map
    const colIdx = {};
    header.forEach((col, idx) => {
      colIdx[col.toLowerCase()] = idx;
    });

    const getUserKeyIdx = () => colIdx['user key'] ?? colIdx['userkey'];
    const getHandleIdx = () => colIdx['user handle'] ?? colIdx['userhandle'];
    const getUserIdIdx = () => colIdx['user id'] ?? colIdx['userid'];
    const getPostIdIdx = () => colIdx['post id'] ?? colIdx['postid'];
    
    for (const row of rows) {
      if (!row || row.trim() === '') continue;
      
      const cols = parseCSVLine(row);
      if (cols.length < header.length) continue; // Skip incomplete rows
      
      const getCol = (name) => {
        const idx = colIdx[name.toLowerCase()];
        return idx != null && idx < cols.length ? cols[idx] : '';
      };
      
      const userKeyIdx = getUserKeyIdx();
      const handleIdx = getHandleIdx();
      const userIdIdx = getUserIdIdx();
      
      if (userKeyIdx == null) continue;
      
      const userKey = cols[userKeyIdx] || 'unknown';
      const handle = handleIdx != null ? cols[handleIdx] : '';
      const userId = userIdIdx != null ? cols[userIdIdx] : '';
      
      // Ensure user exists
      if (!metrics.users[userKey]) {
        metrics.users[userKey] = {
          handle: handle || null,
          id: userId || null,
          posts: {},
          followers: [],
          cameos: []
        };
        stats.usersAdded++;
      } else {
        // Update handle/id if missing
        if (!metrics.users[userKey].handle && handle) metrics.users[userKey].handle = handle;
        if (!metrics.users[userKey].id && userId) metrics.users[userKey].id = userId;
        stats.usersUpdated++;
      }
      
      const user = metrics.users[userKey];
      
      if (section === 'posts_summary') {
        const postIdIdx = getPostIdIdx();
        if (postIdIdx == null) continue;
        
        const postId = cols[postIdIdx];
        if (!postId) continue;
        
        const url = getCol('Post URL') || `${SITE_ORIGIN}/p/${postId}`;
        const caption = getCol('Caption') || '';
        const thumb = getCol('Thumbnail URL') || '';
        const postTimeISO = getCol('Post Time (ISO)') || getCol('Post Time');
        const postTime = parseTimestamp(postTimeISO);
        const ownerKey = getCol('Owner Key') || userKey;
        const ownerHandle = getCol('Owner Handle') || handle;
        const ownerId = getCol('Owner ID') || userId;
        const parentPostId = getCol('Parent Post ID') || '';
        const rootPostId = getCol('Root Post ID') || '';
        const lastSeenISO = getCol('Last Seen Timestamp');
        const lastSeen = parseTimestamp(lastSeenISO);
        
        // Latest snapshot data
        const snapshotTimeISO = getCol('Latest Snapshot Timestamp');
        const snapshotTime = parseTimestamp(snapshotTimeISO);
        const uv = getCol('Unique Views');
        const views = getCol('Total Views');
        const likes = getCol('Likes');
        const comments = getCol('Comments');
        const remixes = getCol('Remixes');
        
        if (!user.posts[postId]) {
          user.posts[postId] = {
            url: url,
            thumb: thumb,
            caption: caption || null,
            snapshots: [],
            ownerKey: ownerKey,
            ownerHandle: ownerHandle,
            ownerId: ownerId || null,
            parent_post_id: parentPostId || null,
            root_post_id: rootPostId || null,
            lastSeen: lastSeen || null
          };
          stats.postsAdded++;
        } else {
          // Update existing post metadata
          const post = user.posts[postId];
          if (!post.url && url) post.url = url;
          if (!post.thumb && thumb) post.thumb = thumb;
          if (!post.caption && caption) post.caption = caption;
          if (!post.ownerKey && ownerKey) post.ownerKey = ownerKey;
          if (!post.ownerHandle && ownerHandle) post.ownerHandle = ownerHandle;
          if (!post.ownerId && ownerId) post.ownerId = ownerId;
          if (!post.parent_post_id && parentPostId) post.parent_post_id = parentPostId;
          if (!post.root_post_id && rootPostId) post.root_post_id = rootPostId;
          if (!post.lastSeen && lastSeen) post.lastSeen = lastSeen;
          stats.postsUpdated++;
        }
        
        // Set post_time if available
        if (postTime && !user.posts[postId].post_time) {
          user.posts[postId].post_time = postTime;
        }
        
        // Add snapshot if timestamp and data available
        if (snapshotTime && (uv !== '' || views !== '' || likes !== '' || comments !== '' || remixes !== '')) {
          const post = user.posts[postId];
          const existingSnap = post.snapshots.find(s => s.t === snapshotTime);
          if (!existingSnap) {
            const snap = { t: snapshotTime };
            if (uv !== '') snap.uv = Number(uv) || 0;
            if (views !== '') snap.views = Number(views) || 0;
            if (likes !== '') snap.likes = Number(likes) || 0;
            if (comments !== '') snap.comments = Number(comments) || 0;
            if (remixes !== '') snap.remix_count = Number(remixes) || 0;
            post.snapshots.push(snap);
            stats.snapshotsAdded++;
          } else {
            stats.snapshotsSkipped++;
          }
        }
        
      } else if (section === 'snapshots') {
        const postIdIdx = getPostIdIdx();
        if (postIdIdx == null) continue;
        
        const postId = cols[postIdIdx];
        if (!postId) continue;
        
        // Ensure post exists
        if (!user.posts[postId]) {
          const url = getCol('Post URL') || `${SITE_ORIGIN}/p/${postId}`;
          const caption = getCol('Post Caption') || '';
          const postTimeISO = getCol('Post Time');
          const postTime = parseTimestamp(postTimeISO);
          const ownerKey = getCol('Owner Key') || userKey;
          const ownerHandle = getCol('Owner Handle') || handle;
          const ownerId = getCol('Owner ID') || userId;
          
          user.posts[postId] = {
            url: url,
            thumb: '',
            caption: caption || null,
            snapshots: [],
            ownerKey: ownerKey,
            ownerHandle: ownerHandle,
            ownerId: ownerId || null
          };
          if (postTime) user.posts[postId].post_time = postTime;
          stats.postsAdded++;
        }
        
        const snapshotTimeISO = getCol('Snapshot Timestamp (ISO)') || getCol('Snapshot Timestamp');
        const snapshotTime = parseTimestamp(snapshotTimeISO);
        if (!snapshotTime) continue;
        
        const post = user.posts[postId];
        const existingSnap = post.snapshots.find(s => s.t === snapshotTime);
        if (!existingSnap) {
          const snap = { t: snapshotTime };
          const uv = getCol('Unique Views');
          const views = getCol('Total Views');
          const likes = getCol('Likes');
          const comments = getCol('Comments');
          const remixes = getCol('Remixes');
          
          if (uv !== '') snap.uv = Number(uv) || 0;
          if (views !== '') snap.views = Number(views) || 0;
          if (likes !== '') snap.likes = Number(likes) || 0;
          if (comments !== '') snap.comments = Number(comments) || 0;
          if (remixes !== '') snap.remix_count = Number(remixes) || 0;
          
          post.snapshots.push(snap);
          stats.snapshotsAdded++;
        } else {
          stats.snapshotsSkipped++;
        }
        
      } else if (section === 'followers') {
        const timestampISO = getCol('Timestamp (ISO)') || getCol('Timestamp');
        const timestamp = parseTimestamp(timestampISO);
        if (!timestamp) continue;
        
        const count = getCol('Follower Count');
        if (count === '') continue;
        
        const existingEntry = user.followers.find(f => f.t === timestamp);
        if (!existingEntry) {
          user.followers.push({ t: timestamp, count: Number(count) || 0 });
          stats.followersAdded++;
        } else {
          stats.followersSkipped++;
        }
        
      } else if (section === 'cameos') {
        const timestampISO = getCol('Timestamp (ISO)') || getCol('Timestamp');
        const timestamp = parseTimestamp(timestampISO);
        if (!timestamp) continue;
        
        const count = getCol('Cast in Count');
        if (count === '') continue;
        
        const existingEntry = user.cameos.find(c => c.t === timestamp);
        if (!existingEntry) {
          user.cameos.push({ t: timestamp, count: Number(count) || 0 });
          stats.cameosAdded++;
        } else {
          stats.cameosSkipped++;
        }
      }
      // Note: users_summary section is informational only, we don't need to process it
    }
    
    // Sort snapshots, followers, and cameos by timestamp after processing
    for (const user of Object.values(metrics.users)) {
      if (Array.isArray(user.followers)) {
        user.followers.sort((a, b) => (a.t || 0) - (b.t || 0));
      }
      if (Array.isArray(user.cameos)) {
        user.cameos.sort((a, b) => (a.t || 0) - (b.t || 0));
      }
      for (const post of Object.values(user.posts || {})) {
        if (Array.isArray(post.snapshots)) {
          post.snapshots.sort((a, b) => (a.t || 0) - (b.t || 0));
        }
      }
    }
  }

  async function main(){
    let metrics = await loadMetrics();
    // Build list and try to restore last user
    let currentUserKey = buildUserOptions(metrics);
    try {
      const { lastUserKey } = await chrome.storage.local.get('lastUserKey');
      if (lastUserKey && (metrics.users[lastUserKey] || isTopTodayKey(lastUserKey))) currentUserKey = lastUserKey;
    } catch {}
    const selEl = $('#userSelect'); if (currentUserKey) selEl.value = currentUserKey;
    let viewsChartType = 'unique'; // 'unique' or 'total'
    const compareViewsChartType = 'total'; // Always use total views for compare section
    let chart = makeChart($('#chart'), 'Unique viewers', 'Unique');
    let viewsPerPersonChart = makeFirst24HoursChart($('#viewsPerPersonChart'), '#viewsPerPersonTooltip', 'Views Per Person', (v) => Number(v).toFixed(2));
    let viewsChart = makeTimeChart($('#viewsChart'), '#viewsTooltip', 'Unique Views', fmt);
    let first24HoursChart = makeFirst24HoursChart($('#first24HoursChart'), '#first24HoursTooltip', 'Unique Views', fmt);
    const followersChart = makeFollowersChart($('#followersChart'));
    let allViewsChart = makeTimeChart($('#allViewsChart'), '#allViewsTooltip', 'Total Views', fmt2);
    const allLikesChart = makeTimeChart($('#allLikesChart'), '#allLikesTooltip', 'Likes', fmt2);
    const cameosChart = makeTimeChart($('#cameosChart'), '#cameosTooltip', 'Cast in', fmt2);
    // Load persisted zoom states
    let zoomStates = {};
    try { const st = await chrome.storage.local.get('zoomStates'); zoomStates = st.zoomStates || {}; } catch {}
    const visibleSet = new Set();
    // On each dashboard open, start from Show All for the selected user.
    // Do not persist this reset; user selections still persist across sessions.
    let forceShowAllOnLoad = true;
    let visibilityByUser = {};
    try {
      const st = await chrome.storage.local.get('visibilityByUser');
      visibilityByUser = st.visibilityByUser || {};
    } catch {}
    let pendingPostPurge = null;
    let currentListActionId = null;
    
    // Compare users state
    const compareUsers = new Set();
    const MAX_COMPARE_USERS = 10;

    function persistVisibility(){
      if (isTopTodayKey(currentUserKey)) return;
      visibilityByUser[currentUserKey] = Array.from(visibleSet);
      try { chrome.storage.local.set({ visibilityByUser }); } catch {}
    }

    function renderComparePills(){
      const container = $('#comparePills');
      if (!container) return;
      container.innerHTML = '';
      const users = Array.from(compareUsers);
      users.forEach((userKey, idx)=>{
        const user = resolveUserForKey(metrics, userKey);
        const handle = user?.handle || (isTopTodayKey(userKey) ? 'Top Today' : userKey);
        const color = COLORS[idx % COLORS.length];
        const pill = document.createElement('div');
        pill.className = 'compare-pill';
        pill.dataset.userKey = userKey;
        pill.style.background = color;
        pill.style.borderColor = color;
        const nameSpan = document.createElement('span');
        nameSpan.className = 'compare-pill-name';
        nameSpan.textContent = handle;
        nameSpan.style.color = '#fff';
        const removeBtn = document.createElement('span');
        removeBtn.className = 'compare-pill-remove';
        removeBtn.textContent = '×';
        removeBtn.style.opacity = '1';
        removeBtn.style.pointerEvents = 'auto';
        removeBtn.style.color = '#fff';
        removeBtn.style.textShadow = '0 1px 2px rgba(0,0,0,0.5)';
        removeBtn.onclick = (e)=>{
          e.stopPropagation();
          compareUsers.delete(userKey);
          // If compare section becomes empty, add current user to show who we're looking at
          if (compareUsers.size === 0 && currentUserKey && resolveUserForKey(metrics, currentUserKey)){
            addCompareUser(currentUserKey);
          } else {
            renderComparePills();
            buildCompareDropdown();
            updateCompareCharts();
          }
        };
        pill.appendChild(nameSpan);
        pill.appendChild(removeBtn);
        container.appendChild(pill);
      });
      if (compareUsers.size < MAX_COMPARE_USERS){
        const addBtn = document.createElement('button');
        addBtn.className = 'compare-add-btn';
        addBtn.textContent = '+';
        addBtn.title = 'Add user';
        addBtn.onclick = ()=>{
          $('#compareSearch').focus();
        };
        container.appendChild(addBtn);
      }
      const searchInput = $('#compareSearch');
      if (searchInput) searchInput.disabled = compareUsers.size >= MAX_COMPARE_USERS;
    }

    function addCompareUser(userKey){
      if (compareUsers.size >= MAX_COMPARE_USERS) return;
      if (!resolveUserForKey(metrics, userKey)) return;
      if (compareUsers.has(userKey)) return;
      compareUsers.add(userKey);
      renderComparePills();
      buildCompareDropdown();
      updateCompareCharts();
      $('#compareSearch').value = '';
      $('#compareSuggestions').style.display = 'none';
    }

    function updateCompareCharts(){
      const userKeys = Array.from(compareUsers);
      if (userKeys.length === 0){
        refreshUserUI();
        return;
      }
      
      // Update allViewsChart
      try {
        const useUnique = compareViewsChartType === 'unique';
        const allSeries = [];
        userKeys.forEach((userKey, idx)=>{
          const user = resolveUserForKey(metrics, userKey);
          if (!user) return;
          const pts = (function(){
            const events = [];
            for (const [pid, p] of Object.entries(user.posts||{})){
              for (const s of (p.snapshots||[])){
                const t = Number(s.t);
                const v = useUnique ? Number(s.uv) : Number(s.views);
                if (isFinite(t) && isFinite(v)) events.push({ t, v, pid });
              }
            }
            events.sort((a,b)=> a.t - b.t);
            const latest = new Map();
            let total = 0;
            const out = [];
            for (const e of events){
              const prev = latest.get(e.pid) || 0;
              if (e.v !== prev){
                latest.set(e.pid, e.v);
                total += (e.v - prev);
                out.push({ x: e.t, y: total, t: e.t });
              }
            }
            return out;
          })();
          if (pts.length){
            const color = COLORS[idx % COLORS.length];
            const handle = user.handle || (isTopTodayKey(userKey) ? 'Top Today' : userKey);
            const profileUrl = handle ? `${SITE_ORIGIN}/profile/${handle}` : null;
            const isTopToday = isTopTodayKey(userKey);
            const label = isTopToday
              ? (useUnique ? 'Top Today • Unique Views' : 'Top Today • Total Views')
              : (useUnique ? `@${handle}'s Unique Views` : `@${handle}'s Total Views`);
            allSeries.push({ id: userKey, label, color, points: pts, profileUrl: isTopToday ? null : profileUrl });
          }
        });
        const yAxisLabel = useUnique ? 'Unique Views' : 'Total Views';
        allViewsChart.setYAxisLabel(yAxisLabel);
        allViewsChart.setData(allSeries);
      } catch {}

      // Update allLikesChart
      try {
        const allSeries = [];
        userKeys.forEach((userKey, idx)=>{
          const user = resolveUserForKey(metrics, userKey);
          if (!user) return;
          const ptsLikes = (function(){
            const events = [];
            for (const [pid, p] of Object.entries(user.posts||{})){
              for (const s of (p.snapshots||[])){
                const t = Number(s.t), v = Number(s.likes);
                if (isFinite(t) && isFinite(v)) events.push({ t, v, pid });
              }
            }
            events.sort((a,b)=> a.t - b.t);
            const latest = new Map();
            let total = 0;
            const out = [];
            for (const e of events){
              const prev = latest.get(e.pid) || 0;
              if (e.v !== prev){
                latest.set(e.pid, e.v);
                total += (e.v - prev);
                out.push({ x: e.t, y: total, t: e.t });
              }
            }
            return out;
          })();
          if (ptsLikes.length){
            const color = COLORS[idx % COLORS.length];
            const handle = user.handle || (isTopTodayKey(userKey) ? 'Top Today' : userKey);
            const profileUrl = handle ? `${SITE_ORIGIN}/profile/${handle}` : null;
            const isTopToday = isTopTodayKey(userKey);
            allSeries.push({ id: userKey, label: isTopToday ? 'Top Today • Likes' : `@${handle}'s Likes`, color, points: ptsLikes, profileUrl: isTopToday ? null : profileUrl });
          }
        });
        allLikesChart.setData(allSeries);
      } catch {}

      // Update cameosChart
      try {
        const allSeries = [];
        userKeys.forEach((userKey, idx)=>{
          const user = resolveUserForKey(metrics, userKey);
          if (!user) return;
          const arr = Array.isArray(user.cameos) ? user.cameos : [];
          const pts = arr.map(it=>({ x:Number(it.t), y:Number(it.count), t:Number(it.t) })).filter(p=>isFinite(p.x)&&isFinite(p.y));
          if (pts.length){
            const color = COLORS[idx % COLORS.length];
            const handle = user.handle || (isTopTodayKey(userKey) ? 'Top Today' : userKey);
            const profileUrl = handle ? `${SITE_ORIGIN}/profile/${handle}` : null;
            const isTopToday = isTopTodayKey(userKey);
            allSeries.push({ id: userKey, label: isTopToday ? 'Top Today • Cast in' : `@${handle}'s Cast in`, color, points: pts, profileUrl: isTopToday ? null : profileUrl });
          }
        });
        cameosChart.setData(allSeries);
      } catch {}

      // Update followersChart
      try {
        const allSeries = [];
        userKeys.forEach((userKey, idx)=>{
          const user = resolveUserForKey(metrics, userKey);
          if (!user) return;
          const arr = Array.isArray(user.followers) ? user.followers : [];
          const pts = arr.map(it=>({ x:Number(it.t), y:Number(it.count), t:Number(it.t) })).filter(p=>isFinite(p.x)&&isFinite(p.y));
          if (pts.length){
            const color = COLORS[idx % COLORS.length];
            const handle = user.handle || (isTopTodayKey(userKey) ? 'Top Today' : userKey);
            const profileUrl = handle ? `${SITE_ORIGIN}/profile/${handle}` : null;
            const isTopToday = isTopTodayKey(userKey);
            allSeries.push({ id: userKey, label: isTopToday ? 'Top Today • Followers' : `@${handle}'s Followers`, color, points: pts, profileUrl: isTopToday ? null : profileUrl });
          }
        });
        followersChart.setData(allSeries);
      } catch {}

      // Update metric cards with aggregated totals across all compared users
      try {
        const totals = (function(){
          const res = { views:0, uniqueViews:0, likes:0, replies:0, remixes:0, interactions:0, cameos:0, followers:0 };
          for (const userKey of userKeys){
            const user = resolveUserForKey(metrics, userKey);
            if (!user) continue;
            const userTotals = computeTotalsForUser(user);
            res.views += userTotals.views;
            res.uniqueViews += userTotals.uniqueViews;
            res.likes += userTotals.likes;
            res.replies += userTotals.replies;
            res.remixes += userTotals.remixes;
            res.interactions += userTotals.interactions;
            const cameosArr = Array.isArray(user.cameos) ? user.cameos : [];
            if (cameosArr.length > 0){
              const lastCameo = cameosArr[cameosArr.length - 1];
              res.cameos += num(lastCameo?.count);
            }
            const followersArr = Array.isArray(user.followers) ? user.followers : [];
            if (followersArr.length > 0){
              const lastFollower = followersArr[followersArr.length - 1];
              res.followers += num(lastFollower?.count);
            }
          }
          return res;
        })();
        const allTotalViewsEl = $('#allTotalViewsTotal'); if (allTotalViewsEl) allTotalViewsEl.textContent = fmt2(totals.views);
        const allUniqueViewsEl = $('#allUniqueViewsTotal'); if (allUniqueViewsEl) allUniqueViewsEl.textContent = fmt2(totals.uniqueViews);
        const allLikesEl = $('#allLikesTotal'); if (allLikesEl) allLikesEl.textContent = fmt2(totals.likes);
        const allRepliesEl = $('#allRepliesTotal'); if (allRepliesEl) allRepliesEl.textContent = fmtK2OrInt(totals.replies);
        const allRemixesEl = $('#allRemixesTotal'); if (allRemixesEl) allRemixesEl.textContent = fmt2(totals.remixes);
        const allInterEl = $('#allInteractionsTotal'); if (allInterEl) allInterEl.textContent = fmt2(totals.interactions);
        const allCameosEl = $('#allCameosTotal'); if (allCameosEl) allCameosEl.textContent = fmtK2OrInt(totals.cameos);
        const followersEl = $('#followersTotal'); if (followersEl) followersEl.textContent = fmtK2OrInt(totals.followers);
      } catch {}
    }

    // Function to calculate best time to post from ALL users' data (runs once on load)
    // Returns an object with three time-bound calculations: year, month, week
    function calculateBestPostTimeFromAllUsers(){
      if (!metrics || !metrics.users) return { year: null, month: null, week: null };
      
      const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      const now = Date.now();
      
      // Helper function to calculate best time for a given time range
      function calculateBestTimeForRange(daysBack){
        const cutoffTime = now - (daysBack * 24 * 60 * 60 * 1000);
        const timeStats = new Map(); // "hour:minuteBucket" -> { count, totalViews, dayOfWeek: Map, times: [] }
        const timeWindowMinutes = 1440; // 24 hours
        const bucketSizeMinutes = 15; // Group posts into 15-minute buckets for more meaningful results
        let totalPostsUsed = 0; // Track total posts used in calculation
        
        // Iterate through ALL users and ALL posts within the time range
        for (const [userKey, user] of Object.entries(metrics.users||{})){
          for (const [pid, p] of Object.entries(user.posts||{})){
            const postTime = getPostTimeStrict(p);
            // Only include posts that are within the time range (postTime >= cutoffTime means post is newer than cutoff)
            if (!postTime || postTime < cutoffTime) continue;
            
            // Find unique views at the end of 24 hours
            const windowEndTime = postTime + (timeWindowMinutes * 60 * 1000);
            let maxViews = 0;
            for (const s of (p.snapshots||[])){
              if (s.t <= windowEndTime && s.uv != null){
                maxViews = Math.max(maxViews, Number(s.uv));
              }
            }
            
            if (maxViews > 0){
              totalPostsUsed++; // Count this post
              const postDate = new Date(postTime);
              const hour = postDate.getHours();
              const minute = postDate.getMinutes();
              const dayOfWeek = postDate.getDay();
              
              // Round to nearest bucket (e.g., 3:07 -> 3:00, 3:22 -> 3:15, 3:38 -> 3:30)
              const minuteBucket = Math.floor(minute / bucketSizeMinutes) * bucketSizeMinutes;
              const timeKey = `${hour}:${minuteBucket}`;
              
              if (!timeStats.has(timeKey)){
                timeStats.set(timeKey, { 
                  count: 0, 
                  totalViews: 0,
                  dayOfWeek: new Map(), // dayOfWeek -> count
                  times: [] // Store actual times for calculating median
                });
              }
              const stats = timeStats.get(timeKey);
              stats.count++;
              stats.totalViews += maxViews;
              stats.times.push({ hour, minute, dayOfWeek });
              
              // Track day of week for this time
              if (!stats.dayOfWeek.has(dayOfWeek)){
                stats.dayOfWeek.set(dayOfWeek, 0);
              }
              stats.dayOfWeek.set(dayOfWeek, stats.dayOfWeek.get(dayOfWeek) + 1);
            }
          }
        }
        
        if (timeStats.size === 0) return null;
        
        // Find top 3 time buckets with highest average views
        const timeBuckets = Array.from(timeStats.entries())
          .map(([timeKey, stats]) => ({
            timeKey,
            avg: stats.totalViews / stats.count,
            count: stats.count,
            stats
          }))
          .sort((a, b) => b.avg - a.avg)
          .slice(0, 3);

        if (timeBuckets.length === 0) return null;

        // Create time range from top buckets - use tighter range for better accuracy
        const times = timeBuckets.flatMap(bucket => bucket.stats.times)
          .sort((a, b) => {
            if (a.hour !== b.hour) return a.hour - b.hour;
            return a.minute - b.minute;
          });

        // Format as time range
        const formatTime = (hour, minute) => {
          const hour12 = hour % 12 || 12;
          const minuteStr = String(minute).padStart(2, '0');
          const ampm = hour >= 12 ? 'PM' : 'AM';
          return `${hour12}:${minuteStr} ${ampm}`;
        };

        // Calculate median time for more accurate best time
        const medianIdx = Math.floor(times.length / 2);
        const medianTime = times[medianIdx];
        const bestHour = medianTime.hour;
        const bestMinute = medianTime.minute;

        let timeRangeStr;
        if (times.length <= 5) {
          // If few posts, show single time
          timeRangeStr = formatTime(medianTime.hour, medianTime.minute);
        } else {
          // Use interquartile range (25th to 75th percentile) for tighter, more accurate range
          const q1Idx = Math.floor(times.length * 0.25);
          const q3Idx = Math.floor(times.length * 0.75);
          const q1Time = times[q1Idx];
          const q3Time = times[q3Idx];
          
          // If the range is still too broad (>3 hours), use median ±1 hour
          const q1Minutes = q1Time.hour * 60 + q1Time.minute;
          const q3Minutes = q3Time.hour * 60 + q3Time.minute;
          const rangeMinutes = q3Minutes - q1Minutes;
          
          if (rangeMinutes > 180) { // More than 3 hours
            // Use median ±1 hour for tighter range
            const medianMinutes = bestHour * 60 + bestMinute;
            const startMinutes = Math.max(0, medianMinutes - 60);
            const endMinutes = Math.min(1439, medianMinutes + 60);
            const startHour = Math.floor(startMinutes / 60) % 24;
            const startMin = startMinutes % 60;
            const endHour = Math.floor(endMinutes / 60) % 24;
            const endMin = endMinutes % 60;
            timeRangeStr = `${formatTime(startHour, startMin)} - ${formatTime(endHour, endMin)}`;
          } else {
            // Use interquartile range
            timeRangeStr = `${formatTime(q1Time.hour, q1Time.minute)} - ${formatTime(q3Time.hour, q3Time.minute)}`;
          }
        }

        // Find most common day of week across all top buckets
        const dayOfWeekMap = new Map();
        for (const bucket of timeBuckets) {
          for (const [day, count] of bucket.stats.dayOfWeek.entries()) {
            dayOfWeekMap.set(day, (dayOfWeekMap.get(day) || 0) + count);
          }
        }

        let bestDayOfWeek = null;
        let bestDayCount = 0;
        for (const [day, count] of dayOfWeekMap.entries()){
          if (count > bestDayCount){
            bestDayCount = count;
            bestDayOfWeek = day;
          }
        }
        
        // Format time in user's local timezone
        const date = new Date();
        date.setHours(bestHour, bestMinute, 0, 0);
        
        // Get timezone abbreviation (ET, PT, etc.)
        const tzStr = date.toLocaleTimeString('en-US', {
          timeZoneName: 'short'
        }).split(' ').pop();

        const dayStr = bestDayOfWeek != null ? dayNames[bestDayOfWeek] : '';

        return {
          timeStr: `${timeRangeStr} ${tzStr}`,
          dayStr: dayStr ? ` on ${dayStr}` : '',
          postCount: totalPostsUsed
        };
      }
      
      // Calculate for year (365 days), month (30 days), and week (7 days)
      const yearResult = calculateBestTimeForRange(365);
      const monthResult = calculateBestTimeForRange(30);
      const weekResult = calculateBestTimeForRange(7);
      
      return {
        year: yearResult,
        month: monthResult,
        week: weekResult
      };
    }

    // Function to calculate best time to post for LIKES from ALL users' data
    function calculateBestPostTimeForLikes(){
      if (!metrics || !metrics.users) return { year: null, month: null, week: null };
      
      const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      const now = Date.now();
      
      function calculateBestTimeForRange(daysBack){
        const cutoffTime = now - (daysBack * 24 * 60 * 60 * 1000);
        const timeStats = new Map();
        const timeWindowMinutes = 1440;
        const bucketSizeMinutes = 15;
        let totalPostsUsed = 0;
        
        for (const [userKey, user] of Object.entries(metrics.users||{})){
          for (const [pid, p] of Object.entries(user.posts||{})){
            const postTime = getPostTimeStrict(p);
            if (!postTime || postTime < cutoffTime) continue;
            
            const windowEndTime = postTime + (timeWindowMinutes * 60 * 1000);
            let maxLikes = 0;
            for (const s of (p.snapshots||[])){
              if (s.t <= windowEndTime && s.likes != null){
                maxLikes = Math.max(maxLikes, Number(s.likes));
              }
            }
            
            if (maxLikes > 0){
              totalPostsUsed++;
              const postDate = new Date(postTime);
              const hour = postDate.getHours();
              const minute = postDate.getMinutes();
              const dayOfWeek = postDate.getDay();
              
              const minuteBucket = Math.floor(minute / bucketSizeMinutes) * bucketSizeMinutes;
              const timeKey = `${hour}:${minuteBucket}`;
              
              if (!timeStats.has(timeKey)){
                timeStats.set(timeKey, { 
                  count: 0, 
                  totalLikes: 0,
                  dayOfWeek: new Map(),
                  times: []
                });
              }
              const stats = timeStats.get(timeKey);
              stats.count++;
              stats.totalLikes += maxLikes;
              stats.times.push({ hour, minute, dayOfWeek });
              
              if (!stats.dayOfWeek.has(dayOfWeek)){
                stats.dayOfWeek.set(dayOfWeek, 0);
              }
              stats.dayOfWeek.set(dayOfWeek, stats.dayOfWeek.get(dayOfWeek) + 1);
            }
          }
        }
        
        if (timeStats.size === 0) return null;
        
        // Find top 3 time buckets with highest average likes
        const timeBuckets = Array.from(timeStats.entries())
          .map(([timeKey, stats]) => ({
            timeKey,
            avg: stats.totalLikes / stats.count,
            count: stats.count,
            stats
          }))
          .sort((a, b) => b.avg - a.avg)
          .slice(0, 3);

        if (timeBuckets.length === 0) return null;

        // Create time range from top buckets - use tighter range for better accuracy
        const times = timeBuckets.flatMap(bucket => bucket.stats.times)
          .sort((a, b) => {
            if (a.hour !== b.hour) return a.hour - b.hour;
            return a.minute - b.minute;
          });

        // Format as time range
        const formatTime = (hour, minute) => {
          const hour12 = hour % 12 || 12;
          const minuteStr = String(minute).padStart(2, '0');
          const ampm = hour >= 12 ? 'PM' : 'AM';
          return `${hour12}:${minuteStr} ${ampm}`;
        };

        // Calculate median time for more accurate best time
        const medianIdx = Math.floor(times.length / 2);
        const medianTime = times[medianIdx];
        const bestHour = medianTime.hour;
        const bestMinute = medianTime.minute;

        let timeRangeStr;
        if (times.length <= 5) {
          // If few posts, show single time
          timeRangeStr = formatTime(medianTime.hour, medianTime.minute);
        } else {
          // Use interquartile range (25th to 75th percentile) for tighter, more accurate range
          const q1Idx = Math.floor(times.length * 0.25);
          const q3Idx = Math.floor(times.length * 0.75);
          const q1Time = times[q1Idx];
          const q3Time = times[q3Idx];
          
          // If the range is still too broad (>3 hours), use median ±1 hour
          const q1Minutes = q1Time.hour * 60 + q1Time.minute;
          const q3Minutes = q3Time.hour * 60 + q3Time.minute;
          const rangeMinutes = q3Minutes - q1Minutes;
          
          if (rangeMinutes > 180) { // More than 3 hours
            // Use median ±1 hour for tighter range
            const medianMinutes = bestHour * 60 + bestMinute;
            const startMinutes = Math.max(0, medianMinutes - 60);
            const endMinutes = Math.min(1439, medianMinutes + 60);
            const startHour = Math.floor(startMinutes / 60) % 24;
            const startMin = startMinutes % 60;
            const endHour = Math.floor(endMinutes / 60) % 24;
            const endMin = endMinutes % 60;
            timeRangeStr = `${formatTime(startHour, startMin)} - ${formatTime(endHour, endMin)}`;
          } else {
            // Use interquartile range
            timeRangeStr = `${formatTime(q1Time.hour, q1Time.minute)} - ${formatTime(q3Time.hour, q3Time.minute)}`;
          }
        }

        // Find most common day of week across all top buckets
        const dayOfWeekMap = new Map();
        for (const bucket of timeBuckets) {
          for (const [day, count] of bucket.stats.dayOfWeek.entries()) {
            dayOfWeekMap.set(day, (dayOfWeekMap.get(day) || 0) + count);
          }
        }

        let bestDayOfWeek = null;
        let bestDayCount = 0;
        for (const [day, count] of dayOfWeekMap.entries()){
          if (count > bestDayCount){
            bestDayCount = count;
            bestDayOfWeek = day;
          }
        }

        const date = new Date();
        date.setHours(bestHour, bestMinute, 0, 0);

        const tzStr = date.toLocaleTimeString('en-US', {
          timeZoneName: 'short'
        }).split(' ').pop();

        const dayStr = bestDayOfWeek != null ? dayNames[bestDayOfWeek] : '';

        return {
          timeStr: `${timeRangeStr} ${tzStr}`,
          dayStr: dayStr ? ` on ${dayStr}` : '',
          postCount: totalPostsUsed
        };
      }
      
      const yearResult = calculateBestTimeForRange(365);
      const monthResult = calculateBestTimeForRange(30);
      const weekResult = calculateBestTimeForRange(7);
      
      return {
        year: yearResult,
        month: monthResult,
        week: weekResult
      };
    }

    // Function to calculate best time to post for REMIXES from ALL users' data
    function calculateBestPostTimeForRemixes(){
      if (!metrics || !metrics.users) return { year: null, month: null, week: null };
      
      const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      const now = Date.now();
      
      function calculateBestTimeForRange(daysBack){
        const cutoffTime = now - (daysBack * 24 * 60 * 60 * 1000);
        const timeStats = new Map();
        const timeWindowMinutes = 1440;
        const bucketSizeMinutes = 15;
        let totalPostsUsed = 0;
        
        for (const [userKey, user] of Object.entries(metrics.users||{})){
          for (const [pid, p] of Object.entries(user.posts||{})){
            const postTime = getPostTimeStrict(p);
            if (!postTime || postTime < cutoffTime) continue;
            
            const windowEndTime = postTime + (timeWindowMinutes * 60 * 1000);
            let maxRemixes = 0;
            for (const s of (p.snapshots||[])){
              const remixCount = s.remix_count ?? s.remixes ?? null;
              if (s.t <= windowEndTime && remixCount != null){
                maxRemixes = Math.max(maxRemixes, Number(remixCount));
              }
            }
            
            if (maxRemixes > 0){
              totalPostsUsed++;
              const postDate = new Date(postTime);
              const hour = postDate.getHours();
              const minute = postDate.getMinutes();
              const dayOfWeek = postDate.getDay();
              
              const minuteBucket = Math.floor(minute / bucketSizeMinutes) * bucketSizeMinutes;
              const timeKey = `${hour}:${minuteBucket}`;
              
              if (!timeStats.has(timeKey)){
                timeStats.set(timeKey, { 
                  count: 0, 
                  totalRemixes: 0,
                  dayOfWeek: new Map(),
                  times: []
                });
              }
              const stats = timeStats.get(timeKey);
              stats.count++;
              stats.totalRemixes += maxRemixes;
              stats.times.push({ hour, minute, dayOfWeek });
              
              if (!stats.dayOfWeek.has(dayOfWeek)){
                stats.dayOfWeek.set(dayOfWeek, 0);
              }
              stats.dayOfWeek.set(dayOfWeek, stats.dayOfWeek.get(dayOfWeek) + 1);
            }
          }
        }
        
        if (timeStats.size === 0) return null;
        
        // Find top 3 time buckets with highest average remixes
        const timeBuckets = Array.from(timeStats.entries())
          .map(([timeKey, stats]) => ({
            timeKey,
            avg: stats.totalRemixes / stats.count,
            count: stats.count,
            stats
          }))
          .sort((a, b) => b.avg - a.avg)
          .slice(0, 3);

        if (timeBuckets.length === 0) return null;

        // Create time range from top buckets - use tighter range for better accuracy
        const times = timeBuckets.flatMap(bucket => bucket.stats.times)
          .sort((a, b) => {
            if (a.hour !== b.hour) return a.hour - b.hour;
            return a.minute - b.minute;
          });

        // Format as time range
        const formatTime = (hour, minute) => {
          const hour12 = hour % 12 || 12;
          const minuteStr = String(minute).padStart(2, '0');
          const ampm = hour >= 12 ? 'PM' : 'AM';
          return `${hour12}:${minuteStr} ${ampm}`;
        };

        // Calculate median time for more accurate best time
        const medianIdx = Math.floor(times.length / 2);
        const medianTime = times[medianIdx];
        const bestHour = medianTime.hour;
        const bestMinute = medianTime.minute;

        let timeRangeStr;
        if (times.length <= 5) {
          // If few posts, show single time
          timeRangeStr = formatTime(medianTime.hour, medianTime.minute);
        } else {
          // Use interquartile range (25th to 75th percentile) for tighter, more accurate range
          const q1Idx = Math.floor(times.length * 0.25);
          const q3Idx = Math.floor(times.length * 0.75);
          const q1Time = times[q1Idx];
          const q3Time = times[q3Idx];
          
          // If the range is still too broad (>3 hours), use median ±1 hour
          const q1Minutes = q1Time.hour * 60 + q1Time.minute;
          const q3Minutes = q3Time.hour * 60 + q3Time.minute;
          const rangeMinutes = q3Minutes - q1Minutes;
          
          if (rangeMinutes > 180) { // More than 3 hours
            // Use median ±1 hour for tighter range
            const medianMinutes = bestHour * 60 + bestMinute;
            const startMinutes = Math.max(0, medianMinutes - 60);
            const endMinutes = Math.min(1439, medianMinutes + 60);
            const startHour = Math.floor(startMinutes / 60) % 24;
            const startMin = startMinutes % 60;
            const endHour = Math.floor(endMinutes / 60) % 24;
            const endMin = endMinutes % 60;
            timeRangeStr = `${formatTime(startHour, startMin)} - ${formatTime(endHour, endMin)}`;
          } else {
            // Use interquartile range
            timeRangeStr = `${formatTime(q1Time.hour, q1Time.minute)} - ${formatTime(q3Time.hour, q3Time.minute)}`;
          }
        }

        // Find most common day of week across all top buckets
        const dayOfWeekMap = new Map();
        for (const bucket of timeBuckets) {
          for (const [day, count] of bucket.stats.dayOfWeek.entries()) {
            dayOfWeekMap.set(day, (dayOfWeekMap.get(day) || 0) + count);
          }
        }

        let bestDayOfWeek = null;
        let bestDayCount = 0;
        for (const [day, count] of dayOfWeekMap.entries()){
          if (count > bestDayCount){
            bestDayCount = count;
            bestDayOfWeek = day;
          }
        }
        
        const date = new Date();
        date.setHours(bestHour, bestMinute, 0, 0);

        const tzStr = date.toLocaleTimeString('en-US', {
          timeZoneName: 'short'
        }).split(' ').pop();

        const dayStr = bestDayOfWeek != null ? dayNames[bestDayOfWeek] : '';

        return {
          timeStr: `${timeRangeStr} ${tzStr}`,
          dayStr: dayStr ? ` on ${dayStr}` : '',
          postCount: totalPostsUsed
        };
      }
      
      const yearResult = calculateBestTimeForRange(365);
      const monthResult = calculateBestTimeForRange(30);
      const weekResult = calculateBestTimeForRange(7);
      
      return {
        year: yearResult,
        month: monthResult,
        week: weekResult
      };
    }

    // Function to render best time grid
    function renderBestTimeGrid(gridElement, bestTimes, postCountYear, postCountMonth, postCountWeek){
      if (!gridElement) return;

      gridElement.innerHTML = '';

      const renderTimeString = (timeData) => {
        if (!timeData) return null;

        // Handle time ranges (contains dash) vs single times
        // Format: "12:30 AM - 2:29 PM ET" or "3:03 PM ET"
        if (timeData.timeStr.includes(' - ')) {
          // Range format: "12:30 AM - 2:29 PM ET"
          const parts = timeData.timeStr.split(' - ');
          const startPart = parts[0].trim(); // "12:30 AM"
          const endPart = parts[1].trim(); // "2:29 PM ET"
          
          // Parse start time: keep space between time and AM/PM
          const startParts = startPart.split(' ');
          const startTime = `${startParts[0]} ${startParts[1]}`; // "12:30 AM"
          
          // Parse end time: keep space between time and AM/PM, extract timezone
          const endParts = endPart.split(' ');
          const endTime = `${endParts[0]} ${endParts[1]}`; // "2:29 PM"
          const timezone = endParts[2] || ''; // "ET" or user's timezone
          
          return `${startTime} - ${endTime} ${timezone}`;
        } else {
          // Single time format: "3:03 PM ET"
          const parts = timeData.timeStr.split(' ');
          const hourMinute = parts[0]; // "3:03"
          const ampm = parts[1]; // "PM"
          const timezone = parts[2] || ''; // "ET" or user's timezone
          return `${hourMinute} ${ampm} ${timezone}`;
        }
      };

      const renderDayString = (timeData) => {
        if (!timeData) return null;
        if (timeData.dayStr) {
          return timeData.dayStr.replace(' on ', '');
        }
        return 'No strong preference';
      };

      // Create column for Week
      const weekColumn = document.createElement('div');
      weekColumn.className = 'best-time-column';
      
      if (bestTimes.week) {
        weekColumn.innerHTML = `
          <div class="best-time-column-label">Based on</div>
          <div class="best-time-column-count">${postCountWeek.toLocaleString()} posts</div>
          <div class="best-time-column-period">this week</div>
          <div class="best-time-column-label" style="margin-top: 12px;">Post between</div>
          <div class="best-time-column-time">${renderTimeString(bestTimes.week)}</div>
          <div class="best-time-column-day">on ${renderDayString(bestTimes.week)}</div>
        `;
      } else {
        weekColumn.innerHTML = '<div class="best-time-column-na">N/A</div>';
      }
      gridElement.appendChild(weekColumn);

      // Create column for Month
      const monthColumn = document.createElement('div');
      monthColumn.className = 'best-time-column';
      
      if (bestTimes.month) {
        monthColumn.innerHTML = `
          <div class="best-time-column-label">Based on</div>
          <div class="best-time-column-count">${postCountMonth.toLocaleString()} posts</div>
          <div class="best-time-column-period">this month</div>
          <div class="best-time-column-label" style="margin-top: 12px;">Post between</div>
          <div class="best-time-column-time">${renderTimeString(bestTimes.month)}</div>
          <div class="best-time-column-day">on ${renderDayString(bestTimes.month)}</div>
        `;
      } else {
        monthColumn.innerHTML = '<div class="best-time-column-na">N/A</div>';
      }
      gridElement.appendChild(monthColumn);

      // Create column for Year
      const yearColumn = document.createElement('div');
      yearColumn.className = 'best-time-column';
      
      if (bestTimes.year) {
        yearColumn.innerHTML = `
          <div class="best-time-column-label">Based on</div>
          <div class="best-time-column-count">${postCountYear.toLocaleString()} posts</div>
          <div class="best-time-column-period">this year</div>
          <div class="best-time-column-label" style="margin-top: 12px;">Post between</div>
          <div class="best-time-column-time">${renderTimeString(bestTimes.year)}</div>
          <div class="best-time-column-day">on ${renderDayString(bestTimes.year)}</div>
        `;
      } else {
        yearColumn.innerHTML = '<div class="best-time-column-na">N/A</div>';
      }
      gridElement.appendChild(yearColumn);
    }

    // Function to update best time to post section
    function updateBestTimeToPostSection(){
      const bestTimesViews = calculateBestPostTimeFromAllUsers();
      const bestTimesLikes = calculateBestPostTimeForLikes();
      const bestTimesRemixes = calculateBestPostTimeForRemixes();
      
      // Render grids
      renderBestTimeGrid($('#bestTimeViewsGrid'), bestTimesViews, 
        bestTimesViews.year?.postCount || 0, 
        bestTimesViews.month?.postCount || 0, 
        bestTimesViews.week?.postCount || 0);
      renderBestTimeGrid($('#bestTimeLikesGrid'), bestTimesLikes,
        bestTimesLikes.year?.postCount || 0,
        bestTimesLikes.month?.postCount || 0,
        bestTimesLikes.week?.postCount || 0);
      renderBestTimeGrid($('#bestTimeRemixesGrid'), bestTimesRemixes,
        bestTimesRemixes.year?.postCount || 0,
        bestTimesRemixes.month?.postCount || 0,
        bestTimesRemixes.week?.postCount || 0);
    }

    // Function to update first 24 hours chart
    function updateFirst24HoursChart(timeWindowMinutes){
      const user = resolveUserForKey(metrics, currentUserKey);
      if (!user) return;
      const colorFor = makeColorMap(user);
      const useUnique = viewsChartType === 'unique';
      const f24Series = (function(){
        const out=[]; for (const [pid,p] of Object.entries(user.posts||{})){
          if (!visibleSet.has(pid)) continue;
          const postTime = getPostTimeStrict(p) || getPostTimeForRecency(p);
          if (!postTime) continue; // Skip posts without any time reference
          const pts=[]; for (const s of (p.snapshots||[])){ 
            const t=s.t; 
            const v=useUnique ? s.uv : s.views; 
            if (t!=null && v!=null) pts.push({ x:Number(t), y:Number(v), t:Number(t) }); 
          }
          const owner = user?.__specialKey === TOP_TODAY_KEY ? (p?.ownerHandle || '') : (user?.handle || '');
          const color=colorFor(pid); const label = buildPostLabel({ ...p, id: pid }, owner);
          // Include all posts with post_time, even if they have no snapshots or no snapshots in the time window
          out.push({ id: pid, label, color, points: pts, url: absUrl(p.url, pid), postTime: postTime }); }
        return out; })();
      const yAxisLabel = useUnique ? 'Unique Views' : 'Total Views';
      first24HoursChart.setData(f24Series, timeWindowMinutes);
      // Update chart label by recreating it with new label
      const canvas = $('#first24HoursChart');
      if (canvas) {
        // The chart function doesn't expose a way to change the label, so we need to update it internally
        // For now, we'll just update the data and the chart will use the label from when it was created
        // We'll need to recreate the chart or modify makeFirst24HoursChart to accept label updates
      }
    }

    function updateViewsPerPersonChart(timeWindowMinutes){
      const user = resolveUserForKey(metrics, currentUserKey);
      if (!user) return;
      const colorFor = makeColorMap(user);
      const vppSeries = (function(){
        const out=[]; for (const [pid,p] of Object.entries(user.posts||{})){
          if (!visibleSet.has(pid)) continue;
          const postTime = getPostTimeStrict(p) || getPostTimeForRecency(p);
          if (!postTime) continue; // Skip posts without any time reference
          const pts=[]; for (const s of (p.snapshots||[])){ 
            const t=s.t; 
            const totalViews = num(s.views);
            const uniqueViews = num(s.uv);
            // Only include if we have both values and unique views > 0
            if (t!=null && totalViews!=null && uniqueViews!=null && uniqueViews > 0) {
              const vpp = Number((totalViews / uniqueViews).toFixed(2));
              pts.push({ x:Number(t), y:vpp, t:Number(t) }); 
            }
          }
          const owner = user?.__specialKey === TOP_TODAY_KEY ? (p?.ownerHandle || '') : (user?.handle || '');
          const color=colorFor(pid); const label = buildPostLabel({ ...p, id: pid }, owner);
          // Include all posts with post_time, even if they have no snapshots or no snapshots in the time window
          out.push({ id: pid, label, color, points: pts, url: absUrl(p.url, pid), postTime: postTime }); }
        return out; })();
      viewsPerPersonChart.setData(vppSeries, timeWindowMinutes);
    }

	    async function refreshUserUI(opts={}){
	      const { preserveEmpty=false, skipRestoreZoom=false } = opts;
	      const user = resolveUserForKey(metrics, currentUserKey);
	      // Always reset list actions to "Show All" on initial dashboard open,
	      // even if there is no selected user yet.
	      if (forceShowAllOnLoad) setListActionActive('showAll');
	      if (!user){
	        buildPostsList(null, ()=>COLORS[0], new Set()); chart.setData([]); return;
	      }
      // No precompute needed for IR; use latest available remix count only for cards
      // Integrity check: remove posts incorrectly attributed to this user
      // Reconcile ownership (selected user only), then reclaim, then remove empty posts
      if (!isTopTodayKey(currentUserKey)){
        await pruneMismatchedPostsForUser(metrics, currentUserKey);
        await reclaimFromUnknownForUser(metrics, currentUserKey);
        await pruneEmptyPostsForUser(metrics, currentUserKey);
      }
	      const colorFor = makeColorMap(user);
	      if (isTopTodayKey(currentUserKey)){
          visibleSet.clear();
          Object.keys(user.posts||{}).forEach(pid=>visibleSet.add(pid));
          setListActionActive('showAll');
          forceShowAllOnLoad = false;
        } else if (forceShowAllOnLoad){
	        visibleSet.clear();
	        Object.keys(user.posts||{}).forEach(pid=>visibleSet.add(pid));
	        setListActionActive('showAll');
	        forceShowAllOnLoad = false;
	      } else if (visibleSet.size === 0 && !preserveEmpty){
	        // Restore from saved state (including empty) or default to last 20 most recent posts when no saved state
	        if (Object.prototype.hasOwnProperty.call(visibilityByUser, currentUserKey)){
	          const saved = visibilityByUser[currentUserKey];
	          if (Array.isArray(saved)) saved.forEach(pid=>visibleSet.add(pid));
	        } else {
          // Only include posts with a valid post_time when choosing the default 20
          const dated = Object.entries(user.posts||{})
            .map(([pid,p])=>({ pid, t: getPostTimeStrict(p) || 0 }))
            .filter(it=>it.t>0)
            .sort((a,b)=>b.t-a.t);
          if (dated.length){
            dated.slice(0,20).forEach(it=>visibleSet.add(it.pid));
          } else {
            // Fallback: choose by GUID numeric (descending) when no post_time
            const fallback = Object.keys(user.posts||{})
              .map(pid=>({ pid, bi: pidBigInt(pid) }))
              .sort((a,b)=> (a.bi===b.bi ? a.pid.localeCompare(b.pid) : (a.bi < b.bi ? 1 : -1)));
            fallback.slice(0,20).forEach(it=>visibleSet.add(it.pid));
          }
        }
      }
      buildPostsList(user, colorFor, visibleSet, { 
        activeActionId: currentListActionId,
        onHover: (pid)=> { chart.setHoverSeries(pid); viewsChart.setHoverSeries(pid); first24HoursChart.setHoverSeries(pid); viewsPerPersonChart.setHoverSeries(pid); },
        onPurge: (pid, snippet) => showPostPurgeConfirm(snippet, pid)
      });
      const useUnique = viewsChartType === 'unique';
      const series = computeSeriesForUser(user, [], colorFor, useUnique)
        .filter(s=>visibleSet.has(s.id))
        .map(s=>({ ...s, url: absUrl(user.posts?.[s.id]?.url, s.id) }));
      chart.setData(series);
      // Time chart: cumulative views by time
      const vSeries = (function(){
        const out=[]; for (const [pid,p] of Object.entries(user.posts||{})){
          if (!visibleSet.has(pid)) continue; 
          const pts=[]; 
          for (const s of (p.snapshots||[])){ 
            const t=s.t; 
            const v=useUnique ? s.uv : s.views; 
            if (t!=null && v!=null) pts.push({ x:Number(t), y:Number(v), t:Number(t) }); 
          }
          const color=colorFor(pid); 
          const owner = user?.__specialKey === TOP_TODAY_KEY ? (p?.ownerHandle || '') : (user?.handle || '');
          const label = buildPostLabel({ ...p, id: pid }, owner); 
          if (pts.length) out.push({ id: pid, label, color, points: pts, url: absUrl(p.url, pid) }); 
        }
        return out; })();
      viewsChart.setData(vSeries);
      // Views Per Person chart: total views / unique views over time since post creation
      updateViewsPerPersonChart(parseInt($('#viewsPerPersonSlider')?.value) || 1440);
      // First 24 hours chart: views over time since post creation
      updateFirst24HoursChart(parseInt($('#first24HoursSlider')?.value) || 1440);
      // Only update compare charts if no compare users are selected
      if (compareUsers.size === 0){
        // Update unfiltered totals cards for single user
        try {
          const t = computeTotalsForUser(user);
          const allTotalViewsEl = $('#allTotalViewsTotal'); if (allTotalViewsEl) allTotalViewsEl.textContent = fmt2(t.views);
          const allUniqueViewsEl = $('#allUniqueViewsTotal'); if (allUniqueViewsEl) allUniqueViewsEl.textContent = fmt2(t.uniqueViews);
          const allLikesEl = $('#allLikesTotal'); if (allLikesEl) allLikesEl.textContent = fmt2(t.likes);
          const allRepliesEl = $('#allRepliesTotal'); if (allRepliesEl) allRepliesEl.textContent = fmtK2OrInt(t.replies);
          const allRemixesEl = $('#allRemixesTotal'); if (allRemixesEl) allRemixesEl.textContent = fmt2(t.remixes);
          const allInterEl = $('#allInteractionsTotal'); if (allInterEl) allInterEl.textContent = fmt2(t.interactions);
          const allCameosEl = $('#allCameosTotal');
          if (allCameosEl) {
            const arr = Array.isArray(user.cameos) ? user.cameos : [];
            const last = arr[arr.length - 1];
            allCameosEl.textContent = last ? fmtK2OrInt(last.count) : '0';
          }
          const followersEl = $('#followersTotal');
          if (followersEl){
            const arr = Array.isArray(user.followers) ? user.followers : [];
            const last = arr[arr.length - 1];
            followersEl.textContent = last ? fmtK2OrInt(last.count) : '0';
          }
        } catch {}
        // All posts cumulative likes (unfiltered): aggregate across all posts
        try {
          const ptsLikes = (function(){
            const events = [];
            for (const [pid, p] of Object.entries(user.posts||{})){
              for (const s of (p.snapshots||[])){
                const t = Number(s.t), v = Number(s.likes);
                if (isFinite(t) && isFinite(v)) events.push({ t, v, pid });
              }
            }
            events.sort((a,b)=> a.t - b.t);
            const latest = new Map();
            let total = 0;
            const out = [];
            for (const e of events){
              const prev = latest.get(e.pid) || 0;
              if (e.v !== prev){
                latest.set(e.pid, e.v);
                total += (e.v - prev);
                out.push({ x: e.t, y: total, t: e.t });
              }
            }
            return out;
          })();
          const colorLikes = '#ff8a7a';
          const seriesLikes = ptsLikes.length ? [{ id: 'all_posts_likes', label: 'Likes', color: colorLikes, points: ptsLikes }] : [];
          allLikesChart.setData(seriesLikes);
        } catch {}
        // All posts cumulative views (unfiltered): aggregate across all posts
        try {
          const useUnique = compareViewsChartType === 'unique';
          const pts = (function(){
            const events = [];
            for (const [pid, p] of Object.entries(user.posts||{})){
              for (const s of (p.snapshots||[])){
                const t = Number(s.t);
                const v = useUnique ? Number(s.uv) : Number(s.views);
                if (isFinite(t) && isFinite(v)) events.push({ t, v, pid });
              }
            }
            events.sort((a,b)=> a.t - b.t);
            const latest = new Map();
            let total = 0;
            const out = [];
            for (const e of events){
              const prev = latest.get(e.pid) || 0;
              if (e.v !== prev){
                latest.set(e.pid, e.v);
                total += (e.v - prev);
                out.push({ x: e.t, y: total, t: e.t });
              }
            }
            return out;
          })();
          const color = '#7dc4ff';
          const label = useUnique ? 'Unique Views' : 'Total Views';
          const series = pts.length ? [{ id: 'all_posts', label, color, points: pts }] : [];
          const yAxisLabel = useUnique ? 'Unique Views' : 'Total Views';
          allViewsChart.setYAxisLabel(yAxisLabel);
          allViewsChart.setData(series);
        } catch {}
        // Cast in chart: use user-level cast in count history when available
        const cSeries = (function(){
          const arr = Array.isArray(user.cameos) ? user.cameos : [];
          const pts = arr.map(it=>({ x:Number(it.t), y:Number(it.count), t:Number(it.t) })).filter(p=>isFinite(p.x)&&isFinite(p.y));
          const color = '#95e06c';
          return pts.length ? [{ id: 'cameos', label: 'Cast in', color, points: pts }] : [];
        })();
        cameosChart.setData(cSeries);
        // Followers chart: use user-level follower history when available
        const fSeries = (function(){
          const arr = Array.isArray(user.followers) ? user.followers : [];
          const pts = arr.map(it=>({ x:Number(it.t), y:Number(it.count), t:Number(it.t) })).filter(p=>isFinite(p.x)&&isFinite(p.y));
          const color = '#ffd166';
          return pts.length ? [{ id: 'followers', label: 'Followers', color, points: pts }] : [];
        })();
        followersChart.setData(fSeries);
      } else {
        updateCompareCharts();
      }
      // Restore any saved zoom for this user (unless skipRestoreZoom is true)
      if (!skipRestoreZoom) {
        try {
          const z = zoomStates[currentUserKey] || {};
          if (z.scatter) chart.setZoom(z.scatter);
          if (z.viewsPerPerson) viewsPerPersonChart.setZoom(z.viewsPerPerson);
          if (z.views) viewsChart.setZoom(z.views);
          if (z.first24Hours) first24HoursChart.setZoom(z.first24Hours);
          if (z.likesAll) allLikesChart.setZoom(z.likesAll);
          if (z.cameos) cameosChart.setZoom(z.cameos);
          if (z.followers) followersChart.setZoom(z.followers);
          if (z.viewsAll) allViewsChart.setZoom(z.viewsAll);
        } catch {}
      }
      // Sync chart hover back to list - use current chart instances
      const currentChart = chart;
      const currentViewsPerPersonChart = viewsPerPersonChart;
      const currentViewsChart = viewsChart;
      const currentFirst24HoursChart = first24HoursChart;
      currentChart.onHover((pid)=>{
        const wrap = $('#posts');
        if (!wrap) return;
        if (pid){
          wrap.classList.add('is-hovering');
          $$('.post', wrap).forEach(r=>{ if (r.dataset.pid===pid) r.classList.add('hover'); else r.classList.remove('hover'); });
        } else {
          wrap.classList.remove('is-hovering');
          $$('.post', wrap).forEach(r=>r.classList.remove('hover'));
        }
        currentViewsPerPersonChart.setHoverSeries(pid);
        currentViewsChart.setHoverSeries(pid);
        currentFirst24HoursChart.setHoverSeries(pid);
      });
      currentViewsPerPersonChart.onHover((pid)=>{
        const wrap = $('#posts'); if (!wrap) return;
        if (pid){ wrap.classList.add('is-hovering'); $$('.post', wrap).forEach(r=>{ if (r.dataset.pid===pid) r.classList.add('hover'); else r.classList.remove('hover'); }); }
        else { wrap.classList.remove('is-hovering'); $$('.post', wrap).forEach(r=>r.classList.remove('hover')); }
        currentChart.setHoverSeries(pid);
        currentViewsChart.setHoverSeries(pid);
        currentFirst24HoursChart.setHoverSeries(pid);
      });
      currentViewsChart.onHover((pid)=>{
        const wrap = $('#posts'); if (!wrap) return;
        if (pid){ wrap.classList.add('is-hovering'); $$('.post', wrap).forEach(r=>{ if (r.dataset.pid===pid) r.classList.add('hover'); else r.classList.remove('hover'); }); }
        else { wrap.classList.remove('is-hovering'); $$('.post', wrap).forEach(r=>r.classList.remove('hover')); }
        currentChart.setHoverSeries(pid);
        currentViewsPerPersonChart.setHoverSeries(pid);
        currentFirst24HoursChart.setHoverSeries(pid);
      });
      currentFirst24HoursChart.onHover((pid)=>{
        const wrap = $('#posts'); if (!wrap) return;
        if (pid){ wrap.classList.add('is-hovering'); $$('.post', wrap).forEach(r=>{ if (r.dataset.pid===pid) r.classList.add('hover'); else r.classList.remove('hover'); }); }
        else { wrap.classList.remove('is-hovering'); $$('.post', wrap).forEach(r=>r.classList.remove('hover')); }
        currentChart.setHoverSeries(pid);
        currentViewsPerPersonChart.setHoverSeries(pid);
        currentViewsChart.setHoverSeries(pid);
      });
      // wire visibility toggles
      $$('#posts .toggle').forEach(btn=>{
        btn.addEventListener('click', ()=>{
          const pid = btn.dataset.pid; const row = btn.closest('.post');
          if (visibleSet.has(pid)) { visibleSet.delete(pid); row.classList.add('hidden'); btn.textContent='Show'; }
          else { visibleSet.add(pid); row.classList.remove('hidden'); btn.textContent='Hide'; }
          // Fit to visible
          chart.resetZoom();
          viewsPerPersonChart.resetZoom();
          const useUnique = viewsChartType === 'unique';
          chart.setData(computeSeriesForUser(user, [], colorFor, useUnique).filter(s=>visibleSet.has(s.id)).map(s=>({ ...s, url: absUrl(user.posts?.[s.id]?.url, s.id) })));
          // Refresh the cumulative views time series to reflect current visibility
          const vSeries = (function(){
            const out=[]; for (const [vpid,p] of Object.entries(user.posts||{})){
              if (!visibleSet.has(vpid)) continue; const pts=[];
              for (const s of (p.snapshots||[])){
                const t=s.t; const v=useUnique ? s.uv : s.views; if (t!=null && v!=null) pts.push({ x:Number(t), y:Number(v), t:Number(t) });
              }
              const owner = user?.__specialKey === TOP_TODAY_KEY ? (p?.ownerHandle || '') : (user?.handle || '');
              const color=colorFor(vpid); const label=buildPostLabel({ ...p, id: vpid }, owner); if (pts.length) out.push({ id: vpid, label, color, points: pts, url: absUrl(p.url, vpid) });
            }
            return out; })();
          viewsChart.setData(vSeries);
          // Refresh Views Per Person chart
          updateViewsPerPersonChart(parseInt($('#viewsPerPersonSlider')?.value) || 1440);
          // Update first 24 hours chart
          updateFirst24HoursChart(parseInt($('#first24HoursSlider')?.value) || 1440);
          // (likes total chart is unfiltered; no need to refresh here)
          // Update metric cards to reflect current visibility
          try{
            const uniqueViewsEl = $('#uniqueViewsTotal');
            const totalViewsEl = $('#totalViewsTotal');
            const likesEl = $('#likesTotal');
            const repliesEl = $('#repliesTotal');
            const remixesEl = $('#remixesTotal');
            const interEl = $('#interactionsTotal');
            const cameosEl = $('#cameosTotal');
            const followersEl = $('#followersTotal');
            let totalUniqueViews = 0, totalViews = 0, totalLikes = 0, totalReplies = 0, totalRemixes = 0, totalInteractions = 0;
            for (const vpid of Array.from(visibleSet)){
              const post = user.posts?.[vpid];
              const last = latestSnapshot(post?.snapshots);
              totalUniqueViews += num(last?.uv);
              totalViews += num(last?.views);
              totalLikes += num(last?.likes);
              totalReplies += num(last?.comments);
              totalRemixes += num(latestRemixCountForPost(post));
              totalInteractions += interactionsOfSnap(last);
            }
            if (uniqueViewsEl) uniqueViewsEl.textContent = fmt2(totalUniqueViews);
            if (totalViewsEl) totalViewsEl.textContent = fmt2(totalViews);
            if (likesEl) likesEl.textContent = fmt2(totalLikes);
            if (repliesEl) repliesEl.textContent = fmtK2OrInt(totalReplies);
            if (remixesEl) remixesEl.textContent = fmt2(totalRemixes);
            if (interEl) interEl.textContent = fmt2(totalInteractions);
            // Update cameos and followers from user data (not post data)
            if (cameosEl) {
              const cameosArr = Array.isArray(user.cameos) ? user.cameos : [];
              const lastCameo = cameosArr.length > 0 ? cameosArr[cameosArr.length - 1] : null;
              cameosEl.textContent = lastCameo ? fmtK2OrInt(lastCameo.count) : '0';
            }
            if (followersEl) {
              const followersArr = Array.isArray(user.followers) ? user.followers : [];
              const lastFollower = followersArr.length > 0 ? followersArr[followersArr.length - 1] : null;
              followersEl.textContent = lastFollower ? fmtK2OrInt(lastFollower.count) : '0';
            }
          } catch {}
          persistVisibility();
        });
      });
    }

    $('#userSelect').addEventListener('change', async (e)=>{
      currentUserKey = e.target.value; visibleSet.clear();
      try { await chrome.storage.local.set({ lastUserKey: currentUserKey }); } catch {}
      // Reset to "Show All" when selecting a new user
      const u = resolveUserForKey(metrics, currentUserKey);
      if (u) {
        Object.keys(u.posts||{}).forEach(pid=>visibleSet.add(pid));
        chart.resetZoom();
        viewsPerPersonChart.resetZoom();
        viewsChart.resetZoom();
        followersChart.resetZoom();
        allViewsChart.resetZoom();
        allLikesChart.resetZoom();
        cameosChart.resetZoom();
      }
      // If exactly one user in compare, replace it with the new selection
      if (compareUsers.size === 1 && currentUserKey && resolveUserForKey(metrics, currentUserKey)){
        compareUsers.clear();
        addCompareUser(currentUserKey);
      }
      // If compare section is empty, add current user to show who we're looking at
      else if (compareUsers.size === 0 && currentUserKey && resolveUserForKey(metrics, currentUserKey)){
        addCompareUser(currentUserKey);
      }
      refreshUserUI({ preserveEmpty: true });
      persistVisibility();
    });

    // Views type toggle pills
    let isUpdatingViewsType = false; // Prevent recursive calls
    function updateViewsType(type){
      // Prevent accidental calls or recursive updates
      if (isUpdatingViewsType || viewsChartType === type) return;
      isUpdatingViewsType = true;
      
      try {
        viewsChartType = type;
        const uniquePill = $('#uniqueViewsPill');
        const totalPill = $('#totalViewsPill');
        if (uniquePill && totalPill) {
          if (type === 'unique') {
            uniquePill.classList.add('active');
            totalPill.classList.remove('active');
          } else {
            uniquePill.classList.remove('active');
            totalPill.classList.add('active');
          }
        }
      // Update chart labels
      const yAxisLabel = type === 'unique' ? 'Unique Views' : 'Total Views';
      const xAxisLabel = type === 'unique' ? 'Unique viewers' : 'Total viewers';
      const tooltipLabel = type === 'unique' ? 'Unique' : 'Total';
      
      chart.setAxisLabels(xAxisLabel, tooltipLabel);
      viewsChart.setYAxisLabel(yAxisLabel);
      first24HoursChart.setYAxisLabel(yAxisLabel);
      
      // Immediately clear data to prevent hovering over stale data from wrong mode
      chart.setData([]);
      viewsChart.setData([]);
      first24HoursChart.setData([]);
      
      // Refresh the UI to update chart data
        refreshUserUI({ skipRestoreZoom: true });
      } finally {
        isUpdatingViewsType = false;
      }
    }

    $('#uniqueViewsPill').addEventListener('click', (e)=>{
      e.stopPropagation();
      if (viewsChartType !== 'unique') updateViewsType('unique');
    });
    $('#totalViewsPill').addEventListener('click', (e)=>{
      e.stopPropagation();
      if (viewsChartType !== 'total') updateViewsType('total');
    });


    // Typeahead suggestions
    $('#search').addEventListener('input', (e)=>{
      const suggestions = $('#suggestions');
      const list = filterUsersByQuery(metrics, e.target.value).slice(0, 20);
      suggestions.innerHTML = list.map(([key,u])=>{
        const count = Object.keys(u.posts||{}).length;
        return `<div class="item" data-key="${esc(key)}"><span>${esc(u.handle||key)}</span><span style="color:#7d8a96">${count} posts</span></div>`;
      }).join('');
      suggestions.style.display = list.length ? 'block' : 'none';
      $$('#suggestions .item').forEach(it=>{
        it.addEventListener('click', async ()=>{
          currentUserKey = it.dataset.key; visibleSet.clear(); $('#search').value = ''; suggestions.style.display='none';
          const sel = $('#userSelect'); sel.value = currentUserKey;
          // Reset to "Show All" when selecting a new user
          const u = resolveUserForKey(metrics, currentUserKey);
          if (u) {
            Object.keys(u.posts||{}).forEach(pid=>visibleSet.add(pid));
            chart.resetZoom();
            viewsChart.resetZoom();
            followersChart.resetZoom();
            allViewsChart.resetZoom();
            allLikesChart.resetZoom();
            cameosChart.resetZoom();
          }
          // If exactly one user in compare, replace it with the new selection
          if (compareUsers.size === 1 && currentUserKey && resolveUserForKey(metrics, currentUserKey)){
            compareUsers.clear();
            addCompareUser(currentUserKey);
          }
          // If compare section is empty, add current user to show who we're looking at
          else if (compareUsers.size === 0 && currentUserKey && resolveUserForKey(metrics, currentUserKey)){
            addCompareUser(currentUserKey);
          }
          refreshUserUI();
          try { await chrome.storage.local.set({ lastUserKey: currentUserKey }); } catch {}
        });
      });
    });
    document.addEventListener('click', (e)=>{ if (!e.target.closest('.user-picker')) $('#suggestions').style.display='none'; });

    function buildCompareDropdown(){
      const sel = $('#compareUserSelect');
      if (!sel) return;
      sel.innerHTML = '<option value="">Select user to add…</option>';

      // Add "Top Today" as a virtual compare option
      if (!compareUsers.has(TOP_TODAY_KEY)){
        const topToday = buildTopTodayUser(metrics);
        const opt = document.createElement('option');
        opt.value = TOP_TODAY_KEY;
        opt.textContent = `${topToday.handle} (${Object.keys(topToday.posts||{}).length})`;
        sel.appendChild(opt);
      }

      const entries = Object.entries(metrics.users);
      const users = entries
        .filter(([key])=>!compareUsers.has(key))
        .sort((a,b)=>{
          const aCount = Object.keys(a[1].posts||{}).length;
          const bCount = Object.keys(b[1].posts||{}).length;
          if (aCount !== bCount) return bCount - aCount; // Descending order
          // If same post count, sort alphabetically
          const A = (a[1].handle||a[0]||'').toLowerCase();
          const B = (b[1].handle||b[0]||'').toLowerCase();
          return A.localeCompare(B);
        });
      users.forEach(([key, u])=>{
        const opt = document.createElement('option');
        opt.value = key;
        const postCount = Object.keys(u.posts||{}).length;
        opt.textContent = `${u.handle || key} (${postCount})`;
        sel.appendChild(opt);
      });
      sel.disabled = compareUsers.size >= MAX_COMPARE_USERS || (users.length === 0 && compareUsers.has(TOP_TODAY_KEY));
    }

    // Compare dropdown change handler
    $('#compareUserSelect').addEventListener('change', (e)=>{
      const userKey = e.target.value;
      if (userKey && !compareUsers.has(userKey)){
        addCompareUser(userKey);
        e.target.value = '';
      }
    });

    // Compare search typeahead
    $('#compareSearch').addEventListener('input', (e)=>{
      const suggestions = $('#compareSuggestions');
      const list = filterUsersByQuery(metrics, e.target.value)
        .filter(([key])=>!compareUsers.has(key))
        .slice(0, 20);
        suggestions.innerHTML = list.map(([key,u])=>{
          const count = Object.keys(u.posts||{}).length;
          return `<div class="item" data-key="${esc(key)}"><span>${esc(u.handle||key)}</span><span style="color:#7d8a96">${count} posts</span></div>`;
        }).join('');
      suggestions.style.display = list.length ? 'block' : 'none';
      $$('#compareSuggestions .item').forEach(it=>{
        it.addEventListener('click', ()=>{
          addCompareUser(it.dataset.key);
        });
      });
    });
    document.addEventListener('click', (e)=>{ if (!e.target.closest('.user-picker-compare')) $('#compareSuggestions').style.display='none'; });

    // Initialize compare pills and dropdown
    renderComparePills();
    buildCompareDropdown();

    // Purge Menu functionality
    const purgeModal = $('#purgeModal');
    const purgeConfirmDialog = $('#purgeConfirmDialog');
    const dateRangeSlider = $('#dateRangeSlider');
    const postCountSlider = $('#postCountSlider');
    const followerCountSlider = $('#followerCountSlider');
    const dateRangeValue = $('#dateRangeValue');
    const postCountValue = $('#postCountValue');
    const followerCountValue = $('#followerCountValue');
    const purgeReviewText = $('#purgeReviewText');
    const purgeConfirmText = $('#purgeConfirmText');
    const purgeStorageSize = $('#purgeStorageSize');
    const dateRangeFill = $('#dateRangeFill');
    const postCountFill = $('#postCountFill');
    const followerCountFill = $('#followerCountFill');
    const postPurgeConfirmDialog = $('#postPurgeConfirm');
    const postPurgeConfirmText = $('#postPurgeConfirmText');
    const postPurgeConfirmYes = $('#postPurgeConfirmYes');
    const postPurgeConfirmNo = $('#postPurgeConfirmNo');
    
    function showPostPurgeConfirm(snippet, pid){
      pendingPostPurge = { pid, userKey: currentUserKey, caption: snippet };
      if (postPurgeConfirmText) postPurgeConfirmText.textContent = `Are you sure you want to purge data tied to "${snippet}"?`;
      if (postPurgeConfirmDialog){
        postPurgeConfirmDialog.style.display = 'flex';
      } else {
        alert(`Are you sure you want to purge data tied to "${snippet}"?`);
      }
    }

    // Exceptions state
    const exceptedUsers = new Set();
    const MAX_EXCEPTED_USERS = 50;
    const EXCEPTIONS_STORAGE_KEY = 'purgeExceptions';
    const COMB_MODE_STORAGE_KEY = 'combModeEnabled';
    const COMB_MODE_LAST_RUN_KEY = 'combModeLastRun';
    let combModeEnabled = true; // Default to enabled
    let combModeDailyTimer = null;

    async function loadExceptedUsers(){
      try {
        const { [EXCEPTIONS_STORAGE_KEY]: saved = [] } = await chrome.storage.local.get(EXCEPTIONS_STORAGE_KEY);
        if (Array.isArray(saved)) {
          // Validate that users still exist in metrics
          const valid = saved.filter(userKey => metrics.users && metrics.users[userKey]);
          return new Set(valid);
        }
      } catch {}
      return new Set();
    }

    async function saveExceptedUsers(){
      try {
        await chrome.storage.local.set({ [EXCEPTIONS_STORAGE_KEY]: Array.from(exceptedUsers) });
      } catch {}
    }

    async function loadCombModePreference(){
      try {
        const { [COMB_MODE_STORAGE_KEY]: saved } = await chrome.storage.local.get(COMB_MODE_STORAGE_KEY);
        if (typeof saved === 'boolean') {
          combModeEnabled = saved;
        }
      } catch {}
      return combModeEnabled;
    }

    async function saveCombModePreference(){
      try {
        await chrome.storage.local.set({ [COMB_MODE_STORAGE_KEY]: combModeEnabled });
      } catch {}
    }

    async function updateStorageSizeDisplay(){
      try {
        // Get all storage data to calculate total size
        const allData = await chrome.storage.local.get(null);
        // Convert to JSON string to calculate byte size
        const jsonString = JSON.stringify(allData);
        const bytes = new Blob([jsonString]).size;
        // Convert to MB with 2 decimal places
        const mb = (bytes / (1024 * 1024)).toFixed(2);
        if (purgeStorageSize) {
          purgeStorageSize.textContent = `Sora Creator Tools currently uses ${mb}MB of memory.`;
        }
      } catch (e) {
        console.error('[Dashboard] Failed to calculate storage size', e);
        if (purgeStorageSize) {
          purgeStorageSize.textContent = 'Sora Creator Tools currently uses 0.00MB of memory.';
        }
      }
    }

    async function runCombModePurge(){
      if (!combModeEnabled) return;
      
      await chrome.storage.local.set({ purgeLock: Date.now() });
      try {
        const now = Date.now();
        const sevenDaysAgo = now - (7 * 24 * 60 * 60 * 1000);
        const sixtyMinutesMs = 60 * 60 * 1000;
        
        let purgedSnapshots = 0;
        metrics = await loadMetrics();
        
        // Process each user
        for (const [userKey, user] of Object.entries(metrics.users || {})){
          // Skip excepted users
          if (exceptedUsers.has(userKey)) continue;
          
          // Process each post
          for (const [postId, post] of Object.entries(user.posts || {})){
            if (!Array.isArray(post.snapshots) || post.snapshots.length === 0) continue;
            
            // Sort snapshots by timestamp
            const sortedSnapshots = [...post.snapshots].sort((a, b) => (a.t || 0) - (b.t || 0));
            const snapshotsToKeep = [];
            let lastKeptTime = null;
            
            // Process snapshots from oldest to newest
            for (let i = 0; i < sortedSnapshots.length; i++){
              const snap = sortedSnapshots[i];
              const snapTime = snap.t || 0;
              
              // Always keep snapshots newer than 7 days
              if (snapTime >= sevenDaysAgo) {
                snapshotsToKeep.push(snap);
                lastKeptTime = snapTime;
                continue;
              }
              
              // For snapshots older than 7 days, keep only if it's been at least 60 minutes
              // since the last kept snapshot (creates "every-60-minute view")
              // This "combs out" detailed/frequent snapshots, keeping only spaced-out ones
              if (lastKeptTime === null || (snapTime - lastKeptTime) >= sixtyMinutesMs) {
                snapshotsToKeep.push(snap);
                lastKeptTime = snapTime;
              } else {
                // This snapshot is within 60 minutes of another, delete it (detailed data)
                purgedSnapshots++;
              }
            }
            
            // Update post with filtered snapshots
            post.snapshots = snapshotsToKeep;
          }
        }
        
        // Save purged metrics
        if (purgedSnapshots > 0) {
          await chrome.storage.local.set({ metrics });
          // Update last run time
          await chrome.storage.local.set({ [COMB_MODE_LAST_RUN_KEY]: now });
          console.log(`[Comb Mode] Purged ${purgedSnapshots} snapshot(s)`);
          // Update storage size display if purge modal is open
          if (purgeModal && purgeModal.style.display !== 'none') {
            await updateStorageSizeDisplay();
          }
        }
      } catch (e) {
        console.error('[Comb Mode] Purge failed', e);
      } finally {
        await chrome.storage.local.remove('purgeLock');
      }
    }

    function scheduleCombModeDaily(){
      // Clear existing timer if any
      if (combModeDailyTimer) {
        clearTimeout(combModeDailyTimer);
        combModeDailyTimer = null;
      }
      
      if (!combModeEnabled) return;
      
      async function scheduleNextRun(){
        try {
          const now = Date.now();
          const { [COMB_MODE_LAST_RUN_KEY]: lastRun } = await chrome.storage.local.get(COMB_MODE_LAST_RUN_KEY);
          
          // Calculate next run time (24 hours from last run, or immediately if never run)
          const nextRunTime = lastRun ? lastRun + (24 * 60 * 60 * 1000) : now;
          const delay = Math.max(0, nextRunTime - now);
          
          combModeDailyTimer = setTimeout(async () => {
            await runCombModePurge();
            // Schedule next run
            scheduleNextRun();
          }, delay);
        } catch (e) {
          console.error('[Comb Mode] Failed to schedule daily purge', e);
        }
      }
      
      scheduleNextRun();
    }

    function getPurgeDescription(){
      const days = Number(dateRangeSlider.value);
      const minPosts = Number(postCountSlider.value);
      const minFollowers = Number(followerCountSlider.value);
      
      let description = '';
      const daysText = days === 365 ? '1 year' : `${days} ${days === 1 ? 'day' : 'days'}`;
      
      if (days === 365 && minPosts === 0 && minFollowers === 0) {
        description = 'all data outside the last 1 year';
      } else if (days < 365 && minPosts > 0 && minFollowers > 0) {
        const postsText = minPosts === 1 ? `${minPosts} post` : `${minPosts} posts`;
        const followersText = fmt(minFollowers);
        description = `all data outside the last ${daysText} for users with less than ${postsText} and less than ${followersText} followers`;
      } else if (days === 365 && minPosts > 0 && minFollowers > 0) {
        const postsText = minPosts === 1 ? `${minPosts} post` : `${minPosts} posts`;
        const followersText = fmt(minFollowers);
        description = `all data outside the last 1 year for users with less than ${postsText} and less than ${followersText} followers`;
      } else if (days < 365 && minPosts > 0) {
        const postsText = minPosts === 1 ? `${minPosts} post` : `${minPosts} posts`;
        description = `all data outside the last ${daysText} for users with less than ${postsText}`;
      } else if (days === 365 && minPosts > 0) {
        const postsText = minPosts === 1 ? `${minPosts} post` : `${minPosts} posts`;
        description = `all data outside the last 1 year for users with less than ${postsText}`;
      } else if (days < 365 && minFollowers > 0) {
        const followersText = fmt(minFollowers);
        description = `all data outside the last ${daysText} for users with less than ${followersText} followers`;
      } else if (days === 365 && minFollowers > 0) {
        const followersText = fmt(minFollowers);
        description = `all data outside the last 1 year for users with less than ${followersText} followers`;
      } else if (days < 365) {
        description = `all data outside the last ${daysText}`;
      } else {
        description = 'all data outside the last 1 year';
      }
      
      // Add exceptions clause
      if (exceptedUsers.size > 0) {
        const exceptedHandles = Array.from(exceptedUsers).map(userKey => {
          const user = metrics.users[userKey];
          return user?.handle || userKey;
        });
        let exceptText = '';
        if (exceptedHandles.length === 1) {
          exceptText = `except for any data from ${exceptedHandles[0]}`;
        } else if (exceptedHandles.length === 2) {
          exceptText = `except for any data from ${exceptedHandles[0]} and ${exceptedHandles[1]}`;
        } else {
          exceptText = `except for any data from ${exceptedHandles.slice(0, -1).join(', ')}, and ${exceptedHandles[exceptedHandles.length - 1]}`;
        }
        description += ' ' + exceptText;
      }
      
      return description;
    }

    function updatePurgeReview(){
      const description = getPurgeDescription();
      purgeReviewText.textContent = 'You are about to purge ' + description + '.';
    }

    function updateSliderFills(){
      const days = Number(dateRangeSlider.value);
      const minPosts = Number(postCountSlider.value);
      const minFollowers = Number(followerCountSlider.value);
      
      // Date range: fill represents how much we're keeping (higher = more kept)
      const datePct = (days / 365) * 100;
      dateRangeFill.style.width = Math.min(100, Math.max(0, datePct)) + '%';
      
      // Post count: fill represents threshold (higher = more kept)
      const postPct = (minPosts / 100) * 100;
      postCountFill.style.width = Math.min(100, Math.max(0, postPct)) + '%';
      
      // Follower count: fill represents threshold (higher = more kept)
      const followerPct = (minFollowers / 10000) * 100;
      followerCountFill.style.width = Math.min(100, Math.max(0, followerPct)) + '%';
    }

    function updateSliderValues(){
      const days = Number(dateRangeSlider.value);
      const minPosts = Number(postCountSlider.value);
      const minFollowers = Number(followerCountSlider.value);
      
      dateRangeValue.textContent = days === 365 ? '1 year' : `${days} ${days === 1 ? 'day' : 'days'}`;
      postCountValue.textContent = `${minPosts} ${minPosts === 1 ? 'post' : 'posts'}`;
      followerCountValue.textContent = `${fmt(minFollowers)} followers`;
      
      updateSliderFills();
      updatePurgeReview();
    }

    $('#purgeModalClose').addEventListener('click', ()=>{
      purgeModal.style.display = 'none';
      purgeConfirmDialog.style.display = 'none';
    });

    purgeModal.addEventListener('mousedown', (e)=>{
      if (e.target === purgeModal) {
        purgeModal.style.display = 'none';
        purgeConfirmDialog.style.display = 'none';
      }
    });

    dateRangeSlider.addEventListener('input', updateSliderValues);
    postCountSlider.addEventListener('input', updateSliderValues);
    followerCountSlider.addEventListener('input', updateSliderValues);

    // Comb Mode checkbox handler
    const combModeCheckbox = $('#combModeCheckbox');
    if (combModeCheckbox) {
      combModeCheckbox.addEventListener('change', async (e) => {
        combModeEnabled = e.target.checked;
        await saveCombModePreference();
        // Reschedule daily timer based on new preference
        scheduleCombModeDaily();
      });
    }

    // Exceptions functionality
    function buildExceptionsDropdown(){
      const sel = $('#exceptionsUserSelect');
      if (!sel) return;
      sel.innerHTML = '<option value="">Select user to except…</option>';
      const entries = Object.entries(metrics.users);
      const users = entries
        .filter(([key])=>!exceptedUsers.has(key))
        .sort((a,b)=>{
          const aCount = Object.keys(a[1].posts||{}).length;
          const bCount = Object.keys(b[1].posts||{}).length;
          if (aCount !== bCount) return bCount - aCount; // Descending order
          // If same post count, sort alphabetically
          const A = (a[1].handle||a[0]||'').toLowerCase();
          const B = (b[1].handle||b[0]||'').toLowerCase();
          return A.localeCompare(B);
        });
      users.forEach(([key, u])=>{
        const opt = document.createElement('option');
        opt.value = key;
        const postCount = Object.keys(u.posts||{}).length;
        opt.textContent = `${u.handle || key} (${postCount})`;
        sel.appendChild(opt);
      });
      sel.disabled = exceptedUsers.size >= MAX_EXCEPTED_USERS || users.length === 0;
    }

    function renderExceptionPills(){
      const container = $('#exceptionsPills');
      if (!container) return;
      container.innerHTML = '';
      const users = Array.from(exceptedUsers);
      users.forEach((userKey)=>{
        const user = metrics.users[userKey];
        const handle = user?.handle || userKey;
        const pill = document.createElement('div');
        pill.className = 'exception-pill';
        pill.dataset.userKey = userKey;
        const nameSpan = document.createElement('span');
        nameSpan.className = 'exception-pill-name';
        nameSpan.textContent = handle;
        const removeBtn = document.createElement('span');
        removeBtn.className = 'exception-pill-remove';
        removeBtn.textContent = '×';
        removeBtn.onclick = async (e)=>{
          e.stopPropagation();
          exceptedUsers.delete(userKey);
          await saveExceptedUsers();
          renderExceptionPills();
          buildExceptionsDropdown();
          updatePurgeReview();
        };
        pill.appendChild(nameSpan);
        pill.appendChild(removeBtn);
        container.appendChild(pill);
      });
      if (exceptedUsers.size < MAX_EXCEPTED_USERS){
        const addBtn = document.createElement('button');
        addBtn.className = 'exceptions-add-btn';
        addBtn.textContent = '+';
        addBtn.title = 'Add user';
        addBtn.onclick = ()=>{
          $('#exceptionsSearch').focus();
        };
        container.appendChild(addBtn);
      }
      const searchInput = $('#exceptionsSearch');
      if (searchInput) searchInput.disabled = exceptedUsers.size >= MAX_EXCEPTED_USERS;
    }

    async function addExceptedUser(userKey){
      if (exceptedUsers.size >= MAX_EXCEPTED_USERS) return;
      if (!metrics.users[userKey]) return;
      if (exceptedUsers.has(userKey)) return;
      exceptedUsers.add(userKey);
      await saveExceptedUsers();
      renderExceptionPills();
      buildExceptionsDropdown();
      updatePurgeReview();
      $('#exceptionsSearch').value = '';
      $('#exceptionsSuggestions').style.display = 'none';
    }

    $('#exceptionsUserSelect').addEventListener('change', async (e)=>{
      const userKey = e.target.value;
      if (userKey && !exceptedUsers.has(userKey)){
        await addExceptedUser(userKey);
        e.target.value = '';
      }
    });

    $('#exceptionsSearch').addEventListener('input', (e)=>{
      const suggestions = $('#exceptionsSuggestions');
      const list = filterUsersByQuery(metrics, e.target.value)
        .filter(([key])=>!exceptedUsers.has(key))
        .slice(0, 20);
        suggestions.innerHTML = list.map(([key,u])=>{
          const count = Object.keys(u.posts||{}).length;
          return `<div class="item" data-key="${esc(key)}"><span>${esc(u.handle||key)}</span><span style="color:#7d8a96">${count} posts</span></div>`;
        }).join('');
      suggestions.style.display = list.length ? 'block' : 'none';
      $$('#exceptionsSuggestions .item').forEach(it=>{
        it.addEventListener('click', async ()=>{
          await addExceptedUser(it.dataset.key);
        });
      });
    });
    document.addEventListener('click', (e)=>{ if (!e.target.closest('.user-picker-exceptions')) $('#exceptionsSuggestions').style.display='none'; });

    $('#purgeMenu').addEventListener('click', async ()=>{
      purgeModal.style.display = 'block';
      // Load saved exceptions
      const saved = await loadExceptedUsers();
      exceptedUsers.clear();
      saved.forEach(key => exceptedUsers.add(key));
      renderExceptionPills();
      buildExceptionsDropdown();
      updateSliderValues();
      // Load comb mode preference
      await loadCombModePreference();
      const combModeCheckbox = $('#combModeCheckbox');
      if (combModeCheckbox) {
        combModeCheckbox.checked = combModeEnabled;
      }
      // Update storage size display
      await updateStorageSizeDisplay();
    });

    $('#purgeExecute').addEventListener('click', ()=>{
      const description = getPurgeDescription();
      purgeConfirmText.textContent = `Are you sure you want to purge ${description}?`;
      purgeConfirmDialog.style.display = 'flex';
    });

    $('#purgeConfirmNo').addEventListener('click', ()=>{
      purgeConfirmDialog.style.display = 'none';
    });

    $('#purgeConfirmYes').addEventListener('click', async ()=>{
      // Set purge lock to prevent concurrent writes from content script
      await chrome.storage.local.set({ purgeLock: Date.now() });

      const days = Number(dateRangeSlider.value);
      const minPosts = Number(postCountSlider.value);
      const minFollowers = Number(followerCountSlider.value);
      
      const cutoffTime = Date.now() - (days * 24 * 60 * 60 * 1000);
      
      // Helper to get post time with snapshot fallback for purge
      function getPostTimeForPurge(post) {
        // First try explicit post time fields
        let t = getPostTimeStrict(post);
        if (t > 0) return t;
        
        // Fallback: use the earliest snapshot timestamp
        if (Array.isArray(post.snapshots) && post.snapshots.length > 0) {
          const times = post.snapshots.map(s => s.t || 0).filter(t => t > 0);
          if (times.length > 0) {
            return Math.min(...times); // Return earliest snapshot time
          }
        }
        
        // No timestamp available
        return 0;
      }
      
      try {
        metrics = await loadMetrics();
        let purgedUsers = 0;
        let purgedPosts = 0;
        
        console.log('[Purge] Starting purge with cutoff:', new Date(cutoffTime).toISOString(), 'excepted users:', Array.from(exceptedUsers));
        
        // Process each user
        for (const [userKey, user] of Object.entries(metrics.users || {})){
          // Skip excepted users
          if (exceptedUsers.has(userKey)) continue;
          
          // Ensure posts object exists
          if (!user.posts) user.posts = {};
          
          // Get follower count for later use
          const followersArr = Array.isArray(user.followers) ? user.followers : [];
          const latestFollowers = followersArr.length > 0 ? Number(followersArr[followersArr.length - 1]?.count) : 0;
          
          // ALWAYS purge posts by date first (if days is set and <= 365)
          // This ensures all old posts are removed regardless of minPosts/minFollowers settings
          let postsToKeep = {};
          const originalPostCount = Object.keys(user.posts || {}).length;
          if (days <= 365) {
            // Purge posts older than cutoff time
            for (const [pid, post] of Object.entries(user.posts || {})){
              const postTime = getPostTimeForPurge(post);
              // Keep posts that have a timestamp AND are within the cutoff time
              // Posts without timestamps are purged (considered old/unknown)
              if (postTime > 0 && postTime >= cutoffTime){
                postsToKeep[pid] = post;
              } else {
                purgedPosts++;
              }
            }
            const purgedCount = originalPostCount - Object.keys(postsToKeep).length;
            if (purgedCount > 0) {
              console.log(`[Purge] User ${user.handle || userKey}: removed ${purgedCount}/${originalPostCount} posts`);
            }
          } else {
            // If days > 365, keep all posts (no date-based purging)
            postsToKeep = { ...user.posts };
          }
          
          // Update user's posts with purged list
          user.posts = postsToKeep;
          
          // Now check if user should be kept based on minPosts/minFollowers criteria
          const postCountAfterPurge = Object.keys(postsToKeep).length;
          
          // ALWAYS remove users with no posts left after purge, regardless of other criteria
          if (postCountAfterPurge === 0) {
            delete metrics.users[userKey];
            purgedUsers++;
            continue;
          }
          
          const hasLowFollowers = minFollowers > 0 && (!isFinite(latestFollowers) || latestFollowers < minFollowers);
          const hasLowPosts = minPosts > 0 && (minPosts === 1 ? postCountAfterPurge <= minPosts : postCountAfterPurge < minPosts);
          
          // Determine if user should be removed based on minPosts/minFollowers criteria:
          // - If both minPosts and minFollowers are set: user must meet BOTH to be removed
          // - If only one is set: user must meet that one to be removed
          // - If neither is set: keep the user (they have posts, so they're kept)
          let shouldRemoveUser = false;
          if (minPosts > 0 && minFollowers > 0) {
            shouldRemoveUser = hasLowPosts && hasLowFollowers;
          } else if (minPosts > 0) {
            shouldRemoveUser = hasLowPosts;
          } else if (minFollowers > 0) {
            shouldRemoveUser = hasLowFollowers;
          }
          // else: no criteria set, keep user since they have posts
          
          // Remove user if they should be purged
          if (shouldRemoveUser){
            delete metrics.users[userKey];
            purgedUsers++;
          }
        }
        
        console.log('[Purge] Complete. Total removed:', purgedUsers, 'users,', purgedPosts, 'posts');
        
        // Save purged metrics
        await chrome.storage.local.set({ metrics });
        
        // Refresh UI
        metrics = await loadMetrics();
        const prev = currentUserKey;
        const def = buildUserOptions(metrics);
        if (!(metrics.users[prev] || isTopTodayKey(prev))) currentUserKey = def;
        $('#userSelect').value = currentUserKey || '';
        
        // Clean up compare users that no longer exist
        for (const key of Array.from(compareUsers)){
          if (!(metrics.users[key] || isTopTodayKey(key))) compareUsers.delete(key);
        }
        renderComparePills();
        buildCompareDropdown();
        refreshUserUI();
        updateBestTimeToPostSection();
        
        // Close modals
        purgeModal.style.display = 'none';
        purgeConfirmDialog.style.display = 'none';
        
        // Update storage size display
        await updateStorageSizeDisplay();
        
        // Show success message
        alert(`Purge complete!\n\nRemoved ${purgedUsers} user(s) and ${purgedPosts} post(s).`);
      } catch (e) {
        console.error('[Dashboard] Purge failed', e);
        alert('Purge failed. Please check the console for details.');
      } finally {
        await chrome.storage.local.remove('purgeLock');
      }
    });

    // Per-post purge confirmation handlers
    if (postPurgeConfirmNo) {
      postPurgeConfirmNo.addEventListener('click', ()=>{
        pendingPostPurge = null;
        if (postPurgeConfirmDialog) postPurgeConfirmDialog.style.display = 'none';
      });
    }

    if (postPurgeConfirmYes) {
      postPurgeConfirmYes.addEventListener('click', async ()=>{
        if (!pendingPostPurge){
          if (postPurgeConfirmDialog) postPurgeConfirmDialog.style.display = 'none';
          return;
        }
        const { pid, userKey } = pendingPostPurge;
        pendingPostPurge = null;
        try {
          metrics = await loadMetrics();
          const user = metrics?.users?.[userKey];
          if (user?.posts && user.posts[pid]){
            delete user.posts[pid];
            if (Object.keys(user.posts).length === 0){
              delete metrics.users[userKey];
            }
            await chrome.storage.local.set({ metrics });
            // Update UI state for current user
            if (userKey === currentUserKey){
              visibleSet.delete(pid);
              const prev = currentUserKey;
              const def = buildUserOptions(metrics);
              if (!(metrics.users[prev] || isTopTodayKey(prev))) currentUserKey = def;
              $('#userSelect').value = currentUserKey || '';
              for (const key of Array.from(compareUsers)){
                if (!(metrics.users[key] || isTopTodayKey(key))) compareUsers.delete(key);
              }
              renderComparePills();
              buildCompareDropdown();
              refreshUserUI({ preserveEmpty: true });
              persistVisibility();
              updateBestTimeToPostSection();
            }
          }
        } catch (e) {
          console.error('[Dashboard] Post purge failed', e);
          alert('Failed to purge this post. Please try again.');
        } finally {
          if (postPurgeConfirmDialog) postPurgeConfirmDialog.style.display = 'none';
        }
      });
    }

    $('#refresh').addEventListener('click', async ()=>{
      // capture zoom states
      const zScatter = chart.getZoom();
      const zViews = viewsChart.getZoom();
      const zFirst24Hours = first24HoursChart.getZoom();
      const zLikesAll = allLikesChart.getZoom();
      const zCameos = cameosChart.getZoom();
      const zFollowers = followersChart.getZoom();
      const zViewsAll = allViewsChart.getZoom();
      metrics = await loadMetrics();
      const prev = currentUserKey; const def = buildUserOptions(metrics);
      if (!(metrics.users[prev] || isTopTodayKey(prev))) currentUserKey = def;
      $('#userSelect').value = currentUserKey || '';
      try { await chrome.storage.local.set({ lastUserKey: currentUserKey }); } catch {}
      updateBestTimeToPostSection();
      
      // Clean up compare users that no longer exist
      for (const key of Array.from(compareUsers)){
        if (!(metrics.users[key] || isTopTodayKey(key))) compareUsers.delete(key);
      }
      renderComparePills();
      buildCompareDropdown();
      refreshUserUI();
      updateBestTimeToPostSection();
      // restore zoom states
      try { if (zScatter) chart.setZoom(zScatter); } catch {}
      try { if (zViews) viewsChart.setZoom(zViews); } catch {}
      try { if (zFirst24Hours) first24HoursChart.setZoom(zFirst24Hours); } catch {}
      try { if (zLikesAll) allLikesChart.setZoom(zLikesAll); } catch {}
      try { if (zCameos) cameosChart.setZoom(zCameos); } catch {}
      try { if (zFollowers) followersChart.setZoom(zFollowers); } catch {}
      try { if (zViewsAll) allViewsChart.setZoom(zViewsAll); } catch {}
    });
    $('#export').addEventListener('click', async ()=>{
      await exportAllDataCSV();
    });
    $('#import').addEventListener('click', ()=>{
      $('#importFile').click();
    });
    $('#importFile').addEventListener('change', async (e)=>{
      const file = e.target.files[0];
      if (file) {
        await importDataCSV(file);
        // Reset file input so same file can be imported again if needed
        e.target.value = '';
      }
    });
    
    // Initialize Comb Mode
    (async () => {
      await loadCombModePreference();
      scheduleCombModeDaily();
    })();
    
    // Persist zoom on full page reload/navigation
    function persistZoom(){
      const z = zoomStates[currentUserKey] || (zoomStates[currentUserKey] = {});
      z.scatter = chart.getZoom();
      z.viewsPerPerson = viewsPerPersonChart.getZoom();
      z.views = viewsChart.getZoom();
      z.first24Hours = first24HoursChart.getZoom();
      z.likesAll = allLikesChart.getZoom();
      z.cameos = cameosChart.getZoom();
      z.followers = followersChart.getZoom();
      z.viewsAll = allViewsChart.getZoom();
      try { chrome.storage.local.set({ zoomStates }); } catch {}
    }
    window.addEventListener('beforeunload', persistZoom);

    function setListActionActive(activeId){
      currentListActionId = activeId || null;
      try{
        const wrap = document.querySelector('.list-actions');
        if (!wrap) return;
        wrap.querySelectorAll('button').forEach(btn=>{
          if (btn.id === activeId) btn.classList.add('active');
          else btn.classList.remove('active');
        });
      } catch {}
    }

      $('#resetZoom').addEventListener('click', ()=>{ chart.resetZoom(); viewsPerPersonChart.resetZoom(); viewsChart.resetZoom(); first24HoursChart.resetZoom(); followersChart.resetZoom(); allViewsChart.resetZoom(); allLikesChart.resetZoom(); cameosChart.resetZoom(); refreshUserUI({ skipRestoreZoom: true }); });
      $('#showAll').addEventListener('click', ()=>{ setListActionActive('showAll'); const u = resolveUserForKey(metrics, currentUserKey); if (!u) return; visibleSet.clear(); Object.keys(u.posts||{}).forEach(pid=>visibleSet.add(pid)); chart.resetZoom(); viewsChart.resetZoom(); first24HoursChart.resetZoom(); followersChart.resetZoom(); allViewsChart.resetZoom(); allLikesChart.resetZoom(); cameosChart.resetZoom(); refreshUserUI({ skipRestoreZoom: true }); persistVisibility(); });
      $('#hideAll').addEventListener('click', ()=>{ setListActionActive('hideAll'); visibleSet.clear(); chart.resetZoom(); viewsChart.resetZoom(); first24HoursChart.resetZoom(); followersChart.resetZoom(); allViewsChart.resetZoom(); allLikesChart.resetZoom(); cameosChart.resetZoom(); refreshUserUI({ preserveEmpty: true, skipRestoreZoom: true }); persistVisibility(); });
      // First 24 hours slider
      function fmtSliderTime(minutes){
        if (minutes < 60) return `${minutes}m`;
        const hours = Math.floor(minutes / 60);
        const mins = minutes % 60;
        if (mins === 0) return `${hours}h`;
        return `${hours}h ${mins}m`;
      }
      const slider = $('#first24HoursSlider');
      const sliderValue = $('#first24HoursSliderValue');
      if (slider && sliderValue) {
        slider.addEventListener('input', (e)=>{
          const minutes = parseInt(e.target.value);
          sliderValue.textContent = fmtSliderTime(minutes);
          updateFirst24HoursChart(minutes);
        });
        sliderValue.textContent = fmtSliderTime(parseInt(slider.value) || 1440);
      }
      const viewsPerPersonSlider = $('#viewsPerPersonSlider');
      const viewsPerPersonSliderValue = $('#viewsPerPersonSliderValue');
      if (viewsPerPersonSlider && viewsPerPersonSliderValue) {
        viewsPerPersonSlider.addEventListener('input', (e)=>{
          const minutes = parseInt(e.target.value);
          viewsPerPersonSliderValue.textContent = fmtSliderTime(minutes);
          updateViewsPerPersonChart(minutes);
        });
        viewsPerPersonSliderValue.textContent = fmtSliderTime(parseInt(viewsPerPersonSlider.value) || 1440);
      }
      $('#last5').addEventListener('click', ()=>{
        setListActionActive('last5');
        const u = resolveUserForKey(metrics, currentUserKey);
        if (!u) return;
        const mapped = Object.entries(u.posts||{}).map(([pid,p])=>({
          pid,
          postTime: getPostTimeStrict(p) || 0,
          pidBI: pidBigInt(pid)
        }));
        const withTs = mapped.filter(x=>x.postTime>0).sort((a,b)=>b.postTime - a.postTime);
        const noTs = mapped.filter(x=>x.postTime<=0).sort((a,b)=>{
          if (a.pidBI === b.pidBI) return a.pid.localeCompare(b.pid);
          return a.pidBI < b.pidBI ? 1 : -1;
        });
        const sorted = withTs.concat(noTs);
        visibleSet.clear();
        sorted.slice(0, 5).forEach(it=>visibleSet.add(it.pid));
        chart.resetZoom(); viewsPerPersonChart.resetZoom(); viewsChart.resetZoom(); followersChart.resetZoom(); allViewsChart.resetZoom(); allLikesChart.resetZoom(); cameosChart.resetZoom();
        refreshUserUI({ skipRestoreZoom: true }); persistVisibility();
      });
      $('#last10').addEventListener('click', ()=>{
        setListActionActive('last10');
        const u = resolveUserForKey(metrics, currentUserKey);
        if (!u) return;
        const mapped = Object.entries(u.posts||{}).map(([pid,p])=>({
          pid,
          postTime: getPostTimeStrict(p) || 0,
          pidBI: pidBigInt(pid)
        }));
        const withTs = mapped.filter(x=>x.postTime>0).sort((a,b)=>b.postTime - a.postTime);
        const noTs = mapped.filter(x=>x.postTime<=0).sort((a,b)=>{
          if (a.pidBI === b.pidBI) return a.pid.localeCompare(b.pid);
          return a.pidBI < b.pidBI ? 1 : -1;
        });
        const sorted = withTs.concat(noTs);
        visibleSet.clear();
        sorted.slice(0, 10).forEach(it=>visibleSet.add(it.pid));
        chart.resetZoom(); viewsPerPersonChart.resetZoom(); viewsChart.resetZoom(); followersChart.resetZoom(); allViewsChart.resetZoom(); allLikesChart.resetZoom(); cameosChart.resetZoom();
        refreshUserUI({ skipRestoreZoom: true }); persistVisibility();
      });
      $('#top5').addEventListener('click', ()=>{
        setListActionActive('top5');
        const u = resolveUserForKey(metrics, currentUserKey);
        if (!u) return;
        const mapped = Object.entries(u.posts||{}).map(([pid,p])=>{
          const last = latestSnapshot(p.snapshots);
          return {
            pid,
            views: num(last?.views),
            postTime: getPostTimeStrict(p) || 0,
            pidBI: pidBigInt(pid)
          };
        });
        const sorted = mapped.sort((a,b)=>{
          const dv = b.views - a.views;
          if (dv !== 0) return dv;
          const dt = (b.postTime || 0) - (a.postTime || 0);
          if (dt !== 0) return dt;
          if (a.pidBI === b.pidBI) return b.pid.localeCompare(a.pid);
          return a.pidBI < b.pidBI ? 1 : -1;
        });
        visibleSet.clear();
        sorted.slice(0, 5).forEach(it=>visibleSet.add(it.pid));
        chart.resetZoom(); viewsPerPersonChart.resetZoom(); viewsChart.resetZoom(); followersChart.resetZoom(); allViewsChart.resetZoom(); allLikesChart.resetZoom(); cameosChart.resetZoom();
        refreshUserUI({ skipRestoreZoom: true }); persistVisibility();
      });
      $('#top10').addEventListener('click', ()=>{
        setListActionActive('top10');
        const u = resolveUserForKey(metrics, currentUserKey);
        if (!u) return;
        const mapped = Object.entries(u.posts||{}).map(([pid,p])=>{
          const last = latestSnapshot(p.snapshots);
          return {
            pid,
            views: num(last?.views),
            postTime: getPostTimeStrict(p) || 0,
            pidBI: pidBigInt(pid)
          };
        });
        const sorted = mapped.sort((a,b)=>{
          const dv = b.views - a.views;
          if (dv !== 0) return dv;
          const dt = (b.postTime || 0) - (a.postTime || 0);
          if (dt !== 0) return dt;
          if (a.pidBI === b.pidBI) return b.pid.localeCompare(a.pid);
          return a.pidBI < b.pidBI ? 1 : -1;
        });
        visibleSet.clear();
        sorted.slice(0, 10).forEach(it=>visibleSet.add(it.pid));
        chart.resetZoom(); viewsPerPersonChart.resetZoom(); viewsChart.resetZoom(); followersChart.resetZoom(); allViewsChart.resetZoom(); allLikesChart.resetZoom(); cameosChart.resetZoom();
        refreshUserUI({ skipRestoreZoom: true }); persistVisibility();
      });
      $('#bottom5').addEventListener('click', ()=>{
        setListActionActive('bottom5');
        const u = resolveUserForKey(metrics, currentUserKey);
        if (!u) return;
        const now = Date.now();
        const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
        const mapped = Object.entries(u.posts||{}).map(([pid,p])=>{
          const postTime = getPostTimeStrict(p) || 0;
          const ageMs = postTime ? now - postTime : Infinity;
          const last = latestSnapshot(p.snapshots);
          return {
            pid,
            postTime,
            views: num(last?.views),
            ageMs,
            pidBI: pidBigInt(pid)
          };
        });
        const olderThan24h = mapped.filter(x=>x.ageMs > TWENTY_FOUR_HOURS_MS);
        const sortedOlder = olderThan24h.sort((a,b)=>{
          const dv = a.views - b.views;
          if (dv !== 0) return dv;
          const dt = (a.postTime || 0) - (b.postTime || 0); // tie-break oldest first
          if (dt !== 0) return dt;
          if (a.pidBI === b.pidBI) return a.pid.localeCompare(b.pid);
          return a.pidBI < b.pidBI ? -1 : 1; // final tie-break oldest-ish first
        });
        const sortedAll = mapped.slice().sort((a,b)=>{
          const dv = a.views - b.views;
          if (dv !== 0) return dv;
          const dt = (a.postTime || 0) - (b.postTime || 0);
          if (dt !== 0) return dt;
          if (a.pidBI === b.pidBI) return a.pid.localeCompare(b.pid);
          return a.pidBI < b.pidBI ? -1 : 1;
        });
        const picked = [];
        for (const it of sortedOlder) {
          if (picked.length >= 5) break;
          picked.push(it);
        }
        if (picked.length < 5) {
          const seen = new Set(picked.map(p=>p.pid));
          for (const it of sortedAll) {
            if (picked.length >= 5) break;
            if (seen.has(it.pid)) continue;
            picked.push(it);
          }
        }
        visibleSet.clear();
        picked.forEach(it=>visibleSet.add(it.pid));
        chart.resetZoom(); viewsPerPersonChart.resetZoom(); viewsChart.resetZoom(); followersChart.resetZoom(); allViewsChart.resetZoom(); allLikesChart.resetZoom(); cameosChart.resetZoom();
        refreshUserUI({ skipRestoreZoom: true }); persistVisibility();
      });
      $('#bottom10').addEventListener('click', ()=>{
        setListActionActive('bottom10');
        const u = resolveUserForKey(metrics, currentUserKey);
        if (!u) return;
        const now = Date.now();
        const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
        const mapped = Object.entries(u.posts||{}).map(([pid,p])=>{
          const postTime = getPostTimeStrict(p) || 0;
          const ageMs = postTime ? now - postTime : Infinity;
          const last = latestSnapshot(p.snapshots);
          return {
            pid,
            postTime,
            views: num(last?.views),
            ageMs,
            pidBI: pidBigInt(pid)
          };
        });
        const olderThan24h = mapped.filter(x=>x.ageMs > TWENTY_FOUR_HOURS_MS);
        const sortedOlder = olderThan24h.sort((a,b)=>{
          const dv = a.views - b.views;
          if (dv !== 0) return dv;
          const dt = (a.postTime || 0) - (b.postTime || 0);
          if (dt !== 0) return dt;
          if (a.pidBI === b.pidBI) return a.pid.localeCompare(b.pid);
          return a.pidBI < b.pidBI ? -1 : 1;
        });
        const sortedAll = mapped.slice().sort((a,b)=>{
          const dv = a.views - b.views;
          if (dv !== 0) return dv;
          const dt = (a.postTime || 0) - (b.postTime || 0);
          if (dt !== 0) return dt;
          if (a.pidBI === b.pidBI) return a.pid.localeCompare(b.pid);
          return a.pidBI < b.pidBI ? -1 : 1;
        });
        const picked = [];
        for (const it of sortedOlder) {
          if (picked.length >= 10) break;
          picked.push(it);
        }
        if (picked.length < 10) {
          const seen = new Set(picked.map(p=>p.pid));
          for (const it of sortedAll) {
            if (picked.length >= 10) break;
            if (seen.has(it.pid)) continue;
            picked.push(it);
          }
        }
        visibleSet.clear();
        picked.forEach(it=>visibleSet.add(it.pid));
        chart.resetZoom(); viewsPerPersonChart.resetZoom(); viewsChart.resetZoom(); followersChart.resetZoom(); allViewsChart.resetZoom(); allLikesChart.resetZoom(); cameosChart.resetZoom();
        refreshUserUI({ skipRestoreZoom: true }); persistVisibility();
      });

      const staleBtn = $('#stale');
      if (staleBtn) staleBtn.addEventListener('click', ()=>{
        setListActionActive('stale');
        const u = resolveUserForKey(metrics, currentUserKey);
        if (!u) return;
        const now = Date.now();
        const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
        const mapped = Object.entries(u.posts||{}).map(([pid,p])=>{
          const last = latestSnapshot(p.snapshots);
          const lastRefresh = toTs(last?.t) || 0;
          const ageMs = lastRefresh ? now - lastRefresh : Infinity;
          return { pid, ageMs };
        });
        const stale = mapped.filter(x=>x.ageMs > TWENTY_FOUR_HOURS_MS);
        visibleSet.clear();
        stale.forEach(it=>visibleSet.add(it.pid));
        chart.resetZoom(); viewsPerPersonChart.resetZoom(); viewsChart.resetZoom(); followersChart.resetZoom(); allViewsChart.resetZoom(); allLikesChart.resetZoom(); cameosChart.resetZoom();
        refreshUserUI({ skipRestoreZoom: true }); persistVisibility();
      });

    // If compare section is empty on initial load, add current user to show who we're looking at
    if (compareUsers.size === 0 && currentUserKey && resolveUserForKey(metrics, currentUserKey)){
      addCompareUser(currentUserKey);
    }
    refreshUserUI();
    updateBestTimeToPostSection();
  }

  document.addEventListener('DOMContentLoaded', main, { once:true });
})();
