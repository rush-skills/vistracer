import { app } from "electron";
import path from "node:path";
import fs from "node:fs/promises";
import https from "node:https";
import { createWriteStream } from "node:fs";
import { createGunzip } from "node:zlib";
import { getLogger } from "./logger";
import { getSettingsStore } from "./persistence";
import { reloadGeoDatabases } from "./geo";
import type { GeoDbDownloadProgress } from "@common/ipc";

const log = getLogger();

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

function downloadFile(
  url: string,
  destPath: string,
  onPercent: (percent: number) => void,
  maxRedirects = 5
): Promise<void> {
  return new Promise((resolve, reject) => {
    const doRequest = (requestUrl: string, redirectsLeft: number) => {
      const parsed = new URL(requestUrl);
      log.info(`[geodb] HTTPS GET ${parsed.hostname}${parsed.pathname}${parsed.search.replace(/license_key=[^&]+/, "license_key=***")}`);

      const req = https.request(
        {
          hostname: parsed.hostname,
          port: 443,
          path: parsed.pathname + parsed.search,
          method: "GET",
          headers: {
            "User-Agent": "VisTracer/0.1 (GeoIP database downloader)"
          }
        },
        (res) => {
          log.info(`[geodb] HTTP ${res.statusCode}`);
          // Follow redirects (301, 302, 303, 307, 308)
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume(); // Drain redirect response body to free the socket
            if (redirectsLeft <= 0) {
              reject(new Error("Too many redirects"));
              return;
            }
            doRequest(res.headers.location, redirectsLeft - 1);
            return;
          }

          if (!res.statusCode || res.statusCode >= 400) {
            let body = "";
            res.on("data", (chunk: Buffer) => { body += chunk.toString(); });
            res.on("end", () => {
              log.error(`[geodb] Download error: ${res.statusCode} ${body}`);
              reject(new Error(`MaxMind download failed (${res.statusCode}): ${body || res.statusMessage}`));
            });
            return;
          }

          const contentLength = Number(res.headers["content-length"] || 0);
          let downloaded = 0;
          const fileStream = createWriteStream(destPath);

          res.on("data", (chunk: Buffer) => {
            fileStream.write(chunk);
            downloaded += chunk.length;
            if (contentLength > 0) {
              onPercent(Math.round((downloaded / contentLength) * 100));
            }
          });

          res.on("end", () => {
            fileStream.end();
            fileStream.on("finish", resolve);
            fileStream.on("error", reject);
          });

          res.on("error", (err) => {
            fileStream.destroy();
            reject(err);
          });
        }
      );

      req.on("error", reject);
      req.end();
    };

    doRequest(url, maxRedirects);
  });
}

async function downloadAndExtract(
  edition: Edition,
  licenseKey: string,
  onProgress: ProgressCallback
): Promise<string> {
  const url = buildDownloadUrl(edition, licenseKey);
  log.info(`[geodb] Downloading ${edition} from ${url.replace(/license_key=[^&]+/, "license_key=***")}`);
  const dbDir = getDatabaseDir();
  await fs.mkdir(dbDir, { recursive: true });

  onProgress({ stage: "downloading", edition, percent: 0 });

  // Use Node's https module instead of the global fetch (which Electron overrides
  // with Chromium's network stack). Electron's fetch may reject valid license keys
  // due to cross-origin redirect handling differences.
  const tarGzPath = path.join(dbDir, `${edition}.tar.gz`);
  await downloadFile(url, tarGzPath, (percent) => {
    onProgress({ stage: "downloading", edition, percent });
  });

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

export async function extractMmdbFromTarGz(
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
