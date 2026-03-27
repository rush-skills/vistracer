import type { TracerouteRun } from "@common/ipc";
import { hopIndexToColor } from "@renderer/lib/globe";
import { createGif } from "@renderer/lib/gifjs";
import { useTracerouteStore } from "@renderer/state/tracerouteStore";

type ExportFormat = "png" | "jpg" | "webp" | "webm" | "gif";

export interface ExportOptions {
  format: ExportFormat;
  dwellSeconds: number;
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const waitNextFrame = (): Promise<void> =>
  new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });

const getGlobeCanvas = (): HTMLCanvasElement | null =>
  document.querySelector(".globe-viewport canvas") as HTMLCanvasElement | null;

const buildFilename = (prefix: string, extension: string) => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${prefix}-${timestamp}.${extension}`;
};

const downloadBlob = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
};

const drawOverlay = (
  ctx: CanvasRenderingContext2D,
  sourceCanvas: HTMLCanvasElement,
  hop: TracerouteRun["hops"][number]
) => {
  const { width, height } = sourceCanvas;
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(sourceCanvas, 0, 0, width, height);

  const padding = Math.round(width * 0.018);
  const maxBoxWidth = Math.round(Math.min(width * 0.26, 240));
  const innerPadding = Math.round(Math.max(12, width * 0.012));
  const textLeft = padding + innerPadding;
  const lineHeight = Math.round(Math.max(14, height * 0.016));
  const lineGap = Math.round(lineHeight * 0.3);
  const overlayTextWidth = maxBoxWidth - innerPadding * 2;

  const headerFont = `600 ${Math.round(lineHeight * 1.15)}px 'Inter', 'Segoe UI', sans-serif`;
  const bodyFont = `400 ${Math.round(lineHeight * 0.92)}px 'Inter', 'Segoe UI', sans-serif`;
  const bodySmallFont = `400 ${Math.round(lineHeight * 0.85)}px 'Inter', 'Segoe UI', sans-serif`;

  const lines: { text: string; color: string; font: string }[] = [];

  const append = (text: string, font: string, color: string) => {
    lines.push({ text, font, color });
  };

  const appendWrapped = (text: string, font: string, color: string) => {
    ctx.font = font;
    const words = text.split(/\s+/);
    let current = "";
    words.forEach((word) => {
      const candidate = current ? `${current} ${word}` : word;
      if (ctx.measureText(candidate).width > overlayTextWidth && current) {
        append(current, font, color);
        current = word;
      } else {
        current = candidate;
      }
    });
    if (current) {
      append(current, font, color);
    }
  };

  const hopHueColor = hopIndexToColor ? hopIndexToColor(hop.hopIndex) : "#69ceb4";
  append(`Hop ${hop.hopIndex}`, headerFont, hopHueColor);
  appendWrapped(hop.ipAddress ?? "Unresolved", bodyFont, "#d7dbff");
  if (hop.hostName) {
    appendWrapped(hop.hostName, bodySmallFont, "rgba(215, 219, 255, 0.7)");
  }

  const location = hop.geo
    ? `${hop.geo.city ? `${hop.geo.city}, ` : ""}${hop.geo.country ?? hop.geo.isoCode ?? "Unknown"}`
    : hop.isPrivate
      ? "Private network"
      : "Unknown";
  appendWrapped(`Location: ${location}`, bodySmallFont, "rgba(215, 219, 255, 0.7)");

  if (hop.geo) {
    appendWrapped(
      `Coords: ${hop.geo.latitude.toFixed(4)}, ${hop.geo.longitude.toFixed(4)}`,
      bodySmallFont,
      "rgba(215, 219, 255, 0.6)"
    );
  }

  const latency =
    hop.latency.avgRttMs == null
      ? "—"
      : `${hop.latency.avgRttMs} ms (min ${hop.latency.minRttMs ?? "—"}, max ${hop.latency.maxRttMs ?? "—"})`;
  appendWrapped(`Latency: ${latency}`, bodySmallFont, "rgba(215, 219, 255, 0.7)");

  const asn = hop.asn?.asn ? `AS${hop.asn.asn}` : "Unknown";
  const asnOrg = hop.asn?.name ? ` — ${hop.asn.name}` : "";
  appendWrapped(`ASN: ${asn}${asnOrg}`, bodySmallFont, "rgba(215, 219, 255, 0.7)");

  if (hop.peeringDb) {
    const peeringLabel = hop.peeringDb.name ?? "PeeringDB entry";
    const peeringLocation = hop.peeringDb.city
      ? ` (${hop.peeringDb.city}${hop.peeringDb.country ? `, ${hop.peeringDb.country}` : ""})`
      : "";
    appendWrapped(`PeeringDB: ${peeringLabel}${peeringLocation}`, bodySmallFont, "rgba(215, 219, 255, 0.6)");
  }

  if (hop.providers && hop.providers.length > 0) {
    append("Providers:", bodySmallFont, "rgba(215, 219, 255, 0.6)");
    hop.providers.forEach((provider) => {
      const statusIcon = provider.status === "success" ? "✓" : provider.status === "error" ? "!" : "•";
      const statusColor =
        provider.status === "success"
          ? "#7ad0b7"
          : provider.status === "error"
            ? "#ff9f9f"
            : "rgba(255,255,255,0.65)";
      appendWrapped(`${statusIcon} ${provider.provider}`, bodySmallFont, statusColor);
    });
  }

  const boxHeight =
    innerPadding * 2 + lines.length * lineHeight + Math.max(0, lines.length - 1) * lineGap;

  const x = padding;
  const y = padding;

  ctx.fillStyle = "rgba(12, 14, 21, 0.8)";
  ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
  ctx.lineWidth = 1.25;
  const radius = 12;
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + maxBoxWidth - radius, y);
  ctx.quadraticCurveTo(x + maxBoxWidth, y, x + maxBoxWidth, y + radius);
  ctx.lineTo(x + maxBoxWidth, y + boxHeight - radius);
  ctx.quadraticCurveTo(x + maxBoxWidth, y + boxHeight, x + maxBoxWidth - radius, y + boxHeight);
  ctx.lineTo(x + radius, y + boxHeight);
  ctx.quadraticCurveTo(x, y + boxHeight, x, y + boxHeight - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  ctx.textBaseline = "alphabetic";
  let currentY = y + innerPadding + lineHeight;
  lines.forEach((line, index) => {
    ctx.font = line.font;
    ctx.fillStyle = line.color;
    ctx.fillText(line.text, textLeft, currentY);
    currentY += lineHeight;
    if (index < lines.length - 1) {
      currentY += lineGap;
    }
  });
};

const captureImageBlob = async (
  canvas: HTMLCanvasElement,
  overlayCtx: CanvasRenderingContext2D,
  hop: TracerouteRun["hops"][number] | undefined,
  format: "image/png" | "image/jpeg" | "image/webp"
): Promise<Blob> => {
  if (hop) {
    drawOverlay(overlayCtx, canvas, hop);
    return await new Promise<Blob>((resolve, reject) => {
      overlayCtx.canvas.toBlob((blob) => {
        if (!blob) {
          reject(new Error("Failed to capture image"));
        } else {
          resolve(blob);
        }
      }, format);
    });
  }

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("Failed to capture image"));
      } else {
        resolve(blob);
      }
    }, format);
  });
};

const captureGif = async (
  hops: TracerouteRun["hops"],
  canvas: HTMLCanvasElement,
  overlayCtx: CanvasRenderingContext2D,
  dwellSeconds: number
): Promise<Blob> => {
  const gif = createGif({ workers: 4, quality: 20, repeat: 0, background: "#000" });
  const store = useTracerouteStore.getState();
  const { setSelectedHop } = store;

  const original = store.selectedHopIndex;

  const blobPromise = new Promise<Blob>((resolve, reject) => {
    gif.on("finished", (blob: Blob) => resolve(blob));
    gif.on("abort", () => reject(new Error("GIF export aborted")));
  });

  const fps = 12;
  const frameInterval = 1000 / fps;
  const frameDelay = Math.max(60, Math.round(frameInterval));

  for (const hop of hops) {
    if (hop.geo) {
      setSelectedHop(hop.hopIndex);
      await waitNextFrame();
    } else {
      setSelectedHop(undefined);
      await waitNextFrame();
    }
    const endTime = performance.now() + Math.max(frameInterval, dwellSeconds * 1000);
    while (performance.now() < endTime) {
      drawOverlay(overlayCtx, canvas, hop);
      gif.addFrame(overlayCtx.canvas, {
        copy: true,
        delay: frameDelay
      });
      await wait(frameInterval);
    }
  }

  gif.render();

  const blob = await blobPromise;
  setSelectedHop(original);
  return blob;
};

const captureWebm = async (
  hops: TracerouteRun["hops"],
  canvas: HTMLCanvasElement,
  overlayCtx: CanvasRenderingContext2D,
  dwellSeconds: number
): Promise<Blob> => {
  const fps = 30;
  const interval = 1000 / fps;
  const store = useTracerouteStore.getState();
  const { setSelectedHop } = store;
  const original = store.selectedHopIndex;

  const trackCanvas = overlayCtx.canvas;
  const stream = trackCanvas.captureStream(fps);

  const mimeTypes = [
    "video/webm; codecs=vp9",
    "video/webm; codecs=vp8",
    "video/webm"
  ];
  const mimeType = mimeTypes.find((type) => MediaRecorder.isTypeSupported(type));
  if (!mimeType) {
    throw new Error("WebM is not supported in this environment.");
  }

  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: 6_000_000
  });

  const chunks: BlobPart[] = [];
  const recordingPromise = new Promise<Blob>((resolve, reject) => {
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        chunks.push(event.data);
      }
    };
    recorder.onerror = (event) => {
      reject(event.error ?? new Error("MediaRecorder error"));
    };
    recorder.onstop = () => {
      resolve(new Blob(chunks, { type: mimeType }));
    };
  });

  recorder.start(Math.round(interval));

  for (const hop of hops) {
    if (hop.geo) {
      setSelectedHop(hop.hopIndex);
      await waitNextFrame();
    } else {
      setSelectedHop(undefined);
      await waitNextFrame();
    }
    const endTime = performance.now() + dwellSeconds * 1000;
    while (performance.now() < endTime) {
      drawOverlay(overlayCtx, canvas, hop);
      await wait(interval);
    }
  }

  recorder.stop();
  stream.getTracks().forEach((track) => track.stop());
  const blob = await recordingPromise;
  setSelectedHop(original);
  return blob;
};

export const runExport = async (options: ExportOptions, run: TracerouteRun): Promise<{ filename: string }> => {
  const canvas = getGlobeCanvas();
  if (!canvas) {
    throw new Error("Globe canvas not found.");
  }

  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) {
    throw new Error("Failed to create capture canvas.");
  }
  ctx.canvas.width = canvas.width;
  ctx.canvas.height = canvas.height;

  const store = useTracerouteStore.getState();
  const { setSelectedHop, setCaptureActive } = store;
  const originalSelected = store.selectedHopIndex;

  const sortedHops = run.hops.slice().sort((a, b) => a.hopIndex - b.hopIndex);
  const hopsWithGeo = sortedHops.filter((hop) => hop.geo);
  const firstGeoHop = hopsWithGeo[0] ?? sortedHops[0];
  const cameraHopIndex = firstGeoHop?.hopIndex ?? sortedHops[0]?.hopIndex;

  const settleCamera = async () => {
    if (cameraHopIndex != null) {
      setSelectedHop(cameraHopIndex);
      await waitNextFrame();
      await wait(600);
      await waitNextFrame();
      await wait(600);
      await waitNextFrame();
    }
  };

  try {
    if (sortedHops.length === 0) {
      throw new Error("No hops available to export.");
    }

    switch (options.format) {
      case "png":
      case "jpg":
      case "webp": {
        const mime = options.format === "png" ? "image/png" : options.format === "jpg" ? "image/jpeg" : "image/webp";
        const blob = await captureImageBlob(canvas, ctx, undefined, mime);
        const filename = buildFilename("vistracer-snapshot", options.format);
        downloadBlob(blob, filename);
        return { filename };
      }
      case "gif": {
        if (!sortedHops.length) {
          throw new Error("No hops available to animate.");
        }
        setCaptureActive(true);
        await settleCamera();
        if (cameraHopIndex != null) {
          setSelectedHop(undefined);
          await waitNextFrame();
        }
        const blob = await captureGif(sortedHops, canvas, ctx, options.dwellSeconds);
        const filename = buildFilename("vistracer-route", "gif");
        downloadBlob(blob, filename);
        setCaptureActive(false);
        return { filename };
      }
      case "webm": {
        if (!sortedHops.length) {
          throw new Error("No hops available to animate.");
        }
        setCaptureActive(true);
        await settleCamera();
        if (cameraHopIndex != null) {
          setSelectedHop(undefined);
          await waitNextFrame();
        }
        const blob = await captureWebm(sortedHops, canvas, ctx, options.dwellSeconds);
        const filename = buildFilename("vistracer-route", "webm");
        downloadBlob(blob, filename);
        setCaptureActive(false);
        return { filename };
      }
      default:
        throw new Error(`Unsupported export format: ${options.format}`);
    }
  } finally {
    setSelectedHop(originalSelected);
    setCaptureActive(false);
  }
};
