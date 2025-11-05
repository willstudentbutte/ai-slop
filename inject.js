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
 * - "Super-hot" state (50+ likes <1h) adds a red glow and 🔥🔥🔥🔥🔥 emoji.
 * - "Gather" mode button (only on /profile/ pages) auto-scrolls and refreshes the page to populate the feed.
 * - Gather mode speed (1 min to 17 min refreshes) is controllable via a slider. Speed translates across tabs.
 */

(function () {
  'use strict';

  try { console.log('[SoraUV] inject.js loaded'); } catch {}

  // Debug toggles
  const DEBUG = { feed: true, thumbs: true };
  const dlog = (topic, ...args) => { try { if (DEBUG[topic]) console.log('[SoraUV]', topic, ...args); } catch {} };

  // == Configuration & Constants ==

  const PREF_KEY = 'SORA_UV_PREFS_V1';
  const SESS_KEY = 'SORA_UV_GATHER_STATE_V1';
  // Match known endpoints, but keep flexible: project_* or any path that includes feed/profile
  const FEED_RE = /\/(backend\/project_[a-z]+\/)?(feed|profile_feed|profile\/)/i;

  const FILTER_STEPS_MIN = [null, 180, 360, 720, 900, 1080];
  const FILTER_LABELS = ['Filter', '<3 hours', '<6 hours', '<12 hours', '<15 hours', '<18 hours'];

  // == State Variables ==

  const idToUnique = new Map();
  const idToLikes = new Map();
  const idToViews = new Map();
  const idToComments = new Map();
  const idToRemixes = new Map();
  const idToMeta = new Map();

  let controlBar = null;
  let gatherTimerEl = null;
  let detailBadgeEl = null;

  let gatherScrollIntervalId = null;
  let gatherRefreshTimeoutId = null;
  let gatherCountdownIntervalId = null;
  let isGatheringActiveThisTab = false;

  // == Utility & Formatting Helpers ==

  const fmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(n % 1e6 ? 1 : 0) + 'M' :
    n >= 1e3 ? (n / 1e3).toFixed(n % 1e3 ? 1 : 0) + 'K' :
    String(n));

  function fmtAgeMin(ageMin) {
    if (!Number.isFinite(ageMin)) return '∞';
    const mTotal = Math.max(0, Math.floor(ageMin));
    const MIN_PER_H = 60,
      MIN_PER_D = 24 * MIN_PER_H,
      MIN_PER_Y = 365 * MIN_PER_D;
    let r = mTotal;
    const y = Math.floor(r / MIN_PER_Y);
    r -= y * MIN_PER_Y;
    const d = Math.floor(r / MIN_PER_D);
    r -= d * MIN_PER_D;
    const h = Math.floor(r / MIN_PER_H);
    r -= h * MIN_PER_H;
    const m = r;
    const parts = [];
    if (y) parts.push(`${y}y`);
    if (d) parts.push(`${d}d`);
    if (h) parts.push(`${h}h`);
    parts.push(`${m}m`);
    return parts.join(' ');
  }

  function fmtRefreshCountdown(ms) {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return `${m}m ${s.toString().padStart(2, '0')}s`;
  }

  const minutesSince = (epochSec) => !epochSec ? Infinity : Math.max(0, (Date.now() / 1000 - epochSec) / 60);

  const fmtPct = (num, denom, digits = 1) => {
    const n = Number(num),
      d = Number(denom);
    if (!Number.isFinite(n) || !Number.isFinite(d) || d <= 0) return null;
    return ((n / d) * 100).toFixed(digits) + '%';
  };

  const likeRate = (likes, unique, views) => {
    const l = Number(likes);
    if (!Number.isFinite(l) || l < 0) return null;
    const u = Number(unique);
    const v = Number(views);
    const denom = (Number.isFinite(u) && u > 0) ? u : ((Number.isFinite(v) && v > 0) ? v : null);
    return denom ? fmtPct(l, denom) : null;
  };

  const interactionRate = (likes, comments, unique) => {
    // Interactions exclude remixes, shares, and downloads
    const l = Number(likes);
    const c = Number(comments);
    const u = Number(unique);
    const sum = (Number.isFinite(l) && l > 0 ? l : 0) + (Number.isFinite(c) && c > 0 ? c : 0);
    return (Number.isFinite(u) && u > 0) ? fmtPct(sum, u) : null;
  };

  const lerp = (a, b, t) => a + (b - a) * t;

  // == Page & URL Helpers ==

  const normalizeId = (s) => s?.toString().split(/[?#]/)[0].trim();
  const isExplore = () => location.pathname.startsWith('/explore');
  const isProfile = () => location.pathname.startsWith('/profile');
  const isPost = () => /^\/p\/s_[A-Za-z0-9]+/i.test(location.pathname);

  const isFilterHiddenPage = () => {
    const path = location.pathname;
    return path.startsWith('/storyboard') || path.startsWith('/drafts') || path.startsWith('/d/') || path.startsWith('/p/');
  };

  function currentSIdFromURL() {
    const m = location.pathname.match(/^\/p\/(s_[A-Za-z0-9]+)/i);
    return m ? m[1] : null;
  }

  function currentProfileHandleFromURL() {
    const m = location.pathname.match(/^\/profile\/(?:username\/)?([^\/?#]+)/i);
    return m ? m[1] : null;
  }

  // == Data Extraction Helpers ==

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

      const id = getItemId(item);
      
      // 1) STRICT: use attachments.encodings.thumbnail.path like in first attempt
      const atts = Array.isArray(p?.attachments) ? p.attachments : null;
      if (atts) {
        for (const att of atts) {
          const t = att?.encodings?.thumbnail?.path;
          if (typeof t === 'string' && /^https?:\/\//.test(t)) {
            dlog('thumbs', 'picked', { id, source: 'att.encodings.thumbnail', url: t });
            return t;
          }
        }
      }

      // 2) Fallback: stable preview from API if present
      if (typeof p?.preview_image_url === 'string' && /^https?:\/\//.test(p.preview_image_url)) {
        dlog('thumbs', 'picked', { id, source: 'preview_image_url', url: p.preview_image_url });
        return p.preview_image_url;
      }

      // 3) Other common fields across variants (pick first valid)
      const pairs = [
        ['thumbnail_url', p?.thumbnail_url],
        ['thumb', p?.thumb],
        ['cover', p?.cover],
        ['image.url|image', p?.image?.url || p?.image],
        ['images[0].url', Array.isArray(p?.images) ? p.images[0]?.url : null],
        ['media.thumb|cover|poster', p?.media?.thumbnail || p?.media?.cover || p?.media?.poster],
        ['assets[0].thumb|url', Array.isArray(p?.assets) ? p.assets[0]?.thumbnail_url || p.assets[0]?.url : null],
        ['poster.url', p?.poster?.url],
      ];
      for (const [label, u] of pairs) {
        if (typeof u === 'string' && /^https?:\/\//.test(u)) {
          dlog('thumbs', 'picked', { id, source: label, url: u });
          return u;
        }
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

  const extractIdFromCard = (el) => {
    const link = el.querySelector('a[href^="/p/s_"]');
    if (!link) return null;
    const m = link.getAttribute('href').match(/\/p\/(s_[A-Za-z0-9]+)/i);
    return m ? normalizeId(m[1]) : null;
  };

  const selectAllCards = () => Array.from(document.querySelectorAll('a[href^="/p/s_"]'))
    .map(a => a.closest('article,div,section') || a);

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
        // Use only direct remix count; avoid any recursive aggregates
        p?.remix_count,
        p?.stats?.remix_count, p?.statistics?.remix_count,
      ];
      for (const v of cands) {
        const n = Number(v);
        if (Number.isFinite(n)) return n;
      }
    } catch {}
    return null;
  };

  // shares/downloads not used

  const getFollowerCount = (item) => {
    try {
      const p = item?.post ?? item;
      const cands = [
        item?.profile?.follower_count, item?.user?.follower_count, item?.author?.follower_count,
        p?.author?.follower_count, p?.owner?.follower_count,
        item?.owner_profile?.follower_count,
      ];
      for (const v of cands) {
        const n = Number(v);
        if (Number.isFinite(n)) return n;
      }
    } catch {}
    return null;
  };

  function getOwner(item) {
    try {
      const p = item?.post ?? item;
      const prof = item?.profile || item?.owner_profile || item?.user || item?.author || p?.author || p?.owner || p?.profile || null;
      // Prefer canonical numeric-ish/user id from post.shared_by when available
      let id = p?.shared_by || prof?.user_id || prof?.id || prof?._id || null;
      // Prefer "username" for handle when present
      let handle = prof?.username || prof?.handle || prof?.name || null;
      return {
        handle: (typeof handle === 'string' && handle) ? handle : null,
        id: (typeof id === 'string' && id) ? id : null
      };
    } catch {
      return { handle: null, id: null };
    }
  }

  // == Badge & UI Logic (Feed) ==

  function colorForAgeMin(ageMin) {
    if (!Number.isFinite(ageMin)) return null;
    const hHours = ageMin / 60;
    if (hHours < 0 || hHours >= 18) return null;
    const idx = Math.floor(hHours);
    const t = idx / 17;
    const h = 0 + (50 * t);
    const l = 42 - (12 * t);
    return `hsla(${h.toFixed(1)}, 100%, ${l.toFixed(1)}%, 0.92)`;
  }

  function isNearWholeDay(ageMin, windowMin = 15) {
    if (!Number.isFinite(ageMin) || ageMin < 0) return false;
    const MIN_PER_D = 1440;
    const nearest = Math.round(ageMin / MIN_PER_D) * MIN_PER_D;
    const diff = Math.abs(ageMin - nearest);
    return nearest >= MIN_PER_D && diff <= windowMin;
  }

  const greenEmblemColor = () => 'hsla(120, 85%, 32%, 0.92)';

  function fireForAge(ageMin) {
    if (!Number.isFinite(ageMin)) return '';
    const h = ageMin / 60;
    if (h < 6) return '🔥🔥🔥';
    if (h < 12) return '🔥🔥';
    if (h < 18) return '🔥';
    return '';
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

  function badgeBgFor(id, meta) {
    if (!meta) return null;
    const ageMin = meta.ageMin;
    const likes = idToLikes.get(id) ?? 0;
    if (likes >= 50 && Number.isFinite(ageMin) && ageMin < 60) {
      return colorForAgeMin(0);
    }
    if (isNearWholeDay(ageMin)) return greenEmblemColor();
    if (likes > 25) return colorForAgeMin(ageMin);
    return null;
  }

  function badgeEmojiFor(id, meta) {
    if (!meta) return '';
    const ageMin = meta.ageMin;
    const likes = idToLikes.get(id) ?? 0;
    if (likes >= 50 && Number.isFinite(ageMin) && ageMin < 60) {
      return '🔥🔥🔥🔥🔥';
    }
    if (isNearWholeDay(ageMin)) return '📝';
    if (likes > 25) return fireForAge(ageMin);
    return '';
  }

  function addBadge(card, views, meta) {
    if (views == null && !meta) return;
    const badge = ensureBadge(card);
    const id = extractIdFromCard(card);
    const likes = idToLikes.get(id) ?? 0;
    const ageMin = meta?.ageMin;
    const isSuperHot = likes >= 50 && Number.isFinite(ageMin) && ageMin < 60;

    const viewsStr = views != null ? `${fmt(views)} views` : null;
    const ageStr = Number.isFinite(meta?.ageMin) ? fmtAgeMin(meta.ageMin) : null;
    const emoji = badgeEmojiFor(id, meta);
    const ir = interactionRate(idToLikes.get(id), idToComments.get(id), idToUnique.get(id));
    const irStr = ir ? `${ir} IR` : null;

    const textParts = [viewsStr, irStr, ageStr, emoji].filter(Boolean);
    badge.textContent = textParts.join(' • ');

    const bg = badgeBgFor(id, meta);
    badge.style.background = bg || 'rgba(0,0,0,0.72)';
    if (isSuperHot) {
      badge.style.boxShadow = '0 0 10px 3px hsla(0, 100%, 50%, 0.7)';
    } else {
      badge.style.boxShadow = 'none';
    }

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

  // == Badge & UI Logic (Detail Page) ==

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
    const ir = interactionRate(likes, idToComments.get(sid), uv);
    if (uv == null && !rate && !ir) return;

    const el = ensureDetailBadge();
    const meta = idToMeta.get(sid);
    const ageMin = meta?.ageMin;
    const isSuperHot = (likes ?? 0) >= 50 && Number.isFinite(ageMin) && ageMin < 60;

    const viewsStr = uv != null ? `${fmt(uv)} views` : null;
    const ageStr = Number.isFinite(meta?.ageMin) ? fmtAgeMin(meta.ageMin) : null;
    const emoji = badgeEmojiFor(sid, meta);
    const irStr = ir ? `${ir} IR` : null;

    el.textContent = [viewsStr, irStr, ageStr, emoji].filter(Boolean).join(' • ');

    const bg = badgeBgFor(sid, meta);
    el.style.background = bg || 'rgba(0,0,0,0.75)';
    if (isSuperHot) {
      el.style.boxShadow = '0 0 10px 3px hsla(0, 100%, 50%, 0.7)';
    } else {
      el.style.boxShadow = 'none';
    }

    const note = isNearWholeDay(meta?.ageMin) ? 'Green day mark ✅' : (bg ? 'Hot ✅' : '');
    const ageLabel = ageStr || '∞';
    el.title = meta ? `Age: ${ageLabel}${note ? `\n${note}` : ''}` : '';
  }

  // == Control Bar UI ==

  function stylBtn(b) {
    Object.assign(b.style, {
      background: 'rgba(255,255,255,0.12)',
      color: '#fff',
      border: '1px solid rgba(255,255,255,0.2)', // This is the original, correct line
      borderRadius: '8px',
      padding: '4px 8px',
      cursor: 'pointer'
    });
    b.onmouseenter = () => {
      if (b.dataset.gathering === 'true' || b.disabled) return;
      b.style.background = 'rgba(255,255,255,0.2)';
    };
    b.onmouseleave = () => {
      if (b.dataset.gathering === 'true' || b.disabled) return;
      b.style.background = 'rgba(255,255,255,0.12)';
    };
  }

  // == MODIFIED FUNCTION ==
  function ensureControlBar() {
    if (controlBar && document.contains(controlBar)) return controlBar;

    const bar = document.createElement('div');
    bar.className = 'sora-uv-controls';
    Object.assign(bar.style, {
      position: 'fixed',
      top: '12px',
      right: '12px',
      zIndex: 999999,
      display: 'flex',
      gap: '8px',
      padding: '6px 8px',
      borderRadius: '10px',
      background: 'rgba(0,0,0,0.55)',
      color: '#fff',
      fontSize: '12px',
      alignItems: 'center',
      backdropFilter: 'blur(2px)',
      userSelect: 'none',
      flexDirection: 'column'
    });

    const buttonContainer = document.createElement('div');
    buttonContainer.style.display = 'flex';
    buttonContainer.style.gap = '8px';

    // 1. Handle universal prefs (speed) from localStorage
    let prefs = getPrefs();
    if (typeof prefs.gatherSpeed !== 'string') {
        prefs.gatherSpeed = '0'; // Default to turtle speed (0)
        setPrefs(prefs); // Save back *only* speed
    }

    // 2. Handle tab-specific state (filter index, gather status) from sessionStorage
    let sessionState = getGatherState();
    if (typeof sessionState.filterIndex !== 'number') {
      sessionState.filterIndex = 0; // Default filter index
    }
    isGatheringActiveThisTab = sessionState.isGathering || false;
    setGatherState(sessionState); // Save state with default filterIndex if it was missing

    const filterBtn = document.createElement('button');
    stylBtn(filterBtn);
    
    // 3. Update setLabel to read from sessionStorage
    const setLabel = () => {
      const s = getGatherState(); // Read from session
      filterBtn.textContent = FILTER_LABELS[s.filterIndex ?? 0];
    };
    setLabel();

    // 4. Update filterBtn.onclick to use sessionStorage
    filterBtn.onclick = () => {
      const s = getGatherState(); // Get current tab state
      s.filterIndex = ((s.filterIndex ?? 0) + 1) % FILTER_STEPS_MIN.length;
      setGatherState(s); // Save new tab state
      setLabel();
      applyFilter();
    };
    
    buttonContainer.appendChild(filterBtn);

    const gatherBtn = document.createElement('button');
    gatherBtn.className = 'sora-uv-gather-btn';
    gatherBtn.dataset.gathering = 'false';
    stylBtn(gatherBtn);
    buttonContainer.appendChild(gatherBtn);

    bar.appendChild(buttonContainer);

    const gatherControlsWrapper = document.createElement('div');
    gatherControlsWrapper.className = 'sora-uv-gather-controls-wrapper';
    Object.assign(gatherControlsWrapper.style, {
      display: 'none', // This wrapper is hidden by default
      flexDirection: 'column',
      width: '100%',
      gap: '6px', // Gap between slider and timer
      alignItems: 'center',
    });

    const sliderContainer = document.createElement('div');
    sliderContainer.className = 'sora-uv-slider-container';
    Object.assign(sliderContainer.style, {
      display: 'flex', // This is now 'flex' by default, parent controls visibility
      width: '100%',
      alignItems: 'center',
      gap: '5px',
    });

    const emojiTurtle = document.createElement('span');
    emojiTurtle.textContent = '🐢';
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '100';
    slider.step = '1';
    slider.value = prefs.gatherSpeed; // Read universal speed from prefs
    slider.style.flexGrow = '1';
    const emojiRabbit = document.createElement('span');
    emojiRabbit.textContent = '🐇';

    sliderContainer.appendChild(emojiTurtle);
    sliderContainer.appendChild(slider);
    sliderContainer.appendChild(emojiRabbit);
    gatherControlsWrapper.appendChild(sliderContainer); // Add slider to wrapper

    const refreshTimerDisplay = document.createElement('div');
    refreshTimerDisplay.className = 'sora-uv-refresh-timer';
    Object.assign(refreshTimerDisplay.style, {
      width: '100%',
      textAlign: 'center',
      fontSize: '11px',
      color: 'rgba(255, 255, 255, 0.7)',
      lineHeight: '1',
    });
    gatherControlsWrapper.appendChild(refreshTimerDisplay); // Add timer to wrapper
    gatherTimerEl = refreshTimerDisplay;

    bar.appendChild(gatherControlsWrapper); // Add the whole wrapper to the bar

    const onSliderChange = () => {
      let p = getPrefs();
      p.gatherSpeed = slider.value;
      setPrefs(p);
      if (isGatheringActiveThisTab) {
        startGathering(true);
      }
    };
    slider.addEventListener('input', onSliderChange);

    bar.updateGatherState = function () {
      if (isGatheringActiveThisTab) {
        gatherBtn.textContent = 'Gathering...';
        gatherBtn.style.background = 'hsla(120, 60%, 30%, 0.9)';
        gatherBtn.dataset.gathering = 'true';
        filterBtn.disabled = true;
        filterBtn.style.opacity = '0.5';
        filterBtn.style.cursor = 'not-allowed';
        if (isProfile()) {
          gatherControlsWrapper.style.display = 'flex';
        }
        startGathering(false); // Default: resume timer if available
        if (!gatherCountdownIntervalId) {
          gatherCountdownIntervalId = setInterval(updateCountdownDisplay, 1000);
        }
      } else {
        gatherBtn.textContent = 'Gather';
        gatherBtn.style.background = 'rgba(255,255,255,0.12)';
        gatherBtn.dataset.gathering = 'false';
        filterBtn.disabled = false;
        filterBtn.style.opacity = '1';
        filterBtn.style.cursor = 'pointer';
        gatherControlsWrapper.style.display = 'none';
        stopGathering(true);
      }
    };

    // 5. Update gatherBtn.onclick to reset the filter in sessionStorage
    gatherBtn.onclick = () => {
      isGatheringActiveThisTab = !isGatheringActiveThisTab;
      let sState = getGatherState(); // Get current tab state
      sState.isGathering = isGatheringActiveThisTab;
      
      if (!isGatheringActiveThisTab) {
        delete sState.refreshDeadline;
      } else {
        // Reset filter *for this tab* when gathering starts
        sState.filterIndex = 0;
      }
      
      setGatherState(sState); // Save updated tab state (gathering status + filter reset)
      bar.updateGatherState(); // Update UI

      if (isGatheringActiveThisTab) {
        // These actions now happen *after* state is set
        setLabel(); // setLabel will read the new '0' index from session
        applyFilter(); // applyFilter will read the new '0' index
      }
    };

    document.documentElement.appendChild(bar);
    controlBar = bar;
    return bar;
  }

  // == Filtering Logic ==

  // == MODIFIED FUNCTION ==
  function applyFilter() {
    // Read filter index from tab-specific session state
    const sessionState = getGatherState();
    const idx = sessionState.filterIndex ?? 0;
    const limitMin = FILTER_STEPS_MIN[idx];

    for (const card of selectAllCards()) {
      const id = extractIdFromCard(card);
      const meta = idToMeta.get(id);
      
      // If no filter is set (null) OR gathering is active, show the card
      if (limitMin == null || isGatheringActiveThisTab) {
        card.style.display = '';
        continue;
      }
      
      // This logic now only runs if a filter is set AND gathering is off
      const show = Number.isFinite(meta?.ageMin) && meta.ageMin <= limitMin;
      card.style.display = show ? '' : 'none';
    }
  }

  // == Gather Mode Logic ==

  function getGatherState() {
    try {
      return JSON.parse(sessionStorage.getItem(SESS_KEY) || '{}');
    } catch {
      return {};
    }
  }

  function setGatherState(s) {
    sessionStorage.setItem(SESS_KEY, JSON.stringify(s));
  }

  function updateCountdownDisplay() {
    if (!isGatheringActiveThisTab || !gatherTimerEl) {
      if (gatherTimerEl) gatherTimerEl.textContent = '';
      return;
    }
    const state = getGatherState();
    const deadline = state.refreshDeadline;
    if (deadline && deadline > Date.now()) {
      const remainingMs = deadline - Date.now();
      gatherTimerEl.textContent = `Refresh in ${fmtRefreshCountdown(remainingMs)}`;
    } else if (deadline) {
      gatherTimerEl.textContent = 'Refreshing...';
    } else {
      gatherTimerEl.textContent = ''; // Clear text if no deadline
    }
  }

  function startGathering(forceNewDeadline = false) {
    // Ensure no stacked timers from prior runs
    if (gatherScrollIntervalId) {
      clearTimeout(gatherScrollIntervalId);
      gatherScrollIntervalId = null;
    }
    if (gatherRefreshTimeoutId) {
      clearTimeout(gatherRefreshTimeoutId);
      gatherRefreshTimeoutId = null;
    }

    stopGathering(false); // keep your session state behavior

    console.log('UV: Starting gathering...');

    const prefs = getPrefs();
    const speedValue = (prefs.gatherSpeed != null) ? prefs.gatherSpeed : '0'; // 0=turtle, 100=rabbit
    const tRaw = Number(speedValue) / 100;
    const t = Math.min(1, Math.max(0, tRaw)); // clamp 0..1

    // Known-good lerp (no surprises)
    const lerp = (a, b, u) => a + (b - a) * u;

    let scrollMinMs, scrollMaxMs, refreshMinMs, refreshMaxMs;

    // Turtle: 15-17 min refresh, 10-15 sec scroll
    const speedSlow = { sMin: 10000, sMax: 15000, rMin: 15 * 60 * 1000, rMax: 17 * 60 * 1000 };
    // Middle: 7-9 min refresh, 4.5-6.5 sec scroll
    const speedMid = { sMin: 4500, sMax: 6500, rMin: 7 * 60 * 1000, rMax: 9 * 60 * 1000 };
    // Rabbit: 1-2 min refresh, 50-150 ms scroll
    const speedFast = { sMin: 50, sMax: 150, rMin: 1 * 60 * 1000, rMax: 2 * 60 * 1000 };

    if (t <= 0.5) {
      const u = t / 0.5; // 0..1 from slow→mid
      scrollMinMs = lerp(speedSlow.sMin, speedMid.sMin, u);
      scrollMaxMs = lerp(speedSlow.sMax, speedMid.sMax, u);
      refreshMinMs = lerp(speedSlow.rMin, speedMid.rMin, u);
      refreshMaxMs = lerp(speedSlow.rMax, speedMid.rMax, u);
    } else {
      const u = (t - 0.5) / 0.5; // 0..1 from mid→fast
      scrollMinMs = lerp(speedMid.sMin, speedFast.sMin, u);
      scrollMaxMs = lerp(speedMid.sMax, speedFast.sMax, u);
      refreshMinMs = lerp(speedMid.rMin, speedFast.rMin, u);
      refreshMaxMs = lerp(speedMid.rMax, speedFast.rMax, u);
    }

    console.log(
      `UV: Speed t=${t.toFixed(2)} | scroll=[${Math.round(scrollMinMs)}..${Math.round(scrollMaxMs)}] ms | ` +
      `refresh=[${Math.round(refreshMinMs / 60000)}..${Math.round(refreshMaxMs / 60000)}] min`
    );

    // Scroll loop
    function randomScroll() {
      if (window.innerHeight + window.scrollY < document.body.scrollHeight - 100) {
        // Fixed scroll amounts - no randomization
        const scrollAmount = t <= 0.1 ? 3 : (t <= 0.3 ? 8 : (t <= 0.7 ? 20 : 100));
        window.scrollBy(0, scrollAmount);
      }
      const delay = Math.random() * (scrollMaxMs - scrollMinMs) + scrollMinMs;
      gatherScrollIntervalId = setTimeout(randomScroll, delay);
    }
    randomScroll();

    // Refresh timer
    const now = Date.now();
    let refreshDelay;
    let sessionState = getGatherState() || {};
    if (!forceNewDeadline && sessionState.refreshDeadline && sessionState.refreshDeadline > now) {
      refreshDelay = sessionState.refreshDeadline - now;
      console.log(`UV: Resuming refresh timer. ${Math.round(refreshDelay/1000)}s remaining.`);
    } else {
      refreshDelay = Math.random() * (refreshMaxMs - refreshMinMs) + refreshMinMs;
      sessionState.refreshDeadline = now + refreshDelay;
      setGatherState(sessionState);
      const logMsg = forceNewDeadline ? 'New forced' : 'New';
      console.log(`UV: ${logMsg} refresh timer set for ${Math.round(refreshDelay/1000)}s.`);
    }
    gatherRefreshTimeoutId = setTimeout(() => {
      console.log('UV: Refreshing page...');
      location.reload();
    }, refreshDelay);

    updateCountdownDisplay(); // Immediately update countdown UI
  }

  function stopGathering(clearSessionState = true) {
    console.log('Sora UV: Stopping gathering.');
    if (gatherScrollIntervalId) {
      clearTimeout(gatherScrollIntervalId);
      gatherScrollIntervalId = null;
    }
    if (gatherRefreshTimeoutId) {
      clearTimeout(gatherRefreshTimeoutId);
      gatherRefreshTimeoutId = null;
    }
    if (clearSessionState) {
      sessionStorage.removeItem(SESS_KEY);
    }
    if (gatherCountdownIntervalId) {
      clearInterval(gatherCountdownIntervalId);
      gatherCountdownIntervalId = null;
    }
    if (gatherTimerEl) {
      gatherTimerEl.textContent = '';
    }
  }

  // --- 2. MODIFY THIS FUNCTION ---
  function updateControlsVisibility() {
    const bar = ensureControlBar();
    if (!bar) return;

    // --- ADDED LOGIC ---
    // Check if we are on a hidden page
    if (isFilterHiddenPage()) {
      bar.style.display = 'none'; // Hide the entire bar
      return; // Stop processing
    } else {
      // Otherwise, ensure the bar is visible
      // The default display style is 'flex' from ensureControlBar
      bar.style.display = 'flex';
    }
    // --- END ADDED LOGIC ---

    // Original logic resumes below:
    const gatherBtn = bar.querySelector('.sora-uv-gather-btn');
    const gatherControlsWrapper = bar.querySelector('.sora-uv-gather-controls-wrapper');
    if (!gatherBtn || !gatherControlsWrapper) return;

    if (isProfile()) {
      gatherBtn.style.display = '';
      bar.updateGatherState(); // This will handle showing/hiding the wrapper
    } else {
      gatherBtn.style.display = 'none';
      gatherControlsWrapper.style.display = 'none'; // Hide wrapper if not on profile
      if (isGatheringActiveThisTab) {
        console.log('Sora UV: Navigated off-profile, stopping gathering.');
        isGatheringActiveThisTab = false;
        let sState = getGatherState();
        sState.isGathering = false;
        delete sState.refreshDeadline;
        setGatherState(sState);
        bar.updateGatherState(); // This will run the "stop" logic
      }
    }
  }
  // --- END MODIFICATION ---

  // == Preferences & Storage ==

  function getPrefs() {
    try {
      return JSON.parse(localStorage.getItem(PREF_KEY) || '{}')
    } catch {
      return {}
    }
  }

  function setPrefs(p) {
    localStorage.setItem(PREF_KEY, JSON.stringify(p));
  }

  function handleStorageChange(e) {
    if (e.key !== PREF_KEY) {
      return; // Ignore storage changes that aren't ours
    }

    console.log('Sora UV: Detected preference change from another tab.');

    try {
      const newPrefs = JSON.parse(e.newValue || '{}');
      if (newPrefs.gatherSpeed == null) return;

      // Update the slider UI in this tab
      const slider = document.querySelector('.sora-uv-controls input[type="range"]');
      if (slider && slider.value !== newPrefs.gatherSpeed) {
        slider.value = newPrefs.gatherSpeed;
      }

      // If gathering is active *in this tab*, restart it to apply the new speed
      if (isGatheringActiveThisTab) {
        console.log('Sora UV: Gathering is active, restarting with new speed.');
        startGathering(true); // Force new deadline & use new speed
      }
    } catch (err) {
      console.error('Sora UV: Error applying storage change.', err);
    }
  }

  // == Network & Data Processing ==

  function looksLikeSoraFeed(json){
    try {
      const items = json?.items || json?.data?.items || null;
      if (!Array.isArray(items) || items.length === 0) return false;
      let hits = 0;
      for (let i=0;i<Math.min(items.length, 10); i++){
        const it = items[i];
        const p = it?.post || it || {};
        if (typeof p?.id === 'string' && /^s_[A-Za-z0-9]+$/.test(p.id)) { hits++; continue; }
        if (typeof p?.preview_image_url === 'string') { hits++; continue; }
        if (Array.isArray(p?.attachments) && p.attachments.length) { hits++; continue; }
      }
      return hits > 0;
    } catch { return false; }
  }

  function installFetchSniffer() {
    dlog('feed', 'install fetch sniffer');
    const origFetch = window.fetch;
    window.fetch = async function (input, init) {
      const res = await origFetch.apply(this, arguments);
      try {
        const url = typeof input === 'string' ? input : (input?.url || '');
        if (FEED_RE.test(url)) {
          dlog('feed', 'fetch matched', { url });
          res.clone().json().then((j)=>{ dlog('feed', 'fetch parsed', { url, items: (j?.items||j?.data?.items||[]).length }); processFeedJson(j); }).catch(()=>{});
        } else if (typeof url === 'string' && url.startsWith(location.origin)) {
          res.clone().json().then((j)=>{
            if (looksLikeSoraFeed(j)) {
              dlog('feed', 'fetch autodetected', { url, items: (j?.items||j?.data?.items||[]).length });
              processFeedJson(j);
            }
          }).catch(()=>{});
        }
      } catch {}
      return res;
    };
    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.addEventListener('load', function () {
        try {
          if (typeof url === 'string' && FEED_RE.test(url)) {
            dlog('feed', 'xhr matched', { url });
            try {
              const j = JSON.parse(this.responseText);
              dlog('feed', 'xhr parsed', { url, items: (j?.items||j?.data?.items||[]).length });
              processFeedJson(j);
            } catch {}
          } else if (typeof url === 'string' && url.startsWith(location.origin)) {
            try {
              const j = JSON.parse(this.responseText);
              if (looksLikeSoraFeed(j)) {
                dlog('feed', 'xhr autodetected', { url, items: (j?.items||j?.data?.items||[]).length });
                processFeedJson(j);
              }
            } catch {}
          }
        } catch {}
      });
      return origOpen.apply(this, arguments);
    };
  }

  function processFeedJson(json) {
    const items = json?.items || json?.data?.items || [];
    const pageHandle = isProfile() ? currentProfileHandleFromURL() : null;
    const pageUserHandle = pageHandle || null;
    const pageUserKey = pageUserHandle ? `h:${pageUserHandle.toLowerCase()}` : 'unknown';
    const batch = [];

    dlog('feed', 'processFeedJson', { items: items.length, pageUserHandle });

    try {
      const profFollowers = Number(json?.follower_count ?? json?.profile?.follower_count);
      const profHandle = json?.username || json?.handle || json?.profile?.username || pageUserHandle || null;
      const profId = json?.user_id || json?.id || json?.profile?.user_id || null;
      if (Number.isFinite(profFollowers) && profHandle) {
        const userKey = `h:${String(profHandle).toLowerCase()}`;
        batch.push({
          followers: profFollowers,
          ts: Date.now(),
          userHandle: profHandle,
          userId: profId,
          userKey,
          pageUserHandle,
          pageUserKey
        });
      }
    } catch {}

    for (const it of items) {
      const id = getItemId(it);
      if (!id) continue;

      const uv = getUniqueViews(it);
      const likes = getLikes(it);
      const tv = getTotalViews(it);
      const cm = getComments(it);
      const rx = getRemixes(it);
      // shares/downloads not captured
      const p = it?.post || it || {};
      const created_at = p?.created_at ?? p?.uploaded_at ?? p?.createdAt ?? p?.created ?? p?.posted_at ?? p?.timestamp ?? null;
      const caption = (typeof p?.caption === 'string' && p.caption) ? p.caption : (typeof p?.text === 'string' && p.text ? p.text : null);
      const ageMin = minutesSince(created_at);
      const th = getThumbnail(it);
      try {
        const p = it?.post || it || {};
        const attCount = Array.isArray(p?.attachments) ? p.attachments.length : 0;
        dlog('thumbs', 'item', { id, attachments: attCount, preview_image_url: p?.preview_image_url || null, chosen: th });
      } catch {}

      if (uv != null) idToUnique.set(id, uv);
      if (likes != null) idToLikes.set(id, likes);
      if (tv != null) idToViews.set(id, tv);
      if (cm != null) idToComments.set(id, cm);
      if (rx != null) idToRemixes.set(id, rx);
      // no shares/downloads maps
      idToMeta.set(id, {
        ageMin
      });

      const absUrl = `${location.origin}/p/${id}`;
      const owner = getOwner(it);
      const userHandle = owner.handle || pageUserHandle || null;
      const userId = owner.id || null;
      const userKey = userHandle ? `h:${userHandle.toLowerCase()}` : (userId != null ? `id:${userId}` : pageUserKey);
      const followers = getFollowerCount(it);

      batch.push({
        postId: id,
        uv,
        likes,
        views: tv,
        comments: cm,
        remixes: rx,            // kept for backward compatibility in storage/UI
        remix_count: rx,        // explicit direct remix count
        // shares/downloads omitted
        followers,
        created_at,
        caption,
        ageMin,
        thumb: th,
        url: absUrl,
        ts: Date.now(),
        userHandle,
        userId,
        userKey,
        // relationship fields for direct remix derivation
        parent_post_id: p?.parent_post_id ?? null,
        root_post_id: p?.root_post_id ?? null,
        pageUserHandle,
        pageUserKey
      });
    }

    if (batch.length) try {
      dlog('feed', 'postMessage metrics_batch', { count: batch.length });
      window.postMessage({
        __sora_uv__: true,
        type: 'metrics_batch',
        items: batch
      }, '*');
    } catch {}

    renderBadges();
    renderDetailBadge();
  }

  // == Observers & Page Lifecycle ==

  const mo = new MutationObserver(() => {
    if (mo._raf) cancelAnimationFrame(mo._raf);
    mo._raf = requestAnimationFrame(() => {
      renderBadges();
      renderDetailBadge();
      updateControlsVisibility();
    });
  });

  function startObservers() {
    mo.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
    renderBadges();
    renderDetailBadge();
    updateControlsVisibility();
  }

  (function patchHistory() {
    const _push = history.pushState,
      _replace = history.replaceState;
    const fire = () => setTimeout(onRouteChange, 0);
    history.pushState = function () {
      const r = _push.apply(this, arguments);
      fire();
      return r;
    };
    history.replaceState = function () {
      const r = _replace.apply(this, arguments);
      fire();
      return r;
    };
    window.addEventListener('popstate', fire);
  })();

  function onRouteChange() {
    renderBadges();
    renderDetailBadge();
    updateControlsVisibility();
  }

  // == Initialization ==

  function init() {
    dlog('feed', 'init');
    installFetchSniffer();
    startObservers();
    onRouteChange();
    window.addEventListener('storage', handleStorageChange);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, {
      once: true
    });
  } else {
    init();
  }
})();
