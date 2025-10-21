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

  function addBadge(card, unique, likes, views) {
    if (unique == null) return;
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
        background: 'rgba(0,0,0,0.7)',
        color: '#fff',
        zIndex: 9999,
        pointerEvents: 'none',
        backdropFilter: 'blur(2px)',
      });
      card.appendChild(badge);
    }
    // Prefer unique viewers as denominator; fallback to total views
    const denom = (unique != null && unique > 0) ? unique : ((views != null && views > 0) ? views : null);
    const rate = (likes != null && denom != null) ? fmtPct(likes, denom) : null;

    if (rate != null) {
      badge.textContent = `Unique: ${fmt(unique)} • ${rate}`;
    } else if (likes != null && views != null) {
      // Fallback: show raw likes/views if we can't compute rate for some reason
      badge.textContent = `Unique: ${fmt(unique)} • ${fmt(likes)}/${fmt(views)}`;
    } else if (likes != null) {
      badge.textContent = `Unique: ${fmt(unique)} • ${fmt(likes)} likes`;
    } else if (views != null) {
      badge.textContent = `Unique: ${fmt(unique)} • ${fmt(views)} views`;
    } else {
      badge.textContent = `Unique: ${fmt(unique)}`;
    }
    // Helpful tooltip with raw counts if available
    const parts = [`Unique: ${fmt(unique)}`];
    if (likes != null) parts.push(`Likes: ${fmt(likes)}`);
    if (views != null) parts.push(`Views: ${fmt(views)}`);
    badge.title = parts.join(' | ');
  }

  function renderBadges() {
    for (const card of selectAllCards()) {
      const id = extractIdFromCard(card);
      if (!id) continue;
      const uv = idToUnique.get(id);
      if (uv != null) addBadge(card, uv, idToLikes.get(id), idToViews.get(id));
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
    if (uv == null) return;
    const el = ensureDetailBadge();
    const likes = idToLikes.get(sid);
    const views = idToViews.get(sid);
    // Prefer unique viewers as denominator; fallback to total views
    const denom = (uv != null && uv > 0) ? uv : ((views != null && views > 0) ? views : null);
    const rate = (likes != null && denom != null) ? fmtPct(likes, denom) : null;
    if (rate != null) {
      el.textContent = `Unique: ${fmt(uv)} • ${rate}`;
    } else if (likes != null && views != null) {
      el.textContent = `Unique: ${fmt(uv)} • ${fmt(likes)}/${fmt(views)}`;
    } else if (likes != null) {
      el.textContent = `Unique: ${fmt(uv)} • ${fmt(likes)} likes`;
    } else if (views != null) {
      el.textContent = `Unique: ${fmt(uv)} • ${fmt(views)} views`;
    } else {
      el.textContent = `Unique: ${fmt(uv)}`;
    }
    const titleParts = [`Unique: ${fmt(uv)}`];
    if (likes != null) titleParts.push(`Likes: ${fmt(likes)}`);
    if (views != null) titleParts.push(`Views: ${fmt(views)}`);
    el.title = titleParts.join(' | ');
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
      const lk = getLikes(it);
      const tv = getTotalViews(it);
      const th = getThumbnail(it);
      if (!id) continue;
      if (uv != null) idToUnique.set(id, uv);
      if (lk != null) idToLikes.set(id, lk);
      if (tv != null) idToViews.set(id, tv);
      const meta = extractUserMeta(it) || {};
      const pf = pageFallbackUser();
      const pageUserKey = pf?.userKey || null;
      const pageUserHandle = pf?.userHandle || null;
      const absUrl = `${location.origin}/p/${id}`;
      batch.push({ postId: id, uv, likes: lk, views: tv, thumb: th, url: absUrl, pageUserKey, pageUserHandle, ...meta, ts: Date.now() });
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
