#!/usr/bin/env node
// Checks the production globe in headless Chrome, with the app's CSP and a
// fake Tauri IPC (mock-ipc.js):
//
// - an idle globe runs no animation frames and no WebGL draws
// - camera moves the app makes (start view, following a trace, selecting a
//   hop, exports) request no online tile, also when the window grows later;
//   a zoom the user makes does
// - a drag during a WebM export does not move the globe
// - exports write files, no page errors, no request leaves the machine
//
//   npm run build
//   node scripts/globe-check/check.mjs [output dir]
//
// Needs Node.js 22.4 or later (global WebSocket).
// CHROME=/path/to/chrome selects the browser (default: Google Chrome on
// macOS). Screenshots and the browser profile go to the output dir (default:
// a new temp dir). Exits 1 when a check fails. Not part of CI: it needs a
// browser with WebGL.

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const dist = path.join(repo, "dist", "renderer");
const chromePath =
  process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

function exitWith(message) {
  console.error(message);
  process.exit(2);
}

if (!fs.existsSync(path.join(dist, "index.html"))) {
  exitWith("dist/renderer is missing: run `npm run build` first.");
}
if (typeof WebSocket !== "function") {
  exitWith("This check needs Node.js 22.4 or later (global WebSocket).");
}
if (!fs.existsSync(chromePath)) {
  exitWith(`No browser at ${chromePath}. Set CHROME to a Chrome or Chromium binary.`);
}
const outDir = process.argv[2]
  ? path.resolve(process.argv[2])
  : fs.mkdtempSync(path.join(os.tmpdir(), "vistracer-globe-check-"));
fs.mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The production CSP from tauri.conf.json, sent with the page.
const conf = JSON.parse(fs.readFileSync(path.join(repo, "src-tauri", "tauri.conf.json"), "utf8"));
const csp = Object.entries(conf.app.security.csp)
  .map(([directive, value]) => `${directive} ${value}`)
  .join("; ");
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".geojson": "application/json"
};
const server = http.createServer((request, response) => {
  const url = new URL(request.url, "http://localhost");
  const file = path.join(
    dist,
    url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname)
  );
  if (
    !file.startsWith(dist + path.sep) ||
    !fs.existsSync(file) ||
    fs.statSync(file).isDirectory()
  ) {
    response.writeHead(404);
    response.end();
    return;
  }
  const headers = { "Content-Type": types[path.extname(file)] ?? "application/octet-stream" };
  if (path.extname(file) === ".html") {
    headers["Content-Security-Policy"] = csp;
  }
  response.writeHead(200, headers);
  fs.createReadStream(file).pipe(response);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const appUrl = `http://127.0.0.1:${server.address().port}/`;

const profile = path.join(outDir, "chrome-profile");
fs.rmSync(profile, { recursive: true, force: true });
const chrome = spawn(
  chromePath,
  [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--enable-unsafe-swiftshader",
    "--hide-scrollbars",
    "about:blank"
  ],
  { stdio: "ignore" }
);
let debuggerUrl;
for (let i = 0; i < 100 && !debuggerUrl; i += 1) {
  await sleep(100);
  const portFile = path.join(profile, "DevToolsActivePort");
  if (fs.existsSync(portFile)) {
    const [port] = fs.readFileSync(portFile, "utf8").split("\n");
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    debuggerUrl = targets.find((target) => target.type === "page")?.webSocketDebuggerUrl;
  }
}
if (!debuggerUrl) {
  chrome.kill();
  server.close();
  exitWith("Chrome did not start with remote debugging.");
}

const socket = new WebSocket(debuggerUrl);
await new Promise((resolve) => socket.addEventListener("open", resolve));
let sequence = 0;
const pending = new Map();
const events = [];
socket.addEventListener("message", (message) => {
  const data = JSON.parse(message.data);
  if (data.id && pending.has(data.id)) {
    pending.get(data.id)(data);
    pending.delete(data.id);
  } else if (data.method) {
    events.push(data);
  }
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, (data) =>
      data.error ? reject(new Error(`${method}: ${data.error.message}`)) : resolve(data.result)
    );
    socket.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  const result = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  }
  return result.result.value;
};
const screenshot = async (name) => {
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(outDir, `${name}.png`), Buffer.from(data, "base64"));
};
const mouse = (type, x, y, extra = {}) =>
  send("Input.dispatchMouseEvent", { type, x, y, ...extra });
const counters = () =>
  evaluate("({ ...window.__globeCheck, onlineTiles: window.__globeCheck.onlineTiles.length })");
const centre = () =>
  evaluate(`(() => {
    const rect = document.querySelector('.globe-viewport canvas').getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);

const results = [];
const check = (name, ok, detail) => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `: ${detail}` : ""}`);
};

/** Waits for flights and tile loads to end and the render loop to sleep. */
const settle = () => sleep(4000);
const idleWindow = async (name) => {
  const before = await counters();
  await sleep(5000);
  const after = await counters();
  const frames = after.raf - before.raf;
  const draws = after.draws - before.draws;
  check(
    `idle globe draws nothing (${name})`,
    frames === 0 && draws === 0,
    `${frames} animation frames, ${draws} WebGL draws in 5 s`
  );
};
/** Online tile requests made while `action` runs and the globe settles. */
const tilesDuring = async (action) => {
  const before = (await counters()).onlineTiles;
  await action();
  await settle();
  return (await counters()).onlineTiles - before;
};
const runTrace = async (target, hopCount) => {
  await evaluate(`(() => {
    const input = document.querySelector('input[aria-label="Traceroute target"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(target)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.form.requestSubmit();
  })()`);
  await sleep(hopCount * 400 + 1000);
};
const clickRow = (text) =>
  evaluate(
    `[...document.querySelectorAll('.hop-details__row')].find((row) => row.textContent.includes(${JSON.stringify(text)})).click()`
  );
const userZoom = async () => {
  const { x, y } = await centre();
  for (let i = 0; i < 3; i += 1) {
    await mouse("mouseWheel", x, y, { deltaX: 0, deltaY: -300 });
    await sleep(150);
  }
};

try {
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Network.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 713,
    deviceScaleFactor: 2,
    mobile: false
  });
  await send("Page.addScriptToEvaluateOnNewDocument", {
    source: fs.readFileSync(path.join(here, "mock-ipc.js"), "utf8")
  });
  await send("Page.navigate", { url: appUrl });
  await sleep(6000);

  check(
    "globe canvas exists",
    await evaluate("Boolean(document.querySelector('.globe-viewport canvas'))")
  );
  check("start view requests no online tile", (await counters()).onlineTiles === 0);
  await idleWindow("start view");
  await screenshot("01-start");

  const followFromStart = await tilesDuring(() => runTrace("example.com", 7));
  check(
    "following a trace from the start view requests no online tile",
    followFromStart === 0,
    `${followFromStart} requests`
  );
  await idleWindow("after a trace");
  await screenshot("02-trace");

  const zoom = await tilesDuring(userZoom);
  check("a zoom the user makes requests online tiles", zoom > 0, `${zoom} requests`);
  await screenshot("03-user-zoom");

  const select = await tilesDuring(() => clickRow("80.81.192.96"));
  check(
    "selecting a hop from a zoomed-in view requests no online tile",
    select === 0,
    `${select} requests`
  );
  await screenshot("04-selected-hop");

  await tilesDuring(userZoom);
  const followZoomedIn = await tilesDuring(() => runTrace("8.8.8.8", 4));
  check(
    "following a trace from a zoomed-in view requests no online tile",
    followZoomedIn === 0,
    `${followZoomedIn} requests`
  );
  await clickRow("8.8.8.8");
  await settle();
  await screenshot("05-anycast-reach");

  const downloads = path.join(outDir, "downloads");
  fs.rmSync(downloads, { recursive: true, force: true });
  fs.mkdirSync(downloads, { recursive: true });
  await send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads });
  await tilesDuring(userZoom);
  const exportButton = () =>
    evaluate(
      `[...document.querySelectorAll('button')].find((b) => /Download export|Exporting/.test(b.textContent))?.textContent ?? ""`
    );
  const startExport = async (format, dwellSeconds) => {
    await evaluate(
      `[...document.querySelectorAll('button')].find((b) => b.textContent.includes('Download export')).click()`
    );
    await sleep(500);
    await evaluate(`document.querySelector('input[type=radio][value="${format}"]').click()`);
    await sleep(300);
    if (dwellSeconds) {
      await evaluate(`(() => {
        const dwell = document.querySelector('#export-modal__dwell');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(dwell, '${dwellSeconds}');
        dwell.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await sleep(200);
    }
    await evaluate(`[...document.querySelectorAll('.export-modal button')].at(-1).click()`);
  };
  // Waits for the footer's "Saved <file>" message.
  const exportSaved = async (extension, timeoutMs) => {
    for (let waited = 0; waited < timeoutMs; waited += 250) {
      const message = await evaluate(
        `document.querySelector('.footer-bar__message')?.textContent ?? ""`
      );
      if (message.startsWith("Saved") && message.endsWith(`.${extension}`)) {
        return true;
      }
      await sleep(250);
    }
    return false;
  };
  const canvasShot = async () => {
    const rect = await evaluate(`(() => {
      const r = document.querySelector('.globe-viewport canvas').getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    })()`);
    return (await send("Page.captureScreenshot", { format: "png", clip: { ...rect, scale: 1 } }))
      .data;
  };
  let dragDuringExport;
  const exportTiles = await tilesDuring(async () => {
    await startExport("png");
    await exportSaved("png", 10000);
    // 8.8.8.8 trace: hop 1 is private, so after the first flight (to hop 2)
    // the export dwells 5 s on hop 1 with no camera move: a quiet window.
    await startExport("webm", 5);
    await sleep(2800);
    const { x, y } = await centre();
    const shotBefore = await canvasShot();
    const before = await counters();
    await mouse("mousePressed", x, y, { button: "left", buttons: 1, clickCount: 1 });
    for (let i = 1; i <= 20; i += 1) {
      await mouse("mouseMoved", x + i * 8, y + i * 3, { button: "left", buttons: 1 });
      await sleep(16);
    }
    await mouse("mouseReleased", x + 160, y + 60, { button: "left", buttons: 0, clickCount: 1 });
    await sleep(800);
    const after = await counters();
    dragDuringExport = {
      exporting: (await exportButton()).includes("Exporting"),
      draws: after.draws - before.draws,
      unchanged: shotBefore === (await canvasShot())
    };
    await exportSaved("webm", 60000);
  });
  check(
    "a drag during a WebM export does not move the globe",
    dragDuringExport.exporting && dragDuringExport.draws === 0 && dragDuringExport.unchanged,
    `still exporting: ${dragDuringExport.exporting}, ${dragDuringExport.draws} WebGL draws, canvas ${dragDuringExport.unchanged ? "unchanged" : "changed"}`
  );
  check(
    "exports from a zoomed-in view request no online tile",
    exportTiles === 0,
    `${exportTiles} requests`
  );
  const files = fs
    .readdirSync(downloads)
    .map((file) => [file, fs.statSync(path.join(downloads, file)).size]);
  check(
    "PNG and WebM exports are written",
    ["png", "webm"].every((ext) =>
      files.some(([file, size]) => file.endsWith(`.${ext}`) && size > 10_000)
    ),
    files.map(([file, size]) => `${file} ${size} B`).join(", ")
  );

  // The export left the camera where the app put it. A larger window raises
  // Cesium's screen-space error; the view must still load no online tile
  // until the user moves the camera.
  const largerWindow = await tilesDuring(() =>
    send("Emulation.setDeviceMetricsOverride", {
      width: 3840,
      height: 2160,
      deviceScaleFactor: 1,
      mobile: false
    })
  );
  check(
    "a larger window after app moves requests no online tile",
    largerWindow === 0,
    `${largerWindow} requests`
  );
  const zoomAfterResize = await tilesDuring(userZoom);
  check(
    "the next user zoom requests online tiles again",
    zoomAfterResize > 0,
    `${zoomAfterResize} requests`
  );
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 713,
    deviceScaleFactor: 2,
    mobile: false
  });
  await settle();

  const { x, y } = await centre();
  const beforeDrag = await counters();
  await mouse("mousePressed", x, y, { button: "left", buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 20; i += 1) {
    await mouse("mouseMoved", x + i * 6, y + i * 2, { button: "left", buttons: 1 });
    await sleep(16);
  }
  await mouse("mouseReleased", x + 120, y + 40, { button: "left", buttons: 0, clickCount: 1 });
  await sleep(2000);
  const afterDrag = await counters();
  check(
    "a drag draws frames",
    afterDrag.raf - beforeDrag.raf > 0,
    `${afterDrag.raf - beforeDrag.raf} animation frames`
  );
  await idleWindow("after a drag");

  const final = await evaluate("window.__globeCheck");
  check("no page errors", final.errors.length === 0, final.errors.join("; "));
  // Cesium's credit display and an image-rendering probe try inline styles;
  // the CSP blocks them with no visible effect (docs/architecture.md).
  const unexpected = final.csp.filter((violation) => !violation.startsWith("style-src"));
  check(
    "no CSP violation other than Cesium's inline styles",
    unexpected.length === 0,
    unexpected.join("; ")
  );
  const hosts = new Set(
    events
      .filter((event) => event.method === "Network.requestWillBeSent")
      .map((event) => new URL(event.params.request.url))
      .filter((url) => url.protocol.startsWith("http"))
      .map((url) => url.host)
  );
  check(
    "no request leaves the machine",
    [...hosts].every((host) => host.startsWith("127.0.0.1")),
    [...hosts].join(", ")
  );
} finally {
  socket.close();
  chrome.kill();
  server.close();
}

console.log(`Screenshots and downloads: ${outDir}`);
process.exit(results.every(Boolean) ? 0 : 1);
