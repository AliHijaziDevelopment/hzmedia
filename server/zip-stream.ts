import { once } from "node:events";
import type { Response } from "express";
import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";

type ArchiveFile = { objectKey: string; filename: string; bytes: number; updatedAt?: Date | string };
type CentralEntry = { filename: Buffer; crc: number; size: number; offset: number; time: number; date: number };

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

export async function streamAlbumZip(response: Response, client: S3Client, bucket: string, files: ArchiveFile[], albumName: string) {
  if (files.length > 65_535 || files.reduce((sum, file) => sum + file.bytes, 0) >= 0xffff0000) throw new Error("This album is too large to download as one file");
  const names = uniqueFilenames(files.map((file) => file.filename));
  const archiveFilename = `${safeFilename(albumName) || "album"}.zip`;
  response.status(200);
  response.setHeader("Content-Type", "application/zip");
  response.setHeader("Content-Disposition", `attachment; filename="${asciiFilename(archiveFilename)}"; filename*=UTF-8''${encodeURIComponent(archiveFilename)}`);
  response.setHeader("Cache-Control", "private, no-store");
  response.flushHeaders();

  let offset = 0;
  const central: CentralEntry[] = [];
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const filename = Buffer.from(names[index], "utf8");
    const { time, date } = dosDate(file.updatedAt ? new Date(file.updatedAt) : new Date());
    const localOffset = offset;
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0808, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(time, 10);
    localHeader.writeUInt16LE(date, 12);
    localHeader.writeUInt16LE(filename.length, 26);
    await write(response, localHeader);
    await write(response, filename);
    offset += localHeader.length + filename.length;

    const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: file.objectKey }));
    const body = object.Body as AsyncIterable<Uint8Array> | undefined;
    if (!body || typeof body[Symbol.asyncIterator] !== "function") throw new Error("A media file could not be downloaded");
    let crc = 0xffffffff;
    let size = 0;
    for await (const value of body) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      for (const byte of chunk) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
      size += chunk.length;
      offset += chunk.length;
      await write(response, chunk);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    if (size > 0xffffffff) throw new Error("A media file is too large to archive");
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc, 4);
    descriptor.writeUInt32LE(size, 8);
    descriptor.writeUInt32LE(size, 12);
    await write(response, descriptor);
    offset += descriptor.length;
    central.push({ filename, crc, size, offset: localOffset, time, date });
  }

  const centralOffset = offset;
  for (const entry of central) {
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0808, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(entry.time, 12);
    header.writeUInt16LE(entry.date, 14);
    header.writeUInt32LE(entry.crc, 16);
    header.writeUInt32LE(entry.size, 20);
    header.writeUInt32LE(entry.size, 24);
    header.writeUInt16LE(entry.filename.length, 28);
    header.writeUInt32LE(entry.offset, 42);
    await write(response, header);
    await write(response, entry.filename);
    offset += header.length + entry.filename.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(offset - centralOffset, 12);
  end.writeUInt32LE(centralOffset, 16);
  response.end(end);
}

async function write(response: Response, chunk: Buffer) {
  if (response.destroyed) throw new Error("Download was cancelled");
  if (!response.write(chunk)) await once(response, "drain");
}

function uniqueFilenames(filenames: string[]) {
  const used = new Set<string>();
  return filenames.map((value, index) => {
    const safe = safeFilename(value) || `media-${index + 1}`;
    let candidate = safe;
    let duplicate = 2;
    while (used.has(candidate.toLowerCase())) candidate = `${duplicate++}-${safe}`;
    used.add(candidate.toLowerCase());
    return candidate;
  });
}

function safeFilename(value: string) { return value.normalize("NFKC").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/^\.+/, "").trim().slice(0, 180); }
function asciiFilename(value: string) { return value.replace(/[^\x20-\x7e]|["\\]/g, "_"); }
function dosDate(value: Date) {
  const year = Math.max(1980, value.getFullYear());
  return { time: (value.getHours() << 11) | (value.getMinutes() << 5) | Math.floor(value.getSeconds() / 2), date: ((year - 1980) << 9) | ((value.getMonth() + 1) << 5) | value.getDate() };
}
