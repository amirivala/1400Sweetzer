// Shared shell for inner pages — injects the sticky top bar at the
// top of <body> with the active nav link highlighted, then wires up
// the account / sign-out button.
//
// Built entirely with createElement / textContent — never interpolates
// user-controlled data into HTML strings.
//
// Load order on inner pages: supabase-js, env.js, supabase-client.js,
// auth-guard.js, page-shell.js, dom.js, then page-specific script.

(async () => {
  // Account is intentionally absent — the user-name button on the right
  // of the pill links to /account.html, and the account page hosts sign-out.
  const navItems = [
    { href: '/home.html',      label: 'Home' },
    { href: '/news.html',      label: 'News' },
    { href: '/bulletin.html',  label: 'Bulletin' },
    { href: '/calendar.html',  label: 'Calendar' },
    { href: '/directory.html', label: 'Directory' },
    { href: '/providers.html', label: 'Providers' },
  ];

  const path = location.pathname.replace(/\/$/, '') || '/index.html';

  // Helpers (local — page-shell runs before dom.js loads).
  const e = (tag, props = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = String(v);
      else if (k === 'text') n.textContent = String(v);
      else if (k.startsWith('on') && typeof v === 'function') {
        n.addEventListener(k.slice(2).toLowerCase(), v);
      } else n.setAttribute(k, String(v));
    }
    for (const k of kids.flat()) {
      if (k == null) continue;
      n.appendChild(typeof k === 'string' ? document.createTextNode(k) : k);
    }
    return n;
  };

  // Wires up the sliding pill indicator on a .nav-pill. Uses event
  // delegation so nav-links added later (e.g. the Admin link) still
  // work without re-binding. A MutationObserver keeps the resting
  // position in sync with the live DOM.
  const initNavIndicator = (pill) => {
    if (!pill) return;
    const ind = pill.querySelector('.nav-pill__indicator');
    if (!ind) return;

    const getResting = () => pill.querySelector('.nav-link[aria-current="page"]');
    const slide = (link) => {
      if (!link) { ind.classList.remove('is-visible'); return; }
      const pRect = pill.getBoundingClientRect();
      const lRect = link.getBoundingClientRect();
      ind.style.width = lRect.width + 'px';
      ind.style.height = lRect.height + 'px';
      ind.style.transform = `translate(${lRect.left - pRect.left}px, -50%)`;
      ind.classList.add('is-visible');
    };

    // Let layout settle before the first measurement (fonts, flex spacing).
    requestAnimationFrame(() => slide(getResting()));

    pill.addEventListener('pointerover', (ev) => {
      const link = ev.target.closest('.nav-link');
      if (link && pill.contains(link)) slide(link);
    });
    pill.addEventListener('focusin', (ev) => {
      if (ev.target.matches?.('.nav-link')) slide(ev.target);
    });
    pill.addEventListener('pointerleave', () => slide(getResting()));
    pill.addEventListener('focusout', (ev) => {
      if (!pill.contains(ev.relatedTarget)) slide(getResting());
    });
    window.addEventListener('resize', () => slide(getResting()), { passive: true });

    // Admin link gets inserted asynchronously after sign-in resolves.
    new MutationObserver(() => slide(getResting())).observe(pill, { childList: true });
  };

  // Hamburger → full-screen drawer. Locks body scroll while open,
  // closes on link click, backdrop tap, or Escape.
  const initNavDrawer = (burger, drawer) => {
    if (!burger || !drawer) return;
    const inner = drawer.querySelector('.nav-drawer__inner');
    const open = () => {
      drawer.classList.add('is-open');
      drawer.setAttribute('aria-hidden', 'false');
      burger.setAttribute('aria-expanded', 'true');
      burger.setAttribute('aria-label', 'Close menu');
      document.body.style.overflow = 'hidden';
    };
    const close = () => {
      drawer.classList.remove('is-open');
      drawer.setAttribute('aria-hidden', 'true');
      burger.setAttribute('aria-expanded', 'false');
      burger.setAttribute('aria-label', 'Open menu');
      document.body.style.overflow = '';
    };
    burger.addEventListener('click', () =>
      drawer.classList.contains('is-open') ? close() : open());
    drawer.addEventListener('click', (ev) => {
      if (ev.target === drawer) close();
      else if (ev.target.closest('.nav-drawer__link')) close();
    });
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && drawer.classList.contains('is-open')) close();
    });
    // If we resize above the mobile breakpoint while the drawer is
    // open, close it so the desktop pill returns cleanly.
    window.addEventListener('resize', () => {
      if (window.innerWidth > 640 && drawer.classList.contains('is-open')) close();
    }, { passive: true });
  };

  // SVG arrow icon used inside the account button.
  const arrowIcon = () => {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2.2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    const p1 = document.createElementNS(NS, 'path'); p1.setAttribute('d', 'M7 17L17 7'); svg.appendChild(p1);
    const p2 = document.createElementNS(NS, 'path'); p2.setAttribute('d', 'M7 7h10v10');  svg.appendChild(p2);
    return svg;
  };

  const navLinks = navItems.map((item) => {
    const props = { class: 'nav-link', href: item.href, text: item.label };
    if (path === item.href) props['aria-current'] = 'page';
    return e('a', props);
  });

  // --- Synchronous nav cache --------------------------------------
  // After the first profile resolution we stash {firstName, isAdmin}
  // in localStorage so subsequent page loads can render the pill in
  // its final shape without waiting on the network. This eliminates
  // the "Account → Amir" flash and the Admin-link layout jolt.
  // Cache is wiped on sign-out by supabase-client.js.
  const NAV_CACHE_KEY = 'sp_nav_cache_v1';
  const readNavCache = () => {
    try { return JSON.parse(localStorage.getItem(NAV_CACHE_KEY) || 'null'); }
    catch { return null; }
  };
  const writeNavCache = (data) => {
    try { localStorage.setItem(NAV_CACHE_KEY, JSON.stringify(data)); } catch {}
  };
  const navCache = readNavCache() || {};
  const haveNavCache = !!navCache.firstName;
  const cachedFirstName = navCache.firstName || 'Account';
  const cachedIsAdmin = navCache.isAdmin === true;

  const accountBtn = e('button',
    { class: 'nav-cta', id: 'navAccount', type: 'button', 'aria-label': 'Your account' },
    e('span', { id: 'navName', text: cachedFirstName }),
    arrowIcon(),
  );

  const indicator = e('span', { class: 'nav-pill__indicator', 'aria-hidden': 'true' });

  // Div-based hamburger — three bars that CSS animates into an X on
  // aria-expanded. Div bars beat SVG lines because transform-origin
  // on a zero-height <line> is unreliable across engines.
  const burgerBtn = e('button', {
    class: 'nav-burger',
    id: 'navBurger',
    type: 'button',
    'aria-label': 'Open menu',
    'aria-expanded': 'false',
    'aria-controls': 'navDrawer',
  },
    e('span', { class: 'nav-burger__bar' }),
    e('span', { class: 'nav-burger__bar' }),
    e('span', { class: 'nav-burger__bar' }),
  );

  const topBar = e('header', { class: 'top-bar' },
    e('a',
      { class: 'top-bar__brand', href: '/home.html', 'aria-label': 'Sunset Penthouse home' },
      e('span', { class: 'top-bar__brand-name' }, 'Sunset', e('br'), 'Penthouse'),
    ),
    e('nav', { 'aria-label': 'Primary' },
      e('div', { class: 'nav-pill liquid-glass' }, indicator, ...navLinks, accountBtn, burgerBtn),
    ),
  );

  // Mobile drawer — a separate aside that mirrors the nav-pill's items.
  const drawerLinks = navItems.map((item) => e('a', {
    class: 'nav-drawer__link',
    href: item.href,
    ...(path === item.href ? { 'aria-current': 'page' } : {}),
  }, item.label, e('span', { class: 'chev', 'aria-hidden': 'true', text: '\u2192' })));
  const drawer = e('aside', {
    id: 'navDrawer',
    class: 'nav-drawer',
    'aria-hidden': 'true',
    'aria-label': 'Primary navigation',
  }, e('div', { class: 'nav-drawer__inner' }, ...drawerLinks,
      e('div', { class: 'nav-drawer__foot', text: '1400 N Sweetzer Ave · West Hollywood' }),
    ));

  // Helpers to add/remove the Admin link in both pill and drawer.
  // `animate` adds .nav-link--enter so post-load insertions fade in
  // instead of popping into place.
  const adminPath = path.startsWith('/admin/');
  const insertAdminLink = (animate) => {
    const adminLink = e('a', {
      class: 'nav-link' + (animate ? ' nav-link--enter' : ''),
      href: '/admin/index.html',
      text: 'Admin',
      ...(adminPath ? { 'aria-current': 'page' } : {}),
    });
    accountBtn.parentNode.insertBefore(adminLink, accountBtn);

    const drawerInner = drawer.querySelector('.nav-drawer__inner');
    const drawerFoot = drawerInner?.querySelector('.nav-drawer__foot');
    const drawerAdmin = e('a', {
      class: 'nav-drawer__link',
      href: '/admin/index.html',
      ...(adminPath ? { 'aria-current': 'page' } : {}),
    }, 'Admin', e('span', { class: 'chev', 'aria-hidden': 'true', text: '→' }));
    if (drawerFoot) drawerInner.insertBefore(drawerAdmin, drawerFoot);

    return adminLink;
  };
  const removeAdminLink = () => {
    topBar.querySelector('.nav-pill a[href="/admin/index.html"]')?.remove();
    drawer.querySelector('a[href="/admin/index.html"]')?.remove();
  };

  // Apply cached admin state synchronously, before mount, so the pill
  // is rendered in its final shape on the very first paint.
  if (cachedIsAdmin) insertAdminLink(false);

  document.body.prepend(topBar);
  document.body.appendChild(drawer);
  const pillEl = topBar.querySelector('.nav-pill');
  initNavIndicator(pillEl);
  initNavDrawer(burgerBtn, drawer);

  // Wire the click handler immediately — it doesn't depend on session.
  accountBtn.addEventListener('click', () => {
    location.href = '/account.html';
  });

  // Reveal the pill on the next paint when we have cache (the pill
  // is already in its final shape). On first visits, defer the
  // reveal until the live profile resolves so we don't fade in a
  // placeholder ("Account") and then swap the text mid-transition.
  const revealPill = () =>
    requestAnimationFrame(() => pillEl.classList.add('is-ready'));
  if (haveNavCache) revealPill();

  // --- Reconcile against the live profile ---------------------------
  const { data: { session } } = await window.sb.auth.getSession();
  if (!session) return; // auth-guard handles the redirect

  const email = session.user.email || '';
  let liveFirstName = email.split('@')[0];
  let liveIsAdmin = false;
  try {
    const { data: profile } = await window.sb
      .from('profiles')
      .select('full_name, role')
      .eq('id', session.user.id)
      .single();
    if (profile?.full_name) liveFirstName = profile.full_name.split(' ')[0];
    liveIsAdmin = profile?.role === 'admin';
  } catch { /* fall back to email handle, non-admin */ }

  if (liveFirstName !== cachedFirstName) {
    document.getElementById('navName').textContent = liveFirstName;
  }

  if (liveIsAdmin !== cachedIsAdmin) {
    if (liveIsAdmin) {
      const link = insertAdminLink(true);
      // Two rAFs so the opacity:0 frame paints before .is-ready flips
      // it to 1 \u2014 otherwise the transition can be skipped.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => link.classList.add('is-ready')));
    } else {
      removeAdminLink();
    }
  }

  writeNavCache({ firstName: liveFirstName, isAdmin: liveIsAdmin });

  // First visit: reveal now, with the live values stamped in.
  if (!haveNavCache) revealPill();
})();
