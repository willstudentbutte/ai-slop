/* Dashboard for Sora Metrics */
(function(){
  'use strict';

  const $ = (sel, el=document) => el.querySelector(sel);
  const $$ = (sel, el=document) => Array.from(el.querySelectorAll(sel));
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
    let entries = Object.entries(metrics.users);
    // Sort alphabetical, pushing 'unknown' to the end
    const users = entries.sort((a,b)=>{
      const A = (a[1].handle||a[0]||'').toLowerCase();
      const B = (b[1].handle||b[0]||'').toLowerCase();
      const ax = a[0]==='unknown' ? 1 : 0;
      const bx = b[0]==='unknown' ? 1 : 0;
      if (ax !== bx) return ax - bx;
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
    res.sort((a,b)=> (a[1].handle||a[0]||'').localeCompare(b[1].handle||b[0]||''));
    return res;
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
      const cap = (typeof p?.caption === 'string' && p.caption) ? p.caption.trim() : null;
      const label = cap || pid; // one-line dynamic via CSS ellipsis
      const title = cap || pid;
      if (DBG_SORT){
        try { console.log(`[Dashboard] sort pid=${pid} raw=${rawPT} norm=${postTime} pidBI=${bi.toString()}`); } catch {}
      }
      return { pid, url: absUrl(p.url, pid), thumb: p.thumb, label, title, last, first, postTime, pidBI: bi, rate };
    });
    // Sort newest first assuming larger post_time is newer
    const withTs = mapped.filter(x=>x.postTime>0).sort((a,b)=>b.postTime - a.postTime);
    const noTs  = mapped.filter(x=>x.postTime<=0).sort((a,b)=>{
      if (a.pidBI === b.pidBI) return a.pid.localeCompare(b.pid);
      return a.pidBI < b.pidBI ? 1 : -1; // descending: bigger id => newer first
    });
    const posts = withTs.concat(noTs);

    // Update metric cards (sum of latest values for visible posts)
    try{
      const viewsEl = $('#viewsTotal');
      const likesEl = $('#likesTotal');
      const repliesEl = $('#repliesTotal');
      const remixesEl = $('#remixesTotal');
      const interEl = $('#interactionsTotal');
      let totalViews = 0, totalLikes = 0, totalReplies = 0, totalRemixes = 0, totalInteractions = 0;
      const current = visibleSet ? Array.from(visibleSet) : [];
      for (const pid of current){
        const post = user.posts?.[pid];
        const last = latestSnapshot(post?.snapshots);
        totalViews += num(last?.views);
        totalLikes += num(last?.likes);
        totalReplies += num(last?.comments); // non-recursive
        totalRemixes += num(latestRemixCountForPost(post));
        totalInteractions += interactionsOfSnap(last);
      }
      if (viewsEl) viewsEl.textContent = fmt2(totalViews);
      if (likesEl) likesEl.textContent = fmt2(totalLikes);
      if (repliesEl) repliesEl.textContent = fmtK2OrInt(totalReplies);
      if (remixesEl) remixesEl.textContent = fmt2(totalRemixes);
      if (interEl) interEl.textContent = fmt2(totalInteractions);
    } catch {}

    for (let i=0;i<posts.length;i++){
      const p = posts[i];
      const row = document.createElement('label');
      row.className='post';
      row.dataset.pid = p.pid;
      const color = typeof colorFor === 'function' ? colorFor(p.pid) : COLORS[i % COLORS.length];
      const thumbStyle = p.thumb ? `background-image:url('${p.thumb.replace(/'/g,"%27")}')` : '';
      row.innerHTML = `
        <div class="dot" style="background:${color}"></div>
        <div class="thumb" style="${thumbStyle}"></div>
        <div class="meta">
          <div class="id"><a href="${p.url}" target="_blank" rel="noopener" title="${esc(p.title)}">${esc(p.label)}</a></div>
          <div class="stats">Unique ${fmt(p.last?.uv)} • Likes ${fmt(p.last?.likes)} • IR ${p.rate==null?'-':p.rate.toFixed(1)+'%'}</div>
        </div>
        <div class="toggle" data-pid="${p.pid}">Hide</div>
      `;
      if (visibleSet && !visibleSet.has(p.pid)) { row.classList.add('hidden'); row.querySelector('.toggle').textContent = 'Show'; }
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
    const res = { views:0, likes:0, replies:0, remixes:0, interactions:0 };
    if (!user || !user.posts) return res;
    for (const [pid, p] of Object.entries(user.posts)){
      const last = latestSnapshot(p?.snapshots);
      if (!last) continue;
      res.views += num(last?.views);
      res.likes += num(last?.likes);
      res.replies += num(last?.comments);
      res.remixes += num(latestRemixCountForPost(p));
      res.interactions += interactionsOfSnap(last);
    }
    return res;
  }

  function computeSeriesForUser(user, selectedPIDs, colorFor){
    const series=[];
    const entries = Object.entries(user.posts||{});
    for (let i=0;i<entries.length;i++){
      const [pid, p] = entries[i];
      const pts = [];
      for (const s of (p.snapshots||[])){
        const r = interactionRate(s);
        if (s.uv != null && r != null) pts.push({ x:s.uv, y:r, t:s.t });
      }
      const color = typeof colorFor === 'function' ? colorFor(pid) : COLORS[i % COLORS.length];
      const cap = (typeof p?.caption === 'string' && p.caption) ? p.caption.trim() : null;
      const label = cap || pid;
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

  function makeChart(canvas){
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
      state.series = series;
      const xs=[], ys=[];
      for (const s of series){
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
      ctx.fillText('Unique viewers', W/2-50, H-6);
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
          s.points.sort((a,b)=>a.t-b.t);
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
    function nearest(mx,my){
      let best=null, bd=Infinity;
      for (const s of state.series){
        for (const p of s.points){
          const x = mapX(p.x), y = mapY(p.y);
          // ignore points outside plot
          if (x < M.left || x > W - M.right || y < M.top || y > H - M.bottom) continue;
          const d = Math.hypot(mx-x,my-y);
          if (d<bd && d<16) { bd=d; best = { pid: s.id, label: s.label || s.id, x:p.x, y:p.y, t:p.t, color:s.color, highlighted:s.highlighted, url: s.url }; }
        }
      }
      return best;
    }

    function showTooltip(h, clientX, clientY){
      if (!h){ tooltip.style.display='none'; return; }
      tooltip.style.display='block';
      const header = `<div style="display:flex;align-items:center;gap:6px"><span class="dot" style="background:${h.color}"></span><strong>${esc(h.label||h.pid)}</strong></div>`;
      const body = `<div>Unique: ${fmt(h.x)} • IR: ${h.y.toFixed(1)}%</div>`;
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

    // Zoom drag state
    let drag = null; // {x0,y0,x1,y1}

    canvas.addEventListener('mousemove', (e)=>{
      const rect = canvas.getBoundingClientRect();
      const mx = (e.clientX - rect.left) * (canvas.width/rect.width) / DPR;
      const my = (e.clientY - rect.top) * (canvas.height/rect.height) / DPR;
      if (drag){ drag.x1 = mx; drag.y1 = my; draw(); drawDragRect(drag); showTooltip(null); return; }
      const h = nearest(mx,my); const prev = state.hoverSeries; state.hover = h; state.hoverSeries = h?.pid || null; if (hoverCb && prev !== state.hoverSeries) hoverCb(state.hoverSeries); draw(); showTooltip(h, e.clientX, e.clientY);
    });
    canvas.addEventListener('mouseleave', ()=>{ state.hover=null; state.hoverSeries=null; if (hoverCb) hoverCb(null); draw(); showTooltip(null); });
    canvas.addEventListener('click', ()=>{
      if (state.hover && state.hover.url) window.open(state.hover.url, '_blank');
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
    return { setData, resetZoom, setHoverSeries, onHover, getZoom, setZoom };
  }

  function makeTimeChart(canvas, tooltipSelector = '#viewsTooltip'){
    const ctx = canvas.getContext('2d');
    const DPR = Math.max(1, window.devicePixelRatio||1);
    let W = canvas.clientWidth||canvas.width, H = canvas.clientHeight||canvas.height;
    const M = { left:58, top:20, right:30, bottom:40 };
    function resize(){
      W = canvas.clientWidth||canvas.width; H = canvas.clientHeight||canvas.height;
      canvas.width = Math.floor(W*DPR); canvas.height = Math.floor(H*DPR); ctx.setTransform(DPR,0,0,DPR,0,0);
      draw();
    }
    const state = { series:[], x:[0,1], y:[0,1], zoomX:null, zoomY:null, hover:null, hoverSeries:null };
    let hoverCb = null;

    function setData(series){
      state.series = series;
      const xs=[], ys=[];
      for (const s of series){
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
      const dayKeys = tickVals.map(t=>{ try{ const d=new Date(t); return d.getFullYear()+"-"+(d.getMonth()+1)+"-"+d.getDate(); } catch { return String(t);} });
      const counts = new Map(); dayKeys.forEach(k=>counts.set(k,(counts.get(k)||0)+1));
      const hasDupDays = Array.from(counts.values()).some(c=>c>1);
      for (let i=0;i<=xticks;i++){
        const x = M.left + i*(W-(M.left+M.right))/xticks; const v = tickVals[i];
        const label = hasDupDays ? fmtDateTime(v) : fmtDate(v);
        const off = hasDupDays ? 36 : 24;
        ctx.fillText(label, x-off, H - (M.bottom - 18));
      }
      for (let i=0;i<=yticks;i++){
        const y = H - M.bottom - i*(H-(M.top+M.bottom))/yticks; const v = yDomain[0] + i*(yDomain[1]-yDomain[0])/yticks;
        ctx.fillText(fmt(Math.round(v)), 10, y+4);
      }
      ctx.fillStyle = '#e8eaed'; ctx.font = 'bold 13px system-ui, -apple-system, Segoe UI, Roboto, Arial';
      ctx.fillText('Time', W/2-20, H-6);
      ctx.save(); ctx.translate(12, H/2+20); ctx.rotate(-Math.PI/2); ctx.fillText('Views', 0,0); ctx.restore();
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
            best = { pid: s.id, label: s.label || s.id, x: p.x, y: p.y, t: p.t, color: s.color, url: s.url };
          }
        }
      }
      return best;
    }
    const tooltip = $(tooltipSelector);
    function showTooltip(h, clientX, clientY){
      if (!h){ tooltip.style.display='none'; return; }
      tooltip.style.display='block';
      const header = `<div style="display:flex;align-items:center;gap:6px"><span class="dot" style="background:${h.color}"></span><strong>${esc(h.label||h.pid)}</strong></div>`;
      const body = `<div>${fmtDateTime(h.x)} • Views: ${fmt(h.y)}</div>`;
      tooltip.innerHTML = header + body;
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
    let drag=null;
    canvas.addEventListener('mousemove',(e)=>{
      const rect=canvas.getBoundingClientRect();
      const mx=(e.clientX-rect.left)*(canvas.width/rect.width)/DPR; const my=(e.clientY-rect.top)*(canvas.height/rect.height)/DPR;
      if (drag){ drag.x1=mx; drag.y1=my; draw(); drawDragRect(drag); showTooltip(null); return; }
      const h = nearest(mx,my); const prev=state.hoverSeries; state.hover=h; state.hoverSeries=h?.pid||null; if (hoverCb && prev!==state.hoverSeries) hoverCb(state.hoverSeries); draw(); showTooltip(h,e.clientX,e.clientY);
    });
    canvas.addEventListener('mouseleave', ()=>{ state.hover=null; state.hoverSeries=null; if (hoverCb) hoverCb(null); draw(); showTooltip(null); });
    // Track recent double-click to avoid opening posts while resetting zoom
    let lastDblClickTs = 0;
    canvas.addEventListener('dblclick', ()=>{ lastDblClickTs = Date.now(); state.zoomX=null; state.zoomY=null; draw(); });
    canvas.addEventListener('click', ()=>{
      if (Date.now() - lastDblClickTs < 250) return; // ignore clicks immediately after dblclick
      if (state.hover && state.hover.url) window.open(state.hover.url,'_blank');
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
    function drawSeries(){
      const muted='#38424c'; const anyHover=!!state.hoverSeries;
      for (const s of state.series){ const color=(anyHover && state.hoverSeries!==s.id)?muted:s.color; if (s.points.length>1){ ctx.strokeStyle=color; ctx.lineWidth=1.4; ctx.beginPath(); s.points.sort((a,b)=>a.t-b.t);
        for (let i=0;i<s.points.length;i++){ const p=s.points[i]; const x=mapX(p.x), y=mapY(p.y); if (i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);} ctx.stroke(); }
        for (const p of s.points){ const x=mapX(p.x), y=mapY(p.y); const isHover=state.hover && state.hover.pid===s.id && state.hover.i===p.t; ctx.fillStyle=color; ctx.beginPath(); ctx.arc(x,y,isHover?4.2:2.4,0,Math.PI*2); ctx.fill(); if (isHover){ ctx.strokeStyle='#ffffffaa'; ctx.lineWidth=1; ctx.beginPath(); ctx.arc(x,y,6,0,Math.PI*2); ctx.stroke(); } }
      }
    }
    function draw(){ ctx.clearRect(0,0,canvas.width,canvas.height); grid(); axes(); drawSeries(); }
    window.addEventListener('resize', resize); resize();
    function resetZoom(){ state.zoomX=null; state.zoomY=null; draw(); }
    function setHoverSeries(pid){ state.hoverSeries=pid||null; draw(); }
    function onHover(cb){ hoverCb=cb; }
    function getZoom(){ return { x: state.zoomX ? [...state.zoomX] : null, y: state.zoomY ? [...state.zoomY] : null }; }
    function setZoom(z){ if (!z) return; if (z.x && isFinite(z.x[0]) && isFinite(z.x[1])) state.zoomX = [z.x[0], z.x[1]]; if (z.y && isFinite(z.y[0]) && isFinite(z.y[1])) state.zoomY = [z.y[0], z.y[1]]; draw(); }
    return { setData, resetZoom, setHoverSeries, onHover, getZoom, setZoom };
  }

  // Followers time chart (single-series, Y-axis = Followers)
  function makeFollowersChart(canvas){
    const ctx = canvas.getContext('2d');
    const DPR = Math.max(1, window.devicePixelRatio||1);
    let W = canvas.clientWidth||canvas.width, H = canvas.clientHeight||canvas.height;
    const M = { left:58, top:20, right:30, bottom:40 };
    function resize(){ W=canvas.clientWidth||canvas.width; H=canvas.clientHeight||canvas.height; canvas.width=Math.floor(W*DPR); canvas.height=Math.floor(H*DPR); ctx.setTransform(DPR,0,0,DPR,0,0); draw(); }
    const state = { series:[], x:[0,1], y:[0,1], zoomX:null, zoomY:null, hover:null };
    function setData(series){ state.series = series; const xs=[], ys=[]; for (const s of series){ for (const p of s.points){ xs.push(p.x); ys.push(p.y); } } state.x=extent(xs,d=>d); state.y=extent(ys,d=>d); draw(); }
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
      const dayKeys = tickVals.map(t=>{ try{ const d=new Date(t); return d.getFullYear()+"-"+(d.getMonth()+1)+"-"+d.getDate(); } catch { return String(t);} });
      const counts = new Map(); dayKeys.forEach(k=>counts.set(k,(counts.get(k)||0)+1));
      const hasDupDays = Array.from(counts.values()).some(c=>c>1);
      for (let i=0;i<=xticks;i++){
        const x=M.left+i*(W-(M.left+M.right))/xticks; const v=tickVals[i]; const label = hasDupDays ? fmtDateTime(v) : fmtDate(v); const off = hasDupDays ? 36 : 24; ctx.fillText(label, x-off, H-(M.bottom-18));
      }
      for (let i=0;i<=yticks;i++){ const y=H-M.bottom - i*(H-(M.top+M.bottom))/yticks; const v=yDomain[0]+i*(yDomain[1]-yDomain[0])/yticks; ctx.fillText(fmt2(v), 10, y+4); }
      ctx.fillStyle='#e8eaed'; ctx.font='bold 13px system-ui, -apple-system, Segoe UI, Roboto, Arial'; ctx.fillText('Time', W/2-20, H-6); ctx.save(); ctx.translate(12,H/2+20); ctx.rotate(-Math.PI/2); ctx.fillText('Followers',0,0); ctx.restore();
    }
    function drawSeries(){ const s=state.series[0]; if (!s) return; ctx.strokeStyle=s.color||'#ffd166'; ctx.lineWidth=1.6; ctx.beginPath(); const pts=[...s.points].sort((a,b)=>a.t-b.t); for (let i=0;i<pts.length;i++){ const p=pts[i]; const x=mapX(p.x), y=mapY(p.y); if (i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y); } ctx.stroke(); for (const p of pts){ const x=mapX(p.x), y=mapY(p.y); ctx.fillStyle=s.color||'#ffd166'; ctx.beginPath(); ctx.arc(x,y,2.4,0,Math.PI*2); ctx.fill(); }
    }
    function draw(){ ctx.clearRect(0,0,canvas.width,canvas.height); grid(); axes(); drawSeries(); }
    const tooltip = $('#followersTooltip');
    function nearest(mx,my){ const s=state.series[0]; if (!s) return null; let best=null,bd=Infinity; for (const p of s.points){ const x=mapX(p.x), y=mapY(p.y); if (x<M.left||x>W-M.right||y<M.top||y>H-M.bottom) continue; const d=Math.hypot(mx-x,my-y); if (d<bd && d<16){ bd=d; best={ x:p.x, y:p.y, t:p.t, color:s.color }; } } return best; }
    function showTooltip(h,cx,cy){
      if (!h){ tooltip.style.display='none'; return; }
      tooltip.style.display='block';
      tooltip.innerHTML = `<div style="display:flex;align-items:center;gap:6px"><span class="dot" style="background:${h.color||'#ffd166'}"></span><strong>Followers</strong></div>`+`<div>${fmtDateTime(h.x)} • Followers: ${fmt2(h.y)}</div>`;
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
    let drag=null; canvas.addEventListener('mousemove',(e)=>{ const rect=canvas.getBoundingClientRect(); const mx=(e.clientX-rect.left)*(canvas.width/rect.width)/DPR; const my=(e.clientY-rect.top)*(canvas.height/rect.height)/DPR; if (drag){ drag.x1=mx; drag.y1=my; draw(); drawDragRect(drag); showTooltip(null); return; } const h=nearest(mx,my); state.hover=h; draw(); showTooltip(h,e.clientX,e.clientY); });
    canvas.addEventListener('mouseleave', ()=>{ state.hover=null; draw(); showTooltip(null); });
    canvas.addEventListener('mousedown',(e)=>{ const rect=canvas.getBoundingClientRect(); let x0=(e.clientX-rect.left)*(canvas.width/rect.width)/DPR; let y0=(e.clientY-rect.top)*(canvas.height/rect.height)/DPR; drag={x0,y0,x1:null,y1:null}; });
    window.addEventListener('mouseup',(e)=>{ if (!drag) return; const rect=canvas.getBoundingClientRect(); let x1=(e.clientX-rect.left)*(canvas.width/rect.width)/DPR; let y1=(e.clientY-rect.top)*(canvas.height/rect.height)/DPR; const [cx0,cy0]=clampToPlot(drag.x0,drag.y0); const [cx1,cy1]=clampToPlot(x1,y1); drag.x1=cx1; drag.y1=cy1; const minW=10,minH=10; const w=Math.abs(cx1-cx0), h=Math.abs(cy1-cy0); if (w>minW && h>minH){ const [X0,X1]=[cx0,cx1].sort((a,b)=>a-b); const [Y0,Y1]=[cy0,cy1].sort((a,b)=>a-b); const invMapX=(px)=>{ const [a,b]=(state.zoomX||state.x); return a + ((px-M.left)/(W-(M.left+M.right)))*(b-a); }; const invMapY=(py)=>{ const [a,b]=(state.zoomY||state.y); return a + (((H-M.bottom)-py)/(H-(M.top+M.bottom)))*(b-a); }; state.zoomX=[invMapX(X0),invMapX(X1)]; state.zoomY=[invMapY(Y1),invMapY(Y0)]; } drag=null; draw(); showTooltip(null); });
    function drawDragRect(d){ if (!d||d.x1==null||d.y1==null) return; ctx.save(); ctx.strokeStyle='#7dc4ff'; ctx.fillStyle='#7dc4ff22'; ctx.lineWidth=1; ctx.setLineDash([4,3]); const x0=Math.max(M.left,Math.min(W-M.right,d.x0)); const y0=Math.max(M.top,Math.min(H-M.bottom,d.y0)); const x1=Math.max(M.left,Math.min(W-M.right,d.x1)); const y1=Math.max(M.top,Math.min(H-M.bottom,d.y1)); const x=Math.min(x0,x1), y=Math.min(y0,y1), w=Math.abs(x1-x0), h=Math.abs(y1-y0); ctx.strokeRect(x,y,w,h); ctx.fillRect(x,y,w,h); ctx.restore(); }
    canvas.addEventListener('dblclick', ()=>{ state.zoomX=null; state.zoomY=null; draw(); });
    window.addEventListener('resize', resize);
    resize();
    function resetZoom(){ state.zoomX=null; state.zoomY=null; draw(); }
    function getZoom(){ return { x: state.zoomX ? [...state.zoomX] : null, y: state.zoomY ? [...state.zoomY] : null }; }
    function setZoom(z){ if (!z) return; if (z.x && isFinite(z.x[0]) && isFinite(z.x[1])) state.zoomX = [z.x[0], z.x[1]]; if (z.y && isFinite(z.y[0]) && isFinite(z.y[1])) state.zoomY = [z.y[0], z.y[1]]; draw(); }
    return { setData, resetZoom, getZoom, setZoom };
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

  async function main(){
    let metrics = await loadMetrics();
    // Build list and try to restore last user
    let currentUserKey = buildUserOptions(metrics);
    try {
      const { lastUserKey } = await chrome.storage.local.get('lastUserKey');
      if (lastUserKey && metrics.users[lastUserKey]) currentUserKey = lastUserKey;
    } catch {}
    const selEl = $('#userSelect'); if (currentUserKey) selEl.value = currentUserKey;
    const chart = makeChart($('#chart'));
    const viewsChart = makeTimeChart($('#viewsChart'), '#viewsTooltip');
    const followersChart = makeFollowersChart($('#followersChart'));
    const allViewsChart = makeTimeChart($('#allViewsChart'), '#allViewsTooltip');
    // Load persisted zoom states
    let zoomStates = {};
    try { const st = await chrome.storage.local.get('zoomStates'); zoomStates = st.zoomStates || {}; } catch {}
    const visibleSet = new Set();
    let visibilityByUser = {};
    try {
      const st = await chrome.storage.local.get('visibilityByUser');
      visibilityByUser = st.visibilityByUser || {};
    } catch {}

    function persistVisibility(){
      visibilityByUser[currentUserKey] = Array.from(visibleSet);
      try { chrome.storage.local.set({ visibilityByUser }); } catch {}
    }

    async function refreshUserUI(opts={}){
      const { preserveEmpty=false } = opts;
      const user = metrics.users[currentUserKey];
      if (!user){
        buildPostsList(null, ()=>COLORS[0], new Set()); chart.setData([]); return;
      }
      // No precompute needed for IR; use latest available remix count only for cards
      // Integrity check: remove posts incorrectly attributed to this user
      // Reconcile ownership (selected user only), then reclaim, then remove empty posts
      await pruneMismatchedPostsForUser(metrics, currentUserKey);
      await reclaimFromUnknownForUser(metrics, currentUserKey);
      await pruneEmptyPostsForUser(metrics, currentUserKey);
      const colorFor = makeColorMap(user);
      if (visibleSet.size === 0 && !preserveEmpty){
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
      buildPostsList(user, colorFor, visibleSet, { onHover: (pid)=> { chart.setHoverSeries(pid); viewsChart.setHoverSeries(pid); } });
      // Update unfiltered totals cards
      try {
        const t = computeTotalsForUser(user);
        const allViewsEl = $('#allViewsTotal'); if (allViewsEl) allViewsEl.textContent = fmt2(t.views);
        const allLikesEl = $('#allLikesTotal'); if (allLikesEl) allLikesEl.textContent = fmt2(t.likes);
        const allRepliesEl = $('#allRepliesTotal'); if (allRepliesEl) allRepliesEl.textContent = fmtK2OrInt(t.replies);
        const allRemixesEl = $('#allRemixesTotal'); if (allRemixesEl) allRemixesEl.textContent = fmt2(t.remixes);
        const allInterEl = $('#allInteractionsTotal'); if (allInterEl) allInterEl.textContent = fmt2(t.interactions);
      } catch {}
      const series = computeSeriesForUser(user, [], colorFor)
        .filter(s=>visibleSet.has(s.id))
        .map(s=>({ ...s, url: absUrl(user.posts?.[s.id]?.url, s.id) }));
      chart.setData(series);
      // Time chart: cumulative views by time
      const vSeries = (function(){
        const out=[]; for (const [pid,p] of Object.entries(user.posts||{})){
          if (!visibleSet.has(pid)) continue; const pts=[]; for (const s of (p.snapshots||[])){ const t=s.t; const v=s.views; if (t!=null && v!=null) pts.push({ x:Number(t), y:Number(v), t:Number(t) }); }
          const color=colorFor(pid); const label = (typeof p?.caption==='string'&&p.caption)?p.caption.trim():pid; if (pts.length) out.push({ id: pid, label, color, points: pts, url: absUrl(p.url, pid) }); }
        return out; })();
      viewsChart.setData(vSeries);
      // All posts cumulative views (unfiltered): aggregate across all posts
      try {
        const pts = (function(){
          const events = [];
          for (const [pid, p] of Object.entries(user.posts||{})){
            for (const s of (p.snapshots||[])){
              const t = Number(s.t), v = Number(s.views);
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
        const series = pts.length ? [{ id: 'all_posts', color, points: pts }] : [];
        allViewsChart.setData(series);
      } catch {}
      // Update Total Followers card
      try {
        const fEl = $('#followersTotal');
        if (fEl){
          const arr = Array.isArray(user.followers) ? user.followers : [];
          const last = arr[arr.length - 1];
          fEl.textContent = last ? fmtK2OrInt(last.count) : '0';
        }
      } catch {}
      // Followers chart: use user-level follower history when available
      const fSeries = (function(){
        const arr = Array.isArray(user.followers) ? user.followers : [];
        const pts = arr.map(it=>({ x:Number(it.t), y:Number(it.count), t:Number(it.t) })).filter(p=>isFinite(p.x)&&isFinite(p.y));
        const color = '#ffd166';
        return pts.length ? [{ id: 'followers', color, points: pts }] : [];
      })();
      followersChart.setData(fSeries);
      // Restore any saved zoom for this user
      try {
        const z = zoomStates[currentUserKey] || {};
        if (z.scatter) chart.setZoom(z.scatter);
        if (z.views) viewsChart.setZoom(z.views);
        if (z.followers) followersChart.setZoom(z.followers);
        if (z.viewsAll) allViewsChart.setZoom(z.viewsAll);
      } catch {}
      // Sync chart hover back to list
      chart.onHover((pid)=>{
        const wrap = $('#posts');
        if (!wrap) return;
        if (pid){
          wrap.classList.add('is-hovering');
          $$('.post', wrap).forEach(r=>{ if (r.dataset.pid===pid) r.classList.add('hover'); else r.classList.remove('hover'); });
        } else {
          wrap.classList.remove('is-hovering');
          $$('.post', wrap).forEach(r=>r.classList.remove('hover'));
        }
        viewsChart.setHoverSeries(pid);
      });
      viewsChart.onHover((pid)=>{
        const wrap = $('#posts'); if (!wrap) return;
        if (pid){ wrap.classList.add('is-hovering'); $$('.post', wrap).forEach(r=>{ if (r.dataset.pid===pid) r.classList.add('hover'); else r.classList.remove('hover'); }); }
        else { wrap.classList.remove('is-hovering'); $$('.post', wrap).forEach(r=>r.classList.remove('hover')); }
        chart.setHoverSeries(pid);
      });
      // wire visibility toggles
      $$('#posts .toggle').forEach(btn=>{
        btn.addEventListener('click', ()=>{
          const pid = btn.dataset.pid; const row = btn.closest('.post');
          if (visibleSet.has(pid)) { visibleSet.delete(pid); row.classList.add('hidden'); btn.textContent='Show'; }
          else { visibleSet.add(pid); row.classList.remove('hidden'); btn.textContent='Hide'; }
          // Fit to visible
          chart.resetZoom();
          chart.setData(computeSeriesForUser(user, [], colorFor).filter(s=>visibleSet.has(s.id)).map(s=>({ ...s, url: absUrl(user.posts?.[s.id]?.url, s.id) })));
          // Refresh the cumulative views time series to reflect current visibility
          const vSeries = (function(){
            const out=[]; for (const [vpid,p] of Object.entries(user.posts||{})){
              if (!visibleSet.has(vpid)) continue; const pts=[];
              for (const s of (p.snapshots||[])){
                const t=s.t; const v=s.views; if (t!=null && v!=null) pts.push({ x:Number(t), y:Number(v), t:Number(t) });
              }
              const color=colorFor(vpid); const label=(typeof p?.caption==='string'&&p.caption)?p.caption.trim():vpid; if (pts.length) out.push({ id: vpid, label, color, points: pts, url: absUrl(p.url, vpid) });
            }
            return out; })();
          viewsChart.setData(vSeries);
          // Update metric cards to reflect current visibility
          try{
            const viewsEl = $('#viewsTotal');
            const likesEl = $('#likesTotal');
            const repliesEl = $('#repliesTotal');
            const remixesEl = $('#remixesTotal');
            const interEl = $('#interactionsTotal');
            let totalViews = 0, totalLikes = 0, totalReplies = 0, totalRemixes = 0, totalInteractions = 0;
            for (const vpid of Array.from(visibleSet)){
              const post = user.posts?.[vpid];
              const last = latestSnapshot(post?.snapshots);
              totalViews += num(last?.views);
              totalLikes += num(last?.likes);
              totalReplies += num(last?.comments);
              totalRemixes += num(latestRemixCountForPost(post));
              totalInteractions += interactionsOfSnap(last);
            }
            if (viewsEl) viewsEl.textContent = fmt2(totalViews);
            if (likesEl) likesEl.textContent = fmt2(totalLikes);
            if (repliesEl) repliesEl.textContent = fmtK2OrInt(totalReplies);
            if (remixesEl) remixesEl.textContent = fmt2(totalRemixes);
            if (interEl) interEl.textContent = fmt2(totalInteractions);
          } catch {}
          persistVisibility();
        });
      });
    }

    $('#userSelect').addEventListener('change', async (e)=>{
      currentUserKey = e.target.value; visibleSet.clear();
      try { await chrome.storage.local.set({ lastUserKey: currentUserKey }); } catch {}
      refreshUserUI({ preserveEmpty: true });
      persistVisibility();
    });

    // Typeahead suggestions
    $('#search').addEventListener('input', (e)=>{
      const suggestions = $('#suggestions');
      const list = filterUsersByQuery(metrics, e.target.value).slice(0, 20);
      suggestions.innerHTML = list.map(([key,u])=>{
        const count = Object.keys(u.posts||{}).length;
        return `<div class="item" data-key="${key}"><span>${u.handle||key}</span><span style="color:#7d8a96">${count} posts</span></div>`;
      }).join('');
      suggestions.style.display = list.length ? 'block' : 'none';
      $$('#suggestions .item').forEach(it=>{
        it.addEventListener('click', async ()=>{
          currentUserKey = it.dataset.key; visibleSet.clear(); $('#search').value = ''; suggestions.style.display='none';
          const sel = $('#userSelect'); sel.value = currentUserKey; refreshUserUI();
          try { await chrome.storage.local.set({ lastUserKey: currentUserKey }); } catch {}
        });
      });
    });
    document.addEventListener('click', (e)=>{ if (!e.target.closest('.user-picker')) $('#suggestions').style.display='none'; });

    $('#refresh').addEventListener('click', async ()=>{
      // capture zoom states
      const zScatter = chart.getZoom();
      const zViews = viewsChart.getZoom();
      const zFollowers = followersChart.getZoom();
      const zViewsAll = allViewsChart.getZoom();
      metrics = await loadMetrics();
      const prev = currentUserKey; const def = buildUserOptions(metrics);
      if (!metrics.users[prev]) currentUserKey = def;
      $('#userSelect').value = currentUserKey || '';
      try { await chrome.storage.local.set({ lastUserKey: currentUserKey }); } catch {}
      refreshUserUI();
      // restore zoom states
      try { if (zScatter) chart.setZoom(zScatter); } catch {}
      try { if (zViews) viewsChart.setZoom(zViews); } catch {}
      try { if (zFollowers) followersChart.setZoom(zFollowers); } catch {}
      try { if (zViewsAll) allViewsChart.setZoom(zViewsAll); } catch {}
    });
    $('#export').addEventListener('click', ()=>{ const u=metrics.users[currentUserKey]; if (u) exportCSV(u); });
    // Persist zoom on full page reload/navigation
    function persistZoom(){
      const z = zoomStates[currentUserKey] || (zoomStates[currentUserKey] = {});
      z.scatter = chart.getZoom();
      z.views = viewsChart.getZoom();
      z.followers = followersChart.getZoom();
      z.viewsAll = allViewsChart.getZoom();
      try { chrome.storage.local.set({ zoomStates }); } catch {}
    }
    window.addEventListener('beforeunload', persistZoom);
      $('#resetZoom').addEventListener('click', ()=>{ chart.resetZoom(); viewsChart.resetZoom(); followersChart.resetZoom(); allViewsChart.resetZoom(); refreshUserUI(); });
      $('#showAll').addEventListener('click', ()=>{ const u = metrics.users[currentUserKey]; if (!u) return; visibleSet.clear(); Object.keys(u.posts||{}).forEach(pid=>visibleSet.add(pid)); chart.resetZoom(); viewsChart.resetZoom(); followersChart.resetZoom(); refreshUserUI(); persistVisibility(); });
      $('#hideAll').addEventListener('click', ()=>{ visibleSet.clear(); chart.resetZoom(); viewsChart.resetZoom(); followersChart.resetZoom(); refreshUserUI({ preserveEmpty: true }); persistVisibility(); });

    refreshUserUI();
  }

  document.addEventListener('DOMContentLoaded', main, { once:true });
})();
