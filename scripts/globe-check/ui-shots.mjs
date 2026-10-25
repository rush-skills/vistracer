#!/usr/bin/env node
// Screenshots of the UI in headless Chrome with the fake Tauri IPC
// (mock-ipc.js): dark and light theme, a trace, the layer panel, a hover
// card, the command bar and the attribution, and the smallest window size.
// For review only; it checks nothing.
//
//   npm run build
//   node scripts/globe-check/ui-shots.mjs [output dir]

import { openApp, outputDir, sleep } from "./browser.mjs";

const outDir = outputDir("vistracer-ui-shots");

async function shoot({ width, height, theme, prefix }) {
  const app = await openApp({ outDir, width, height, deviceScaleFactor: 2 });
  const { evaluate, screenshot } = app;
  const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)})?.click()`);
  try {
    await sleep(6000);
    if (theme === "light") {
      await click('button[aria-label="Switch to light theme"]');
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
  } finally {
    await app.close();
  }
}

await shoot({ width: 1440, height: 900, theme: "dark", prefix: "dark" });
await shoot({ width: 1440, height: 900, theme: "light", prefix: "light" });
await shoot({ width: 960, height: 640, theme: "dark", prefix: "small" });
console.log(`Screenshots: ${outDir}`);
process.exit(0);
