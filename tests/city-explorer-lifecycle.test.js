import test from 'node:test';
import assert from 'node:assert/strict';
import { mountCityExplorer } from '../public/city-explorer.js';

function setupExplorer(t) {
  const frames = new Map();
  let frameId = 0;
  class Element {
    hidden = false;
    style = {};
    children = new Map();
    listeners = new Map();
    classList = { toggle() {}, remove() {} };
    append(child) { this.appended = child; }
    remove() {}
    setAttribute() {}
    addEventListener(event, listener) { this.listeners.set(event, listener); }
    removeEventListener(event) { this.listeners.delete(event); }
    querySelector(selector) {
      if (!this.children.has(selector)) {
        const element = new Element();
        element.hidden = ['.city-explorer-list', '.city-explorer-panel'].includes(selector);
        this.children.set(selector, element);
      }
      return this.children.get(selector);
    }
    getContext() {
      return { fillRect() {}, beginPath() {}, roundRect() {}, fill() {}, stroke() {}, getImageData: () => ({}) };
    }
  }
  const document = new Element();
  document.body = new Element();
  document.createElement = () => new Element();
  const globals = {
    document,
    requestAnimationFrame(callback) { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame(id) { frames.delete(id); },
    IntersectionObserver: undefined,
  };
  const original = Object.fromEntries(Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  t.after(() => {
    for (const name of Object.keys(globals)) {
      if (original[name]) Object.defineProperty(globalThis, name, original[name]);
      else delete globalThis[name];
    }
  });

  const sources = new Map(), layers = new Map(), images = new Set(), listeners = new Map();
  const roadLayer = { id: 'road', type: 'line', 'source-layer': 'transportation' };
  layers.set('road', roadLayer);
  let loaded = true;
  let center = { lng: 71.43, lat: 51.13 };
  let trafficPaints = 0;
  const map = {
    hasImage: (id) => images.has(id), addImage: (id) => images.add(id), removeImage: (id) => images.delete(id),
    addSource(id) {
      sources.set(id, { data: null, setData(data) { this.data = data; if (id === 'city-explorer-traffic') trafficPaints += 1; } });
    },
    getSource: (id) => sources.get(id), removeSource: (id) => sources.delete(id),
    addLayer: (layer) => layers.set(layer.id, layer), getLayer: (id) => layers.get(id), removeLayer: (id) => layers.delete(id),
    getStyle: () => ({ layers: [...layers.values()] }),
    getCenter: () => center, getZoom: () => 15, areTilesLoaded: () => loaded, isMoving: () => false,
    queryRenderedFeatures: () => [{ type: 'Feature', properties: { class: 'primary' },
      geometry: { type: 'LineString', coordinates: [[center.lng, center.lat], [center.lng + .01, center.lat]] } }],
    getCanvas: () => ({ style: {} }), resize() {},
    on: (event, listener) => listeners.set(event, listener), off: (event) => listeners.delete(event),
  };
  const flushFrame = (now) => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((callback) => callback(now));
  };
  const host = new Element();
  const explorer = mountCityExplorer({ host, map, city: { name: 'Астана' } });
  return {
    explorer, root: host.querySelector('.citymap-stage').appended, frames, sources, layers, images, listeners, document, flushFrame,
    setLoaded(value) { loaded = value; }, setCenter(value) { center = value; }, trafficPaints: () => trafficPaints,
  };
}

test('changing city stops animation until destination roads load and destroy releases it', (t) => {
  const { explorer, frames, sources, layers, images, listeners, document, flushFrame, setLoaded, setCenter, trafficPaints } = setupExplorer(t);
  explorer.setEnabled(true);
  flushFrame(100);
  assert.equal(frames.size, 1, 'loaded traffic continues animating');
  assert.ok(sources.get('city-explorer-traffic').data.features.length > 0);

  setLoaded(false);
  explorer.setCity({ name: 'Алматы' });
  assert.equal(frames.size, 0, 'city reset cancels the already scheduled frame');
  const paintsAfterReset = trafficPaints();
  flushFrame(200);
  assert.equal(trafficPaints(), paintsAfterReset, 'no empty GeoJSON paints while destination is loading');
  assert.deepEqual(sources.get('city-explorer-traffic').data.features, []);

  setCenter({ lng: 76.945, lat: 43.238 });
  setLoaded(true);
  listeners.get('idle')();
  assert.equal(frames.size, 1, 'destination roads resume the animation');
  assert.ok(sources.get('city-explorer-traffic').data.features.every((feature) => feature.geometry.coordinates[0] > 76));
  flushFrame(300);
  explorer.destroy();
  assert.equal(frames.size, 0);
  assert.equal(listeners.size, 0);
  assert.equal(document.listeners.size, 0);
  assert.equal(sources.size, 0);
  assert.equal(images.size, 0);
  assert.deepEqual([...layers.keys()], ['road']);
});

test('timeline refresh updates an open district card without reopening a dismissed card', (t) => {
  const { explorer, root } = setupExplorer(t);
  explorer.setEnabled(true);
  const district = { name: 'Нура', metric: 'Оценка района', value: 49.2, phase: 'До решений', weakest: 'Поликлиники · 35,0' };
  const panel = root.querySelector('.city-explorer-panel');

  explorer.inspectDistrict(district, { reveal: false });
  assert.equal(panel.hidden, true, 'a passive calculation does not open a new card');
  explorer.inspectDistrict(district);
  assert.equal(panel.hidden, false, 'an explicit district selection opens its card');
  explorer.inspectDistrict({ ...district, value: 53 }, { reveal: false });
  assert.match(panel.innerHTML, /53 \/ 100/, 'an open card follows the current timeline value');

  root.listeners.get('click')({ target: { closest: () => ({ dataset: { action: 'close' } }) } });
  explorer.inspectDistrict({ ...district, value: 50 }, { reveal: false });
  assert.equal(panel.hidden, true, 'the next frame respects the user closing the card');
  explorer.inspectDistrict(district);
  assert.equal(panel.hidden, false, 'selecting the same district again still opens its card');
  explorer.destroy();
});
