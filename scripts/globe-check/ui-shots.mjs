#!/usr/bin/env node
// Screenshots of the UI in headless Chrome with the fake Tauri IPC
// (mock-ipc.js): dark and light theme, a trace, the layer panel, hover
// cards from the timeline and the globe, the command bar, the credits, the
// settings dialog, and the smallest window (960 x 640). For review only; it
// checks nothing.
//
//   npm run build
//   node scripts/globe-check/ui-shots.mjs [output dir]

import { openApp, outputDir, sleep } from "./browser.mjs";

const outDir = outputDir("vistracer-ui-shots");

async function shoot({ width, height, theme, prefix, full }) {
  const app = await openApp({ outDir, width, height, deviceScaleFactor: 2 });
  const { evaluate, screenshot, mouse, key } = app;
  const click = (selector) =>
    evaluate(`document.querySelector(${JSON.stringify(selector)})?.click()`);
  const centreOf = (selector) =>
    evaluate(`(() => {
      const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
  try {
    await sleep(6000);
    if (theme === "light") {
      await click('button[aria-label="Switch to the light theme"]');
      await sleep(500);
    }
    await screenshot(`${prefix}-01-start`);
    await evaluate(`(() => {
      const input = document.querySelector('input[aria-label="Traceroute target"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'example.com');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.form.requestSubmit();
    })()`);
    await sleep(7 * 400 + 4000);
    await screenshot(`${prefix}-02-trace`);

    // The camera centres the selected hop: hover its marker on the globe.
    const canvas = await centreOf(".globe-viewport canvas");
    await mouse("mouseMoved", canvas.x, canvas.y);
    await sleep(800);
    await screenshot(`${prefix}-03-hover-globe`);
    await mouse("mouseMoved", 5, canvas.y);

    if (!full) {
      return;
    }
    const hop = await centreOf("#timeline-hop-4");
    await mouse("mouseMoved", hop.x, hop.y);
    await sleep(500);
    await screenshot(`${prefix}-04-hover-timeline`);
    await mouse("mouseMoved", 5, 300);

    await click("#layers-toggle");
    await sleep(400);
    await screenshot(`${prefix}-05-layers`);
    await click("#layers-toggle");

    await click(".toolbar__command");
    await sleep(300);
    await evaluate(`(() => {
      const input = document.querySelector('[role="combobox"][aria-label^="Search commands"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'hop');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await sleep(300);
    await screenshot(`${prefix}-06-command-bar`);
    await key("Escape");

    await click('button[aria-label="Data sources and credits"]');
    await sleep(300);
    await screenshot(`${prefix}-07-credits`);
    await key("Escape");

    await click('button[aria-label="Open settings"]');
    await sleep(600);
    await screenshot(`${prefix}-08-settings`);
  } finally {
    await app.close();
  }
}

await shoot({ width: 1440, height: 900, theme: "dark", prefix: "dark", full: true });
await shoot({ width: 1440, height: 900, theme: "light", prefix: "light", full: true });
await shoot({ width: 960, height: 640, theme: "dark", prefix: "small", full: false });
console.log(`Screenshots: ${outDir}`);
process.exit(0);
