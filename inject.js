/*
 * Copyright (c) 2025 William Cruttenden
 * Licensed under the Polyform Noncommercial License 1.0.0.
 * Noncommercial use permitted. Commercial use requires a separate license from the copyright holder.
 * See the LICENSE file for details.
 */

(function () {
  'use strict';

  // ---------- utils ----------
  const fmt = (n) => (n >= 1e6 ? (n/1e6).toFixed(n%1e6?1:0)+'M'
                    : n >= 1e3 ? (n/1e3).toFixed(n%1e3?1:0)+'K'
                    : String(n));
  const fmtPct = (num, den) => {
    const a = Number(num), b = Number(den);
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= 0) return null;
    const p = (a / b) * 100;
    const digits = p < 10 ? 1 : 0;
    return p.toFixed(digits) + '%';
  };
  // ==== Hotness config ====
  const HALF_LIFE_MIN = 120;          // freshness decay half-life in minutes
  const VEL_UNIT = 60;                // velocity window factor: /min * 60 = per hour
  const REMIX_MIN_LIKES = 50;         // remix flag min likes
  const REMIX_MAX_AGE_MIN = 90;       // remix flag max age
  const BASE_REMIX_SCORE_THRESH = 80; // fallback threshold for "Remix now"
  const PREF_KEY = 'SORA_UV_PREFS_V1';// localStorage key for UI prefs

  // ==== Helpers ====
  const clamp = (x,a,b)=>Math.max(a,Math.min(b,x));
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

  // ---------- JSON extractors ----------
  const getUniqueViews = (item) => item?.post?.unique_view_count ?? null;
  const getLikes = (item) => {
    try {
      const p = item?.post ?? item;
      const cands = [
        p?.like_count,
        p?.likes_count,
        p?.likes,
        p?.stats?.like_count,
        p?.statistics?.like_count,
        p?.reactions?.like?.count,
      ];
      for (const v of cands) if (Number.isFinite(Number(v))) return Number(v);
    } catch {}
    return null;
  };
  const getTotalViews = (item) => {
    try {
      const p = item?.post ?? item;
      const cands = [
        p?.view_count,
        p?.views,
        p?.play_count,
        p?.impression_count,
        p?.stats?.view_count,
        p?.statistics?.view_count,
      ];
      for (const v of cands) if (Number.isFinite(Number(v))) return Number(v);
    } catch {}
    return null;
  };

  const getComments = (item) => {
    try {
      const p = item?.post ?? item;
      const cands = [
        p?.reply_count,
        p?.comments_count,
        p?.comment_count,
        p?.stats?.reply_count,
        p?.statistics?.reply_count,
      ];
      for (const v of cands) if (Number.isFinite(Number(v))) return Number(v);
    } catch {}
    return null;
  };

  const getRemixes = (item) => {
    try {
      const p = item?.post ?? item;
      const cands = [
        p?.recursive_remix_count,
        p?.remix_count,
        p?.remixes_count,
        p?.remixes,
        p?.stats?.remix_count,
        p?.statistics?.remix_count,
      ];
      for (const v of cands) if (Number.isFinite(Number(v))) return Number(v);
    } catch {}
    return null;
  };

  const getShares = (item) => {
    try {
      const p = item?.post ?? item;
      const cands = [
        p?.share_count,
        p?.shares_count,
        p?.shares,
        p?.stats?.share_count,
        p?.statistics?.share_count,
      ];
      for (const v of cands) if (Number.isFinite(Number(v))) return Number(v);
    } catch {}
    return null;
  };

  const getDownloads = (item) => {
    try {
      const p = item?.post ?? item;
      const cands = [
        p?.download_count,
        p?.downloads_count,
        p?.downloads,
        p?.stats?.download_count,
        p?.statistics?.download_count,
      ];
      for (const v of cands) if (Number.isFinite(Number(v))) return Number(v);
    } catch {}
    return null;
  };

  const getThumbnail = (item) => {
    try {
      const p = item?.post ?? item;
      const candidates = [
        p?.thumbnail_url,
        p?.thumb,
        p?.cover,
        p?.image?.url || p?.image,
        Array.isArray(p?.images) ? p.images[0]?.url : null,
        p?.media?.thumbnail || p?.media?.cover || p?.media?.poster,
        Array.isArray(p?.assets) ? p.assets[0]?.thumbnail_url || p.assets[0]?.url : null,
        p?.preview_image_url,
        p?.poster?.url,
      ].filter(Boolean);
      for (const u of candidates) {
        if (typeof u === 'string' && /^https?:\/\//.test(u)) return u;
      }
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

  // ---------- DOM mapping ----------
  const extractIdFromCard = (el) => {
    const link = el.querySelector('a[href^="/p/s_"]');
    if (!link) return null;
    const m = link.getAttribute('href').match(/\/p\/(s_[A-Za-z0-9]+)/i);
    return m ? normalizeId(m[1]) : null;
  };

  const selectAllCards = () => {
    return Array.from(document.querySelectorAll('a[href^="/p/s_"]'))
      .map(a => a.closest('article,div,section') || a);
  };

  // ---------- state & UI ----------
  const idToUnique = new Map();
  const idToLikes  = new Map();
  const idToViews  = new Map();
  // Hotness state
  const idToMeta  = new Map(); // id -> { score, ageMin, velPerHour, remixNow }
  const idLastObs = new Map(); // id -> { uv, t } for velocity calc
  let controlBar = null;       // UI node for sort/filter
  const lastScores = [];       // rolling score distribution for dynamic threshold

  function updateVelocity(id, uv) {
    const now = Date.now();
    const prev = idLastObs.get(id);
    idLastObs.set(id, { uv, t: now });
    if (!prev || uv == null || prev.uv == null) return 0;
    const dtMin = (now - prev.t) / 60000;
    if (dtMin <= 0.2) return 0; // throttle jitter
    const d = uv - prev.uv;
    return Math.max(0, Math.round((d / dtMin) * VEL_UNIT)); // views/hour
  }

  function dynamicRemixThreshold() {
    if (lastScores.length < 20) return BASE_REMIX_SCORE_THRESH;
    const sorted = [...lastScores].sort((a,b)=>a-b);
    const p75 = sorted[Math.floor(0.75*(sorted.length-1))];
    return Math.max(BASE_REMIX_SCORE_THRESH, Math.min(5000, Math.round(p75)));
  }

  function calcHotness({ likes=0, remixes=0, views=0, created_at=null, velPerHour=0 }) {
    const ageMin = minutesSince(created_at);
    const decay = Math.pow(2, -ageMin / HALF_LIFE_MIN); // freshness decay
    const momentum = (likes + 2*remixes) * (1 + Math.log10((views||0)+1)); // engagement × log(views)
    const velBonus = 1 + clamp(velPerHour / 2000, 0, 2); // bonus for fast movers
    const score = Math.round(momentum * velBonus * decay);
    const remixNow = (likes >= REMIX_MIN_LIKES && ageMin <= REMIX_MAX_AGE_MIN) || (score >= dynamicRemixThreshold());
    return { score, ageMin, velPerHour, remixNow };
  }

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

  function addBadge(card, uniqueViews, likes, totalViews, meta) {
    const rate = likeRate(likes, uniqueViews, totalViews);
    if (uniqueViews == null && !meta && !rate) return;
    const badge = ensureBadge(card);
    const parts = [];
    if (uniqueViews != null) {
      parts.push(rate ? `Unique: ${fmt(uniqueViews)} • ${rate}` : `Unique: ${fmt(uniqueViews)}`);
    } else if (rate) {
      parts.push(`Like rate: ${rate}`);
    }
    if (meta) {
      const ageStr = Number.isFinite(meta.ageMin) ? `${Math.round(meta.ageMin)}m` : '';
      const velStr = meta.velPerHour ? `↑ ${fmt(meta.velPerHour)}/h` : '';
      const scoreStr = `🔥 ${meta.score}`;
      parts.push([scoreStr, velStr, ageStr].filter(Boolean).join(' • '));
    }
    badge.textContent = parts.join('  —  ');
    badge.style.background = meta?.remixNow ? 'rgba(255,69,0,0.85)' : 'rgba(0,0,0,0.72)';
    const ageRounded = meta && Number.isFinite(meta.ageMin) ? Math.round(meta.ageMin) : '∞';
    const tooltipLines = [];
    if (uniqueViews != null) tooltipLines.push(`Unique: ${fmt(uniqueViews)}`);
    if (likes != null) tooltipLines.push(`Likes: ${fmt(likes)}`);
    if (totalViews != null) tooltipLines.push(`Views: ${fmt(totalViews)}`);
    if (rate) tooltipLines.push(`Like rate: ${rate}`);
    if (meta) {
      tooltipLines.push(`Score: ${meta.score}`);
      tooltipLines.push(`Velocity: ${meta.velPerHour || 0}/h`);
      tooltipLines.push(`Age: ${ageRounded} min`);
      if (meta.remixNow) tooltipLines.push('Remix now ✅');
    }
    badge.title = tooltipLines.join('\n');
  }

  function renderBadges() {
    ensureControlBar();
    for (const card of selectAllCards()) {
      const id = extractIdFromCard(card);
      if (!id) continue;
      const uv = idToUnique.get(id);
      const likes = idToLikes.get(id);
      const totalViews = idToViews.get(id);
      const meta = idToMeta.get(id);
      addBadge(card, uv, likes, totalViews, meta);
    }
    applyFilter();
    resortGrid();
  }

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
    if (prefs.sortHot) {
      delete prefs.sortHot;
      setPrefs(prefs);
    }

    const filterBtn = document.createElement('button');
    stylBtn(filterBtn);
    filterBtn.textContent = prefs.filterRemix ? 'Filter: Remix-now' : 'Filter: All';
    filterBtn.onclick = ()=>{
      const p=getPrefs(); p.filterRemix=!p.filterRemix; setPrefs(p);
      filterBtn.textContent = p.filterRemix ? 'Filter: Remix-now' : 'Filter: All';
      applyFilter();
    };

    bar.appendChild(filterBtn);
    document.documentElement.appendChild(bar);
    controlBar = bar;
    return bar;
  }

  function gridContainer(){
    const anchors = Array.from(document.querySelectorAll('a[href^="/p/s_"]'));
    if (!anchors.length) return null;
    let parent = anchors[0].parentElement;
    while (parent && parent!==document.body){
      const count = parent.querySelectorAll('a[href^="/p/s_"]').length;
      if (count===anchors.length) return parent;
      parent = parent.parentElement;
    }
    return document.body;
  }

  function resortGrid(){
    const prefs = getPrefs();
    if (!prefs.sortHot) return;
    const container = gridContainer();
    if (!container) return;
    const cards = selectAllCards().map(card=>{
      const id = extractIdFromCard(card);
      const meta = idToMeta.get(id);
      return { card, score: meta?.score ?? -1 };
    });
    const scored = cards.filter(x=>x.score>=0).length;
    if (scored < Math.max(6, Math.floor(cards.length*0.5))) return; // wait until enough data
    cards.sort((a,b)=>b.score-a.score);
    for (const {card} of cards) container.appendChild(card);
  }

  function applyFilter(){
    const prefs = getPrefs();
    const onlyRemix = !!prefs.filterRemix;
    for (const card of selectAllCards()){
      const id = extractIdFromCard(card);
      const meta = idToMeta.get(id);
      card.style.display = (!onlyRemix || !!meta?.remixNow) ? '' : 'none';
    }
  }

  // Fixed badge on the post detail page
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
      if (detailBadgeEl) {
        detailBadgeEl.remove();
        detailBadgeEl = null;
      }
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
    const parts = [];
    if (uv != null) {
      parts.push(rate ? `Unique: ${fmt(uv)} • ${rate}` : `Unique: ${fmt(uv)}`);
    } else if (rate) {
      parts.push(`Like rate: ${rate}`);
    }
    if (meta) {
      const ageStr = Number.isFinite(meta.ageMin) ? `${Math.round(meta.ageMin)}m` : '';
      const velStr = meta.velPerHour ? `↑ ${fmt(meta.velPerHour)}/h` : '';
      const scoreStr = `🔥 ${meta.score}`;
      parts.push([scoreStr, velStr, ageStr].filter(Boolean).join(' • '));
    }
    el.textContent = parts.join('  —  ');
    el.style.background = meta?.remixNow ? 'rgba(255,69,0,0.85)' : 'rgba(0,0,0,0.75)';
    const ageRounded = meta && Number.isFinite(meta.ageMin) ? Math.round(meta.ageMin) : '∞';
    const tooltipLines = [];
    if (uv != null) tooltipLines.push(`Unique: ${fmt(uv)}`);
    if (likes != null) tooltipLines.push(`Likes: ${fmt(likes)}`);
    if (totalViews != null) tooltipLines.push(`Views: ${fmt(totalViews)}`);
    if (rate) tooltipLines.push(`Like rate: ${rate}`);
    if (meta) {
      tooltipLines.push(`Score: ${meta.score}`);
      tooltipLines.push(`Velocity: ${meta.velPerHour || 0}/h`);
      tooltipLines.push(`Age: ${ageRounded} min`);
      if (meta.remixNow) tooltipLines.push('Remix now ✅');
    }
    el.title = tooltipLines.join('\n');
  }

  // ---------- observers ----------
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

  function processFeedJson(json) {
    const items = json?.items || json?.data?.items || [];
    const batch = [];
    for (const it of items) {
      const id = getItemId(it);
      const uv = getUniqueViews(it);
      const likes = getLikes(it);
      const tv = getTotalViews(it);
      const cm = getComments(it);
      const rx = getRemixes(it);
      const sh = getShares(it);
      const dl = getDownloads(it);
      const p = it?.post || it || {};
      const created_at = p?.created_at ?? p?.uploaded_at ?? p?.createdAt ?? p?.created ?? p?.posted_at ?? p?.timestamp ?? null;
      const th = getThumbnail(it);
      if (!id) continue;
      if (uv != null) {
        idToUnique.set(id, uv);
        const velPerHour = updateVelocity(id, uv);
        const meta = calcHotness({ likes: likes ?? 0, remixes: rx ?? 0, views: uv, created_at, velPerHour });
        idToMeta.set(id, meta);
        lastScores.push(meta.score); if (lastScores.length > 200) lastScores.shift();
      }
      if (likes != null) idToLikes.set(id, likes);
      if (tv != null) idToViews.set(id, tv);
      const meta = extractUserMeta(it) || {};
      const pf = pageFallbackUser();
      const pageUserKey = pf?.userKey || null;
      const pageUserHandle = pf?.userHandle || null;
      const absUrl = `${location.origin}/p/${id}`;
      batch.push({ postId: id, uv, likes, views: tv, comments: cm, remixes: rx, shares: sh, downloads: dl, created_at, thumb: th, url: absUrl, pageUserKey, pageUserHandle, ...meta, ts: Date.now() });
    }
    if (batch.length) try { window.postMessage({ __sora_uv__: true, type: 'metrics_batch', items: batch }, '*'); } catch {}
    renderBadges();
    renderDetailBadge();
  }

  function extractUserMeta(item){
    try {
      const p = item?.post ?? item;
      const directHandle = p?.user_handle || p?.author_handle || p?.owner_handle || p?.creator_handle || item?.user_handle || item?.author_handle;
      const directId = p?.user_id || p?.author_id || p?.owner_id || p?.creator_id || item?.user_id || item?.author_id;
      let candidates = [
        p?.user, p?.author, p?.creator, p?.owner, p?.profile, p?.channel, p?.actor,
        item?.user, item?.author, item?.creator, item?.owner, item?.profile, item?.channel, item?.actor
      ].filter(Boolean);
      let handle = directHandle || null;
      let id = directId || null;
      for (const u of candidates){
        if (!handle) handle = u.handle || u.username || u.user_name || u.screen_name || (typeof u.name==='string' && u.name.startsWith('@') ? u.name.slice(1) : null);
        if (!id) id = u.id || u.user_id || u.uid || u.profile_id || u.channel_id || null;
        if (handle && id) break;
      }
      // Fallback to page-level profile when available
      if (!handle && !id) {
        const pf = pageFallbackUser();
        if (pf) return pf;
      }
      const userKey = (handle || id || '').toString().toLowerCase() || 'unknown';
      return { userHandle: handle || null, userId: id || null, userKey };
    } catch {}
    return null;
  }

  function pageFallbackUser(){
    try{
      if (isProfile()){
        const m = location.pathname.match(/^\/profile\/(?:@)?([^\/?#]+)/i);
        if (m && m[1]){
          const handle = decodeURIComponent(m[1]);
          const key = handle.toLowerCase();
          return { userHandle: handle, userId: null, userKey: key };
        }
      }
    } catch {}
    return null;
  }

  // ---------- optional bootstrap ----------
  async function bootstrapIfNeeded() {
    try {
      if (isExplore()) {
        await prefetchPaged('/backend/project_y/feed?limit=16&cut=nf2_top', 2);
      }
      if (isProfile()) {
        await prefetchPaged('/backend/project_y/profile_feed/me?limit=15&cut=nf2', 2);
      }
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
