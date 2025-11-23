/*
 * Copyright (c) 2025 Will (fancyson-ai), Topher (cameoed), Skye (thecosmicskye)
 * Licensed under the MIT License. See the LICENSE file for details.
 *
 * What this does (simple):
 * - Reads the site’s feed JSON and adds a small badge to each post card.
 * - Badge color is based on time since posting (all posts >25 likes): red (<1h) → yellow (18h) in 18 gradient steps from RED (hot) to YELLOW (warm).
 * - If age is within ±15m of a whole day (1d, 2d, 3d…), the badge turns green with a 📝 icon.
 * - Corner button cycles a time filter: All, <3h, <6h, <12h, <15h, <18h, <21h.
 * - "Gather" mode (profile/top) auto-scrolls + refreshes; Top now scrolls slightly faster and uses a 10m loop.
 */

(function () {
  'use strict';

  try {
    console.log('[SoraUV] inject.js loaded');
  } catch {}

  // Debug toggles
  const DEBUG = { feed: true, thumbs: true, analyze: true, drafts: false };
  const dlog = (topic, ...args) => {
    try {
      if (DEBUG[topic]) console.log('[SoraUV]', topic, ...args);
    } catch {}
  };

  // == Configuration & Constants ==
  const PREF_KEY = 'SORA_UV_PREFS_V1';
  const SESS_KEY = 'SORA_UV_GATHER_STATE_V1';
  const ANALYZE_VISITED_KEY = 'SORA_UV_ANALYZE_VISITED';
  const ANALYZE_VISITED_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
  const BOOKMARKS_KEY = 'SORA_UV_BOOKMARKS_V1';
  const FEED_RE = /\/(backend\/project_[a-z]+\/)?(feed|profile_feed|profile\/)/i;
  const DRAFTS_RE = /\/(backend\/project_[a-z]+\/)?profile\/drafts($|\/|\?)/i;

  // Includes <21h (1260 minutes)
  const FILTER_STEPS_MIN = [null, 180, 360, 720, 900, 1080, 1260];
  const FILTER_LABELS = ['All', '<3 hours', '<6 hours', '<12 hours', '<15 hours', '<18 hours', '<21 hours'];
  const ALLOWED_VIDEO_EXTENSIONS = ['mp4', 'mov', 'webm']; // Sora-supported video formats

  // == State Maps ==
  const idToUnique = new Map();
  const idToLikes = new Map();
  const idToViews = new Map();
  const idToComments = new Map();
  const idToRemixes = new Map();
  const idToMeta = new Map(); // { ageMin, userHandle }
  const idToDuration = new Map(); // Draft duration in seconds
  const idToPrompt = new Map(); // Draft prompt text
  const idToDownloadUrl = new Map(); // Draft downloadable URL
  const idToViolation = new Map(); // Draft content violation status

  // == Draft UI Constants ==
  const DRAFT_BUTTON_SIZE = 24; // px
  const DRAFT_BUTTON_MARGIN = 6; // px from edge
  const DRAFT_BUTTON_SPACING = 4; // px between buttons
  const SORA_DEFAULT_FPS = 30; // Sora standard framerate (fallback if API doesn't provide fps)

  // == UI State ==
  let controlBar = null;
  let gatherTimerEl = null;
  let detailBadgeEl = null;

  let gatherScrollIntervalId = null;
  let gatherRefreshTimeoutId = null;
  let gatherCountdownIntervalId = null;
  let isGatheringActiveThisTab = false;

  // Analyze (Top feed only)
  let analyzeActive = false;
  let analyzeBtn = null;
  let analyzeOverlayEl = null;
  let analyzeHeaderTextEl = null;
  let analyzeAutoRefreshId = null;
  let analyzeSliderWrap = null;
  let analyzeTableEl = null;
  let analyzeHelperTextEl = null;
  let analyzeRapidScrollId = null;
  let analyzeRapidStopTimeout = null;
  let analyzeRefreshRowsInterval = null;
  let analyzeCountdownIntervalId = null;
  let analyzeCountdownRemainingSec = 0;
  let analyzeSortKey = 'views';
  let analyzeSortDir = 'desc';

  // Time window (hours) for slicing rows
  const ANALYZE_WINDOW_KEY = 'SORA_UV_ANALYZE_WINDOW_H';
  let analyzeWindowHours = Math.min(24, Math.max(1, Number(localStorage.getItem(ANALYZE_WINDOW_KEY) || 24)));
  const ANALYZE_RUN_MS = 6500; // 6.5 seconds

  // Bookmarks (Drafts page only)
  // 0 = show all, 1 = show bookmarked only, 2 = show unbookmarked only, 3 = violations only
  let bookmarksFilterState = 0;
  let bookmarksBtn = null;

  // Performance: Cache draft cards to avoid constant DOM queries
  let cachedDraftCards = null;
  let cachedDraftCardsCount = 0;
  let processedDraftCards = new WeakSet(); // Track which cards have buttons already
  let processedDraftCardsCount = 0; // Track how many cards are fully processed
  let lastAppliedFilterState = -1; // Track when filter needs re-applying

  // Track route to detect same-tab navigation
  const routeKey = () => `${location.pathname}${location.search}`;
  let lastRouteKey = routeKey();

  // == Utils ==
  const fmt = (n) =>
    n >= 1e6
      ? (n / 1e6).toFixed(n % 1e6 ? 1 : 0) + 'M'
      : n >= 1e3
      ? (n / 1e3).toFixed(n % 1e3 ? 1 : 0) + 'K'
      : String(n);

  const fmtInt = (n) => {
    const x = Number(n);
    if (!Number.isFinite(x)) return '';
    return x.toLocaleString('en-US');
  };

  function truncateInline(str, max = 140) {
    if (typeof str !== 'string') return '';
    const s = str.replace(/\s+/g, ' ').trim();
    return s.length > max ? s.slice(0, max).trim() + '…' : s;
  }

  function fmtAgeMin(ageMin) {
    if (!Number.isFinite(ageMin)) return '∞';
    const mTotal = Math.max(0, Math.floor(ageMin));
    const MIN_PER_H = 60,
      MIN_PER_D = 1440,
      MIN_PER_Y = 525600;
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

  const minutesSince = (epochSec) => (!epochSec ? Infinity : Math.max(0, (Date.now() / 1000 - epochSec) / 60));

  const fmtPct = (num, denom, digits = 1) => {
    const n = Number(num),
      d = Number(denom);
    if (!Number.isFinite(n) || !Number.isFinite(d) || d <= 0) return null;
    return ((n / d) * 100).toFixed(digits) + '%';
  };

  const likeRate = (likes, unique, views) => {
    const l = Number(likes);
    if (!Number.isFinite(l) || l < 0) return null;
    const u = Number(unique),
      v = Number(views);
    const denom = Number.isFinite(u) && u > 0 ? u : Number.isFinite(v) && v > 0 ? v : null;
    return denom ? fmtPct(l, denom) : null;
  };

  const interactionRate = (likes, comments, unique) => {
    const l = Number(likes),
      c = Number(comments),
      u = Number(unique);
    const sum = (Number.isFinite(l) ? l : 0) + (Number.isFinite(c) ? c : 0);
    return Number.isFinite(u) && u > 0 ? fmtPct(sum, u) : null;
  };

  function remixRate(likes, remixes) {
    const l = Number(likes);
    const r = Number(remixes);
    if (!Number.isFinite(l) || l <= 0 || !Number.isFinite(r) || r < 0) return null;
    return ((r / l) * 100).toFixed(2);
  }

  // == Page type helpers ==
  const normalizeId = (s) => s?.toString().split(/[?#]/)[0].trim();
  const isExplore = () => location.pathname.startsWith('/explore');
  const isProfile = () => location.pathname.startsWith('/profile');
  const isPost = () => /^\/p\/s_[A-Za-z0-9]+/i.test(location.pathname);

  const isTopFeed = () => {
    try {
      const u = new URL(location.href);
      return u.origin === 'https://sora.chatgpt.com' && u.pathname === '/explore' && u.searchParams.get('feed') === 'top';
    } catch {
      return false;
    }
  };

  const isFilterHiddenPage = () => {
    const p = location.pathname;
    return p.startsWith('/storyboard') || p.startsWith('/drafts') || p.startsWith('/d/') || p.startsWith('/p/');
  };

  const isDrafts = () => location.pathname.startsWith('/drafts');

  function currentSIdFromURL() {
    const m = location.pathname.match(/^\/p\/(s_[A-Za-z0-9]+)/i);
    return m ? m[1] : null;
  }
  function currentProfileHandleFromURL() {
    const m = location.pathname.match(/^\/profile\/(?:username\/)?([^\/?#]+)/i);
    return m ? m[1] : null;
  }

  // == Data extraction ==
  const getUniqueViews = (item) => item?.post?.unique_view_count ?? null;
  const getLikes = (item) => {
    try {
      const p = item?.post ?? item;
      const cands = [p?.like_count, p?.likes_count, p?.likes, p?.stats?.like_count, p?.statistics?.like_count, p?.reactions?.like?.count];
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
      const cands = [p?.view_count, p?.views, p?.play_count, p?.impression_count, p?.stats?.view_count, p?.statistics?.view_count];
      for (const v of cands) {
        const n = Number(v);
        if (Number.isFinite(n)) return n;
      }
    } catch {}
    return null;
  };
  const getComments = (item) => {
    try {
      const p = item?.post ?? item;
      const cands = [
        p?.comment_count,
        p?.comments_count,
        p?.comments,
        p?.reply_count,
        p?.replies?.count,
        p?.stats?.comment_count,
        p?.statistics?.comment_count,
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
      const cands = [p?.remix_count, p?.stats?.remix_count, p?.statistics?.remix_count];
      for (const v of cands) {
        const n = Number(v);
        if (Number.isFinite(n)) return n;
      }
    } catch {}
    return null;
  };
  const getCameos = (item) => {
    try {
      const p = item?.post ?? item;
      const cands = [p?.cameo_count, p?.stats?.cameo_count, p?.statistics?.cameo_count];
      for (const v of cands) {
        const n = Number(v);
        if (Number.isFinite(n)) return n;
      }
      const arr = Array.isArray(p?.cameo_profiles) ? p.cameo_profiles : null;
      if (arr) return arr.length;
    } catch {}
    return null;
  };
  const getFollowerCount = (item) => {
    try {
      const p = item?.post ?? item;
      const cands = [
        item?.profile?.follower_count,
        item?.user?.follower_count,
        item?.author?.follower_count,
        p?.author?.follower_count,
        p?.owner?.follower_count,
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
      const prof =
        item?.profile || item?.owner_profile || item?.user || item?.author || p?.author || p?.owner || p?.profile || null;
      let id = p?.shared_by || prof?.user_id || prof?.id || prof?._id || null;
      let handle = prof?.username || prof?.handle || prof?.name || null;
      return { handle: typeof handle === 'string' && handle ? handle : null, id: typeof id === 'string' && id ? id : null };
    } catch {
      return { handle: null, id: null };
    }
  }
  const getThumbnail = (item) => {
    try {
      const p = item?.post ?? item;
      const id = getItemId(item);
      const atts = Array.isArray(p?.attachments) ? p.attachments : null;
      if (atts)
        for (const att of atts) {
          const t = att?.encodings?.thumbnail?.path;
          if (typeof t === 'string' && /^https?:\/\//.test(t)) {
            dlog('thumbs', 'picked', { id, source: 'att.encodings.thumbnail', url: t });
            return t;
          }
        }
      if (typeof p?.preview_image_url === 'string' && /^https?:\/\//.test(p.preview_image_url)) {
        dlog('thumbs', 'picked', { id, source: 'preview_image_url', url: p.preview_image_url });
        return p.preview_image_url;
      }
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
      for (const [label, u] of pairs)
        if (typeof u === 'string' && /^https?:\/\//.test(u)) {
          dlog('thumbs', 'picked', { id, source: label, url: u });
          return u;
        }
    } catch {}
    return null;
  };
  const getItemId = (item) => {
    const cand = item?.post?.id || item?.post?.core_id || item?.post?.content_id || item?.id;
    if (cand && /^s_[A-Za-z0-9]+$/i.test(cand)) return normalizeId(cand);
    const deep = findSIdDeep(item);
    return deep ? normalizeId(deep) : null;
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
  const selectAllCards = () =>
    Array.from(document.querySelectorAll('a[href^="/p/s_"]')).map((a) => a.closest('article,div,section') || a);

  // == Drafts helpers ==
  const extractDraftIdFromCard = (el) => {
    // Try to find a link with /d/ pattern
    const link = el.querySelector('a[href^="/d/"]');
    if (link) {
      const m = link.getAttribute('href').match(/\/d\/([A-Za-z0-9_-]+)/i);
      if (m) return normalizeId(m[1]);
    }
    // Try to find any data attribute that might contain draft ID
    const dataId = el.dataset?.draftId || el.dataset?.id;
    if (dataId) return normalizeId(dataId);
    // Try to find draft ID in any child element's data attributes
    const childWithId = el.querySelector('[data-draft-id], [data-id]');
    if (childWithId) {
      const id = childWithId.dataset?.draftId || childWithId.dataset?.id;
      if (id) return normalizeId(id);
    }
    return null;
  };
  const selectAllDrafts = () => {
    if (!isDrafts()) {
      cachedDraftCards = null;
      cachedDraftCardsCount = 0;
      processedDraftCardsCount = 0;
      return [];
    }

    // Try to find draft cards by looking for /d/ links
    const allLinks = document.querySelectorAll('a[href^="/d/"]');
    const currentCount = allLinks.length;

    // Return cached version if count hasn't changed
    if (cachedDraftCards && currentCount === cachedDraftCardsCount && currentCount > 0) {
      return cachedDraftCards;
    }

    // Cache miss - do the full query
    // Reset processed count since we're re-scanning (new cards may have appeared)
    processedDraftCardsCount = 0;

    const linksMethod = Array.from(allLinks).map((a) => a.closest('article,div,section') || a);
    if (linksMethod.length > 0) {
      cachedDraftCards = linksMethod;
      cachedDraftCardsCount = currentCount;
      return linksMethod;
    }

    // Fallback: look for common grid/list containers on drafts page
    const containers = document.querySelectorAll('[class*="grid"] > div, [class*="flex"] > div');
    const filtered = Array.from(containers).filter(el => {
      // Only include elements that contain media and have a valid draft ID
      const hasMedia = el.querySelector('video, img');
      const hasDraftId = extractDraftIdFromCard(el);
      return hasMedia && hasDraftId;
    });
    cachedDraftCards = filtered;
    cachedDraftCardsCount = filtered.length;
    return filtered;
  };

  // == Badge & UI (Feed) ==
  function colorForAgeMin(ageMin) {
    if (!Number.isFinite(ageMin)) return null;
    const hHours = ageMin / 60;
    if (hHours < 0 || hHours >= 18) return null;
    const idx = Math.floor(hHours);
    const t = idx / 17;
    const h = 0 + 50 * t;
    const l = 42 - 12 * t;
    return `hsla(${h.toFixed(1)}, 100%, ${l.toFixed(1)}%, 0.85)`;
  }
  function isNearWholeDay(ageMin, windowMin = 15) {
    if (!Number.isFinite(ageMin) || ageMin < 0) return false;
    const nearest = Math.round(ageMin / 1440) * 1440;
    const diff = Math.abs(ageMin - nearest);
    return nearest >= 1440 && diff <= windowMin;
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

  // Tooltip (1s delayed, cursor-follow)
  let sharedTooltip;
  function getTooltip() {
    if (sharedTooltip && document.contains(sharedTooltip)) return sharedTooltip;
    const t = document.createElement('div');
    t.className = 'sora-uv-tooltip';
    Object.assign(t.style, {
      position: 'fixed',
      padding: '6px 10px',
      fontSize: '12px',
      fontWeight: '600',
      lineHeight: '1',
      borderRadius: '9999px',
      background: 'rgba(37,37,37,0.7)',
      color: '#fff',
      zIndex: '2147483647',
      pointerEvents: 'none',
      transform: 'translate(-50%,-110%)',
      whiteSpace: 'nowrap',
      display: 'none',
      boxShadow: 'inset 0 0 1px rgba(0,0,0,0.10), inset 0 0 1px rgba(255,255,255,0.50), 0 2px 20px rgba(0,0,0,0.25)',
      backdropFilter: 'blur(6px)',
      WebkitBackdropFilter: 'blur(6px)',
    });
    document.documentElement.appendChild(t);
    sharedTooltip = t;
    return t;
  }


  let _promptTipTimer = null;
  async function copyTextToClipboard(text) {
    const t = String(text ?? '');
    try {
      await navigator.clipboard.writeText(t);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = t;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      ta.style.pointerEvents = 'none';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      try { document.execCommand('copy'); } catch {}
      document.body.removeChild(ta);
    }
  }
  function showPromptClickTooltip(clientX, clientY, text = 'Prompt copied!', ms = 1000) {
    const tip = getTooltip();
    tip.textContent = text;
    tip.style.left = `${clientX}px`;
    tip.style.top = `${clientY + 1}px`;
    tip.style.display = 'block';
    if (_promptTipTimer) clearTimeout(_promptTipTimer);
    _promptTipTimer = setTimeout(() => { tip.style.display = 'none'; }, ms);
  }


  function attachTooltip(el, text, enabled = true) {
    if (!enabled || !text) return;
    let timerId = null;
    let tracking = false;
    const DELAY_MS = 1000;
    const OFFSET_Y = 1;

    const move = (e) => {
      const tip = getTooltip();
      tip.textContent = text;
      tip.style.left = `${e.clientX}px`;
      tip.style.top = `${e.clientY + OFFSET_Y}px`;
    };

    el.addEventListener('mouseenter', (e) => {
      timerId = setTimeout(() => {
        const tip = getTooltip();
        tip.textContent = text;
        tip.style.display = 'block';
        move(e);
        if (!tracking) {
          tracking = true;
          el.addEventListener('mousemove', move);
        }
      }, DELAY_MS);
    });

    const hide = () => {
      if (timerId) clearTimeout(timerId);
      const tip = getTooltip();
      tip.style.display = 'none';
      if (tracking) {
        el.removeEventListener('mousemove', move);
        tracking = false;
      }
    };

    el.addEventListener('mouseleave', hide);

    const obs = new MutationObserver(() => {
      if (!document.contains(el)) {
        hide();
        obs.disconnect();
      }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
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
        display: 'flex',
        gap: '6px',
        flexWrap: 'wrap',
        padding: '4px',
        fontSize: '12px',
        lineHeight: '1',
        fontWeight: '600',
        borderRadius: '10px',
        background: 'rgba(0,0,0,0.4)',
        color: '#fff',
        zIndex: 9999,
        pointerEvents: 'auto',
      });
      card.appendChild(badge);
    }
    return badge;
  }

  function ensureBookmarkButton(draftCard, draftId) {
    if (!draftId) return null;

    let bookmarkBtn = draftCard.querySelector('.sora-uv-bookmark-btn');
    if (!bookmarkBtn) {
      if (getComputedStyle(draftCard).position === 'static') draftCard.style.position = 'relative';

      bookmarkBtn = document.createElement('button');
      bookmarkBtn.className = 'sora-uv-bookmark-btn';
      bookmarkBtn.type = 'button';
      bookmarkBtn.setAttribute('aria-label', 'Toggle bookmark');
      Object.assign(bookmarkBtn.style, {
        position: 'absolute',
        bottom: `${DRAFT_BUTTON_MARGIN}px`,
        left: `${DRAFT_BUTTON_MARGIN}px`,
        width: `${DRAFT_BUTTON_SIZE}px`,
        height: `${DRAFT_BUTTON_SIZE}px`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: '4px',
        background: 'rgba(0,0,0,0.75)',
        border: 'none',
        color: '#fff',
        fontSize: '14px',
        cursor: 'pointer',
        zIndex: 9998,
        transition: 'all 0.2s ease',
        backdropFilter: 'blur(4px)',
        WebkitBackdropFilter: 'blur(4px)',
      });

      bookmarkBtn.addEventListener('mouseenter', () => {
        bookmarkBtn.style.background = 'rgba(0,0,0,0.9)';
        bookmarkBtn.style.transform = 'scale(1.05)';
      });
      bookmarkBtn.addEventListener('mouseleave', () => {
        bookmarkBtn.style.background = 'rgba(0,0,0,0.75)';
        bookmarkBtn.style.transform = 'scale(1)';
      });

      bookmarkBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const nowBookmarked = toggleBookmark(draftId);
        updateBookmarkButtonState(bookmarkBtn, nowBookmarked);
        // Re-apply filter if active (force=true since bookmark changed)
        if (bookmarksFilterState !== 0) {
          applyBookmarksFilter(true);
        }
      });

      draftCard.appendChild(bookmarkBtn);
    }

    // Update button state based on current bookmark status
    updateBookmarkButtonState(bookmarkBtn, isBookmarked(draftId));
    return bookmarkBtn;
  }

  function updateBookmarkButtonState(btn, bookmarked) {
    // Create bookmark SVG icon (classic ribbon/flag shape)
    const svg = bookmarked
      ? `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style="pointer-events: none;">
           <path d="M17 3H7c-1.1 0-2 .9-2 2v16l7-3 7 3V5c0-1.1-.9-2-2-2z"/>
         </svg>`
      : `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="pointer-events: none;">
           <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>
         </svg>`;

    btn.innerHTML = svg;
    btn.style.color = bookmarked ? '#ffd700' : '#fff';
    btn.setAttribute('aria-pressed', bookmarked ? 'true' : 'false');
  }

  function ensureCopyPromptButton(draftCard, draftId) {
    if (!draftId) return null;

    let copyBtn = draftCard.querySelector('.sora-uv-copy-prompt-btn');
    if (!copyBtn) {
      if (getComputedStyle(draftCard).position === 'static') draftCard.style.position = 'relative';

      copyBtn = document.createElement('button');
      copyBtn.className = 'sora-uv-copy-prompt-btn';
      copyBtn.type = 'button';
      copyBtn.setAttribute('aria-label', 'Copy prompt');
      Object.assign(copyBtn.style, {
        position: 'absolute',
        bottom: `${DRAFT_BUTTON_MARGIN}px`,
        left: `${DRAFT_BUTTON_MARGIN + DRAFT_BUTTON_SIZE + DRAFT_BUTTON_SPACING}px`,
        width: `${DRAFT_BUTTON_SIZE}px`,
        height: `${DRAFT_BUTTON_SIZE}px`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: '4px',
        background: 'rgba(0,0,0,0.75)',
        border: 'none',
        color: '#fff',
        cursor: 'pointer',
        zIndex: 9998,
        transition: 'all 0.2s ease',
        backdropFilter: 'blur(4px)',
        WebkitBackdropFilter: 'blur(4px)',
      });

      // Copy icon SVG
      copyBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="pointer-events: none;">
        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
      </svg>`;

      copyBtn.addEventListener('mouseenter', () => {
        if (!copyBtn.disabled) {
          copyBtn.style.background = 'rgba(0,0,0,0.9)';
          copyBtn.style.transform = 'scale(1.05)';
        }
      });
      copyBtn.addEventListener('mouseleave', () => {
        copyBtn.style.background = 'rgba(0,0,0,0.75)';
        copyBtn.style.transform = 'scale(1)';
      });

      copyBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();

        const prompt = idToPrompt.get(draftId);
        if (!prompt) return;

        try {
          await navigator.clipboard.writeText(prompt);
          const originalHTML = copyBtn.innerHTML;
          // Show checkmark
          copyBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="pointer-events: none;">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>`;
          copyBtn.style.color = '#4ade80';
          setTimeout(() => {
            copyBtn.innerHTML = originalHTML;
            copyBtn.style.color = '#fff';
          }, 1500);
        } catch (err) {
          console.error('Failed to copy prompt:', err);
        }
      });

      draftCard.appendChild(copyBtn);
    }

    // Update button state based on whether prompt exists
    const hasPrompt = idToPrompt.has(draftId);
    copyBtn.disabled = !hasPrompt;
    copyBtn.style.opacity = hasPrompt ? '1' : '0.4';
    copyBtn.style.cursor = hasPrompt ? 'pointer' : 'not-allowed';

    return copyBtn;
  }

  function ensureDownloadButton(draftCard, draftId) {
    if (!draftId) return null;

    let downloadBtn = draftCard.querySelector('.sora-uv-download-btn');
    if (!downloadBtn) {
      if (getComputedStyle(draftCard).position === 'static') draftCard.style.position = 'relative';

      downloadBtn = document.createElement('button');
      downloadBtn.className = 'sora-uv-download-btn';
      downloadBtn.type = 'button';
      downloadBtn.setAttribute('aria-label', 'Download draft');
      Object.assign(downloadBtn.style, {
        position: 'absolute',
        bottom: `${DRAFT_BUTTON_MARGIN}px`,
        left: `${DRAFT_BUTTON_MARGIN + (DRAFT_BUTTON_SIZE + DRAFT_BUTTON_SPACING) * 2}px`,
        width: `${DRAFT_BUTTON_SIZE}px`,
        height: `${DRAFT_BUTTON_SIZE}px`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: '4px',
        background: 'rgba(0,0,0,0.75)',
        border: 'none',
        color: '#fff',
        cursor: 'pointer',
        zIndex: 9998,
        transition: 'all 0.2s ease',
        backdropFilter: 'blur(4px)',
        WebkitBackdropFilter: 'blur(4px)',
      });

      // Download icon SVG
      downloadBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="pointer-events: none;">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
        <polyline points="7 10 12 15 17 10"></polyline>
        <line x1="12" y1="15" x2="12" y2="3"></line>
      </svg>`;

      downloadBtn.addEventListener('mouseenter', () => {
        if (!downloadBtn.disabled) {
          downloadBtn.style.background = 'rgba(0,0,0,0.9)';
          downloadBtn.style.transform = 'scale(1.05)';
        }
      });
      downloadBtn.addEventListener('mouseleave', () => {
        downloadBtn.style.background = 'rgba(0,0,0,0.75)';
        downloadBtn.style.transform = 'scale(1)';
      });

      downloadBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();

        const downloadUrl = idToDownloadUrl.get(draftId);
        if (!downloadUrl) return;

        try {
          // Fetch the file and create a blob URL to force download
          const response = await fetch(downloadUrl);
          if (!response.ok) throw new Error('Download failed');

          const blob = await response.blob();
          const blobUrl = URL.createObjectURL(blob);

          // Determine file extension from URL or Content-Type
          let extension = '.mp4'; // Default for Sora videos
          try {
            // Try to extract from URL path
            const urlPath = new URL(downloadUrl).pathname;
            const urlExt = urlPath.match(/\.([a-z0-9]+)$/i)?.[1];
            if (urlExt && ALLOWED_VIDEO_EXTENSIONS.includes(urlExt.toLowerCase())) {
              extension = `.${urlExt}`;
            } else {
              // Try to get from Content-Type header
              const contentType = response.headers.get('content-type');
              if (contentType?.includes('video/mp4')) extension = '.mp4';
              else if (contentType?.includes('video/quicktime')) extension = '.mov';
              else if (contentType?.includes('video/webm')) extension = '.webm';
            }
          } catch {}

          // Create temporary anchor element to trigger download
          const a = document.createElement('a');
          a.href = blobUrl;
          a.download = `sora-draft-${draftId}${extension}`;
          a.style.display = 'none';
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);

          // Clean up the blob URL after download completes (longer delay for large video files)
          setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);
        } catch (err) {
          console.error('[SoraUV] Failed to download:', err);
          // Fallback to opening in new tab if fetch fails
          window.open(downloadUrl, '_blank');
        }
      });

      draftCard.appendChild(downloadBtn);
    }

    // Update button state based on whether download URL exists
    const hasDownloadUrl = idToDownloadUrl.has(draftId);
    downloadBtn.disabled = !hasDownloadUrl;
    downloadBtn.style.opacity = hasDownloadUrl ? '1' : '0.4';
    downloadBtn.style.cursor = hasDownloadUrl ? 'pointer' : 'not-allowed';

    return downloadBtn;
  }

  function createPill(parent, text, tooltipText, tooltipEnabled = true) {
    if (!text) return null;
    const pill = document.createElement('span');
    pill.className = 'sora-uv-pill';
    Object.assign(pill.style, {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '4px 8px',
      borderRadius: '9999px',
      background: 'rgba(37,37,37,0.7)',
      color: '#fff',
      fontSize: '13px',
      fontWeight: '700',
      lineHeight: '1.1',
      userSelect: 'none',
      whiteSpace: 'nowrap',
      backdropFilter: 'blur(8px)',
      WebkitBackdropFilter: 'blur(8px)',
      boxShadow:
        'inset 0 0 1px rgba(0,0,0,0.10), inset 0 0 1px rgba(255,255,255,0.50), 0 2px 20px rgba(0,0,0,0.25)',
    });
    pill.textContent = text;
    parent.appendChild(pill);
    attachTooltip(pill, tooltipText, tooltipEnabled);
    return pill;
  }

  function badgeBgFor(id, meta) {
    if (!meta) return null;
    const ageMin = meta.ageMin;
    const likes = idToLikes.get(id) ?? 0;
    if (likes >= 50 && Number.isFinite(ageMin) && ageMin < 60) return colorForAgeMin(0);
    if (isNearWholeDay(ageMin)) return greenEmblemColor();
    if (likes > 25) return colorForAgeMin(ageMin);
    return null;
  }
  function badgeEmojiFor(id, meta) {
    if (!meta) return '';
    const ageMin = meta.ageMin;
    const likes = idToLikes.get(id) ?? 0;
    if (likes >= 50 && Number.isFinite(ageMin) && ageMin < 60) return '🔥🔥🔥🔥🔥';
    if (isNearWholeDay(ageMin)) return '📝';
    if (likes > 25) return fireForAge(ageMin);
    return '';
  }

  function expireEtaTooltip(ageMin) {
    if (!Number.isFinite(ageMin)) return null;

    if (isNearWholeDay(ageMin, 15)) return null;

    const MIN_PER_H = 60;
    const MIN_PER_D = 1440;
    const a = Math.max(0, Math.floor(ageMin));

    if (a >= MIN_PER_D) {
      const d = Math.floor(a / MIN_PER_D);
      const h = Math.floor((a - d * MIN_PER_D) / MIN_PER_H);
      const m = a - d * MIN_PER_D - h * MIN_PER_H;
      return `This was posted ${d}d ${h}h ${m}m ago`;
    }

    // Under 24h → keep graduation countdown (includes minutes via fmtAgeMin)
    const remain = Math.max(0, MIN_PER_D - a);
    const human = fmtAgeMin(remain);
    return `This gen will graduate from Top in ~${human}!`;
  }


  function addBadge(card, views, meta) {
    if (views == null && !meta) return;
    const badge = ensureBadge(card);
    const id = extractIdFromCard(card);
    const likes = idToLikes.get(id) ?? 0;
    const ageMin = meta?.ageMin;
    const isSuperHot = likes >= 50 && Number.isFinite(ageMin) && ageMin < 60;

    const uv = idToUnique.get(id);
    const irRaw = interactionRate(idToLikes.get(id), idToComments.get(id), idToUnique.get(id)); // already like "12.3%"
    const rrRaw = remixRate(idToLikes.get(id), idToRemixes.get(id)); // "12.34" (no %)

    // Normalize IR/RR displays
    const irDisp = irRaw ? (parseFloat(irRaw) === 0 ? '0%' : irRaw) : null;
    const rrDisp =
      rrRaw == null ? null : +rrRaw === 0 ? '0%' : (rrRaw.endsWith('.00') ? rrRaw.slice(0, -3) : rrRaw) + '%';

    const viewsStr = uv != null ? `👀 ${fmt(uv)}` : null;
    const irStr = irDisp ? `${irDisp} IR` : null;
    const rrStr = rrDisp ? `${rrDisp} RR` : null;
    const ageStr = Number.isFinite(ageMin) ? fmtAgeMin(ageMin) : null;
    const emojiStr = badgeEmojiFor(id, meta);
    const timeEmojiStr = (ageStr || emojiStr) ? [ageStr || '', emojiStr || ''].filter(Boolean).join(' ') : null;

    const bg = badgeBgFor(id, meta);
    badge.style.background = 'transparent';
    const pillBg = bg || 'rgba(37,37,37,0.7)';

    const newKey = JSON.stringify([viewsStr, irStr, rrStr, timeEmojiStr, pillBg]);
    if (badge.dataset.key === newKey) {
      badge.style.boxShadow = 'none';
      return;
    }
    badge.dataset.key = newKey;

    badge.innerHTML = '';
    if (viewsStr) {
      const el = createPill(badge, viewsStr, `${fmtInt(uv)} Unique Views`, true);
      el.style.background = pillBg;
    }
    if (irStr) {
      const el = createPill(badge, irStr, 'Likes + Comments relative to Unique Views', true);
      el.style.background = pillBg;
    }
    if (rrStr) {
      const el = createPill(badge, rrStr, 'Total Remixes relative to Likes', true);
      el.style.background = pillBg;
    }
    if (timeEmojiStr) {
      const tip = Number.isFinite(ageMin) ? expireEtaTooltip(ageMin) : null;
      const nearDay = isNearWholeDay(ageMin);
      const tipFinal = tip || (nearDay ? 'This gen was posted at this time of day!' : null);
      const el = createPill(badge, timeEmojiStr, tipFinal, !!tipFinal);
      el.style.background = pillBg;
      if (isSuperHot) {
        el.style.boxShadow = '0 0 10px 3px hsla(0, 100%, 50%, 0.7)';
      }
    }
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

  function renderBookmarkButtons() {
    if (!isDrafts()) return;
    ensureControlBar();
    const draftCards = selectAllDrafts();

    // Early exit: if all cards are already processed, skip
    if (draftCards.length > 0 && draftCards.length === processedDraftCardsCount) {
      return;
    }

    let newCardsFound = 0;
    for (const draftCard of draftCards) {
      // Skip if we've already fully processed this card (all buttons added)
      if (processedDraftCards.has(draftCard)) continue;

      const draftId = extractDraftIdFromCard(draftCard);
      if (!draftId) continue;

      ensureBookmarkButton(draftCard, draftId);
      // Don't mark as processed yet - renderDraftButtons needs to add other buttons too
      newCardsFound++;
    }

    // Only apply filter if we found new cards (force=true since new cards need styling)
    if (newCardsFound > 0) {
      applyBookmarksFilter(true);
    }
  }

  function formatDuration(seconds) {
    if (!seconds || !Number.isFinite(seconds)) return null;
    const s = Math.round(seconds);
    if (s < 60) return `${s}s`;
    const mins = Math.floor(s / 60);
    const secs = s % 60;
    return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
  }

  function ensureDurationBadge(draftCard, draftId) {
    if (!draftId) return null;

    const duration = idToDuration.get(draftId);
    if (!duration) return null;

    let badge = draftCard.querySelector('.sora-uv-duration-badge');
    if (!badge) {
      if (getComputedStyle(draftCard).position === 'static') draftCard.style.position = 'relative';

      badge = document.createElement('div');
      badge.className = 'sora-uv-duration-badge';
      Object.assign(badge.style, {
        position: 'absolute',
        bottom: `${DRAFT_BUTTON_MARGIN}px`,
        right: `${DRAFT_BUTTON_MARGIN}px`,
        padding: '4px 8px',
        borderRadius: '4px',
        background: 'rgba(0,0,0,0.75)',
        color: '#fff',
        fontSize: '12px',
        fontWeight: '600',
        lineHeight: '1',
        zIndex: 9999,
        backdropFilter: 'blur(4px)',
        WebkitBackdropFilter: 'blur(4px)',
        pointerEvents: 'none',
      });

      draftCard.appendChild(badge);
    }

    const formatted = formatDuration(duration);
    if (formatted) {
      badge.textContent = formatted;
      badge.style.display = '';
    } else {
      badge.style.display = 'none';
    }

    return badge;
  }

  function renderDraftButtons() {
    if (!isDrafts()) return;

    const draftCards = selectAllDrafts();

    // Early exit: if all cards are already processed, skip
    if (draftCards.length > 0 && draftCards.length === processedDraftCardsCount) {
      return;
    }

    for (const draftCard of draftCards) {
      // Skip if we've already processed this card
      if (processedDraftCards.has(draftCard)) continue;

      const draftId = extractDraftIdFromCard(draftCard);
      if (!draftId) continue;

      ensureDurationBadge(draftCard, draftId);
      ensureCopyPromptButton(draftCard, draftId);
      ensureDownloadButton(draftCard, draftId);
      processedDraftCards.add(draftCard);
      processedDraftCardsCount++; // Increment count for early exit optimization
    }
  }

  // == Detail badge (post page only) ==
  
  // This function targets the visible video container
  function findDetailBadgeTarget() {
    if (!isPost()) return null;

    // 1. Find the wrapper div for the *visible* video player (the one at top: 0px and opacity: 1)
    const visibleVideoWrapper = document.querySelector('.relative.h-full.w-full.origin-top > .absolute.overflow-hidden.rounded-xl.cursor-default[style*="top: 0px"][style*="opacity: 1"]');
    
    if (!visibleVideoWrapper) return null;
    
    // 2. The inner container which we want to attach the badge to is the .group.relative.h-full.w-full
    const videoGroup = visibleVideoWrapper.querySelector('.group.relative.h-full.w-full');
    
    if (videoGroup) {
      if (getComputedStyle(videoGroup).position === 'static') {
        videoGroup.style.position = 'relative';
      }
      
      // Find or create the data container inside the video group
      let detailDataEl = videoGroup.querySelector('.sora-uv-badge-detail-container');
      if (!detailDataEl) {
        detailDataEl = document.createElement('div');
        detailDataEl.className = 'sora-uv-badge-detail-container';
        // This container is the wrapper for the pills, positioned at the top left.
        Object.assign(detailDataEl.style, {
          position: 'absolute',
          top: '6px',
          left: '6px',
          display: 'flex',
          gap: '6px',
          flexWrap: 'wrap',
          zIndex: 9999, // Ensure it sits above the video/image
          pointerEvents: 'none', // Initially set to none, but individual pills will be 'auto'
          padding: '4px', // Add some internal padding
        });
        videoGroup.appendChild(detailDataEl);
      }
      return detailDataEl;
    }

    return null;
  }

  function ensureDetailBadgeContainer() {
    if (detailBadgeEl && document.contains(detailBadgeEl)) return detailBadgeEl;
    
    const targetEl = findDetailBadgeTarget();

    if (targetEl) {
      detailBadgeEl = targetEl;
      return detailBadgeEl;
    }
    
    if (detailBadgeEl) {
      detailBadgeEl.remove(); 
      detailBadgeEl = null;
    }
    return null;
  }


  function renderDetailBadge() {
    const el = ensureDetailBadgeContainer();
    
    if (!isPost() || !el) {
      if (el) el.innerHTML = ''; 
      if (detailBadgeEl) {
        detailBadgeEl.remove();
        detailBadgeEl = null;
      }
      return;
    }

    const sid = currentSIdFromURL();
    if (!sid) {
      el.innerHTML = '';
      return;
    }

    const uv = idToUnique.get(sid);
    const likes = idToLikes.get(sid);
    const totalViews = idToViews.get(sid);
    const comments = idToComments.get(sid);
    const remixes = idToRemixes.get(sid);

    const irRaw = interactionRate(likes, comments, uv);
    const rrRaw = remixRate(likes, remixes);
    const irDisp = irRaw ? (parseFloat(irRaw) === 0 ? '0%' : irRaw) : null;
    const rrDisp = rrRaw == null ? null : +rrRaw === 0 ? '0%' : (rrRaw.endsWith('.00') ? rrRaw.slice(0, -3) : rrRaw) + '%';

    const meta = idToMeta.get(sid);
    const ageMin = meta?.ageMin;
    const isSuperHot = (likes ?? 0) >= 50 && Number.isFinite(ageMin) && ageMin < 60;

    const viewsStr = uv != null ? `👀 ${fmt(uv)} views` : null;
    const irStr = irDisp ? `${irDisp} IR` : null;
    const rrStr = rrDisp ? `${rrDisp} RR` : null;
    
    const timeStr = Number.isFinite(ageMin) ? fmtAgeMin(ageMin) : null;
    const emoji = badgeEmojiFor(sid, meta);

    // Determine if we have any data to display
    if (viewsStr == null && irStr == null && rrStr == null && timeStr == null && emoji == '') {
      el.innerHTML = '';
      return;
    }

    // Use a key to prevent unnecessary DOM updates
    const newKey = JSON.stringify([viewsStr, irStr, rrStr, timeStr, emoji]);
    if (el.dataset.key === newKey) return;
    el.dataset.key = newKey;
    
    el.innerHTML = '';

    const pillBg = 'rgba(37,37,37,0.7)'; 
    
    // 1. Views Pill
    if (viewsStr) {
      const metEl = createPill(el, viewsStr, `${fmtInt(uv)} Unique Views`, true);
      metEl.style.background = pillBg;
      metEl.style.pointerEvents = 'auto';
    }
    
    // 2. IR Pill
    if (irStr) {
      const metEl = createPill(el, irStr, 'Likes + Comments relative to Unique Views', true);
      metEl.style.background = pillBg;
      metEl.style.pointerEvents = 'auto';
    }
    
    // 3. RR Pill
    if (rrStr) {
      const metEl = createPill(el, rrStr, 'Total Remixes relative to Likes', true);
      metEl.style.background = pillBg;
      metEl.style.pointerEvents = 'auto';
    }
    
    // 4. Time/Age Pill
    if (timeStr || emoji) {
      const timeEmojiStr = [timeStr || '', emoji || ''].filter(Boolean).join(' ');
      const tip = Number.isFinite(ageMin) ? expireEtaTooltip(ageMin) : null;
      const nearDay = isNearWholeDay(ageMin);
      const tipFinal = tip || (nearDay ? 'This gen was posted at this time of day!' : null);
      
      const timeEl = createPill(el, timeEmojiStr, tipFinal, !!tipFinal);
      const bg = badgeBgFor(sid, meta);
      timeEl.style.background = bg || pillBg;
      timeEl.style.pointerEvents = 'auto';

      if (isSuperHot) {
        timeEl.style.boxShadow = '0 0 10px 3px hsla(0, 100%, 50%, 0.7)';
      }
    }

    // Keep container pointerEvents: none to allow clicks to pass through to video controls, 
    // but since the pills themselves are explicitly set to 'auto', they will still receive cursor events.
    el.style.pointerEvents = 'none'; 
  }

  // == Profile Impact (unchanged) ==
  function parseMetricNumber(text) {
    if (typeof text !== 'string') return null;
    let t = text.trim().toUpperCase();
    if (!t) return null;
    let mult = 1;
    if (t.endsWith('K')) {
      mult = 1e3;
      t = t.slice(0, -1);
    } else if (t.endsWith('M')) {
      mult = 1e6;
      t = t.slice(0, -1);
    } else if (t.endsWith('B')) {
      mult = 1e9;
      t = t.slice(0, -1);
    }
    t = t.replace(/[\s,]/g, '');
    const n = Number(t);
    return Number.isFinite(n) ? n * mult : null;
  }
  function formatImpactRatio(likes, followers) {
    const l = Number(likes),
      f = Number(followers);
    if (!Number.isFinite(l) || !Number.isFinite(f) || f <= 0) return null;
    const ratio = l / f;
    const rounded = Math.ceil(ratio * 10) / 10;
    return `${rounded.toFixed(1)}x`;
  }
  function removeProfileImpact() {
    const existing = document.querySelector('[data-sora-uv-impact]');
    if (existing && existing.parentElement) existing.parentElement.removeChild(existing);
  }
  function renderProfileImpact() {
    if (!isProfile()) {
      removeProfileImpact();
      return;
    }
    const metricsRow = document.querySelector('section div.grid.auto-cols-fr.grid-flow-col');
    if (!metricsRow) return;

    const metricLabels = Array.from(metricsRow.querySelectorAll('.text-xs'));
    const followersLabel = metricLabels.find((el) => el.textContent?.trim().toLowerCase() === 'followers');
    const likesLabel = metricLabels.find((el) => el.textContent?.trim().toLowerCase() === 'likes');

    const followersValueEl = followersLabel?.previousElementSibling;
    const likesValueEl = likesLabel?.previousElementSibling;

    const followers = parseMetricNumber(followersValueEl?.textContent || '');
    const likes = parseMetricNumber(likesValueEl?.textContent || '');

    let impactText = null;
    try {
      const u = new URL(location.href);
      const handle = currentProfileHandleFromURL();
      if (u.origin === 'https://sora.chatgpt.com' && handle && handle.toLowerCase() === 'sora') impactText = '∞';
      if (u.origin === 'https://sora.chatgpt.com' && handle && handle.toLowerCase() === 'sama') impactText = '∞';
    } catch {}
    if (!impactText) impactText = formatImpactRatio(likes, followers);

    const existing = metricsRow.querySelector('[data-sora-uv-impact]');
    if (!impactText) {
      if (existing) existing.remove();
      return;
    }

    if (existing) {
      const valueEl = existing.querySelector('[data-sora-uv-impact-value]');
      if (valueEl) valueEl.textContent = impactText;
      return;
    }

    const cell = document.createElement('div');
    cell.setAttribute('data-sora-uv-impact', 'true');

    const valueDiv = document.createElement('div');
    valueDiv.className = 'text-2xl font-semibold';
    valueDiv.setAttribute('data-sora-uv-impact-value', 'true');
    valueDiv.textContent = impactText;

    const labelDiv = document.createElement('div');
    labelDiv.className = 'text-xs';
    labelDiv.textContent = 'impact';

    cell.appendChild(valueDiv);
    cell.appendChild(labelDiv);

    const likesContainer = likesLabel?.parentElement;
    if (likesContainer && likesContainer.nextSibling) {
      metricsRow.insertBefore(cell, likesContainer.nextSibling);
    } else {
      metricsRow.appendChild(cell);
    }
  }

  function makePill(btn, label) {
    // inject shared CSS once
    if (!document.getElementById('sora-uv-btn-style')) {
      const st = document.createElement('style');
      st.id = 'sora-uv-btn-style';
      st.textContent = `
        .sora-uv-btn{
          display:inline-flex;align-items:center;justify-content:center;height:40px;
          border-radius:9999px;padding:10px 16px;border:1px solid rgba(255,255,255,0.15);
          font-size:16px;font-weight:600;line-height:1;white-space:nowrap;cursor:pointer;user-select:none;
          background:rgba(37,37,37,0.6);color:#fff;
          box-shadow:inset 0 0 1px rgba(255,255,255,0.06),0 1px 10px rgba(0,0,0,0.30);
          backdrop-filter:blur(22px) saturate(2);-webkit-backdrop-filter:blur(22px) saturate(2);
          transition:background 120ms ease,border-color 120ms ease,box-shadow 120ms ease,opacity 120ms ease;
        }
        .sora-uv-btn:hover{ background:rgba(37,37,37,0.75) }
        .sora-uv-btn[disabled]{ opacity:.5; cursor:not-allowed }
        .sora-uv-btn[data-active="true"]{
          background:hsla(120,60%,30%,.90);
          border:1px solid hsla(120,60%,40%,.90);
          box-shadow:0 0 10px 3px hsla(120,60%,35%,.45);
        }
        .sora-uv-btn[data-active="true"]:hover{
          background:hsla(120,60%,32%,.95);
        }
      `;
      document.head.appendChild(st);
    }

    // reset + label
    while (btn.firstChild) btn.removeChild(btn.firstChild);
    const span = document.createElement('span');
    span.textContent = label;
    btn.appendChild(span);

    // base attrs
    btn.type = 'button';
    btn.setAttribute('role', 'combobox');
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-autocomplete', 'none');
    btn.dataset.state = 'closed';

    // apply class; CSS handles normal/hover/active
    btn.classList.add('sora-uv-btn');

    // helpers
    btn._labelSpan = span;
    btn.setLabel = (t) => {
      btn._labelSpan.textContent = t;
    };
    btn.setActive = (on) => {
      btn.dataset.active = on ? 'true' : 'false';
    };

    return btn;
  }

  function ensureControlBar() {
    // Make sure the shared .sora-uv-btn styles exist even if we early-return
    if (!document.getElementById('sora-uv-btn-style')) {
      // leverage makePill's injector by creating a throwaway button once
      makePill(document.createElement('button'), '');
    }

    if (controlBar && document.contains(controlBar)) return controlBar;

    const bar = document.createElement('div');
    bar.className = 'sora-uv-controls';
    Object.assign(bar.style, {
      position: 'fixed',
      top: '12px',
      right: '12px',
      zIndex: 2147483647,
      display: 'flex',
      gap: '8px',
      padding: '0',
      borderRadius: '0',
      background: 'transparent',
      color: '#fff',
      fontSize: '12px',
      alignItems: 'center',
      userSelect: 'none',
      flexDirection: 'column',
    });

    const buttonRow = document.createElement('div');
    Object.assign(buttonRow.style, { display: 'flex', gap: '8px', background: 'transparent' });

    // prefs
    let prefs = getPrefs();
    if (typeof prefs.gatherSpeed !== 'string') {
      prefs.gatherSpeed = '0';
      setPrefs(prefs);
    }

    // ---- PRESERVE SESSION ACROSS REFRESH ----
    // Only initialize a new session if no session exists; do NOT clobber an existing one.
    const existingSess = getGatherState();
    if (!existingSess || typeof existingSess !== 'object' || Object.keys(existingSess).length === 0) {
      setGatherState({ filterIndex: 0, isGathering: false });
    }
    // Reflect persisted state into this-tab flag without starting loops here.
    // init() will call updateGatherState()/startGathering() as needed.
    isGatheringActiveThisTab = !!(existingSess && existingSess.isGathering);

    // --- Helper to disable with visual cues + block hover/click ---
    function setDisabled(btn, on) {
      if (!btn) return;
      btn.disabled = !!on;
      btn.style.opacity = on ? '0.5' : '1';
      btn.style.cursor = on ? 'not-allowed' : 'pointer';
      btn.style.pointerEvents = on ? 'none' : 'auto';
    }

    // Filter
    const filterContainer = document.createElement('div');
    filterContainer.className = 'sora-uv-filter-container';
    filterContainer.style.position = 'relative';

    const filterBtn = document.createElement('button');
    filterBtn.setAttribute('data-role', 'filter-btn');
    makePill(filterBtn, 'Filter');
    filterContainer.appendChild(filterBtn);
    

    // Filter dropdown menu
    const filterDropdown = document.createElement('div');
    filterDropdown.className = 'sora-uv-filter-dropdown';
    Object.assign(filterDropdown.style, {
      position: 'absolute',
      top: 'calc(100% + 4px)',
      right: '0',
      display: 'none',
      flexDirection: 'column',
      gap: '0',
      padding: '8px',
      background: 'rgba(37, 37, 37, 0.6)', // Sora's dark mode transparency
      border: '1px solid rgba(255, 255, 255, 0.15)', // Subtle glass border
      borderRadius: '20px',
      boxShadow: '0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05)',
      backdropFilter: 'blur(22px) saturate(2)', // The key glassmorphism effect
      WebkitBackdropFilter: 'blur(22px) saturate(2)',
      zIndex: 999999,
      minWidth: '220px',
    });
    
    // Filter dropdown items
    FILTER_LABELS.forEach((label, index) => {
      const option = document.createElement('button');
      option.textContent = label;
      option.className = 'sora-uv-filter-option';
      Object.assign(option.style, {
        padding: '8px 12px',
        background: 'transparent',
        border: 'none',
        color: 'var(--token-text-primary, #fff)',
        textAlign: 'left',
        cursor: 'pointer',
        borderRadius: '8px',
        fontSize: '14px',
        fontWeight: '500',
        transition: 'background 120ms ease',
      });

      option.onmouseenter = () => { option.style.background = 'var(--token-bg-light, rgba(255, 255, 255, 0.1))'; };
      option.onmouseleave = () => { option.style.background = 'transparent'; };

      option.onclick = (e) => {
        e.stopPropagation();
        const s = getGatherState();
        s.filterIndex = index;
        setGatherState(s);
        bar.updateFilterLabel();
        applyFilter();
        filterDropdown.style.display = 'none';
      };
  
      filterDropdown.appendChild(option);
    });

    filterContainer.appendChild(filterDropdown);
    buttonRow.appendChild(filterContainer);

    // Gather
    const gatherBtn = document.createElement('button');
    gatherBtn.className = 'sora-uv-gather-btn';
    gatherBtn.dataset.gathering = 'false';
    makePill(gatherBtn, 'Gather');
    buttonRow.appendChild(gatherBtn);

    // Analyze (Top only; visibility handled later)
    analyzeBtn = document.createElement('button');
    analyzeBtn.className = 'sora-uv-analyze-btn';
    makePill(analyzeBtn, 'Analyze');
    analyzeBtn.style.display = 'none';
    buttonRow.appendChild(analyzeBtn);

    // Bookmarks (Drafts only; visibility handled later)
    bookmarksBtn = document.createElement('button');
    bookmarksBtn.className = 'sora-uv-bookmarks-btn';
    bookmarksBtn.dataset.active = 'false';
    makePill(bookmarksBtn, 'Filter');
    bookmarksBtn.style.display = 'none';
    buttonRow.appendChild(bookmarksBtn);

    bar.appendChild(buttonRow);

    // Gather controls
    const gatherControlsWrapper = document.createElement('div');
    gatherControlsWrapper.className = 'sora-uv-gather-controls-wrapper';
    Object.assign(gatherControlsWrapper.style, {
      display: 'none',
      flexDirection: 'column',
      width: '100%',
      gap: '6px',
      alignItems: 'center',
      background: 'transparent',
    });

    const sliderContainer = document.createElement('div');
    sliderContainer.className = 'sora-uv-slider-container';
    Object.assign(sliderContainer.style, {
      display: 'flex',
      width: '100%',
      alignItems: 'center',
      gap: '5px',
      background: 'transparent',
    });

    const emojiTurtle = document.createElement('span');
    emojiTurtle.textContent = '🐢';
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '100';
    slider.step = '1';
    slider.value = getPrefs().gatherSpeed;
    slider.style.flexGrow = '1';
    const emojiRabbit = document.createElement('span');
    emojiRabbit.textContent = '🐇';

    sliderContainer.appendChild(emojiTurtle);
    sliderContainer.appendChild(slider);
    sliderContainer.appendChild(emojiRabbit);
    gatherControlsWrapper.appendChild(sliderContainer);

    const refreshTimerDisplay = document.createElement('div');
    refreshTimerDisplay.className = 'sora-uv-refresh-timer';
    Object.assign(refreshTimerDisplay.style, {
      width: '100%',
      textAlign: 'center',
      fontSize: '11px',
      color: 'rgba(255, 255, 255, 0.7)',
      lineHeight: '1',
      background: 'transparent',
    });
    gatherControlsWrapper.appendChild(refreshTimerDisplay);
    gatherTimerEl = refreshTimerDisplay;

    bar.appendChild(gatherControlsWrapper);

    const onSliderChange = () => {
      let p = getPrefs();
      p.gatherSpeed = slider.value;
      setPrefs(p);
      if (isGatheringActiveThisTab) startGathering(true);
    };
    slider.addEventListener('input', onSliderChange);

    // ----- Filter lock logic -----
    function applyFilterLockState() {
      // Don't touch buttons while Gather is on
      if (isGatheringActiveThisTab) return;

      const s = getGatherState();
      const idx = s.filterIndex ?? 0;
      const filterActive = idx > 0;

      // Filter button "active" green when any filter is applied
      if (typeof filterBtn.setActive === 'function') filterBtn.setActive(filterActive);

      // Lock Gather & Analyze when filter is on
      setDisabled(gatherBtn, filterActive);
      setDisabled(analyzeBtn, filterActive);
    }

    // Label + lock in one place so we can call from multiple flows
    bar.updateFilterLabel = () => {
      const s = getGatherState();
      const idx = s.filterIndex ?? 0;
      filterBtn.setLabel(idx === 0 ? 'Filter' : FILTER_LABELS[idx]);

      // Only apply filter-lock when NOT gathering; otherwise we’d re-enable Analyze mid-gather
      if (!isGatheringActiveThisTab) applyFilterLockState();
    };

    // Wire Filter button
    filterBtn.onclick = (e) => {
      if (filterBtn.disabled) return;
      e.stopPropagation();
      const isOpen = filterDropdown.style.display === 'flex';
      filterDropdown.style.display = isOpen ? 'none' : 'flex';
    };

    // Close dropdown when clicking outside
    document.addEventListener('click', () => {
      filterDropdown.style.display = 'none';
    });

    // Guard clicks on disabled buttons
    gatherBtn.onclick = () => {
      if (gatherBtn.disabled) return;
      isGatheringActiveThisTab = !isGatheringActiveThisTab;
      const s = getGatherState();
      s.isGathering = isGatheringActiveThisTab;
      if (!isGatheringActiveThisTab) {
        delete s.refreshDeadline;
      } else {
        s.filterIndex = 0; // clear filter when starting Gather (optional)
      }
      setGatherState(s);
      bar.updateGatherState();
      if (isGatheringActiveThisTab) {
        bar.updateFilterLabel();
        applyFilter();
      }
    };

    analyzeBtn.onclick = () => {
      if (analyzeBtn.disabled) return;
      toggleAnalyzeMode();
    };

    bookmarksBtn.onclick = () => {
      if (bookmarksBtn.disabled) return;
      // Cycle through states: 0 (all) -> 1 (bookmarked) -> 2 (unbookmarked) -> 3 (violations) -> 0
      bookmarksFilterState = (bookmarksFilterState + 1) % 4;

      const labels = ['Filter', 'Bookmarks', 'Unbookmarked', 'Violations'];
      bookmarksBtn.setActive(bookmarksFilterState !== 0);
      bookmarksBtn.setLabel(labels[bookmarksFilterState]);
      applyBookmarksFilter(true); // Force since filter state changed
    };

    bar.updateGatherState = () => {
      const filterLockActive = (getGatherState().filterIndex ?? 0) > 0;

      if (isGatheringActiveThisTab) {
        // Gather ON
        gatherBtn.setLabel('Gathering...');
        gatherBtn.dataset.gathering = 'true';
        gatherBtn.setActive(true);

        // Hide & hard-disable Analyze while gathering
        if (analyzeBtn) {
          analyzeBtn.style.display = 'none';
          setDisabled(analyzeBtn, true);
        }

        // Disable Filter during gather
        setDisabled(filterBtn, true);

        if (isProfile()) {
          gatherControlsWrapper.style.display = 'flex';
          sliderContainer.style.display = 'flex';
        } else if (isTopFeed()) {
          gatherControlsWrapper.style.display = 'flex';
          sliderContainer.style.display = 'none';
        }

        startGathering(false);
        if (!gatherCountdownIntervalId) gatherCountdownIntervalId = setInterval(updateCountdownDisplay, 1000);
      } else {
        // Gather OFF
        gatherBtn.setLabel('Gather');
        gatherBtn.dataset.gathering = 'false';
        gatherBtn.setActive(false);

        // Re-enable Filter, then apply Filter-lock (may disable Gather/Analyze if a filter is set)
        setDisabled(filterBtn, false);
        gatherControlsWrapper.style.display = 'none';
        stopGathering(false);

        // Restore Analyze visibility (Top feed only); then apply lock
        if (analyzeBtn) {
          analyzeBtn.style.display = isTopFeed() ? '' : 'none';
          setDisabled(analyzeBtn, filterLockActive);
        }

        setDisabled(gatherBtn, filterLockActive);
        if (typeof filterBtn.setActive === 'function') filterBtn.setActive(filterLockActive);
      }

      // Update label text; applyFilterLockState will no-op while gathering
      if (typeof bar.updateFilterLabel === 'function') bar.updateFilterLabel();
    };

    // Initial label + lock application
    bar.updateFilterLabel();

    document.documentElement.appendChild(bar);
    controlBar = bar;
    return bar;
  }



  function startAnalyzeAutoRefresh() {
    if (analyzeAutoRefreshId) clearInterval(analyzeAutoRefreshId);

    const TICK_MS = 30_000; // every 30s (your setting)

    const tick = () => {
      if (!analyzeActive) return;
      if (document.hidden) return; // SAFEGUARD: no work when tab not visible
      requestAnimationFrame(() => renderAnalyzeTable(true));
    };

    analyzeAutoRefreshId = setInterval(tick, TICK_MS);

    // Run once immediately if we're visible
    if (!document.hidden) tick();

    // Refresh immediately when the tab gains focus or becomes visible
    const onFocus = () => {
      if (!analyzeActive) return;
      if (!document.hidden) requestAnimationFrame(() => renderAnalyzeTable(true));
    };
    const onVis = () => {
      if (!analyzeActive) return;
      if (!document.hidden) requestAnimationFrame(() => renderAnalyzeTable(true));
    };

    // Store listeners so we can remove them on stop
    startAnalyzeAutoRefresh._onFocus = onFocus;
    startAnalyzeAutoRefresh._onVis = onVis;

    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVis);
  }

  function stopAnalyzeAutoRefresh() {
    if (analyzeAutoRefreshId) {
      clearInterval(analyzeAutoRefreshId);
      analyzeAutoRefreshId = null;
    }
    if (startAnalyzeAutoRefresh._onFocus) {
      window.removeEventListener('focus', startAnalyzeAutoRefresh._onFocus);
      startAnalyzeAutoRefresh._onFocus = null;
    }
    if (startAnalyzeAutoRefresh._onVis) {
      document.removeEventListener('visibilitychange', startAnalyzeAutoRefresh._onVis);
      startAnalyzeAutoRefresh._onVis = null;
    }
  }


  // ========================== ANALYZE VISITED LINK STORAGE ================================
  
  function getAnalyzeVisited(purgeOld = true) {
    let list = [];
    try {
      list = JSON.parse(localStorage.getItem(ANALYZE_VISITED_KEY) || '[]');
      if (!Array.isArray(list)) list = [];
    } catch {
      list = [];
    }
    
    // Convert list to a Map for easy ID lookup, while cleaning old data
    const now = Date.now();
    const map = new Map();
    let needsSave = false;
    
    for (const item of list) {
      if (typeof item?.id === 'string' && typeof item?.t === 'number') {
        if (purgeOld && now - item.t > ANALYZE_VISITED_MAX_AGE_MS) {
          needsSave = true; // Mark old data for removal
        } else {
          map.set(item.id, item.t); // Keep it
        }
      } else {
        needsSave = true; // Clean up corrupted entries
      }
    }
    
    // If we purged anything, save the clean list back to storage
    if (needsSave && purgeOld) {
      // Rebuild the clean list from the Map values
      const cleanList = Array.from(map.entries()).map(([id, t]) => ({ id, t }));
      try {
        localStorage.setItem(ANALYZE_VISITED_KEY, JSON.stringify(cleanList));
      } catch (e) {
        dlog('analyze', 'Error saving cleaned visited state', e);
      }
    }

    // Return a Set of just the IDs for quick checking in renderAnalyzeTable
    return new Set(map.keys());
  }

  function addAnalyzeVisited(postId) {
    if (!postId) return;
    
    // Get the full list from storage (don't purge yet, just retrieve for update)
    let list = [];
    try {
      list = JSON.parse(localStorage.getItem(ANALYZE_VISITED_KEY) || '[]');
      if (!Array.isArray(list)) list = [];
    } catch {
      list = [];
    }
    
    const now = Date.now();
    let updated = false;
    
    // Check if the post ID already exists; if so, update its timestamp
    for (let i = 0; i < list.length; i++) {
      if (list[i]?.id === postId) {
        list[i].t = now;
        updated = true;
        break;
      }
    }
    
    // If not found, add a new entry
    if (!updated) {
      list.push({ id: postId, t: now });
    }
    
    // Save the updated list. 
    try {
      localStorage.setItem(ANALYZE_VISITED_KEY, JSON.stringify(list));
    } catch (e) {
      dlog('analyze', 'Error saving visited state', e);
    }
    
    // Explicitly call to purge old entries after adding a new one.
    getAnalyzeVisited(true);  
  }
  
  function __sorauv_toTs(v) {
    if (typeof v === 'number' && isFinite(v)) return v < 1e11 ? v * 1000 : v;
    if (typeof v === 'string' && v.trim()) {
      const s = v.trim();
      if (/^\d+$/.test(s)) {
        const n = Number(s);
        return n < 1e11 ? n * 1000 : n;
      }
      const d = Date.parse(s);
      if (!isNaN(d)) return d;
    }
    return 0;
  }
  function __sorauv_getPostTimeStrict(p) {
    const cands = [p?.post_time, p?.postTime, p?.post?.post_time, p?.post?.postTime, p?.meta?.post_time];
    for (const c of cands) {
      const t = __sorauv_toTs(c);
      if (t) return t;
    }
    return 0;
  }
  function __sorauv_latestSnapshot(snaps) {
    if (!Array.isArray(snaps) || snaps.length === 0) return null;
    const last = snaps[snaps.length - 1];
    if (last?.t != null) return last;
    let best = null,
      bt = -Infinity;
    for (const s of snaps) {
      const t = Number(s?.t);
      if (isFinite(t) && t > bt) {
        bt = t;
        best = s;
      }
    }
    return best || last || null;
  }

  let _metricsInFlight = null,
    _metricsCache = null,
    _metricsTs = 0;

  async function requestStoredMetrics() {
    const now = Date.now();
    if (_metricsInFlight) return _metricsInFlight;
    if (_metricsCache && now - _metricsTs < 1000) return _metricsCache; // 1s cache

    _metricsInFlight = new Promise((resolve) => {
      const token = Math.random().toString(36).slice(2);
      const onReply = (ev) => {
        const d = ev?.data;
        if (!d || d.__sora_uv__ !== true || d.type !== 'metrics_response' || d.req !== token) return;
        window.removeEventListener('message', onReply);
        _metricsInFlight = null;
        _metricsCache = d.metrics || { users: {} };
        _metricsTs = Date.now();
        resolve(_metricsCache);
      };
      window.addEventListener('message', onReply);
      window.postMessage({ __sora_uv__: true, type: 'metrics_request', req: token }, '*');
      setTimeout(() => {
        // timeout safety
        window.removeEventListener('message', onReply);
        _metricsInFlight = null;
        resolve(_metricsCache || { users: {} });
      }, 2000);
    });
    return _metricsInFlight;
  }

  async function collectAnalyzeRowsFromStorage() {
    const metrics = await requestStoredMetrics();
    const rows = [];
    const NOW = Date.now();
    const DAY_MS = 24 * 60 * 60 * 1000;

    for (const [, user] of Object.entries(metrics?.users || {})) {
      for (const [pid, p] of Object.entries(user?.posts || {})) {
        const tPost = __sorauv_getPostTimeStrict(p);
        if (!tPost || NOW - tPost > DAY_MS) continue;

        const snap = __sorauv_latestSnapshot(p?.snapshots);
        if (!snap) continue;
        const likes = Number(snap.likes);
        if (!isFinite(likes) || likes < 20) continue;

        const uv = Number(snap.uv);
        const comments = Number(snap.comments);
        const remixes = Number(snap.remix_count ?? snap.remixes);

        const rrVal =
          isFinite(likes) && likes > 0 && isFinite(remixes) && remixes >= 0 ? (remixes / likes) * 100 : null;
        const irVal = isFinite(uv) && uv > 0 ? (((Number(likes) || 0) + (Number(comments) || 0)) / uv) * 100 : null;

        const ageMin = Math.max(0, Math.floor((NOW - tPost) / 60000));
        const expiringMin = Math.max(0, 1440 - ageMin);

        const caption =
          typeof p?.caption === 'string' && p.caption ? p.caption : typeof p?.text === 'string' && p.text ? p.text : '';

        // pull owner handle if present in user or post node
        const ownerHandle =
          typeof user?.userHandle === 'string' && user.userHandle
            ? user.userHandle
            : typeof user?.handle === 'string' && user.handle
            ? user.handle
            : typeof p?.userHandle === 'string' && p.userHandle
            ? p.userHandle
            : '';

        const rrPctStr = rrVal == null ? '' : rrVal === 0 ? '0%' : rrVal.toFixed(2).replace(/\.00$/, '') + '%';
        const irPctStr = irVal == null ? '' : irVal === 0 ? '0%' : irVal.toFixed(1).replace(/\.0$/, '') + '%';

        rows.push({
          id: pid,
          url: p.url ? p.url : `${location.origin}/p/${pid}`,
          ownerHandle,
          views: isFinite(uv) ? uv : 0,
          likes: isFinite(likes) ? likes : 0,
          remixes: isFinite(remixes) ? remixes : 0,
          comments: isFinite(comments) ? comments : 0,
          rrPctStr,
          rrPctVal: rrVal == null ? -1 : rrVal,
          irPctStr,
          irPctVal: irVal == null ? -1 : irVal,
          expiringMin,
          caption,
        });
      }
    }
    if (DEBUG.analyze) dlog('analyze', 'rows from storage', rows.length);
    return rows;
  }

  function collectAnalyzeRowsFromLiveMaps() {
    const rows = [];
    for (const [id, likes] of idToLikes.entries()) {
      const meta = idToMeta.get(id);
      const ageMin = meta?.ageMin;
      if (!Number.isFinite(ageMin) || ageMin > 1440) continue;
      if (!Number.isFinite(likes) || likes < 20) continue;

      const uv = Number(idToUnique.get(id) ?? 0);
      const comments = Number(idToComments.get(id) ?? 0);
      const remixes = Number(idToRemixes.get(id) ?? 0);

      const rrRaw = remixRate(likes, remixes); // "12.34" or null
      const rrPctStr = rrRaw == null ? '' : +rrRaw === 0 ? '0%' : (rrRaw.endsWith('.00') ? rrRaw.slice(0, -3) : rrRaw) + '%';
      const rrPctVal = rrRaw == null ? -1 : +rrRaw;

      const irVal = uv > 0 ? (((Number(likes) || 0) + (Number(comments) || 0)) / uv) * 100 : null;
      const irPctStr = irVal == null ? '' : irVal === 0 ? '0%' : irVal.toFixed(1).replace(/\.0$/, '') + '%';

      const expiringMin = Math.max(0, 1440 - Math.floor(ageMin));

      rows.push({
        id,
        url: `${location.origin}/p/${id}`,
        ownerHandle: typeof meta?.userHandle === 'string' && meta.userHandle ? meta.userHandle : '',
        views: uv || 0,
        likes: Number(likes) || 0,
        remixes: remixes || 0,
        comments: comments || 0,
        rrPctStr,
        rrPctVal,
        irPctStr,
        irPctVal: irVal == null ? -1 : irVal,
        expiringMin,
        caption: '', // live map path doesn’t retain caption reliably
      });
    }
    if (DEBUG.analyze) dlog('analyze', 'rows from live maps', rows.length);
    return rows;
  }

  function ensureAnalyzeOverlay() {
    if (analyzeOverlayEl && document.contains(analyzeOverlayEl)) return analyzeOverlayEl;

    const ov = document.createElement('div');
    ov.className = 'sora-uv-analyze-overlay';
    Object.assign(ov.style, {
      position: 'fixed',
      inset: '0',
      zIndex: 2147483646,
      background: 'rgba(33,33,33,0.75)', // page veil
      color: '#fff',
      display: 'none',
      overflow: 'auto', // scroll container for sticky header
    });

    // Hide scrollbars once
    if (!ov.querySelector('#sora-uv-hide-scroll')) {
      const st = document.createElement('style');
      st.id = 'sora-uv-hide-scroll';
      st.textContent = `
        .sora-uv-analyze-overlay {scrollbar-width:none;-ms-overflow-style:none;}
        .sora-uv-analyze-overlay::-webkit-scrollbar {width:0;height:0}
        .sora-uv-analyze-overlay *::-webkit-scrollbar {width:0;height:0}
      `;
      ov.appendChild(st);
    }

    const wrap = document.createElement('div');
    Object.assign(wrap.style, { maxWidth: '1400px', margin: '24px auto', padding: '0 16px 40px' });
    ov.appendChild(wrap);

    const panel = document.createElement('div');
    // IMPORTANT: do NOT use overflow:hidden here; use clip (no scroll container) or visible fallback.
    const panelOverflow = (window.CSS && CSS.supports && CSS.supports('overflow', 'clip')) ? 'clip' : 'visible';
    Object.assign(panel.style, {
      position: 'relative',
      borderRadius: '24px',
      padding: '16px',
      border: '1px solid #353535',      // stroke
      boxShadow: '0 6px 28px rgba(0,0,0,0.35)',
      background: '#1e1e1e',          // panel BG
      overflow: panelOverflow,        // was 'hidden' before; this breaks sticky
      isolation: 'isolate',
    });
    wrap.appendChild(panel);
    ov._panel = panel;

    ov.addEventListener('mousedown', (e) => {
      if (!panel.contains(e.target)) { e.preventDefault(); exitAnalyzeMode(); }
    });

    // ---------- Header ----------
    const headerBox = document.createElement('div');
    Object.assign(headerBox.style, {
      display: 'flex', flexDirection: 'column', alignItems: 'flex-start',
      gap: '6px', marginBottom: '12px', position: 'relative',
    });

    const h1 = document.createElement('h1');
    h1.textContent = "Today's Top Insights";
    Object.assign(h1.style, { fontSize: '22px', fontWeight: '800', margin: 0 });

    analyzeHeaderTextEl = document.createElement('div');
    Object.assign(analyzeHeaderTextEl.style, {
      fontSize: '15px', fontWeight: '600', opacity: 0.9, color: 'rgba(255,255,255,0.9)', margin: 0,
    });

    analyzeHelperTextEl = document.createElement('div');
    analyzeHelperTextEl.textContent = "Pro tip: Run 'Gather' mode on Top Feed in its own window and this data will auto-refresh!";
    Object.assign(analyzeHelperTextEl.style, {
      fontSize: '12px',
      fontWeight: '400',
      color: '#a3a3a3',
      margin: 0,
      display: 'none',
    });

    headerBox.appendChild(h1);
    headerBox.appendChild(analyzeHeaderTextEl);
    headerBox.appendChild(analyzeHelperTextEl);
    panel.appendChild(headerBox);

    // ---------- Slider Row ----------
    analyzeSliderWrap = document.createElement('div');
    Object.assign(analyzeSliderWrap.style, {
      width: '100%', display: 'none', alignItems: 'center', gap: '10px',
      padding: '10px 12px', borderRadius: '14px',
      background: 'rgba(48,48,48,0.22)',
      border: '1px solid #353535',
      boxShadow: '0 6px 20px rgba(0,0,0,0.30), inset 0 0 1px rgba(255,255,255,0.18)',
      isolation: 'isolate', position: 'relative', margin: '4px 0 10px',
    });
    panel.appendChild(analyzeSliderWrap);

    const lbl = document.createElement('div');
    lbl.textContent = 'Range';
    Object.assign(lbl.style, { fontWeight: 800, fontSize: '13px', opacity: 0.9, minWidth: '64px' });

    const track = document.createElement('div');
    Object.assign(track.style, { position: 'relative', flex: '1 1 auto', height: '20px', display: 'flex', alignItems: 'center' });

    const trackBar = document.createElement('div');
    Object.assign(trackBar.style, {
      position: 'absolute', left: 0, right: 0, height: '8px',
      borderRadius: '9999px', background: 'rgba(255,255,255,0.85)', pointerEvents: 'none',
    });

    const fillBar = document.createElement('div');
    Object.assign(fillBar.style, {
      position: 'absolute', left: 0, height: '8px', borderRadius: '9999px',
      background: 'hsla(120,60%,30%,0.95)', width: '0%', pointerEvents: 'none', willChange: 'width',
    });

    const rangeInput = document.createElement('input');
    rangeInput.type = 'range';
    rangeInput.min = '1';
    rangeInput.max = '24';
    rangeInput.step = '1';
    rangeInput.value = String(analyzeWindowHours);
    Object.assign(rangeInput.style, {
      appearance: 'none', WebkitAppearance: 'none', width: '100%', height: '20px', background: 'transparent', outline: 'none', zIndex: 1,
    });

    if (!ov.querySelector('#sora-uv-range-thumb')) {
      const thumbStyle = document.createElement('style');
      thumbStyle.id = 'sora-uv-range-thumb';
      thumbStyle.textContent = `
        .sora-uv-analyze-overlay input[type="range"]::-webkit-slider-thumb{
          appearance:none;-webkit-appearance:none;width:18px;height:18px;border-radius:50%;
          background:hsla(120,60%,30%,1);border:2px solid hsla(120,60%,40%,1);
          box-shadow:0 0 0 2px rgba(0,0,0,0.15),0 6px 14px rgba(0,0,0,0.30);
        }
        .sora-uv-analyze-overlay input[type="range"]::-moz-range-thumb{
          width:18px;height:18px;border-radius:50%;
          background:hsla(120,60%,30%,1);border:2px solid hsla(120,60%,40%,1);
          box-shadow:0 0 0 2px rgba(0,0,0,0.15),0 6px 14px rgba(0,0,0,0.30);
        }
        .sora-uv-analyze-overlay input[type="range"]::-webkit-slider-runnable-track{background:transparent;}
        .sora-uv-analyze-overlay input[type="range"]::-moz-range-track{background:transparent;}
      `;
      ov.appendChild(thumbStyle);
    }

    const pill = document.createElement('div');
    Object.assign(pill.style, {
      padding: '6px 10px',
      borderRadius: '9999px',
      background: 'hsla(120,60%,30%,0.85)',
      border: '1px solid hsla(120,60%,40%,0.9)',
      boxShadow: '0 0 10px 3px hsla(120,60%,35%,0.35)',
      fontWeight: 800,
      fontSize: '12px',
      whiteSpace: 'nowrap',
      zIndex: 2,
      cursor: 'pointer',
    });

    const updateSliderUI = () => {
      const val = Number(rangeInput.value) || 1;
      pill.textContent = val === 1 ? '1 hour' : `${val} hours`;
      const pctLogical = ((val - 1) / 23) * 100;
      const pctSafe = Math.min(99.6, Math.max(0, pctLogical));
      fillBar.style.width = pctSafe + '%';
    };

    pill.onclick = () => {
      rangeInput.value = '24';
      analyzeWindowHours = 24;
      localStorage.setItem('SORA_UV_ANALYZE_WINDOW_H', '24');
      updateSliderUI();
      renderAnalyzeTable(true);
    };
    rangeInput.oninput = () => {
      analyzeWindowHours = Math.min(24, Math.max(1, Number(rangeInput.value) || 24));
      localStorage.setItem('SORA_UV_ANALYZE_WINDOW_H', String(analyzeWindowHours));
      updateSliderUI();
      renderAnalyzeTable(true);
    };
    window.addEventListener('resize', updateSliderUI);

    track.appendChild(trackBar);
    track.appendChild(fillBar);
    track.appendChild(rangeInput);

    analyzeSliderWrap.appendChild(lbl);
    analyzeSliderWrap.appendChild(track);
    analyzeSliderWrap.appendChild(pill);

    // ---------- Table ----------
    analyzeTableEl = document.createElement('table');
    Object.assign(analyzeTableEl.style, {
      width: '100%',
      borderCollapse: 'separate', // keep separate for sticky compatibility
      borderSpacing: 0,
      fontSize: '13px',
      background: 'transparent',
      tableLayout: 'fixed',
      position: 'relative',
      borderRadius: '14px',
    });
    panel.appendChild(analyzeTableEl);

    // Sticky header offset var for thead/th
    ov._recomputeSticky = () => {
      ov.style.setProperty('--analyze-sticky-top', '0px'); // stick to overlay viewport top
    };
    const ro = new ResizeObserver(() => ov._recomputeSticky());
    ro.observe(panel);
    ro.observe(headerBox);
    ro.observe(analyzeSliderWrap);
    window.addEventListener('resize', ov._recomputeSticky);
    requestAnimationFrame(() => {
      ov._recomputeSticky();
      updateSliderUI();
    });

    document.documentElement.appendChild(ov);
    analyzeOverlayEl = ov;
    return ov;
  }


  function buildAnalyzeHeaderIfNeeded() {
    const table = analyzeTableEl;
    if (!table) return;

    const legacy = document.querySelector('.sora-uv-sticky-head');
    if (legacy) legacy.remove();

    const allHeads = Array.from(table.querySelectorAll('thead'));
    const existing = allHeads.shift();
    allHeads.forEach((h) => h.remove());

    if (!table.querySelector('colgroup')) {
      const cg = document.createElement('colgroup');

      // Tiny Prompt column (first)
      const colPrompt = document.createElement('col');
      colPrompt.style.width = '28px';
      colPrompt.style.minWidth = '28px';
      colPrompt.style.maxWidth = '28px';
      cg.appendChild(colPrompt);

      const colPost = document.createElement('col');
      colPost.style.width = 'auto';
      colPost.style.minWidth = '140px';
      cg.appendChild(colPost);

      ['100px', '60px', '60px', '60px', '75px', '75px', '100px'].forEach((w) => {
        const c = document.createElement('col');
        c.style.width = w;
        c.style.maxWidth = w;
        cg.appendChild(c);
      });

      table.insertBefore(cg, table.firstChild);
    }

    let thead = existing;
    if (!thead) {
      thead = document.createElement('thead');
      const tr = document.createElement('tr');
      [
        ['prompt', '📋'],
        ['post', 'Post'],
        ['views', 'Views'],
        ['likes', '👍'],
        ['remixes', '🌀'],
        ['comments', '💬'],
        ['rr', 'RR %'],
        ['ir', 'IR %'],
        ['expiring', 'Expires'],
      ].forEach(([key, label]) => {
        const th = document.createElement('th');
        th.dataset.key = key;
        th.textContent = label;
        if (key === 'prompt') th.title = 'Prompt';
        Object.assign(th.style, {
          background: 'rgba(24,24,24,0.88)',
          textAlign: key === 'post' ? 'left' : (key === 'prompt' ? 'center' : 'right'),
          padding: key === 'prompt' ? '6px 0' : '10px 12px',
          cursor: key === 'prompt' ? 'default' : 'pointer',
          fontWeight: '800',
          userSelect: 'none',
          position: 'sticky',
          top: 'var(--analyze-sticky-top,0)',
          borderBottom: '1px solid rgba(255,255,255,0.1)',
          borderTop: '1px solid rgba(255,255,255,0.1)',
          zIndex: 12,
          borderRadius: '0',
          borderTopLeftRadius: '0',
          borderTopRightRadius: '0',
          width: key === 'prompt' ? '28px' : undefined,
          maxWidth: key === 'prompt' ? '28px' : undefined,
          minWidth: key === 'prompt' ? '28px' : undefined,
        });

        if (key === 'post') {
          th.style.paddingLeft = '0';
          th.style.marginLeft = '0';
        }

        // Only make sortable if not the prompt column
        if (key !== 'prompt') {
          th.onclick = () => {
            analyzeSortDir = analyzeSortKey === key && analyzeSortDir === 'asc' ? 'desc' : 'asc';
            analyzeSortKey = key;
            updateAnalyzeHeaderSortIndicators();
            renderAnalyzeTable(true);
          };
        }

        tr.appendChild(th);
      });
      thead.appendChild(tr);
    }

    const firstBody = table.querySelector('tbody');
    table.insertBefore(thead, firstBody);

    Object.assign(thead.style, {
      position: 'sticky',
      top: 'var(--analyze-sticky-top,0)',
      zIndex: 12,
      backdropFilter: 'blur(6px)',
      WebkitBackdropFilter: 'blur(6px)',
      borderRadius: '0',
    });

    Array.from(thead.querySelectorAll('th')).forEach((th) => {
      th.style.borderTopLeftRadius = '0';
      th.style.borderTopRightRadius = '0';
      th.style.borderRadius = '0';
    });

    updateAnalyzeHeaderSortIndicators();
  }


  function updateAnalyzeHeaderSortIndicators() {
    const table = analyzeTableEl;
    if (!table || !table.tHead) return;
    const ths = Array.from(table.tHead.querySelectorAll('th'));
    for (const th of ths) {
      const key = th.dataset.key;
      const base = th.textContent.replace(/\s+[▲▼]$/, '');
      if (key && key === analyzeSortKey) {
        th.textContent = base + (analyzeSortDir === 'asc' ? ' ▲' : ' ▼');
      } else {
        th.textContent = base;
      }
    }
  }

  function buildAnalyzeHeaderIfNeeded() {
    const table = analyzeTableEl;
    if (!table) return;

    const legacy = document.querySelector('.sora-uv-sticky-head');
    if (legacy) legacy.remove();

    const allHeads = Array.from(table.querySelectorAll('thead'));
    const existing = allHeads.shift();
    allHeads.forEach((h) => h.remove());

    if (!table.querySelector('colgroup')) {
      const cg = document.createElement('colgroup');

      // Tiny Prompt column (first)
      const colPrompt = document.createElement('col');
      colPrompt.style.width = '28px';
      colPrompt.style.minWidth = '28px';
      colPrompt.style.maxWidth = '28px';
      cg.appendChild(colPrompt);

      const colPost = document.createElement('col');
      colPost.style.width = 'auto';
      colPost.style.minWidth = '140px';
      cg.appendChild(colPost);

      ['100px', '60px', '60px', '60px', '75px', '75px', '100px'].forEach((w) => {
        const c = document.createElement('col');
        c.style.width = w;
        c.style.maxWidth = w;
        cg.appendChild(c);
      });

      table.insertBefore(cg, table.firstChild);
    }

    let thead = existing;
    if (!thead) {
      thead = document.createElement('thead');
      const tr = document.createElement('tr');
      [
        ['prompt', '📋'],
        ['post', 'Post'],
        ['views', 'Views'],
        ['likes', '👍'],
        ['remixes', '🌀'],
        ['comments', '💬'],
        ['rr', 'RR %'],
        ['ir', 'IR %'],
        ['expiring', 'Expires'],
      ].forEach(([key, label]) => {
        const th = document.createElement('th');
        th.dataset.key = key;
        th.textContent = label;
        if (key === 'prompt') th.title = 'Prompt';
        Object.assign(th.style, {
          background: 'rgba(24,24,24,0.88)',
          textAlign: key === 'post' ? 'left' : (key === 'prompt' ? 'center' : 'right'),
          padding: key === 'prompt' ? '6px 0' : '10px 12px',
          cursor: key === 'prompt' ? 'default' : 'pointer',
          fontWeight: '800',
          userSelect: 'none',
          position: 'sticky',
          top: 'var(--analyze-sticky-top,0)',
          borderBottom: '1px solid rgba(255,255,255,0.1)',
          borderTop: '1px solid rgba(255,255,255,0.1)',
          zIndex: 12,
          borderRadius: '0',
          borderTopLeftRadius: '0',
          borderTopRightRadius: '0',
          width: key === 'prompt' ? '28px' : undefined,
          maxWidth: key === 'prompt' ? '28px' : undefined,
          minWidth: key === 'prompt' ? '28px' : undefined,
        });

        if (key === 'post') {
          th.style.paddingLeft = '0';
          th.style.marginLeft = '0';
        }

        // Only make sortable if not the prompt column
        if (key !== 'prompt') {
          th.onclick = () => {
            analyzeSortDir = analyzeSortKey === key && analyzeSortDir === 'asc' ? 'desc' : 'asc';
            analyzeSortKey = key;
            updateAnalyzeHeaderSortIndicators();
            renderAnalyzeTable(true);
          };
        }

        tr.appendChild(th);
      });
      thead.appendChild(tr);
    }

    const firstBody = table.querySelector('tbody');
    table.insertBefore(thead, firstBody);

    Object.assign(thead.style, {
      position: 'sticky',
      top: 'var(--analyze-sticky-top,0)',
      zIndex: 12,
      backdropFilter: 'blur(6px)',
      WebkitBackdropFilter: 'blur(6px)',
      borderRadius: '0',
    });

    Array.from(thead.querySelectorAll('th')).forEach((th) => {
      th.style.borderTopLeftRadius = '0';
      th.style.borderTopRightRadius = '0';
      th.style.borderRadius = '0';
    });

    updateAnalyzeHeaderSortIndicators();
  }

async function renderAnalyzeTable(force = false) {
  if (!force) {
    if (renderAnalyzeTable._busy) return;
    const now = Date.now();
    if (renderAnalyzeTable._last && now - renderAnalyzeTable._last < 200) return;
    renderAnalyzeTable._last = now;
  }
  renderAnalyzeTable._busy = true;

  try {
    if (!analyzeActive) return;
    ensureAnalyzeOverlay();
    buildAnalyzeHeaderIfNeeded();

    // ⛔️ Do NOT force borderCollapse='collapse' here.
    // Leave the table with border-collapse: separate (set at creation).

    let rows = await collectAnalyzeRowsFromStorage();
    if (!rows.length && typeof collectAnalyzeRowsFromLiveMaps === 'function') rows = collectAnalyzeRowsFromLiveMaps();

    const windowMin = (Number(analyzeWindowHours) || 24) * 60;
    const expiringThreshold = 1440 - windowMin;
    rows = rows.filter((r) => Number.isFinite(r.expiringMin) && r.expiringMin >= expiringThreshold);
    rows = sortRows(rows);

    const newTbody = document.createElement('tbody');
    const visitedSet = getAnalyzeVisited(); // Get set once for quick lookups and purging

    const mkTdNum = (v) => {
      const td = document.createElement('td');
      td.textContent = typeof v === 'number' ? v.toLocaleString('en-US') : v || '—';
      Object.assign(td.style, {
        padding: '10px 12px',
        textAlign: 'right',
        borderBottom: '1px solid rgba(255,255,255,0.08)',
      });
      return td;
    };

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const postId = r.id; // Post ID for visited tracking

      const tr = document.createElement('tr');
      Object.assign(tr.style, { transition: 'background-color 120ms ease' });
      if (i % 2 === 1) tr.style.background = 'rgba(255,255,255,0.03)';
      tr.onmouseenter = () => { tr.style.background = 'rgba(255,255,255,0.05)'; };
      tr.onmouseleave = () => { tr.style.background = i % 2 === 1 ? 'rgba(255,255,255,0.03)' : 'transparent'; };

      const tdPrompt = document.createElement('td');
      Object.assign(tdPrompt.style, {
        padding: '6px 4px',
        borderBottom: '1px solid rgba(255,255,255,0.08)',
        textAlign: 'center',
        width: '28px',
        minWidth: '28px',
        maxWidth: '28px',
      });
      const captionOnly = (typeof r.caption === 'string' ? r.caption : '').replace(/\s+/g, ' ').trim();
      if (captionOnly.length > 100) {
        const btn = document.createElement('a');
        btn.href = 'javascript:void(0)';
        btn.textContent = '📋';
        btn.setAttribute('role', 'button');
        btn.setAttribute('aria-label', 'Copy prompt');
        Object.assign(btn.style, {
          textDecoration: 'none',
          cursor: 'pointer',
          userSelect: 'none',
          display: 'inline-block',
          lineHeight: '1',
        });
        btn.addEventListener('click', async (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          await copyTextToClipboard(captionOnly);
          showPromptClickTooltip(ev.clientX, ev.clientY, 'Prompt copied!', 1000);
        });
        btn.addEventListener('keydown', async (ev) => {
          if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault();
            await copyTextToClipboard(captionOnly);
            const rect = btn.getBoundingClientRect();
            const cx = rect.left + rect.width / 2;
            const cy = rect.top;
            showPromptClickTooltip(cx, cy, 'Prompt copied!', 1000);
          }
        });
        tdPrompt.appendChild(btn);
      } else {
        tdPrompt.textContent = '';
      }

      const tdPost = document.createElement('td');
      Object.assign(tdPost.style, {
        padding: '10px 12px 10px 0',
        borderBottom: '1px solid rgba(255,255,255,0.08)',
        textAlign: 'left',
      });

      const a = document.createElement('a');
      a.href = r.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      Object.assign(a.style, {
        color: '#cfe3ff',
        textDecoration: 'none',
        display: 'block',
        width: '100%',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        paddingLeft: '0',
        marginLeft: '0',
        // Apply opacity if visited
        opacity: visitedSet.has(postId) ? '0.45' : '1',
      });

      // Add click handler to mark as visited
      a.addEventListener('click', () => {
          addAnalyzeVisited(postId);
          a.style.opacity = '0.6';
      });


      const owner = typeof r.ownerHandle === 'string' && r.ownerHandle ? r.ownerHandle : '';
      const captionRaw = typeof r.caption === 'string' && r.caption ? r.caption : r.id;
      const fullLabel = owner ? `${owner} • ${captionRaw}` : captionRaw || '';
      a.title = fullLabel;

      if (owner) {
        const u = document.createElement('span'); u.textContent = owner; u.style.fontWeight = '800'; a.appendChild(u);
        const sep = document.createElement('span'); sep.textContent = ' - '; sep.style.fontWeight = '300'; a.appendChild(sep);
        const c = document.createElement('span'); c.textContent = captionRaw || ''; c.style.fontWeight = '300'; a.appendChild(c);
      } else {
        const c = document.createElement('span'); c.textContent = captionRaw || ''; c.style.fontWeight = '300'; a.appendChild(c);
      }

      a.onmouseenter = () => { a.style.textDecoration = 'underline'; };
      a.onmouseleave = () => { a.style.textDecoration = 'none'; };
      tdPost.appendChild(a);

      const tdViews = mkTdNum(r.views);
      const tdLikes = mkTdNum(r.likes);
      const tdRemixes = mkTdNum(r.remixes);
      const tdComments = mkTdNum(r.comments);
      const tdRR = mkTdNum(r.rrPctStr || '—');
      const tdIR = mkTdNum(r.irPctStr || '—');
      const expStr = typeof r.expiringMin === 'number' ? (r.expiringMin <= 0 ? '0m' : fmtAgeMin(r.expiringMin)) : '—';
      const tdExp = mkTdNum(expStr);

      tr.appendChild(tdPrompt);
      tr.appendChild(tdPost);
      tr.appendChild(tdViews);
      tr.appendChild(tdLikes);
      tr.appendChild(tdRemixes);
      tr.appendChild(tdComments);
      tr.appendChild(tdRR);
      tr.appendChild(tdIR);
      tr.appendChild(tdExp);
      newTbody.appendChild(tr);
    }

    const table = analyzeTableEl;
    const oldTbody = table.tBodies[0];
    const swap = () => {
      if (oldTbody) table.replaceChild(newTbody, oldTbody);
      else table.appendChild(newTbody);
    };
    if ('requestAnimationFrame' in window) requestAnimationFrame(swap);
    else swap();

    const isAnalyzing = !!(analyzeRapidScrollId || analyzeCountdownIntervalId);
    if (!isAnalyzing && analyzeHeaderTextEl) {
      const hoursLabel = (n) => (Number(n) === 1 ? '1 hour' : `${n} hours`);
      analyzeHeaderTextEl.textContent = rows.length
        ? `${rows.length} top gens from the last ${hoursLabel(analyzeWindowHours)}`
        : `No gens for last ${hoursLabel(analyzeWindowHours)}... run Gather mode!`;
    }
  } finally {
    renderAnalyzeTable._busy = false;
  }
}


  function updateAnalyzeHeaderSortIndicators() {
    const table = analyzeTableEl;
    if (!table || !table.tHead) return;
    const ths = Array.from(table.tHead.querySelectorAll('th'));
    for (const th of ths) {
      const key = th.dataset.key;
      const base = th.textContent.replace(/\s+[▲▼]$/, '');
      if (key && key === analyzeSortKey) {
        th.textContent = base + (analyzeSortDir === 'asc' ? ' ▲' : ' ▼');
      } else {
        th.textContent = base;
      }
    }
  }

  function showAnalyzeTable(show) {
    if (!analyzeTableEl) return;
    analyzeTableEl.style.display = show ? '' : 'none';
  }

  function sortRows(rows) {
    const key = analyzeSortKey;
    const dir = analyzeSortDir === 'asc' ? 1 : -1;
    rows.sort((a, b) => {
      if (key === 'prompt') {
        const aLen = (a.caption || '').replace(/\s+/g, ' ').trim().length;
        const bLen = (b.caption || '').replace(/\s+/g, ' ').trim().length;
        return (aLen - bLen) * dir;
      }
      if (key === 'post') {
        const aUser = (a.ownerHandle || '').toLowerCase();
        const bUser = (b.ownerHandle || '').toLowerCase();
        if (aUser !== bUser) return aUser.localeCompare(bUser) * dir;
        const aCap = (a.caption || a.id || '').toLowerCase();
        const bCap = (b.caption || b.id || '').toLowerCase();
        return aCap.localeCompare(bCap) * dir;
      }
      if (key === 'views') return (a.views - b.views) * dir;
      if (key === 'likes') return (a.likes - b.likes) * dir;
      if (key === 'remixes') return (a.remixes - b.remixes) * dir;
      if (key === 'comments') return (a.comments - b.comments) * dir;
      if (key === 'rr') return ((a.rrPctVal ?? -1) - (b.rrPctVal ?? -1)) * dir;
      if (key === 'ir') return ((a.irPctVal ?? -1) - (b.irPctVal ?? -1)) * dir;
      if (key === 'expiring') return (a.expiringMin - b.expiringMin) * dir;
      return 0;
    });
    return rows;
  }


  function hideAllCards(hide) {
    for (const card of selectAllCards()) {
      if (hide) card.style.display = 'none';
      else card.style.display = '';
    }
  }

  function startRapidAnalyzeGather() {
    stopRapidAnalyzeGather();
    showAnalyzeTable(false);
    if (analyzeSliderWrap) analyzeSliderWrap.style.display = 'none';

    // Faster, longer bursts; no end detection
    const BURST_STEP_PX = 1200; // was 100
    const TICK_MS = 5;      // was 10

    const step = () => {
      window.scrollBy(0, BURST_STEP_PX);
      analyzeRapidScrollId = setTimeout(step, TICK_MS);
    };
    step();

    analyzeCountdownRemainingSec = Math.max(1, Math.round(ANALYZE_RUN_MS / 1000));
    const updateCountdown = () => {
      if (!analyzeHeaderTextEl) return;
      analyzeHeaderTextEl.textContent = `Analyzing for ${analyzeCountdownRemainingSec}…`;
    };
    updateCountdown();

    analyzeCountdownIntervalId = setInterval(() => {
      analyzeCountdownRemainingSec = Math.max(0, analyzeCountdownRemainingSec - 1);
      if (analyzeCountdownRemainingSec > 0) updateCountdown();
    }, 1000);

    analyzeRapidStopTimeout = setTimeout(() => {
      stopRapidAnalyzeGather();
      showAnalyzeTable(true);
      if (analyzeSliderWrap) analyzeSliderWrap.style.display = 'flex';
      renderAnalyzeTable(true);
      setTimeout(() => {
        try {
          const hasRows = !!(analyzeTableEl && analyzeTableEl.tBodies[0] && analyzeTableEl.tBodies[0].rows.length);
          if (analyzeHelperTextEl) analyzeHelperTextEl.style.display = hasRows ? '' : 'none';
        } catch {}
      }, 0);
    }, ANALYZE_RUN_MS);
  }



  function stopRapidAnalyzeGather() {
    if (analyzeRapidScrollId) {
      clearTimeout(analyzeRapidScrollId);
      analyzeRapidScrollId = null;
    }
    if (analyzeRapidStopTimeout) {
      clearTimeout(analyzeRapidStopTimeout);
      analyzeRapidStopTimeout = null;
    }
    if (analyzeRefreshRowsInterval) {
      clearInterval(analyzeRefreshRowsInterval);
      analyzeRefreshRowsInterval = null;
    }
    if (analyzeCountdownIntervalId) {
      clearInterval(analyzeCountdownIntervalId);
      analyzeCountdownIntervalId = null;
    }
  }

  async function enterAnalyzeMode() {
    analyzeActive = true;
    const ov = ensureAnalyzeOverlay();

    hideAllCards(true);
    ov.style.display = 'block';

    if (typeof ov._recomputeSticky === 'function') ov._recomputeSticky();

    analyzeBtn && analyzeBtn.setActive && analyzeBtn.setActive(true);
    // keep existing sort (don’t reset), only set defaults if nothing chosen
    if (!analyzeSortKey) analyzeSortKey = 'views';
    if (!analyzeSortDir) analyzeSortDir = 'desc';

    startRapidAnalyzeGather();    // 10s burst to populate quickly
    startAnalyzeAutoRefresh();    // then keep it fresh every minute
    updateControlsVisibility();
  }

  function exitAnalyzeMode() {
    analyzeActive = false;
    stopRapidAnalyzeGather();
    stopAnalyzeAutoRefresh();
    hideAllCards(false);
    if (analyzeOverlayEl) analyzeOverlayEl.style.display = 'none';
    analyzeBtn && analyzeBtn.setActive && analyzeBtn.setActive(false);

    const bar = controlBar || ensureControlBar();
    if (bar) {
      const f = bar.querySelector('[data-role="filter-btn"]');
      const g = bar.querySelector('.sora-uv-gather-btn');
      if (f) f.style.display = '';
      if (g) g.style.display = '';
    }

    updateControlsVisibility();
  }

  function toggleAnalyzeMode() {
    if (!isTopFeed()) return;
    if (analyzeActive) exitAnalyzeMode();
    else enterAnalyzeMode();
  }

  // == Filtering ==
  function applyFilter() {
    if (analyzeActive) return; // overlay handles visibility
    const s = getGatherState();
    const idx = s.filterIndex ?? 0;
    const limitMin = FILTER_STEPS_MIN[idx];

    for (const card of selectAllCards()) {
      const id = extractIdFromCard(card);
      const meta = idToMeta.get(id);
      if (limitMin == null || isGatheringActiveThisTab) {
        card.style.display = '';
        continue;
      }
      const show = Number.isFinite(meta?.ageMin) && meta.ageMin <= limitMin;
      card.style.display = show ? '' : 'none';
    }
  }

  function applyBookmarksFilter(force = false) {
    if (!isDrafts()) return;

    // Skip if filter hasn't changed (unless forced)
    if (!force && lastAppliedFilterState === bookmarksFilterState) {
      return;
    }

    const bookmarks = getBookmarks();
    const draftCards = selectAllDrafts();
    lastAppliedFilterState = bookmarksFilterState;

    for (const draftCard of draftCards) {
      const draftId = extractDraftIdFromCard(draftCard);

      // Determine if this card should be visible based on current filter state
      let shouldShow = true;

      if (!draftId) {
        // No ID found - fade when filtering, show when showing all
        shouldShow = bookmarksFilterState === 0;
      } else {
        const isBookmarked = bookmarks.has(draftId);
        const isViolation = idToViolation.get(draftId);

        if (bookmarksFilterState === 0) {
          // Show all drafts
          shouldShow = true;
        } else if (bookmarksFilterState === 1) {
          // Show only bookmarked drafts
          shouldShow = isBookmarked;
        } else if (bookmarksFilterState === 2) {
          // Show only unbookmarked drafts
          shouldShow = !isBookmarked;
        } else if (bookmarksFilterState === 3) {
          // Show only content violations
          shouldShow = isViolation;
        }
      }

      // Apply visual fade instead of hiding
      if (shouldShow) {
        draftCard.style.removeProperty('opacity');
        draftCard.style.removeProperty('pointer-events');
        draftCard.style.removeProperty('filter');
      } else {
        // Using !important is intentional - as a browser extension injecting into an unknown page,
        // we need to override any existing styles that might interfere with filter visibility
        draftCard.style.setProperty('opacity', '0.25', 'important');
        draftCard.style.setProperty('pointer-events', 'none', 'important');
        draftCard.style.setProperty('filter', 'grayscale(1)', 'important');
      }
    }
  }

  // == Gather Mode ==
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
    if (deadline) {
      const remainingMs = Math.max(0, deadline - Date.now());
      gatherTimerEl.textContent = `Refresh in ${fmtRefreshCountdown(remainingMs)}`;
    } else {
      gatherTimerEl.textContent = '';
    }
  }

  function startGathering(forceNewDeadline = false) {
    // stop any prior loops
    if (gatherScrollIntervalId) {
      clearTimeout(gatherScrollIntervalId);
      gatherScrollIntervalId = null;
    }
    if (gatherRefreshTimeoutId) {
      clearTimeout(gatherRefreshTimeoutId);
      gatherRefreshTimeoutId = null;
    }

    // small, frequent increments for smoothness (~60fps)
    const TICK_MS = 16; // ~60Hz
    function startSmoothAutoScroll(pxPerStep) {
      const step = Math.max(0.25, Number(pxPerStep) || 1); // allow sub-pixel movement
      function tick() {
        const atBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 100;
        if (!atBottom) {
          window.scrollTo(0, window.scrollY + step);
        }
        gatherScrollIntervalId = setTimeout(tick, TICK_MS);
      }
      tick();
    }

    if (isTopFeed()) {
      // === TOP: keep 10m loop ===
      const refreshMs = 5 * 60 * 1000;
      const TOP_PX_PER_STEP = 16; //  1 → ~75 px/s

      const s0 = getGatherState() || {};
      if (!forceNewDeadline && typeof s0.refreshDeadline === 'number' && s0.refreshDeadline > Date.now()) {
        const remaining = s0.refreshDeadline - Date.now();
        startSmoothAutoScroll(TOP_PX_PER_STEP);
        gatherRefreshTimeoutId = setTimeout(() => location.reload(), remaining);
        updateCountdownDisplay();
        return;
      }

      startSmoothAutoScroll(TOP_PX_PER_STEP);

      const now = Date.now();
      let sessionState = getGatherState() || {};
      let refreshDelay = refreshMs;
      if (!forceNewDeadline && sessionState.refreshDeadline && sessionState.refreshDeadline > now) {
        refreshDelay = sessionState.refreshDeadline - now;
      } else {
        sessionState.refreshDeadline = now + refreshDelay;
        setGatherState(sessionState);
      }
      gatherRefreshTimeoutId = setTimeout(() => location.reload(), refreshDelay);
      updateCountdownDisplay();
      return;
    }

    // === PROFILE: slider-based smooth scroll (unchanged) ===
    const prefs = getPrefs();
    const speedValue = prefs.gatherSpeed != null ? prefs.gatherSpeed : '0';
    const t = Math.min(1, Math.max(0, Number(speedValue) / 100));

    // Map slider to pixels-per-second (slow → fast)
    const PPS_SLOW = 50;    // px/s at far left
    const PPS_MID = 1500;   // px/s mid
    const PPS_FAST = 3000;    // px/s far right

    const lerp = (a, b, u) => a + (b - a) * u;
    let pps;
    if (t <= 0.5) {
      pps = lerp(PPS_SLOW, PPS_MID, t / 0.5);
    } else {
      pps = lerp(PPS_MID, PPS_FAST, (t - 0.5) / 0.5);
    }
    const pxPerStep = (pps * TICK_MS) / 1000; // per-tick movement
    startSmoothAutoScroll(pxPerStep);

    // randomized refresh window (unchanged)
    const speedSlow = { rMin: 15 * 60000, rMax: 17 * 60000 };
    const speedMid  = { rMin: 7 * 60000,  rMax: 9 * 60000 };
    const speedFast = { rMin: 1 * 60000,  rMax: 2 * 60000 };

    let refreshMinMs, refreshMaxMs;
    if (t <= 0.5) {
      const u = t / 0.5;
      refreshMinMs = lerp(speedSlow.rMin, speedMid.rMin, u);
      refreshMaxMs = lerp(speedSlow.rMax, speedMid.rMax, u);
    } else {
      const u = (t - 0.5) / 0.5;
      refreshMinMs = lerp(speedMid.rMin, speedFast.rMin, u);
      refreshMaxMs = lerp(speedMid.rMax, speedFast.rMax, u);
    }

    const now = Date.now();
    let s = getGatherState() || {};
    let refreshDelay;
    if (!forceNewDeadline && s.refreshDeadline && s.refreshDeadline > now) {
      refreshDelay = s.refreshDeadline - now;
    } else {
      refreshDelay = Math.random() * (refreshMaxMs - refreshMinMs) + refreshMinMs;
      s.refreshDeadline = now + refreshDelay;
      setGatherState(s);
    }
    gatherRefreshTimeoutId = setTimeout(() => location.reload(), refreshDelay);
    updateCountdownDisplay();
  }


  function stopGathering(clearSessionState = false) {
    if (gatherScrollIntervalId) {
      clearTimeout(gatherScrollIntervalId);
      gatherScrollIntervalId = null;
    }
    if (gatherRefreshTimeoutId) {
      clearTimeout(gatherRefreshTimeoutId);
      gatherRefreshTimeoutId = null;
    }
    if (gatherCountdownIntervalId) {
      clearInterval(gatherCountdownIntervalId);
      gatherCountdownIntervalId = null;
    }
    if (gatherTimerEl) gatherTimerEl.textContent = '';

    const s = getGatherState() || {};
    s.isGathering = false;
    delete s.refreshDeadline;

    if (clearSessionState === true) {
      const keptFilter = typeof s.filterIndex === 'number' ? s.filterIndex : 0;
      sessionStorage.setItem(SESS_KEY, JSON.stringify({ filterIndex: keptFilter, isGathering: false }));
    } else {
      setGatherState(s);
    }
  }

  // == Network & Processing ==
  function looksLikeSoraFeed(json) {
    try {
      const items = json?.items || json?.data?.items || null;
      if (!Array.isArray(items) || items.length === 0) return false;
      let hits = 0;
      for (let i = 0; i < Math.min(items.length, 10); i++) {
        const it = items[i],
          p = it?.post || it || {};
        if (typeof p?.id === 'string' && /^s_[A-Za-z0-9]+$/.test(p.id)) {
          hits++;
          continue;
        }
        if (typeof p?.preview_image_url === 'string') {
          hits++;
          continue;
        }
        if (Array.isArray(p?.attachments) && p.attachments.length) {
          hits++;
          continue;
        }
      }
      return hits > 0;
    } catch {
      return false;
    }
  }

  function installFetchSniffer() {
    dlog('feed', 'install fetch sniffer');
    const origFetch = window.fetch;
    window.fetch = async function (input, init) {
      const res = await origFetch.apply(this, arguments);
      try {
        const url = typeof input === 'string' ? input : input?.url || '';

        // Check DRAFTS_RE before FEED_RE since drafts URL would also match FEED_RE
        if (DRAFTS_RE.test(url)) {
          res.clone().json().then(processDraftsJson).catch((err) => {
            console.error('[SoraUV] Error parsing drafts fetch response:', err);
          });
        } else if (FEED_RE.test(url)) {
          dlog('feed', 'fetch matched', { url });
          res
            .clone()
            .json()
            .then((j) => {
              dlog('feed', 'fetch parsed', { url, items: (j?.items || j?.data?.items || []).length });
              processFeedJson(j);
            })
            .catch(() => {});
        } else if (typeof url === 'string' && url.startsWith(location.origin)) {
          res
            .clone()
            .json()
            .then((j) => {
              if (looksLikeSoraFeed(j)) {
                dlog('feed', 'fetch autodetected', { url, items: (j?.items || j?.data?.items || []).length });
                processFeedJson(j);
              }
            })
            .catch(() => {});
        }
      } catch {}
      return res;
    };
    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.addEventListener('load', function () {
        try {
          if (typeof url === 'string') {
            // Check DRAFTS_RE before FEED_RE since drafts URL would also match FEED_RE
            if (DRAFTS_RE.test(url)) {
              try {
                processDraftsJson(JSON.parse(this.responseText));
              } catch (err) {
                console.error('[SoraUV] Error parsing drafts XHR:', err);
              }
            } else if (FEED_RE.test(url)) {
              dlog('feed', 'xhr matched', { url });
              try {
                const j = JSON.parse(this.responseText);
                dlog('feed', 'xhr parsed', { url, items: (j?.items || j?.data?.items || []).length });
                processFeedJson(j);
              } catch {}
            } else if (url.startsWith(location.origin)) {
              try {
                const j = JSON.parse(this.responseText);
                if (looksLikeSoraFeed(j)) {
                  dlog('feed', 'xhr autodetected', { url, items: (j?.items || j?.data?.items || []).length });
                  processFeedJson(j);
                }
              } catch {}
            }
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
      const findProfile = (root) => {
        if (!root || typeof root !== 'object') return null;
        const direct = root.profile || root.data?.profile || root.owner_profile || null;
        if (direct) return direct;
        const arr = root.items || root.data?.items || [];
        for (const it of Array.isArray(arr) ? arr : []) {
          if (it?.profile) return it.profile;
          if (it?.owner_profile) return it.owner_profile;
          const p = it?.post || it || {};
          if (p?.owner_profile) return p.owner_profile;
          if (p?.author && (p.author.cameo_count != null || p.author.follower_count != null || p.author.username))
            return p.author;
        }
        return null;
      };
      const prof = findProfile(json);
      const profFollowers = Number(json?.follower_count ?? json?.profile?.follower_count ?? prof?.follower_count);
      const profCameos = Number(json?.cameo_count ?? json?.profile?.cameo_count ?? prof?.cameo_count);
      const profHandle =
        (json?.username || json?.handle || json?.profile?.username || prof?.username || pageUserHandle || '')
          .toString() || null;
      const profId = json?.user_id || json?.id || json?.profile?.user_id || prof?.user_id || null;
      if (profHandle) {
        const userKey = `h:${String(profHandle).toLowerCase()}`;
        const base = { ts: Date.now(), userHandle: profHandle, userId: profId, userKey, pageUserHandle, pageUserKey };
        if (Number.isFinite(profFollowers)) batch.push({ ...base, followers: profFollowers });
        if (Number.isFinite(profCameos)) batch.push({ ...base, cameo_count: profCameos });
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
      const cx = getCameos(it);
      const p = it?.post || it || {};
      const created_at =
        p?.created_at ?? p?.uploaded_at ?? p?.createdAt ?? p?.created ?? p?.posted_at ?? p?.timestamp ?? null;
      const caption =
        (typeof p?.caption === 'string' && p.caption) ? p.caption : (typeof p?.text === 'string' && p.text ? p.text : null);
      const ageMin = minutesSince(created_at);
      const th = getThumbnail(it);

      if (uv != null) idToUnique.set(id, uv);
      if (likes != null) idToLikes.set(id, likes);
      if (tv != null) idToViews.set(id, tv);
      if (cm != null) idToComments.set(id, cm);
      if (rx != null) idToRemixes.set(id, rx);

      const absUrl = `${location.origin}/p/${id}`;
      const owner = getOwner(it);
      const userHandle = owner.handle || pageUserHandle || null;
      const userId = owner.id || null;

      // store owner with meta so Analyze can render "<owner> • <caption>"
      idToMeta.set(id, { ageMin, userHandle });

      const userKey = userHandle ? `h:${userHandle.toLowerCase()}` : userId != null ? `id:${userId}` : pageUserKey;
      const followers = getFollowerCount(it);

      batch.push({
        postId: id,
        uv,
        likes,
        views: tv,
        comments: cm,
        remixes: rx,
        remix_count: rx,
        cameos: cx,
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
        parent_post_id: p?.parent_post_id ?? null,
        root_post_id: p?.root_post_id ?? null,
        pageUserHandle,
        pageUserKey,
      });
    }

    if (batch.length)
      try {
        window.postMessage({ __sora_uv__: true, type: 'metrics_batch', items: batch }, '*');
      } catch {}

    renderBadges();
    renderDetailBadge();
    renderProfileImpact();
  }

  function processDraftsJson(json) {
    // Extract draft data from API response
    const items = json?.items || json?.data?.items || json?.generations || [];
    if (!Array.isArray(items) || items.length === 0) return;

    for (const item of items) {
      try {
        let draftId = item?.id || item?.generation_id || item?.draft_id;
        if (!draftId) continue;
        draftId = normalizeId(draftId);

        // Extract n_frames and fps from creation_config for duration
        const nFrames = item?.creation_config?.n_frames;
        const fps = item?.creation_config?.fps;
        if (typeof nFrames === 'number' && nFrames > 0) {
          // Use fps from API if available, otherwise default to 30 fps
          const hasValidFps = (typeof fps === 'number' && fps > 0);
          const usedFps = hasValidFps ? fps : SORA_DEFAULT_FPS;
          idToDuration.set(draftId, nFrames / usedFps);
          if (!hasValidFps && DEBUG.drafts) {
            dlog('drafts', `Draft ${draftId} duration calculated with default ${SORA_DEFAULT_FPS} fps (nFrames=${nFrames})`);
          }
        }

        // Extract prompt from creation_config
        const prompt = item?.creation_config?.prompt;
        if (prompt && typeof prompt === 'string') {
          idToPrompt.set(draftId, prompt);
        }

        // Extract downloadable_url
        const downloadUrl = item?.downloadable_url;
        if (downloadUrl && typeof downloadUrl === 'string') {
          idToDownloadUrl.set(draftId, downloadUrl);
        }

        // Extract content violation status
        if (item?.kind === 'sora_content_violation') {
          idToViolation.set(draftId, true);
        } else {
          idToViolation.set(draftId, false);
        }
      } catch (e) {
        console.error('[SoraUV] Error processing draft item:', e);
      }
    }

    // Trigger render to show all draft buttons and badges
    renderDraftButtons();
  }

  // == Observers & Lifecycle ==
  const mo = new MutationObserver(() => {
    if (mo._raf) cancelAnimationFrame(mo._raf);
    mo._raf = requestAnimationFrame(() => {
      renderBadges();
      renderDetailBadge();
      renderProfileImpact();
      renderBookmarkButtons();
      renderDraftButtons();
      updateControlsVisibility();
    });
  });

  function startObservers() {
    mo.observe(document.documentElement, { childList: true, subtree: true });
    renderBadges();
    renderDetailBadge();
    renderProfileImpact();
    renderBookmarkButtons();
    renderDraftButtons();
    updateControlsVisibility();
  }

  function resetFilterFreshSlate() {
    const newState = { filterIndex: 0, isGathering: false };
    setGatherState(newState);
    isGatheringActiveThisTab = false;
    const bar = controlBar || ensureControlBar();
    if (bar && typeof bar.updateFilterLabel === 'function') bar.updateFilterLabel();
    applyFilter();
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

  function forceStopGatherOnNavigation() {
    if (isGatheringActiveThisTab) console.log('Sora UV: Route change — stopping gather for this tab.');
    isGatheringActiveThisTab = false;
    stopGathering(false);
    setGatherState({ filterIndex: 0, isGathering: false });
    const bar = controlBar || ensureControlBar();
    if (bar && typeof bar.updateGatherState === 'function') bar.updateGatherState();
    if (bar && typeof bar.updateFilterLabel === 'function') bar.updateFilterLabel();
    if (analyzeActive) exitAnalyzeMode();
    applyFilter();
  }

  function updateControlsVisibility() {
    const bar = ensureControlBar();
    if (!bar) return;

    // Show control bar on drafts page for bookmarks feature, hide on other filter-hidden pages
    if (isFilterHiddenPage() && !isDrafts()) {
      bar.style.display = 'none';
      return;
    } else bar.style.display = 'flex';

    const filterBtn = bar.querySelector('[data-role="filter-btn"]');
    const gatherBtn = bar.querySelector('.sora-uv-gather-btn');
    const gatherControlsWrapper = bar.querySelector('.sora-uv-gather-controls-wrapper');
    const sliderContainer = bar.querySelector('.sora-uv-slider-container');

    // Hide Filter/Gather entirely during Analyze mode
    if (analyzeActive) {
      if (filterBtn) filterBtn.style.display = 'none';
      if (gatherBtn) gatherBtn.style.display = 'none';
      if (gatherControlsWrapper) gatherControlsWrapper.style.display = 'none';
      if (typeof bar.updateFilterLabel === 'function') bar.updateFilterLabel();

      // Position on the right (default)
      bar.style.top = '12px';
      bar.style.right = '12px';
      bar.style.left = 'auto';
      bar.style.transform = 'none';

      return; // nothing else to manage while analyzing
    }

    // Normal visibility rules (when NOT analyzing)
    if (isProfile() || isTopFeed()) {
      if (gatherBtn) gatherBtn.style.display = '';
      if (filterBtn) filterBtn.style.display = '';
      if (gatherControlsWrapper) gatherControlsWrapper.style.display = isGatheringActiveThisTab ? 'flex' : 'none';
      if (sliderContainer) sliderContainer.style.display = isProfile() ? 'flex' : 'none';
      bar.updateGatherState();

      // Position on the right (default)
      bar.style.top = '12px';
      bar.style.right = '12px';
      bar.style.left = 'auto';
      bar.style.transform = 'none';
    } else if (isDrafts()) {
      // On drafts page: hide Filter, Gather, and controls
      if (filterBtn) filterBtn.style.display = 'none';
      if (gatherBtn) gatherBtn.style.display = 'none';
      if (gatherControlsWrapper) gatherControlsWrapper.style.display = 'none';

      // Position centered horizontally to avoid overlapping native buttons on both sides
      bar.style.top = '12px';
      bar.style.left = '50%';
      bar.style.right = 'auto';
      bar.style.transform = 'translateX(-50%)';
    } else {
      if (gatherBtn) gatherBtn.style.display = 'none';
      if (gatherControlsWrapper) gatherControlsWrapper.style.display = 'none';
      if (isGatheringActiveThisTab) {
        isGatheringActiveThisTab = false;
        let sState = getGatherState();
        sState.isGathering = false;
        delete sState.refreshDeadline;
        setGatherState(sState);
        bar.updateGatherState();
      }
      if (filterBtn) filterBtn.style.display = '';

      // Position on the right (default)
      bar.style.top = '12px';
      bar.style.right = '12px';
      bar.style.left = 'auto';
      bar.style.transform = 'none';
    }

    // Analyze button only on Top feed
    if (analyzeBtn) analyzeBtn.style.display = isTopFeed() ? '' : 'none';

    // Bookmarks button only on Drafts page
    if (bookmarksBtn) bookmarksBtn.style.display = isDrafts() ? '' : 'none';

    if (typeof bar.updateFilterLabel === 'function') bar.updateFilterLabel();
  }

  function onRouteChange() {
    const rk = routeKey();
    const navigated = rk !== lastRouteKey;
    lastRouteKey = rk;

    if (navigated) {
      forceStopGatherOnNavigation();
      // Reset bookmarks filter on navigation
      bookmarksFilterState = 0;
      lastAppliedFilterState = -1;
      if (bookmarksBtn) {
        bookmarksBtn.setActive(false);
        bookmarksBtn.setLabel('Filter');
      }
      // Invalidate draft card cache on navigation
      cachedDraftCards = null;
      cachedDraftCardsCount = 0;
      processedDraftCardsCount = 0;
      processedDraftCards = new WeakSet(); // Reset to clear stale DOM references; navigation may remove/replace draft card elements, so previous references may no longer be valid
    }

    const bar = ensureControlBar();
    if (bar && typeof bar.updateFilterLabel === 'function') bar.updateFilterLabel();

    renderBadges();
    renderDetailBadge();
    renderProfileImpact();
    renderBookmarkButtons();
    renderDraftButtons();
    updateControlsVisibility();
  }

  // == Prefs ==
  function getPrefs() {
    try {
      return JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
    } catch {
      return {};
    }
  }
  function setPrefs(p) {
    localStorage.setItem(PREF_KEY, JSON.stringify(p));
  }

  // == Bookmarks (Drafts) ==
  function getBookmarks() {
    try {
      const data = JSON.parse(localStorage.getItem(BOOKMARKS_KEY) || '{}');
      return new Set(Array.isArray(data.ids) ? data.ids : []);
    } catch {
      return new Set();
    }
  }
  function setBookmarks(bookmarksSet) {
    localStorage.setItem(BOOKMARKS_KEY, JSON.stringify({ ids: Array.from(bookmarksSet) }));
  }
  function toggleBookmark(draftId) {
    const bookmarks = getBookmarks();
    if (bookmarks.has(draftId)) {
      bookmarks.delete(draftId);
    } else {
      bookmarks.add(draftId);
    }
    setBookmarks(bookmarks);
    return bookmarks.has(draftId);
  }
  function isBookmarked(draftId) {
    return getBookmarks().has(draftId);
  }

  function handleStorageChange(e) {
    if (e.key !== PREF_KEY) return;
    try {
      const newPrefs = JSON.parse(e.newValue || '{}');
      if (newPrefs.gatherSpeed == null) return;
      const slider = document.querySelector('.sora-uv-controls input[type="range"]');
      if (slider && slider.value !== newPrefs.gatherSpeed) slider.value = newPrefs.gatherSpeed;
      if (isGatheringActiveThisTab && !isTopFeed()) startGathering(true);
    } catch (err) {
      console.error('Sora UV: Error applying storage change.', err);
    }
  }

  function init() {
    dlog('feed', 'init');
    // NOTE: we do NOT want to reset session here; we want Gather to survive a refresh.
    installFetchSniffer();
    startObservers();
    onRouteChange();
    window.addEventListener('storage', handleStorageChange);

    // If this tab had Gather running pre-refresh, resume it AND start a fresh timer.
    const s = getGatherState() || {};
    if (s.isGathering) {
      isGatheringActiveThisTab = true;
      const bar = controlBar || ensureControlBar();
      if (bar && typeof bar.updateGatherState === 'function') bar.updateGatherState();
      // Force a new schedule after refresh so the loop "starts over"
      startGathering(true);
      if (!gatherCountdownIntervalId) gatherCountdownIntervalId = setInterval(updateCountdownDisplay, 1000);
    }
  }

  // Debug helper - only available when DEBUG.drafts is enabled
  if (DEBUG.drafts) {
    window.__soraDebug = {
      idToDuration,
      idToPrompt,
      idToDownloadUrl,
      idToViolation,
      renderDraftButtons,
      selectAllDrafts,
      extractDraftIdFromCard,
      isDrafts,
      processDraftsJson,
      getBookmarks,
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
