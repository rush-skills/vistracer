#!/usr/bin/env node
// Screenshots of the UI in headless Chrome with the fake Tauri IPC
// (mock-ipc.js): dark and light theme, a trace, the layer panel, hover
// cards from the timeline and the globe, the command bar, the credits, the
// settings dialog, the infrastructure layers (exchanges and data centres,
// a site card, cloud regions, network colours, the cable notice and cables),
// the satellites (a Starlink hop, the notice, the layer on, a satellite
// card), and the smallest window (960 x 640) with a framed flight. For
// review only; it checks nothing.
//
//   npm run build
//   node scripts/globe-check/ui-shots.mjs [output dir]

import { openApp, outputDir, sleep } from "./browser.mjs";

const outDir = outputDir("vistracer-ui-shots");

async function shoot({ width, height, theme, prefix, full, reduced = false }) {
  const app = await openApp({ outDir, width, height, deviceScaleFactor: 2 });
  const { evaluate, mouse, key } = app;
  if (reduced) {
    // The system settings "reduce motion" and "reduce transparency".
    await app.send("Emulation.setEmulatedMedia", {
      features: [
        { name: "prefers-reduced-motion", value: "reduce" },
        { name: "prefers-reduced-transparency", value: "reduce" }
      ]
    });
  }
  const screenshot = async (name) => {
    await app.screenshot(name);
    console.log(name);
  };
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

    const selectHop = async (address) => {
      await evaluate(
        `[...document.querySelectorAll('.hop-details__row')].find((row) => row.textContent.includes(${JSON.stringify(address)})).click()`
      );
      await sleep(2500);
    };
    if (!full) {
      // App flights frame the hop in the area the panels leave free.
      await selectHop("80.81.192.96");
      await screenshot(`${prefix}-04-flight-framing`);
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
    await key("Escape");
    await sleep(300);

    const setLayers = async (ids, on) => {
      await click("#layers-toggle");
      await sleep(300);
      for (const id of ids) {
        await evaluate(`(() => {
          const box = document.querySelector('input[aria-labelledby="layer-${id}-label"]');
          if (box.checked !== ${on}) box.click();
        })()`);
        await sleep(150);
      }
      await click("#layers-toggle");
      await sleep(1500);
    };

    await setLayers(["exchanges", "data-centres"], true);
    await selectHop("80.81.192.96");
    await screenshot(`${prefix}-09-exchanges-datacentres`);
    await setLayers(["exchanges", "data-centres"], false);

    await setLayers(["cloud-regions"], true);
    await selectHop("154.54.58.1");
    await screenshot(`${prefix}-10-cloud-regions`);

    await setLayers(["asn-colors"], true);
    await screenshot(`${prefix}-11-network-colours`);

    await click("#layers-toggle");
    await sleep(300);
    await evaluate(`document.querySelector('input[aria-labelledby="layer-submarine-cables-label"]').click()`);
    await sleep(400);
    await screenshot(`${prefix}-12-cables-notice`);
    await evaluate(
      `[...document.querySelectorAll('.consent-dialog button')].find((b) => b.textContent.startsWith('Show')).click()`
    );
    await sleep(300);
    await click("#layers-toggle");
    await sleep(1000);
    await selectHop("80.231.217.17");
    await screenshot(`${prefix}-13-cables`);

    // A site card: move the pointer over the free area until one shows.
    await setLayers(["cloud-regions", "asn-colors", "submarine-cables"], false);
    await setLayers(["exchanges", "data-centres"], true);
    await selectHop("80.81.192.96");
    const area = await evaluate(`(() => {
      const pane = document.querySelector('[data-globe-inset="right"]').getBoundingClientRect();
      const top = document.querySelector('[data-globe-inset="top"]').getBoundingClientRect();
      const bottom = Math.min(...[...document.querySelectorAll('[data-globe-inset="bottom"]')].map((p) => p.getBoundingClientRect().top));
      return { left: 16, right: pane.left - 16, top: top.bottom + 16, bottom: bottom - 16 };
    })()`);
    let found = false;
    for (let y = area.top; y < area.bottom && !found; y += 18) {
      for (let x = area.left; x < area.right && !found; x += 18) {
        await mouse("mouseMoved", x, y);
        await sleep(80);
        found = await evaluate(
          `/Internet exchange|Data centre/.test(document.querySelector('[role=tooltip]')?.textContent ?? '')`
        );
      }
    }
    await screenshot(`${prefix}-14-site-card${found ? "" : "-not-found"}`);

    // Satellites: a route through Starlink's network, then the layer.
    await setLayers(["exchanges", "data-centres"], false);
    await mouse("mouseMoved", 5, 300);
    await evaluate(`(() => {
      const input = document.querySelector('input[aria-label="Traceroute target"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'starlink.example');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.form.requestSubmit();
    })()`);
    await sleep(5 * 400 + 3000);
    await selectHop("203.0.113.25");
    await screenshot(`${prefix}-15-starlink-hop`);
    await evaluate(
      `[...document.querySelectorAll('button')].find((b) => b.textContent === 'Show Starlink satellites').click()`
    );
    await sleep(400);
    await screenshot(`${prefix}-16-satellites-notice`);
    await evaluate(
      `[...document.querySelectorAll('.consent-dialog button')].find((b) => b.textContent.startsWith('Show')).click()`
    );
    await sleep(1500);
    // Zoom out (the user's own move; far out the globe uses bundled imagery).
    const globeCentre = await centreOf(".globe-viewport canvas");
    for (let i = 0; i < 8; i += 1) {
      await mouse("mouseWheel", globeCentre.x - 200, globeCentre.y, { deltaX: 0, deltaY: 400 });
      await sleep(150);
    }
    await sleep(3000);
    await screenshot(`${prefix}-17-satellites`);
    let satellite = false;
    for (let y = area.top; y < area.bottom && !satellite; y += 9) {
      for (let x = area.left; x < area.right && !satellite; x += 9) {
        await mouse("mouseMoved", x, y);
        await sleep(60);
        satellite = await evaluate(`/NORAD/.test(document.querySelector('[role=tooltip]')?.textContent ?? '')`);
      }
    }
    await screenshot(`${prefix}-18-satellite-card${satellite ? "" : "-not-found"}`);
  } finally {
    await app.close();
  }
}

// SHOTS=dark,light,small,reduced picks some of the sets (default: all).
const sets = (process.env.SHOTS ?? "dark,light,small,reduced").split(",");
if (sets.includes("dark")) {
  await shoot({ width: 1440, height: 900, theme: "dark", prefix: "dark", full: true });
}
if (sets.includes("light")) {
  await shoot({ width: 1440, height: 900, theme: "light", prefix: "light", full: true });
}
if (sets.includes("small")) {
  await shoot({ width: 960, height: 640, theme: "dark", prefix: "small", full: false });
}
if (sets.includes("reduced")) {
  await shoot({ width: 1440, height: 900, theme: "light", prefix: "reduced", full: false, reduced: true });
}
console.log(`Screenshots: ${outDir}`);
process.exit(0);
