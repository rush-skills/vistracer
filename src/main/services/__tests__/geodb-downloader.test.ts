import { describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { gzipSync } from "node:zlib";

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp", getAppPath: () => "/tmp", isPackaged: false }
}));
vi.mock("electron-store", () => {
  return {
    default: class {
      #data = new Map();
      get(key: string, def?: unknown) { return this.#data.get(key) ?? def; }
      set(key: string, val: unknown) { this.#data.set(key, val); }
      delete(key: string) { this.#data.delete(key); }
    }
  };
});

import { extractMmdbFromTarGz } from "../geodb-downloader";

function createTarEntry(filename: string, content: Buffer): Buffer {
  // Tar header is 512 bytes
  const header = Buffer.alloc(512);

  // Name (0-99)
  header.write(filename, 0, Math.min(filename.length, 100), "utf8");

  // Mode (100-107)
  header.write("0000644\0", 100, 8, "utf8");

  // UID (108-115)
  header.write("0000000\0", 108, 8, "utf8");

  // GID (116-123)
  header.write("0000000\0", 116, 8, "utf8");

  // Size in octal (124-135)
  const sizeOctal = content.length.toString(8).padStart(11, "0") + "\0";
  header.write(sizeOctal, 124, 12, "utf8");

  // Mtime (136-147)
  header.write("00000000000\0", 136, 12, "utf8");

  // Checksum placeholder (148-155) — fill with spaces first
  header.write("        ", 148, 8, "utf8");

  // Typeflag (156) — '0' for regular file
  header.write("0", 156, 1, "utf8");

  // Compute checksum (sum of all header bytes as unsigned)
  let checksum = 0;
  for (let i = 0; i < 512; i++) {
    checksum += header[i];
  }
  const checksumOctal = checksum.toString(8).padStart(6, "0") + "\0 ";
  header.write(checksumOctal, 148, 8, "utf8");

  // Pad data to 512-byte boundary
  const paddedSize = Math.ceil(content.length / 512) * 512;
  const dataBlock = Buffer.alloc(paddedSize);
  content.copy(dataBlock);

  return Buffer.concat([header, dataBlock]);
}

function createTarGz(entries: Array<{ name: string; content: Buffer }>): Buffer {
  const parts = entries.map(e => createTarEntry(e.name, e.content));
  // Add two 512-byte zero blocks as end-of-archive marker
  parts.push(Buffer.alloc(1024));
  const tar = Buffer.concat(parts);
  return Buffer.from(gzipSync(tar));
}

describe("extractMmdbFromTarGz", () => {
  it("extracts .mmdb from a valid tarball", async () => {
    const fakeDb = Buffer.from("fake-mmdb-data-city");
    const tarGz = createTarGz([
      { name: "GeoLite2-City.mmdb", content: fakeDb }
    ]);

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "geodb-test-"));
    const tarPath = path.join(tmpDir, "test.tar.gz");
    const outPath = path.join(tmpDir, "GeoLite2-City.mmdb");

    try {
      await fs.writeFile(tarPath, tarGz);
      await extractMmdbFromTarGz(tarPath, "GeoLite2-City", outPath);

      const result = await fs.readFile(outPath);
      expect(result.toString()).toBe("fake-mmdb-data-city");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("throws when .mmdb file is not found in archive", async () => {
    const tarGz = createTarGz([
      { name: "some-other-file.txt", content: Buffer.from("nope") }
    ]);

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "geodb-test-"));
    const tarPath = path.join(tmpDir, "test.tar.gz");
    const outPath = path.join(tmpDir, "GeoLite2-City.mmdb");

    try {
      await fs.writeFile(tarPath, tarGz);
      await expect(
        extractMmdbFromTarGz(tarPath, "GeoLite2-City", outPath)
      ).rejects.toThrow("GeoLite2-City.mmdb not found in downloaded archive");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("handles nested directory structure", async () => {
    const fakeDb = Buffer.from("nested-mmdb-data");
    const tarGz = createTarGz([
      { name: "GeoLite2-City_20240101/GeoLite2-City.mmdb", content: fakeDb }
    ]);

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "geodb-test-"));
    const tarPath = path.join(tmpDir, "test.tar.gz");
    const outPath = path.join(tmpDir, "GeoLite2-City.mmdb");

    try {
      await fs.writeFile(tarPath, tarGz);
      await extractMmdbFromTarGz(tarPath, "GeoLite2-City", outPath);

      const result = await fs.readFile(outPath);
      expect(result.toString()).toBe("nested-mmdb-data");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
