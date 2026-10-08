import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../src/api/server.js', import.meta.url), 'utf8');
const start = source.indexOf('async function sendPublic');
const end = source.indexOf("app.get('/'", start);
const publicDir = new URL('../public/', import.meta.url).pathname;
const sendPublic = vm.runInNewContext(`${source.slice(start, end)}; sendPublic`, { fs, path, publicDir });

test('固定 URL 的 HTML、JS 和 CSS 每次使用前需重新验证', async () => {
  for (const [file, type, expected] of [
    ['index.html', 'text/html', 'no-cache'],
    ['app.js', 'text/javascript', 'no-cache'],
    ['styles.css', 'text/css', 'no-cache'],
    ['logo.png', 'image/png', 'public, max-age=3600, must-revalidate'],
  ]) {
    const headers = new Map();
    const reply = {
      header(name, value) { headers.set(name, value); return this; },
      type(value) { headers.set('Content-Type', value); return this; },
      send(body) { return body; },
    };
    const body = await sendPublic(reply, file, type);
    assert.equal(headers.get('Cache-Control'), expected, file);
    assert.equal(headers.get('Content-Type'), type);
    assert.deepEqual(body, await fs.readFile(path.join(publicDir, file)));
  }
});
