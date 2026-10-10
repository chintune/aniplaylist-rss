import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";

test("the shared AniPlaylist UI has syntactically valid inline JavaScript", async () => {
  const html = await fs.readFile(new URL("../site/index.html", import.meta.url), "utf8");
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
    .map(match => match[1])
    .filter(source => source.trim());

  assert.ok(scripts.length > 0, "site/index.html should have an inline application script");
  for (const [index, source] of scripts.entries()) {
    assert.doesNotThrow(
      () => new vm.Script(source, { filename: `site/index.html inline script ${index + 1}` }),
      `inline script ${index + 1} should parse`
    );
  }
});

test("the shared UI contains route-specific song detail and season routing", async () => {
  const html = await fs.readFile(new URL("../site/index.html", import.meta.url), "utf8");
  assert.match(html, /function routeFromLocation\(\)/);
  assert.match(html, /function showSongDetail\(r\)/);
  assert.match(html, /id="detailView"/);
  assert.match(html, /data-video-url/);
});
