/* Play the experiment the way a visitor would, at two widths, and check that
   everything downstream of it actually fills in. A demo nobody clicked is a
   demo nobody verified. */
const { chromium } = require('/home/bolgac/projects/minimalist-workout-app/node_modules/playwright');
const path = require('path');
const fs = require('fs');

const PAGE = 'file://' + path.resolve(__dirname, '..', 'docs', 'index.html') + '?tour=off';
const OUT = path.resolve(__dirname, '..', 'data', 'shots');

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  let fail = false;
  const errors = [];

  for (const [name, w, h] of [['desktop', 1536, 960], ['phone', 390, 844]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(`[${name}] ${e.message}`));
    page.on('console', m => { if (m.type() === 'error') errors.push(`[${name}] console: ${m.text()}`); });
    await page.goto(PAGE, { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);

    const selfcheck = await page.evaluate(() => document.querySelector('#selfcheck').innerText);
    if (name === 'desktop') console.log('SELF-CHECK: ' + selfcheck);
    if (!/Matched/.test(selfcheck)) { console.log('  self-check did not match'); fail = true; }

    await page.click('#begin');
    await page.waitForTimeout(150);

    await page.waitForSelector('#routebtns button:not([disabled])');
    const days = await page.evaluate(() => D.recovery.days);
    const closure = await page.evaluate(() => D.closure_day);
    let clicks = 0;
    for (let d = 1; d <= days; d++) {
      const open = await page.$$('#routebtns button:not([disabled])');
      if (!open.length) { console.log(`  day ${d}: no enabled route button`); fail = true; break; }
      if (d === closure) {
        const offCount = await page.evaluate(() => document.querySelectorAll('#routebtns button[disabled]').length);
        if (offCount < 1) { console.log(`  day ${d}: the closure did not shut a route`); fail = true; }
      }
      await open[d % open.length].click();
      clicks++;
      await page.waitForTimeout(d >= days ? 500 : 950);
    }
    console.log(`${name}: played ${clicks} days`);

    const after = await page.evaluate(() => ({
      fit: document.querySelector('#fitcard').innerText.slice(0, 400),
      cmp: document.querySelector('#cmpcard').innerText.slice(0, 260),
      v2: document.querySelector('#v2').innerText,
      v4: document.querySelector('#v4').innerText,
      beliefSvg: !!document.querySelector('#beliefviz svg'),
      readout: document.querySelector('#readout').innerText
    }));
    if (!after.beliefSvg) { console.log('  belief chart missing'); fail = true; }
    if (!/learning rate/i.test(after.fit)) { console.log('  fit card empty'); fail = true; }
    if (!/stable preference/i.test(after.cmp)) { console.log('  comparison card empty'); fail = true; }
    if (!after.v2 || !after.v4) { console.log('  a verdict stayed empty'); fail = true; }
    if (name === 'desktop') {
      console.log('\nFIT CARD:\n' + after.fit.replace(/\n+/g, ' | '));
      console.log('\nCOMPARISON:\n' + after.cmp.replace(/\n+/g, ' | '));
      console.log('\nVERDICT 2: ' + after.v2);
      console.log('VERDICT 4: ' + after.v4);
    }

    const of = await page.evaluate(() => {
      const de = document.documentElement;
      return { sw: de.scrollWidth, cw: de.clientWidth };
    });
    if (of.sw > of.cw + 1) { console.log(`  OVERFLOW after playing at ${name}: ${of.sw} > ${of.cw}`); fail = true; }
    else console.log(`  no overflow after playing at ${name}`);

    await page.screenshot({ path: path.join(OUT, `${name}-played.png`), fullPage: true });
    await ctx.close();
  }

  await browser.close();
  if (errors.length) { console.log('\nSCRIPT ERRORS:'); errors.forEach(e => console.log('  ' + e)); fail = true; }
  else console.log('\nno script errors while playing');
  process.exit(fail ? 1 : 0);
})();
