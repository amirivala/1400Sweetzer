// Tiny DOM builder that avoids ever interpolating user data into HTML
// strings. All text goes through textContent (auto-escaped by the
// browser); attributes go through setAttribute. No XSS surface.
//
// Usage:
//   el('a', { class: 'btn', href: '/x', text: profile.full_name })
//   el('div', { class: 'card' }, el('h2', { text: post.title }), childNode)

window.el = function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);

  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class')        node.className = String(v);
    else if (k === 'text')    node.textContent = String(v);
    else if (k === 'style')   Object.assign(node.style, v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else {
      node.setAttribute(k, String(v));
    }
  }

  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.appendChild(typeof child === 'string' || typeof child === 'number'
      ? document.createTextNode(String(child))
      : child);
  }
  return node;
};

// Replace all children of a target with the given DOM node(s).
window.mount = function mount(target, ...nodes) {
  const t = typeof target === 'string' ? document.querySelector(target) : target;
  if (!t) return;
  while (t.firstChild) t.removeChild(t.firstChild);
  for (const n of nodes.flat()) {
    if (n == null) continue;
    t.appendChild(typeof n === 'string' ? document.createTextNode(n) : n);
  }
};

// Render rich-text HTML (from Quill in the admin editor) safely.
// Uses DOMPurify if loaded, otherwise falls back to a safe text-only
// rendering. Returns a DocumentFragment ready to append.
window.renderRichText = function renderRichText(html) {
  if (window.DOMPurify) {
    return window.DOMPurify.sanitize(String(html || ''), {
      RETURN_DOM_FRAGMENT: true,
      USE_PROFILES: { html: true },
      ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'u', 's', 'a', 'ul', 'ol', 'li',
                     'h2', 'h3', 'h4', 'blockquote', 'code', 'pre', 'img'],
      ALLOWED_ATTR: ['href', 'target', 'rel', 'src', 'alt', 'title'],
      ALLOW_DATA_ATTR: false,
    });
  }
  // Fallback: render as plain text (no rich formatting, but safe).
  const frag = document.createDocumentFragment();
  const tmp  = document.createElement('div');
  tmp.textContent = String(html || '');
  frag.appendChild(tmp);
  return frag;
};

// Tiny shared formatters
window.fmt = {
  date: (iso) => new Date(iso).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  }),
  longDate: (iso) => new Date(iso).toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  }),
  time: (iso) => new Date(iso).toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit',
  }),
  monShort: (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short' }).toUpperCase(),
  day: (iso) => String(new Date(iso).getDate()),
  // Strip HTML to plain text for previews. Uses DOMParser so script tags
  // never run; we extract textContent only.
  stripHtml: (html) => {
    const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
    return (doc.body.textContent || '').trim();
  },
};
