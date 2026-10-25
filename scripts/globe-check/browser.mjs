// Shared by check.mjs and ui-shots.mjs: serves dist/renderer with the app's
// production CSP, starts headless Chrome with remote debugging, and injects
// the fake Tauri IPC (mock-ipc.js) before the app loads.
//
// Needs Node.js 22.4 or later (global WebSocket). CHROME=/path/to/chrome
// selects the browser (default: Google Chrome on macOS).

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

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function exitWith(message) {
  console.error(message);
  process.exit(2);
}

/** The output dir from argv[2], or a new temp dir named after `prefix`. */
export function outputDir(prefix) {
  const dir = process.argv[2]
    ? path.resolve(process.argv[2])
    : fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Opens the built app at `width` x `height` CSS px. Returns CDP helpers;
 * `events` collects every CDP event (Network.enable is on).
 */
export async function openApp({ outDir, width = 1280, height = 713, deviceScaleFactor = 2 }) {
  if (!fs.existsSync(path.join(dist, "index.html"))) {
    exitWith("dist/renderer is missing: run `npm run build` first.");
  }
  if (typeof WebSocket !== "function") {
    exitWith("This check needs Node.js 22.4 or later (global WebSocket).");
  }
  if (!fs.existsSync(chromePath)) {
    exitWith(`No browser at ${chromePath}. Set CHROME to a Chrome or Chromium binary.`);
  }

  // The production CSP from tauri.conf.json, sent with the page.
  const conf = JSON.parse(
    fs.readFileSync(path.join(repo, "src-tauri", "tauri.conf.json"), "utf8")
  );
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
    // Chrome may have created the file but not written the port yet.
    const port = fs.existsSync(portFile)
      ? Number(fs.readFileSync(portFile, "utf8").split("\n")[0])
      : 0;
    if (port > 0) {
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
  // A page that crashed or hangs never answers: fail the call instead of
  // waiting forever.
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        const crashed = events.some((event) => event.method === "Inspector.targetCrashed");
        reject(new Error(`${method}: no answer in 60 s${crashed ? " (the page crashed)" : ""}`));
      }, 60000);
      pending.set(id, (data) => {
        clearTimeout(timer);
        data.error ? reject(new Error(`${method}: ${data.error.message}`)) : resolve(data.result);
      });
      socket.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ?? result.exceptionDetails.text
      );
    }
    return result.result.value;
  };
  const screenshot = async (name) => {
    const { data } = await send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(outDir, `${name}.png`), Buffer.from(data, "base64"));
  };
  const mouse = (type, x, y, extra = {}) =>
    send("Input.dispatchMouseEvent", { type, x, y, ...extra });
  const key = async (keyName, { code, modifiers = 0, text } = {}) => {
    const base = { key: keyName, code: code ?? keyName, modifiers };
    await send("Input.dispatchKeyEvent", { type: "keyDown", ...base, ...(text ? { text } : {}) });
    await send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  };
  const exited = new Promise((resolve) => chrome.once("exit", resolve));
  /**
   * Resolves once Chrome has exited and released its profile. Chrome can
   * ignore SIGTERM; it is killed after 5 s, so a failed step ends the run
   * with its error instead of waiting forever.
   */
  const close = async () => {
    socket.close();
    chrome.kill();
    server.close();
    const forced = setTimeout(() => chrome.kill("SIGKILL"), 5000);
    await exited;
    clearTimeout(forced);
  };

  try {
    await send("Page.enable");
    await send("Inspector.enable");
    await send("Runtime.enable");
    await send("Network.enable");
    await send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor,
      mobile: false
    });
    await send("Page.addScriptToEvaluateOnNewDocument", {
      source: fs.readFileSync(path.join(here, "mock-ipc.js"), "utf8")
    });
    await send("Page.navigate", { url: appUrl });
  } catch (error) {
    await close();
    throw error;
  }
  return { send, evaluate, screenshot, mouse, key, events, close };
}
