/**
 * Opt-in real-browser map regression. Requires Chrome, Playwright and network
 * access to OpenFreeMap. No map/style/tile/service stubs are used.
 *
 * Run: node tests/map-sectors.e2e.mjs
 * If Playwright is not installed locally, set PLAYWRIGHT_MODULE to its absolute
 * index.mjs path. MAP_SCREENSHOT_DIR controls the evidence directory.
 * The isolated local server disables AI, so the demo cannot call a paid model.
 */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAppServer } from '../src/server.js';
import { DISTRICT_COLORS, DISTRICT_BOUNDS, DISTRICT_SECTORS } from '../public/district-sectors.js';

const moduleName = process.env.PLAYWRIGHT_MODULE;
const { chromium } = await import(moduleName ? pathToFileURL(moduleName).href : 'playwright');
const screenshotDir = process.env.MAP_SCREENSHOT_DIR || join(tmpdir(), 'ascension-map-sectors');
await mkdir(screenshotDir, { recursive: true });
const server = createAppServer({ aiConfigured: () => false, env: {} });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
let page;
const pageErrors = [];
const networkFailures = [];
const fmt = value => Number(value).toLocaleString('ru-RU', { maximumFractionDigits: 1, minimumFractionDigits: 1 });
const step = async (name, run) => { await run(); console.log(`PASS ${name}`); };

async function settle() {
  await page.waitForFunction(() => window.__testMap && !window.__testMap.isMoving());
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function mapPoint(districtId) {
  // Find a real rendered polygon pixel not covered by markers or overlays.
  return page.evaluate(id => {
    const map = window.__testMap;
    const canvas = map.getCanvas();
    const rect = canvas.getBoundingClientRect();
    for (let y = 30; y < rect.height - 30; y += 12) {
      for (let x = 30; x < rect.width - 30; x += 12) {
        const globalX = rect.left + x, globalY = rect.top + y;
        if (globalY < 0 || globalY > innerHeight || document.elementFromPoint(globalX, globalY) !== canvas) continue;
        if (map.queryRenderedFeatures([x, y], { layers: ['citymap-sector-fill'] })[0]?.properties.districtId === id) return { x: globalX, y: globalY };
      }
    }
    throw new Error(`No unobstructed rendered sector pixel for ${id}`);
  }, districtId);
}

async function assertSelection(id) {
  assert.equal(await page.locator(`.citymap-district-card[data-district="${id}"]`).getAttribute('aria-pressed'), 'true');
  const selected = await page.evaluate(() => Object.entries(window.__testColors).filter(([key]) => window.__testMap.getFeatureState({ source: 'citymap-districts', id: key }).selected).map(([key]) => key));
  assert.deepEqual(selected, [id]);
}

async function assertFit() {
  await settle();
  const fit = await page.evaluate(bounds => {
    const map = window.__testMap;
    const canvas = map.getCanvas().getBoundingClientRect();
    const inspector = document.querySelector('.citymap-inspector').getBoundingClientRect();
    const corners = bounds.flatMap(([x]) => bounds.map(([, y]) => map.project([x, y])));
    return { corners, width: canvas.width, height: canvas.height, inspectorRight: inspector.right - canvas.left, mobile: matchMedia('(max-width: 670px)').matches };
  }, DISTRICT_BOUNDS);
  for (const corner of fit.corners) {
    assert.ok(corner.x >= -1 && corner.x <= fit.width + 1 && corner.y >= -1 && corner.y <= fit.height + 1, `sector corner outside canvas: ${JSON.stringify({ corner, fit })}`);
    if (!fit.mobile) assert.ok(corner.x > fit.inspectorRight, 'overview reserves inspector space');
  }
}

async function assertMobileLayout() {
  const layout = await page.evaluate(() => {
    const rect = selector => {
      const element = document.querySelector(selector), box = element.getBoundingClientRect();
      return { x: box.x, y: box.y, right: box.right, bottom: box.bottom, width: box.width, height: box.height };
    };
    return { viewport: innerWidth, document: document.documentElement.scrollWidth, stage: rect('.citymap-stage'), inspector: rect('.citymap-inspector'), metric: rect('.citymap-inspector-value > span'), priority: rect('.citymap-priority'), tools: rect('.citymap-map-tools'), hint: rect('.citymap-interaction-hint') };
  });
  const overlaps = (a, b) => a.x < b.right - 1 && a.right > b.x + 1 && a.y < b.bottom - 1 && a.bottom > b.y + 1;
  assert.ok(layout.document <= layout.viewport, `horizontal page overflow: ${JSON.stringify(layout)}`);
  assert.ok(layout.inspector.y >= layout.stage.bottom - 1, 'mobile inspector is below the canvas');
  assert.ok(!overlaps(layout.inspector, layout.tools), 'map tools do not cover inspector');
  assert.ok(!overlaps(layout.metric, layout.priority), `metric label overlaps priority: ${JSON.stringify(layout)}`);
  assert.ok(layout.hint.y >= layout.inspector.bottom - 1, 'help text follows inspector');
}

try {
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1200 }, reducedMotion: 'reduce' });
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('requestfailed', request => networkFailures.push({ url: request.url(), error: request.failure()?.errorText }));
  await page.addInitScript(colors => {
    window.__testColors = colors;
    // Capture the real MapLibre instance without changing its implementation.
    let library;
    Object.defineProperty(window, 'maplibregl', {
      configurable: true,
      get: () => library,
      set(value) {
        library = value;
        const OriginalMap = value.Map;
        value.Map = class extends OriginalMap {
          constructor(...args) { super(...args); window.__testMap = this; }
        };
      },
    });
  }, DISTRICT_COLORS);
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__testMap?.getLayer('citymap-sector-fill'), null, { timeout: 30_000 });
  await page.locator('#city-map').scrollIntoViewIfNeeded();
  await settle();

  await step('real map, five palette colors and fit overview', async () => {
    assert.equal(await page.locator('.citymap-fallback').isVisible(), false);
    assert.equal(await page.locator('.citymap-district-card').count(), 5);
    const source = await page.evaluate(() => window.__testMap.getSource('citymap-districts').getData());
    assert.deepEqual(source, DISTRICT_SECTORS);
    assert.equal(new Set(source.features.map(feature => feature.properties.color)).size, 5);
    assert.deepEqual(await page.evaluate(() => window.__testMap.getPaintProperty('citymap-sector-fill', 'fill-color')), ['get', 'color']);
    await assertFit();
    await page.locator('#city-map').screenshot({ path: join(screenshotDir, 'desktop.png') });
  });

  await step('hover and select every sector using actual canvas mouse events', async () => {
    for (const id of Object.keys(DISTRICT_COLORS)) {
      const point = await mapPoint(id);
      await page.mouse.move(point.x, point.y);
      await page.waitForFunction(id => window.__testMap.getFeatureState({ source: 'citymap-districts', id }).hover === true, id);
      assert.equal(await page.locator('.citymap-hover-tip').isVisible(), true);
      assert.equal(await page.locator('.citymap-hover-tip').evaluate(element => element.style.getPropertyValue('--district-color')), DISTRICT_COLORS[id]);
      await page.mouse.click(point.x, point.y);
      await assertSelection(id);
    }
    await page.mouse.move(10, 10);
    assert.equal(await page.locator('.citymap-hover-tip').isVisible(), false);
  });

  await step('district cards support arrows, Home, End and Enter; reset restores fit', async () => {
    await page.locator('.citymap-district-card').first().focus();
    await page.keyboard.press('End');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.district), 'nura');
    await page.keyboard.press('Home');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.district), 'esil');
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.district), 'almaty');
    await page.keyboard.press('Enter');
    await assertSelection('almaty');
    await page.locator('.citymap-show-all').click();
    await assertFit();
  });

  await step('sector visibility toggle hides and restores all three layers', async () => {
    for (const expected of ['none', 'visible']) {
      await page.locator('.citymap-sector-toggle').click();
      assert.deepEqual(await page.evaluate(() => ['citymap-sector-fill', 'citymap-sector-halo', 'citymap-sector-line'].map(id => window.__testMap.getLayoutProperty(id, 'visibility'))), [expected, expected, expected]);
      assert.equal(await page.locator('.citymap-hover-tip').isVisible(), false);
    }
  });

  await step('calculated values and before/after controls use official simulation results', async () => {
    await page.locator('#demo-button').click();
    const response = page.waitForResponse(response => response.url().endsWith('/api/simulate') && response.request().method() === 'POST');
    await page.locator('#simulate-button').click();
    const result = await (await response).json();
    assert.equal(result.valid, true);
    await page.waitForFunction(() => document.querySelector('[data-phase="after"]').getAttribute('aria-pressed') === 'true');
    for (const phase of ['before', 'after']) {
      await page.locator(`[data-phase="${phase}"]`).click();
      for (const district of result.districts) {
        assert.equal(await page.locator(`.citymap-district-card[data-district="${district.id}"] > strong`).innerText(), fmt(district[`${phase}Score`]));
      }
    }
    await page.locator('.citymap-district-card[data-district="nura"]').click();
    await page.locator('.citymap-metric').selectOption('S2');
    assert.equal(await page.locator('.citymap-inspector-value > strong').innerText(), fmt(result.districts.find(item => item.id === 'nura').after.S2));
    await page.locator('.citymap-show-all').click();
  });

  await step('mobile 320/390/670: no horizontal overflow, no inspector/control/text overlap', async () => {
    for (const width of [320, 390, 670]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.locator('.citymap-show-all').click();
      await settle();
      await page.locator('#city-map').screenshot({ path: join(screenshotDir, `mobile-${width}.png`) });
      await assertMobileLayout();
      await assertFit();
    }
  });

  await step('tablet 768/820: overview leaves inspector clear', async () => {
    for (const width of [768, 820]) {
      await page.setViewportSize({ width, height: 1200 });
      await page.locator('.citymap-show-all').click();
      await assertFit();
      await page.locator('#city-map').screenshot({ path: join(screenshotDir, `tablet-${width}.png`) });
    }
  });

  await step('other cities hide scenario sectors, scores and markers; return restores demo', async () => {
    await page.setViewportSize({ width: 390, height: 1000 });
    await page.locator('.citymap-place').selectOption('almaty-city');
    await settle();
    for (const selector of ['.citymap-sector-toolbar', '.citymap-data-toolbar', '.citymap-district-list', '.citymap-legend']) assert.equal(await page.locator(selector).isVisible(), false, selector);
    assert.equal(await page.locator('.citymap-marker').count(), 0);
    assert.equal(await page.evaluate(() => window.__testMap.getLayoutProperty('citymap-sector-fill', 'visibility')), 'none');
    assert.match(await page.locator('.citymap-inspector').innerText(), /Алматы/);
    const geometry = await page.evaluate(() => {
      const inspector = document.querySelector('.citymap-inspector').getBoundingClientRect();
      const credit = document.querySelector('.citymap-disclaimer').getBoundingClientRect();
      const button = document.querySelector('.citymap-return').getBoundingClientRect();
      return { inspectorBottom: inspector.bottom, nextTop: credit.top, buttonBottom: button.bottom, width: document.documentElement.scrollWidth, viewport: innerWidth };
    });
    assert.ok(geometry.buttonBottom <= geometry.inspectorBottom && geometry.nextTop >= geometry.inspectorBottom - 1, JSON.stringify(geometry));
    assert.ok(geometry.width <= geometry.viewport);
    await page.locator('#city-map').screenshot({ path: join(screenshotDir, 'mobile-geography.png') });
    await page.locator('.citymap-return').click();
    assert.equal(await page.locator('.citymap-district-card').count(), 5);
    assert.equal(await page.locator('.citymap-marker').count(), 5);
  });

  await step('3D explorer still renders buildings and selects a real building', async () => {
    await page.setViewportSize({ width: 1440, height: 1200 });
    await page.locator('[data-view="3d"]').click();
    await settle();
    assert.equal(await page.locator('.city-explorer').isVisible(), true);
    assert.equal(await page.locator('.citymap-sector-toggle').isDisabled(), true);
    assert.equal(await page.evaluate(() => window.__testMap.getLayoutProperty('citymap-sector-fill', 'visibility')), 'none');
    assert.equal(await page.evaluate(() => window.__testMap.getLayoutProperty('citymap-buildings-3d', 'visibility')), 'visible');
    await page.waitForFunction(() => window.__testMap.queryRenderedFeatures(undefined, { layers: ['citymap-buildings-3d'] }).length > 0, null, { timeout: 30_000 });
    await page.locator('.citymap-stage').scrollIntoViewIfNeeded();
    const point = await page.evaluate(() => {
      const map = window.__testMap, canvas = map.getCanvas(), box = canvas.getBoundingClientRect();
      for (let y = 140; y < box.height - 120; y += 6) for (let x = 150; x < box.width - 100; x += 6) {
        if (document.elementFromPoint(box.left + x, box.top + y) !== canvas) continue;
        if (map.queryRenderedFeatures([x, y], { layers: ['citymap-buildings-3d'] }).length) return { x: box.left + x, y: box.top + y };
      }
      throw new Error('No unobstructed 3D building pixel');
    });
    await page.mouse.click(point.x, point.y);
    assert.equal(await page.locator('.city-explorer-panel').isVisible(), true);
    assert.match(await page.locator('.city-explorer-panel').innerText(), /Здание|Группа зданий/);
    await page.locator('#city-map').screenshot({ path: join(screenshotDir, 'desktop-3d-building.png') });
    await page.locator('[data-view="2d"]').click();
    assert.equal(await page.locator('.city-explorer').isVisible(), false);
    await assertFit();
  });

  await step('3D chosen while the remote style is loading applies after load', async () => {
    let release;
    let sawStyle;
    const held = new Promise(resolve => { release = resolve; });
    const requested = new Promise(resolve => { sawStyle = resolve; });
    const url = 'https://tiles.openfreemap.org/styles/positron';
    await page.route(url, async route => { sawStyle(); await held; await route.continue(); });
    try {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await requested;
      await page.locator('[data-view="3d"]').click();
      release();
      await page.waitForFunction(() => window.__testMap?.getLayer('citymap-buildings-3d') && window.__testMap.getPitch() > 50, null, { timeout: 30_000 });
      assert.equal(await page.locator('.city-explorer').isVisible(), true);
      assert.equal(await page.locator('[data-view="3d"]').getAttribute('aria-pressed'), 'true');
      assert.equal(await page.evaluate(() => window.__testMap.getLayoutProperty('citymap-sector-fill', 'visibility')), 'none');
    } finally {
      release();
      await page.unroute(url);
    }
  });

  assert.deepEqual(pageErrors, [], 'no uncaught browser exceptions');
  console.log(JSON.stringify({ screenshots: screenshotDir, pageErrors, networkFailures }, null, 2));
} catch (error) {
  await page?.screenshot({ path: join(screenshotDir, 'failure.png'), fullPage: false }).catch(() => {});
  console.error(JSON.stringify({ screenshots: screenshotDir, pageErrors, networkFailures }, null, 2));
  throw error;
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
