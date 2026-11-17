import { createRequire } from 'node:module';
import { readdirSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
const root = process.argv[2];
const { chromium } = createRequire(root + '/x.js')('/paperclip/instances/default/projects/49d7702a-17ba-48f6-936a-6f2503a0a47e/1a1eae3f-76eb-4c97-b304-6407a3ae88d7/meta-ads/.paperclip/worktrees/feature/AIU-277-sdlc-owner-preview-ui-ux-review-of-every-merged-screen-against-its-mockup/node_modules/.pnpm/playwright@1.65.1/node_modules/playwright');
const map = { 'fe-screen-001-003': ['SCREEN-001','SCREEN-003'], 'fe-screen-002':['SCREEN-002'],'fe-screen-004':['SCREEN-004'],'fe-screen-005':['SCREEN-005'],'fe-screen-006a':['SCREEN-006'],'fe-screen-006b':['SCREEN-006'],'fe-screen-007a':['SCREEN-007'],'fe-screen-007b':['SCREEN-007'],'fe-screen-008':['SCREEN-008'],'fe-screen-009a':['SCREEN-009'],'fe-screen-009b':['SCREEN-009'],'fe-screen-010':['SCREEN-010'],'fe-screen-011':['SCREEN-011'],'fe-screen-012':['SCREEN-012'],'fe-screen-013':['SCREEN-013'],'fe-screen-014':['SCREEN-014'],'fe-screen-015':['SCREEN-015'] };
const ev = root + '/evidence/visual/1b3e62f', png = root + '/design/mockups/png';
mkdirSync(ev + '/compare', { recursive: true });
const b = await chromium.launch();
for (const w of [390, 1440]) {
  for (const [spec, ids] of Object.entries(map)) {
    const dir = `${ev}/${spec}/screenshots`; if (!existsSync(dir)) continue;
    const items = [];
    for (const f of readdirSync(dir).filter(f => f.endsWith(`-${w}.png`)).sort()) {
      const state = f.replace(`-${w}.png`, '');
      const fr = ids.map(i => `${png}/${i}--${state}--${w}.png`).find(existsSync);
      items.push({ state, build: `${dir}/${f}`, frame: fr });
    }
    const per = w === 390 ? 2 : 1;
    for (let p = 0; p * per < items.length; p++) {
      const part = items.slice(p * per, p * per + per);
      const html = `<body style="margin:0;font:14px sans-serif;background:#888"><div style="display:flex;gap:12px;padding:8px;align-items:flex-start">${part.map(it => `<div><div style="background:#fff;padding:2px 6px;margin-bottom:4px"><b>${it.state}</b> ${w}px — left: BUILD, right: FRAME${it.frame ? '' : ' (none)'}</div><div style="display:flex;gap:6px;align-items:flex-start"><img src="file://${it.build}" style="width:${w}px;${w===1440?'width:700px':''}">${it.frame ? `<img src="file://${it.frame}" style="width:${w===1440?700:w}px">` : ''}</div></div>`).join('')}</div></body>`;
      const page = await b.newPage({ viewport: { width: 1500, height: 900 } });
      writeFileSync('/tmp/uxv277/t.html', html);
      await page.goto('file:///tmp/uxv277/t.html');
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${ev}/compare/${spec}-${w}-${p + 1}.png`, fullPage: true });
      await page.close();
    }
  }
}
await b.close();
