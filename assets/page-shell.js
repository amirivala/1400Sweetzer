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
  const navItems = [
    { href: '/home.html',      label: 'Home' },
    { href: '/news.html',      label: 'News' },
    { href: '/bulletin.html',  label: 'Bulletin' },
    { href: '/calendar.html',  label: 'Calendar' },
    { href: '/directory.html', label: 'Directory' },
    { href: '/providers.html', label: 'Providers' },
    { href: '/account.html',   label: 'Account' },
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

  const accountBtn = e('button',
    { class: 'nav-cta', id: 'navAccount', type: 'button', 'aria-label': 'Sign out' },
    e('span', { id: 'navName', text: 'Sign out' }),
    arrowIcon(),
  );

  const topBar = e('header', { class: 'top-bar' },
    e('a',
      { class: 'top-bar__brand', href: '/home.html', 'aria-label': 'Sunset Penthouse home' },
      e('span', { class: 'mark liquid-glass-strong' },
        e('span', { 'aria-hidden': 'true', text: 'SP' }),
      ),
      e('span', { class: 'top-bar__brand-name', text: 'Sunset Penthouse' }),
    ),
    e('nav', { 'aria-label': 'Primary' },
      e('div', { class: 'nav-pill liquid-glass' }, ...navLinks, accountBtn),
    ),
  );

  document.body.prepend(topBar);

  // Personalize the account button label, hook up sign-out.
  const { data: { session } } = await window.sb.auth.getSession();
  if (!session) return; // auth-guard already handled redirect

  const email = session.user.email || '';
  let firstName = email.split('@')[0];
  try {
    const { data: profile } = await window.sb
      .from('profiles').select('full_name').eq('id', session.user.id).single();
    if (profile?.full_name) firstName = profile.full_name.split(' ')[0];
  } catch { /* ignore — fall back to the email handle */ }

  document.getElementById('navName').textContent = firstName;
  accountBtn.addEventListener('click', async (ev) => {
    ev.preventDefault();
    if (confirm('Sign out of ' + email + '?')) {
      await window.sb.auth.signOut();
      location.href = '/';
    }
  });
})();
