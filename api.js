/*
 * Copyright (c) 2025 Will (fancyson-ai), Topher (cameoed), Skye (thecosmicskye)
 * Licensed under the MIT License. See the LICENSE file for details.
 */

(function () {
  'use strict';

  // Idempotency guard (SPA + extension reload safety)
  if (window.__sct_api__?.installed) return;
  window.__sct_api__ = window.__sct_api__ || {};
  window.__sct_api__.installed = true;

  const DEBUG = false;
  const dlog = (...args) => {
    try {
      if (DEBUG) console.log('[SCT][api]', ...args);
    } catch {}
  };

  const NF_CREATE_RE = /\/backend\/nf\/create/i;
  const DURATION_OVERRIDE_KEY = 'SCT_DURATION_OVERRIDE_V1'; // stored in sora.chatgpt.com localStorage

  const isStoryboardRoute = () => {
    try {
      return /(^|\/)storyboard(\/|$)/i.test(String(location?.pathname || ''));
    } catch {
      return false;
    }
  };

  let __sct_videoGensRaf = 0;
  let __sct_keepSettingsOpenToken = 0;

  const unhideEl = (el) => {
    if (!el) return;
    try {
      el.hidden = false;
      el.removeAttribute('aria-hidden');
      if (el.style && el.style.display === 'none') el.style.display = '';
      if (el.style && el.style.visibility === 'hidden') el.style.visibility = '';
    } catch {}
  };

  const findSettingsTriggerButton = () => {
    try {
      return document.querySelector('button[aria-label="Settings"][aria-haspopup="menu"]');
    } catch {
      return null;
    }
  };

  const getSettingsRootMenuFromMenuEl = (menuEl) => {
    try {
      if (!menuEl) return null;
      if (menuEl.querySelector && menuEl.querySelector('[data-sct-duration-menuitem="1"]')) return menuEl;
      const labelledBy = menuEl.getAttribute && menuEl.getAttribute('aria-labelledby');
      if (!labelledBy) return null;
      const labelEl = document.getElementById(labelledBy);
      const parentMenu = labelEl && labelEl.closest && labelEl.closest('[data-radix-menu-content][role="menu"]');
      if (!parentMenu) return null;
      return getSettingsRootMenuFromMenuEl(parentMenu);
    } catch {
      return null;
    }
  };

  const keepSettingsMenuOpenSoon = () => {
    const trigger = findSettingsTriggerButton();
    if (!trigger) return;

    const token = Date.now();
    __sct_keepSettingsOpenToken = token;

    const ensure = () => {
      try {
        if (__sct_keepSettingsOpenToken !== token) return;
        if (trigger.getAttribute('aria-expanded') !== 'true') {
          trigger.click();
        } else {
          // Occasionally Radix leaves the menu mounted but hidden.
          const rootMenu = document.querySelector('[data-radix-menu-content][role="menu"][data-state="open"]');
          if (rootMenu) unhideEl(rootMenu);
        }
      } catch {}
    };

    // Run after Radix selection handling.
    setTimeout(ensure, 0);
    requestAnimationFrame(ensure);
  };

  function ensureVideoGensWarning(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return false;
    const desiredCount = seconds === 25 ? 3 : seconds === 15 ? 2 : 1;
    const forceShow = seconds === 5 || seconds === 10 || seconds === 25;

    const findOpenSettingsMenuEl = () => {
      try {
        const openMenus = Array.from(document.querySelectorAll('[data-radix-menu-content][role="menu"][data-state="open"]'));
        // Prefer the top-level settings menu (contains the Duration menu item).
        const preferred = openMenus.find((m) => m.querySelector && m.querySelector('[data-sct-duration-menuitem="1"]'));
        if (preferred) return preferred;
        return openMenus.find((m) => (m.textContent || '').includes('Duration')) || null;
      } catch {
        return null;
      }
    };

    const removeInjectedHelperFromMenu = (menu) => {
      if (!menu) return;
      try {
        const injected = menu.querySelectorAll('[data-sct-video-gens="1"],[data-sct-video-gens-sep="1"]');
        injected.forEach((el) => el.remove());
      } catch {}
    };

    const findNativeHelperRowInMenu = (menu) => {
      if (!menu) return null;
      try {
        const anchors = Array.from(menu.querySelectorAll('a')).filter((a) => {
          const href = String(a.getAttribute && a.getAttribute('href') ? a.getAttribute('href') : '');
          return /help\.openai\.com\/en\/articles\/12642688/i.test(href);
        });

        for (const a of anchors) {
          let n = a;
          for (let i = 0; i < 12 && n; i++, n = n.parentElement) {
            const t = (n.textContent || '').trim();
            if (!t) continue;
            if (!/video\s+gens\s+you're\s+using/i.test(t)) continue;
            const countEl = n.querySelector && n.querySelector('.font-medium');
            if (countEl) return n;
          }
        }
      } catch {}
      return null;
    };

    const ensureHelperRowInMenu = () => {
      if (!forceShow) return null;
      const menu = findOpenSettingsMenuEl();
      if (!menu) return null;

      try {
        const existingInjected = menu.querySelector && menu.querySelector('[data-sct-video-gens="1"]');
        if (existingInjected) {
          unhideEl(existingInjected);
          return existingInjected;
        }
      } catch {}

      try {
        // If Sora already rendered the native helper row, don't inject another.
        const native = findNativeHelperRowInMenu(menu);
        if (native) return null;
      } catch {}

      try {
        const sep = document.createElement('div');
        sep.setAttribute('role', 'separator');
        sep.setAttribute('aria-orientation', 'horizontal');
        sep.className = 'my-1.5 h-px bg-token-bg-light mx-3';
        sep.dataset.sctVideoGensSep = '1';

        const row = document.createElement('div');
        row.className = 'flex max-w-[250px] items-center gap-3 px-3 pb-1.5 pt-2 text-token-text-tertiary';
        row.dataset.sctVideoGens = '1';
        row.innerHTML = `
          <div class="flex-1 text-xs leading-[18px]">
            Video gens you're using with current settings.
            <a href="https://help.openai.com/en/articles/12642688" target="_blank" rel="noreferrer noopener" class="font-semibold hover:underline">Learn more</a>
          </div>
          <div class="flex shrink-0 flex-col items-end">
            <div class="flex items-center gap-[3px]">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" viewBox="0 0 16 16" class="h-5 w-5">
                <path fill="currentColor" fill-rule="evenodd" d="M7.57 1.387c.9-.04 1.746.373 2.318 1.068 1.032-.36 2.204-.085 3.007.8.811.894 1.03 2.169.682 3.27.814.78 1.187 2.01.898 3.202-.288 1.181-1.165 2.057-2.235 2.303-.206 1.132-.976 2.129-2.112 2.465-.573.169-1.212.113-1.803.113a2.83 2.83 0 0 1-2.062-.902l-1.248-.025c-2.034 0-3.135-2.498-2.593-4.216-.813-.78-1.185-2.01-.896-3.2.288-1.184 1.169-2.063 2.242-2.307.714-2.307 1.943-2.522 3.801-2.575zM9.247 3.39c-.418-.704-1.162-1.055-1.89-.909l-.144.036c-.784.232-1.356 1.01-1.404 1.935a.53.53 0 0 1-.499.503c-.757.047-1.484.629-1.71 1.561-.229.938.139 1.876.802 2.354a.53.53 0 0 1 .173.653c-.374.816-.245 1.835.358 2.5.591.651 1.455.767 2.141.385l.097-.042a.53.53 0 0 1 .62.235c.446.75 1.263 1.1 2.034.873.784-.231 1.358-1.01 1.404-1.936a.533.533 0 0 1 .5-.504c.757-.046 1.484-.627 1.711-1.559.228-.938-.14-1.876-.805-2.355a.53.53 0 0 1-.172-.654c.374-.815.246-1.832-.357-2.496-.592-.652-1.457-.77-2.143-.387a.53.53 0 0 1-.716-.193" clip-rule="evenodd"></path>
              </svg>
              <div class="font-medium">${String(desiredCount)}</div>
            </div>
          </div>
        `;

        menu.appendChild(sep);
        menu.appendChild(row);
        return row;
      } catch {
        return null;
      }
    };

    const findWarningRoot = () => {
      try {
        const menu = findOpenSettingsMenuEl();
        if (menu) {
          // Prefer Sora's native helper row when available (prevents duplicates).
          const native = findNativeHelperRowInMenu(menu);
          if (native) return native;
          const injected = menu.querySelector && menu.querySelector('[data-sct-video-gens="1"]');
          if (injected) return injected;
        }

        const anchors = Array.from(document.querySelectorAll('a')).filter((a) => {
          const t = (a.textContent || '').trim();
          const href = String(a.getAttribute && a.getAttribute('href') ? a.getAttribute('href') : '');
          return /learn\s+more/i.test(t) || /help\.openai\.com\/en\/articles\/12642688/i.test(href);
        });

        for (const a of anchors) {
          let n = a;
          for (let i = 0; i < 14 && n; i++, n = n.parentElement) {
            const t = (n.textContent || '').trim();
            if (!t) continue;
            if (!/video\s+gens\s+you're\s+using/i.test(t)) continue;
            const countEl = n.querySelector && n.querySelector('.font-medium');
            if (countEl && /^\s*\d+\s*$/.test((countEl.textContent || '').trim())) return n;

            // If the immediate container is just the left text column, prefer a parent that also contains the count.
            const parent = n.parentElement;
            const parentCountEl = parent && parent.querySelector && parent.querySelector('.font-medium');
            if (parentCountEl && /^\s*\d+\s*$/.test((parentCountEl.textContent || '').trim())) return parent;
          }
        }

        // Fallback: find any node with the text and a count element.
        const candidates = Array.from(document.querySelectorAll('div')).filter((el) => {
          const t = (el.textContent || '').trim();
          if (!t) return false;
          if (!/video\s+gens\s+you're\s+using/i.test(t)) return false;
          const countEl = el.querySelector && el.querySelector('.font-medium');
          return !!(countEl && /^\s*\d+\s*$/.test((countEl.textContent || '').trim()));
        });
        return candidates[0] || null;
      } catch {
        return null;
      }
    };

    const applyToRoot = (root) => {
      if (!root) return false;
      try {
        // Ensure visible (20/25 should always show this helper row).
        if (forceShow) {
          let n = root;
          for (let i = 0; i < 10 && n; i++, n = n.parentElement) unhideEl(n);
        }

        const countEls = Array.from(root.querySelectorAll('.font-medium')).filter((el) =>
          /^\s*\d+\s*$/.test((el.textContent || '').trim())
        );
        const countEl = countEls[countEls.length - 1];
        if (!countEl) return false;
        countEl.textContent = String(desiredCount);
        return true;
      } catch {
        return false;
      }
    };

    const tryApply = () => applyToRoot(findWarningRoot());

    // If the native helper exists, ensure we don't have our injected one too.
    try {
      const menu = findOpenSettingsMenuEl();
      const native = menu && findNativeHelperRowInMenu(menu);
      if (native) removeInjectedHelperFromMenu(menu);
    } catch {}

    if (tryApply()) return true;

    // If switching from low durations to 25, Sora may not render the helper row; inject it.
    if (forceShow && (seconds === 5 || seconds === 10 || seconds === 25)) {
      try {
        ensureHelperRowInMenu();
      } catch {}
      return tryApply();
    }

    return false;
  }

  function scheduleVideoGensWarning(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    try {
      if (__sct_videoGensRaf) cancelAnimationFrame(__sct_videoGensRaf);
    } catch {}

    ensureVideoGensWarning(seconds);
    __sct_videoGensRaf = requestAnimationFrame(() => {
      try {
        ensureVideoGensWarning(seconds);
      } catch {}
    });
  }

  const EXTRA_DURATIONS = [
    { seconds: 5, frames: 150, label: '5 seconds', shortLabel: '5s' },
    { seconds: 25, frames: 750, label: '25 seconds', shortLabel: '25s' },
  ];

  function safeJsonParse(str) {
    try {
      return JSON.parse(str);
    } catch {
      return null;
    }
  }

  function loadDurationOverrideFromStorage() {
    try {
      const raw = localStorage.getItem(DURATION_OVERRIDE_KEY);
      if (!raw) return null;
      const v = safeJsonParse(raw);
      if (!v || typeof v !== 'object') return null;
      const seconds = Number(v.seconds);
      const frames = Number(v.frames);
      if (!Number.isFinite(seconds) || !Number.isFinite(frames)) return null;
      if (seconds <= 0 || frames <= 0) return null;
      return { seconds, frames };
    } catch {
      return null;
    }
  }

  let durationOverride = loadDurationOverrideFromStorage();
  function getDurationOverride() {
    return durationOverride;
  }

  function writeDurationOverride(next) {
    try {
      localStorage.setItem(
        DURATION_OVERRIDE_KEY,
        JSON.stringify({ seconds: next.seconds, frames: next.frames, setAt: Date.now() })
      );
    } catch {}
    durationOverride = { seconds: next.seconds, frames: next.frames };
  }

  function clearDurationOverride() {
    try {
      localStorage.removeItem(DURATION_OVERRIDE_KEY);
    } catch {}
    durationOverride = null;
  }

  function rewriteNFramesInBodyString(bodyString, frames) {
    if (typeof bodyString !== 'string') return bodyString;

    // Common case: JSON string body containing `n_frames`
    const parsed = safeJsonParse(bodyString);
    if (parsed && typeof parsed === 'object') {
      // Direct payload: { ..., n_frames: 300, ... }
      if (Object.prototype.hasOwnProperty.call(parsed, 'n_frames')) {
        parsed.n_frames = frames;
        return JSON.stringify(parsed);
      }

      // Wrapped payload: { body: "{\"n_frames\":300,...}", ... }
      if (typeof parsed.body === 'string') {
        const inner = safeJsonParse(parsed.body);
        if (inner && typeof inner === 'object' && Object.prototype.hasOwnProperty.call(inner, 'n_frames')) {
          inner.n_frames = frames;
          parsed.body = JSON.stringify(inner);
          return JSON.stringify(parsed);
        }
      }
    }

    // Fallback: best-effort replacement
    try {
      const replaced = bodyString.replace(/(\\?"n_frames\\?"\s*:\s*)\d+/i, `$1${frames}`);
      return replaced;
    } catch {
      return bodyString;
    }
  }

  function patchFetch() {
    if (typeof window.fetch !== 'function') return;
    if (window.fetch.__sct_patched) return;

    const origFetch = window.fetch;
    function patchedFetch(input, init) {
      if (!durationOverride) return origFetch.apply(this, arguments);
      try {
        const url = typeof input === 'string' ? input : input?.url || '';
        if (typeof url === 'string' && NF_CREATE_RE.test(url)) {
          const method = (init && init.method) || (typeof input === 'object' && input?.method) || 'GET';
          if (String(method).toUpperCase() === 'POST') {
            const override = getDurationOverride();
            if (override && Number.isFinite(override.frames) && init && typeof init === 'object') {
              const nextInit = { ...init };
              if (nextInit.body != null) {
                nextInit.body = rewriteNFramesInBodyString(nextInit.body, override.frames);
                dlog('fetch rewrite', { url, frames: override.frames });
                return origFetch.call(this, input, nextInit);
              }
            }
          }
        }
      } catch {}
      return origFetch.apply(this, arguments);
    }

    patchedFetch.__sct_patched = true;
    window.fetch = patchedFetch;
  }

  function patchXHR() {
    const proto = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
    if (!proto) return;
    if (proto.__sct_patched) return;
    proto.__sct_patched = true;

    const origOpen = proto.open;
    const origSend = proto.send;

    proto.open = function (method, url) {
      try {
        this.__sct_method = method;
        this.__sct_url = url;
      } catch {}
      return origOpen.apply(this, arguments);
    };

    proto.send = function (body) {
      if (!durationOverride) return origSend.call(this, body);
      try {
        const url = String(this.__sct_url || '');
        const method = String(this.__sct_method || 'GET').toUpperCase();
        if (method === 'POST' && NF_CREATE_RE.test(url)) {
          const override = getDurationOverride();
          if (override && Number.isFinite(override.frames) && typeof body === 'string') {
            body = rewriteNFramesInBodyString(body, override.frames);
            dlog('xhr rewrite', { url, frames: override.frames });
          }
        }
      } catch {}
      return origSend.call(this, body);
    };
  }

  function findDurationMenuValueEl(durationMenuItemEl) {
    if (!durationMenuItemEl) return null;
    const preferred = durationMenuItemEl.querySelector('.text-token-text-tertiary');
    if (preferred) return preferred;

    try {
      const divs = Array.from(durationMenuItemEl.querySelectorAll('div'));
      for (let i = divs.length - 1; i >= 0; i--) {
        const t = (divs[i].textContent || '').trim();
        if (/^\d+\s*s$/.test(t) || /^\d+s$/.test(t)) return divs[i];
      }
    } catch {}
    return null;
  }

  function ensureExtraDurationItems(durationSubmenuEl) {
    if (!durationSubmenuEl) return;

    const group = durationSubmenuEl.querySelector('[role="group"]');
    if (!group) return;

    // Don't show injected time options on the storyboard route.
    if (isStoryboardRoute()) {
      try {
        const injected = group.querySelectorAll('[data-sct-duration-option]');
        injected.forEach((el) => el.remove());
      } catch {}
      return;
    }

    const template = group.querySelector('[role="menuitemradio"]');
    if (!template) return;

    durationSubmenuEl.dataset.sctDurationMenu = '1';

    const override = getDurationOverride();
    const isChecked = (d) => override && override.seconds === d.seconds && override.frames === d.frames;

    const getMenuItemSeconds = (el) => {
      const label = (el?.querySelector?.('span.truncate')?.textContent || el?.textContent || '').trim();
      const m = label.match(/(\d+)\s*seconds?/i) || label.match(/(\d+)\s*s\b/i);
      if (!m) return null;
      const n = Number(m[1]);
      return Number.isFinite(n) ? n : null;
    };

    const hasExistingSecondsOption = (seconds) => {
      try {
        const radios = Array.from(group.querySelectorAll('[role="menuitemradio"]'));
        return radios.some((el) => getMenuItemSeconds(el) === seconds);
      } catch {
        return false;
      }
    };

    const getClockSvg = (menuItemEl) => {
      if (!menuItemEl) return null;
      try {
        const svgs = Array.from(menuItemEl.querySelectorAll('svg'));
        // The clock icon contains a <circle> (the checkmark/chevrons typically do not).
        return svgs.find((s) => s && s.querySelector && s.querySelector('circle')) || null;
      } catch {
        return null;
      }
    };

    const normalizeDurationIcons = () => {
      try {
        const radios = Array.from(group.querySelectorAll('[role="menuitemradio"]'));
        if (!radios.length) return;

        // Pick a base clock icon from the first item that has one.
        let baseClock = null;
        for (const r of radios) {
          const svg = getClockSvg(r);
          if (svg) {
            baseClock = svg.cloneNode(true);
            break;
          }
        }
        if (!baseClock) return;

        // Replace every duration item's clock icon with the same base icon.
        for (const r of radios) {
          const existing = getClockSvg(r);
          if (!existing) continue;
          try {
            const clone = baseClock.cloneNode(true);
            // Clear any transforms from the original icon; we'll reapply consistently.
            if (clone.style) {
              clone.style.transform = '';
              clone.style.transformOrigin = '';
            }
            existing.replaceWith(clone);
          } catch {}
        }
      } catch {}
    };

    const applyClockRotationForSeconds = (menuItemEl, seconds) => {
      if (!menuItemEl) return;
      if (!Number.isFinite(seconds) || seconds <= 0) return;
      try {
        const svg = getClockSvg(menuItemEl);
        if (!svg) return;

        // Rotation spec:
        // - Take the current 5s rotation and rotate it 8.3% (of a full circle) to the right as the new 5s baseline.
        // - Then rotate proportionally by duration, adding another 8.3% per +5 seconds.
        const allowed = new Set([5, 10, 15, 25]);
        if (!allowed.has(seconds)) return;

        const stepDegPer5s = 360 * 0.083; // 8.3%
        const stepDegPerSecond = stepDegPer5s / 5;

        // Our previous 5s "vertical" was effectively -90deg; shift baseline +8.3% clockwise.
        const baseline5sDeg = -90 + stepDegPer5s;
        const angle = baseline5sDeg + (seconds - 5) * stepDegPerSecond;

        svg.style.transformOrigin = '50% 50%';
        svg.style.transform = `rotate(${angle}deg)`;
      } catch {}
    };

    function setRadioState(el, checked) {
      try {
        el.setAttribute('aria-checked', checked ? 'true' : 'false');
        el.setAttribute('data-state', checked ? 'checked' : 'unchecked');
      } catch {}
    }

    function selectDuration(d, el) {
      writeDurationOverride({ seconds: d.seconds, frames: d.frames });

      try {
        const radios = group.querySelectorAll('[role="menuitemradio"]');
        radios.forEach((r) => setRadioState(r, r === el));
      } catch {}

      // Update the "Duration" value label in the parent menu, if present.
      try {
        const durationMenuItems = Array.from(document.querySelectorAll('[role="menuitem"][aria-haspopup="menu"]')).filter((mi) =>
          (mi.textContent || '').includes('Duration')
        );
        for (const mi of durationMenuItems) {
          const valueEl = findDurationMenuValueEl(mi);
          if (valueEl) valueEl.textContent = d.shortLabel;
        }
      } catch {}

      scheduleVideoGensWarning(d.seconds);
    }

    function makeItem(d) {
      const el = template.cloneNode(true);
      el.dataset.sctDurationOption = String(d.seconds);
      el.dataset.sctFrames = String(d.frames);

      // Update label text
      const labelSpan = el.querySelector('span.truncate');
      if (labelSpan) labelSpan.textContent = d.label;

      setRadioState(el, isChecked(d));

      // Apply override without letting Radix close the parent Settings menu.
      const activate = (ev) => {
        try {
          ev.preventDefault();
          ev.stopPropagation();
          ev.stopImmediatePropagation();
        } catch {}
        selectDuration(d, el);
        keepSettingsMenuOpenSoon();
      };
      el.addEventListener('click', activate, true);
      el.addEventListener(
        'keydown',
        (ev) => {
          const k = ev && (ev.key || ev.code);
          if (k === 'Enter' || k === ' ' || k === 'Spacebar' || k === 'Space') activate(ev);
        },
        true
      );

      return el;
    }

    for (const d of EXTRA_DURATIONS) {
      if (group.querySelector(`[data-sct-duration-option="${d.seconds}"]`)) {
        // Keep state in sync when the submenu is re-opened/re-rendered.
        const existing = group.querySelector(`[data-sct-duration-option="${d.seconds}"]`);
        setRadioState(existing, isChecked(d));
        continue;
      }

      // Don't inject duplicates if the menu already has a built-in option for this duration.
      if (hasExistingSecondsOption(d.seconds)) continue;

      const el = makeItem(d);
      group.appendChild(el);
    }

    // If an override is active for one of our injected options, ensure only that option looks selected.
    try {
      const matched = EXTRA_DURATIONS.find((d) => isChecked(d));
      if (matched) {
        const selectedEl = group.querySelector(`[data-sct-duration-option="${matched.seconds}"]`);
        if (selectedEl) {
          const radios = group.querySelectorAll('[role="menuitemradio"]');
          radios.forEach((r) => setRadioState(r, r === selectedEl));
        }
      }
    } catch {}

    // Re-order to: 5, 7, 10, 15, 20, 25 (others after).
    try {
      const desired = [5, 10, 15, 25];
      const radios = Array.from(group.querySelectorAll('[role="menuitemradio"]'));
      const withMeta = radios.map((el, idx) => {
        const sec = getMenuItemSeconds(el);
        const pos = sec != null ? desired.indexOf(sec) : -1;
        return { el, idx, rank: pos === -1 ? 1000 + idx : pos };
      });
      withMeta.sort((a, b) => a.rank - b.rank);
      for (const it of withMeta) group.appendChild(it.el);
    } catch {}

    // Ensure the clock icon has a consistent aesthetic progression for our duration list.
    try {
      // Ensure all menu options use the same base clock icon (Sora uses multiple variants).
      normalizeDurationIcons();

      const radios = Array.from(group.querySelectorAll('[role="menuitemradio"]'));
      for (const el of radios) {
        const sec = getMenuItemSeconds(el);
        if (sec != null) applyClockRotationForSeconds(el, sec);
      }
    } catch {}
  }

  function installDurationDropdownEnhancer() {
    let processScheduled = false;
    const scheduleProcess = () => {
      if (processScheduled) return;
      processScheduled = true;
      requestAnimationFrame(() => {
        processScheduled = false;
        process();
      });
    };

    const process = () => {
      try {
        const durationMenuItems = Array.from(document.querySelectorAll('[role="menuitem"][aria-haspopup="menu"]')).filter((el) =>
          (el.textContent || '').includes('Duration')
        );

        const override = getDurationOverride();
        if (override) {
          scheduleVideoGensWarning(override.seconds);
        } else {
          // Ensure the credit usage helper stays correct even when using built-in durations.
          try {
            for (const mi of durationMenuItems) {
              const valueEl = findDurationMenuValueEl(mi);
              const t = (valueEl?.textContent || '').trim();
              const m = t.match(/(\d+)\s*s\b/i) || t.match(/(\d+)\s*seconds?\b/i);
              if (m) {
                const sec = Number(m[1]);
                if (Number.isFinite(sec)) {
                  scheduleVideoGensWarning(sec);
                  break;
                }
              }
            }
          } catch {}
        }
        for (const mi of durationMenuItems) {
          mi.dataset.sctDurationMenuitem = '1';

          if (override) {
            const valueEl = findDurationMenuValueEl(mi);
            if (valueEl) valueEl.textContent = `${override.seconds}s`;
          }

          const submenuId = mi.getAttribute('aria-controls');
          if (!submenuId) continue;
          const submenu = document.getElementById(submenuId);
          if (submenu) ensureExtraDurationItems(submenu);
        }
      } catch {}
    };

    // Clear override when selecting any built-in duration option
    document.addEventListener(
      'click',
      (ev) => {
        try {
          const radio = ev.target && ev.target.closest && ev.target.closest('[role="menuitemradio"]');
          if (!radio) return;
          const menu = radio.closest && radio.closest('[data-sct-duration-menu="1"]');
          if (!menu) return;
          if (radio.dataset && radio.dataset.sctDurationOption) return; // our injected items
          clearDurationOverride();

          // Ensure injected items no longer look selected.
          try {
            const group = radio.closest('[role="group"]');
            if (group) {
              const injected = group.querySelectorAll('[data-sct-duration-option]');
              injected.forEach((el) => {
                try {
                  el.setAttribute('aria-checked', 'false');
                  el.setAttribute('data-state', 'unchecked');
                } catch {}
              });
            }
          } catch {}

          // Update the Duration label to the selected built-in option immediately.
          try {
            const labelText = (radio.querySelector('span.truncate')?.textContent || radio.textContent || '').trim();
            const m = labelText.match(/(\d+)\s*seconds?/i) || labelText.match(/(\d+)\s*s\b/i);
            if (m) {
              const sec = Number(m[1]);
              if (Number.isFinite(sec)) {
                scheduleVideoGensWarning(sec);
                const durationMenuItems = Array.from(document.querySelectorAll('[role="menuitem"][aria-haspopup="menu"]')).filter((mi) =>
                  (mi.textContent || '').includes('Duration')
                );
                for (const mi of durationMenuItems) {
                  const valueEl = findDurationMenuValueEl(mi);
                  if (valueEl) valueEl.textContent = `${sec}s`;
                }
              }
            }
          } catch {}

          scheduleProcess();
        } catch {}
      },
      true
    );

    // Keep the settings modal open when selecting items inside it (Radix sometimes closes it).
    document.addEventListener(
      'click',
      (ev) => {
        try {
          const item = ev.target && ev.target.closest && ev.target.closest('[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"]');
          if (!item) return;
          const menuEl = item.closest && item.closest('[data-radix-menu-content][role="menu"]');
          const rootMenu = getSettingsRootMenuFromMenuEl(menuEl);
          if (!rootMenu) return;
          keepSettingsMenuOpenSoon();
        } catch {}
      },
      true
    );

    // When the Duration menu item is opened, ensure we inject immediately (Radix can reuse portal roots).
    document.addEventListener(
      'pointerdown',
      (ev) => {
        try {
          const mi = ev.target && ev.target.closest && ev.target.closest('[role="menuitem"][aria-haspopup="menu"]');
          if (!mi) return;
          if (!(mi.textContent || '').includes('Duration')) return;
          scheduleProcess();
        } catch {}
      },
      true
    );

    // Only react to Radix portal mount/unmount (body direct children), not all subtree mutations.
    const startObserver = () => {
      try {
        if (!document.body) return;
        const RADIX_SEL = '[data-radix-popper-content-wrapper],[data-radix-menu-content]';
        const isRadixPortal = (n) => {
          try {
            return (
              n &&
              n.nodeType === 1 &&
              (n.matches?.(RADIX_SEL) || n.querySelector?.(RADIX_SEL))
            );
          } catch {
            return false;
          }
        };
        const obs = new MutationObserver((records) => {
          for (const r of records) {
            const added = r.addedNodes || [];
            for (const n of added) {
              if (isRadixPortal(n)) {
                scheduleProcess();
                return;
              }
            }
            const removed = r.removedNodes || [];
            for (const n of removed) {
              if (isRadixPortal(n)) {
                scheduleProcess();
                return;
              }
            }
          }
        });
        // Observe subtree, but only schedule work when nodes matching Radix portal/menu appear/disappear.
        obs.observe(document.body, { childList: true, subtree: true });
        scheduleProcess();
      } catch {}
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', startObserver, { once: true });
    } else {
      startObserver();
    }
  }

  // Install
  patchFetch();
  patchXHR();
  installDurationDropdownEnhancer();
})();
