#!/usr/bin/env node
// Checks the production globe in headless Chrome, with the app's CSP and a
// fake Tauri IPC (mock-ipc.js):
//
// - an idle globe runs no animation frames and no WebGL draws, and the
//   glass panels over it (backdrop-filter blur) make no compositor frames
// - camera moves the app makes (start view, following a trace, selecting a
//   hop, exports) request no online tile, also when the window grows later;
//   a zoom the user makes does
// - a drag during a WebM export does not move the globe
// - with "Online imagery" off in the layer panel, a user zoom requests no
//   online tile; switched on again, it does
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
import path from "node:path";
import { openApp, outputDir, sleep } from "./browser.mjs";

const outDir = outputDir("vistracer-globe-check");
const { send, evaluate, screenshot, mouse, events, close } = await openApp({ outDir });

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

// Compositor work while `action` runs, from a Chrome trace: frames the
// compositor drew (DrawFrame, BeginFrame) and main-thread paints.
const FRAME_EVENTS = new Set(["DrawFrame", "BeginFrame", "Paint"]);
const compositorFrames = async (action) => {
  const from = events.length;
  await send("Tracing.start", {
    traceConfig: {
      includedCategories: ["devtools.timeline", "disabled-by-default-devtools.timeline.frame"]
    },
    transferMode: "ReturnAsStream"
  });
  await action();
  await send("Tracing.end");
  let complete;
  while (!(complete = events.slice(from).find((e) => e.method === "Tracing.tracingComplete"))) {
    await sleep(50);
  }
  let data = "";
  for (;;) {
    const chunk = await send("IO.read", { handle: complete.params.stream });
    data += chunk.base64Encoded ? Buffer.from(chunk.data, "base64").toString() : chunk.data;
    if (chunk.eof) {
      break;
    }
  }
  await send("IO.close", { handle: complete.params.stream });
  const trace = JSON.parse(data);
  return (Array.isArray(trace) ? trace : trace.traceEvents).filter((e) => FRAME_EVENTS.has(e.name))
    .length;
};

const idleWindow = async (name) => {
  const before = await counters();
  const composited = await compositorFrames(() => sleep(5000));
  const after = await counters();
  const frames = after.raf - before.raf;
  const draws = after.draws - before.draws;
  check(
    `idle globe draws nothing (${name})`,
    frames === 0 && draws === 0,
    `${frames} animation frames, ${draws} WebGL draws in 5 s`
  );
  check(
    `idle glass panels make no compositor frames (${name})`,
    composited === 0,
    `${composited} frame and paint events in 5 s`
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
const userDrag = async (dx, dy) => {
  const { x, y } = await centre();
  await mouse("mousePressed", x, y, { button: "left", buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 20; i += 1) {
    await mouse("mouseMoved", x + (dx * i) / 20, y + (dy * i) / 20, { button: "left", buttons: 1 });
    await sleep(16);
  }
  await mouse("mouseReleased", x + dx, y + dy, { button: "left", buttons: 0, clickCount: 1 });
};
const userZoom = async () => {
  const { x, y } = await centre();
  for (let i = 0; i < 3; i += 1) {
    await mouse("mouseWheel", x, y, { deltaX: 0, deltaY: -300 });
    await sleep(150);
  }
};

try {
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
      `[...document.querySelectorAll('button')].find((b) => /Export route|Exporting/.test(b.textContent))?.textContent ?? ""`
    );
  const startExport = async (format, dwellSeconds) => {
    await evaluate(
      `[...document.querySelectorAll('button')].find((b) => b.textContent.includes('Export route')).click()`
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
  // A fingerprint of the WebGL canvas's own pixels (it keeps its drawing
  // buffer for exports). Not a screenshot: the panels float over the canvas,
  // and their focus rings and hover states are not the globe.
  const canvasShot = () =>
    evaluate(`(() => {
      const data = document.querySelector('.globe-viewport canvas').toDataURL();
      let hash = 0;
      for (let i = 0; i < data.length; i += 1) hash = (hash * 31 + data.charCodeAt(i)) | 0;
      return data.length + ':' + hash;
    })()`);
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

  // The layer panel's switch, as a user flips it.
  const setOnlineImagery = async (on) => {
    await evaluate(`document.querySelector('#layers-toggle').click()`);
    await sleep(300);
    await evaluate(`(() => {
      const box = document.querySelector('input[aria-labelledby="layer-online-imagery-label"]');
      if (box.checked !== ${on}) box.click();
      document.querySelector('#layers-toggle').click();
    })()`);
    await sleep(300);
  };
  // Off, the user moves to new ground and zooms in: nothing is requested.
  // On again, that view's online tiles load (they were never loaded, so
  // Cesium's imagery cache cannot serve them).
  await setOnlineImagery(false);
  const offTiles = await tilesDuring(async () => {
    await userDrag(-420, 60);
    await userZoom();
  });
  check(
    "with online imagery off, a user drag and zoom request no online tile",
    offTiles === 0,
    `${offTiles} requests`
  );
  const onTiles = await tilesDuring(() => setOnlineImagery(true));
  check(
    "switched on again, online imagery loads the user's view",
    onTiles > 0,
    `${onTiles} requests`
  );

  const { x, y } = await centre();
  const beforeDrag = await counters();
  const canvasBeforeDrag = await canvasShot();
  await mouse("mousePressed", x, y, { button: "left", buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 20; i += 1) {
    await mouse("mouseMoved", x + i * 6, y + i * 2, { button: "left", buttons: 1 });
    await sleep(16);
  }
  await mouse("mouseReleased", x + 120, y + 40, { button: "left", buttons: 0, clickCount: 1 });
  await sleep(2000);
  const afterDrag = await counters();
  // Also shows that the canvas fingerprint above sees a moved globe.
  const canvasMoved = canvasBeforeDrag !== (await canvasShot());
  check(
    "a drag draws frames and moves the globe",
    afterDrag.raf - beforeDrag.raf > 0 && canvasMoved,
    `${afterDrag.raf - beforeDrag.raf} animation frames, canvas ${canvasMoved ? "changed" : "unchanged"}`
  );
  await idleWindow("after a drag");

  // Control: the trace does see frames when something on the page animates.
  const animated = await compositorFrames(async () => {
    await evaluate(`(() => {
      const probe = document.createElement('div');
      probe.id = 'frame-probe';
      Object.assign(probe.style, { position: 'fixed', left: '0', top: '0', width: '8px', height: '8px' });
      document.body.append(probe);
      probe.animate([{ backgroundColor: 'red' }, { backgroundColor: 'blue' }], { duration: 500, iterations: Infinity });
    })()`);
    await sleep(2000);
    await evaluate(`document.querySelector('#frame-probe').remove()`);
  });
  check("control: an animated element makes compositor frames", animated > 0, `${animated} events`);

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
  await close();
}

console.log(`Screenshots and downloads: ${outDir}`);
process.exit(results.every(Boolean) ? 0 : 1);
