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
 * - Badge text looks like: “30.2K views • 14h 36m • 🔥/🔥🔥/🔥🔥🔥” with more flames for hotter posts. Super-hot mode shows on posts with >50 likes in less than an hour.
 * - Use "Gather" mode on your profile to auto-scroll and refresh the page as often as every 1-2 minutes or as slow as every 15-17 minutes to auto-populate your dashboard
 *
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
  const fmtPct = (num, denom, digits = 1) => {
    const n = Number(num), d = Number(denom);
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
  const interactionRate = (likes, comments, remixes, shares, downloads, unique) => {
    const sum = [likes, comments, remixes, shares, downloads]
      .map(x => Number(x))
      .reduce((a, b) => a + (Number.isFinite(b) && b > 0 ? b : 0), 0);
    const u = Number(unique);
    const denom = (Number.isFinite(u) && u > 0) ? u : null;
    return denom ? fmtPct(sum, denom) : null;
  };
  const normalizeId = (s) => s?.toString().split(/[?#]/)[0].trim();
  const isExplore = () => location.pathname.startsWith('/explore');
  const isProfile = () => location.pathname.startsWith('/profile');
  const isPost    = () => /^\/p\/s_[A-Za-z0-9]+/i.test(location.pathname);
  
  // [NEW] Linear interpolation helper function
  const lerp = (a, b, t) => a + (b - a) * t;

  // Red (0h) → Yellow (18h), 18 steps, saturated.
  function colorForAgeMin(ageMin) {
    if (!Number.isFinite(ageMin)) return null;
    const hHours = ageMin / 60;
    if (hHours < 0 || hHours >= 18) return null;
    const idx = Math.floor(hHours);              // 0..17
    const t = idx / 17;                          // 0..1
    const h = 0 + (50 * t);                      // hue: 0→50
    const l = 42 - (12 * t);                     // lightness: 42%→30%
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

  // Try to infer the profile handle from the current URL when on a profile page
  function currentProfileHandleFromURL() {
    const m = location.pathname.match(/^\/profile\/(?:username\/)?([^\/?#]+)/i);
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
  const idToComments = new Map();
  const idToRemixes  = new Map();
  const idToShares   = new Map();
  const idToDownloads= new Map();
  const idToMeta   = new Map(); // id -> { ageMin }
  let controlBar   = null;
  
  // Timers for gathering
  let gatherScrollIntervalId = null;
  let gatherRefreshTimeoutId = null;


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

  // [MODIFIED] Function
  function badgeBgFor(id, meta) {
    if (!meta) return null;
    const ageMin = meta.ageMin;
    const likes = idToLikes.get(id) ?? 0; // Get likes

    // [NEW] Super-hot state
    if (likes >= 50 && Number.isFinite(ageMin) && ageMin < 60) {
      return colorForAgeMin(0); // Hottest red
    }

    if (isNearWholeDay(ageMin)) return greenEmblemColor();
    if (likes > 25) return colorForAgeMin(ageMin); // Relies on 'likes' from above
    return null;
  }

  // [MODIFIED] Function
  function badgeEmojiFor(id, meta) {
    if (!meta) return '';
    const ageMin = meta.ageMin;
    const likes = idToLikes.get(id) ?? 0; // Get likes

    // [NEW] Super-hot state
    if (likes >= 50 && Number.isFinite(ageMin) && ageMin < 60) {
      return '🔥🔥🔥🔥🔥';
    }

    if (isNearWholeDay(ageMin)) return '📝';
    if (likes > 25) return fireForAge(ageMin); // Relies on 'likes' from above
    return '';
  }

  // [MODIFIED] Function
  function addBadge(card, views, meta) {
    if (views == null && !meta) return;
    const badge = ensureBadge(card);
    const id = extractIdFromCard(card);

    // [NEW] Check for super-hot state
    const likes = idToLikes.get(id) ?? 0;
    const ageMin = meta?.ageMin;
    const isSuperHot = likes >= 50 && Number.isFinite(ageMin) && ageMin < 60;

    const viewsStr = views != null ? `${fmt(views)} views` : null;
    const ageStr = Number.isFinite(meta?.ageMin) ? fmtAgeMin(meta.ageMin) : null;
    const emoji = badgeEmojiFor(id, meta);
    const ir = interactionRate(
      idToLikes.get(id),
      idToComments.get(id),
      idToRemixes.get(id),
      idToShares.get(id),
      idToDownloads.get(id),
      idToUnique.get(id)
    );
    const irStr = ir ? `${ir} IR` : null;

    const textParts = [viewsStr, irStr, ageStr, emoji].filter(Boolean);
    badge.textContent = textParts.join(' • ');

    const bg = badgeBgFor(id, meta);
    badge.style.background = bg || 'rgba(0,0,0,0.72)';

    // [NEW] Add/remove shadow glow
    if (isSuperHot) {
      badge.style.boxShadow = '0 0 10px 3px hsla(0, 100%, 50%, 0.7)';
    } else {
      badge.style.boxShadow = 'none'; // IMPORTANT: reset it
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

  // ---------- [MODIFIED] Gathering Functions ----------
  
  function startGathering() {
    // Stop any existing timers just in case
    stopGathering(false); // Pass false to avoid clearing prefs

    console.log('Sora UV: Starting gathering...');
    
    // 1. Get speed settings from slider
    const prefs = getPrefs();
    const t = (prefs.gatherSpeed || 50) / 100; // Slider value 0.0 to 1.0

    let scrollMinMs, scrollMaxMs, refreshMinMs, refreshMaxMs, scrollAmountMin, scrollAmountMax;

    // These are the 3 key points for interpolation
    // Point 1 (t=0, Turtle): 13-15m refresh / 1.5-2.0s scroll / 150-250px amount
    const speedSlow = { sMin: 1500, sMax: 2000, rMin: 13*60*1000, rMax: 15*60*1000, aMin: 150, aMax: 250 };
    // Point 2 (t=0.5, Default): 4-7m refresh / 0.75-1.25s scroll / 200-300px amount
    const speedMid = { sMin: 750, sMax: 1250, rMin: 4*60*1000, rMax: 7*60*1000, aMin: 200, aMax: 300 };
    // Point 3 (t=1, Rabbit): 1-2m refresh / 0.25-0.75s scroll / 250-350px amount
    const speedFast = { sMin: 250, sMax: 750, rMin: 1*60*1000, rMax: 2*60*1000, aMin: 250, aMax: 350 };

    if (t <= 0.5) {
      // Interpolate between Slow and Mid
      const localT = t / 0.5; // Remap t from [0, 0.5] to [0, 1]
      scrollMinMs = lerp(speedSlow.sMin, speedMid.sMin, localT);
      scrollMaxMs = lerp(speedSlow.sMax, speedMid.sMax, localT);
      refreshMinMs = lerp(speedSlow.rMin, speedMid.rMin, localT);
      refreshMaxMs = lerp(speedSlow.rMax, speedMid.rMax, localT);
      scrollAmountMin = lerp(speedSlow.aMin, speedMid.aMin, localT);
      scrollAmountMax = lerp(speedSlow.aMax, speedMid.aMax, localT);
    } else {
      // Interpolate between Mid and Fast
      const localT = (t - 0.5) / 0.5; // Remap t from [0.5, 1] to [0, 1]
      scrollMinMs = lerp(speedMid.sMin, speedFast.sMin, localT);
      scrollMaxMs = lerp(speedMid.sMax, speedFast.sMax, localT);
      refreshMinMs = lerp(speedMid.rMin, speedFast.rMin, localT);
      refreshMaxMs = lerp(speedMid.rMax, speedFast.rMax, localT);
      scrollAmountMin = lerp(speedMid.aMin, speedFast.aMin, localT);
      scrollAmountMax = lerp(speedMid.aMax, speedFast.aMax, localT);
    }

    // 2. Recursive scroll function
    function randomScroll() {
      // 2a. Perform scroll action
      if (window.innerHeight + window.scrollY < document.body.scrollHeight - 100) {
           const scrollAmount = Math.random() * (scrollAmountMax - scrollAmountMin) + scrollAmountMin;
           window.scrollBy(0, scrollAmount);
      } else {
           console.log('Sora UV: Reached bottom, waiting for refresh.');
      }
      
      // 2b. Calculate next random delay
      const delay = Math.random() * (scrollMaxMs - scrollMinMs) + scrollMinMs;
      
      // 2c. Schedule next scroll
      gatherScrollIntervalId = setTimeout(randomScroll, delay); 
    }

    // Start the scroll loop
    randomScroll();

    // 3. Set refresh timer
    const now = Date.now();
    let refreshDelay;

    if (prefs.refreshDeadline && prefs.refreshDeadline > now) {
      refreshDelay = prefs.refreshDeadline - now;
      console.log(`Sora UV: Resuming refresh timer. ${Math.round(refreshDelay/1000)}s remaining.`);
    } else {
      refreshDelay = Math.random() * (refreshMaxMs - refreshMinMs) + refreshMinMs;
      const newDeadline = now + refreshDelay;
      prefs.refreshDeadline = newDeadline;
      setPrefs(prefs);
      console.log(`Sora UV: New refresh timer set for ${Math.round(refreshDelay/1000)}s.`);
    }

    gatherRefreshTimeoutId = setTimeout(() => {
      console.log('Sora UV: Refreshing page...');
      location.reload();
    }, refreshDelay);
  }

  function stopGathering(clearPrefs = true) {
    console.log('Sora UV: Stopping gathering.');

    if (gatherScrollIntervalId) {
      clearTimeout(gatherScrollIntervalId);
      gatherScrollIntervalId = null;
    }
    if (gatherRefreshTimeoutId) {
      clearTimeout(gatherRefreshTimeoutId);
      gatherRefreshTimeoutId = null;
    }

    if (clearPrefs) {
      const prefs = getPrefs();
      delete prefs.refreshDeadline;
      // We keep gatherSpeed, but clear the deadline
      setPrefs(prefs);
    }
  }

  // ---------- [MODIFIED] control bar ----------
  function getPrefs(){ try{return JSON.parse(localStorage.getItem(PREF_KEY)||'{}')}catch{return{}} }
  function setPrefs(p){ localStorage.setItem(PREF_KEY, JSON.stringify(p)); }
  function stylBtn(b){
    Object.assign(b.style,{
      background:'rgba(255,255,255,0.12)', color:'#fff',
      border:'1px solid rgba(255,255,255,0.2)', borderRadius:'8px',
      padding:'4px 8px', cursor:'pointer'
    });
    b.onmouseenter=()=> {
      if (b.dataset.gathering === 'true' || b.disabled) return;
      b.style.background='rgba(255,255,255,0.2)';
    };
    b.onmouseleave=()=> {
       if (b.dataset.gathering === 'true' || b.disabled) return;
       b.style.background='rgba(255,255,255,0.12)';
    };
  }

  function ensureControlBar(){
    if (controlBar && document.contains(controlBar)) return controlBar;
    
    // --- Create Control Bar ---
    const bar = document.createElement('div');
    bar.className='sora-uv-controls';
    Object.assign(bar.style,{
      position:'fixed', top:'12px', right:'12px', zIndex:999999,
      display:'flex', gap:'8px', padding:'6px 8px', borderRadius:'10px',
      background:'rgba(0,0,0,0.55)', color:'#fff', fontSize:'12px',
      alignItems:'center', backdropFilter:'blur(2px)', userSelect:'none',
      flexDirection: 'column' // [NEW] Stack controls vertically
    });
    
    // [NEW] Create a container for the buttons
    const buttonContainer = document.createElement('div');
    buttonContainer.style.display = 'flex';
    buttonContainer.style.gap = '8px';

    // --- Initialize Prefs ---
    let prefs = getPrefs();
    if (typeof prefs.filterIndex !== 'number') prefs.filterIndex = 0;
    if (typeof prefs.isGathering !== 'boolean') prefs.isGathering = false;
    if (typeof prefs.gatherSpeed !== 'string') prefs.gatherSpeed = '50'; // Slider val is string
    setPrefs(prefs); 

    // --- Filter Button ---
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
    buttonContainer.appendChild(filterBtn); // Add to button container

    // --- Gather Button ---
    const gatherBtn = document.createElement('button');
    gatherBtn.dataset.gathering = 'false';
    stylBtn(gatherBtn);
    buttonContainer.appendChild(gatherBtn); // Add to button container
    
    bar.appendChild(buttonContainer); // Add button container to main bar

    // --- [NEW] Gather Speed Slider ---
    const sliderContainer = document.createElement('div');
    sliderContainer.className = 'sora-uv-slider-container';
    Object.assign(sliderContainer.style, {
        display: 'none', // Hidden by default
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
    slider.value = prefs.gatherSpeed;
    slider.style.flexGrow = '1';
    
    const emojiRabbit = document.createElement('span');
    emojiRabbit.textContent = '🐇';

    sliderContainer.appendChild(emojiTurtle);
    sliderContainer.appendChild(slider);
    sliderContainer.appendChild(emojiRabbit);
    bar.appendChild(sliderContainer); // Add slider container to main bar

    // --- [NEW] Slider Event Listeners ---
    const onSliderChange = () => {
        let p = getPrefs();
        p.gatherSpeed = slider.value;
        setPrefs(p);
        // Restart gathering to apply new speed
        if (p.isGathering) {
            startGathering();
        }
    };
    slider.addEventListener('input', onSliderChange); // 'input' is more fluid than 'change'

    // --- State Update Function ---
    function updateGatherState() {
      const p = getPrefs();
      if (p.isGathering) {
        gatherBtn.textContent = 'Gathering...';
        gatherBtn.style.background = 'hsla(120, 60%, 30%, 0.9)';
        gatherBtn.dataset.gathering = 'true';
        filterBtn.disabled = true; 
        filterBtn.style.opacity = '0.5';
        filterBtn.style.cursor = 'not-allowed';
        sliderContainer.style.display = 'flex'; // [NEW] Show slider
        startGathering();
      } else {
        gatherBtn.textContent = 'Gather';
        gatherBtn.style.background = 'rgba(255,255,255,0.12)';
        gatherBtn.dataset.gathering = 'false';
        filterBtn.disabled = false;
        filterBtn.style.opacity = '1';
        filterBtn.style.cursor = 'pointer';
        sliderContainer.style.display = 'none'; // [NEW] Hide slider
        stopGathering(true);
      }
    }

    gatherBtn.onclick = () => {
      let p = getPrefs();
      p.isGathering = !p.isGathering; // Toggle state
      setPrefs(p);
      updateGatherState(); // Apply the new state
      
      if (p.isGathering) {
          p = getPrefs();
          p.filterIndex = 0;
          setPrefs(p);
          prefs.filterIndex = 0;
          setLabel();
          applyFilter();
      }
    };
    
    // --- Init ---
    document.documentElement.appendChild(bar);
    controlBar = bar;
    
    updateGatherState(); // Run on load

    return bar;
  }

  // ---------- [MODIFIED] filtering (cycles through thresholds) ----------
  function applyFilter(){
    const prefs = getPrefs();
    
    if (prefs.isGathering) {
        if (prefs.filterIndex !== 0) {
             prefs.filterIndex = 0;
             setPrefs(prefs);
             const filterBtn = controlBar?.querySelector('button');
             if(filterBtn) filterBtn.textContent = FILTER_LABELS[0];
        }
    }

    const idx = typeof prefs.filterIndex === 'number' ? prefs.filterIndex : 0;
    const limitMin = FILTER_STEPS_MIN[idx]; 

    for (const card of selectAllCards()){
      const id = extractIdFromCard(card);
      const meta = idToMeta.get(id);
      
      if (limitMin == null || prefs.isGathering) {
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
  
  // [MODIFIED] Function
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
    const ir = interactionRate(
      likes,
      idToComments.get(sid),
      idToRemixes.get(sid),
      idToShares.get(sid),
      idToDownloads.get(sid),
      uv
    );
    if (uv == null && !rate && !ir) return;
    const el = ensureDetailBadge();
    const meta = idToMeta.get(sid);

    // [NEW] Check for super-hot state
    const ageMin = meta?.ageMin;
    const isSuperHot = (likes ?? 0) >= 50 && Number.isFinite(ageMin) && ageMin < 60;

    const viewsStr = uv != null ? `${fmt(uv)} views` : null;
    const ageStr = Number.isFinite(meta?.ageMin) ? fmtAgeMin(meta.ageMin) : null;
    const emoji = badgeEmojiFor(sid, meta);
    const irStr = ir ? `${ir} IR` : null;
    el.textContent = [viewsStr, irStr, ageStr, emoji].filter(Boolean).join(' • ');

    const bg = badgeBgFor(sid, meta);
    el.style.background = bg || 'rgba(0,0,0,0.75)';

    // [NEW] Add/remove shadow glow
    if (isSuperHot) {
      el.style.boxShadow = '0 0 10px 3px hsla(0, 100%, 50%, 0.7)';
    } else {
      el.style.boxShadow = 'none'; // IMPORTANT: reset it
    }

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
  function onRouteChange() { renderBadges(); renderDetailBadge(); }

  // ---------- network interception ----------
  const FEED_RE = /\/backend\/project_y\/(feed|profile_feed|profile\/)/;
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

  // Try to extract the post owner's identity (handle/id) from the item
  function getOwner(item){
    try {
      const p = item?.post ?? item;
      const prof = item?.profile || item?.user || item?.author || p?.author || p?.owner || null;
      let handle = prof?.handle || prof?.username || prof?.name || null;
      let id = prof?.id || prof?.user_id || prof?._id || null;
      if (!handle) {
        // some feeds put it deeper
        handle = p?.profile?.handle || p?.user?.username || null;
      }
      return { handle: (typeof handle === 'string' && handle) ? handle : null, id: id ?? null };
    } catch { return { handle:null, id:null }; }
  }

  // Build minimal meta (age only) and store counters used for coloring/emojis
  function processFeedJson(json) {
    const items = json?.items || json?.data?.items || [];
    const pageHandle = isProfile() ? currentProfileHandleFromURL() : null;
    const pageUserHandle = pageHandle || null;
    const pageUserKey = pageUserHandle ? `h:${pageUserHandle.toLowerCase()}` : 'unknown';
    const batch = [];

    // If this is a profile object (not an items list), capture followers directly
    try {
      const profFollowers = Number(json?.follower_count);
      const profHandle = json?.username || json?.handle || pageUserHandle || null;
      const profId = json?.user_id || json?.id || null;
      if (Number.isFinite(profFollowers) && profHandle) {
        const userKey = `h:${String(profHandle).toLowerCase()}`;
        batch.push({ followers: profFollowers, ts: Date.now(), userHandle: profHandle, userId: profId, userKey, pageUserHandle, pageUserKey });
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
      const sh = getShares(it);
      const dl = getDownloads(it);
      const p = it?.post || it || {};
      const created_at = p?.created_at ?? p?.uploaded_at ?? p?.createdAt ?? p?.created ?? p?.posted_at ?? p?.timestamp ?? null;
      const ageMin = minutesSince(created_at);
      const th = getThumbnail(it);

      if (uv != null) idToUnique.set(id, uv);
      if (likes != null) idToLikes.set(id, likes);
      if (tv != null) idToViews.set(id, tv);
      if (cm != null) idToComments.set(id, cm);
      if (rx != null) idToRemixes.set(id, rx);
      if (sh != null) idToShares.set(id, sh);
      if (dl != null) idToDownloads.set(id, dl);
      idToMeta.set(id, { ageMin });

      const absUrl = `${location.origin}/p/${id}`;
      const owner = getOwner(it);
      const userHandle = owner.handle || pageUserHandle || null;
      const userId = owner.id || null;
      const userKey = userHandle ? `h:${userHandle.toLowerCase()}` : (userId != null ? `id:${userId}` : pageUserKey);
      const followers = getFollowerCount(it);
      batch.push({ postId: id, uv, likes, views: tv, comments: cm, remixes: rx, shares: sh, downloads: dl, followers, created_at, ageMin, thumb: th, url: absUrl, ts: Date.now(), userHandle, userId, userKey, pageUserHandle, pageUserKey });
    }
    if (batch.length) try { window.postMessage({ __sora_uv__: true, type: 'metrics_batch', items: batch }, '*'); } catch {}
    renderBadges();
    renderDetailBadge();
  }

  // (bootstrap removed to avoid hitting authed endpoints and causing 401s)

  // ---------- boot ----------
  function init(){ installFetchSniffer(); startObservers(); onRouteChange(); }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else { init(); }
})();
