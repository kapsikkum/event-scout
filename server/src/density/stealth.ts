/**
 * Make a headless browser stop announcing that it is one.
 *
 * Google serves a stripped "limited view" of Maps to clients it suspects, with
 * the popular-times panel missing entirely — which reads as "this venue has no
 * data" rather than as a block, so the failure is silent. The user agent alone
 * is not enough: a browser can claim to be Edge on Windows and still be given
 * away by the renderer string, an odd window size, or a timezone that
 * contradicts the language it asked for.
 *
 * What this cannot do is make detection impossible. Anything that runs in the
 * page can be checked against something that does not, and a determined
 * fingerprinter has more surface than any fixed script covers. This closes the
 * signals that are both well known and cheap to close; treat a sudden run of
 * empty results as a sign the arms race moved rather than as a bug here.
 */

/** A GPU that a Windows machine plausibly has, in ANGLE's exact phrasing. */
const WEBGL_VENDOR = 'Google Inc. (NVIDIA)';
const WEBGL_RENDERER =
  'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002504) Direct3D11 vs_5_0 ps_5_0, D3D11)';

/**
 * Runs before any page script, in every frame.
 *
 * Written as a string because it is evaluated in the page, not here — it has
 * no access to anything in this module's scope.
 */
export const STEALTH_SCRIPT = `
(() => {
  const hide = (obj, prop, value) => {
    try {
      Object.defineProperty(obj, prop, { get: () => value, configurable: true });
    } catch { /* already locked down */ }
  };

  // The single most checked property. Automation sets it to true; a browser
  // nobody is driving does not define it at all.
  try { delete Object.getPrototypeOf(navigator).webdriver; } catch { /* ignore */ }
  hide(navigator, 'webdriver', undefined);

  // Headless reports a software rasteriser — SwiftShader on Linux, "Microsoft
  // Basic Render Driver" on Windows. Both mean "no real GPU", which no
  // ordinary desktop reports.
  const patchGl = (proto) => {
    if (!proto) return;
    const original = proto.getParameter;
    proto.getParameter = function (parameter) {
      if (parameter === 37445) return ${JSON.stringify(WEBGL_VENDOR)};
      if (parameter === 37446) return ${JSON.stringify(WEBGL_RENDERER)};
      return original.apply(this, arguments);
    };
  };
  patchGl(window.WebGLRenderingContext && WebGLRenderingContext.prototype);
  patchGl(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype);

  // Real Chrome exposes this object; the headless shell does not. Only the
  // shape is needed — nothing checks that it works.
  if (!window.chrome) window.chrome = {};
  if (!window.chrome.runtime) window.chrome.runtime = {};
  if (!window.chrome.csi) window.chrome.csi = () => ({});
  if (!window.chrome.loadTimes) window.chrome.loadTimes = () => ({});

  // Notification.permission answering "denied" while permissions.query says
  // "prompt" is a contradiction only automation produces.
  try {
    const query = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = (params) =>
      params && params.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission, onchange: null })
        : query(params);
  } catch { /* no permissions API */ }

  // An empty plugin list is the classic old-headless tell. Modern Chrome
  // reports five PDF entries, so only fill in when they are missing.
  if (navigator.plugins && navigator.plugins.length === 0) {
    const names = ['PDF Viewer', 'Chrome PDF Viewer', 'Chromium PDF Viewer',
                   'Microsoft Edge PDF Viewer', 'WebKit built-in PDF'];
    hide(navigator, 'plugins', names.map((name) => ({ name, filename: 'internal-pdf-viewer' })));
  }
  if (navigator.languages && navigator.languages.length === 0) {
    hide(navigator, 'languages', ['en-AU', 'en-US', 'en']);
  }

  // A machine with 1 core and no reported memory is a container, not a desktop.
  if (navigator.hardwareConcurrency < 4) hide(navigator, 'hardwareConcurrency', 8);
  if (!navigator.deviceMemory) hide(navigator, 'deviceMemory', 8);
})();
`;

/**
 * Command-line switches that keep the browser from flagging itself before any
 * page script gets a chance to run. Shared by the local launcher and the
 * container, which is why they live here rather than in either.
 */
export const STEALTH_ARGS = [
  // Without this the browser sets navigator.webdriver as soon as a debugger
  // attaches, and no amount of patching in the page is as clean as never
  // having set it.
  '--disable-blink-features=AutomationControlled',
  '--disable-infobars',
  '--no-default-browser-check',
  '--no-first-run',
  '--disable-features=Translate,AutomationControlled',
];

/** A window size an actual person might have, rather than the headless default. */
export const WINDOW_SIZE = { width: 1280, height: 900 };
