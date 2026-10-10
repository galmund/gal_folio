// Regenerates every app icon in web/ from the vector design below.
// Rasterising uses headless Chrome (no npm deps); override with CHROME_PATH.
//
//   npm run icons

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const S = 1024;

function squirclePath(size, n = 5, steps = 240) {
  const r = size / 2;
  const pts = [];
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * 2 * Math.PI;
    const c = Math.cos(t), s = Math.sin(t);
    const x = r + r * Math.sign(c) * Math.abs(c) ** (2 / n);
    const y = r + r * Math.sign(s) * Math.abs(s) ** (2 / n);
    pts.push(`${x.toFixed(1)} ${y.toFixed(1)}`);
  }
  return `M${pts.join('L')}Z`;
}

// `squircle`: shaped icon with transparent corners (favicon, in-app logo, PWA "any").
// Otherwise full-bleed: iOS and maskable PWA hosts apply their own mask, and iOS
// fills any transparency with black, so those must be opaque squares.
function iconSvg({ squircle }) {
  const shape = squirclePath(S);
  const line = 'M232 688 L420 500 L566 610 L792 334';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0.35" y2="1">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="0.6" stop-color="#f4f6f9"/>
      <stop offset="1" stop-color="#e3e8ef"/>
    </linearGradient>
    <radialGradient id="sheen" cx="0.5" cy="0" r="0.75">
      <stop offset="0" stop-color="#fff" stop-opacity="0.16"/>
      <stop offset="1" stop-color="#fff" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="stroke" x1="0" y1="1" x2="1" y2="0">
      <stop offset="0" stop-color="#1f9e45"/>
      <stop offset="1" stop-color="#34c759"/>
    </linearGradient>
    <linearGradient id="area" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#34c759" stop-opacity="0.22"/>
      <stop offset="1" stop-color="#4ade6e" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="fade" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#fff" stop-opacity="0.2"/>
      <stop offset="0.55" stop-color="#fff" stop-opacity="1"/>
      <stop offset="1" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
    <mask id="areaMask"><rect x="232" y="300" width="560" height="500" fill="url(#fade)"/></mask>
    <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="14" stdDeviation="16" flood-color="#0b3d1c" flood-opacity="0.22"/>
    </filter>${squircle ? `
    <clipPath id="clip"><path d="${shape}"/></clipPath>` : ''}
  </defs>
  <g${squircle ? ' clip-path="url(#clip)"' : ''}>
    <rect width="${S}" height="${S}" fill="url(#bg)"/>
    <rect width="${S}" height="${S}" fill="url(#sheen)"/>
    <path d="${line} L792 800 L232 800 Z" fill="url(#area)" mask="url(#areaMask)"/>
    <path d="${line}" fill="none" stroke="url(#stroke)" stroke-width="84" stroke-linecap="round" stroke-linejoin="round" filter="url(#glow)"/>
  </g>${squircle ? `
  <path d="${shape}" fill="none" stroke="rgba(0,0,0,0.1)" stroke-width="1" vector-effect="non-scaling-stroke"/>` : ''}
</svg>
`;
}

// Recent headless Chrome writes the screenshot but doesn't always exit, so wait
// for the file to land and then kill it.
async function rasterise(svg, size, out, dir) {
  const html = path.join(dir, `r${size}.html`);
  writeFileSync(html, `<!doctype html><style>html,body{margin:0;background:transparent}img{display:block;width:${size}px;height:${size}px}</style><img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}">`);
  rmSync(out, { force: true });
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
    '--default-background-color=00000000', `--window-size=${size},${size}`,
    `--user-data-dir=${path.join(dir, `profile${size}`)}`, `--screenshot=${out}`, `file://${html}`,
  ], { stdio: 'ignore' });
  try {
    for (let waited = 0; waited < 30000; waited += 100) {
      await new Promise((r) => setTimeout(r, 100));
      if (existsSync(out) && statSync(out).size > 0) {
        await new Promise((r) => setTimeout(r, 300));
        return readFileSync(out);
      }
      if (chrome.exitCode !== null) break;
    }
    throw new Error(`Chrome did not produce ${out}`);
  } finally {
    chrome.kill('SIGKILL');
  }
}

// ICO files may embed PNG payloads directly (supported by every current browser).
function buildIco(images) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, png }, i) => {
    const e = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, e);
    header.writeUInt8(size >= 256 ? 0 : size, e + 1);
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(png.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map((i) => i.png)]);
}

const shaped = iconSvg({ squircle: true });
const fullBleed = iconSvg({ squircle: false });
writeFileSync(path.join(WEB, 'icon.svg'), shaped);

const tmp = mkdtempSync(path.join(tmpdir(), 'icons-'));
try {
  await rasterise(fullBleed, 180, path.join(WEB, 'apple-touch-icon.png'), tmp);
  await rasterise(shaped, 192, path.join(WEB, 'icon-192.png'), tmp);
  await rasterise(shaped, 512, path.join(WEB, 'icon-512.png'), tmp);
  await rasterise(fullBleed, 512, path.join(WEB, 'icon-maskable-512.png'), tmp);
  const ico = [];
  for (const size of [16, 32, 48]) ico.push({ size, png: await rasterise(shaped, size, path.join(tmp, `f${size}.png`), tmp) });
  writeFileSync(path.join(WEB, 'favicon.ico'), buildIco(ico));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log('Icons written to', WEB);
