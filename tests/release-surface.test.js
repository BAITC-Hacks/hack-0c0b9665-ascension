import test from 'node:test';
import assert from 'node:assert/strict';
import { htmlReferences, cssReferences, validateJsonResponse, checkLocalSurface } from '../scripts/check-release-surface.mjs';

test('release inventory resolves local resources without treating comments, inline code, data or external URLs as files', () => {
  const html = `<!-- <img src="/missing-comment.webp"> --><script>const template='<img src="/not-a-resource">';</script>
    <link href='/app.css?v=2&amp;theme=green'><script src="./app.js"></script>
    <img src=/art.webp srcset="/art.webp 1x, /art-large.webp 2x">
    <a href="/#workspace">home</a><a href="#local">anchor</a><img src="data:image/png;base64,AA==">
    <a href="https://example.com/other.html">external</a><img src="//cdn.example.com/icon.png">`;
  assert.deepEqual(htmlReferences(html, '/nested/page.html'), ['/app.css', '/nested/app.js', '/art.webp', '/art.webp', '/art-large.webp', '/index.html']);
  assert.deepEqual(cssReferences('/* url(/missing) */ .x{background:url("../art.webp?v=2")} .y{mask:url(data:image/svg+xml,test)}', '/css/app.css'), ['/art.webp']);
});

test('HTTP API smoke rejects HTML 200 fallbacks, errors and JSON with the wrong shape', () => {
  const valid = body => body?.ok === true;
  assert.throws(() => validateJsonResponse('/api/health', 200, 'text/html', '<html>fallback</html>', 200, valid), /HTML fallback/);
  assert.throws(() => validateJsonResponse('/api/health', 503, 'application/json', '{"ok":true}', 200, valid), /HTTP 503/);
  assert.throws(() => validateJsonResponse('/api/citizen/config', 503, 'application/json', '{"errors":[{"code":"COMPLAINTS_UNAVAILABLE"}]}', 200, valid), /service unavailable.*COMPLAINTS_UNAVAILABLE/);
  assert.throws(() => validateJsonResponse('/api/health', 200, 'application/json', '{', 200, valid), /invalid JSON/);
  assert.throws(() => validateJsonResponse('/api/health', 200, 'application/json', '{"error":"disabled"}', 200, valid), /contract mismatch/);
  assert.doesNotThrow(() => validateJsonResponse('/api/health', 200, 'application/json; charset=utf-8', '{"ok":true}', 200, valid));
});

test('release includes all pages, rendered unique artwork, local linked assets and selectable akim navigation', async () => {
  const result = await checkLocalSurface();
  assert.deepEqual(result.errors, [], result.errors.join('\n'));
});
