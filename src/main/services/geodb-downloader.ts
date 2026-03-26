import { app } from "electron";
import path from "node:path";
import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { createGunzip } from "node:zlib";
import { getLogger } from "./logger";
import { getSettingsStore } from "./persistence";
import { reloadGeoDatabases } from "./geo";

const log = getLogger();

export interface GeoDbDownloadProgress {
  stage: "downloading" | "extracting" | "complete" | "error";
  edition: string;
  percent?: number;
  error?: string;
}

type ProgressCallback = (progress: GeoDbDownloadProgress) => void;

const EDITIONS = ["GeoLite2-City", "GeoLite2-ASN"] as const;
type Edition = (typeof EDITIONS)[number];

function buildDownloadUrl(edition: Edition, licenseKey: string): string {
  return (
    `https://download.maxmind.com/app/geoip_download` +
    `?edition_id=${edition}&license_key=${encodeURIComponent(licenseKey)}&suffix=tar.gz`
  );
}

function getDatabaseDir(): string {
  return path.join(app.getPath("userData"), "databases");
}

async function downloadAndExtract(
  edition: Edition,
  licenseKey: string,
  onProgress: ProgressCallback
): Promise<string> {
  const url = buildDownloadUrl(edition, licenseKey);
  const dbDir = getDatabaseDir();
  await fs.mkdir(dbDir, { recursive: true });

  onProgress({ stage: "downloading", edition, percent: 0 });

  const response = await fetch(url);
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `MaxMind download failed (${response.status}): ${text || response.statusText}`
    );
  }

  // Download to a temp tar.gz file
  const tarGzPath = path.join(dbDir, `${edition}.tar.gz`);
  const body = response.body;
  if (!body) {
    throw new Error("Empty response body from MaxMind");
  }

  const fileStream = createWriteStream(tarGzPath);
  const contentLength = Number(response.headers.get("content-length") || 0);
  let downloaded = 0;

  const reader = body.getReader();
  try {
    let done = false;
    while (!done) {
      const result = await reader.read();
      done = result.done;
      const value = result.value;
      if (done || !value) break;
      fileStream.write(value);
      downloaded += value.byteLength;
      if (contentLength > 0) {
        onProgress({
          stage: "downloading",
          edition,
          percent: Math.round((downloaded / contentLength) * 100)
        });
      }
    }
  } finally {
    fileStream.end();
    await new Promise<void>((resolve, reject) => {
      fileStream.on("finish", resolve);
      fileStream.on("error", reject);
    });
  }

  onProgress({ stage: "extracting", edition });

  // Extract .mmdb from tarball
  // tar.gz contains: <edition>_<date>/<edition>.mmdb
  const mmdbPath = path.join(dbDir, `${edition}.mmdb`);
  await extractMmdbFromTarGz(tarGzPath, edition, mmdbPath);

  // Clean up tar.gz
  await fs.unlink(tarGzPath).catch(() => {});

  onProgress({ stage: "complete", edition, percent: 100 });
  return mmdbPath;
}

async function extractMmdbFromTarGz(
  tarGzPath: string,
  edition: string,
  outputPath: string
): Promise<void> {
  // Simple tar parser — we only need to find the .mmdb file
  const { createReadStream } = await import("node:fs");
  const gunzip = createGunzip();
  const source = createReadStream(tarGzPath);

  const chunks: Buffer[] = [];
  const decompressed = source.pipe(gunzip);

  for await (const chunk of decompressed) {
    chunks.push(Buffer.from(chunk));
  }

  const tarBuffer = Buffer.concat(chunks);
  const mmdbFilename = `${edition}.mmdb`;
  let offset = 0;

  while (offset < tarBuffer.length - 512) {
    // Read tar header (512 bytes)
    const header = tarBuffer.subarray(offset, offset + 512);

    // Check for end-of-archive (two zero blocks)
    if (header.every((b) => b === 0)) break;

    // Extract filename from header (first 100 bytes, null-terminated)
    const nameEnd = header.indexOf(0, 0);
    const name = header.subarray(0, Math.min(nameEnd, 100)).toString("utf8");

    // Extract file size from header (octal, bytes 124-135)
    const sizeStr = header.subarray(124, 136).toString("utf8").trim();
    const size = parseInt(sizeStr, 8) || 0;

    offset += 512; // Move past header

    if (name.endsWith(mmdbFilename)) {
      const fileData = tarBuffer.subarray(offset, offset + size);
      await fs.writeFile(outputPath, fileData);
      return;
    }

    // Skip file data (padded to 512-byte boundary)
    offset += Math.ceil(size / 512) * 512;
  }

  throw new Error(`${mmdbFilename} not found in downloaded archive`);
}

export async function downloadGeoDatabases(
  licenseKey: string,
  onProgress: ProgressCallback
): Promise<{ cityPath: string; asnPath: string }> {
  const results: Record<string, string> = {};

  for (const edition of EDITIONS) {
    try {
      const dbPath = await downloadAndExtract(edition, licenseKey, onProgress);
      results[edition] = dbPath;
      log.info(`Downloaded ${edition} to ${dbPath}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Download failed";
      log.error(`Failed to download ${edition}`, error);
      onProgress({ stage: "error", edition, error: message });
      throw error;
    }
  }

  const cityPath = results["GeoLite2-City"];
  const asnPath = results["GeoLite2-ASN"];

  // Update settings and reload readers
  const store = getSettingsStore();
  const geoSettings = store.get("geo");
  store.set("geo", {
    ...geoSettings,
    cityDbPath: cityPath,
    asnDbPath: asnPath,
    lastUpdated: Date.now()
  });

  await reloadGeoDatabases();

  return { cityPath, asnPath };
}
