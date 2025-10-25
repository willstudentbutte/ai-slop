/*
 * Copyright (c) 2025 William Cruttenden
 * Licensed under the Polyform Noncommercial License 1.0.0.
 * Noncommercial use permitted. Commercial use requires a separate license from the copyright holder.
 *
 * What this does (simple):
 * - Reads the site’s feed JSON and adds a small badge to each post card.
 * - Badge color is based on time since posting (all posts >25 likes): red (<1h) → yellow (18h) in 18 gradient steps from RED (hot) to YELLOW (warm).
 * - If age is within ±15m of a whole day (1d, 2d, 3d…), the badge turns green with a 📝 icon indicating a good time to POST to achieve those likes.
 * - Corner button cycles a time filter: All, <3h, <6h, <12h, <15h, <18h to focus only on Hot posts in the Top feed.
 * - Badge text looks like: “30.2K views • 14h 36m • 🔥/🔥🔥/🔥🔥🔥” with more flames for hotter posts.
 */

(function () {
  'use strict';

  // ---------- formatting ----------
  const fmt = (n) => (n >= 1e6 ? (n/1e6).toFixed(n%1e6?1:0)+'M'
                    : n >= 1e3 ? (n/1e3).toFixed(n%1e3?1:0)+'K'
                    : String(n));

  function fmtAgeMin(ageMin) {
    if (!Number.isFinite(ageMin)) return '∞';
    const mTotal = Math.max(0, Math.floor(ageMin));
    const MIN_PER_H = 60, MIN_PER_D = 24*MIN_PER_H, MIN_PER_Y = 365*MIN_PER_D;
    let r = mTotal;
    const y = Math.floor(r / MIN_PER_Y); r -= y * MIN_PER_Y;
    const d = Math.floor(r / MIN_PER_D); r -= d * MIN_PER_D;
    const h = Math.floor(r / MIN_PER_H); r -= h * MIN_PER_H;
    const m = r;
    const parts = [];
    if (y) parts.push(`${y}y`);
    if (d) parts.push(`${d}d`);
    if (h) parts.push(`${h}h`);
    parts.push(`${m}m`);
    return parts.join(' ');
  }

  // ---------- config ----------
  const PREF_KEY = 'SORA_UV_PREFS_V1';

  // Filter cycle: null = show all
  const FILTER_STEPS_MIN = [null, 180, 360, 720, 900, 1080];
  const FILTER_LABELS    = ['Filter', '<3 hours', '<6 hours', '<12 hours', '<15 hours', '<18 hours'];

  // ---------- helpers ----------
  const minutesSince = (epochSec)=>!epochSec?Infinity:Math.max(0, (Date.now()/1000-epochSec)/60);
  const likeRate = (likes, unique, views) => {
    const l = Number(likes);
    if (!Number.isFinite(l) || l < 0) return null;
    const u = Number(unique);
    const v = Number(views);
    const denom = (Number.isFinite(u) && u > 0) ? u : ((Number.isFinite(v) && v > 0) ? v : null);
    return denom ? fmtPct(l, denom) : null;
  };
  const normalizeId = (s) => s?.toString().split(/[?#]/)[0].trim();
  const isExplore = () => location.pathname.startsWith('/explore');
  const isProfile = () => location.pathname.startsWith('/profile');
  const isPost    = () => /^\/p\/s_[A-Za-z0-9]+/i.test(location.pathname);

  // Red (0h) → Yellow (18h), 18 steps, saturated.
  function colorForAgeMin(ageMin) {
    if (!Number.isFinite(ageMin)) return null;
    const hHours = ageMin / 60;
    if (hHours < 0 || hHours >= 18) return null;
    const idx = Math.floor(hHours);                 // 0..17
    const t = idx / 17;                             // 0..1
    const h = 0 + (50 * t);                         // hue: 0→50
    const l = 42 - (12 * t);                        // lightness: 42%→30%
    return `hsla(${h.toFixed(1)}, 100%, ${l.toFixed(1)}%, 0.92)`;
  }

  // Whole-day (±15m) => green day mark.
  function isNearWholeDay(ageMin, windowMin = 15) {
    if (!Number.isFinite(ageMin) || ageMin < 0) return false;
    const MIN_PER_D = 1440;
    const nearest = Math.round(ageMin / MIN_PER_D) * MIN_PER_D;
    const diff = Math.abs(ageMin - nearest);
    return nearest >= MIN_PER_D && diff <= windowMin;
  }
  const greenEmblemColor = () => 'hsla(120, 85%, 32%, 0.92)';

  // Fire tiers for <18h (only if eligible for red→yellow coloring)
  function fireForAge(ageMin) {
    if (!Number.isFinite(ageMin)) return '';
    const h = ageMin / 60;
    if (h < 6) return '🔥🔥🔥';
    if (h < 12) return '🔥🔥';
    if (h < 18) return '🔥';
    return '';
  }

  // ---------- JSON extractors ----------
  const getUniqueViews = (item) => item?.post?.unique_view_count ?? null;
  const getLikes = (item) => {
    try {
      const p = item?.post ?? item;
      const cands = [
        p?.like_count, p?.likes_count, p?.likes,
        p?.stats?.like_count, p?.statistics?.like_count,
        p?.reactions?.like?.count,
      ];
      for (const v of cands) {
        const n = Number(v);
        if (Number.isFinite(n)) return n;
      }
    } catch {}
    return null;
  };
  const getTotalViews = (item) => {
    try {
      const p = item?.post ?? item;
      const cands = [
        p?.view_count, p?.views, p?.play_count, p?.impression_count,
        p?.stats?.view_count, p?.statistics?.view_count,
      ];
      for (const v of cands) {
        const n = Number(v);
        if (Number.isFinite(n)) return n;
      }
    } catch {}
    return null;
  };
  const getThumbnail = (item) => {
    try {
      const p = item?.post ?? item;
      const candidates = [
        p?.thumbnail_url, p?.thumb, p?.cover,
        p?.image?.url || p?.image,
        Array.isArray(p?.images) ? p.images[0]?.url : null,
        p?.media?.thumbnail || p?.media?.cover || p?.media?.poster,
        Array.isArray(p?.assets) ? p.assets[0]?.thumbnail_url || p.assets[0]?.url : null,
        p?.preview_image_url, p?.poster?.url,
      ].filter(Boolean);
      for (const u of candidates) if (typeof u === 'string' && /^https?:\/\//.test(u)) return u;
    } catch {}
    return null;
  };
  const getItemId = (item) => {
    const cand = item?.post?.id || item?.post?.core_id || item?.post?.content_id || item?.id;
    if (cand && /^s_[A-Za-z0-9]+$/i.test(cand)) return normalizeId(cand);
    const deep = findSIdDeep(item);
    if (deep) return normalizeId(deep);
    return null;
  };
  function findSIdDeep(obj) {
    try {
      const stack = [obj];
      while (stack.length) {
        const cur = stack.pop();
        if (!cur) continue;
        if (typeof cur === 'string' && /^s_[A-Za-z0-9]+$/i.test(cur)) return cur;
        if (Array.isArray(cur)) stack.push(...cur);
        else if (typeof cur === 'object') stack.push(...Object.values(cur));
      }
    } catch {}
    return null;
  }
  function currentSIdFromURL() {
    const m = location.pathname.match(/^\/p\/(s_[A-Za-z0-9]+)/i);
    return m ? m[1] : null;
  }

  // ---------- DOM mapping ----------
  const extractIdFromCard = (el) => {
    const link = el.querySelector('a[href^="/p/s_"]');
    if (!link) return null;
    const m = link.getAttribute('href').match(/\/p\/(s_[A-Za-z0-9]+)/i);
    return m ? normalizeId(m[1]) : null;
  };
  const selectAllCards = () => Array.from(document.querySelectorAll('a[href^="/p/s_"]'))
    .map(a => a.closest('article,div,section') || a);

  // ---------- state ----------
  const idToUnique = new Map();
  const idToLikes  = new Map();
  const idToViews  = new Map();
  const idToMeta   = new Map(); // id -> { ageMin }
  let controlBar   = null;

  // ---------- badge UI ----------
  function ensureBadge(card) {
    let badge = card.querySelector('.sora-uv-badge');
    if (!badge) {
      if (getComputedStyle(card).position === 'static') card.style.position = 'relative';
      badge = document.createElement('div');
      badge.className = 'sora-uv-badge';
      Object.assign(badge.style, {
        position: 'absolute',
        top: '6px',
        left: '6px',
        padding: '3px 6px',
        fontSize: '12px',
        lineHeight: '1',
        fontWeight: '600',
        borderRadius: '8px',
        background: 'rgba(0,0,0,0.72)',
        color: '#fff',
        zIndex: 9999,
        pointerEvents: 'none',
        backdropFilter: 'blur(2px)',
      });
      card.appendChild(badge);
    }
    return badge;
  }

  function badgeBgFor(id, meta) {
    if (!meta) return null;
    const ageMin = meta.ageMin;
    if (isNearWholeDay(ageMin)) return greenEmblemColor();
    const likes = idToLikes.get(id) ?? 0;
    if (likes > 25) return colorForAgeMin(ageMin);
    return null;
  }

  function badgeEmojiFor(id, meta) {
    if (!meta) return '';
    const ageMin = meta.ageMin;
    if (isNearWholeDay(ageMin)) return '📝';
    const likes = idToLikes.get(id) ?? 0;
    if (likes > 25) return fireForAge(ageMin);
    return '';
  }

  function addBadge(card, views, meta) {
    if (views == null && !meta) return;
    const badge = ensureBadge(card);
    const id = extractIdFromCard(card);

    const viewsStr = views != null ? `${fmt(views)} views` : null;
    const ageStr = Number.isFinite(meta?.ageMin) ? fmtAgeMin(meta.ageMin) : null;
    const emoji = badgeEmojiFor(id, meta);

    const textParts = [viewsStr, ageStr, emoji].filter(Boolean);
    badge.textContent = textParts.join(' • ');

    const bg = badgeBgFor(id, meta);
    badge.style.background = bg || 'rgba(0,0,0,0.72)';

    const note = isNearWholeDay(meta?.ageMin) ? 'Green day mark ✅' : (bg ? 'Hot ✅' : '');
    const ageLabel = ageStr || '∞';
    badge.title = meta ? `Age: ${ageLabel}${note ? `\n${note}` : ''}` : '';
  }

  function renderBadges() {
    ensureControlBar();
    for (const card of selectAllCards()) {
      const id = extractIdFromCard(card);
      if (!id) continue;
      const uv = idToUnique.get(id);
      const meta = idToMeta.get(id);
      addBadge(card, uv, meta);
    }
    applyFilter();
  }

  // ---------- control bar ----------
  function getPrefs(){ try{return JSON.parse(localStorage.getItem(PREF_KEY)||'{}')}catch{return{}} }
  function setPrefs(p){ localStorage.setItem(PREF_KEY, JSON.stringify(p)); }
  function stylBtn(b){
    Object.assign(b.style,{
      background:'rgba(255,255,255,0.12)', color:'#fff',
      border:'1px solid rgba(255,255,255,0.2)', borderRadius:'8px',
      padding:'4px 8px', cursor:'pointer'
    });
    b.onmouseenter=()=>b.style.background='rgba(255,255,255,0.2)';
    b.onmouseleave=()=>b.style.background='rgba(255,255,255,0.12)';
  }

  function ensureControlBar(){
    if (controlBar && document.contains(controlBar)) return controlBar;
    const bar = document.createElement('div');
    bar.className='sora-uv-controls';
    Object.assign(bar.style,{
      position:'fixed', top:'12px', right:'12px', zIndex:999999,
      display:'flex', gap:'8px', padding:'6px 8px', borderRadius:'10px',
      background:'rgba(0,0,0,0.55)', color:'#fff', fontSize:'12px',
      alignItems:'center', backdropFilter:'blur(2px)', userSelect:'none'
    });

    const prefs = getPrefs();
    if (typeof prefs.filterIndex !== 'number') {
      prefs.filterIndex = 0; // start at “Filter” (no limit)
      setPrefs(prefs);
    }

    const filterBtn = document.createElement('button');
    stylBtn(filterBtn);
    const setLabel = () => filterBtn.textContent = FILTER_LABELS[prefs.filterIndex];
    setLabel();

    filterBtn.onclick = ()=>{
      const p = getPrefs();
      p.filterIndex = ((p.filterIndex ?? 0) + 1) % FILTER_STEPS_MIN.length;
      setPrefs(p);
      prefs.filterIndex = p.filterIndex; // keep local in sync
      setLabel();
      applyFilter();
    };

    bar.appendChild(filterBtn);
    document.documentElement.appendChild(bar);
    controlBar = bar;
    return bar;
  }

  // ---------- filtering (cycles through thresholds) ----------
  function applyFilter(){
    const prefs = getPrefs();
    const idx = typeof prefs.filterIndex === 'number' ? prefs.filterIndex : 0;
    const limitMin = FILTER_STEPS_MIN[idx]; // null => show all

    for (const card of selectAllCards()){
      const id = extractIdFromCard(card);
      const meta = idToMeta.get(id);
      if (limitMin == null) { // “Filter” = show everything
        card.style.display = '';
        continue;
      }
      const show = Number.isFinite(meta?.ageMin) && meta.ageMin <= limitMin;
      card.style.display = show ? '' : 'none';
    }
  }

  // ---------- detail badge ----------
  let detailBadgeEl = null;
  function ensureDetailBadge() {
    if (detailBadgeEl && document.contains(detailBadgeEl)) return detailBadgeEl;
    const el = document.createElement('div');
    el.className = 'sora-uv-badge-detail';
    Object.assign(el.style, {
      position: 'fixed',
      top: '12px',
      left: '12px',
      padding: '6px 10px',
      fontSize: '13px',
      fontWeight: '700',
      borderRadius: '10px',
      background: 'rgba(0,0,0,0.75)',
      color: '#fff',
      zIndex: 999999,
      pointerEvents: 'none',
      backdropFilter: 'blur(2px)',
    });
    document.documentElement.appendChild(el);
    detailBadgeEl = el;
    return el;
  }
  function renderDetailBadge() {
    if (!isPost()) {
      if (detailBadgeEl) { detailBadgeEl.remove(); detailBadgeEl = null; }
      return;
    }
    const sid = currentSIdFromURL();
    if (!sid) return;
    const uv = idToUnique.get(sid);
    const likes = idToLikes.get(sid);
    const totalViews = idToViews.get(sid);
    const rate = likeRate(likes, uv, totalViews);
    if (uv == null && !rate) return;
    const el = ensureDetailBadge();
    const meta = idToMeta.get(sid);

    const viewsStr = uv != null ? `${fmt(uv)} views` : null;
    const ageStr = Number.isFinite(meta?.ageMin) ? fmtAgeMin(meta.ageMin) : null;
    const emoji = badgeEmojiFor(sid, meta);
    el.textContent = [viewsStr, ageStr, emoji].filter(Boolean).join(' • ');

    const bg = badgeBgFor(sid, meta);
    el.style.background = bg || 'rgba(0,0,0,0.75)';

    const note = isNearWholeDay(meta?.ageMin) ? 'Green day mark ✅' : (bg ? 'Hot ✅' : '');
    const ageLabel = ageStr || '∞';
    el.title = meta ? `Age: ${ageLabel}${note ? `\n${note}` : ''}` : '';
  }

  // ---------- observers & routing ----------
  const mo = new MutationObserver(() => {
    if (mo._raf) cancelAnimationFrame(mo._raf);
    mo._raf = requestAnimationFrame(() => { renderBadges(); renderDetailBadge(); });
  });
  function startObservers() {
    mo.observe(document.documentElement, { childList: true, subtree: true });
    renderBadges();
    renderDetailBadge();
  }
  (function patchHistory() {
    const _push = history.pushState, _replace = history.replaceState;
    const fire = () => setTimeout(onRouteChange, 0);
    history.pushState = function() { const r = _push.apply(this, arguments); fire(); return r; };
    history.replaceState = function() { const r = _replace.apply(this, arguments); fire(); return r; };
    window.addEventListener('popstate', fire);
  })();
  function onRouteChange() { renderBadges(); renderDetailBadge(); bootstrapIfNeeded(); }

  // ---------- network interception ----------
  const FEED_RE = /\/backend\/project_y\/(feed|profile_feed)/;
  function installFetchSniffer() {
    const origFetch = window.fetch;
    window.fetch = async function(input, init) {
      const res = await origFetch.apply(this, arguments);
      try {
        const url = typeof input === 'string' ? input : (input?.url || '');
        if (FEED_RE.test(url)) res.clone().json().then(processFeedJson).catch(()=>{});
      } catch {}
      return res;
    };
    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url) {
      this.addEventListener('load', function() {
        try {
          if (typeof url === 'string' && FEED_RE.test(url)) {
            try { processFeedJson(JSON.parse(this.responseText)); } catch {}
          }
        } catch {}
      });
      return origOpen.apply(this, arguments);
    };
  }

  // Additional metric extractors (optional fields)
  const getComments = (item) => {
    try {
      const p = item?.post ?? item;
      const cands = [
        p?.comment_count, p?.comments_count, p?.comments,
        p?.reply_count, p?.replies?.count,
        p?.stats?.comment_count, p?.statistics?.comment_count,
      ];
      for (const v of cands) {
        const n = Number(v);
        if (Number.isFinite(n)) return n;
      }
    } catch {}
    return null;
  };
  const getRemixes = (item) => {
    try {
      const p = item?.post ?? item;
      const cands = [
        p?.remix_count, p?.remixes,
        p?.stats?.remix_count, p?.statistics?.remix_count,
      ];
      for (const v of cands) {
        const n = Number(v);
        if (Number.isFinite(n)) return n;
      }
    } catch {}
    return null;
  };
  const getShares = (item) => {
    try {
      const p = item?.post ?? item;
      const cands = [
        p?.share_count, p?.shares,
        p?.stats?.share_count, p?.statistics?.share_count,
      ];
      for (const v of cands) {
        const n = Number(v);
        if (Number.isFinite(n)) return n;
      }
    } catch {}
    return null;
  };
  const getDownloads = (item) => {
    try {
      const p = item?.post ?? item;
      const cands = [
        p?.download_count, p?.downloads,
        p?.stats?.download_count, p?.statistics?.download_count,
      ];
      for (const v of cands) {
        const n = Number(v);
        if (Number.isFinite(n)) return n;
      }
    } catch {}
    return null;
  };

  // Build minimal meta (age only) and store counters used for coloring/emojis
  function processFeedJson(json) {
    const items = json?.items || json?.data?.items || [];
    const batch = [];
    for (const it of items) {
      const id = getItemId(it);
      if (!id) continue;

      const uv = getUniqueViews(it);
      const likes = getLikes(it);
      const tv = getTotalViews(it);
      const cm = getComments(it);
      const rx = getRemixes(it);
      const sh = getShares(it);
      const dl = getDownloads(it);
      const p = it?.post || it || {};
      const created_at = p?.created_at ?? p?.uploaded_at ?? p?.createdAt ?? p?.created ?? p?.posted_at ?? p?.timestamp ?? null;
      const ageMin = minutesSince(created_at);
      const th = getThumbnail(it);

      if (uv != null) idToUnique.set(id, uv);
      if (likes != null) idToLikes.set(id, likes);
      if (tv != null) idToViews.set(id, tv);
      idToMeta.set(id, { ageMin });

      const absUrl = `${location.origin}/p/${id}`;
      batch.push({ postId: id, uv, likes, views: tv, comments: cm, remixes: rx, shares: sh, downloads: dl, created_at, ageMin, thumb: th, url: absUrl, ts: Date.now() });
    }
    if (batch.length) try { window.postMessage({ __sora_uv__: true, type: 'metrics_batch', items: batch }, '*'); } catch {}
    renderBadges();
    renderDetailBadge();
  }

  // ---------- optional bootstrap ----------
  async function bootstrapIfNeeded() {
    try {
      if (isExplore()) await prefetchPaged('/backend/project_y/feed?limit=16&cut=nf2_top', 2);
      if (isProfile()) await prefetchPaged('/backend/project_y/profile_feed/me?limit=15&cut=nf2', 2);
    } catch {}
  }
  async function prefetchPaged(baseUrl, pages = 1) {
    let url = baseUrl;
    for (let i = 0; i < pages; i++) {
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) break;
      const json = await res.json();
      processFeedJson(json);
      const cursor = json?.cursor || json?.data?.cursor;
      if (!cursor) break;
      const sep = url.includes('?') ? '&' : '?';
      url = `${baseUrl}${sep}cursor=${encodeURIComponent(cursor)}`;
    }
  }

  // ---------- boot ----------
  function init(){ installFetchSniffer(); startObservers(); onRouteChange(); bootstrapIfNeeded(); }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else { init(); }
})();
