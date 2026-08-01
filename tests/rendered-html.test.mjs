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

test("keeps live progress and backend-mediated media transfers connected", async () => {
  const [dashboard, server, styles, nginx] = await Promise.all([
    readFile(new URL("../app/dashboard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../server/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../deploy/nginx-hzmedia.conf", import.meta.url), "utf8"),
  ]);

  assert.match(dashboard, /new WebSocket\(url\)/);
  assert.match(dashboard, /new XMLHttpRequest\(\)/);
  assert.match(dashboard, /request\.upload\.onprogress/);
  assert.match(dashboard, /request\.withCredentials = true/);
  assert.match(dashboard, /X-HZ-Media-Request/);
  assert.match(dashboard, /\/api\/albums\/\$\{album\._id\}\/uploads/);
  assert.doesNotMatch(dashboard, /cloudflarestorage|presign/i);
  assert.match(dashboard, /<UploadTray/);
  assert.match(dashboard, /href=\{item\.downloadUrl\}/);
  assert.match(server, /httpServer\.on\("upgrade"/);
  assert.match(server, /Body: request/);
  assert.match(server, /\/api\/media\/:mediaId\/content/);
  assert.match(server, /await pipeline/);
  assert.match(server, /downloadUrl/);
  assert.doesNotMatch(server, /getSignedUrl|uploadUrl/);
  assert.doesNotMatch(server, /streamAlbumZip/);
  assert.match(nginx, /client_max_body_size 512m/);
  assert.match(nginx, /proxy_request_buffering off/);
  assert.match(styles, /\.upload-tray/);
  assert.match(styles, /\.media-download/);
});
