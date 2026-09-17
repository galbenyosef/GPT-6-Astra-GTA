import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

let child;
let port;
before(async () => {
  child = spawn(process.execPath, [fileURLToPath(new URL('../serve.mjs', import.meta.url)), '--port', '0'], {
    cwd: tmpdir(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  port = await new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error('Server startup timed out')), 10000);
    child.once('error', reject);
    child.once('exit', () => { clearTimeout(timeout); reject(new Error('Server exited before startup')); });
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/127\.0\.0\.1:(\d+)/);
      if (match) { clearTimeout(timeout); resolve(Number(match[1])); }
    });
  });
});
after(async () => {
  if (child && child.exitCode === null) {
    await new Promise(resolve => { child.once('exit', resolve); child.kill(); });
  }
});
const get = (path, options = {}) => new Promise((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port, path, ...options }, response => {
    const chunks = [];
    response.on('data', chunk => chunks.push(chunk));
    response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
  });
  req.on('error', reject); req.end();
});

test('built game starts from another working directory and serves exact build bytes', async () => {
  const response = await get('/');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, await readFile(new URL('../dist/index.html', import.meta.url)));
  const assets = [...response.body.toString().matchAll(/(?:src|href)="(\/[^"?]+)"/g)].map(match => match[1]);
  assert.ok(assets.some(asset => asset.endsWith('.js')));
  for (const asset of assets) {
    const result = await get(asset);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, await readFile(new URL(`../dist${asset}`, import.meta.url)));
    assert.equal(result.headers['x-content-type-options'], 'nosniff');
  }
});
test('source, configuration, hidden files and traversal cannot be downloaded', async () => {
  for (const path of ['/package.json', '/package-lock.json', '/src/ui/App.tsx', '/serve.mjs', '/.env', '/.git/config',
    '/../package.json', '/%2e%2e/package.json', '/assets/../../package.json', '/%2e%2e%5cpackage.json',
    '/%252e%252e/package.json', '/index.html:stream', '/index.html%00', '/assets/']) {
    assert.equal((await get(path)).status, 404, path);
  }
});
test('malformed URL produces a generic error without crashing the server', async () => {
  assert.equal((await get('/%ZZ')).status, 400);
  assert.equal((await get('/')).status, 200);
});
test('HEAD works and query parameters do not change the document', async () => {
  const head = await get('/', { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(head.body.length, 0);
  assert.deepEqual((await get('/?launch=1')).body, (await get('/')).body);
});
test('write methods and non-local Host headers are rejected', async () => {
  assert.equal((await get('/', { method: 'POST' })).status, 405);
  assert.equal((await get('/', { headers: { Host: 'example.invalid' } })).status, 403);
  assert.equal((await get('/', { headers: { Host: `localhost:${port}` } })).status, 200);
});

test('default startup chooses a free port when the usual port is occupied', async () => {
  const blocker = createServer((_, response) => response.end('Occupied'));
  await new Promise((resolve, reject) => {
    blocker.once('error', error => error.code === 'EADDRINUSE' ? resolve() : reject(error));
    blocker.listen(5182, '127.0.0.1', resolve);
  });
  const fallback = spawn(process.execPath, [fileURLToPath(new URL('../serve.mjs', import.meta.url)), '--open', '--no-open'], {
    cwd: tmpdir(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const fallbackPort = await new Promise((resolve, reject) => {
      let output = '';
      const timeout = setTimeout(() => reject(new Error('Fallback startup timed out')), 10000);
      fallback.once('error', error => { clearTimeout(timeout); reject(error); });
      fallback.once('exit', () => { clearTimeout(timeout); reject(new Error('Fallback server exited')); });
      fallback.stdout.on('data', chunk => {
        output += chunk;
        const match = output.match(/127\.0\.0\.1:(\d+)/);
        if (match) { clearTimeout(timeout); resolve(Number(match[1])); }
      });
    });
    assert.notEqual(fallbackPort, 5182);
    const response = await get('/', { port: fallbackPort });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, await readFile(new URL('../dist/index.html', import.meta.url)));
  } finally {
    if (fallback.exitCode === null) await new Promise(resolve => { fallback.once('exit', resolve); fallback.kill(); });
    if (blocker.listening) await new Promise(resolve => blocker.close(resolve));
  }
});

test('an explicitly requested occupied port fails clearly without opening another game', async () => {
  const duplicate = spawn(process.execPath, [fileURLToPath(new URL('../serve.mjs', import.meta.url)), '--port', String(port)], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  duplicate.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => { duplicate.once('exit', resolve); duplicate.once('error', reject); });
  assert.equal(code, 1);
  assert.ok(stderr.includes('порт занят'));
  assert.equal((await get('/')).status, 200);
});
