// Frame runtime: inlines Lucide icons, builds each portal's shell from <body data-portal data-nav>, and shows ?state=<name>.
// <body data-portal="operator|admin|auth|bare" data-nav="campaigns" data-keys="missing|disabled" data-alerts="2">
// <i data-icon="plus" class="sm"></i> becomes an inline SVG (stroke follows the text colour).
(() => {
  const state = new URLSearchParams(location.search).get('state') || 'default';
  const NAV = {
    operator: [
      { id: 'campaigns', label: 'Campaigns', icon: 'clapperboard', href: 'SCREEN-005.html' },
      { id: 'new', label: 'New brief', icon: 'square-pen', href: 'SCREEN-006.html' },
      { id: 'keys', label: 'Provider keys', icon: 'key-round', href: 'SCREEN-010.html' },
    ],
    admin: [
      { id: 'accounts', label: 'Accounts', icon: 'users', href: 'SCREEN-011.html' },
      { id: 'invites', label: 'Invitations', short: 'Invites', icon: 'mail-plus', href: 'SCREEN-012.html' },
      { id: 'usage', label: 'Usage report', short: 'Usage', icon: 'chart-column', href: 'SCREEN-015.html' },
      { id: 'alerts', label: 'Alerts', icon: 'bell', href: 'SCREEN-014.html' },
      { id: 'settings', label: 'Settings', icon: 'settings', href: 'SCREEN-013.html' },
    ],
  };
  const svg = (name, cls = '') =>
    `<svg class="icon ${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${(window.ICONS || {})[name] || ''}</svg>`;
  window.icon = svg;
  const icons = (root) =>
    root.querySelectorAll('i[data-icon]').forEach((el) => {
      const hidden = el.dataset.when; const tmp = document.createElement('span'); tmp.innerHTML = svg(el.dataset.icon, el.className);
      const node = tmp.firstChild; if (hidden) { node.dataset.when = hidden; } el.replaceWith(node);
    });

  document.addEventListener('DOMContentLoaded', () => {
    const body = document.body;
    const portal = body.dataset.portal;
    const main = document.querySelector('main');
    if (portal === 'operator' || portal === 'admin') {
      const items = NAV[portal];
      const active = body.dataset.nav;
      const isAdmin = portal === 'admin';
      const alerts = body.dataset.alerts;
      const link = (n, cls) =>
        `<a class="${cls}" href="${n.href}"${n.id === active ? ' aria-current="page"' : ''} title="${n.label}">${svg(n.icon)}<span class="label">${n.short || n.label}</span>${n.id === 'alerts' && alerts ? `<span class="count" aria-label="${alerts} unacknowledged">${alerts}</span><span class="count-dot"></span>` : ''}</a>`;
      const keysChip =
        body.dataset.keys === 'missing'
          ? `<a class="badge badge-warning link" href="SCREEN-010.html">${svg('key-round', 'sm')}<span class="txt">Add provider keys</span></a>`
          : body.dataset.keys === 'disabled'
            ? `<a class="badge badge-destructive link" href="SCREEN-010.html">${svg('triangle-alert', 'sm')}<span class="txt">Key disabled</span></a>`
            : '';
      const header = `<a class="skip-link" href="#main">Skip to content</a>
<header class="app-header">
  <a class="brand" href="${isAdmin ? 'SCREEN-011.html' : 'SCREEN-005.html'}" aria-label="ShrooMap home"><img src="../brand/shroomap-logo-light.svg" alt="ShrooMap"></a>
  ${isAdmin ? '<span class="portal-tag">Administration</span>' : ''}
  <div class="header-actions">${keysChip}
    <button class="avatar-btn" aria-haspopup="menu" aria-expanded="${state === 'menu-open'}" aria-label="${isAdmin || body.dataset.role === 'admin' ? 'Administrator' : 'Operator'} account menu"><span class="avatar">${svg('circle-user')}</span><span class="role">${isAdmin ? 'Administrator' : body.dataset.role === 'admin' ? 'Administrator' : 'Operator'}</span>${svg('chevron-down', 'sm')}</button>
  </div>
</header>`;
      const sidebar = `<nav class="app-sidebar" aria-label="Main"><div class="sidebar-inner">
  <div class="nav-group-label">${isAdmin ? 'Administration' : 'Workspace'}</div>
  ${items.map((n) => link(n, 'nav-item')).join('')}
  ${isAdmin || body.dataset.role === 'admin' ? `<div class="sidebar-foot"><a class="nav-item" href="${isAdmin ? 'SCREEN-005.html' : 'SCREEN-011.html'}" title="${isAdmin ? 'Back to workspace' : 'Administration'}">${svg(isAdmin ? 'arrow-left' : 'shield-check')}<span class="label">${isAdmin ? 'Back to workspace' : 'Administration'}</span></a></div>` : ''}
</div></nav>`;
      const tabbar = `<nav class="tabbar" aria-label="Main">${items.map((n) => link(n, '')).join('')}</nav>`;
      const menu = `<div class="menu" role="menu" data-when="menu-open" hidden>
  <div class="menu-label">Signed in as ${isAdmin || body.dataset.role === 'admin' ? 'Administrator' : 'Operator'}</div>
  <a href="SCREEN-010.html" role="menuitem">${svg('key-round')}Provider keys</a>
  ${isAdmin || body.dataset.role === 'admin' ? `<a href="${isAdmin ? 'SCREEN-005.html' : 'SCREEN-011.html'}" role="menuitem">${svg(isAdmin ? 'arrow-left' : 'shield-check')}${isAdmin ? 'Switch to workspace' : 'Switch to administration'}</a>` : ''}
  <a href="#" role="menuitem">${svg('shield')}Account and security${svg('external-link', 'sm')}</a>
  <hr>
  <button role="menuitem">${svg('log-out')}Sign out</button>
</div>`;
      const app = document.createElement('div');
      app.className = 'app';
      app.innerHTML = header + sidebar;
      main.id = 'main';
      main.classList.add('app-main');
      if (!main.querySelector(':scope > .page')) {
        const page = document.createElement('div');
        page.className = 'page' + (main.dataset.width ? ' ' + main.dataset.width : '');
        while (main.firstChild) page.appendChild(main.firstChild);
        main.appendChild(page);
      }
      main.parentNode.insertBefore(app, main);
      app.appendChild(main);
      app.insertAdjacentHTML('beforeend', tabbar);
      body.insertAdjacentHTML('beforeend', menu);
    }
    // workspace header: <div data-ws data-tab="brief|clips|final" data-name="…" data-brief="Needs review|success:Accepted" data-clips="0 of 3" data-final="Locked"><div class="ws-actions">…buttons…</div></div>
    document.querySelectorAll('[data-ws]').forEach((el) => {
      const d = el.dataset; const actions = el.querySelector('.ws-actions');
      const tab = (id, label, icon, href, badge, disabled) => `<a class="tab" role="tab" href="${href}" aria-selected="${d.tab === id}"${disabled ? ' aria-disabled="true"' : ''}>${svg(icon, 'sm')}${label}${badge ? ` <span class="badge ${badge.cls}">${badge.text}</span>` : ''}</a>`;
      const parse = (v) => { if (!v) return null; const [a, b] = v.includes('|') ? v.split('|') : ['', v]; return { cls: a ? 'badge-' + a : '', text: b }; };
      el.innerHTML = `<nav class="breadcrumb" aria-label="Breadcrumb"><a href="SCREEN-005.html">Campaigns</a>${svg('chevron-right', 'sm')}<span aria-current="page">${d.name}</span></nav>
<div class="page-header"><div class="titles"><h1>${d.name}</h1><div class="row ui muted"><span>UGC ad</span><span>${d.meta || '3 segments · 45 s'}</span><span>Created 14 Nov 2026</span></div></div><div class="actions"></div></div>
<div class="tabs" role="tablist" aria-label="Campaign stages">${tab('brief', '1 Brief', 'file-text', 'SCREEN-007.html', parse(d.brief))}${tab('clips', '2 Clips', 'clapperboard', 'SCREEN-008.html', parse(d.clips), d.clipsDisabled)}${tab('final', '3 Final', 'film', 'SCREEN-009.html', parse(d.final), d.finalDisabled)}</div>`;
      if (actions) el.querySelector('.page-header .actions').appendChild(actions);
      if (actions) actions.classList.add('row');
      el.classList.add('stack');
    });
    // steppers: <ol class="stepper" data-steps="A|B|C" data-step-map="default:2,step-1:1"> (current step per state; earlier steps are done)
    document.querySelectorAll('ol.stepper[data-steps]').forEach((ol) => {
      const map = Object.fromEntries(ol.dataset.stepMap.split(',').map((p) => p.split(':')));
      const cur = parseInt(map[state] || map.default || '1', 10);
      ol.setAttribute('aria-label', 'Progress');
      ol.innerHTML = ol.dataset.steps.split('|').map((t, i) => {
        const n = i + 1; const done = n < cur;
        return `<li class="step${done ? ' done' : ''}"${n === cur ? ' aria-current="step"' : ''}><span class="n">${done ? svg('check', 'sm') : n}</span><span class="t">${t}</span></li>`;
      }).join('');
    });
    icons(document);
    // states
    document.querySelectorAll('[data-when]').forEach((el) => {
      el.toggleAttribute('hidden', !el.dataset.when.split(' ').includes(state));
    });
    // inline-state attributes: data-state-attr="name:value:state" not needed; keep frames simple.
    // one visible control per label: give the visible variant the label's id, drop duplicates
    document.querySelectorAll('.field > label[for]').forEach((l) => {
      const all = [...l.parentElement.querySelectorAll('input,textarea,select')];
      const vis = all.find((c) => !c.closest('[hidden]'));
      if (!vis) return;
      all.forEach((c) => { if (c !== vis && c.id === l.htmlFor) c.removeAttribute('id'); });
      vis.id = l.htmlFor;
    });
    document.querySelectorAll('.table-wrap').forEach((w) => { w.tabIndex = 0; w.setAttribute('role', 'region'); w.setAttribute('aria-label', 'Table, scrolls sideways when narrow'); });
    document.documentElement.dataset.state = state;
  });
})();
