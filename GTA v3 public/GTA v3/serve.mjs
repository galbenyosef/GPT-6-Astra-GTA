// Serves the included build using Node.js only. Paths are relative to this file.
import { createServer } from 'node:http';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const browserRequested = args.includes('--open') && !args.includes('--no-open');
const portArgs = args.filter(arg => arg !== '--open' && arg !== '--no-open');
const automaticPort = portArgs.length === 0;
const port = automaticPort ? 5182
  : portArgs.length === 2 && portArgs[0] === '--port' && /^\d+$/.test(portArgs[1]) ? Number(portArgs[1]) : NaN;
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error('Использование: node serve.mjs [--port 5182] [--open] [--no-open]');
  process.exit(1);
}

const types = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'], ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.webp', 'image/webp'],
  ['.ico', 'image/x-icon'], ['.woff2', 'font/woff2'],
]);
const files = new Map();
async function loadBuild(directory, prefix = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const name = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) await loadBuild(join(directory, entry.name), name);
    // Skip links and unknown files; never expose the source or project folder.
    else if (entry.isFile() && types.has(extname(entry.name))) {
      files.set(name, { body: await readFile(join(directory, entry.name)), type: types.get(extname(entry.name)) });
    }
  }
}
try {
  const root = fileURLToPath(new URL('./dist/', import.meta.url));
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid build folder');
  await loadBuild(root);
  if (!files.has('/index.html')) throw new Error('Missing build');
  files.set('/', files.get('/index.html'));
} catch {
  console.error('Не найдена готовая игра в dist. Распакуйте архив целиком и запустите START ещё раз.');
  process.exit(1);
}

const server = createServer((request, response) => {
  const reply = (status, body, type = 'text/plain; charset=utf-8', headers = {}) => {
    response.writeHead(status, {
      'Content-Type': type, 'Content-Length': Buffer.byteLength(body),
      'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache', ...headers,
    });
    response.end(request.method === 'HEAD' ? undefined : body);
  };
  const localPort = server.address().port;
  if (![`127.0.0.1:${localPort}`, `localhost:${localPort}`].includes(request.headers.host)) {
    reply(403, 'Forbidden'); return;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    reply(405, 'Method not allowed', undefined, { Allow: 'GET, HEAD' }); return;
  }
  let pathname;
  try { pathname = decodeURIComponent((request.url ?? '').split('?')[0]); }
  catch { reply(400, 'Bad request'); return; }
  // Exact lookup prevents traversal, alternate streams, and access outside dist.
  const file = files.get(pathname);
  if (!file) { reply(404, 'Not found'); return; }
  reply(200, file.body, file.type);
});
let retriedPort = false;
server.on('error', error => {
  if (error.code === 'EADDRINUSE' && automaticPort && !retriedPort) {
    retriedPort = true;
    server.listen(0, '127.0.0.1');
    return;
  }
  console.error(error.code === 'EADDRINUSE'
    ? 'Этот порт занят. Закройте другой сервер или запустите START без дополнительных параметров.'
    : 'Не удалось запустить локальный сервер. Попробуйте запустить START ещё раз.');
  process.exit(1);
});
server.on('listening', () => {
  const url = `http://127.0.0.1:${server.address().port}/`;
  console.log(`Игра готова: ${url}`);
  console.log('Нажмите Play в браузере. Это окно должно оставаться открытым во время игры.');
  console.log('Чтобы остановить сервер, нажмите Ctrl+C или закройте это окно.');
  if (browserRequested) {
    const command = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? '/usr/bin/open' : 'xdg-open';
    const parameters = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
    const browser = spawn(command, parameters, { stdio: 'ignore', windowsHide: true });
    const manualOpen = () => console.log(`Если браузер не открылся, откройте этот адрес вручную: ${url}`);
    browser.on('error', manualOpen);
    browser.on('exit', code => { if (code && code !== 0) manualOpen(); });
    browser.unref();
  }
});
server.listen(port, '127.0.0.1');
