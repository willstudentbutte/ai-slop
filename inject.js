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
  const idToViews = new Map();

  function addBadge(card, views) {
    if (views == null) return;
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
    badge.textContent = `Unique: ${fmt(views)}`;
  }

  function renderBadges() {
    for (const card of selectAllCards()) {
      const id = extractIdFromCard(card);
      if (!id) continue;
      const uv = idToViews.get(id);
      if (uv != null) addBadge(card, uv);
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
    const uv = idToViews.get(sid);
    if (uv == null) return;
    const el = ensureDetailBadge();
    el.textContent = `Unique: ${fmt(uv)}`;
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
    for (const it of items) {
      const id = getItemId(it);
      const uv = getUniqueViews(it);
      if (id && uv != null) idToViews.set(id, uv);
    }
    renderBadges();
    renderDetailBadge();
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
