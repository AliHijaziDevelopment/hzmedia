import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the HZ Media application shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Overview · HZ Media<\/title>/i);
  assert.match(html, />HZ Media</);
  assert.match(html, />Loading</);
  assert.match(html, /Opening HZ Media/);
  assert.doesNotMatch(html, /Your site is taking shape|Building your site/);
});

test("keeps live upload progress and album downloads connected", async () => {
  const [dashboard, server, archive, styles] = await Promise.all([
    readFile(new URL("../app/dashboard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../server/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../server/zip-stream.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(dashboard, /new WebSocket\(url\)/);
  assert.match(dashboard, /new XMLHttpRequest\(\)/);
  assert.match(dashboard, /request\.upload\.onprogress/);
  assert.match(dashboard, /<UploadTray/);
  assert.match(dashboard, /\/api\/albums\/\$\{album\._id\}\/download/);
  assert.match(server, /httpServer\.on\("upgrade"/);
  assert.match(server, /app\.get\("\/api\/albums\/:albumId\/download"/);
  assert.match(server, /streamAlbumZip/);
  assert.match(archive, /Content-Disposition/);
  assert.match(archive, /GetObjectCommand/);
  assert.match(styles, /\.upload-tray/);
  assert.match(styles, /\.album-download/);
});
