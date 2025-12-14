/*
 * Copyright (c) 2025 Will (fancyson-ai), Topher (cameoed), Skye (thecosmicskye)
 * Licensed under the MIT License. See the LICENSE file for details.
 *
 * SORA CREATOR TOOLS - Feature Overview:
 *
 * 1. FEED ENHANCEMENTS:
 *    - Injects status badges into post cards showing age and engagement metrics.
 *    - Color-coded badges: Red (<1h) to Yellow (18h) gradient indicating post "hotness".
 *    - Daily milestones: Green badge with 📝 icon indicating if a post was made around this time
 *    - Time Filters: Button to select time-bound post visibility (<3h, <6h... <21h).
 *
 * 2. DATA GATHERING & ANALYSIS:
 *    - "Gather" Mode: Auto-scrolls and refreshes profiles/feeds to scrape data.
 *    - "Analyze" Mode (Top Feed): Overlay table sorting posts by Views, Likes, etc.
 *
 * 3. CREATOR TOOLS:
 *    - Drafts: Bookmarking system, bulk filtering, and download button injection.
 *    - Characters: Tracks cameo counts, likes, and creation dates.
 *
 * 4. UX IMPROVEMENTS:
 *    - Auto-scroll capabilities for hands-free data collection.
 */

(function () {
  'use strict';

  try {
  } catch {}

  // Debug toggles
  const DEBUG = { feed: false, thumbs: false, analyze: false, drafts: false };
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
  const TASK_TO_DRAFT_KEY = 'SORA_UV_TASK_TO_DRAFT_V1'; // task_id -> source draft ID for draft remixes
  const FEED_RE = /\/(backend\/project_[a-z]+\/)?(feed|profile_feed|profile\/)/i;
  const DRAFTS_RE = /\/(backend\/project_[a-z]+\/)?profile\/drafts($|\/|\?)/i;
  const CHARACTERS_RE = /\/(backend\/project_[a-z]+\/)?profile\/[^/]+\/characters($|\?)/i;
  const NF_CREATE_RE = /\/backend\/nf\/create/i;
  const NF_PENDING_V2_RE = /\/backend\/nf\/pending\/v2/i;
  const POST_DETAIL_RE = /\/(backend\/project_[a-z]+\/)?posts?\/[^/]+(\/(tree|children|ancestors|remix_posts|remixes))?(\?|$)/i;

  // Includes <21h (1260 minutes) plus a final special filter
  const FILTER_STEPS_MIN = [null, 180, 360, 720, 900, 1080, 1260, 'no_remixes'];
  const FILTER_LABELS = ['Filter', '<3 hours', '<6 hours', '<12 hours', '<15 hours', '<18 hours', '<21 hours', 'No Remixes'];
  const ALLOWED_VIDEO_EXTENSIONS = ['mp4', 'mov', 'webm']; // Sora-supported video formats

  // Debug toggle for characters
  DEBUG.characters = false;

  // == State Maps ==
  const idToUnique = new Map();
  const idToLikes = new Map();
  const idToViews = new Map();
  const idToComments = new Map();
  const idToRemixes = new Map();
  const idToCameos = new Map(); // Array of cameo usernames
  const idToMeta = new Map(); // { ageMin, userHandle }
  const idToDuration = new Map(); // Draft duration in seconds
  const idToDimensions = new Map(); // Video dimensions { width, height }
  const idToPrompt = new Map(); // Draft prompt text
  const idToDownloadUrl = new Map(); // Draft downloadable URL
  const idToViolation = new Map(); // Draft content violation status
  const idToRemixTarget = new Map(); // Draft remix target post ID (if it's a remix of a post)
  const idToRemixTargetDraft = new Map(); // Draft remix target draft ID (if it's a remix of a draft)
  const taskToSourceDraft = new Map(); // task_id -> source draft gen ID (for draft remix tracking)
  const taskToPrompt = new Map(); // task_id -> prompt (from pending v2)
  const charToCameoCount = new Map(); // Character cameo count
  const charToLikesCount = new Map(); // Character likes received count
  const charToCanCameo = new Map(); // Character can_cameo permission
  const charToCreatedAt = new Map(); // Character created_at timestamp
  const usernameToUserId = new Map(); // Map username to user_id for character lookup
  const lockedPostIds = new Set(); // Post IDs whose data should not be overwritten (currently viewed posts)
  const processedPostDetailIds = new Set(); // Post detail responses already applied (avoid late duplicate overwrites)
  const pendingPostDetailIds = new Set(); // Post IDs currently being detail-fetched
  let lastPostDetailUrlTemplate = null; // Remember a detail URL pattern to reuse across posts
  const charToOriginalIndex = new Map(); // Store original order from API
  let charGlobalIndexCounter = 0; // Global counter for character order across all API calls

  // == Draft UI Constants ==
  const DRAFT_BUTTON_SIZE = 24; // px
  const DRAFT_BUTTON_MARGIN = 6; // px from edge
  const DRAFT_BUTTON_SPACING = 4; // px between buttons
  const SORA_DEFAULT_FPS = 30; // Sora standard framerate (fallback if API doesn't provide fps)

  // == UI State ==
  let controlBar = null;
  let gatherTimerEl = null;
  let detailBadgeEl = null;
  let detailBadgeRetryInterval = null;
  let characterSortBtn = null;
  let characterSortMode = 'date'; // 'date', 'likes', 'cameos', 'likesPerDay'
  let suppressDetailBadgeRender = false; // Flag to prevent renderDetailBadge during bulk processing

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
  let analyzeCameoFilterWrap = null;
  let analyzeCameoSelectEl = null;
  let analyzeCameoFilterUsername = null;

  // Time window (hours) for slicing rows
  const ANALYZE_WINDOW_KEY = 'SORA_UV_ANALYZE_WINDOW_H';
  let analyzeWindowHours = Math.min(24, Math.max(1, Number(localStorage.getItem(ANALYZE_WINDOW_KEY) || 24)));
  const ANALYZE_RUN_MS = 6500; // 6.5 seconds

  // Bookmarks (Drafts page only)
  // 0 = show all, 1 = show bookmarked only, 2 = show unbookmarked only, 3 = violations only
  let bookmarksFilterState = 0;
  let bookmarksBtn = null;

  // Dashboard injection perf guards
  let dashboardBtnEl = null;
  let dashboardInjectRafId = null;
  let dashboardInjectRetryId = null;
  let dashboardInjectLastAttemptMs = 0;
  const DASHBOARD_INJECT_THROTTLE_MS = 1500;

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

  const ESC_MAP = { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC_MAP[c] || c);

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

  function fmtAgeMinPill(ageMin) {
    if (!Number.isFinite(ageMin)) return fmtAgeMin(ageMin);
    const mTotal = Math.max(0, Math.floor(ageMin));
    if (mTotal <= 1) return 'Just now';
    return fmtAgeMin(ageMin);
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
  const isDraftDetail = () => location.pathname === '/d' || location.pathname.startsWith('/d/');

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
      // API uses cameo_profiles array
      const arr = Array.isArray(p?.cameo_profiles) ? p.cameo_profiles : null;
      if (arr) return arr.length;
    } catch {}
    return null;
  };
  const getCameoUsernames = (item) => {
    try {
      const usernamesSet = new Set();
      
      // Helper function to extract usernames from a post object
      const extractFromPost = (postObj) => {
        if (!postObj || typeof postObj !== 'object') return;
        // API uses cameo_profiles array - each item is a profile object with username
        const arr = Array.isArray(postObj?.cameo_profiles) ? postObj.cameo_profiles : null;
        if (arr && arr.length > 0) {
          for (const profile of arr) {
            if (profile?.username && typeof profile.username === 'string') {
              usernamesSet.add(profile.username);
            }
          }
        }
      };
      
      // Extract from main post
      const p = item?.post ?? item;
      extractFromPost(p);
      
      // NOTE: Do NOT extract from remix_posts - those are child remixes with their own cameos
      // We only want cameos that are actually IN this post
      
      // Extract from nested ancestors.items array (ancestors is an object with items array)
      if (p?.ancestors) {
        const ancestorItems = Array.isArray(p.ancestors.items) ? p.ancestors.items 
                            : Array.isArray(p.ancestors) ? p.ancestors 
                            : null;
        if (ancestorItems) {
          for (const ancestorItem of ancestorItems) {
            const ancestorPost = ancestorItem?.post ?? ancestorItem;
            extractFromPost(ancestorPost);
          }
        }
      }
      
      // Also check if ancestors are at the item level (but NOT remix_posts - see note above)
      if (item?.ancestors) {
        const ancestorItems = Array.isArray(item.ancestors.items) ? item.ancestors.items 
                            : Array.isArray(item.ancestors) ? item.ancestors 
                            : null;
        if (ancestorItems) {
          for (const ancestorItem of ancestorItems) {
            const ancestorPost = ancestorItem?.post ?? ancestorItem;
            extractFromPost(ancestorPost);
          }
        }
      }
      
      return usernamesSet.size > 0 ? Array.from(usernamesSet) : null;
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

    // Guard against comment/reply objects: they often carry a parent/root post id
    // (s_...) plus text, but are not posts themselves. Deep search would otherwise
    // pick up the parent id and we'd treat the comment like a post.
    try {
      const p = item?.post ?? item ?? {};
      const ownId = p?.id || item?.id || null;
      const refId =
        p?.post_id ||
        p?.parent_post_id ||
        p?.root_post_id ||
        item?.post_id ||
        item?.parent_post_id ||
        item?.root_post_id ||
        null;
      const hasOwnSId = typeof ownId === 'string' && /^s_[A-Za-z0-9]+$/i.test(ownId);
      const hasRefSId = typeof refId === 'string' && /^s_[A-Za-z0-9]+$/i.test(refId);
      const hasMediaOrMetrics =
        (Array.isArray(p?.attachments) && p.attachments.length > 0) ||
        typeof p?.preview_image_url === 'string' ||
        p?.unique_view_count != null ||
        p?.view_count != null ||
        p?.like_count != null;
      if (!hasOwnSId && hasRefSId && !hasMediaOrMetrics) return null;
    } catch {}

    const deep = findSIdDeep(item);
    if (!deep) return null;
    try {
      const p = item?.post ?? item ?? {};
      const ownId = p?.id || item?.id || null;
      const hasOwnSId = typeof ownId === 'string' && /^s_[A-Za-z0-9]+$/i.test(ownId);
      if (!hasOwnSId) {
        const refs = [
          p?.post_id,
          p?.parent_post_id,
          p?.root_post_id,
          p?.source_post_id,
          p?.remix_target_post_id,
          item?.post_id,
          item?.parent_post_id,
          item?.root_post_id,
          item?.source_post_id,
          item?.remix_target_post_id,
        ];
        if (refs.some((r) => typeof r === 'string' && r === deep)) return null;
      }
    } catch {}
    return normalizeId(deep);
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
  function isBadCardContainer(el) {
    try {
      if (!el || el === document.body || el === document.documentElement) return true;
      const style = getComputedStyle(el);
      if (style.position === 'fixed' || style.position === 'sticky') return true;
      // Avoid nav/sidebars/toolbars that sometimes contain post links.
      const role = el.getAttribute?.('role');
      if (role === 'navigation' || role === 'menubar' || role === 'toolbar') return true;
      return false;
    } catch {
      return false;
    }
  }

  function closestPostCardFromAnchor(a) {
    if (!a) return null;
    let el = a;
    let steps = 0;
    while (el && steps < 10) {
      if (el.tagName === 'ARTICLE' || el.getAttribute?.('role') === 'article') {
        if (!isBadCardContainer(el)) return el;
      }
      const cls = typeof el.className === 'string' ? el.className : '';
      const hasMedia = !!el.querySelector?.('video, img, canvas');
      const looksCardy =
        hasMedia &&
        (cls.includes('rounded') || cls.includes('overflow-hidden') || cls.includes('shadow') || cls.includes('group'));
      if (looksCardy && !isBadCardContainer(el)) return el;
      el = el.parentElement;
      steps++;
    }
    return null;
  }

  const selectAllCards = () =>
    Array.from(document.querySelectorAll('a[href^="/p/s_"]'))
      .filter((a) => {
        // Exclude posts inside Leaderboard dialog/popover
        const inDialog = a.closest('[role="dialog"]');
        return !inDialog;
      })
      .map((a) => closestPostCardFromAnchor(a) || a.closest('article,section,div') || a)
      .filter((el) => !isBadCardContainer(el));

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

  function bestDraftDownloadUrl(item) {
    if (!item || typeof item !== 'object') return null;
    const source = item?.encodings?.source?.path;
    const sourceWm = item?.encodings?.source_wm?.path;
    const legacyDownloadUrl = item?.downloadable_url;
    const legacyNoWm = item?.download_urls?.no_watermark;
    const legacyWm = item?.download_urls?.watermark;
    return [source, sourceWm, legacyDownloadUrl, legacyNoWm, legacyWm].find((u) => typeof u === 'string' && u);
  }

  function applyBestDownloadUrlToItem(item) {
    const downloadUrl = bestDraftDownloadUrl(item);
    if (!downloadUrl) return null;

    // Normalize primary field for downstream consumers (including native Sora)
    item.downloadable_url = downloadUrl;
    item.url = downloadUrl;

    // Normalize download_urls collection while preserving existing values
    const downloadUrls = { ...(item.download_urls || {}) };
    if (!downloadUrls.no_watermark) downloadUrls.no_watermark = downloadUrl;
    if (!downloadUrls.watermark) {
      const wm = item?.encodings?.source_wm?.path;
      if (wm) downloadUrls.watermark = wm;
    }
    item.download_urls = downloadUrls;

    return downloadUrl;
  }

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
      lineHeight: '1.2',
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
    const DELAY_MS = 750;
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

  function ensureRedoButton(draftCard, draftId) {
    if (!draftId) return null;

    let redoBtn = draftCard.querySelector('.sora-uv-redo-btn');
    if (!redoBtn) {
      if (getComputedStyle(draftCard).position === 'static') draftCard.style.position = 'relative';

      redoBtn = document.createElement('button');
      redoBtn.className = 'sora-uv-redo-btn';
      redoBtn.type = 'button';
      redoBtn.setAttribute('aria-label', 'Redo generation');
      Object.assign(redoBtn.style, {
        position: 'absolute',
        bottom: `${DRAFT_BUTTON_MARGIN}px`,
        left: `${DRAFT_BUTTON_MARGIN + (DRAFT_BUTTON_SIZE + DRAFT_BUTTON_SPACING) * 3}px`,
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

      // Redo/refresh icon SVG
      redoBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="pointer-events: none;">
        <path d="M21 2v6h-6"></path>
        <path d="M3 12a9 9 0 0 1 15-6.7L21 8"></path>
        <path d="M3 22v-6h6"></path>
        <path d="M21 12a9 9 0 0 1-15 6.7L3 16"></path>
      </svg>`;

      redoBtn.addEventListener('mouseenter', () => {
        if (!redoBtn.disabled) {
          redoBtn.style.background = 'rgba(0,0,0,0.9)';
          redoBtn.style.transform = 'scale(1.05)';
        }
      });
      redoBtn.addEventListener('mouseleave', () => {
        redoBtn.style.background = 'rgba(0,0,0,0.75)';
        redoBtn.style.transform = 'scale(1)';
      });

      redoBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();

        const prompt = idToPrompt.get(draftId);
        if (!prompt) return;

        const remixTargetPostId = idToRemixTarget.get(draftId);
        const remixTargetDraftId = idToRemixTargetDraft.get(draftId);

        if (remixTargetPostId) {
          // This is a remix of a post - navigate to the post remix page
          const remixUrl = `https://sora.chatgpt.com/p/${remixTargetPostId}?remix=`;
          sessionStorage.setItem('SORA_UV_REDO_PROMPT', prompt);
          window.location.href = remixUrl;
        } else if (remixTargetDraftId) {
          // This is a remix of a draft - navigate to the draft remix page
          const remixUrl = `https://sora.chatgpt.com/d/${remixTargetDraftId}?remix=`;
          sessionStorage.setItem('SORA_UV_REDO_PROMPT', prompt);
          window.location.href = remixUrl;
        } else {
          // Not a remix - fill in the prompt directly on the drafts page textarea
          const textarea = document.querySelector('textarea[placeholder="Describe your video..."]');
          if (textarea) {
            // Set the value and dispatch events to trigger React state updates
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
            nativeInputValueSetter.call(textarea, prompt);
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            textarea.dispatchEvent(new Event('change', { bubbles: true }));

            // Focus the textarea
            textarea.focus();

            // Scroll to the textarea
            textarea.scrollIntoView({ behavior: 'smooth', block: 'center' });

            // Show brief feedback
            const originalColor = redoBtn.style.color;
            redoBtn.style.color = '#4ade80';
            setTimeout(() => {
              redoBtn.style.color = originalColor;
            }, 1500);
          } else {
            console.error('[SoraUV] Could not find textarea to fill prompt');
          }
        }
      });

      draftCard.appendChild(redoBtn);
    }

    // Update button state based on whether prompt exists
    const hasPrompt = idToPrompt.has(draftId);
    redoBtn.disabled = !hasPrompt;
    redoBtn.style.opacity = hasPrompt ? '1' : '0.4';
    redoBtn.style.cursor = hasPrompt ? 'pointer' : 'not-allowed';

    return redoBtn;
  }

  function ensureRemixButton(draftCard, draftId) {
    if (!draftId) return null;

    let remixBtn = draftCard.querySelector('.sora-uv-remix-btn');
    if (!remixBtn) {
      if (getComputedStyle(draftCard).position === 'static') draftCard.style.position = 'relative';

      remixBtn = document.createElement('button');
      remixBtn.className = 'sora-uv-remix-btn';
      remixBtn.type = 'button';
      remixBtn.setAttribute('aria-label', 'Remix this draft');
      Object.assign(remixBtn.style, {
        position: 'absolute',
        bottom: `${DRAFT_BUTTON_MARGIN}px`,
        left: `${DRAFT_BUTTON_MARGIN + (DRAFT_BUTTON_SIZE + DRAFT_BUTTON_SPACING) * 4}px`,
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

      // Remix icon SVG (Sora's official remix icon)
      remixBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" fill="none" viewBox="0 0 20 20" style="pointer-events: none;">
        <circle cx="10" cy="10" r="7" stroke="currentColor" stroke-width="1.556"></circle>
        <path stroke="currentColor" stroke-linecap="round" stroke-width="1.556" d="M11.945 10c0-4.667-9.723-5.833-8.75 1.556"></path>
        <path stroke="currentColor" stroke-linecap="round" stroke-width="1.556" d="M8.055 10c0 4.667 9.723 5.833 8.75-1.556"></path>
      </svg>`;

      remixBtn.addEventListener('mouseenter', () => {
        remixBtn.style.background = 'rgba(0,0,0,0.9)';
        remixBtn.style.transform = 'scale(1.05)';
      });
      remixBtn.addEventListener('mouseleave', () => {
        remixBtn.style.background = 'rgba(0,0,0,0.75)';
        remixBtn.style.transform = 'scale(1)';
      });

      remixBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();

        // Store the prompt if available so it auto-fills on the remix page
        const prompt = idToPrompt.get(draftId);
        if (prompt) {
          sessionStorage.setItem('SORA_UV_REDO_PROMPT', prompt);
        }

        // Navigate to the remix page for this draft
        const remixUrl = `https://sora.chatgpt.com/d/${draftId}?remix=`;
        window.location.href = remixUrl;
      });

      draftCard.appendChild(remixBtn);
    }

    return remixBtn;
  }

  // Check for pending redo prompt on page load (for remix navigation)
  function checkPendingRedoPrompt() {
    const pendingPrompt = sessionStorage.getItem('SORA_UV_REDO_PROMPT');
    if (!pendingPrompt) return;

    // Clear it immediately to prevent re-triggering
    sessionStorage.removeItem('SORA_UV_REDO_PROMPT');

    // Wait for page to load and textarea to be available
    const attemptFill = (retries = 0) => {
      const textarea = document.querySelector('textarea[placeholder="Describe changes..."]');
      if (textarea) {
        // Set the value and dispatch events to trigger React state updates
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        nativeInputValueSetter.call(textarea, pendingPrompt);
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.dispatchEvent(new Event('change', { bubbles: true }));
        textarea.focus();
        textarea.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } else if (retries < 20) {
        // Retry up to 20 times (2 seconds total)
        setTimeout(() => attemptFill(retries + 1), 100);
      } else {
        console.error('[SoraUV] Could not find remix textarea after navigation');
      }
    };

    // Start attempting after a short delay for page render
    setTimeout(() => attemptFill(), 300);
  }

  function createPill(parent, text, tooltipText, tooltipEnabled = true) {
    if (!text) return null;
    const pill = document.createElement('span');
    pill.className = 'sora-uv-pill';
    Object.assign(pill.style, {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '5px 8px',
      borderRadius: '9999px',
      background: 'rgba(37,37,37,0.7)',
      color: '#fff',
      fontSize: '13px',
      fontWeight: '700',
      lineHeight: '1',
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
    if (likes >= 25) return colorForAgeMin(ageMin);
    return null;
  }
  function badgeEmojiFor(id, meta) {
    if (!meta) return '';
    const ageMin = meta.ageMin;
    const likes = idToLikes.get(id) ?? 0;
    if (likes >= 50 && Number.isFinite(ageMin) && ageMin < 60) return '🔥🔥🔥🔥🔥';
    if (isNearWholeDay(ageMin)) return '📝';
    if (likes >= 25) return fireForAge(ageMin);
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
    const totalViews = idToViews.get(id);
    const irRaw = interactionRate(idToLikes.get(id), idToComments.get(id), idToUnique.get(id)); // already like "12.3%"
    const rrRaw = remixRate(idToLikes.get(id), idToRemixes.get(id)); // "12.34" (no %)

    // Normalize IR/RR displays
    const irDisp = irRaw ? (parseFloat(irRaw) === 0 ? '0%' : irRaw) : null;
    const rrDisp =
      rrRaw == null ? null : +rrRaw === 0 ? '0%' : (rrRaw.endsWith('.00') ? rrRaw.slice(0, -3) : rrRaw) + '%';

    // Impact Score
    let impactStr = null;
    if (totalViews != null && uv != null && uv > 0) {
      const ratio = totalViews / uv;
      impactStr = `${ratio.toFixed(2)}`;
    }

    // Duration
    const duration = idToDuration.get(id);
    const durationStr = duration ? formatDuration(duration) : null;

    const viewsStr = uv != null ? `👀 ${fmt(uv)}` : null;
    const irStr = irDisp ? `${irDisp} IR` : null;
    const rrStr = rrDisp ? `${rrDisp} RR` : null;
    const ageStr = Number.isFinite(ageMin) ? fmtAgeMinPill(ageMin) : null;
    const emojiStr = badgeEmojiFor(id, meta);
    const timeEmojiStr = (ageStr || emojiStr) ? [ageStr || '', emojiStr || ''].filter(Boolean).join(' ') : null;

    const bg = badgeBgFor(id, meta);
    badge.style.background = 'transparent';
    const pillBg = bg || 'rgba(37,37,37,0.7)';

    const newKey = JSON.stringify([durationStr, viewsStr, irStr, rrStr, impactStr, timeEmojiStr, pillBg]);
    if (badge.dataset.key === newKey) {
      badge.style.boxShadow = 'none';
      return;
    }
    badge.dataset.key = newKey;

    badge.innerHTML = '';
    if (viewsStr) {
      let tooltip = `${fmtInt(uv)} Unique Views`;
      if (impactStr) {
        tooltip += ` – ${fmtInt(totalViews)} Total Views – ${impactStr} Views Per Person`;
      }
      const el = createPill(badge, viewsStr, tooltip, true);
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
    if (durationStr) {
      const dims = idToDimensions.get(id);
      let modelName = '';
      if (dims) {
        const w = dims.width;
        const h = dims.height;
        // Check for Sora 2 (352x640 or 640x352)
        if ((w === 352 && h === 640) || (w === 640 && h === 352)) {
          modelName = ' Sora 2';
        }
        // Check for Sora 2 Pro (512x896 or 896x512)
        else if ((w === 512 && h === 896) || (w === 896 && h === 512)) {
          modelName = ' Sora 2 Pro';
        }
      }
      const tooltip = `${durationStr}${modelName} video`;
      const el = createPill(badge, `${durationStr}`, tooltip, true);
      el.style.background = pillBg;
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
    
    // Round to nearest whole second if within 0.2s of a whole number
    const nearestWhole = Math.round(seconds);
    if (Math.abs(seconds - nearestWhole) < 0.2) {
      seconds = nearestWhole;
    }
    
    // Round to 1 decimal place
    const rounded = Math.round(seconds * 10) / 10;
    
    if (rounded < 60) {
      // For under 60 seconds, show as whole number
      return `${Math.round(rounded)}s`;
    }
    
    // For 60+ seconds, show minutes (keep existing logic)
    const s = Math.round(seconds);
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
      ensureRedoButton(draftCard, draftId);
      ensureRemixButton(draftCard, draftId);
      processedDraftCards.add(draftCard);
      processedDraftCardsCount++; // Increment count for early exit optimization
    }
  }

  // == Detail badge (post page only) ==
  
  function teardownDetailBadge() {
    if (detailBadgeRetryInterval) {
      clearInterval(detailBadgeRetryInterval);
      detailBadgeRetryInterval = null;
    }
    if (detailBadgeEl && document.contains(detailBadgeEl)) {
      try {
        detailBadgeEl.remove();
      } catch {}
    }
    detailBadgeEl = null;
  }

  // This function targets the visible video container
  function findDetailBadgeTarget() {
    // We look for the specific structure of the detail modal/page
    const selector = '.relative.h-full.w-full.origin-top > .absolute.overflow-hidden.rounded-xl';
    
    // Find ALL matching wrappers
    const wrappers = Array.from(document.querySelectorAll(selector));
    
    if (wrappers.length === 0) return null;
    
    let bestWrapper = null;
    let bestDist = Infinity;
    const viewportCenterY = window.innerHeight / 2;
    
    for (const wrapper of wrappers) {
      const style = window.getComputedStyle(wrapper);
      
      // Check for basic visibility
      if ((style.opacity === '1' || parseFloat(style.opacity) > 0.5) && style.display !== 'none' && style.visibility !== 'hidden') {
        
        // Find the one closest to the center of the viewport
        const rect = wrapper.getBoundingClientRect();
        
        // Skip if completely out of view
        if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
        
        const wrapperCenterY = rect.top + rect.height / 2;
        const dist = Math.abs(viewportCenterY - wrapperCenterY);
        
        if (dist < bestDist) {
          bestDist = dist;
          bestWrapper = wrapper;
        }
      }
    }
    
    if (!bestWrapper) {
      // Fallback: just take the first visible one if none are "in view" (maybe loading?)
      for (const wrapper of wrappers) {
         const style = window.getComputedStyle(wrapper);
         if ((style.opacity === '1' || parseFloat(style.opacity) > 0.5) && style.display !== 'none' && style.visibility !== 'hidden') {
           bestWrapper = wrapper;
           break;
         }
      }
    }
    
    if (!bestWrapper) return null;
    
    const visibleVideoWrapper = bestWrapper;
    
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


  // Function to fetch post data when visiting a post page directly
  async function fetchPostDataIfNeeded(opts = {}) {
    const forceDetail = !!opts.forceDetail;
    const sid = opts.sidOverride || currentSIdFromURL();
    if (!sid) return;
    if (!isPost() && !opts.sidOverride) return;

    // If we already have full data, no work.
    if (!forceDetail && detailBadgeDataReady(sid)) return;
    
    // Try to load from storage first
    try {
      const requestId = 'post_data_' + Date.now();
      window.postMessage({ __sora_uv__: true, type: 'metrics_request', req: requestId }, '*');
      
      // Wait for response
      const responsePromise = new Promise((resolve) => {
        const handler = (ev) => {
          const d = ev?.data;
          if (d?.__sora_uv__ === true && d?.type === 'metrics_response' && d?.req === requestId) {
            window.removeEventListener('message', handler);
            resolve(d.metrics);
          }
        };
        window.addEventListener('message', handler);
        // Timeout after 1 second
        setTimeout(() => {
          window.removeEventListener('message', handler);
          resolve(null);
        }, 1000);
      });
      
      const metrics = await responsePromise;
      if (metrics?.users) {
        // Helper function to load post data from a post object
        const loadPostData = (post, postId) => {
          const latest = __sorauv_latestSnapshot(post.snapshots);
          if (latest) {
            // Only set values if they're not null/undefined
            if (latest.uv != null) idToUnique.set(postId, latest.uv);
            if (latest.likes != null) idToLikes.set(postId, latest.likes);
            if (latest.views != null) idToViews.set(postId, latest.views);
            if (latest.comments != null) idToComments.set(postId, latest.comments);
            // Remixes might be stored as remix_count or remixes
            const remixes = Number(latest.remix_count ?? latest.remixes ?? 0);
            if (!isNaN(remixes)) idToRemixes.set(postId, remixes);
            
            // Load duration from snapshot if available
            if (latest.duration != null && typeof latest.duration === 'number') {
              idToDuration.set(postId, latest.duration);
            }
            
            // Load dimensions from snapshot if available
            if (latest.width != null && latest.height != null) {
              idToDimensions.set(postId, { width: latest.width, height: latest.height });
            }
            
            // Calculate age from post creation time, not snapshot time
            const tPost = __sorauv_getPostTimeStrict(post);
            if (tPost > 0) {
              // __sorauv_getPostTimeStrict returns milliseconds, __sorauv_toTs handles conversion
              const ageMin = Math.max(0, (Date.now() - tPost) / (1000 * 60));
              idToMeta.set(postId, { ageMin });
            } else if (latest.t) {
              // Fallback: use snapshot time if post_time not available
              // This is less accurate but better than nothing
              const ageMin = Math.max(0, (Date.now() - latest.t) / (1000 * 60));
              idToMeta.set(postId, { ageMin });
            }
          }
          
          // Also try to extract duration and dimensions from post level if not in latest snapshot
          if (!idToDuration.has(postId) && post.duration != null && typeof post.duration === 'number') {
            idToDuration.set(postId, post.duration);
          }
          
          if (!idToDimensions.has(postId) && post.width != null && post.height != null) {
            idToDimensions.set(postId, { width: post.width, height: post.height });
          }
          
          // Fallback: check all snapshots for duration and dimensions
          if (!idToDuration.has(postId) && post.snapshots && post.snapshots.length > 0) {
            for (const snap of post.snapshots) {
              if (snap.duration != null && typeof snap.duration === 'number') {
                idToDuration.set(postId, snap.duration);
                break;
              }
            }
          }
          
          if (!idToDimensions.has(postId) && post.snapshots && post.snapshots.length > 0) {
            for (const snap of post.snapshots) {
              if (snap.width != null && snap.height != null) {
                idToDimensions.set(postId, { width: snap.width, height: snap.height });
                break;
              }
            }
          }
          
          return true;
        };
        
        // Find the post in stored metrics and populate Maps
        for (const user of Object.values(metrics.users)) {
          if (user.posts) {
            // First check if the post is at the top level
            if (user.posts[sid]) {
              loadPostData(user.posts[sid], sid);
              return; // Found and loaded
            }
            
            // If not found at top level, search through remix_posts of all posts
            for (const [parentId, parentPost] of Object.entries(user.posts)) {
              // remix_posts can be either an array OR an object with items array
              const remixPostsData = parentPost.remix_posts;
              const remixPosts = Array.isArray(remixPostsData) 
                ? remixPostsData 
                : (Array.isArray(remixPostsData?.items) ? remixPostsData.items : []);
              
              if (remixPosts.length > 0) {
                for (const remixItem of remixPosts) {
                  // Remix items may have nested post object or be the post itself
                  const remixPost = remixItem?.post || remixItem;
                  // Check if this remix post matches our target ID
                  const remixId = remixPost.id || remixPost.post_id;
                  if (remixId === sid) {
                    // Pass the actual post object, not the wrapper
                    loadPostData(remixPost, sid);
                    return; // Found and loaded remix
                  }
                }
              }
            }
          }
        }
      }
    } catch (e) {
      dlog('feed', 'Error loading post data from storage', e);
    }

    if (detailBadgeDataReady(sid)) return;
    
    // If not in storage, try fetching from feed endpoints
    // Try Top feed first (most likely to have the post)
    try {
      const feedUrl = `${location.origin}/explore?feed=top`;
      const response = await fetch(feedUrl, {
        method: 'GET',
        credentials: 'include',
        headers: { 'Accept': 'application/json' },
      });
      if (response.ok) {
        const json = await response.json();
        processFeedJson(json);
        // Check if we now have valid data (not just that the key exists)
        if (detailBadgeDataReady(sid)) return;
      }
    } catch (e) {
      dlog('feed', 'Error fetching Top feed for post data', e);
    }

    // As a last resort (or when forced), hit the detail endpoint once.
    if (forceDetail || !processedPostDetailIds.has(sid)) {
      fetchPostDetailOnce(sid);
    }
  }

  function detailBadgeDataReady(sid) {
    if (!sid) return false;
    return (
      idToUnique.get(sid) != null &&
      idToLikes.get(sid) != null &&
      idToViews.get(sid) != null &&
      idToRemixes.get(sid) != null &&
      idToMeta.get(sid) != null
    );
  }

  function detailBadgeCommentsReady(sid) {
    if (!sid) return false;
    return idToComments.get(sid) != null;
  }

  function renderDetailLoading(el) {
    if (!el) return;
    if (el.dataset.key === 'loading') return;
    el.dataset.key = 'loading';
    el.innerHTML = '';
    try {
      const pill = createPill(el, 'Loading...', null, false);
      if (pill) pill.style.background = 'rgba(37,37,37,0.7)';
    } catch {}
  }

  function rememberPostDetailTemplate(url) {
    if (typeof url !== 'string') return;
    try {
      const m = url.match(/\/posts?\/(s_[A-Za-z0-9]+)/i);
      if (!m) return;
      const id = m[1];
      lastPostDetailUrlTemplate = url.replace(id, '{sid}');
    } catch {}
  }

  function buildPostDetailUrls(sid) {
    const urls = [];
    if (lastPostDetailUrlTemplate && lastPostDetailUrlTemplate.includes('{sid}')) {
      urls.push(lastPostDetailUrlTemplate.replace('{sid}', sid));
    }
    // Fallback guesses; keep small and same-origin.
    urls.push(`${location.origin}/posts/${sid}/tree`);
    urls.push(`${location.origin}/backend/posts/${sid}/tree`);
    return Array.from(new Set(urls));
  }

  async function fetchPostDetailOnce(sid) {
    if (!sid) return;
    if (processedPostDetailIds.has(sid) || pendingPostDetailIds.has(sid)) return;
    pendingPostDetailIds.add(sid);
    try {
      const urls = buildPostDetailUrls(sid);
      for (const url of urls) {
        try {
          const res = await fetch(url, {
            method: 'GET',
            credentials: 'include',
            headers: { 'Accept': 'application/json' },
          });
          if (!res.ok) continue;
          const json = await res.json();
          if (!looksLikePostDetail(json)) continue;
          processPostDetailJson(json);
          // processPostDetailJson will mark processed for the current post.
          if (processedPostDetailIds.has(sid)) break;
        } catch {}
      }
    } finally {
      pendingPostDetailIds.delete(sid);
    }
  }

  function renderDetailBadge() {
    if (!isPost()) {
      teardownDetailBadge();
      return;
    }

    const el = ensureDetailBadgeContainer();
    
    // If no container found, or if we have one but want to clear it (e.g. navigated away)
    // We check sid later.
    if (!el) {
      if (detailBadgeEl) {
        detailBadgeEl.remove();
        detailBadgeEl = null;
      }
      return;
    }

    const sid = currentSIdFromURL();
    if (!sid) {
      // If we have a container but no SID (e.g. modal open but URL not updated yet?),
      // we can't render data. Just clear it.
      el.innerHTML = '';
      return;
    }
    
    dlog('feed', 'renderDetailBadge for post', { 
      sid, 
      uv: idToUnique.get(sid), 
      likes: idToLikes.get(sid),
      remixes: idToRemixes.get(sid),
      isLocked: lockedPostIds.has(sid)
    });

    // If we haven't processed the current post's detail payload yet, avoid showing
    // placeholder/stale pills (e.g., zeros from ancestor/feed packets) until the
    // dedicated post detail fetch lands.
    const needsDetail = isPost() && !processedPostDetailIds.has(sid) && !detailBadgeDataReady(sid);
    if (needsDetail) {
      if (detailBadgeRetryInterval) {
        clearInterval(detailBadgeRetryInterval);
        detailBadgeRetryInterval = null;
      }
      fetchPostDataIfNeeded({ forceDetail: true, sidOverride: sid });
      renderDetailLoading(el);
      return;
    }

    // If we don't have valid data, try to fetch it
    const dataReady = detailBadgeDataReady(sid);
    if (!dataReady) {
      // Clear any existing retry interval
      if (detailBadgeRetryInterval) {
        clearInterval(detailBadgeRetryInterval);
        detailBadgeRetryInterval = null;
      }
      
      // Try fetching data
      fetchPostDataIfNeeded();
      
      // Set up retries to check if data becomes available (page might load it via API)
      let retryCount = 0;
      const maxRetries = 20; // Try for up to 6 seconds (20 * 300ms)
      detailBadgeRetryInterval = setInterval(() => {
        retryCount++;
        const ready = detailBadgeDataReady(sid);

        // Only stop if we have ALL primary metrics (and meta) or we timed out
        if (ready || retryCount >= maxRetries) {
          clearInterval(detailBadgeRetryInterval);
          detailBadgeRetryInterval = null;
          renderDetailBadge(); // Re-render with whatever we have
        }
      }, 300);
      
      el.innerHTML = ''; // Clear while loading
      renderDetailLoading(el);
      return;
    }
    
    // Clear retry interval if we have data
    if (detailBadgeRetryInterval) {
      clearInterval(detailBadgeRetryInterval);
      detailBadgeRetryInterval = null;
    }

    // All primary metrics are present; render the pills
    const uv = idToUnique.get(sid);
    const likes = idToLikes.get(sid);
    const totalViews = idToViews.get(sid);
    const commentsVal = idToComments.get(sid);
    const comments = commentsVal ?? 0;
    const remixes = idToRemixes.get(sid) ?? 0;

    const irRaw = commentsVal == null ? null : interactionRate(likes, comments, uv);
    const rrRaw = remixRate(likes, remixes);
    const irDisp = irRaw ? (parseFloat(irRaw) === 0 ? '0%' : irRaw) : null;
    const rrDisp = rrRaw == null ? null : +rrRaw === 0 ? '0%' : (rrRaw.endsWith('.00') ? rrRaw.slice(0, -3) : rrRaw) + '%';
    
    // Impact Score
    let impactStr = null;
    if (totalViews != null && uv != null && uv > 0) {
      const ratio = totalViews / uv;
      impactStr = `${ratio.toFixed(2)}`;
    }

    const meta = idToMeta.get(sid);
    const ageMin = meta?.ageMin;
    const isSuperHot = (likes ?? 0) >= 50 && Number.isFinite(ageMin) && ageMin < 60;

    // Match feed badge format exactly
    const viewsStr = uv != null ? `👀 ${fmt(uv)}` : null;
    const irStr = irDisp ? `${irDisp} IR` : null;
    const rrStr = rrDisp ? `${rrDisp} RR` : null;
    const ageStr = Number.isFinite(ageMin) ? fmtAgeMinPill(ageMin) : null;
    const emojiStr = badgeEmojiFor(sid, meta);
    const timeEmojiStr = (ageStr || emojiStr) ? [ageStr || '', emojiStr || ''].filter(Boolean).join(' ') : null;

    // Get duration if available
    let duration = idToDuration.get(sid);
    
    // Fallback: Try to extract duration and dimensions from the video element on the page
    if (!duration || !idToDimensions.has(sid)) {
      try {
        const videoEl = document.querySelector('video[src]');
        if (videoEl) {
          // Extract duration
          if (!duration && videoEl.duration && isFinite(videoEl.duration)) {
            duration = videoEl.duration;
            idToDuration.set(sid, duration); // Cache it
          }
          // Extract dimensions
          if (!idToDimensions.has(sid) && videoEl.videoWidth && videoEl.videoHeight) {
            idToDimensions.set(sid, { width: videoEl.videoWidth, height: videoEl.videoHeight });
          }
        }
      } catch (e) {
        // Ignore errors
      }
    }
    
    const durationStr = duration ? formatDuration(duration) : null;

    // Determine if we have any data to display
    if (viewsStr == null && irStr == null && rrStr == null && impactStr == null && timeEmojiStr == null && durationStr == null) {
      el.innerHTML = '';
      return;
    }

    // Use a key to prevent unnecessary DOM updates - match feed badge key format
    const bg = badgeBgFor(sid, meta);
    const pillBg = bg || 'rgba(37,37,37,0.7)';
    const newKey = JSON.stringify([durationStr, viewsStr, irStr, rrStr, impactStr, timeEmojiStr, pillBg]);
    const hasPills = el.querySelectorAll('.sora-uv-pill').length > 0;
    if (el.dataset.key === newKey && hasPills) return;
    el.dataset.key = newKey;
    
    el.innerHTML = ''; 
    
    // 1. Views Pill - match feed badge exactly
    if (viewsStr) {
      let tooltip = `${fmtInt(uv)} Unique Views`;
      if (impactStr) {
        tooltip += ` – ${fmtInt(totalViews)} Total Views – ${impactStr} Views Per Person`;
      }
      const metEl = createPill(el, viewsStr, tooltip, true);
      metEl.style.background = pillBg;
      metEl.style.pointerEvents = 'auto';
    }
    
    // 2. IR Pill - match feed badge exactly
    if (irStr) {
      const metEl = createPill(el, irStr, 'Likes + Comments relative to Unique Views', true);
      metEl.style.background = pillBg;
      metEl.style.pointerEvents = 'auto';
    }
    
    // 3. RR Pill - match feed badge exactly
    if (rrStr) {
      const metEl = createPill(el, rrStr, 'Total Remixes relative to Likes', true);
      metEl.style.background = pillBg;
      metEl.style.pointerEvents = 'auto';
    }
    
    // 4. Time/Age Pill - match feed badge exactly
    if (timeEmojiStr) {
      const tip = Number.isFinite(ageMin) ? expireEtaTooltip(ageMin) : null;
      const nearDay = isNearWholeDay(ageMin);
      const tipFinal = tip || (nearDay ? 'This gen was posted at this time of day!' : null);
      
      const timeEl = createPill(el, timeEmojiStr, tipFinal, !!tipFinal);
      timeEl.style.background = pillBg;
      timeEl.style.pointerEvents = 'auto';

      if (isSuperHot) {
        timeEl.style.boxShadow = '0 0 10px 3px hsla(0, 100%, 50%, 0.7)';
      }
    }

    // 5. Duration Pill - moved to end
    if (durationStr) {
      const dims = idToDimensions.get(sid);
      let modelName = '';
      if (dims) {
        const w = dims.width;
        const h = dims.height;
        // Check for Sora 2 (352x640 or 640x352)
        if ((w === 352 && h === 640) || (w === 640 && h === 352)) {
          modelName = ' Sora 2';
        }
        // Check for Sora 2 Pro (512x896 or 896x512)
        else if ((w === 512 && h === 896) || (w === 896 && h === 512)) {
          modelName = ' Sora 2 Pro';
        }
      }
      const tooltip = `${durationStr}${modelName} video`;
      const metEl = createPill(el, `${durationStr}`, tooltip, true);
      metEl.style.background = pillBg;
      metEl.style.pointerEvents = 'auto';
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

  function makePill(btn, label, hasArrow = false) {
    // inject shared CSS once
    if (!document.getElementById('sora-uv-btn-style')) {
      const st = document.createElement('style');
      st.id = 'sora-uv-btn-style';
      st.textContent = `
        .sora-uv-btn {
          display: flex;
          height: 40px;
          align-items: center;
          justify-content: space-between;
          gap: 6px;
          border-radius: 9999px;
          padding: 0 16px;
          background: rgba(37, 37, 37, 0.6);
          backdrop-filter: blur(22px) saturate(2);
          -webkit-backdrop-filter: blur(22px) saturate(2);
          border: 1px solid rgba(255, 255, 255, 0.15);
          color: #fff;
          font-size: 16px;
          font-weight: 600;
          white-space: nowrap;
          cursor: pointer;
          user-select: none;
          transition: opacity 120ms ease;
          box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
        }
        .sora-uv-btn::before,
        .sora-uv-btn::after {
          display: none !important;
        }
        .sora-uv-btn:hover {
          opacity: 0.9;
        }
        .sora-uv-btn[disabled] { 
          opacity: .5; 
          cursor: not-allowed; 
        }
        .sora-uv-btn[data-active="true"] {
          background: hsla(120, 60%, 30%, .90) !important;
          border: 1px solid hsla(120, 60%, 40%, .90) !important;
          box-shadow: 0 0 10px 3px hsla(120, 60%, 35%, .45) !important;
          color: #fff !important;
          opacity: 1 !important;
        }
        .sora-uv-btn[data-active="true"]:hover {
          background: hsla(120, 60%, 32%, .95) !important;
        }
        .sora-uv-btn svg {
          opacity: 0.5;
        }
        .sora-uv-btn:hover svg {
          opacity: 1;
        }
        .sora-uv-btn[data-active="true"] svg {
          opacity: 0.8;
        }
      `;
      document.head.appendChild(st);
    }

    // reset + label
    while (btn.firstChild) btn.removeChild(btn.firstChild);
    const span = document.createElement('span');
    span.textContent = label;
    btn.appendChild(span);

    // add arrow if requested
    if (hasArrow) {
      btn.dataset.hasArrow = 'true';
      const arrowDiv = document.createElement('div');
      arrowDiv.style.display = 'flex';
      arrowDiv.style.alignItems = 'center';
      arrowDiv.style.flexShrink = '0';
      arrowDiv.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"></path></svg>`;
      btn.appendChild(arrowDiv);
    }

    // base attrs
    btn.type = 'button';
    btn.setAttribute('role', 'combobox');
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-autocomplete', 'none');
    btn.dataset.state = 'closed';
    btn.className = 'sora-uv-btn';

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
    
    // Helper function to calculate top position based on scroll distance
    // Linear movement: starts at 42px (12px + 30px), moves to 8px over 30px of scroll
    // Only applies on explore pages
    const getBarTopPosition = () => {
      // Only apply scroll-based positioning on explore pages
      if (!isExplore()) {
        return '12px'; // Default position on non-explore pages
      }
      
      const scrollY = window.scrollY || window.pageYOffset || 0;
      const maxScroll = 30; // Distance to scroll before fully moved up
      const startTop = 42; // 12px + 30px offset
      const endTop = 8; // Positioned slightly higher than original 12px after scrolling
      
      if (scrollY <= 0) {
        return `${startTop}px`;
      } else if (scrollY >= maxScroll) {
        return `${endTop}px`;
      } else {
        // Linear interpolation
        const progress = scrollY / maxScroll;
        const currentTop = startTop - (startTop - endTop) * progress;
        return `${currentTop}px`;
      }
    };
    
    // Update bar position based on scroll
    const updateBarPosition = () => {
      bar.style.top = getBarTopPosition();
    };
    
    Object.assign(bar.style, {
      position: 'fixed',
      top: getBarTopPosition(), // Start 30px lower (42px), move linearly to 12px
      right: '12px',
      zIndex: 2147483640, // Lower than max to allow notifications (toasts) to be on top
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
      // No transition - direct movement tied to scroll
    });
    
    // Function to update feed selector button position based on scroll
    const updateFeedButtonPosition = () => {
      // Only apply scroll-based positioning on explore pages
      if (!isExplore()) {
        return; // Don't modify feed button position on non-explore pages
      }
      
      // Find the feed selector button container (the one with "Choose a feed" aria-label)
      const feedButton = document.querySelector('button[aria-label="Choose a feed"]');
      if (!feedButton) return;
      
      // Find the parent container with fixed positioning
      let container = feedButton.closest('.fixed');
      if (!container) {
        // If no fixed container found, look for parent with top-4 or top-2 classes
        container = feedButton.parentElement;
        while (container && !container.classList.contains('fixed')) {
          container = container.parentElement;
        }
      }
      if (!container) return;
      
      const scrollY = window.scrollY || window.pageYOffset || 0;
      const maxScroll = 30;
      const startOffset = 34; // 34px lower at start (more spacing)
      
      // Get original top values from classes (top-4 = 16px, top-2 = 8px)
      // For mobile: top-4 (16px) -> 16px + 40px = 56px at start, 16px at end
      // For tablet: top-2 (8px) -> 8px + 40px = 48px at start, 8px at end
      const isTablet = window.matchMedia('(min-width: 768px)').matches;
      const baseTop = isTablet ? 8 : 16; // top-2 = 8px, top-4 = 16px
      const endTop = isTablet ? 8 : 16; // More spacing from top (back to original base positions)
      
      const startTop = baseTop + startOffset;
      let finalTop;
      if (scrollY <= 0) {
        finalTop = startTop;
      } else if (scrollY >= maxScroll) {
        finalTop = endTop;
      } else {
        // Linear interpolation
        const progress = scrollY / maxScroll;
        finalTop = startTop - (startTop - endTop) * progress;
      }
      
      container.style.top = `${finalTop}px`;
    };
    
    // Store the function for later use
    window.updateFeedButtonPosition = updateFeedButtonPosition;
    
    // Initial position update and watch for dynamically added buttons
    const tryUpdateFeedButton = () => {
      updateFeedButtonPosition();
    };
    
    // Try immediately and after a delay
    tryUpdateFeedButton();
    
    // Watch for DOM changes in case button is added dynamically
    const observer = new MutationObserver(() => {
      tryUpdateFeedButton();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    bar._feedButtonObserver = observer;
    
    // Add scroll event listener - update directly on every scroll
    const handleScroll = () => {
      updateBarPosition();
      updateFeedButtonPosition();
    };
    window.addEventListener('scroll', handleScroll, { passive: true });
    bar._handleScroll = handleScroll;
    bar._feedButtonTimers = [
      setTimeout(tryUpdateFeedButton, 100),
      setTimeout(tryUpdateFeedButton, 500),
    ];
    
    // Store the update function on the bar for later use
    bar.updateBarPosition = updateBarPosition;

    const buttonRow = document.createElement('div');
    Object.assign(buttonRow.style, {
      display: 'flex',
      gap: '8px',
      background: 'transparent',
      justifyContent: 'center',
      alignItems: 'center',
    });

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
    filterContainer.style.display = 'none';
    
    const filterBtn = document.createElement('button');
    filterBtn.setAttribute('data-role', 'filter-btn');
    makePill(filterBtn, 'Filter', true);
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
      // Format dropdown labels: "All Posts" for first item, "Past X hours" for others
      let dropdownLabel;
      if (index === 0) {
        dropdownLabel = 'All Posts';
      } else if (FILTER_STEPS_MIN[index] === 'no_remixes') {
        dropdownLabel = 'No Remixes';
      } else {
        const hours = FILTER_STEPS_MIN[index] / 60; // Convert minutes to hours
        dropdownLabel = `Past ${hours} hours`;
      }
      option.textContent = dropdownLabel;
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
    gatherBtn.dataset.gathering = 'false';
    makePill(gatherBtn, 'Gather');
    gatherBtn.classList.add('sora-uv-gather-btn');
    gatherBtn.style.display = 'none';
    buttonRow.appendChild(gatherBtn);

    // Analyze (Top only; visibility handled later)
    analyzeBtn = document.createElement('button');
    makePill(analyzeBtn, 'Analyze');
    analyzeBtn.classList.add('sora-uv-analyze-btn');
    analyzeBtn.style.display = 'none';
    buttonRow.appendChild(analyzeBtn);

    // Bookmarks (Drafts only; visibility handled later)
    const bookmarksContainer = document.createElement('div');
    bookmarksContainer.className = 'sora-uv-bookmarks-container';
    bookmarksContainer.style.position = 'relative';
    
    bookmarksBtn = document.createElement('button');
    bookmarksBtn.dataset.active = 'false';
    makePill(bookmarksBtn, 'All Drafts', true);
    bookmarksBtn.classList.add('sora-uv-bookmarks-btn');
    bookmarksBtn.style.display = 'none';
    bookmarksContainer.appendChild(bookmarksBtn);
    
    // Bookmarks dropdown menu
    const bookmarksDropdown = document.createElement('div');
    bookmarksDropdown.className = 'sora-uv-bookmarks-dropdown';
    Object.assign(bookmarksDropdown.style, {
      position: 'absolute',
      top: 'calc(100% + 4px)',
      right: '0',
      display: 'none',
      flexDirection: 'column',
      gap: '0',
      padding: '8px',
      background: 'rgba(37, 37, 37, 0.6)',
      border: '1px solid rgba(255, 255, 255, 0.15)',
      borderRadius: '20px',
      boxShadow: '0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05)',
      backdropFilter: 'blur(22px) saturate(2)',
      WebkitBackdropFilter: 'blur(22px) saturate(2)',
      zIndex: 999999,
      minWidth: '220px',
    });
    
    // Bookmarks dropdown options
    const bookmarksLabels = ['All Drafts', 'Bookmarks', 'Unbookmarked', 'Violations'];
    bookmarksLabels.forEach((label, index) => {
      const option = document.createElement('button');
      option.textContent = label;
      option.className = 'sora-uv-bookmarks-option';
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
        bookmarksFilterState = index;
        bookmarksBtn.setActive(bookmarksFilterState !== 0);
        bookmarksBtn.setLabel(label);
        applyBookmarksFilter(true);
        bookmarksDropdown.style.display = 'none';
        // Update visual selection
        updateBookmarksDropdownSelection();
      };
      bookmarksDropdown.appendChild(option);
    });
    
    // Function to update dropdown selection visual state
    const updateBookmarksDropdownSelection = () => {
      const options = bookmarksDropdown.querySelectorAll('.sora-uv-bookmarks-option');
      options.forEach((opt, idx) => {
        if (idx === bookmarksFilterState) {
          opt.style.background = 'var(--token-bg-active, rgba(255, 255, 255, 0.15))';
          opt.style.fontWeight = '600';
        } else {
          opt.style.background = 'transparent';
          opt.style.fontWeight = '500';
        }
      });
    };
    
    // Initialize selection state
    updateBookmarksDropdownSelection();
    
    bookmarksContainer.appendChild(bookmarksDropdown);
    buttonRow.appendChild(bookmarksContainer);

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

    // Inject gather slider CSS once
    if (!document.getElementById('sora-uv-gather-slider-style')) {
      const st = document.createElement('style');
      st.id = 'sora-uv-gather-slider-style';
      st.textContent = `
        .sora-uv-controls input[type="range"]::-webkit-slider-thumb {
          appearance: none;
          -webkit-appearance: none;
        }
        .sora-uv-controls input[type="range"]::-moz-range-thumb {
          border: none;
        }
      `;
      document.head.appendChild(st);
    }

    const sliderContainer = document.createElement('div');
    sliderContainer.className = 'sora-uv-slider-container';
    Object.assign(sliderContainer.style, {
      display: 'flex',
      width: '100%',
      alignItems: 'center',
      justifyContent: 'center',
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
      filterBtn.setLabel(FILTER_LABELS[idx]);

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
    document.addEventListener('click', (e) => {
      if (!filterContainer.contains(e.target)) {
        filterDropdown.style.display = 'none';
      }
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

    bookmarksBtn.onclick = (e) => {
      if (bookmarksBtn.disabled) return;
      e.stopPropagation();
      const isOpen = bookmarksDropdown.style.display === 'flex';
      if (!isOpen) {
        updateBookmarksDropdownSelection();
      }
      bookmarksDropdown.style.display = isOpen ? 'none' : 'flex';
    };
    
    // Close bookmarks dropdown when clicking outside
    document.addEventListener('click', (e) => {
      if (bookmarksContainer && !bookmarksContainer.contains(e.target)) {
        bookmarksDropdown.style.display = 'none';
      }
    });

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

        // Align gatherControlsWrapper with the button's current width
        // Use requestAnimationFrame to ensure the button has rendered with new label
        requestAnimationFrame(() => {
          const buttonWidth = gatherBtn.offsetWidth;
          gatherControlsWrapper.style.width = `${buttonWidth}px`;
          gatherControlsWrapper.style.alignSelf = 'flex-start';
          // Calculate the left offset to align with the button relative to the bar
          const buttonRect = gatherBtn.getBoundingClientRect();
          const barRect = bar.getBoundingClientRect();
          gatherControlsWrapper.style.marginLeft = `${buttonRect.left - barRect.left}px`;
        });

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
        // Reset alignment styles
        gatherControlsWrapper.style.width = '100%';
        gatherControlsWrapper.style.alignSelf = '';
        gatherControlsWrapper.style.marginLeft = '';
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
    
    // Set initial position based on current scroll
    updateBarPosition();

    document.documentElement.appendChild(bar);
    controlBar = bar;
    return bar;
  }

  function teardownControlBar() {
    const bar = controlBar;
    if (!bar) return;
    try {
      if (bar._handleScroll) window.removeEventListener('scroll', bar._handleScroll);
    } catch {}
    try {
      if (bar._feedButtonObserver) bar._feedButtonObserver.disconnect();
    } catch {}
    try {
      const timers = Array.isArray(bar._feedButtonTimers) ? bar._feedButtonTimers : [];
      for (const t of timers) clearTimeout(t);
    } catch {}
    try {
      if (document.contains(bar)) bar.remove();
    } catch {}
    controlBar = null;
  }



  async function fetchNewPostsForAnalyze() {
    // Fetch on all feeds except Drafts
    if (isDrafts()) return;
    
    try {
      let feedUrl;
      
      if (isTopFeed()) {
        // Top feed endpoint
        feedUrl = `${location.origin}/explore?feed=top`;
      } else if (isProfile()) {
        // Profile feed endpoint
        const profileHandle = currentProfileHandleFromURL();
        if (profileHandle) {
          feedUrl = `${location.origin}/profile/${profileHandle}`;
        } else {
          feedUrl = `${location.origin}/profile`;
        }
      } else {
        // For other feeds (For You, Following, etc.), use current path
        feedUrl = `${location.origin}${location.pathname}${location.search}`;
      }
      
      if (feedUrl) {
        dlog('analyze', 'fetching new posts', { feedUrl });
        // Fetch the feed - this will go through the fetch sniffer which automatically
        // processes the response via processFeedJson, updating stored metrics
        const response = await fetch(feedUrl, {
          method: 'GET',
          credentials: 'include',
          headers: {
            'Accept': 'application/json',
          },
        });
        
        if (response.ok) {
          // The fetch sniffer will handle processing the JSON automatically
          // We just need to wait a bit for it to process, then the render will pick up new data
          const json = await response.json();
          dlog('analyze', 'fetched new posts', { items: (json?.items || json?.data?.items || []).length });
          // Process directly as well to ensure immediate update (fetch sniffer may have already done this)
          processFeedJson(json);
        }
      }
    } catch (error) {
      dlog('analyze', 'error fetching new posts', { error: error.message });
    }
  }

  function startAnalyzeAutoRefresh() {
    if (analyzeAutoRefreshId) clearInterval(analyzeAutoRefreshId);

    const TICK_MS = 30_000; // every 30s (your setting)

    const tick = async () => {
      if (!analyzeActive) return;
      if (document.hidden) return; // SAFEGUARD: no work when tab not visible
      
      // First, fetch new posts from the API
      await fetchNewPostsForAnalyze();
      
      // Update the cameo dropdown with fresh counts if it's visible
      if (analyzeCameoFilterWrap && analyzeCameoFilterWrap.style.display !== 'none') {
        // Use the globally accessible updateCameoDropdown function
        if (typeof window._soraUVUpdateCameoDropdown === 'function') {
          await window._soraUVUpdateCameoDropdown();
        }
      }
      
      // Then render the table with updated data
      requestAnimationFrame(() => renderAnalyzeTable(true));
    };

    analyzeAutoRefreshId = setInterval(tick, TICK_MS);

    // Run once immediately if we're visible
    if (!document.hidden) tick();

    // Refresh immediately when the tab gains focus or becomes visible
    const onFocus = async () => {
      if (!analyzeActive) return;
      if (!document.hidden) {
        await fetchNewPostsForAnalyze();
        // Update dropdown if visible
        if (analyzeCameoFilterWrap && analyzeCameoFilterWrap.style.display !== 'none' && typeof window._soraUVUpdateCameoDropdown === 'function') {
          await window._soraUVUpdateCameoDropdown();
        }
        requestAnimationFrame(() => renderAnalyzeTable(true));
      }
    };
    const onVis = async () => {
      if (!analyzeActive) return;
      if (!document.hidden) {
        await fetchNewPostsForAnalyze();
        // Update dropdown if visible
        if (analyzeCameoFilterWrap && analyzeCameoFilterWrap.style.display !== 'none' && typeof window._soraUVUpdateCameoDropdown === 'function') {
          await window._soraUVUpdateCameoDropdown();
        }
        requestAnimationFrame(() => renderAnalyzeTable(true));
      }
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
        
        // Debug: Check if duration is in the stored metrics
        if (DEBUG.analyze) {
          const sampleUser = Object.values(_metricsCache.users || {})[0];
          if (sampleUser && sampleUser.posts) {
            const samplePost = Object.values(sampleUser.posts)[0];
            if (samplePost) {
              dlog('analyze', 'metrics loaded', {
                userCount: Object.keys(_metricsCache.users || {}).length,
                postCount: Object.values(_metricsCache.users || {}).reduce((sum, u) => sum + Object.keys(u.posts || {}).length, 0),
                samplePostHasDuration: !!samplePost.duration,
                samplePostDuration: samplePost.duration,
                sampleSnapshotHasDuration: samplePost.snapshots && samplePost.snapshots.length > 0 ? !!samplePost.snapshots[0].duration : false
              });
            }
          }
        }
        
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

  async function collectCameoUsernamesFromStorage() {
    const metrics = await requestStoredMetrics();
    const NOW = Date.now();
    const windowHours = Number(analyzeWindowHours) || 24;
    const WINDOW_MS = windowHours * 60 * 60 * 1000;
    const userPostIds = new Map(); // username -> Set of post IDs (any post they're tied to)

    for (const [, user] of Object.entries(metrics?.users || {})) {
      const userHandle = user?.handle || user?.userHandle || null;
      
      for (const [pid, p] of Object.entries(user?.posts || {})) {
        const tPost = __sorauv_getPostTimeStrict(p);
        if (!tPost || NOW - tPost > WINDOW_MS) continue;

        const snap = __sorauv_latestSnapshot(p?.snapshots);
        if (!snap) continue;
        const likes = Number(snap.likes);
        if (!isFinite(likes) || likes < 15) continue;

        // Get owner of this post
        const ownerHandle = p?.ownerHandle || userHandle;
        
        // Get cameos in this post
        const cameos = Array.isArray(p?.cameo_usernames) ? p.cameo_usernames : [];
        const uniqueCameos = [...new Set(cameos)].filter(c => typeof c === 'string' && c);
        
        // Collect all usernames tied to this post (owner + cast)
        const tiedUsernames = new Set();
        if (ownerHandle && typeof ownerHandle === 'string') {
          tiedUsernames.add(ownerHandle);
        }
        for (const cameoUsername of uniqueCameos) {
          tiedUsernames.add(cameoUsername);
        }
        
        // Add this post to each tied username's set (dedupe automatically)
        for (const username of tiedUsernames) {
          if (!userPostIds.has(username)) {
            userPostIds.set(username, new Set());
          }
          userPostIds.get(username).add(pid);
        }
      }
    }

    // Convert to array with counts and sort by count (descending), then alphabetically
    const result = Array.from(userPostIds.entries())
      .map(([username, postIds]) => ({ username, count: postIds.size }))
      .sort((a, b) => {
        if (a.count !== b.count) return b.count - a.count;
        return a.username.localeCompare(b.username);
      });
    
    return result;
  }

  async function collectAnalyzeRowsFromStorage() {
    const metrics = await requestStoredMetrics();
    const rows = [];
    const NOW = Date.now();
    const windowHours = Number(analyzeWindowHours) || 24;
    const WINDOW_MS = windowHours * 60 * 60 * 1000;
    const windowMin = windowHours * 60;

    for (const [, user] of Object.entries(metrics?.users || {})) {
      for (const [pid, p] of Object.entries(user?.posts || {})) {
        const tPost = __sorauv_getPostTimeStrict(p);
        if (!tPost || NOW - tPost > WINDOW_MS) continue;

        const snap = __sorauv_latestSnapshot(p?.snapshots);
        if (!snap) continue;
        const likes = Number(snap.likes);
        if (!isFinite(likes) || likes < 15) continue;

        const uv = Number(snap.uv);
        const comments = Number(snap.comments);
        const remixes = Number(snap.remix_count ?? snap.remixes);

        const rrVal =
          isFinite(likes) && likes > 0 && isFinite(remixes) && remixes >= 0 ? (remixes / likes) * 100 : null;
        const irVal = isFinite(uv) && uv > 0 ? (((Number(likes) || 0) + (Number(comments) || 0)) / uv) * 100 : null;

        const ageMin = Math.max(0, Math.floor((NOW - tPost) / 60000));
        const expiringMin = Math.max(0, windowMin - ageMin);

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

        // Get duration from storage: try snapshot first, then post level, then in-memory Map
        let duration = snap.duration != null ? snap.duration : (p.duration != null ? p.duration : idToDuration.get(pid));
        const durationStr = duration ? formatDuration(duration) : null;
        
        // Debug logging to track duration loading
        if (DEBUG.analyze && pid && likes >= 20) {
          const sample = Math.random() < 0.1; // Sample 10% of posts
          if (sample || !duration) {
            dlog('analyze', 'duration load', { 
              pid: pid.substring(0, 8), 
              snapDuration: snap.duration, 
              postDuration: p.duration, 
              memDuration: idToDuration.get(pid),
              final: duration,
              hasSnap: !!snap,
              snapKeys: snap ? Object.keys(snap).join(',') : 'none',
              postKeys: Object.keys(p || {}).join(',')
            });
          }
        }
        
        // Restore duration to in-memory Map if we found it in storage
        if (duration != null && !idToDuration.has(pid)) {
          idToDuration.set(pid, duration);
        }

        // Also restore dimensions to in-memory Map if stored (try snapshot first, then post level)
        if (snap.width != null && snap.height != null) {
          idToDimensions.set(pid, { width: snap.width, height: snap.height });
        } else if (p.width != null && p.height != null) {
          idToDimensions.set(pid, { width: p.width, height: p.height });
        }

        rows.push({
          id: pid,
          url: p.url ? p.url : `${location.origin}/p/${pid}`,
          ownerHandle,
          views: isFinite(uv) ? uv : 0,
          duration: durationStr,
          likes: isFinite(likes) ? likes : 0,
          remixes: isFinite(remixes) ? remixes : 0,
          comments: isFinite(comments) ? comments : 0,
          rrPctStr,
          rrPctVal: rrVal == null ? -1 : rrVal,
          irPctStr,
          irPctVal: irVal == null ? -1 : irVal,
          expiringMin,
          caption,
          cameo_usernames: Array.isArray(p?.cameo_usernames) ? p.cameo_usernames : null,
        });
      }
    }
    if (DEBUG.analyze) dlog('analyze', 'rows from storage', rows.length);
    return rows;
  }

  function collectAnalyzeRowsFromLiveMaps() {
    const rows = [];
    const windowHours = Number(analyzeWindowHours) || 24;
    const windowMin = windowHours * 60;
    for (const [id, likes] of idToLikes.entries()) {
      const meta = idToMeta.get(id);
      const ageMin = meta?.ageMin;
      if (!Number.isFinite(ageMin) || ageMin > windowMin) continue;
      if (!Number.isFinite(likes) || likes < 15) continue;

      const uv = Number(idToUnique.get(id) ?? 0);
      const comments = Number(idToComments.get(id) ?? 0);
      const remixes = Number(idToRemixes.get(id) ?? 0);

      const rrRaw = remixRate(likes, remixes); // "12.34" or null
      const rrPctStr = rrRaw == null ? '' : +rrRaw === 0 ? '0%' : (rrRaw.endsWith('.00') ? rrRaw.slice(0, -3) : rrRaw) + '%';
      const rrPctVal = rrRaw == null ? -1 : +rrRaw;

      const irVal = uv > 0 ? (((Number(likes) || 0) + (Number(comments) || 0)) / uv) * 100 : null;
      const irPctStr = irVal == null ? '' : irVal === 0 ? '0%' : irVal.toFixed(1).replace(/\.0$/, '') + '%';

      const expiringMin = Math.max(0, windowMin - Math.floor(ageMin));

      const duration = idToDuration.get(id);
      const durationStr = duration ? formatDuration(duration) : null;

      rows.push({
        id,
        url: `${location.origin}/p/${id}`,
        ownerHandle: typeof meta?.userHandle === 'string' && meta.userHandle ? meta.userHandle : '',
        views: uv || 0,
        duration: durationStr,
        likes: Number(likes) || 0,
        remixes: remixes || 0,
        comments: comments || 0,
        rrPctStr,
        rrPctVal,
        irPctStr,
        irPctVal: irVal == null ? -1 : irVal,
        expiringMin,
        caption: '', // live map path doesn't retain caption reliably
        cameo_usernames: null, // live maps don't retain cameo_usernames reliably
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
    Object.assign(lbl.style, { fontWeight: 800, fontSize: '13px', opacity: 0.9, minWidth: '48px' });

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

    pill.onclick = async () => {
      rangeInput.value = '24';
      analyzeWindowHours = 24;
      localStorage.setItem('SORA_UV_ANALYZE_WINDOW_H', '24');
      updateSliderUI();
      // Update cameo dropdown when window changes
      if (analyzeCameoFilterWrap && analyzeCameoFilterWrap.style.display !== 'none') {
        await updateCameoDropdown();
      }
      renderAnalyzeTable(true);
    };
    rangeInput.oninput = async () => {
      analyzeWindowHours = Math.min(24, Math.max(1, Number(rangeInput.value) || 24));
      localStorage.setItem('SORA_UV_ANALYZE_WINDOW_H', String(analyzeWindowHours));
      updateSliderUI();
      // Update cameo dropdown when window changes
      if (analyzeCameoFilterWrap && analyzeCameoFilterWrap.style.display !== 'none') {
        await updateCameoDropdown();
      }
      renderAnalyzeTable(true);
    };
    window.addEventListener('resize', updateSliderUI);

    track.appendChild(trackBar);
    track.appendChild(fillBar);
    track.appendChild(rangeInput);

    analyzeSliderWrap.appendChild(lbl);
    analyzeSliderWrap.appendChild(track);
    analyzeSliderWrap.appendChild(pill);

    // ---------- Cameo Filter Row ----------
    analyzeCameoFilterWrap = document.createElement('div');
    Object.assign(analyzeCameoFilterWrap.style, {
      width: '100%', display: 'none', alignItems: 'center', gap: '6px',
      padding: '10px 12px', borderRadius: '14px',
      background: 'rgba(48,48,48,0.22)',
      border: '1px solid #353535',
      boxShadow: '0 6px 20px rgba(0,0,0,0.30), inset 0 0 1px rgba(255,255,255,0.18)',
      isolation: 'isolate', position: 'relative', margin: '4px 0 10px',
    });
    panel.appendChild(analyzeCameoFilterWrap);

    const cameoFilterLbl = document.createElement('div');
    cameoFilterLbl.textContent = 'See gens tied to';
    Object.assign(cameoFilterLbl.style, { fontWeight: 800, fontSize: '13px', opacity: 0.9, minWidth: '105px' });

    analyzeCameoSelectEl = document.createElement('select');
    Object.assign(analyzeCameoSelectEl.style, {
      minWidth: '180px',
      maxWidth: '220px',
      padding: '6px 10px',
      background: 'rgba(29,29,29,0.78)',
      color: '#e8eaed',
      border: '1px solid rgba(255,255,255,0.10)',
      borderRadius: '8px',
      fontSize: '13px',
      outline: 'none',
      cursor: 'pointer',
    });

    const updateCameoDropdown = async () => {
      const cameos = await collectCameoUsernamesFromStorage();
      
      // Sort by count descending (most frequent to least)
      const sortedCameos = [...cameos].sort((a, b) => b.count - a.count);
      
      if (analyzeCameoSelectEl) {
        analyzeCameoSelectEl.innerHTML = 
        '<option value="">Everyone</option>' +
        sortedCameos.map(c => `<option value="${esc(c.username)}">${esc(c.username)} (${fmtInt(c.count)})</option>`).join('');
        
        if (analyzeCameoFilterUsername) {
          analyzeCameoSelectEl.value = analyzeCameoFilterUsername;
        } else {
          analyzeCameoSelectEl.value = '';
        }
      }
    };
    
    // Make updateCameoDropdown accessible globally for auto-refresh
    window._soraUVUpdateCameoDropdown = updateCameoDropdown;

    analyzeCameoSelectEl.addEventListener('change', (e) => {
      const value = e.target.value;
      if (value === '' || value === null) {
        // "Everyone" - no filter, show all data
        analyzeCameoFilterUsername = null;
      } else {
        // Specific person selected - filter to show posts with this cameo OR made by this user
        analyzeCameoFilterUsername = value;
      }
      // Force refresh to apply the new filter and update header text
      renderAnalyzeTable(true);
    });

    analyzeCameoFilterWrap.appendChild(cameoFilterLbl);
    analyzeCameoFilterWrap.appendChild(analyzeCameoSelectEl);

    // Initialize dropdown
    updateCameoDropdown();
    
    // Make updateCameoDropdown accessible globally for auto-refresh
    window._soraUVUpdateCameoDropdown = updateCameoDropdown;

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
    if (analyzeCameoFilterWrap) ro.observe(analyzeCameoFilterWrap);
    window.addEventListener('resize', ov._recomputeSticky);
    requestAnimationFrame(() => {
      ov._recomputeSticky();
      updateSliderUI();
    });

    document.documentElement.appendChild(ov);
    analyzeOverlayEl = ov;
    return ov;
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

      ['100px', '60px', '60px', '60px', '60px', '75px', '75px', '100px'].forEach((w) => {
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
        ['duration', '⏱'],
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

    if (DEBUG.analyze && rows.length > 0) {
      const sample = rows.find(r => r.cameo_usernames && r.cameo_usernames.length > 0);
      if (sample) {
        dlog('analyze', 'found row with cameos', { id: sample.id, cameos: sample.cameo_usernames, owner: sample.ownerHandle });
      } else {
        dlog('analyze', 'no rows with cameos found in this batch', { totalRows: rows.length });
      }
    }

    const windowMin = (Number(analyzeWindowHours) || 24) * 60;
    // Filter rows: expiringMin represents minutes until the post expires from the window
    // A post with expiringMin >= 0 is still within the window
    rows = rows.filter((r) => Number.isFinite(r.expiringMin) && r.expiringMin >= 0);
    
    // Filter by cameo username if selected
    if (analyzeCameoFilterUsername) {
      // Show posts with specific cameo OR posts made by that user
      const filterUsernameLower = analyzeCameoFilterUsername.toLowerCase().trim();
      rows = rows.filter((r) => {
        // Check if user appears as a cameo
        const cameos = Array.isArray(r.cameo_usernames) ? r.cameo_usernames : [];
        const hasCameo = cameos.some(c => {
          if (typeof c !== 'string') return false;
          return c.toLowerCase().trim() === filterUsernameLower;
        });
        
        // Check if user is the owner/creator of the post
        const ownerHandleLower = (r.ownerHandle || '').toLowerCase().trim();
        const isOwner = ownerHandleLower === filterUsernameLower;
        
        return hasCameo || isOwner;
      });
    }
    
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
      const cameos = Array.isArray(r.cameo_usernames) ? r.cameo_usernames.filter(c => typeof c === 'string' && c.trim()) : [];
      
      // Build the full label with cast: "username cast charactername1, charactername2 - caption"
      let fullLabel = '';
      if (owner) {
        if (cameos.length > 0) {
          const cameoList = cameos.join(', ');
          fullLabel = `${owner} cast ${cameoList} - ${captionRaw}`;
        } else {
          fullLabel = `${owner} - ${captionRaw}`;
        }
      } else {
        fullLabel = captionRaw || '';
      }
      a.title = fullLabel;

      if (owner) {
        const u = document.createElement('span'); 
        u.textContent = owner; 
        u.style.fontWeight = '800'; 
        a.appendChild(u);
        
        if (cameos.length > 0) {
          // Always show "cast" when there are cast members (even if owner is also in cast)
          const castWord = document.createElement('span'); 
          castWord.textContent = ' cast '; 
          castWord.style.fontWeight = '300'; 
          a.appendChild(castWord);
          
          // Add each cast username as a separate bold span
          cameos.forEach((cameo, idx) => {
            const cameoUser = document.createElement('span');
            cameoUser.textContent = cameo;
            cameoUser.style.fontWeight = '800';
            a.appendChild(cameoUser);
            if (idx < cameos.length - 1) {
              const comma = document.createElement('span');
              comma.textContent = ', ';
              comma.style.fontWeight = '300';
              a.appendChild(comma);
            }
          });
        }
        
        const sep = document.createElement('span'); 
        sep.textContent = ' - '; 
        sep.style.fontWeight = '300'; 
        a.appendChild(sep);
        
        const c = document.createElement('span'); 
        c.textContent = captionRaw || ''; 
        c.style.fontWeight = '300'; 
        a.appendChild(c);
      } else {
        const c = document.createElement('span'); 
        c.textContent = captionRaw || ''; 
        c.style.fontWeight = '300'; 
        a.appendChild(c);
      }

      a.onmouseenter = () => { a.style.textDecoration = 'underline'; };
      a.onmouseleave = () => { a.style.textDecoration = 'none'; };
      tdPost.appendChild(a);

      const tdViews = mkTdNum(r.views);
      const tdDuration = mkTdNum(r.duration || '—');
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
      tr.appendChild(tdDuration);
      tr.appendChild(tdLikes);
      tr.appendChild(tdRemixes);
      tr.appendChild(tdComments);
      tr.appendChild(tdRR);
      tr.appendChild(tdIR);
      tr.appendChild(tdExp);
      newTbody.appendChild(tr);
    }

    const table = analyzeTableEl;
    const swap = () => {
      const currentBody = table.tBodies[0];
      if (currentBody) table.replaceChild(newTbody, currentBody);
      else table.appendChild(newTbody);
    };
    if ('requestAnimationFrame' in window) requestAnimationFrame(swap);
    else swap();

    const isAnalyzing = !!(analyzeRapidScrollId || analyzeCountdownIntervalId);
    if (!isAnalyzing && analyzeHeaderTextEl) {
      const hoursLabel = (n) => (Number(n) === 1 ? '1 hour' : `${n} hours`);
      const fmtNum = (n) => (Number.isFinite(n) ? n.toLocaleString('en-US') : '0');
      const totals = rows.reduce(
        (acc, r) => {
          acc.views += Number.isFinite(r.views) ? r.views : 0;
          acc.likes += Number.isFinite(r.likes) ? r.likes : 0;
          acc.remixes += Number.isFinite(r.remixes) ? r.remixes : 0;
          acc.comments += Number.isFinite(r.comments) ? r.comments : 0;
          return acc;
        },
        { views: 0, likes: 0, remixes: 0, comments: 0 }
      );
      const username = analyzeCameoFilterUsername;
      if (username) {
        // User selected in dropdown
        analyzeHeaderTextEl.textContent = rows.length
          ? `You've seen ${rows.length} top gen${rows.length === 1 ? '' : 's'} tied to ${username} in the last ${hoursLabel(analyzeWindowHours)} totalling ${fmtNum(totals.views)} views, ${fmtNum(totals.likes)} likes, ${fmtNum(totals.remixes)} remixes, and ${fmtNum(totals.comments)} comments.`
          : `No top gens tied to ${username} for last ${hoursLabel(analyzeWindowHours)}... run Gather mode!`;
      } else {
        // Everyone selected (no filter)
        analyzeHeaderTextEl.textContent = rows.length
          ? `You've seen ${rows.length} top gen${rows.length === 1 ? '' : 's'} in the last ${hoursLabel(analyzeWindowHours)} totalling ${fmtNum(totals.views)} views, ${fmtNum(totals.likes)} likes, ${fmtNum(totals.remixes)} remixes, and ${fmtNum(totals.comments)} comments.`
          : `No gens for last ${hoursLabel(analyzeWindowHours)}... run Gather mode!`;
      }
      // Show helper text if there are rows
      // BUT hide it during gather mode OR during rapid analyze gather
      if (analyzeHelperTextEl) {
        const isRapidGathering = !!(analyzeRapidScrollId || analyzeCountdownIntervalId);
        const winH = Number(analyzeWindowHours) || 24;
        const shouldShow =
          (rows.length > 0 || winH <= 1) && !(isTopFeed() && (isGatheringActiveThisTab || isRapidGathering));
        analyzeHelperTextEl.style.display = shouldShow ? '' : 'none';
      }
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
	      const aViews = Number(a.views) || 0;
	      const bViews = Number(b.views) || 0;
	      let primary = 0;
	      if (key === 'prompt') {
	        const aLen = (a.caption || '').replace(/\s+/g, ' ').trim().length;
	        const bLen = (b.caption || '').replace(/\s+/g, ' ').trim().length;
	        primary = (aLen - bLen) * dir;
	      }
	      else if (key === 'post') {
	        const aUser = (a.ownerHandle || '').toLowerCase();
	        const bUser = (b.ownerHandle || '').toLowerCase();
	        if (aUser !== bUser) primary = aUser.localeCompare(bUser) * dir;
	        const aCap = (a.caption || a.id || '').toLowerCase();
	        const bCap = (b.caption || b.id || '').toLowerCase();
	        if (!primary) primary = aCap.localeCompare(bCap) * dir;
	      }
	      else if (key === 'views') {
	        primary = (aViews - bViews) * dir;
	      }
	      else if (key === 'duration') {
	        // Parse duration strings like "10s" or "10.5s" to numeric values for sorting
	        const parseDuration = (d) => {
	          if (!d || d === '—') return -1;
	          const match = d.match(/^(\d+(?:\.\d+)?)s$/);
	          return match ? parseFloat(match[1]) : -1;
	        };
	        const aDur = parseDuration(a.duration);
	        const bDur = parseDuration(b.duration);
	        if (aDur !== bDur) {
	          primary = (aDur - bDur) * dir;
	        }
	        // If durations are equal, fall through to views tiebreaker below
	      }
	      else if (key === 'likes') primary = (a.likes - b.likes) * dir;
	      else if (key === 'remixes') primary = (a.remixes - b.remixes) * dir;
	      else if (key === 'comments') primary = (a.comments - b.comments) * dir;
	      else if (key === 'rr') primary = ((a.rrPctVal ?? -1) - (b.rrPctVal ?? -1)) * dir;
	      else if (key === 'ir') primary = ((a.irPctVal ?? -1) - (b.irPctVal ?? -1)) * dir;
	      else if (key === 'expiring') primary = (a.expiringMin - b.expiringMin) * dir;

	      if (primary) return primary;
	      // For any tie in the active sort column, secondary-sort by decreasing views.
	      if (key !== 'views') {
	        const viewDiff = bViews - aViews;
	        if (viewDiff) return viewDiff;
	      }
	      // Final deterministic tiebreaker.
	      return String(a.id || '').localeCompare(String(b.id || ''));
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
    if (analyzeCameoFilterWrap) analyzeCameoFilterWrap.style.display = 'none';
    // Hide helper text during rapid gather
    if (analyzeHelperTextEl) analyzeHelperTextEl.style.display = 'none';

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
      if (analyzeCameoFilterWrap) analyzeCameoFilterWrap.style.display = 'flex';
      renderAnalyzeTable(true);
      setTimeout(() => {
        try {
          const hasRows = !!(analyzeTableEl && analyzeTableEl.tBodies[0] && analyzeTableEl.tBodies[0].rows.length);
          // After rapid gather completes, show helper text if there are rows
          if (analyzeHelperTextEl) {
            const winH = Number(analyzeWindowHours) || 24;
            const shouldShow = hasRows || winH <= 1;
            analyzeHelperTextEl.style.display = shouldShow ? '' : 'none';
          }
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
    
    // On profile pages, set the cameo filter to the profile username BEFORE building overlay
    if (isProfile()) {
      const profileHandle = currentProfileHandleFromURL();
      if (profileHandle) {
        analyzeCameoFilterUsername = profileHandle;
      }
    }
    
    const ov = ensureAnalyzeOverlay();

    hideAllCards(true);
    ov.style.display = 'block';

    if (typeof ov._recomputeSticky === 'function') ov._recomputeSticky();

    analyzeBtn && analyzeBtn.setActive && analyzeBtn.setActive(true);
    // keep existing sort (don't reset), only set defaults if nothing chosen
    if (!analyzeSortKey) analyzeSortKey = 'views';
    if (!analyzeSortDir) analyzeSortDir = 'desc';

    // On profile pages, update UI elements after overlay is built
    if (isProfile() && analyzeCameoFilterUsername) {
      // Update UI elements if they exist
      if (analyzeCameoSelectEl) analyzeCameoSelectEl.value = analyzeCameoFilterUsername;
    }

    // Only start rapid gather on Top feed (not on profile pages or other feeds)
    if (isTopFeed()) {
      startRapidAnalyzeGather();    // 10s burst to populate quickly
    } else if (isProfile()) {
      // On profile pages, show "Loading..." initially
      if (analyzeHeaderTextEl) {
        analyzeHeaderTextEl.textContent = 'Loading...';
      }
      // On profile pages, show the table immediately
      showAnalyzeTable(true);
      if (analyzeSliderWrap) analyzeSliderWrap.style.display = 'flex';
      if (analyzeCameoFilterWrap) analyzeCameoFilterWrap.style.display = 'flex';
      renderAnalyzeTable(true);
      // Show helper text after rendering
      setTimeout(() => {
        try {
          const hasRows = !!(analyzeTableEl && analyzeTableEl.tBodies[0] && analyzeTableEl.tBodies[0].rows.length);
          // Hide helper text during gather mode OR during rapid analyze gather
          if (analyzeHelperTextEl) {
            const isRapidGathering = !!(analyzeRapidScrollId || analyzeCountdownIntervalId);
            const winH = Number(analyzeWindowHours) || 24;
            const shouldShow =
              (hasRows || winH <= 1) && !(isTopFeed() && (isGatheringActiveThisTab || isRapidGathering));
            analyzeHelperTextEl.style.display = shouldShow ? '' : 'none';
          }
        } catch {}
      }, 100);
    } else {
      // On other feeds (For You, Following, etc.), show the table immediately like Profile
      if (analyzeHeaderTextEl) {
        analyzeHeaderTextEl.textContent = 'Loading...';
      }
      showAnalyzeTable(true);
      if (analyzeSliderWrap) analyzeSliderWrap.style.display = 'flex';
      if (analyzeCameoFilterWrap) analyzeCameoFilterWrap.style.display = 'flex';
      renderAnalyzeTable(true);
      // Show helper text after rendering (shown immediately on other pages unless gathering)
      setTimeout(() => {
        try {
          const hasRows = !!(analyzeTableEl && analyzeTableEl.tBodies[0] && analyzeTableEl.tBodies[0].rows.length);
          // Hide helper text during gather mode OR during rapid analyze gather
          if (analyzeHelperTextEl) {
            const isRapidGathering = !!(analyzeRapidScrollId || analyzeCountdownIntervalId);
            const winH = Number(analyzeWindowHours) || 24;
            const shouldShow =
              (hasRows || winH <= 1) && !(isTopFeed() && (isGatheringActiveThisTab || isRapidGathering));
            analyzeHelperTextEl.style.display = shouldShow ? '' : 'none';
          }
        } catch {}
      }, 100);
    }
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
      const filterContainer = f ? f.closest('.sora-uv-filter-container') : null;
      const g = bar.querySelector('.sora-uv-gather-btn');
      if (filterContainer) filterContainer.style.display = '';
      if (g) g.style.display = '';
    }

    updateControlsVisibility();
  }

  function toggleAnalyzeMode() {
    if (isDrafts()) return; // Don't allow Analyze mode on Drafts page
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
      // If we're not on a page where filters apply, don't hide anything.
      // Apply filters on Profile and all Explore feeds.
      // Sora may update the URL to `/explore` while still showing the same Explore tab (top/latest/following),
      // so do not rely on `feed=top` being present to decide whether filtering should apply.
      // Also apply on Post routes: opening a post from Explore often updates the URL to `/p/...` while the
      // Explore grid remains mounted underneath a modal, and we want to keep the filtered view stable.
      if ((!isProfile() && !isExplore() && !isPost()) || limitMin == null || isGatheringActiveThisTab) {
        card.style.display = '';
        continue;
      }

      if (limitMin === 'no_remixes') {
        // Only meaningful on Explore/Post (modal-over-explore); elsewhere don't hide.
        if (!isExplore() && !isPost()) {
          card.style.display = '';
          continue;
        }
        const rx = idToRemixes.get(id);
        // Show only posts we definitively know have zero remixes.
        // If remix count is unknown yet, hide until data arrives (like time filters).
        const nRx = Number(rx);
        const show = Number.isFinite(nRx) && nRx === 0;
        card.style.display = show ? '' : 'none';
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
      gatherTimerEl.textContent = `Refreshing in ${fmtRefreshCountdown(remainingMs)}`;
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
      const refreshMs = 10 * 60 * 1000;
      const TOP_PX_PER_STEP = 7; //  67% of 10.66 (33% slower)

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
    const PPS_SLOW = 100;    // px/s at far left
    const PPS_MID = 900;   // px/s mid
    const PPS_FAST = 1800;    // px/s far right

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
    const speedFast = { rMin: 5 * 60000,  rMax: 6 * 60000 };

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

  function looksLikePostDetail(json) {
    try {
      // Post detail has structure: { post: {...}, profile: {...}, remix_posts: {...}, ancestors: {...} }
      const p = json?.post;
      if (!p || typeof p !== 'object') return false;
      
      // Check if it has typical post fields
      if (typeof p?.id === 'string' && /^s_[A-Za-z0-9]+$/.test(p.id)) return true;
      if (p?.unique_view_count != null || p?.view_count != null) return true;
      if (Array.isArray(p?.attachments) && p.attachments.length) return true;
      
      return false;
    } catch {
      return false;
    }
  }

  function decorateDraftsResponse(res) {
    if (!res || typeof res.json !== 'function' || res._soraUvDraftsPatched) return res;
    res._soraUvDraftsPatched = true;

    const origJson = res.json.bind(res);
    res.json = async () => {
      const data = await origJson();
      return normalizeDraftsJsonForDownload(data);
    };

    const origClone = typeof res.clone === 'function' ? res.clone.bind(res) : null;
    if (origClone) {
      res.clone = () => {
        const cloned = origClone();
        try {
          decorateDraftsResponse(cloned);
        } catch {}
        return cloned;
      };
    }
    return res;
  }

  // If pending v2 is unavailable, we can still populate drafts metadata by calling the drafts endpoint directly.
  // Throttle to avoid spamming in case Sora repeatedly polls a broken endpoint.
  const DRAFTS_BACKUP_THROTTLE_MS = 15000;
  let draftsBackupInFlight = false;
  let draftsBackupLastAttemptMs = 0;
  function scheduleDraftsBackupFetch(reason) {
    try {
      if (!isDrafts()) return;
      const now = Date.now();
      if (draftsBackupInFlight) return;
      if (now - draftsBackupLastAttemptMs < DRAFTS_BACKUP_THROTTLE_MS) return;
      draftsBackupLastAttemptMs = now;
      draftsBackupInFlight = true;
      const url = `${location.origin}/backend/project_y/profile/drafts?limit=15`;
      fetch(url).catch(() => {}).finally(() => { draftsBackupInFlight = false; });
      dlog('drafts', 'scheduled drafts backup fetch', { reason });
    } catch {}
  }

  function installFetchSniffer() {
    dlog('feed', 'install fetch sniffer');
    const isLikelyJsonResponse = (res) => {
      try {
        const ct = String(res?.headers?.get?.('content-type') || '').toLowerCase();
        return ct.includes('application/json') || ct.includes('+json');
      } catch {
        return false;
      }
    };
    const origFetch = window.fetch;
    window.fetch = async function (input, init) {
      const res = await origFetch.apply(this, arguments);
      try {
        if (isDraftDetail()) return res;
        const url = typeof input === 'string' ? input : input?.url || '';

        // Intercept /backend/nf/create to capture task_id -> source draft mapping for draft remixes
        if (NF_CREATE_RE.test(url)) {
          // Only capture if we're on a draft remix page (/d/{genId}?remix=)
          const draftRemixMatch = location.pathname.match(/^\/d\/([A-Za-z0-9_-]+)/i);
          if (draftRemixMatch && location.search.includes('remix')) {
            const sourceDraftId = draftRemixMatch[1];
            res.clone().json().then((json) => {
              const taskId = json?.id;
              if (taskId && sourceDraftId) {
                saveTaskToSourceDraft(taskId, sourceDraftId);
                dlog('drafts', `Saved task->draft mapping: ${taskId} -> ${sourceDraftId}`);
              }
            }).catch(() => {});
          }
        }

        // Pending tasks (v2): used by Sora to show running gens; parse to hydrate prompts/drafts.
        if (NF_PENDING_V2_RE.test(url)) {
          if (!res.ok) scheduleDraftsBackupFetch('pending_v2_not_ok');
          res.clone().json().then(processPendingV2Json).catch(() => {
            scheduleDraftsBackupFetch('pending_v2_parse_failed');
          });
          return res;
        }

        // Check POST_DETAIL_RE, DRAFTS_RE and CHARACTERS_RE before FEED_RE since they would also match FEED_RE
        if (POST_DETAIL_RE.test(url)) {
          dlog('feed', 'fetch matched post detail', { url });
          rememberPostDetailTemplate(url);
          res.clone().json().then((j) => {
            dlog('feed', 'post detail parsed', { url, hasPost: !!j?.post, hasRemixes: !!j?.remix_posts?.items });
            processPostDetailJson(j);
          }).catch((err) => {
            console.error('[SoraUV] Error parsing post detail fetch response:', err);
          });
        } else if (CHARACTERS_RE.test(url)) {
          res.clone().json().then(processCharactersJson).catch((err) => {
            console.error('[SoraUV] Error parsing characters fetch response:', err);
          });
        } else if (DRAFTS_RE.test(url)) {
          decorateDraftsResponse(res);
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
          // Avoid cloning/parsing bodies for non-JSON same-origin requests (can be very expensive on /d/...).
          if (isLikelyJsonResponse(res)) {
            res
              .clone()
              .json()
              .then((j) => {
                if (looksLikePostDetail(j)) {
                  dlog('feed', 'fetch autodetected post detail', { url, hasPost: !!j?.post });
                  processPostDetailJson(j);
                } else if (looksLikeSoraFeed(j)) {
                  dlog('feed', 'fetch autodetected feed', { url, items: (j?.items || j?.data?.items || []).length });
                  processFeedJson(j);
                }
              })
              .catch(() => {});
          }
        }
      } catch {}
      return res;
    };
    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.addEventListener('load', function () {
        try {
          if (isDraftDetail()) return;
            if (typeof url === 'string') {
              // Intercept /backend/nf/create for draft remix tracking
              if (NF_CREATE_RE.test(url)) {
                const draftRemixMatch = location.pathname.match(/^\/d\/([A-Za-z0-9_-]+)/i);
                if (draftRemixMatch && location.search.includes('remix')) {
                const sourceDraftId = draftRemixMatch[1];
                try {
                  const json = JSON.parse(this.responseText);
                  const taskId = json?.id;
                  if (taskId && sourceDraftId) {
                    saveTaskToSourceDraft(taskId, sourceDraftId);
                    dlog('drafts', `Saved task->draft mapping (XHR): ${taskId} -> ${sourceDraftId}`);
                  }
                } catch {}
                }
              }

              // Pending tasks (v2): parse to hydrate prompts/drafts; fall back to drafts endpoint if unavailable.
              if (NF_PENDING_V2_RE.test(url)) {
                if (this.status && this.status >= 400) scheduleDraftsBackupFetch('pending_v2_xhr_not_ok');
                try {
                  processPendingV2Json(JSON.parse(this.responseText));
                } catch {
                  scheduleDraftsBackupFetch('pending_v2_xhr_parse_failed');
                }
                return;
              }

              // Check POST_DETAIL_RE, CHARACTERS_RE and DRAFTS_RE before FEED_RE since they would also match FEED_RE
              if (POST_DETAIL_RE.test(url)) {
                dlog('feed', 'xhr matched post detail', { url });
                rememberPostDetailTemplate(url);
                try {
                const j = JSON.parse(this.responseText);
                dlog('feed', 'post detail parsed (XHR)', { url, hasPost: !!j?.post, hasRemixes: !!j?.remix_posts?.items });
                processPostDetailJson(j);
              } catch (err) {
                console.error('[SoraUV] Error parsing post detail XHR:', err);
              }
            } else if (CHARACTERS_RE.test(url)) {
              try {
                processCharactersJson(JSON.parse(this.responseText));
              } catch (err) {
                console.error('[SoraUV] Error parsing characters XHR:', err);
              }
            } else if (DRAFTS_RE.test(url)) {
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
                const ct = String(this.getResponseHeader('content-type') || '').toLowerCase();
                if (ct.includes('application/json') || ct.includes('+json')) {
                  const j = JSON.parse(this.responseText);
                  if (looksLikePostDetail(j)) {
                    dlog('feed', 'xhr autodetected post detail', { url, hasPost: !!j?.post });
                    processPostDetailJson(j);
                  } else if (looksLikeSoraFeed(j)) {
                    dlog('feed', 'xhr autodetected feed', { url, items: (j?.items || j?.data?.items || []).length });
                    processFeedJson(j);
                  }
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

      // Safety check: ensure we don't process comments/replies as if they were the main post
      // This happens because comments often contain the post_id they belong to, and getItemId finds it via deep search
      const rawP = it?.post || it || {};
      if (rawP.id !== id) {
        const refs = [
          rawP.post_id,
          rawP.parent_post_id,
          rawP.root_post_id,
          rawP.source_post_id,
          rawP.remix_target_post_id,
        ];
        if (refs.some((r) => typeof r === 'string' && r === id)) continue;
      }

      const uv = getUniqueViews(it);
      const likes = getLikes(it);
      const tv = getTotalViews(it);
      const cm = getComments(it);
      const rx = getRemixes(it);
      const cx = getCameos(it);
      const cameoUsernames = getCameoUsernames(it);
      if (cameoUsernames && cameoUsernames.length > 0) {
        dlog('feed', 'extracted cameo usernames', { id, cameoUsernames, itemKeys: Object.keys(it || {}), postKeys: Object.keys(it?.post || {}) });
      } else {
        // Debug: log the structure to see what fields are available
        const p = it?.post || it || {};
        const castRelatedKeys = Object.keys(p || {}).filter(k => 
          k.toLowerCase().includes('cast') || k.toLowerCase().includes('cameo'));
        if (castRelatedKeys.length > 0) {
          dlog('feed', 'found cast-related keys but no usernames extracted', { 
            id, 
            castRelatedKeys,
            sampleValues: castRelatedKeys.slice(0, 3).map(k => ({ key: k, value: p[k], type: typeof p[k] }))
          });
        }
      }
      const p = it?.post || it || {};
      const created_at =
        p?.created_at ?? p?.uploaded_at ?? p?.createdAt ?? p?.created ?? p?.posted_at ?? p?.timestamp ?? null;
      const caption =
        (typeof p?.caption === 'string' && p.caption) ? p.caption : (typeof p?.text === 'string' && p.text ? p.text : null);
      const ageMin = minutesSince(created_at);
      const th = getThumbnail(it);

      // Extract video duration from n_frames (Sora uses 30 fps for published posts)
      try {
        let nFrames = null;
        let width = null;
        let height = null;

        // Strategy 1: attachments
        const attachments = Array.isArray(p?.attachments) ? p.attachments : null;
        if (attachments && attachments.length > 0) {
          const att = attachments[0];
          if (att?.n_frames != null) nFrames = Number(att.n_frames);
          if (att?.width != null) width = Number(att.width);
          if (att?.height != null) height = Number(att.height);
          
          if (DEBUG.feed && nFrames == null) {
             dlog('feed', 'attachments found but n_frames missing', { id, attKeys: Object.keys(att) });
          }
        } else if (DEBUG.feed) {
           dlog('feed', 'no attachments found', { id, pKeys: Object.keys(p || {}) });
        }

        // Strategy 2: creation_config (seen in drafts, maybe in feed too)
        if (nFrames == null) {
          const cc = p?.creation_config || it?.creation_config;
          if (cc) {
            if (cc.n_frames != null) nFrames = Number(cc.n_frames);
          }
        }

        // Strategy 3: video_metadata or direct
        if (nFrames == null || isNaN(nFrames)) {
             if (p?.n_frames != null) nFrames = Number(p.n_frames);
             
             // Check video_metadata
             if ((nFrames == null || isNaN(nFrames)) && p?.video_metadata) {
               if (p.video_metadata.n_frames != null) nFrames = Number(p.video_metadata.n_frames);
             }
        }

        if (typeof nFrames === 'number' && !isNaN(nFrames) && nFrames > 0) {
          // Published posts use 30 fps
          const duration = nFrames / 30;
          idToDuration.set(id, duration);
        } else if (DEBUG.feed) {
           // Log when we fail to extract frames, to help debug
           dlog('feed', 'failed to extract frames', { 
             id, 
             hasAttachments: !!(p?.attachments && p.attachments.length),
             hasCreationConfig: !!(p?.creation_config || it?.creation_config),
             keys: Object.keys(p || {})
           });
        }

        if (typeof width === 'number' && typeof height === 'number') {
          idToDimensions.set(id, { width, height });
        }
      } catch (e) {
        // Ignore extraction errors
      }

      // Helper to safely update metrics, respecting locks and avoiding zero overwrites
      const updateMetric = (map, val) => {
        if (val == null) return;
        const existing = map.get(id);
        const isLocked = lockedPostIds.has(id);

        // Allow zero for comments/remixes (legit "no activity") and for likes when we also
        // have another primary metric in this packet. Keep guarding UV/views zeros to avoid
        // placeholder/stale packets.
        if (val === 0 && existing == null) {
          const allowZero =
            map === idToComments ||
            map === idToRemixes ||
            (map === idToLikes && (uv != null || tv != null));
          if (!allowZero) return;
        }

        if (isLocked) {
          // For locked posts, only allow improvements (greater than existing)
          if (existing == null || val > existing) {
            map.set(id, val);
          }
        } else {
          // For unlocked posts, allow typical improvements / first set
          if (existing == null || val > existing || (existing === 0 && val > 0)) {
            map.set(id, val);
          }
        }
      };

      updateMetric(idToUnique, uv);
      updateMetric(idToLikes, likes);
      updateMetric(idToViews, tv);
      updateMetric(idToComments, cm);
      updateMetric(idToRemixes, rx);

      const absUrl = `${location.origin}/p/${id}`;
      const owner = getOwner(it);
      const userHandle = owner.handle || pageUserHandle || null;
      const userId = owner.id || null;

      // store owner with meta so Analyze can render "<owner> • <caption>"
      // Respect locks so the current post's meta (age/timestamp) is not overwritten by other packets
      const isLockedMeta = lockedPostIds.has(id);
      const existingMeta = idToMeta.get(id);
      let shouldUpdateMeta = true;
      if (isLockedMeta) {
        shouldUpdateMeta = false;
      } else if (existingMeta && Number.isFinite(existingMeta.ageMin) && Number.isFinite(ageMin)) {
        // Prevent overwriting with a significantly smaller ageMin (would make post appear newer)
        // This protects against ancestors/related posts corrupting the main post's timestamp
        // A post's age should only increase over time, never decrease significantly
        if (existingMeta.ageMin > ageMin + 5) {
          // The new ageMin is smaller - post would appear younger
          // Only allow this if the difference is very small (natural variance)
          shouldUpdateMeta = false;
          dlog('feed', 'prevented meta update - new ageMin smaller than existing', {
            id,
            existingAgeMin: existingMeta.ageMin,
            newAgeMin: ageMin,
            diff: existingMeta.ageMin - ageMin
          });
        }
      }

      if (shouldUpdateMeta) {
        idToMeta.set(id, { ageMin, userHandle });
      }

      const userKey = userHandle ? `h:${userHandle.toLowerCase()}` : userId != null ? `id:${userId}` : pageUserKey;
      const followers = getFollowerCount(it);

      // Get duration and dimensions that were just extracted above
      const duration = idToDuration.get(id);
      const dimensions = idToDimensions.get(id);

      batch.push({
        postId: id,
        uv,
        likes,
        views: tv,
        comments: cm,
        remixes: rx,
        remix_count: rx,
        cameos: cx,
        cameo_usernames: cameoUsernames,
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
        duration: duration || null,
        width: dimensions?.width || null,
        height: dimensions?.height || null,
      });
      
      // Also process remix_posts (child remixes) to make their data available when clicked
      // remix_posts can be either an array OR an object with items array
      const remixPostsData = p?.remix_posts || it?.remix_posts;
      const remixPosts = Array.isArray(remixPostsData) 
        ? remixPostsData 
        : (Array.isArray(remixPostsData?.items) ? remixPostsData.items : []);
      
      if (remixPosts.length > 0) {
        for (const remixItem of remixPosts) {
          const remixId = getItemId(remixItem);
          if (!remixId) continue;
          
          // Extract all the same data for the remix post
          const remixUv = getUniqueViews(remixItem);
          const remixLikes = getLikes(remixItem);
          const remixTv = getTotalViews(remixItem);
          const remixCm = getComments(remixItem);
          const remixRx = getRemixes(remixItem);
          const remixCx = getCameos(remixItem);
          const remixCameoUsernames = getCameoUsernames(remixItem);
          
          const remixP = remixItem?.post || remixItem || {};
          const remixCreatedAt = remixP?.created_at ?? remixP?.uploaded_at ?? remixP?.createdAt ?? remixP?.created ?? remixP?.posted_at ?? remixP?.timestamp ?? null;
          const remixCaption = (typeof remixP?.caption === 'string' && remixP.caption) ? remixP.caption : (typeof remixP?.text === 'string' && remixP.text ? remixP.text : null);
          const remixAgeMin = minutesSince(remixCreatedAt);
          const remixTh = getThumbnail(remixItem);
          
          // Extract duration and dimensions for remix
          try {
            let remixNFrames = null;
            let remixWidth = null;
            let remixHeight = null;
            
            const remixAttachments = Array.isArray(remixP?.attachments) ? remixP.attachments : null;
            if (remixAttachments && remixAttachments.length > 0) {
              const att = remixAttachments[0];
              if (att?.n_frames != null) remixNFrames = Number(att.n_frames);
              if (att?.width != null) remixWidth = Number(att.width);
              if (att?.height != null) remixHeight = Number(att.height);
            }
            
            if (remixNFrames == null) {
              const cc = remixP?.creation_config || remixItem?.creation_config;
              if (cc && cc.n_frames != null) remixNFrames = Number(cc.n_frames);
            }
            
            if (remixNFrames == null || isNaN(remixNFrames)) {
              if (remixP?.n_frames != null) remixNFrames = Number(remixP.n_frames);
              if ((remixNFrames == null || isNaN(remixNFrames)) && remixP?.video_metadata) {
                if (remixP.video_metadata.n_frames != null) remixNFrames = Number(remixP.video_metadata.n_frames);
              }
            }
            
            if (typeof remixNFrames === 'number' && !isNaN(remixNFrames) && remixNFrames > 0) {
              const remixDuration = remixNFrames / 30;
              idToDuration.set(remixId, remixDuration);
            }
            
            if (typeof remixWidth === 'number' && typeof remixHeight === 'number') {
              idToDimensions.set(remixId, { width: remixWidth, height: remixHeight });
            }
          } catch (e) {
            // Ignore extraction errors
          }
          
          // Store in Maps - only update if we don't have data OR new data is better
          // Remixes are not locked, but still avoid zero overwrites
          const updateRemixMetric = (map, val) => {
            if (val == null) return;
            const existing = map.get(remixId);
            if (existing == null || val > existing || (existing === 0 && val > 0)) {
              map.set(remixId, val);
            }
          };

          updateRemixMetric(idToUnique, remixUv);
          updateRemixMetric(idToLikes, remixLikes);
          updateRemixMetric(idToViews, remixTv);
          updateRemixMetric(idToComments, remixCm);
          updateRemixMetric(idToRemixes, remixRx);
          
          const remixAbsUrl = `${location.origin}/p/${remixId}`;
          const remixOwner = getOwner(remixItem);
          const remixUserHandle = remixOwner.handle || pageUserHandle || null;
          const remixUserId = remixOwner.id || null;
          
          // Meta for remixes; not locked, but avoid overwriting if already set with a higher-quality value
          const existingRemixMeta = idToMeta.get(remixId);
          if (!existingRemixMeta) {
            idToMeta.set(remixId, { ageMin: remixAgeMin, userHandle: remixUserHandle });
          }
          
          const remixUserKey = remixUserHandle ? `h:${remixUserHandle.toLowerCase()}` : remixUserId != null ? `id:${remixUserId}` : pageUserKey;
          const remixFollowers = getFollowerCount(remixItem);
          
          const remixDuration = idToDuration.get(remixId);
          const remixDimensions = idToDimensions.get(remixId);
          
          batch.push({
            postId: remixId,
            uv: remixUv,
            likes: remixLikes,
            views: remixTv,
            comments: remixCm,
            remixes: remixRx,
            remix_count: remixRx,
            cameos: remixCx,
            cameo_usernames: remixCameoUsernames,
            followers: remixFollowers,
            created_at: remixCreatedAt,
            caption: remixCaption,
            ageMin: remixAgeMin,
            thumb: remixTh,
            url: remixAbsUrl,
            ts: Date.now(),
            userHandle: remixUserHandle,
            userId: remixUserId,
            userKey: remixUserKey,
            parent_post_id: remixP?.parent_post_id ?? id, // Link to parent
            root_post_id: remixP?.root_post_id ?? null,
            pageUserHandle,
            pageUserKey,
            duration: remixDuration || null,
            width: remixDimensions?.width || null,
            height: remixDimensions?.height || null,
          });
        }
      }
    }

    if (batch.length)
      try {
        window.postMessage({ __sora_uv__: true, type: 'metrics_batch', items: batch }, '*');
      } catch {}

    renderBadges();
    if (!suppressDetailBadgeRender) {
      renderDetailBadge();
    }
    renderProfileImpact();
  }

  function processPostDetailJson(json) {
    // Process post detail page response (e.g., /posts/{id}/tree)
    // Structure: { post: {...}, profile: {...}, remix_posts: {items: [...]}, ancestors: {items: [...]}, parent_post: {...}, children: {items: [...]} }
    
    const mainPostId = json?.post?.id;
    const currentSid = currentSIdFromURL();
    const isCurrentPost = !!(mainPostId && currentSid && mainPostId === currentSid);
    if (mainPostId && processedPostDetailIds.has(mainPostId) && isCurrentPost) {
      dlog('feed', 'processPostDetailJson skipped (already processed current)', { postId: mainPostId, currentSid });
      return;
    }
    dlog('feed', 'processPostDetailJson', { 
      hasPost: !!json?.post, 
      postId: mainPostId,
      currentSid,
      isCurrentPost,
      hasRemixes: !!json?.remix_posts?.items?.length,
      hasAncestors: !!json?.ancestors?.items?.length 
    });
    
    // Suppress renderDetailBadge during bulk processing to prevent flickering/wrong data
    suppressDetailBadgeRender = true;
    
    try {
      // Process the main post FIRST and LOCK it to prevent remix/ancestor data from overwriting it
      if (json?.post && mainPostId) {
        // For the CURRENT post, clear any stale meta before processing to ensure
        // fresh data from the API response is always used. This fixes the bug where
        // navigating original -> remix -> back to original could show stale timestamp
        // data from when the original was processed as an ancestor.
        if (isCurrentPost) {
          idToMeta.delete(mainPostId);
          dlog('feed', 'cleared stale meta for current post before processing', { id: mainPostId });
        }
        
        const postWrapper = { post: json.post };
        if (json.profile) {
          postWrapper.profile = json.profile;
        }
        processFeedJson({ items: [postWrapper] });
        
        // Lock this post's data only if it matches the currently viewed post
        if (isCurrentPost) {
          lockedPostIds.add(mainPostId);
          processedPostDetailIds.add(mainPostId);
          
          dlog('feed', 'processed and LOCKED current main post', { 
            id: mainPostId, 
            uv: json.post.unique_view_count,
            likes: json.post.like_count,
            stored_uv: idToUnique.get(mainPostId),
            stored_likes: idToLikes.get(mainPostId),
            stored_meta: idToMeta.get(mainPostId)
          });
        } else {
          dlog('feed', 'processed main post (not current, not locked)', { id: mainPostId, currentSid });
        }
      }
      
      // Now process other data (their data can still be stored, but won't overwrite locked posts)
      
      // Process ancestors (these are parent posts in the chain)
      if (json?.ancestors?.items && Array.isArray(json.ancestors.items)) {
        processFeedJson({ items: json.ancestors.items });
        dlog('feed', 'processed ancestors', { count: json.ancestors.items.length });
      }
      
      // Process parent_post (immediate parent)
      if (json?.parent_post) {
        processFeedJson({ items: [json.parent_post] });
        dlog('feed', 'processed parent_post');
      }
      
      // Process remix_posts (child remixes - these should NOT affect the main post)
      if (json?.remix_posts?.items && Array.isArray(json.remix_posts.items)) {
        processFeedJson({ items: json.remix_posts.items });
        dlog('feed', 'processed remix_posts', { count: json.remix_posts.items.length });
      }
      
      // Skip children (replies/comments). We only collect posts and remixes.
      if (json?.children?.items && Array.isArray(json.children.items)) {
        dlog('feed', 'skipped children (comments)', { count: json.children.items.length });
      }
      
      // Verify main post data is still correct after all processing
      if (mainPostId) {
        dlog('feed', 'After all processing - main post data', {
          id: mainPostId,
          stored_uv: idToUnique.get(mainPostId),
          stored_likes: idToLikes.get(mainPostId),
          stored_remixes: idToRemixes.get(mainPostId)
        });
      }
    } finally {
      // Re-enable rendering and trigger a single render with all data loaded
      suppressDetailBadgeRender = false;
      renderDetailBadge();
      dlog('feed', 'processPostDetailJson complete, rendered badges');
    }
  }

  function looksLikePendingV2Task(item) {
    if (!item || typeof item !== 'object') return false;
    const id = item?.id;
    const status = item?.status;
    const hasGenerationsArray = Array.isArray(item?.generations);
    return typeof id === 'string' && id.startsWith('task_') && typeof status === 'string' && hasGenerationsArray;
  }

  function extractDraftItemsFromPayload(json) {
    if (!json) return [];

    // Pending v2: array of tasks with nested `generations`
    if (Array.isArray(json)) {
      const isPendingV2 = json.some(looksLikePendingV2Task);
      if (!isPendingV2) return json;

      const gens = [];
      for (const task of json) {
        if (!looksLikePendingV2Task(task)) continue;
        const taskId = task?.id;
        const taskPrompt = typeof task?.prompt === 'string' ? task.prompt : null;
        if (taskId && taskPrompt) taskToPrompt.set(taskId, taskPrompt);

        const taskGens = Array.isArray(task?.generations) ? task.generations : [];
        for (const gen of taskGens) {
          if (!gen || typeof gen !== 'object') continue;

          // Annotate generations with their originating task for downstream draft-remix mapping.
          if (taskId && gen.task_id == null) gen.task_id = taskId;

          // Pending v2 tasks include `prompt`; drafts payloads often include it under `creation_config.prompt`.
          if (taskPrompt) {
            const cc = gen?.creation_config;
            if (!cc || typeof cc !== 'object') gen.creation_config = {};
            if (!gen.creation_config.prompt) gen.creation_config.prompt = taskPrompt;
          }

          gens.push(gen);
        }
      }
      return gens;
    }

    // Drafts endpoint: { items: [...] } (sometimes wrapped), plus legacy shapes.
    const items = json?.items || json?.data?.items || json?.generations || [];
    return Array.isArray(items) ? items : [];
  }

  function processPendingV2Json(json) {
    const gens = extractDraftItemsFromPayload(json);
    if (!Array.isArray(gens) || gens.length === 0) return;

    // Reuse draft processing pipeline.
    processDraftsJson({ generations: gens });
  }

  function processDraftsJson(json) {
    // Extract draft data from API response
    const items = extractDraftItemsFromPayload(json);
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
        const taskIdForPrompt = item?.task_id;
        const prompt =
          (typeof item?.creation_config?.prompt === 'string' && item.creation_config.prompt) ||
          (typeof item?.prompt === 'string' && item.prompt) ||
          (taskIdForPrompt && taskToPrompt.has(taskIdForPrompt) ? taskToPrompt.get(taskIdForPrompt) : null);
        if (prompt && typeof prompt === 'string') {
          idToPrompt.set(draftId, prompt);
        }

        // Normalize best download URL for both Sora-native button and our buttons
        const downloadUrl = applyBestDownloadUrlToItem(item);
        if (downloadUrl) idToDownloadUrl.set(draftId, downloadUrl);

        // Extract content violation status
        if (item?.kind === 'sora_content_violation') {
          idToViolation.set(draftId, true);
        } else {
          idToViolation.set(draftId, false);
        }

        // Extract remix target post ID if this is a remix of a post
        const remixTargetPostId = item?.creation_config?.remix_target_post?.post?.id;
        if (remixTargetPostId && typeof remixTargetPostId === 'string') {
          idToRemixTarget.set(draftId, remixTargetPostId);
        }

        // Check if this draft is a remix of another draft (only if not already mapped)
        if (!idToRemixTargetDraft.has(draftId)) {
          const taskId = item?.task_id;
          if (taskId && taskToSourceDraft.has(taskId)) {
            const sourceDraftId = taskToSourceDraft.get(taskId);
            idToRemixTargetDraft.set(draftId, sourceDraftId);
            dlog('drafts', `Mapped draft ${draftId} -> source draft ${sourceDraftId}`);
          }
        }
      } catch (e) {
        console.error('[SoraUV] Error processing draft item:', e);
      }
    }

    // Trigger render to show all draft buttons and badges
    renderDraftButtons();
  }

  function normalizeDraftsJsonForDownload(json) {
    try {
      const items = extractDraftItemsFromPayload(json);
      if (!Array.isArray(items)) return json;
      for (const item of items) {
        applyBestDownloadUrlToItem(item);
      }
    } catch (e) {
      console.error('[SoraUV] Error normalizing drafts JSON for download:', e);
    }
    return json;
  }

  function processCharactersJson(json) {
    // Extract character data from API response
    const items = json?.items || [];
    if (!Array.isArray(items) || items.length === 0) return;

    dlog('characters', `Processing ${items.length} characters`);

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      try {
        const userId = item?.user_id;
        const username = item?.username;
        if (!userId) continue;

        // Store username -> userId mapping
        if (username) {
          usernameToUserId.set(username.toLowerCase(), userId);
        }

        // Store original index for date sorting (only if not already stored)
        if (!charToOriginalIndex.has(userId)) {
          charToOriginalIndex.set(userId, charGlobalIndexCounter++);
        }

        // Extract character stats
        if (typeof item.cameo_count === 'number') {
          charToCameoCount.set(userId, item.cameo_count);
        }
        if (typeof item.likes_received_count === 'number') {
          charToLikesCount.set(userId, item.likes_received_count);
        }
        if (typeof item.can_cameo === 'boolean') {
          charToCanCameo.set(userId, item.can_cameo);
        }
        // Extract created_at for likes per day calculation
        const createdAt = item?.created_at ?? item?.createdAt ?? item?.created ?? null;
        if (createdAt) {
          charToCreatedAt.set(userId, createdAt);
        }

        dlog('characters', `Character: ${username} (${userId}) - ${item.cameo_count} cameos, ${item.likes_received_count} likes, can_cameo: ${item.can_cameo}, created_at: ${createdAt}`);
      } catch (e) {
        console.error('[SoraUV] Error processing character item:', e);
      }
    }

    // Trigger render to show character stats (this will also handle re-sorting)
    renderCharacterStats();
  }

  function addCharacterSortButton() {
    // Find the Characters dialog header by looking for dialog with "Characters" title
    const dialog = document.querySelector('div[role="dialog"]');
    if (!dialog) {
      // Dialog closed, reset button reference
      characterSortBtn = null;
      return;
    }

    // Check if button already exists
    if (dialog.querySelector('.sora-uv-char-sort-btn')) return;

    // Find the header by text content
    const dialogHeader = Array.from(dialog.querySelectorAll('h2')).find(h => h.textContent === 'Characters');
    if (!dialogHeader) return;

    const headerContainer = dialogHeader.parentElement;
    if (!headerContainer) return;

    // Create custom dropdown container
    const dropdownContainer = document.createElement('div');
    dropdownContainer.className = 'sora-uv-char-sort-dropdown';
    Object.assign(dropdownContainer.style, {
      position: 'relative',
      marginTop: '4px'
    });

    // Create button
    characterSortBtn = document.createElement('button');
    characterSortBtn.className = 'sora-uv-char-sort-btn';
    Object.assign(characterSortBtn.style, {
      background: 'rgba(29,29,29,0.78)',
      color: '#fff',
      border: 'none',
      borderRadius: '12px',
      padding: '6px 12px',
      fontSize: '12px',
      fontWeight: '600',
      cursor: 'pointer',
      transition: 'background 0.2s',
      display: 'flex',
      alignItems: 'center',
      gap: '6px'
    });

    const updateButtonText = () => {
      const labels = {
        'date': 'Sort: Date',
        'likes': 'Sort: Likes',
        'likesPerDay': 'Sort: Likes/Day',
        'cameos': 'Sort: Cameos'
      };
      characterSortBtn.textContent = labels[characterSortMode] || 'Sort';
      characterSortBtn.appendChild(arrow);
    };

    // Create arrow icon
    const arrow = document.createElement('span');
    arrow.textContent = '▼';
    arrow.style.fontSize = '10px';

    updateButtonText();

    // Create dropdown menu
    const dropdownMenu = document.createElement('div');
    dropdownMenu.className = 'sora-uv-char-sort-menu';
    Object.assign(dropdownMenu.style, {
      position: 'absolute',
      top: '100%',
      left: '0',
      marginTop: '4px',
      background: 'rgba(29,29,29,0.95)',
      borderRadius: '12px',
      padding: '4px',
      display: 'none',
      flexDirection: 'column',
      gap: '2px',
      minWidth: '140px',
      zIndex: '1000',
      boxShadow: '0 4px 12px rgba(0,0,0,0.5)'
    });

    // Add options to dropdown
    const options = [
      { value: 'date', label: 'Date' },
      { value: 'likes', label: 'Likes' },
      { value: 'likesPerDay', label: 'Likes/Day' },
      { value: 'cameos', label: 'Cameos' }
    ];

    options.forEach(opt => {
      const option = document.createElement('button');
      option.textContent = opt.label;
      option.className = 'sora-uv-char-sort-option';
      Object.assign(option.style, {
        background: 'transparent',
        color: '#fff',
        border: 'none',
        borderRadius: '8px',
        padding: '8px 12px',
        fontSize: '12px',
        cursor: 'pointer',
        textAlign: 'left',
        transition: 'background 0.2s'
      });

      option.addEventListener('mouseenter', () => {
        option.style.background = 'rgba(255,255,255,0.1)';
      });

      option.addEventListener('mouseleave', () => {
        option.style.background = 'transparent';
      });

      option.addEventListener('click', (e) => {
        e.stopPropagation();
        characterSortMode = opt.value;
        updateButtonText();
        dropdownMenu.style.display = 'none';
        sortCharacterList();
      });

      dropdownMenu.appendChild(option);
    });

    // Toggle dropdown on button click
    characterSortBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isVisible = dropdownMenu.style.display === 'flex';
      dropdownMenu.style.display = isVisible ? 'none' : 'flex';
    });

    // Close dropdown when clicking outside
    document.addEventListener('click', () => {
      if (dropdownMenu) {
        dropdownMenu.style.display = 'none';
      }
    });

    dropdownContainer.appendChild(characterSortBtn);
    dropdownContainer.appendChild(dropdownMenu);
    headerContainer.appendChild(dropdownContainer);
  }

  function sortCharacterList() {
    // Find the character list container
    const listContainer = document.querySelector('div[role="dialog"] .flex.flex-col.gap-1');
    if (!listContainer) return;

    // Get all character link elements
    const characterLinks = Array.from(listContainer.querySelectorAll('a[href^="/profile/"]'));
    if (characterLinks.length === 0) return;

    // Create array of {element, username, stats} for sorting
    const charactersData = characterLinks.map(link => {
      const href = link.getAttribute('href');
      const match = href?.match(/\/profile\/([^/?]+)/);
      if (!match) return null;

      const username = match[1];
      const userId = usernameToUserId.get(username.toLowerCase());

      const likes = userId ? (charToLikesCount.get(userId) || 0) : 0;
      const createdAt = userId ? charToCreatedAt.get(userId) : null;
      let likesPerDay = 0;
      if (createdAt && likes > 0) {
        // createdAt is a Unix timestamp in seconds, convert to milliseconds
        const created = new Date(createdAt * 1000);
        const now = new Date();
        const daysSinceCreation = Math.max(1, (now - created) / (1000 * 60 * 60 * 24));
        likesPerDay = likes / daysSinceCreation;
      }

      return {
        element: link,
        username,
        userId,
        likes,
        likesPerDay,
        cameos: userId ? (charToCameoCount.get(userId) || 0) : 0,
        originalIndex: userId ? (charToOriginalIndex.get(userId) ?? 9999) : 9999
      };
    }).filter(Boolean);

    // Sort based on current mode
    if (characterSortMode === 'likes') {
      charactersData.sort((a, b) => b.likes - a.likes);
    } else if (characterSortMode === 'likesPerDay') {
      charactersData.sort((a, b) => b.likesPerDay - a.likesPerDay);
    } else if (characterSortMode === 'cameos') {
      charactersData.sort((a, b) => b.cameos - a.cameos);
    } else if (characterSortMode === 'date') {
      // Sort by original index to restore default order
      charactersData.sort((a, b) => a.originalIndex - b.originalIndex);
    }

    // Reorder DOM elements
    charactersData.forEach(char => {
      listContainer.appendChild(char.element);
    });

    dlog('characters', `Sorted ${charactersData.length} characters by ${characterSortMode}`);
  }

	  function renderCharacterStats() {
	    // Only do work when we're actually in the Characters UI (dialog or characters page).
	    let dialog = null;
	    let inCharDialog = false;
	    try {
	      const anyCharLink = document.querySelector('div[role="dialog"] a[href^="/profile/"]');
	      dialog = anyCharLink?.closest?.('div[role="dialog"]') || null;
	      const headerText = dialog?.querySelector?.('h2, [role="heading"]')?.textContent || '';
	      inCharDialog = !!(dialog && /edit characters/i.test(headerText));
	      // On profile pages, the character dialog can get too narrow; enforce a min width once.
	      if (inCharDialog && !dialog.dataset.soraUvMinWidthSet) {
	        if (!dialog.style.minWidth) dialog.style.minWidth = '524px';
	        dialog.dataset.soraUvMinWidthSet = 'true';
	      }
	    } catch {}

	    const inCharactersPage = /\/characters($|\?)/i.test(`${location.pathname}${location.search || ''}`);
	    if (!inCharDialog && !inCharactersPage) return;

	    // Add sort button if dialog is open
	    addCharacterSortButton();

	    // Find all character links (prefer scoping to dialog when present)
	    const root = inCharDialog && dialog ? dialog : document;
	    const characterLinks = root.querySelectorAll('a[href^="/profile/"]');

	    let hasNewStats = false;

	    for (const link of characterLinks) {
      // Skip if we've already added stats to this link
      if (link.querySelector('.sora-uv-char-stats')) continue;

      // Extract username from href
      const href = link.getAttribute('href');
      const match = href?.match(/\/profile\/([^/?]+)/);
      if (!match) continue;

      const username = match[1];
      const userId = usernameToUserId.get(username.toLowerCase());
      if (!userId) continue;

      // Get stats from maps
      const cameoCount = charToCameoCount.get(userId);
      const likesCount = charToLikesCount.get(userId);
      const canCameo = charToCanCameo.get(userId);

      // Create stats container
      const statsContainer = document.createElement('div');
      statsContainer.className = 'sora-uv-char-stats';
      Object.assign(statsContainer.style, {
        display: 'flex',
        gap: '8px',
        fontSize: '12px',
        marginTop: '2px',
        color: '#a3a3a3',
        alignItems: 'center'
      });

      // Add cameo count
      if (typeof cameoCount === 'number') {
        const cameoStat = document.createElement('span');
        cameoStat.textContent = `${fmt(cameoCount)} cameo${cameoCount !== 1 ? 's' : ''}`;
        statsContainer.appendChild(cameoStat);

        // Add separator
        const sep1 = document.createElement('span');
        sep1.textContent = '•';
        sep1.style.color = '#525252';
        statsContainer.appendChild(sep1);
      }

      // Add likes count and likes per day
      if (typeof likesCount === 'number') {
        const likesStat = document.createElement('span');
        likesStat.textContent = `${fmt(likesCount)} like${likesCount !== 1 ? 's' : ''}`;
        statsContainer.appendChild(likesStat);

        // Calculate and add likes per day
        const createdAt = charToCreatedAt.get(userId);
        if (createdAt && likesCount > 0) {
          // createdAt is a Unix timestamp in seconds, convert to milliseconds
          const created = new Date(createdAt * 1000);
          const now = new Date();
          const daysSinceCreation = Math.max(1, (now - created) / (1000 * 60 * 60 * 24));
          const likesPerDay = likesCount / daysSinceCreation;

          const lpdStat = document.createElement('span');
          lpdStat.textContent = `(${fmt(Math.round(likesPerDay))}/day)`;
          lpdStat.style.color = '#737373';
          statsContainer.appendChild(lpdStat);
        }

        // Add separator if canCameo exists
        if (typeof canCameo === 'boolean') {
          const sep2 = document.createElement('span');
          sep2.textContent = '•';
          sep2.style.color = '#525252';
          statsContainer.appendChild(sep2);
        }
      }

      // Add can cameo badge
      if (typeof canCameo === 'boolean') {
        const cameoBadge = document.createElement('span');
        cameoBadge.textContent = canCameo ? '✓ Can cameo' : '✗ Cannot cameo';
        Object.assign(cameoBadge.style, {
          color: canCameo ? '#4ade80' : '#ef4444',
          fontWeight: '500'
        });
        statsContainer.appendChild(cameoBadge);
      }

      // Add stats container to the character item
      const nameContainer = link.querySelector('.flex.min-w-0.flex-1.flex-col');
      if (nameContainer && statsContainer.childNodes.length > 0) {
        nameContainer.appendChild(statsContainer);
        hasNewStats = true;
      }
    }

    // If we added new stats and we're in a sorted mode, re-sort the list
    if (hasNewStats && characterSortMode !== 'date') {
      // Use requestAnimationFrame to ensure DOM is updated before sorting
      requestAnimationFrame(() => {
        sortCharacterList();
      });
    }
  }

  // == Observers & Lifecycle ==
  function runRenderPass() {
    if (isDraftDetail()) return;
    const onExplore = isExplore();
    const onProfile = isProfile();
    const onPost = isPost();
    const onDrafts = isDrafts();
    const shouldRenderCards = onExplore || onProfile || onPost;

    if (shouldRenderCards) renderBadges();
    if (onPost) renderDetailBadge();
    else teardownDetailBadge();
    if (onProfile) renderProfileImpact();
    if (onDrafts) {
      renderBookmarkButtons();
      renderDraftButtons();
    }
    // Character stats only matters on profile/characters views; it does its own internal gating.
    if (location.pathname.includes('/profile')) renderCharacterStats();
    updateControlsVisibility();
    scheduleInjectDashboardButton();
  }

  const mo = new MutationObserver(() => {
    if (mo._raf) cancelAnimationFrame(mo._raf);
    mo._raf = requestAnimationFrame(() => {
      runRenderPass();
    });
  });

  let observersActive = false;

  function startObservers() {
    if (observersActive) return;
    observersActive = true;
    mo.observe(document.documentElement, { childList: true, subtree: true });
    runRenderPass();
  }

  function stopObservers() {
    if (!observersActive) return;
    observersActive = false;
    try {
      mo.disconnect();
    } catch {}
    try {
      if (mo._raf) cancelAnimationFrame(mo._raf);
    } catch {}
    mo._raf = null;
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
    if (isGatheringActiveThisTab && DEBUG.feed) dlog('feed', 'Route change — stopping gather for this tab.');
    isGatheringActiveThisTab = false;
    stopGathering(false);
    // Preserve any active filter across navigation; only stop gather state.
    const s = getGatherState() || {};
    s.isGathering = false;
    delete s.refreshDeadline;
    setGatherState(s);
    const bar = controlBar || ensureControlBar();
    if (bar && typeof bar.updateGatherState === 'function') bar.updateGatherState();
    if (bar && typeof bar.updateFilterLabel === 'function') bar.updateFilterLabel();
    if (analyzeActive) exitAnalyzeMode();
    applyFilter();
  }

  function resetFilterOnNavigation() {
    const s = getGatherState() || {};
    s.filterIndex = 0;
    s.isGathering = false;
    delete s.refreshDeadline;
    setGatherState(s);
    const bar = controlBar || ensureControlBar();
    if (bar && typeof bar.updateFilterLabel === 'function') bar.updateFilterLabel();
    applyFilter();
  }

  function routeKindFromRouteKey(rk) {
    const path = String(rk || '').split('?')[0] || '';
    if (path === '/explore' || path.startsWith('/explore/')) return 'explore';
    if (/^\/p\/s_[A-Za-z0-9]+/i.test(path)) return 'post';
    return 'other';
  }

  function shouldPreserveFilterAcrossNavigation(prevRouteKey, nextRouteKey) {
    const a = routeKindFromRouteKey(prevRouteKey);
    const b = routeKindFromRouteKey(nextRouteKey);
    // Preserve the filter when navigating between Explore and Post pages,
    // since Sora often changes the URL without actually changing the underlying feed state.
    return (a === 'explore' || a === 'post') && (b === 'explore' || b === 'post');
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
    const filterContainer = filterBtn ? filterBtn.closest('.sora-uv-filter-container') : null;
    const gatherBtn = bar.querySelector('.sora-uv-gather-btn');
    const gatherControlsWrapper = bar.querySelector('.sora-uv-gather-controls-wrapper');
    const sliderContainer = bar.querySelector('.sora-uv-slider-container');

    // Hide Filter/Gather entirely during Analyze mode
    if (analyzeActive) {
      if (filterContainer) filterContainer.style.display = 'none';
      if (gatherBtn) gatherBtn.style.display = 'none';
      if (gatherControlsWrapper) gatherControlsWrapper.style.display = 'none';
      if (typeof bar.updateFilterLabel === 'function') bar.updateFilterLabel();

      // Position on the right (default)
      if (typeof bar.updateBarPosition === 'function') {
        bar.updateBarPosition();
      } else {
        bar.style.top = '12px';
      }
      bar.style.right = '12px';
      bar.style.left = 'auto';
      bar.style.transform = 'none';

      return; // nothing else to manage while analyzing
    }

    // Normal visibility rules (when NOT analyzing)
    // Gather button: ONLY show on Top feed (feed=top) or Profile pages
    // Explicitly hide on drafts pages and other explore feeds (feed=following, feed=latest, or no feed param)
    
    // First, handle drafts page - always hide Gather on drafts
    if (isDrafts()) {
      // On drafts page: hide Filter, Gather, and controls
      if (filterContainer) filterContainer.style.display = 'none';
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

      // Position centered horizontally to avoid overlapping native buttons on both sides
      if (typeof bar.updateBarPosition === 'function') {
        bar.updateBarPosition();
      } else {
        bar.style.top = '12px';
      }
      bar.style.left = '50%';
      bar.style.right = 'auto';
      bar.style.transform = 'translateX(-50%)';
    } else if (isProfile() || isTopFeed()) {
      // Show Gather on Profile pages or Top feed
      if (gatherBtn) gatherBtn.style.display = 'flex';
      if (filterContainer) filterContainer.style.display = '';
      if (gatherControlsWrapper) gatherControlsWrapper.style.display = isGatheringActiveThisTab ? 'flex' : 'none';
      if (sliderContainer) sliderContainer.style.display = isProfile() ? 'flex' : 'none';
      bar.updateGatherState();

      // Position on the right (default)
      if (typeof bar.updateBarPosition === 'function') {
        bar.updateBarPosition();
      } else {
        bar.style.top = '12px';
      }
      bar.style.right = '12px';
      bar.style.left = 'auto';
      bar.style.transform = 'none';
    } else {
      // On other explore feeds (feed=following, feed=latest, or no feed param) or other pages, hide Gather
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
      if (filterContainer) filterContainer.style.display = '';

      // Position on the right (default)
      if (typeof bar.updateBarPosition === 'function') {
        bar.updateBarPosition();
      } else {
        bar.style.top = '12px';
      }
      bar.style.right = '12px';
      bar.style.left = 'auto';
      bar.style.transform = 'none';
    }

    // Analyze button on all feeds except Drafts
    if (analyzeBtn) analyzeBtn.style.display = isDrafts() ? 'none' : '';

    // Bookmarks button only on Drafts page
    if (bookmarksBtn) bookmarksBtn.style.display = isDrafts() ? '' : 'none';

    if (typeof bar.updateFilterLabel === 'function') bar.updateFilterLabel();
  }

  function onRouteChange() {
    const rk = routeKey();
    const prev = lastRouteKey;
    const navigated = rk !== prev;
    lastRouteKey = rk;

    if (isDraftDetail()) {
      // /d/... draft detail pages are extremely sensitive; avoid all injected work here.
      try {
        stopRapidAnalyzeGather();
        stopAnalyzeAutoRefresh();
      } catch {}
      analyzeActive = false;
      try {
        if (analyzeOverlayEl) analyzeOverlayEl.style.display = 'none';
      } catch {}

      try {
        isGatheringActiveThisTab = false;
        stopGathering(false);
        const s = getGatherState() || {};
        s.isGathering = false;
        delete s.refreshDeadline;
        setGatherState(s);
      } catch {}

      teardownDetailBadge();
      teardownControlBar();
      stopObservers();

      try {
        if (dashboardInjectRafId) cancelAnimationFrame(dashboardInjectRafId);
      } catch {}
      dashboardInjectRafId = null;
      try {
        if (dashboardInjectRetryId) clearTimeout(dashboardInjectRetryId);
      } catch {}
      dashboardInjectRetryId = null;
      try {
        if (dashboardBtnEl && document.contains(dashboardBtnEl)) dashboardBtnEl.remove();
      } catch {}
      dashboardBtnEl = null;
      return;
    } else if (!observersActive) {
      // If we previously disabled for /d/... and navigated back, resume observers.
      startObservers();
    }

    if (navigated) {
      forceStopGatherOnNavigation();
      if (!shouldPreserveFilterAcrossNavigation(prev, rk)) resetFilterOnNavigation();
      // Reset bookmarks filter on navigation
      bookmarksFilterState = 0;
      lastAppliedFilterState = -1;
      if (bookmarksBtn) {
        bookmarksBtn.setActive(false);
        bookmarksBtn.setLabel('All Drafts');
      }
      // Invalidate draft card cache on navigation
      cachedDraftCards = null;
      cachedDraftCardsCount = 0;
      processedDraftCardsCount = 0;
      processedDraftCards = new WeakSet(); // Reset to clear stale DOM references; navigation may remove/replace draft card elements, so previous references may no longer be valid
      
      // Clear locks only if route truly changed; keep processed IDs for later skips
      lockedPostIds.clear();
      dlog('feed', 'Navigation detected - cleared locked post IDs');
    }

    const bar = ensureControlBar();
    if (bar && typeof bar.updateFilterLabel === 'function') bar.updateFilterLabel();

    // If on a post page, try to fetch data if not available
    if (isPost()) {
      fetchPostDataIfNeeded();
      // Clear cached detail badge element on navigation to force re-finding
      if (navigated && detailBadgeEl) {
        detailBadgeEl = null;
      }
    }

    runRenderPass();

    // SPA navigation can update the URL without a full re-render; always re-apply current filter.
    applyFilter();
    
    // On post pages, retry rendering detail badge after a delay to allow DOM to settle
    if (isPost() && navigated) {
      setTimeout(() => {
        detailBadgeEl = null; // Force re-find
        renderDetailBadge();
      }, 100);
      setTimeout(() => {
        detailBadgeEl = null;
        renderDetailBadge();
      }, 300);
      setTimeout(() => {
        detailBadgeEl = null;
        renderDetailBadge();
      }, 600);
    }
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

  // == Task to Source Draft Mapping (for draft remix redo button) ==
  function loadTaskToSourceDraft() {
    try {
      const data = JSON.parse(localStorage.getItem(TASK_TO_DRAFT_KEY) || '{}');
      for (const [taskId, sourceDraftId] of Object.entries(data)) {
        taskToSourceDraft.set(taskId, sourceDraftId);
      }
    } catch {
      // Ignore parse errors
    }
  }
  function saveTaskToSourceDraft(taskId, sourceDraftId) {
    taskToSourceDraft.set(taskId, sourceDraftId);
    try {
      const data = JSON.parse(localStorage.getItem(TASK_TO_DRAFT_KEY) || '{}');
      data[taskId] = sourceDraftId;
      localStorage.setItem(TASK_TO_DRAFT_KEY, JSON.stringify(data));
    } catch {
      // Ignore storage errors
    }
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

  // Inject dashboard button into left sidebar
  function scheduleDashboardInjectRetry(ms = 1000) {
    if (dashboardInjectRetryId) return;
    dashboardInjectRetryId = setTimeout(() => {
      dashboardInjectRetryId = null;
      scheduleInjectDashboardButton();
    }, ms);
  }

  function isDashboardButtonPresent() {
    try {
      if (dashboardBtnEl && document.contains(dashboardBtnEl)) return true;
      const existing = document.querySelector('.sora-uv-dashboard-btn');
      if (existing) {
        dashboardBtnEl = existing;
        return true;
      }
    } catch {}
    dashboardBtnEl = null;
    return false;
  }

  function scheduleInjectDashboardButton() {
    // Fast path: if we already hold a live reference, do nothing.
    if (dashboardBtnEl && document.contains(dashboardBtnEl)) return;

    const now = Date.now();
    const since = now - dashboardInjectLastAttemptMs;
    if (since < DASHBOARD_INJECT_THROTTLE_MS) {
      scheduleDashboardInjectRetry(DASHBOARD_INJECT_THROTTLE_MS - since);
      return;
    }

    if (dashboardInjectRafId) return;
    dashboardInjectRafId = requestAnimationFrame(() => {
      dashboardInjectRafId = null;
      dashboardInjectLastAttemptMs = Date.now();
      injectDashboardButton();
    });
  }

  function injectDashboardButton() {
    // Check if button already exists
    if (isDashboardButtonPresent()) return;

    // Find the left sidebar - it has specific classes
    const sidebar = document.querySelector('div.fixed.left-0.top-0.z-50');
    if (!sidebar) {
      // Retry after a delay if sidebar not found yet
      scheduleDashboardInjectRetry(1000);
      return;
    }

    // Find the notification bell button (last activity button before profile)
    const buttons = sidebar.querySelectorAll('button[aria-label="Activity"]');
    const notificationButton = buttons[buttons.length - 1]; // Get the last "Activity" button (notification bell)
    
    if (!notificationButton) {
      scheduleDashboardInjectRetry(1000);
      return;
    }

    // Create dashboard button matching Sora's style (slightly larger)
    const dashboardBtn = document.createElement('button');
    dashboardBtn.className = 'sora-uv-dashboard-btn p-3.5 group data-[state=open]:opacity-100 opacity-50 hover:opacity-100 focus-visible:opacity-100';
    dashboardBtn.setAttribute('aria-label', 'Dashboard');
    dashboardBtn.setAttribute('type', 'button');
    dashboardBtn.setAttribute('data-state', 'closed');
    // Adjust padding to match other icons better
    dashboardBtn.style.padding = '13px';

    // Create the chart icon (inline and hover/focus states) - slightly larger
    const iconSpanInline = document.createElement('span');
    iconSpanInline.className = 'inline group-hover:hidden group-focus-visible:hidden group-data-[state=open]:hidden';
    iconSpanInline.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="25" height="25" viewBox="0 0 24 24" fill="none" class="h-6 w-6">
      <path d="M4 4V18H20" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
      <path d="M5 16L9 11L13 14L18 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
    </svg>`;

    const iconSpanHover = document.createElement('span');
    iconSpanHover.className = 'hidden group-hover:inline group-focus-visible:inline group-data-[state=open]:inline';
    iconSpanHover.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="25" height="25" viewBox="0 0 24 24" fill="none" class="h-6 w-6">
      <path d="M4 4V18H20" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
      <path d="M5 16L9 11L13 14L18 6" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
    </svg>`;

    const srOnly = document.createElement('div');
    srOnly.className = 'sr-only';
    srOnly.textContent = 'Dashboard';

    dashboardBtn.appendChild(iconSpanInline);
    dashboardBtn.appendChild(iconSpanHover);
    dashboardBtn.appendChild(srOnly);

    // Insert before the notification button (above it)
    notificationButton.parentNode.insertBefore(dashboardBtn, notificationButton);

    // Cache a stable reference; React may clone/replace later, but this avoids repeated document-wide lookups.
    dashboardBtnEl = dashboardBtn;

    if (dashboardInjectRetryId) {
      clearTimeout(dashboardInjectRetryId);
      dashboardInjectRetryId = null;
    }
    
    try {
      dlog('feed', 'Dashboard button injected into left sidebar');
    } catch {}
  }

  // Global click delegation for the dashboard button
  // This is more robust than attaching a listener to the element, which might be cloned or replaced by React
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.sora-uv-dashboard-btn');
    if (!btn) return;
    
    e.preventDefault();
    e.stopPropagation();

    let profileHandle = null;
    let profileUserKey = null;
    // On profile pages, carry the profile handle into the dashboard dropdown (like Analyze)
    if (isProfile()) {
      profileHandle = currentProfileHandleFromURL();
      if (profileHandle) {
        profileUserKey = `h:${profileHandle.toLowerCase()}`;
        analyzeCameoFilterUsername = profileHandle;
        if (analyzeCameoSelectEl) {
          analyzeCameoSelectEl.value = profileHandle;
        }
      }
    }
    
    // Send message to content script
    try {
      window.postMessage({
        __sora_uv__: true,
        type: 'open_dashboard',
        userKey: profileUserKey,
        userHandle: profileHandle || null,
      }, '*');
    } catch {}
  }, true); // Capture phase to ensure we get it first

  function ensureToastStyles() {
    if (document.getElementById('sora-uv-toast-style')) return;
    const st = document.createElement('style');
    st.id = 'sora-uv-toast-style';
    st.textContent = `
      [data-sonner-toaster="true"], 
      section[aria-label="Notifications alt+T"],
      ol[data-sonner-toaster="true"] {
        z-index: 2147483647 !important;
      }
    `;
    document.head.appendChild(st);
  }

  function init() {
    dlog('feed', 'init');
    ensureToastStyles();
    if (isDraftDetail()) {
      dlog('feed', 'draft detail route detected; not initializing');
      return;
    }
    // NOTE: we do NOT want to reset session here; we want Gather to survive a refresh.
    loadTaskToSourceDraft(); // Load task->draft mappings from localStorage
    installFetchSniffer();
    startObservers();
    onRouteChange();
    window.addEventListener('storage', handleStorageChange);

    // Inject dashboard button into left sidebar
    scheduleInjectDashboardButton();

    // Check for pending redo prompt (from remix navigation)
    checkPendingRedoPrompt();

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
      idToRemixTarget,
      idToRemixTargetDraft,
      taskToSourceDraft,
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
