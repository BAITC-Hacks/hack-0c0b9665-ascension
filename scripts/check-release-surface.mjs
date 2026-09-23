/**
 * Read-only release inventory. Run: node scripts/check-release-surface.mjs
 * Also verify the deployed bytes and public API contracts:
 * RELEASE_BASE_URL=https://example.workers.dev node scripts/check-release-surface.mjs
 * No credentials, writes, Telegram calls, or paid AI requests are performed.
 * This complements (does not replace) authenticated browser acceptance tests.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, relative, extname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createContext, runInContext } from 'node:vm';

export const RELEASE_PAGES = ['index.html', 'citizens.html', 'mayor.html', 'desk.html', 'akim.html', 'resident.html', 'results.html', 'demo.html'];
export const AKIM_TABS = ['summary', 'problems', 'tasks', 'decisions', 'meeting'];
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const ORIGIN = 'https://release.invalid';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const decode = value => value.replace(/&(?:amp|quot|apos|lt|gt|#(\d+)|#x([a-f\d]+));/gi, (whole, decimal, hex) => {
  if (decimal || hex) return String.fromCodePoint(parseInt(decimal || hex, hex ? 16 : 10));
  return { '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>' }[whole.toLowerCase()] ?? whole;
});

// Parse authored start tags and quoted/unquoted attributes, not JavaScript text.
// Raw script/style bodies and comments must not masquerade as HTML resource tags.
export function htmlTags(source) {
  const markup = source.replace(/<!--[\s\S]*?-->/g, '').replace(/(<(script|style)\b[^>]*>)[\s\S]*?(<\/\2\s*>)/gi, '$1$3');
  return [...markup.matchAll(/<([a-z][\w:-]*)\b((?:[^"'<>]|"[^"]*"|'[^']*')*)>/gi)].map(([, name, raw]) => {
    const attributes = {};
    for (const [, key, double, single, bare] of raw.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
      attributes[key.toLowerCase()] = decode(double ?? single ?? bare ?? '');
    }
    return { name: name.toLowerCase(), attributes };
  });
}

export function localReference(value, owner = '/index.html') {
  if (!value || value.startsWith('#') || value.includes('${')) return null;
  const url = new URL(value, new URL(owner, ORIGIN));
  if (url.origin !== ORIGIN) return null;
  const pathname = decodeURIComponent(url.pathname);
  if (pathname.startsWith('/api/')) return null;
  return pathname.endsWith('/') ? `${pathname}index.html` : pathname;
}

export function htmlReferences(source, owner) {
  return htmlTags(source).flatMap(({ attributes }) => {
    const values = [attributes.src, attributes.href, attributes.poster];
    if (attributes.srcset && !attributes.srcset.startsWith('data:')) {
      values.push(...attributes.srcset.split(',').map(candidate => candidate.trim().split(/\s+/)[0]));
    }
    return values.map(value => localReference(value, owner)).filter(Boolean);
  });
}

export function cssReferences(source, owner) {
  return [...source.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)]+))\s*\)/gi)]
    .map(([, double, single, bare]) => localReference(double ?? single ?? bare, owner)).filter(Boolean);
}

function section(source, from, to) {
  const start = source.indexOf(from), end = source.indexOf(to, start + from.length);
  if (start < 0 || end < 0) throw new Error(`Renderer changed: cannot isolate ${from}; update the release harness.`);
  return source.slice(start, end);
}

function elements() {
  const nodes = new Map();
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, { innerHTML: '', textContent: '', style: {}, focus() {} });
    return nodes.get(id);
  };
  return { get, nodes };
}

// Execute the actual rendering functions against the shipped dataset. Imports,
// event listeners and initialize() are deliberately excluded: no application I/O.
export function renderIllustrationSlots(source, index, dataset) {
  const { get } = elements();
  const context = createContext({ document: { getElementById: get }, PLACES: [{ id: 'astana' }], fixture: dataset });
  const code = [
    section(source, 'const $ =', 'async function api('),
    section(source, 'function districtOptions(', 'function invalidateResult('),
    section(source, 'function renderDistricts(', 'function renderDistrictFocus('),
    'state.dataset = fixture; renderCatalog(); renderPlan();',
    'renderDistricts({ districts: fixture.districts.map(d => ({ ...d, before: d.indicators, after: d.indicators, beforeScore: 50, afterScore: 50 })) }, false);',
  ].join('\n');
  runInContext(code, context, { timeout: 2000 });
  const slotClasses = new Set(['direction-art', 'district-art', 'metric-icon', 'empty-plan-art', 'result-placeholder-art']);
  const slots = htmlTags([index, get('catalog').innerHTML, get('selected-list').innerHTML, get('district-summary').innerHTML].join('\n'))
    .filter(({ name, attributes }) => name === 'img' && (attributes.class || '').split(/\s+/).some(name => slotClasses.has(name)));
  return slots.map(({ attributes }) => ({ kind: attributes.class, path: localReference(attributes.src) }));
}

// Exercise real setTab()/render() with a synthetic signed-in state. This checks
// navigation presence and selection, not authentication or tab API behavior.
export function renderAkimNavigation(source) {
  const { get } = elements();
  const context = createContext({
    document: { querySelector: get, documentElement: {} },
    localStorage: { getItem() { return null; } }, location: { hash: '', search: '' },
    history: { replaceState() {} }, window: { scrollTo() {} }, URLSearchParams,
  });
  runInContext(section(source, 'const words =', 'function renderView()') + '\nfunction renderView() {}\nstate={now:"2026-09-23T12:00:00Z"};user={login:"release-check",role:"admin"};', context, { timeout: 2000 });
  return AKIM_TABS.map(tab => {
    runInContext(`setTab(${JSON.stringify(tab)})`, context, { timeout: 2000 });
    const buttons = htmlTags(get('#akim-app').innerHTML).filter(({ name, attributes }) => name === 'button' && attributes['data-action'] === 'tab');
    return { tab, tabs: buttons.map(({ attributes }) => attributes['data-tab']), selected: buttons.filter(({ attributes }) => attributes['aria-current'] === 'page').map(({ attributes }) => attributes['data-tab']) };
  });
}

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(async entry => {
    if (['node_modules', '.git', '.wrangler', 'vendor'].includes(entry.name)) return [];
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : entry.isFile() ? [path] : [];
  }))).flat();
}

export async function checkLocalSurface(root = ROOT) {
  const errors = [], resources = new Set(), pages = new Map();
  const publicRoot = resolve(root, 'public');
  const sourceFiles = (await Promise.all(['public', 'src', 'scripts', 'tests', 'data'].map(name => filesUnder(resolve(root, name))))).flat();
  for (const name of ['package.json', 'wrangler.jsonc']) sourceFiles.push(resolve(root, name));
  for (const path of sourceFiles) {
    if (!/\.(?:[cm]?js|jsonc?|html|css)$/.test(path)) continue;
    const source = await readFile(path, 'utf8');
    if (/^(?:<{7}(?: .*)?|={7}|>{7}(?: .*)?|\|{7}(?: .*)?)\r?$/m.test(source)) errors.push(`${relative(root, path)}: unresolved merge marker`);
  }
  for (const name of RELEASE_PAGES) {
    try {
      const source = await readFile(resolve(publicRoot, name), 'utf8');
      if (!htmlTags(source).some(tag => tag.name === 'html') || !htmlTags(source).some(tag => tag.name === 'title')) errors.push(`${name}: not a complete titled HTML page`);
      pages.set(name, source);
      resources.add('/' + name);
      for (const path of htmlReferences(source, '/' + name)) resources.add(path);
    } catch (error) { errors.push(`${name}: ${error.message}`); }
  }
  const reachable = new Set(['index.html']);
  for (const page of reachable) {
    for (const { name, attributes } of htmlTags(pages.get(page) || '')) {
      if (name !== 'a') continue;
      const target = localReference(attributes.href, '/' + page)?.slice(1);
      if (pages.has(target)) reachable.add(target);
    }
  }
  for (const page of pages.keys()) if (!reachable.has(page)) errors.push(`${page}: no navigation path from the home page`);
  // Set iteration visits CSS references added during the walk (including imports).
  for (const path of resources) {
    const file = resolve(publicRoot, '.' + path);
    const name = relative(publicRoot, file);
    if (name === '..' || name.startsWith('..' + sep)) { errors.push(`${path}: escapes public/`); continue; }
    try {
      if (!(await stat(file)).isFile()) throw new Error('not a file');
      if (extname(path) === '.css') for (const ref of cssReferences(await readFile(file, 'utf8'), path)) resources.add(ref);
    } catch (error) { errors.push(`${path}: missing referenced resource (${error.code || error.message})`); }
  }
  let slots = [], navigation = [];
  try {
    slots = renderIllustrationSlots(await readFile(resolve(publicRoot, 'app.js'), 'utf8'), pages.get('index.html') || '', JSON.parse(await readFile(resolve(root, 'data/city.json'), 'utf8')));
    if (slots.length !== 25) errors.push(`Expected 25 rendered illustration slots, found ${slots.length}`);
    if (new Set(slots.map(slot => slot.path)).size !== slots.length) errors.push('Illustration slots reuse the same image URL');
    const hashes = new Map();
    for (const { path } of slots) {
      if (!path || !path.startsWith('/assets/illustrations/') || path.includes('undefined')) { errors.push(`Invalid rendered illustration: ${path}`); continue; }
      resources.add(path);
      try {
        const bytes = await readFile(resolve(publicRoot, '.' + path));
        if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP') errors.push(`${path}: not a WebP file`);
        const hash = digest(bytes);
        if (hashes.has(hash)) errors.push(`${path}: duplicates bytes of ${hashes.get(hash)}`);
        hashes.set(hash, path);
      } catch (error) { errors.push(`${path}: ${error.message}`); }
    }
  } catch (error) { errors.push(`Illustration rendering: ${error.message}`); }
  try {
    navigation = renderAkimNavigation(await readFile(resolve(publicRoot, 'akim.js'), 'utf8'));
    for (const { tab, tabs, selected } of navigation) {
      if (tabs.join(',') !== AKIM_TABS.join(',') || selected.join(',') !== tab) errors.push(`Akim navigation fails when selecting ${tab}`);
    }
  } catch (error) { errors.push(`Akim navigation: ${error.message}`); }
  return { errors, resources: [...resources].sort(), pages: [...pages.keys()], illustrationSlots: slots.length, akimTabs: navigation.length };
}

export function validateJsonResponse(path, status, contentType, text, expectedStatus, validBody) {
  if (!/^application\/(?:[\w.+-]+\+)?json\b/i.test(contentType || '')) throw new Error(`${path}: expected JSON, got ${contentType || 'no content type'} (HTML fallback is not an API)`);
  let body;
  try { body = JSON.parse(text); } catch { throw new Error(`${path}: invalid JSON`); }
  if (status !== expectedStatus) {
    const code = body?.code || body?.errors?.[0]?.code;
    throw new Error(`${path}: HTTP ${status}, expected ${expectedStatus}${[409, 503].includes(status) ? ' (service unavailable)' : ''}${typeof code === 'string' ? `; ${code}` : ''}`);
  }
  if (!validBody(body)) throw new Error(`${path}: JSON contract mismatch`);
}

export async function checkHttpSurface(base, local, root = ROOT, fetcher = fetch) {
  const baseURL = new URL(base);
  if (!['http:', 'https:'].includes(baseURL.protocol) || baseURL.username || baseURL.password || baseURL.pathname !== '/' || baseURL.search || baseURL.hash) throw new Error('RELEASE_BASE_URL must be an HTTP(S) origin without credentials, path, query or fragment.');
  const errors = [], checks = [];
  const get = path => fetcher(new URL(path, baseURL), { method: 'GET', headers: { Accept: path.startsWith('/api/') ? 'application/json' : '*/*' }, signal: AbortSignal.timeout(15000), redirect: 'follow' });
  const types = { '.html': /^text\/html\b/i, '.css': /^text\/css\b/i, '.js': /^(?:text|application)\/(?:javascript|ecmascript)\b/i, '.webp': /^image\/webp\b/i, '.svg': /^image\/svg\+xml\b/i };
  // Exact byte comparison catches successful responses from a stale deployment.
  for (const path of new Set(['/', ...local.resources])) checks.push(async () => {
    const response = await get(path);
    if (response.status !== 200) throw new Error(`${path}: HTTP ${response.status}`);
    const type = types[extname(path === '/' ? 'index.html' : path)];
    if (type && !type.test(response.headers.get('content-type') || '')) throw new Error(`${path}: wrong content type ${response.headers.get('content-type')}`);
    const expected = await readFile(resolve(root, 'public', '.' + (path === '/' ? '/index.html' : path)));
    if (digest(Buffer.from(await response.arrayBuffer())) !== digest(expected)) throw new Error(`${path}: served bytes differ from this release checkout`);
  });
  const endpoints = [
    ['/api/health', 200, body => body?.ok === true && typeof body.aiConfigured === 'boolean'],
    ['/api/dataset', 200, body => Array.isArray(body?.measures) && body.measures.length > 0 && Array.isArray(body.districts) && body.districts.length > 0],
    ['/api/baseline', 200, body => body?.valid === true && Number.isFinite(body.score) && Array.isArray(body.districts)],
    ['/api/citizen/config', 200, body => typeof body?.adminConfigured === 'boolean' && typeof body?.analysisMode === 'string' && (body?.telegramUrl === null || typeof body?.telegramUrl === 'string')],
    ['/api/desk/session', 200, body => typeof body?.configured === 'boolean' && Object.hasOwn(body, 'user')],
    ['/api/public/results', 200, body => Array.isArray(body?.items) && Array.isArray(body?.districts)],
    ['/api/__release_surface_missing__', 404, body => body?.code === 'NOT_FOUND' || body?.errors?.some(error => error.code === 'NOT_FOUND')],
  ];
  for (const [path, status, validBody] of endpoints) checks.push(async () => {
    const response = await get(path);
    validateJsonResponse(path, response.status, response.headers.get('content-type'), await response.text(), status, validBody);
  });
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(6, checks.length) }, async () => {
    while (next < checks.length) {
      const check = checks[next++];
      try { await check(); } catch (error) { errors.push(error.message); }
    }
  }));
  return { errors, requests: checks.length };
}

async function main() {
  const local = await checkLocalSurface();
  let remote;
  if (process.env.RELEASE_BASE_URL) remote = await checkHttpSurface(process.env.RELEASE_BASE_URL, local);
  const errors = [...local.errors, ...(remote?.errors || [])];
  if (errors.length) { console.error(errors.map(error => `FAIL ${error}`).join('\n')); process.exitCode = 1; }
  else console.log(`PASS release surface: ${local.pages.length} pages, ${local.resources.length} local resources, ${local.illustrationSlots} unique illustration slots, ${local.akimTabs} akim tabs${remote ? `, ${remote.requests} read-only HTTP checks` : ''}.`);
  console.log('Scope: release inventory and public contracts; run authenticated browser E2E for workflows, plus visual checks for layout.');
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main().catch(error => { console.error(`FAIL ${error.message}`); process.exitCode = 1; });
