'use strict';

const { app, BrowserWindow, session, shell } = require('electron');
const path = require('path');
const fs = require('fs');

// `electron . --diag` records a performance trace to diagnostics.log so we can
// see exactly what stalls the renderer during the hit/get-hit freeze.
// (Avoid the name `--debug`: Electron reserves it as a Node inspector flag.)
const DEBUG = process.argv.includes('--diag');

// ----------------------------------------------------------------------------
// App identity
// ----------------------------------------------------------------------------
app.setName('Blocked Client');
app.setAppUserModelId('com.blocked.client'); // Windows taskbar / notification identity

const ICON = path.join(__dirname, 'blockedIcon.ico');
const GAME_URL = 'https://bloxd.io';

// ----------------------------------------------------------------------------
// GPU / performance command-line switches.
// These MUST be applied before the `ready` event, so they live at module top.
// Anything Chromium doesn't recognise is silently ignored, so this is safe.
// ----------------------------------------------------------------------------
// The default config mirrors a normal browser's GPU pipeline — which you
// confirmed runs bloxd smoothly. The aggressive FPS-uncapping flags are the
// cause of the hit/get-hit stutter (they leave the GPU no headroom to absorb
// the extra draw work each hit submits), so they're opt-in via `--uncap`.
const SWITCHES = [
  // Force hardware acceleration on, even if the GPU is on Chromium's blocklist.
  ['ignore-gpu-blocklist'],
  ['enable-gpu-rasterization'], // on by default in Chrome; kept explicit

  // Keep rendering at full speed even when the window is covered or unfocused.
  ['disable-features', 'CalculateNativeWinOcclusion'],

  // Smoother GC behaviour for a long-running WebGL session.
  ['js-flags', '--max-semi-space-size=128'],
];

// Opt-in raw-FPS mode: `electron . --uncap` (or `npm run uncap`).
// Uncapping pushes the FPS number up but removes the vsync headroom that lets
// the GPU absorb per-hit draw spikes — i.e. it brings back the freeze. Leave it
// off for smooth combat; turn it on only if you prefer the higher number.
if (process.argv.includes('--uncap')) {
  SWITCHES.push(
    ['disable-frame-rate-limit'],
    ['disable-gpu-vsync'],
    ['enable-zero-copy'],
  );
}

for (const [key, value] of SWITCHES) {
  if (value === undefined) app.commandLine.appendSwitch(key);
  else app.commandLine.appendSwitch(key, value);
}

// One window only; reuse the running instance instead of spawning more.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

// ----------------------------------------------------------------------------
// URL helpers
// ----------------------------------------------------------------------------
function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}

function hostMatches(host, list) {
  return list.some((d) => host === d || host.endsWith('.' + d));
}

function isBloxd(url) {
  return hostMatches(hostOf(url), ['bloxd.io']);
}

// OAuth / login providers whose popups & redirects must be allowed to run
// inside the app (otherwise sign-in windows get bounced to the browser and
// can't post the result back to the game).
const AUTH_HOSTS = [
  // Google
  'accounts.google.com', 'accounts.youtube.com', 'oauth2.googleapis.com',
  'content.googleapis.com', 'apis.google.com', 'ssl.gstatic.com',
  // Apple
  'appleid.apple.com', 'idmsa.apple.com', 'apple.com',
  // Microsoft
  'login.microsoftonline.com', 'login.live.com', 'login.microsoft.com',
  'account.live.com', 'account.microsoft.com',
  // Discord
  'discord.com', 'discordapp.com',
  // Firebase (bloxd's sign-in is brokered through Firebase Auth handlers)
  'firebaseapp.com', 'web.app', 'identitytoolkit.googleapis.com',
  'securetoken.googleapis.com',
];

function isAuthUrl(url) {
  return hostMatches(hostOf(url), AUTH_HOSTS);
}

// ----------------------------------------------------------------------------
// Ad / tracker blocklist — cancelled at the network layer before they load.
// ----------------------------------------------------------------------------
const AD_HOSTS = [
  // Google ad stack
  'googlesyndication.com', 'googleadservices.com', 'doubleclick.net',
  'adservice.google.com', '2mdn.net', 'imasdk.googleapis.com',
  'googletagservices.com', 'googletagmanager.com', 'google-analytics.com',
  // Game / .io ad networks
  'adinplay.com', 'venatusmedia.com', 'playwire.com', 'aniview.com',
  'gamemonetize.com', 'gamedistribution.com',
  // Programmatic / RTB networks
  'amazon-adsystem.com', 'adnxs.com', 'pubmatic.com', 'rubiconproject.com',
  'openx.net', 'criteo.com', 'criteo.net', 'casalemedia.com', 'contextweb.com',
  'smartadserver.com', '3lift.com', 'sharethrough.com', 'adform.net',
  'yieldmo.com', 'indexww.com', 'bidswitch.net', 'taboola.com', 'outbrain.com',
  // Ad verification / measurement
  'adsafeprotected.com', 'moatads.com', 'scorecardresearch.com',
];

function installAdBlocker() {
  const filter = { urls: AD_HOSTS.flatMap((d) => [`*://${d}/*`, `*://*.${d}/*`]) };
  session.defaultSession.webRequest.onBeforeRequest(filter, (_details, cb) => {
    cb({ cancel: true });
  });
}

// In-page ad elements the game renders itself (substring match also catches
// hashed CSS-module variants like `AdBanner_x1y2z`). Hidden via injected CSS,
// which keeps applying to elements added after the page loads.
const AD_CSS = `
  [class*="AdBanner"],
  [class*="SuperRankAdInner"],
  [class*="ShopBannerDiv"] { display: none !important; }
`;

// ----------------------------------------------------------------------------
// Behaviour shared by the main window and any auth popups it spawns.
// ----------------------------------------------------------------------------
app.on('web-contents-created', (_event, contents) => {
  // Let login popups open in-app; send everything else to the system browser.
  contents.setWindowOpenHandler(({ url }) => {
    if (isAuthUrl(url) || isBloxd(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 520,
          height: 680,
          autoHideMenuBar: true,
          backgroundColor: '#000000',
          icon: ICON,
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
          },
        },
      };
    }
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // Keep the game window on bloxd.io; allow auth redirects; bounce the rest.
  contents.on('will-navigate', (event, url) => {
    if (!isBloxd(url) && !isAuthUrl(url)) {
      event.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });

  // Alt+F4 quits the whole application, even while the game has key focus.
  contents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.alt && input.key === 'F4') {
      event.preventDefault();
      app.quit();
    }
  });
});

// ----------------------------------------------------------------------------
// Performance diagnostics (only with `--debug`).
//
// Injected into the page's main world. It records, with a monotonic timestamp:
//   JANK <ms>            a frame that took too long — the freeze itself
//   LONGTASK <ms>        a JS task that blocked the main thread
//   SHADER_COMPILE/LINK  GPU shader work (lazy effect compilation stalls)
//   AUDIO_DECODE <ms>    decoding a sound buffer
//   SFX / MEDIA_PLAY     a sound was triggered (lines up with hits)
//   FETCH / FETCH_FAIL   slow or blocked network calls
// Correlating what appears right before each JANK tells us the cause.
// ----------------------------------------------------------------------------
const DIAG_LOG = path.join(__dirname, 'diagnostics.log');

const DIAG_SCRIPT = `(() => {
  if (window.__bcDiag) return;
  const buf = window.__bcDiag = [];
  const now = () => Math.round(performance.now());
  const push = (type, val) => { buf.push(now() + ' ' + type + (val === undefined ? '' : ' ' + val)); if (buf.length > 8000) buf.shift(); };

  // The freeze itself: frames longer than ~50ms.
  let last = performance.now();
  (function tick(){ const t = performance.now(); const dt = t - last; last = t; if (dt > 50) push('JANK', Math.round(dt)); requestAnimationFrame(tick); })();

  // Main-thread blocking tasks.
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) if (e.duration > 40) push('LONGTASK', Math.round(e.duration)); }).observe({ entryTypes: ['longtask'] }); } catch (e) {}

  // GPU shader compile/link stalls (lazily compiled hit effects).
  [window.WebGLRenderingContext, window.WebGL2RenderingContext].forEach(G => { if (!G) return;
    ['compileShader','linkProgram'].forEach(fn => { const o = G.prototype[fn]; if (!o) return;
      G.prototype[fn] = function(){ const t = performance.now(); const r = o.apply(this, arguments); const d = performance.now() - t; if (d > 3) push(fn === 'linkProgram' ? 'SHADER_LINK' : 'SHADER_COMPILE', Math.round(d)); return r; }; });
  });

  // Audio: decode cost + every SFX trigger (hit sounds).
  if (window.AudioContext) { const d = AudioContext.prototype.decodeAudioData; AudioContext.prototype.decodeAudioData = function(){ const t = performance.now(); const r = d.apply(this, arguments); if (r && r.then) r.then(() => push('AUDIO_DECODE', Math.round(performance.now() - t))); return r; }; }
  if (window.AudioBufferSourceNode) { const s = AudioBufferSourceNode.prototype.start; AudioBufferSourceNode.prototype.start = function(){ push('SFX'); return s.apply(this, arguments); }; }
  if (window.HTMLMediaElement) { const p = HTMLMediaElement.prototype.play; HTMLMediaElement.prototype.play = function(){ push('MEDIA_PLAY'); return p.apply(this, arguments); }; }

  // Network calls: slow ones, and anything that fails (e.g. blocked by adblock).
  const f = window.fetch; if (f) window.fetch = function(){ const t = performance.now(); const raw = String(arguments[0]); const u = raw.slice(0, 90); const skip = raw.startsWith('data:') || raw.startsWith('blob:');
    return f.apply(this, arguments).then(r => { const dd = performance.now() - t; if (dd > 40 && !skip) push('FETCH', Math.round(dd) + ' ' + u); return r; }, e => { if (!skip) push('FETCH_FAIL', Math.round(performance.now() - t) + ' ' + u); throw e; }); };

  push('DIAG_READY');
})();`;

// Drains the in-page buffer to disk once a second.
const DIAG_DRAIN = '(function(){var d=window.__bcDiag||[];var s=JSON.stringify(d);if(window.__bcDiag)window.__bcDiag.length=0;return s;})()';

function startDiagnostics(win) {
  fs.writeFileSync(DIAG_LOG, '# Blocked Client diagnostics - ' + new Date().toISOString() + '\n# t(ms) EVENT [detail]\n');
  win.webContents.on('dom-ready', () => win.webContents.executeJavaScript(DIAG_SCRIPT).catch(() => {}));
  const timer = setInterval(async () => {
    if (win.isDestroyed()) return clearInterval(timer);
    try {
      const arr = JSON.parse(await win.webContents.executeJavaScript(DIAG_DRAIN));
      if (arr.length) fs.appendFileSync(DIAG_LOG, arr.join('\n') + '\n');
    } catch (e) {}
  }, 1000);
  win.on('closed', () => clearInterval(timer));
  console.log('[Blocked Client] diagnostics -> ' + DIAG_LOG);
}

// ----------------------------------------------------------------------------
// Main window
// ----------------------------------------------------------------------------
function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 720,
    show: false,
    title: 'Blocked Client',
    icon: ICON,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    webPreferences: {
      backgroundThrottling: false, // never throttle when unfocused
      spellcheck: false,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      v8CacheOptions: 'code',
    },
  });

  // Keep our title; don't let the page rename the window.
  win.on('page-title-updated', (e) => {
    e.preventDefault();
    win.setTitle('Blocked Client');
  });

  // Hide the game's own in-page ad elements once the DOM is available.
  win.webContents.on('dom-ready', () => win.webContents.insertCSS(AD_CSS));

  // bloxd registers a `beforeunload` handler that otherwise silently cancels
  // the window close — this is why Alt+F4 and the X button don't work.
  // Ignoring it lets the window (and app) actually close.
  win.webContents.on('will-prevent-unload', (e) => e.preventDefault());

  if (DEBUG) startDiagnostics(win);

  win.maximize();
  win.once('ready-to-show', () => win.show());
  win.loadURL(GAME_URL);
}

app.on('second-instance', () => {
  const [win] = BrowserWindow.getAllWindows();
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.whenReady().then(() => {
  installAdBlocker();
  createWindow();
});

app.on('window-all-closed', () => app.quit());
