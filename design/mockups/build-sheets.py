# Generates frames/CMP-SHEET-0n.html (component galleries). Run: python3 build-sheets.py
import json
H = lambda t: ('<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>' + t + '</title><link rel="icon" href="../brand/favicon.svg">\n'
 '<link rel="stylesheet" href="../tokens.css"><link rel="stylesheet" href="../base.css"><link rel="stylesheet" href="../components.css"><script src="../assets/icons.js"></script><script src="../shell.js"></script></head>\n<body data-portal="bare"><main class="sheet">\n')
END = '</main></body></html>\n'
def st(tag, html): return '<div class="state"><span class="tag">' + tag + '</span>' + html + '</div>'
def cmp_(id_, name, body): return '<section class="cmp" aria-label="' + name + '"><h2>' + name + '</h2><span class="cmp-id">' + id_ + '</span>' + body + '</section>'
def states(*items): return '<div class="states">' + ''.join(items) + '</div>'
def btn(cls, txt, extra=''): return '<button class="btn ' + cls + '" ' + extra + '>' + txt + '</button>'
def field(inner): return '<div class="field">' + inner + '</div>'
ICON = lambda n, c='': '<i data-icon="' + n + '" class="' + c + '"></i>'

# ---- 01
sw = [("--background","#FBF9F4","Page"),("--card","#FFFFFF","Cards, inputs"),("--muted","#F5F1E6","Muted surface"),("--foreground","#232D38","Text"),("--muted-foreground","#566170","Secondary text"),("--primary","#4A6F47","Primary action"),("--primary-hover","#3C5A3A","Hover"),("--primary-subtle","#E8F0E4","Selected"),("--brand-cap","#5C8658","Brand green (graphic only)"),("--brand-stem","#D5BFA8","Stem beige"),("--brand-brown","#6A503C","Brown"),("--brand-rust","#9E6240","Rust"),("--destructive","#B42318","Destructive"),("--warning","#7A4B00","Warning"),("--success","#2C6B3A","Success"),("--info","#2A5B8C","Info"),("--input","#7C8590","Input border"),("--surface-inverse","#161C23","Dark surface")]
dark = {"#232D38","#566170","#4A6F47","#3C5A3A","#6A503C","#9E6240","#B42318","#7A4B00","#2C6B3A","#2A5B8C","#7C8590","#161C23","#5C8658"}
sws = ''
for n, h, u in sw:
    fg = '#fff' if h in dark else '#232D38'
    label = '' if h in ('#5C8658', '#7C8590') else 'Aa'
    sws += '<div class="swatch"><div class="chipc" style="background:' + h + ';color:' + fg + '">' + label + '</div><div class="meta"><strong>' + n + '</strong><span>' + h + '</span><span class="muted">' + u + '</span></div></div>'
logo = lambda f, w, dk='': '<div class="logo-tile ' + dk + '"><img src="../brand/' + f + '" alt="ShrooMap" width="' + str(w) + '"></div>'
b = H('CMP sheet 01: brand, tokens, type')
b += cmp_('CMP-001', 'Brand: logo, mark, icon set', states(
  st('Lockup on light (default)', logo('shroomap-logo-light.svg', 280)),
  st('Lockup on dark', logo('shroomap-logo-dark.svg', 280, 'dark')),
  st('Mark, light and dark', '<div class="row">' + logo('shroomap-mark.svg', 72) + logo('shroomap-mark-on-dark.svg', 72, 'dark') + '</div>'),
  st('Mono ink and mono cream', '<div class="row">' + logo('shroomap-logo-mono-ink.svg', 150) + logo('shroomap-logo-mono-cream.svg', 150, 'dark') + '</div>'),
  st('Favicon 16/32/48, apple-touch 180, manifest 192, maskable 512', '<div class="row"><img src="../brand/favicon.svg" width="16" height="16" alt=""><img src="../brand/favicon.svg" width="32" height="32" alt=""><img src="../brand/favicon.svg" width="48" height="48" alt=""><img src="../brand/apple-touch-icon.png" width="90" height="90" alt=""><img src="../brand/icon-192.png" width="96" height="96" alt=""><img src="../brand/icon-maskable-512.png" width="96" height="96" alt=""></div>'),
  st('Minimum size and clear space', '<p class="ui muted">Lockup 120 px wide minimum; mark 24 px (16 px uses the favicon cut). Clear space: 25% of the lockup height on every side.</p>')))
b += cmp_('TOKENS', 'Colour tokens', '<div class="swatches">' + sws + '</div>')
b += cmp_('TYPE', 'Type scale (Inter, self-hosted)', '<div class="stack"><h1>Page heading 24/32 · 600 · Morning Focus Blend</h1><h2>Section heading 18/28 · 600</h2><p>Body 16/24 · 400. Brief, generate and assemble brand-checked UGC video ads.</p><p class="ui">UI and table text 14/20 · 400/500. Estimated cost US$1,284.60 (tabular figures).</p><p class="caption">Caption 12/16 · 500, auxiliary only</p><p class="mono">u_8f3a…c21d · …7Q2d · fingerprint 4f9a·1c07 (system monospace)</p></div>')
open('frames/CMP-SHEET-01.html', 'w').write(b + END)

# ---- 02
def rowb(cls):
    return states(st('Default', btn(cls, 'Label')), st('Hover', btn(cls + ' is-hover', 'Label')), st('Focus', btn(cls + ' is-focus', 'Label')), st('Active', btn(cls + ' is-active', 'Label')), st('Disabled', btn(cls, 'Label', 'disabled')), st('Pending', btn(cls, '<span class="spinner"></span>Saving…', 'aria-busy="true" aria-disabled="true"')))
b = H('CMP sheet 02: primitives')
b += cmp_('CMP-003', 'Button: primary', rowb('btn-primary'))
b += cmp_('CMP-003', 'Button: secondary, outline, ghost, destructive', states(
  st('Secondary', btn('btn-secondary', 'Label')), st('Outline', btn('btn-outline', 'Label')), st('Ghost', btn('btn-ghost', 'Label')),
  st('Destructive', btn('btn-destructive', 'Delete')), st('Destructive outline', btn('btn-destructive-outline', 'Delete key')),
  st('Icon only', btn('btn-outline icon', ICON('trash-2'), 'aria-label="Delete"')), st('Small', btn('btn-outline sm', 'Small'))))
b += cmp_('CMP-004 / CMP-010', 'Input and form field', states(
  st('Empty', field('<label for="a1">Product name <span class="req">(required)</span></label><input id="a1" class="input" placeholder="Name"><div class="help">Up to 200 characters.</div>')),
  st('Filled', field('<label for="a2">Product name</label><input id="a2" class="input" value="Morning Focus Blend">')),
  st('Focused', field('<label for="a3">Product name</label><input id="a3" class="input is-focus" value="Morning Focus">')),
  st('Invalid', field('<label for="a4">Product name</label><input id="a4" class="input" aria-invalid="true" aria-describedby="e4"><div class="error" id="e4">' + ICON('circle-alert', 'sm') + 'Enter the product name.</div>')),
  st('Disabled', field('<label for="a5">Product name</label><input id="a5" class="input" value="Morning Focus Blend" disabled>')),
  st('Read-only', field('<label for="a6">Product name</label><input id="a6" class="input" value="Morning Focus Blend" readonly>')),
  st('Textarea with counter', field('<label for="a7">Dialogue</label><textarea id="a7" class="textarea">Short sample dialogue.</textarea><div class="counter warn">24 words · target 32 to 42</div>')),
  st('Masked key input', field('<label for="a8">API key</label><input id="a8" class="input key-input" type="password" value="••••••••••••"><div class="help">Never shown again after saving.</div>')),
  st('Select', field('<label for="a9">Tone</label><select id="a9" class="select"><option>Calm and grounded</option></select>'))))
b += cmp_('CMP-005 / CMP-006', 'Select and choice controls', states(
  st('Radio card selected', '<div class="radio-card" role="radio" aria-checked="true"><span class="dot"></span><div><div class="t">UGC ad</div><div class="d">Creator-style video</div></div></div>'),
  st('Radio card', '<div class="radio-card" role="radio" aria-checked="false"><span class="dot"></span><div><div class="t">Paste a script</div></div></div>'),
  st('Radio card disabled', '<div class="radio-card" role="radio" aria-checked="false" aria-disabled="true"><span class="dot"></span><div><div class="t">Animated</div><div class="d">Not in this release</div></div></div>'),
  st('Checkbox', '<label class="choice"><input type="checkbox" checked>Use segment 1</label>'),
  st('Segmented', '<div class="seg"><button aria-pressed="false">1</button><button aria-pressed="false">2</button><button aria-pressed="true">3</button><button aria-pressed="false">4</button></div>'),
  st('Switch on and off', '<div class="row"><span class="switch" role="switch" aria-checked="true"><span class="track"></span>On</span><span class="switch" role="switch" aria-checked="false"><span class="track"></span>Off</span></div>')))
bd = [('Neutral', '', ''), ('Primary', 'badge-primary', ''), ('Success', 'badge-success', ICON('circle-check')), ('Info', 'badge-info', '<span class="spinner"></span>'), ('Warning', 'badge-warning', ICON('triangle-alert')), ('Destructive', 'badge-destructive', ICON('circle-x'))]
b += cmp_('CMP-007', 'Badge and status', states(*[st(t, '<span class="badge ' + c + '">' + i + t + '</span>') for t, c, i in bd]))
b += cmp_('CMP-008', 'Loading: spinner, progress, skeleton', states(st('Spinner', '<span class="spinner"></span>'), st('Progress', '<div class="progress"><i class="w-60"></i></div>'), st('Skeleton', '<div class="stack-sm"><span class="skel h-lg w-50"></span><span class="skel w-full"></span><span class="skel w-75"></span></div>')))
b += cmp_('CMP-002', 'Icons (Lucide 1.73.0 at 16, 20, 24 px, 2 px stroke)', '<div class="row">' + ICON('plus', 'sm') + ICON('search') + ICON('key-round', 'lg') + ICON('shield-check', 'lg') + ICON('clapperboard', 'lg') + ICON('trash-2', 'lg') + '</div>')
open('frames/CMP-SHEET-02.html', 'w').write(b + END)

# ---- 03
b = H('CMP sheet 03: feedback, navigation and data')
al = ''
for k, i in [('info', 'info'), ('success', 'circle-check'), ('warning', 'triangle-alert'), ('destructive', 'circle-alert')]:
    al += '<div class="alert alert-' + k + '">' + ICON(i) + '<div class="body"><span class="title">' + k.capitalize() + ' alert title</span><span>Specific sentence about what happened and what to do next.</span></div></div>'
b += cmp_('CMP-011', 'Alert', '<div class="stack">' + al + '</div>')
b += cmp_('CMP-012', 'Toast (in flow here; top-right of the viewport in the app)', states('<div class="toast">' + ICON('circle-check') + '<div><strong>Campaign deleted.</strong></div></div>', '<div class="toast toast-error">' + ICON('circle-alert') + '<div><strong>Could not save.</strong> Try again.</div></div>', '<div class="toast toast-info">' + ICON('info') + '<div><strong>Invitation sent again.</strong></div></div>'))
b += cmp_('CMP-014 / CMP-015', 'Tabs and stepper', '<div class="stack"><div class="tabs" role="tablist" aria-label="Example tabs"><a class="tab" role="tab" aria-selected="true" href="#">History <span class="badge">24</span></a><a class="tab" role="tab" aria-selected="false" href="#">Drafts</a><a class="tab" role="tab" aria-selected="false" aria-disabled="true" href="#">Final</a></div><ol class="stepper" data-steps="Format|Product|Audience and direction|Concept and script" data-step-map="default:2"></ol></div>')
b += cmp_('CMP-016 / CMP-017', 'Data table, filter bar, pagination', '<div class="card"><div class="card-body tight stack"><div class="filter-bar"><div class="field search"><div class="input-group">' + ICON('search', 'sm') + '<input class="input" placeholder="Search"></div></div><div class="chips"><button class="chip" aria-pressed="true">All</button><button class="chip" aria-pressed="false">Failed 2</button></div></div></div><table class="table"><thead><tr><th>Account</th><th>Status</th><th class="num">Calls</th></tr></thead><tbody><tr><td>u_8f3a…c21d</td><td><span class="badge badge-success">Active</span></td><td class="num">402</td></tr><tr><td>u_41b9…07ae</td><td><span class="badge badge-warning">Suspended</span></td><td class="num">256</td></tr></tbody></table><div class="table-foot"><span>2 rows</span><div class="pager"><button class="btn btn-outline sm" disabled>Previous</button><button class="btn btn-outline sm">Next</button></div></div></div>')
b += cmp_('CMP-018 / CMP-019', 'Card, empty and error states', states('<div class="card"><div class="card-header"><h2>Card title</h2></div><div class="card-body">Card content.</div></div>', '<div class="card"><div class="empty"><div class="glyph">' + ICON('clapperboard', 'lg') + '</div><h2>No campaigns yet</h2><p>First useful action.</p></div></div>', '<div class="card"><div class="empty error"><div class="glyph">' + ICON('circle-alert', 'lg') + '</div><h2>Could not load</h2><button class="btn btn-outline sm">Try again</button></div></div>'))
open('frames/CMP-SHEET-03.html', 'w').write(b + END)

# ---- 04
b = H('CMP sheet 04: overlays, upload and domain components')
b += cmp_('CMP-013', 'Dialogs', states('<div class="dialog"><div class="dialog-head"><h2>Confirm dialog</h2></div><div class="dialog-body"><p>Explains consequences in plain words.</p></div><div class="dialog-foot"><button class="btn btn-outline">Cancel</button><button class="btn btn-destructive">Delete</button></div></div>', '<div class="dialog"><div class="dialog-head"><h2>Typed confirmation</h2></div><div class="dialog-body"><div class="field"><label for="tt">Type the address to confirm</label><input id="tt" class="input"></div></div><div class="dialog-foot"><button class="btn btn-outline">Cancel</button><button class="btn btn-destructive" disabled>Remove</button></div></div>'))
b += cmp_('CMP-020', 'Menu', '<div class="menu static"><div class="menu-label">Signed in as Administrator</div><a href="#">' + ICON('key-round') + 'Provider keys</a><a href="#">' + ICON('shield-check') + 'Switch to administration</a><hr><button>' + ICON('log-out') + 'Sign out</button></div>')
b += cmp_('CMP-021', 'File upload', states('<div class="dropzone">' + ICON('upload', 'lg') + '<div><strong>Drop an image here</strong></div><div class="muted">JPEG, PNG, WebP or GIF · up to 10 MB</div></div>', '<div class="upload-item"><div class="thumb"><img src="../assets/img/product-bottle.svg" alt="" width="56" height="56"></div><div class="grow"><div class="ui strong">bottle.jpg</div><div class="progress"><i class="w-60"></i></div></div><span class="badge badge-info">Processing</span></div>', '<div class="upload-item rejected"><div class="thumb"><span class="empty-thumb">' + ICON('file-warning') + '</span></div><div class="grow"><div class="ui strong">label.pdf</div><div class="ui text-destructive">Not supported.</div></div><span class="badge badge-destructive">Rejected</span></div>'))
b += cmp_('CMP-022 / CMP-023 / CMP-024', 'Job card, audio QC, claim issue', '<div class="stack"><div class="job-card"><div class="clip placeholder">' + ICON('file-video', 'lg') + '</div><div class="info"><div class="head"><h3>Segment 2</h3><span class="badge badge-destructive">Failed</span></div><div class="qc skipped">' + ICON('triangle-alert', 'text-warning') + '<div><strong>Audio check: skipped</strong><div>Reason shown here.</div></div></div></div></div><div class="claim high">' + ICON('shield-alert') + '<div class="grow"><strong>High risk · Segment 2</strong><div>"…<span class="quote">cures my anxiety</span>…" Edit until the check passes.</div></div></div><div class="claim other">' + ICON('triangle-alert') + '<div class="grow"><strong>Other · Segment 1</strong><div>Em dash. Edit or clear with a reason.</div></div></div><div class="claim closed">' + ICON('circle-check') + '<div class="grow"><strong>Closed</strong><div>Cleared with a recorded reason.</div></div></div></div>')
b += cmp_('CMP-025 / CMP-026 / CMP-027 / CMP-028', 'Key card, metric tile, campaign row', '<div class="stack"><div class="card"><div class="card-body key-card"><div><h2>OpenAI <span class="badge badge-success">Active</span></h2><dl class="kv"><dt>Key</dt><dd><span class="fp">…7Q2d</span></dd></dl></div><div class="row"><button class="btn btn-outline">Replace key</button><button class="btn btn-destructive-outline">Delete</button></div></div></div><div class="metrics"><div class="metric"><span class="l">Calls</span><span class="v num">1,284</span></div><div class="metric"><span class="l">Failed</span><span class="v num">37</span></div></div><div class="card"><div class="campaign-row"><div class="poster">' + ICON('film') + '</div><div><a class="name" href="#">Morning Focus Blend</a><div class="meta">3 segments · 45 s</div></div><span class="badge badge-success">Final ready</span></div></div></div>')
open('frames/CMP-SHEET-04.html', 'w').write(b + END)

fr = [f for f in json.load(open('frames.json')) if not f['id'].startswith('CMP-SHEET')]
for i in ('01', '02', '03', '04'):
    fr.append({"id": "CMP-SHEET-" + i, "file": "frames/CMP-SHEET-" + i + ".html", "states": ["default"], "widths": [1440, 390]})
json.dump(fr, open('frames.json', 'w'), indent=1)
