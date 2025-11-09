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

  try { console.log('[SoraUV] inject.js loaded'); } catch {}

  // Debug toggles
  const DEBUG = { feed: true, thumbs: true };
  const dlog = (topic, ...args) => { try { if (DEBUG[topic]) console.log('[SoraUV]', topic, ...args); } catch {} };

  // == Configuration & Constants ==
  const PREF_KEY = 'SORA_UV_PREFS_V1';
  const SESS_KEY = 'SORA_UV_GATHER_STATE_V1';
  const FEED_RE = /\/(backend\/project_[a-z]+\/)?(feed|profile_feed|profile\/)/i;

  // Includes <21h (1260 minutes)
  const FILTER_STEPS_MIN = [null, 180, 360, 720, 900, 1080, 1260];
  const FILTER_LABELS = ['Filter', '<3 hours', '<6 hours', '<12 hours', '<15 hours', '<18 hours', '<21 hours'];

  // == State Maps ==
  const idToUnique = new Map();
  const idToLikes = new Map();
  const idToViews = new Map();
  const idToComments = new Map();
  const idToRemixes = new Map();
  const idToMeta = new Map();

  // == UI State ==
  let controlBar = null;
  let gatherTimerEl = null;
  let detailBadgeEl = null;

  let gatherScrollIntervalId = null;
  let gatherRefreshTimeoutId = null;
  let gatherCountdownIntervalId = null;
  let isGatheringActiveThisTab = false;

  // Track route to detect same-tab navigation
  const routeKey = () => `${location.pathname}${location.search}`;
  let lastRouteKey = routeKey();

  // == Utils ==
  const fmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(n % 1e6 ? 1 : 0) + 'M' :
    n >= 1e3 ? (n / 1e3).toFixed(n % 1e3 ? 1 : 0) + 'K' : String(n));

  function fmtAgeMin(ageMin) {
    if (!Number.isFinite(ageMin)) return '∞';
    const mTotal = Math.max(0, Math.floor(ageMin));
    const MIN_PER_H = 60, MIN_PER_D = 1440, MIN_PER_Y = 525600;
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

  function fmtRefreshCountdown(ms) {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return `${m}m ${s.toString().padStart(2, '0')}s`;
  }

  const minutesSince = (epochSec) => !epochSec ? Infinity : Math.max(0, (Date.now() / 1000 - epochSec) / 60);

  const fmtPct = (num, denom, digits = 1) => {
    const n = Number(num), d = Number(denom);
    if (!Number.isFinite(n) || !Number.isFinite(d) || d <= 0) return null;
    return ((n / d) * 100).toFixed(digits) + '%';
  };

  const likeRate = (likes, unique, views) => {
    const l = Number(likes);
    if (!Number.isFinite(l) || l < 0) return null;
    const u = Number(unique), v = Number(views);
    const denom = (Number.isFinite(u) && u > 0) ? u : ((Number.isFinite(v) && v > 0) ? v : null);
    return denom ? fmtPct(l, denom) : null;
  };

  const interactionRate = (likes, comments, unique) => {
    const l = Number(likes), c = Number(comments), u = Number(unique);
    const sum = (Number.isFinite(l) ? l : 0) + (Number.isFinite(c) ? c : 0);
    return (Number.isFinite(u) && u > 0) ? fmtPct(sum, u) : null;
  };

  // Remix Rate (remixes / likes)
  function remixRate(likes, remixes) {
    const l = Number(likes);
    const r = Number(remixes);
    if (!Number.isFinite(l) || l <= 0 || !Number.isFinite(r) || r < 0) return null;
    return fmtPct(r, l);
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
    } catch { return false; }
  };

  const isFilterHiddenPage = () => {
    const p = location.pathname;
    return p.startsWith('/storyboard') || p.startsWith('/drafts') || p.startsWith('/d/') || p.startsWith('/p/');
  };

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
      for (const v of cands) { const n = Number(v); if (Number.isFinite(n)) return n; }
    } catch {}
    return null;
  };
  const getTotalViews = (item) => {
    try {
      const p = item?.post ?? item;
      const cands = [p?.view_count, p?.views, p?.play_count, p?.impression_count, p?.stats?.view_count, p?.statistics?.view_count];
      for (const v of cands) { const n = Number(v); if (Number.isFinite(n)) return n; }
    } catch {}
    return null;
  };
  const getComments = (item) => {
    try {
      const p = item?.post ?? item;
      const cands = [p?.comment_count, p?.comments_count, p?.comments, p?.reply_count, p?.replies?.count, p?.stats?.comment_count, p?.statistics?.comment_count];
      for (const v of cands) { const n = Number(v); if (Number.isFinite(n)) return n; }
    } catch {}
    return null;
  };
  const getRemixes = (item) => {
    try {
      const p = item?.post ?? item;
      const cands = [p?.remix_count, p?.stats?.remix_count, p?.statistics?.remix_count];
      for (const v of cands) { const n = Number(v); if (Number.isFinite(n)) return n; }
    } catch {}
    return null;
  };
  const getCameos = (item) => {
    try {
      const p = item?.post ?? item;
      const cands = [p?.cameo_count, p?.stats?.cameo_count, p?.statistics?.cameo_count];
      for (const v of cands) { const n = Number(v); if (Number.isFinite(n)) return n; }
      const arr = Array.isArray(p?.cameo_profiles) ? p.cameo_profiles : null;
      if (arr) return arr.length;
    } catch {}
    return null;
  };
  const getFollowerCount = (item) => {
    try {
      const p = item?.post ?? item;
      const cands = [item?.profile?.follower_count, item?.user?.follower_count, item?.author?.follower_count,
        p?.author?.follower_count, p?.owner?.follower_count, item?.owner_profile?.follower_count];
      for (const v of cands) { const n = Number(v); if (Number.isFinite(n)) return n; }
    } catch {}
    return null;
  };
  function getOwner(item) {
    try {
      const p = item?.post ?? item;
      const prof = item?.profile || item?.owner_profile || item?.user || item?.author || p?.author || p?.owner || p?.profile || null;
      let id = p?.shared_by || prof?.user_id || prof?.id || prof?._id || null;
      let handle = prof?.username || prof?.handle || prof?.name || null;
      return { handle: (typeof handle === 'string' && handle) ? handle : null, id: (typeof id === 'string' && id) ? id : null };
    } catch { return { handle: null, id: null }; }
  }
  const getThumbnail = (item) => {
    try {
      const p = item?.post ?? item;
      const id = getItemId(item);
      const atts = Array.isArray(p?.attachments) ? p.attachments : null;
      if (atts) for (const att of atts) {
        const t = att?.encodings?.thumbnail?.path;
        if (typeof t === 'string' && /^https?:\/\//.test(t)) { dlog('thumbs', 'picked', { id, source: 'att.encodings.thumbnail', url: t }); return t; }
      }
      if (typeof p?.preview_image_url === 'string' && /^https?:\/\//.test(p.preview_image_url)) { dlog('thumbs','picked',{id,source:'preview_image_url',url:p.preview_image_url}); return p.preview_image_url; }
      const pairs = [
        ['thumbnail_url', p?.thumbnail_url], ['thumb', p?.thumb], ['cover', p?.cover],
        ['image.url|image', p?.image?.url || p?.image],
        ['images[0].url', Array.isArray(p?.images) ? p.images[0]?.url : null],
        ['media.thumb|cover|poster', p?.media?.thumbnail || p?.media?.cover || p?.media?.poster],
        ['assets[0].thumb|url', Array.isArray(p?.assets) ? p.assets[0]?.thumbnail_url || p.assets[0]?.url : null],
        ['poster.url', p?.poster?.url],
      ];
      for (const [label, u] of pairs) if (typeof u === 'string' && /^https?:\/\//.test(u)) { dlog('thumbs','picked',{id,source:label,url:u}); return u; }
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
  const selectAllCards = () => Array.from(document.querySelectorAll('a[href^="/p/s_"]'))
    .map(a => a.closest('article,div,section') || a);

  // == Badge & UI (Feed) ==
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

  function ensureBadge(card) {
    let badge = card.querySelector('.sora-uv-badge');
    if (!badge) {
      if (getComputedStyle(card).position === 'static') card.style.position = 'relative';
      badge = document.createElement('div');
      badge.className = 'sora-uv-badge';
      Object.assign(badge.style, {
        position: 'absolute', top: '6px', left: '6px',
        padding: '3px 6px', fontSize: '12px', lineHeight: '1', fontWeight: '600',
        borderRadius: '8px', background: 'rgba(0,0,0,0.72)', color: '#fff',
        zIndex: 9999, pointerEvents: 'none', backdropFilter: 'blur(2px)',
      });
      card.appendChild(badge);
    }
    return badge;
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

  function addBadge(card, views, meta) {
    if (views == null && !meta) return;
    const badge = ensureBadge(card);
    const id = extractIdFromCard(card);
    const likes = idToLikes.get(id) ?? 0;
    const ageMin = meta?.ageMin;
    const isSuperHot = likes >= 50 && Number.isFinite(ageMin) && ageMin < 60;

    const viewsStr = views != null ? `${fmt(views)} views` : null;
    const ageStr = Number.isFinite(ageMin) ? fmtAgeMin(ageMin) : null;
    const emoji = badgeEmojiFor(id, meta);
    const ir = interactionRate(idToLikes.get(id), idToComments.get(id), idToUnique.get(id));
    const irStr = ir ? `${ir} IR` : null;

    badge.textContent = [viewsStr, irStr, ageStr, emoji].filter(Boolean).join(' • ');
    const bg = badgeBgFor(id, meta);
    badge.style.background = bg || 'rgba(0,0,0,0.72)';
    badge.style.boxShadow = isSuperHot ? '0 0 10px 3px hsla(0, 100%, 50%, 0.7)' : 'none';
    const note = isNearWholeDay(ageMin) ? 'Green day mark ✅' : (bg ? 'Hot ✅' : '');
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

  // == Detail badge (includes RR) ==
  function ensureDetailBadge() {
    if (detailBadgeEl && document.contains(detailBadgeEl)) return detailBadgeEl;
    const el = document.createElement('div');
    el.className = 'sora-uv-badge-detail';
    Object.assign(el.style, {
      position: 'fixed', top: '12px', left: '12px',
      padding: '6px 10px', fontSize: '13px', fontWeight: '700',
      borderRadius: '10px', background: 'rgba(0,0,0,0.75)', color: '#fff',
      zIndex: 999999, pointerEvents: 'none', backdropFilter: 'blur(2px)',
    });
    document.documentElement.appendChild(el);
    detailBadgeEl = el;
    return el;
  }
  function renderDetailBadge() {
    if (!isPost()) { if (detailBadgeEl) { detailBadgeEl.remove(); detailBadgeEl = null; } return; }
    const sid = currentSIdFromURL();
    if (!sid) return;

    const uv = idToUnique.get(sid);
    const likes = idToLikes.get(sid);
    const totalViews = idToViews.get(sid);
    const comments = idToComments.get(sid);
    const remixes = idToRemixes.get(sid);

    const ir = interactionRate(likes, comments, uv);
    const rr = remixRate(likes, remixes);

    if (uv == null && !ir && !rr) return;

    const el = ensureDetailBadge();
    const meta = idToMeta.get(sid);
    const ageMin = meta?.ageMin;
    const isSuperHot = (likes ?? 0) >= 50 && Number.isFinite(ageMin) && ageMin < 60;

    const parts = [];
    if (uv != null) parts.push(`${fmt(uv)} views`);
    if (ir) parts.push(`${ir} IR`);
    if (rr) parts.push(`${rr} RR`);
    if (Number.isFinite(ageMin)) parts.push(fmtAgeMin(ageMin));
    const emoji = badgeEmojiFor(sid, meta);
    if (emoji) parts.push(emoji);
    el.textContent = parts.join(' • ');

    const bg = badgeBgFor(sid, meta);
    el.style.background = bg || 'rgba(0,0,0,0.75)';
    el.style.boxShadow = isSuperHot ? '0 0 10px 3px hsla(0, 100%, 50%, 0.7)' : 'none';

    const note = isNearWholeDay(ageMin) ? 'Green day mark ✅' : (bg ? 'Hot ✅' : '');
    const ageLabel = Number.isFinite(ageMin) ? fmtAgeMin(ageMin) : '∞';
    el.title = meta ? `Age: ${ageLabel}${note ? `\n${note}` : ''}` : '';
  }

  // == Profile Impact ==
  function parseMetricNumber(text) {
    if (typeof text !== 'string') return null;
    let t = text.trim().toUpperCase();
    if (!t) return null;
    let mult = 1;
    if (t.endsWith('K')) { mult = 1e3; t = t.slice(0, -1); }
    else if (t.endsWith('M')) { mult = 1e6; t = t.slice(0, -1); }
    else if (t.endsWith('B')) { mult = 1e9; t = t.slice(0, -1); }
    t = t.replace(/[\s,]/g, '');
    const n = Number(t);
    return Number.isFinite(n) ? n * mult : null;
  }
  function formatImpactRatio(likes, followers) {
    const l = Number(likes), f = Number(followers);
    if (!Number.isFinite(l) || !Number.isFinite(f) || f <= 0) return null;
    const ratio = l / f; const rounded = Math.ceil(ratio * 10) / 10;
    return `${rounded.toFixed(1)}x`;
  }
  function removeProfileImpact() {
    const existing = document.querySelector('[data-sora-uv-impact]');
    if (existing && existing.parentElement) existing.parentElement.removeChild(existing);
  }
  function renderProfileImpact() {
    if (!isProfile()) { removeProfileImpact(); return; }
    const metricsRow = document.querySelector('section div.grid.auto-cols-fr.grid-flow-col');
    if (!metricsRow) return;

    const metricLabels = Array.from(metricsRow.querySelectorAll('.text-xs'));
    const followersLabel = metricLabels.find(el => el.textContent?.trim().toLowerCase() === 'followers');
    const likesLabel = metricLabels.find(el => el.textContent?.trim().toLowerCase() === 'likes');

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
    if (!impactText) { if (existing) existing.remove(); return; }

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

  // == Control Bar UI ==
  function stylBtn(b) {
    Object.assign(b.style, {
      background: 'rgba(255,255,255,0.12)', color: '#fff',
      border: '1px solid rgba(255,255,255,0.2)', borderRadius: '8px',
      padding: '4px 8px', cursor: 'pointer'
    });
    b.onmouseenter = () => { if (b.dataset.gathering === 'true' || b.disabled) return; b.style.background = 'rgba(255,255,255,0.2)'; };
    b.onmouseleave = () => { if (b.dataset.gathering === 'true' || b.disabled) return; b.style.background = 'rgba(255,255,255,0.12)'; };
  }

  function ensureControlBar() {
    if (controlBar && document.contains(controlBar)) return controlBar;

    const bar = document.createElement('div');
    bar.className = 'sora-uv-controls';
    Object.assign(bar.style, {
      position: 'fixed', top: '12px', right: '12px', zIndex: 999999,
      display: 'flex', gap: '8px', padding: '6px 8px', borderRadius: '10px',
      background: 'rgba(0,0,0,0.55)', color: '#fff', fontSize: '12px',
      alignItems: 'center', backdropFilter: 'blur(2px)', userSelect: 'none', flexDirection: 'column'
    });

    const buttonContainer = document.createElement('div');
    buttonContainer.style.display = 'flex';
    buttonContainer.style.gap = '8px';

    // Prefs
    let prefs = getPrefs();
    if (typeof prefs.gatherSpeed !== 'string') { prefs.gatherSpeed = '0'; setPrefs(prefs); }

    // Tab session: ALWAYS start fresh on creation
    let sessionState = getGatherState();
    sessionState = { filterIndex: 0, isGathering: false };
    setGatherState(sessionState);
    isGatheringActiveThisTab = false;

    const filterBtn = document.createElement('button');
    stylBtn(filterBtn);

    bar.updateFilterLabel = function () {
      const s = getGatherState();
      const idx = s.filterIndex ?? 0;
      filterBtn.textContent = FILTER_LABELS[idx];
    };
    bar.updateFilterLabel();

    filterBtn.onclick = () => {
      const s = getGatherState();
      s.filterIndex = ((s.filterIndex ?? 0) + 1) % FILTER_STEPS_MIN.length;
      setGatherState(s);
      bar.updateFilterLabel();
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
      display: 'none', flexDirection: 'column', width: '100%', gap: '6px', alignItems: 'center',
    });

    const sliderContainer = document.createElement('div');
    sliderContainer.className = 'sora-uv-slider-container';
    Object.assign(sliderContainer.style, {
      display: 'flex', width: '100%', alignItems: 'center', gap: '5px',
    });

    const emojiTurtle = document.createElement('span'); emojiTurtle.textContent = '🐢';
    const slider = document.createElement('input');
    slider.type = 'range'; slider.min = '0'; slider.max = '100'; slider.step = '1';
    slider.value = getPrefs().gatherSpeed; slider.style.flexGrow = '1';
    const emojiRabbit = document.createElement('span'); emojiRabbit.textContent = '🐇';

    sliderContainer.appendChild(emojiTurtle);
    sliderContainer.appendChild(slider);
    sliderContainer.appendChild(emojiRabbit);
    gatherControlsWrapper.appendChild(sliderContainer);

    const refreshTimerDisplay = document.createElement('div');
    refreshTimerDisplay.className = 'sora-uv-refresh-timer';
    Object.assign(refreshTimerDisplay.style, {
      width: '100%', textAlign: 'center', fontSize: '11px', color: 'rgba(255, 255, 255, 0.7)', lineHeight: '1',
    });
    gatherControlsWrapper.appendChild(refreshTimerDisplay);
    gatherTimerEl = refreshTimerDisplay;

    bar.appendChild(gatherControlsWrapper);

    const onSliderChange = () => {
      let p = getPrefs(); p.gatherSpeed = slider.value; setPrefs(p);
      if (isGatheringActiveThisTab) startGathering(true);
    };
    slider.addEventListener('input', onSliderChange);

    bar.updateGatherState = function () {
      const filterBtnEl = filterBtn;

      if (isGatheringActiveThisTab) {
        gatherBtn.textContent = 'Gathering...';
        gatherBtn.style.background = 'hsla(120, 60%, 30%, 0.9)';
        gatherBtn.dataset.gathering = 'true';
        if (filterBtnEl) { filterBtnEl.disabled = true; filterBtnEl.style.opacity = '0.5'; filterBtnEl.style.cursor = 'not-allowed'; }

        if (isProfile()) {
          gatherControlsWrapper.style.display = 'flex';
          if (sliderContainer) sliderContainer.style.display = 'flex';
        } else if (isTopFeed()) {
          gatherControlsWrapper.style.display = 'flex';
          if (sliderContainer) sliderContainer.style.display = 'none';
        }

        startGathering(false);
        if (!gatherCountdownIntervalId) gatherCountdownIntervalId = setInterval(updateCountdownDisplay, 1000);
      } else {
        gatherBtn.textContent = 'Gather';
        gatherBtn.style.background = 'rgba(255,255,255,0.12)';
        gatherBtn.dataset.gathering = 'false';
        if (filterBtnEl) { filterBtnEl.disabled = false; filterBtnEl.style.opacity = '1'; filterBtnEl.style.cursor = 'pointer'; }

        stopGathering(false);
        gatherControlsWrapper.style.display = 'none';
      }

      if (typeof bar.updateFilterLabel === 'function') bar.updateFilterLabel();
    };

    gatherBtn.onclick = () => {
      isGatheringActiveThisTab = !isGatheringActiveThisTab;
      let sState = getGatherState();
      sState.isGathering = isGatheringActiveThisTab;
      if (!isGatheringActiveThisTab) {
        delete sState.refreshDeadline;
      } else {
        sState.filterIndex = 0; // starting gather resets filter to All
      }
      setGatherState(sState);
      bar.updateGatherState();
      if (isGatheringActiveThisTab) { bar.updateFilterLabel(); applyFilter(); }
    };

    document.documentElement.appendChild(bar);
    controlBar = bar;
    return bar;
  }

  // == Filtering ==
  function applyFilter() {
    const s = getGatherState();
    const idx = s.filterIndex ?? 0;
    const limitMin = FILTER_STEPS_MIN[idx];

    for (const card of selectAllCards()) {
      const id = extractIdFromCard(card);
      const meta = idToMeta.get(id);
      if (limitMin == null || isGatheringActiveThisTab) { card.style.display = ''; continue; }
      const show = Number.isFinite(meta?.ageMin) && meta.ageMin <= limitMin;
      card.style.display = show ? '' : 'none';
    }
  }

  // == Gather Mode ==
  function getGatherState() {
    try { return JSON.parse(sessionStorage.getItem(SESS_KEY) || '{}'); } catch { return {}; }
  }
  function setGatherState(s) { sessionStorage.setItem(SESS_KEY, JSON.stringify(s)); }

  function updateCountdownDisplay() {
    if (!isGatheringActiveThisTab || !gatherTimerEl) { if (gatherTimerEl) gatherTimerEl.textContent = ''; return; }
    const state = getGatherState();
    const deadline = state.refreshDeadline;
    if (deadline && deadline > Date.now()) {
      const remainingMs = deadline - Date.now();
      gatherTimerEl.textContent = isTopFeed()
        ? `Gathering top for ${fmtRefreshCountdown(remainingMs)}...`
        : `Refresh in ${fmtRefreshCountdown(remainingMs)}`;
    } else if (deadline) {
      gatherTimerEl.textContent = isTopFeed() ? 'Gathering top for 0m 00s...' : 'Refreshing...';
    } else {
      gatherTimerEl.textContent = '';
    }
  }

  function startGathering(forceNewDeadline = false) {
    if (gatherScrollIntervalId) { clearTimeout(gatherScrollIntervalId); gatherScrollIntervalId = null; }
    if (gatherRefreshTimeoutId) { clearTimeout(gatherRefreshTimeoutId); gatherRefreshTimeoutId = null; }

    console.log('UV: Starting/resuming gathering...');

    if (isTopFeed()) {
      const refreshMs = 10 * 60 * 1000;

      // If timers already exist and we aren't forcing a new deadline, just resume.
      const s0 = getGatherState() || {};
      if (!forceNewDeadline && typeof s0.refreshDeadline === 'number' && s0.refreshDeadline > Date.now()) {
        const remaining = s0.refreshDeadline - Date.now();
        console.log(`UV: Top resume. ${Math.round(remaining / 1000)}s remaining.`);
        // Resume scroll loop
        function slowScrollResume() {
          if (window.innerHeight + window.scrollY < document.body.scrollHeight - 100) {
            window.scrollBy(0, 3); // slightly faster than before
          }
          gatherScrollIntervalId = setTimeout(slowScrollResume, 4000); // slightly quicker cadence
        }
        slowScrollResume();

        gatherRefreshTimeoutId = setTimeout(() => {
          console.log('UV: Refreshing page (Top feed)...');
          location.reload();
        }, remaining);
        updateCountdownDisplay();
        return;
      }

      // Fresh cycle
      function slowScroll() {
        if (window.innerHeight + window.scrollY < document.body.scrollHeight - 100) {
          window.scrollBy(0, 3);
        }
        gatherScrollIntervalId = setTimeout(slowScroll, 4000);
      }
      slowScroll();

      const now = Date.now();
      let sessionState = getGatherState() || {};
      let refreshDelay = refreshMs;
      if (!forceNewDeadline && sessionState.refreshDeadline && sessionState.refreshDeadline > now) {
        refreshDelay = sessionState.refreshDeadline - now; // should not happen due to early return, but keep safe
      } else {
        sessionState.refreshDeadline = now + refreshDelay;
        setGatherState(sessionState);
      }

      console.log(`UV: Top feed refresh set for ${Math.round(refreshDelay / 1000)}s.`);
      gatherRefreshTimeoutId = setTimeout(() => {
        console.log('UV: Refreshing page (Top feed)...');
        location.reload();
      }, refreshDelay);

      updateCountdownDisplay();
      return;
    }

    // Profile (slider-based)
    const prefs = getPrefs();
    const speedValue = (prefs.gatherSpeed != null) ? prefs.gatherSpeed : '0';
    const t = Math.min(1, Math.max(0, Number(speedValue) / 100));

    const speedSlow = { sMin: 10000, sMax: 15000, rMin: 15 * 60000, rMax: 17 * 60000 };
    const speedMid  = { sMin:  4500, sMax:  6500, rMin:  7 * 60000, rMax:  9 * 60000 };
    const speedFast = { sMin:    50, sMax:   150, rMin:  1 * 60000, rMax:  2 * 60000 };

    const lerp = (a,b,u)=>a+(b-a)*u;
    let scrollMinMs, scrollMaxMs, refreshMinMs, refreshMaxMs;
    if (t <= 0.5) {
      const u = t / 0.5;
      scrollMinMs = lerp(speedSlow.sMin, speedMid.sMin, u);
      scrollMaxMs = lerp(speedSlow.sMax, speedMid.sMax, u);
      refreshMinMs = lerp(speedSlow.rMin, speedMid.rMin, u);
      refreshMaxMs = lerp(speedSlow.rMax, speedMid.rMax, u);
    } else {
      const u = (t - 0.5) / 0.5;
      scrollMinMs = lerp(speedMid.sMin, speedFast.sMin, u);
      scrollMaxMs = lerp(speedMid.sMax, speedFast.sMax, u);
      refreshMinMs = lerp(speedMid.rMin, speedFast.rMin, u);
      refreshMaxMs = lerp(speedMid.rMax, speedFast.rMax, u);
    }

    console.log(`UV: Speed t=${t.toFixed(2)} | scroll=[${Math.round(scrollMinMs)}..${Math.round(scrollMaxMs)}] ms | refresh=[${Math.round(refreshMinMs/60000)}..${Math.round(refreshMaxMs/60000)}] min`);

    function randomScroll() {
      if (window.innerHeight + window.scrollY < document.body.scrollHeight - 100) {
        const amt = t <= 0.1 ? 3 : (t <= 0.3 ? 8 : (t <= 0.7 ? 20 : 100));
        window.scrollBy(0, amt);
      }
      const delay = Math.random() * (scrollMaxMs - scrollMinMs) + scrollMinMs;
      gatherScrollIntervalId = setTimeout(randomScroll, delay);
    }
    randomScroll();

    const now = Date.now();
    let s = getGatherState() || {};
    let refreshDelay;
    if (!forceNewDeadline && s.refreshDeadline && s.refreshDeadline > now) {
      refreshDelay = s.refreshDeadline - now;
      console.log(`UV: Resuming refresh timer. ${Math.round(refreshDelay/1000)}s remaining.`);
    } else {
      refreshDelay = Math.random() * (refreshMaxMs - refreshMinMs) + refreshMinMs;
      s.refreshDeadline = now + refreshDelay; setGatherState(s);
      console.log(`UV: ${forceNewDeadline ? 'New forced' : 'New'} refresh timer set for ${Math.round(refreshDelay/1000)}s.`);
    }
    gatherRefreshTimeoutId = setTimeout(() => { console.log('UV: Refreshing page...'); location.reload(); }, refreshDelay);

    updateCountdownDisplay();
  }

  // Never nuke filterIndex unless explicitly resetting to fresh slate
  function stopGathering(clearSessionState = false) {
    console.log('Sora UV: Stopping gathering.');
    if (gatherScrollIntervalId) { clearTimeout(gatherScrollIntervalId); gatherScrollIntervalId = null; }
    if (gatherRefreshTimeoutId) { clearTimeout(gatherRefreshTimeoutId); gatherRefreshTimeoutId = null; }
    if (gatherCountdownIntervalId) { clearInterval(gatherCountdownIntervalId); gatherCountdownIntervalId = null; }
    if (gatherTimerEl) gatherTimerEl.textContent = '';

    const s = getGatherState() || {};
    s.isGathering = false;
    delete s.refreshDeadline;

    if (clearSessionState === true) {
      const keptFilter = (typeof s.filterIndex === 'number') ? s.filterIndex : 0;
      sessionStorage.setItem(SESS_KEY, JSON.stringify({ filterIndex: keptFilter, isGathering: false }));
    } else {
      setGatherState(s);
    }
  }

  // == Network & Processing ==
  function looksLikeSoraFeed(json){
    try {
      const items = json?.items || json?.data?.items || null;
      if (!Array.isArray(items) || items.length === 0) return false;
      let hits = 0;
      for (let i=0;i<Math.min(items.length, 10); i++){
        const it = items[i], p = it?.post || it || {};
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
      const findProfile = (root) => {
        if (!root || typeof root !== 'object') return null;
        const direct = root.profile || root.data?.profile || root.owner_profile || null;
        if (direct) return direct;
        const arr = root.items || root.data?.items || [];
        for (const it of (Array.isArray(arr)?arr:[])){
          if (it?.profile) return it.profile;
          if (it?.owner_profile) return it.owner_profile;
          const p = it?.post || it || {};
          if (p?.owner_profile) return p.owner_profile;
          if (p?.author && (p.author.cameo_count != null || p.author.follower_count != null || p.author.username)) return p.author;
        }
        return null;
      };
      const prof = findProfile(json);
      const profFollowers = Number(json?.follower_count ?? json?.profile?.follower_count ?? prof?.follower_count);
      const profCameos = Number(json?.cameo_count ?? json?.profile?.cameo_count ?? prof?.cameo_count);
      const profHandle = (json?.username || json?.handle || json?.profile?.username || prof?.username || pageUserHandle || '').toString() || null;
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
      const created_at = p?.created_at ?? p?.uploaded_at ?? p?.createdAt ?? p?.created ?? p?.posted_at ?? p?.timestamp ?? null;
      const caption = (typeof p?.caption === 'string' && p.caption) ? p.caption : (typeof p?.text === 'string' && p.text ? p.text : null);
      const ageMin = minutesSince(created_at);
      const th = getThumbnail(it);

      if (uv != null) idToUnique.set(id, uv);
      if (likes != null) idToLikes.set(id, likes);
      if (tv != null) idToViews.set(id, tv);
      if (cm != null) idToComments.set(id, cm);
      if (rx != null) idToRemixes.set(id, rx);
      idToMeta.set(id, { ageMin });

      const absUrl = `${location.origin}/p/${id}`;
      const owner = getOwner(it);
      const userHandle = owner.handle || pageUserHandle || null;
      const userId = owner.id || null;
      const userKey = userHandle ? `h:${userHandle.toLowerCase()}` : (userId != null ? `id:${userId}` : pageUserKey);
      const followers = getFollowerCount(it);

      batch.push({
        postId: id, uv, likes, views: tv, comments: cm, remixes: rx, remix_count: rx, cameos: cx,
        followers, created_at, caption, ageMin, thumb: th, url: absUrl, ts: Date.now(),
        userHandle, userId, userKey, parent_post_id: p?.parent_post_id ?? null, root_post_id: p?.root_post_id ?? null,
        pageUserHandle, pageUserKey
      });
    }

    if (batch.length) try {
      window.postMessage({ __sora_uv__: true, type: 'metrics_batch', items: batch }, '*');
    } catch {}

    renderBadges();
    renderDetailBadge();
    renderProfileImpact();
  }

  // == Observers & Lifecycle ==
  const mo = new MutationObserver(() => {
    if (mo._raf) cancelAnimationFrame(mo._raf);
    mo._raf = requestAnimationFrame(() => {
      renderBadges();
      renderDetailBadge();
      renderProfileImpact();
      updateControlsVisibility();
    });
  });

  function startObservers() {
    mo.observe(document.documentElement, { childList: true, subtree: true });
    renderBadges();
    renderDetailBadge();
    renderProfileImpact();
    updateControlsVisibility();
  }

  // Fresh slate helper: reset filter to All immediately
  function resetFilterFreshSlate() {
    const newState = { filterIndex: 0, isGathering: false };
    setGatherState(newState);
    isGatheringActiveThisTab = false;
    const bar = controlBar || ensureControlBar();
    if (bar && typeof bar.updateFilterLabel === 'function') bar.updateFilterLabel();
    applyFilter();
  }

  (function patchHistory() {
    const _push = history.pushState, _replace = history.replaceState;
    const fire = () => setTimeout(onRouteChange, 0);
    history.pushState = function () { const r = _push.apply(this, arguments); fire(); return r; };
    history.replaceState = function () { const r = _replace.apply(this, arguments); fire(); return r; };
    window.addEventListener('popstate', fire);
  })();

  // Navigation: stop gather and force fresh filter slate on every route change
  function forceStopGatherOnNavigation() {
    if (isGatheringActiveThisTab) console.log('Sora UV: Route change — stopping gather for this tab.');
    isGatheringActiveThisTab = false;
    stopGathering(false);
    setGatherState({ filterIndex: 0, isGathering: false });
    const bar = controlBar || ensureControlBar();
    if (bar && typeof bar.updateGatherState === 'function') bar.updateGatherState();
    if (bar && typeof bar.updateFilterLabel === 'function') bar.updateFilterLabel();
    applyFilter();
  }

  function updateControlsVisibility() {
    const bar = ensureControlBar();
    if (!bar) return;

    if (isFilterHiddenPage()) { bar.style.display = 'none'; return; }
    else bar.style.display = 'flex';

    const gatherBtn = bar.querySelector('.sora-uv-gather-btn');
    const gatherControlsWrapper = bar.querySelector('.sora-uv-gather-controls-wrapper');
    const sliderContainer = bar.querySelector('.sora-uv-slider-container');
    if (!gatherBtn || !gatherControlsWrapper) return;

    if (isProfile() || isTopFeed()) {
      gatherBtn.style.display = '';
      gatherControlsWrapper.style.display = isGatheringActiveThisTab ? 'flex' : 'none';
      if (sliderContainer) sliderContainer.style.display = isProfile() ? 'flex' : 'none';
      bar.updateGatherState();
    } else {
      gatherBtn.style.display = 'none';
      gatherControlsWrapper.style.display = 'none';
      if (isGatheringActiveThisTab) {
        isGatheringActiveThisTab = false;
        let sState = getGatherState(); sState.isGathering = false; delete sState.refreshDeadline; setGatherState(sState);
        bar.updateGatherState();
      }
    }

    if (typeof bar.updateFilterLabel === 'function') bar.updateFilterLabel();
  }

  function onRouteChange() {
    const rk = routeKey();
    const navigated = rk !== lastRouteKey;
    lastRouteKey = rk;

    if (navigated) {
      forceStopGatherOnNavigation();
    }

    const bar = ensureControlBar();
    if (bar && typeof bar.updateFilterLabel === 'function') bar.updateFilterLabel();

    renderBadges();
    renderDetailBadge();
    renderProfileImpact();
    updateControlsVisibility();
  }

  // == Prefs ==
  function getPrefs() { try { return JSON.parse(localStorage.getItem(PREF_KEY) || '{}'); } catch { return {}; } }
  function setPrefs(p) { localStorage.setItem(PREF_KEY, JSON.stringify(p)); }
  function handleStorageChange(e) {
    if (e.key !== PREF_KEY) return;
    try {
      const newPrefs = JSON.parse(e.newValue || '{}');
      if (newPrefs.gatherSpeed == null) return;
      const slider = document.querySelector('.sora-uv-controls input[type="range"]');
      if (slider && slider.value !== newPrefs.gatherSpeed) slider.value = newPrefs.gatherSpeed;
      if (isGatheringActiveThisTab && !isTopFeed()) startGathering(true);
    } catch (err) { console.error('Sora UV: Error applying storage change.', err); }
  }

  // == Init ==
  function init() {
    dlog('feed', 'init');
    // ALWAYS begin a new tab with a fresh slate for Filter + Gather
    resetFilterFreshSlate();

    installFetchSniffer();
    startObservers();
    onRouteChange();
    window.addEventListener('storage', handleStorageChange);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
