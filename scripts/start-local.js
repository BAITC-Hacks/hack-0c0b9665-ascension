import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Always resolve configuration, assets and data relative to this checkout.
process.chdir(fileURLToPath(new URL('../', import.meta.url)));

if (Number(process.versions.node.split('.')[0]) < 24) {
  console.error('Install Node.js 24 or newer from https://nodejs.org/ (current: ' + process.version + ').');
  process.exit(1);
}

try {
  process.loadEnvFile('.env.local');
} catch (error) {
  if (error.code !== 'ENOENT') {
    console.error('Cannot read .env.local. Check its permissions and format.');
    process.exit(1);
  }
}

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error('PORT must be an integer from 0 to 65535. Set PORT=3100 in .env.local to use another port.');
  process.exit(1);
}

// This shortcut is for a local review. npm start and Compose support server hosting.
const host = '127.0.0.1';
process.env.HOST = host;
const { resolveAIConfiguration } = await import('../src/ai/provider.js');
const { createAppServer } = await import('../src/server.js');
const server = createAppServer();
server.once('error', error => {
  console.error(error.code === 'EADDRINUSE'
    ? `Port ${port} is in use. Stop the previous server or set PORT=3100 in .env.local and try again.`
    : 'Cannot start the local server. Check the port and access to the project folder.');
  process.exitCode = 1;
});
server.listen(port, host, () => {
  const base = `http://${host}:${server.address().port}`;
  console.log(`\nAscension is ready: ${base}/`);
  console.log(`Simulator:          ${base}/classic.html`);
  console.log(`Citizen requests:   ${base}/citizens.html`);
  console.log(`Mayor panel:        ${base}/mayor.html`);
  console.log(`Health:             ${base}/api/health`);
  console.log('Keep this window open. Press Ctrl+C to stop.');
  if (!resolveAIConfiguration({}, process.env).configured) {
    console.log('No AI key configured: calculations and requests work; explanations use the calculation rules.');
  }
  if (process.argv.includes('--no-open')) return;
  const command = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const browser = spawn(command, [base + '/'], { stdio: 'ignore', windowsHide: true });
  browser.once('error', () => console.log(`Open ${base}/ in your browser.`));
  browser.unref();
});

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    server.close(() => process.exit(0));
    server.closeAllConnections();
    setTimeout(() => process.exit(1), 5000).unref();
  });
}
