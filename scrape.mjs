import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { chromium } from "playwright";

const ROOT = process.cwd();
const CFG = JSON.parse(await fs.readFile(path.join(ROOT, "seasons.json"), "utf8"));
const RSS_DIR = path.join(ROOT, "rss");
const DEBUG_DIR = path.join(ROOT, "debug");
const STATE_PATH = path.join(ROOT, "state.json");
const CACHE_PATH = path.join(ROOT, "resolve-cache.json");

await fs.mkdir(RSS_DIR, { recursive: true });
await fs.mkdir(DEBUG_DIR, { recursive: true });

let state = {};
let resolveCache = {};

try { state = JSON.parse(await fs.readFile(STATE_PATH, "utf8")); } catch {}
try { resolveCache = JSON.parse(await fs.readFile(CACHE_PATH, "utf8")); } catch {}

const SPOTIFY_RE = /https?:\/\/open\.spotify\.com\/(?:track|album|playlist|artist)\/[A-Za-z0-9]+/i;

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
function clean(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}
function sha1(s) {
  return crypto.createHash("sha1").update(String(s)).digest("hex").slice(0, 16);
}
function unique(arr) {
  return [...new Set(arr.map(clean).filter(Boolean))];
}

/*
 * AniPlaylist's current Algolia records contain nested fields such as:
 *
 * titles:       [...]
 * anime_titles: [...]
 * artists:      [...]
 * links:        [...]
 * platforms:    [...]
 * song_type:    "Opening"
 * song_type_short: "OP"
 *
 * Older scraper versions assumed these were plain strings. They are not.
 */
function collectStrings(value, out = [], depth = 0) {
  if (value == null || depth > 8) return out;
  if (typeof value === "string") {
    if (value.trim()) out.push(value);
    return out;
  }
  if (typeof value === "number" || typeof value === "boolean") return out;

  if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out, depth + 1);
    return out;
  }

  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      // Keys themselves are not values we want to present as titles.
      collectStrings(v, out, depth + 1);
    }
  }
  return out;
}

function textFrom(value, preferredKeys = []) {
  if (value == null) return "";

  if (typeof value === "string" || typeof value === "number") return clean(value);

  if (Array.isArray(value)) {
    const parts = [];
    for (const v of value) {
      const t = textFrom(v, preferredKeys);
      if (t) parts.push(t);
      if (parts.length >= 8) break;
    }
    return unique(parts).join(", ");
  }

  if (typeof value === "object") {
    const lower = new Map(Object.entries(value).map(([k, v]) => [k.toLowerCase(), v]));

    for (const key of preferredKeys) {
      const v = lower.get(key.toLowerCase());
      const t = textFrom(v, preferredKeys);
      if (t) return t;
    }

    for (const key of ["en", "english", "romaji", "japanese", "ja", "name", "title", "label", "text", "value"]) {
      const v = lower.get(key);
      const t = textFrom(v, preferredKeys);
      if (t) return t;
    }

    for (const v of Object.values(value)) {
      const t = textFrom(v, preferredKeys);
      if (t) return t;
    }
  }
  return "";
}

function textListFrom(value, preferredKeys = []) {
  if (value == null) return [];
  if (typeof value === "string" || typeof value === "number") return [clean(value)];

  if (Array.isArray(value)) {
    return unique(value.flatMap(v => textListFrom(v, preferredKeys))).slice(0, 16);
  }

  if (typeof value === "object") {
    // An object containing an English title should yield that title only.
    for (const key of preferredKeys) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        const t = textFrom(value[key], preferredKeys);
        if (t) return [t];
      }
    }
    for (const key of ["en", "english", "romaji", "name", "title", "label", "text"]) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        const t = textFrom(value[key], preferredKeys);
        if (t) return [t];
      }
    }
    return unique(Object.values(value).flatMap(v => textListFrom(v, preferredKeys))).slice(0, 16);
  }

  return [];
}

function findSpotify(value, depth = 0) {
  if (value == null || depth > 12) return "";

  if (typeof value === "string") {
    const m = value.match(SPOTIFY_RE);
    return m ? m[0] : "";
  }

  if (Array.isArray(value)) {
    for (const v of value) {
      const s = findSpotify(v, depth + 1);
      if (s) return s;
    }
    return "";
  }

  if (typeof value === "object") {
    // Prefer explicit spotify keys first.
    for (const [k, v] of Object.entries(value)) {
      if (/spotify/i.test(k)) {
        const s = findSpotify(v, depth + 1);
        if (s) return s;
      }
    }
    for (const v of Object.values(value)) {
      const s = findSpotify(v, depth + 1);
      if (s) return s;
    }
  }

  return "";
}

function asAniPlaylistUrl(value) {
  if (typeof value !== "string") return "";
  const v = value.trim();
  if (!v) return "";

  if (/^https?:\/\//i.test(v)) return v;

  // Current Algolia records can expose a relative `short_link`/`web` path.
  if (v.startsWith("/")) return `https://aniplaylist.com${v}`;

  // Some fields contain just the path without a leading slash.
  if (/^[A-Za-z0-9._~!$&'()*+,;=:@%/?-]+$/.test(v) &&
      !/^(spotify|apple|deezer|youtube):/i.test(v)) {
    return `https://aniplaylist.com/${v}`;
  }

  return "";
}

function firstAniPlaylistUrl(value, depth = 0) {
  if (value == null || depth > 10) return "";

  if (typeof value === "string") return asAniPlaylistUrl(value);

  if (Array.isArray(value)) {
    for (const v of value) {
      const u = firstAniPlaylistUrl(v, depth + 1);
      if (u) return u;
    }
    return "";
  }

  if (typeof value === "object") {
    for (const v of Object.values(value)) {
      const u = firstAniPlaylistUrl(v, depth + 1);
      if (u) return u;
    }
  }

  return "";
}

function normaliseHit(hit) {
  const titles = textListFrom(hit.titles, ["title", "name", "text"]);
  const animeTitles = textListFrom(hit.anime_titles, ["title", "name", "text"]);
  const artists = textListFrom(hit.artists, ["name", "artist", "title"]);
  const displayArtists = textListFrom(hit.display_artists, ["name", "artist", "title"]);

  const song = textFrom(hit.titles, ["title", "name", "text"])
    || textFrom(hit.song_key, ["name", "title"])
    || textFrom(hit.name, ["name", "title"])
    || textFrom(hit.title, ["title", "name"]);

  const anime = textFrom(hit.anime_titles, ["title", "name", "text"])
    || textFrom(hit.anime, ["title", "name", "text"])
    || textFrom(hit.series, ["title", "name"]);

  const artist = displayArtists.join(", ") || artists.join(", ")
    || textFrom(hit.artist, ["name", "artist"]);

  const kind = clean(
    hit.song_type_short
    || hit.song_type
    || hit.type
    || ""
  );

  const spotify = findSpotify(hit.links) || findSpotify(hit.platforms) || findSpotify(hit);
  const detailUrl =
    firstAniPlaylistUrl(hit.web)
    || firstAniPlaylistUrl(hit.short_link)
    || firstAniPlaylistUrl(hit.url);

  return {
    id: clean(hit.objectID || hit.id || hit.song_key || ""),
    anime,
    song,
    artist,
    kind,
    spotify,
    detailUrl,
    season: textFrom(hit.season, ["name", "title"]),
    rawKeys: Object.keys(hit),
    titleCandidates: titles,
    animeCandidates: animeTitles,
    artistCandidates: artists,
  };
}

async function resolveSpotifyFromDetail(page, item) {
  if (!item.detailUrl || !/^https?:\/\//i.test(item.detailUrl)) return "";

  const key = item.detailUrl;
  const cached = resolveCache[key];
  if (cached && cached.spotify) return cached.spotify;

  try {
    await page.goto(item.detailUrl, {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });

    // AniPlaylist's detail pages hydrate their platform links after the HTML shell loads.
    await page.waitForTimeout(1200);

    const hrefs = await page.locator('a[href]').evaluateAll(as =>
      as.map(a => a.href).filter(Boolean)
    ).catch(() => []);

    for (const href of hrefs) {
      const m = href.match(SPOTIFY_RE);
      if (m) {
        resolveCache[key] = {
          spotify: m[0],
          checkedAt: new Date().toISOString(),
        };
        return m[0];
      }
    }

    // Also inspect the rendered HTML in case the platform link is embedded in a script.
    const html = await page.content();
    const m = html.match(SPOTIFY_RE);

    resolveCache[key] = {
      spotify: m?.[0] || "",
      checkedAt: new Date().toISOString(),
    };

    return m?.[0] || "";
  } catch (e) {
    resolveCache[key] = {
      spotify: "",
      checkedAt: new Date().toISOString(),
      error: String(e.message || e).slice(0, 300),
    };
    return "";
  }
}
function rssEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function makeRssItem(item, season) {
  const kind = item.kind || "Other";
  const title = `[${kind}] ${item.anime || "Unknown anime"} — ${item.song || "Unknown song"}`;
  const description = [
    item.anime ? `Anime: ${item.anime}` : "",
    item.kind ? `Type: ${item.kind}` : "",
    item.song ? `Song: ${item.song}` : "",
    item.artist ? `Artist: ${item.artist}` : "",
    `Season: ${season}`,
  ].filter(Boolean).join("\n");

  const key = sha1([
    season,
    item.id || "",
    item.anime,
    item.kind,
    item.song,
    item.artist,
    item.spotify,
  ].join("|"));

  const firstSeen = state[key]?.firstSeen || new Date().toISOString();
  state[key] = {
    firstSeen,
    season,
    ...item,
  };

  return {
    title,
    description,
    link: item.spotify,
    guid: `aniplaylist:${key}`,
    pubDate: firstSeen,
  };
}

function buildRss(season, items) {
  items.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

  const body = items.map(i => `    <item>
      <title>${rssEscape(i.title)}</title>
      <description>${rssEscape(i.description)}</description>
      <link>${rssEscape(i.link)}</link>
      <guid isPermaLink="false">${rssEscape(i.guid)}</guid>
      <pubDate>${new Date(i.pubDate).toUTCString()}</pubDate>
    </item>`).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${rssEscape(`AniPlaylist — ${season}`)}</title>
    <link>https://aniplaylist.com/?seasons=${encodeURIComponent(season)}</link>
    <description>New AniPlaylist entries for ${rssEscape(season)} with Spotify links.</description>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${body}
  </channel>
</rss>
`;
}

const browser = await chromium.launch({
  headless: true,
  args: [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-blink-features=AutomationControlled",
  ],
});

const context = await browser.newContext({
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/154 Safari/537.36",
  viewport: { width: 1440, height: 1800 },
});

const page = await context.newPage();
const summary = [];

for (const season of CFG.seasons) {
  const url = `https://aniplaylist.com/?seasons=${encodeURIComponent(season)}`;
  const diag = {
    season,
    url,
    resultCount: null,
    jsonResponses: 0,
    algoliaResponses: 0,
    hitArrays: 0,
    rawHits: 0,
    uniqueHits: 0,
    normalized: 0,
    withSpotify: 0,
    withDetailUrl: 0,
    resolvedSpotify: 0,
    sample: [],
    errors: [],
  };

  console.log(`\n=== ${season} ===`);
  console.log(`Loading ${url}`);

  const captured = [];
  const responseHandler = async (resp) => {
    const ct = (resp.headers()["content-type"] || "").toLowerCase();
    const u = resp.url();
    if (!(ct.includes("json") || /algolia|\/search(?:\/|\\?|$)|api/i.test(u))) return;

    diag.jsonResponses++;
    try {
      const body = await resp.text();
      if (!body || body.length > 10_000_000) return;
      const json = JSON.parse(body);
      if (/algolia/i.test(u)) diag.algoliaResponses++;
      captured.push({ url: u, json });
    } catch {}
  };

  page.on("response", responseHandler);

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.waitForTimeout(7000);

    // Keep scrolling until the page stops changing or 60 passes have occurred.
    let oldHeight = 0;
    let stable = 0;
    for (let i = 0; i < 60; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(450);
      const height = await page.evaluate(() => document.body.scrollHeight).catch(() => 0);
      if (height === oldHeight) stable++;
      else stable = 0;
      oldHeight = height;
      if (stable >= 5) break;
    }
    await page.waitForTimeout(2000);

    const bodyText = await page.locator("body").innerText().catch(() => "");
    const countMatches = [
      /([\d,]+)\s+results found/i,
      /([\d,]+)\s+results/i,
    ];
    for (const re of countMatches) {
      const m = bodyText.match(re);
      if (m) {
        diag.resultCount = Number(m[1].replace(/,/g, ""));
        break;
      }
    }
    console.log(`Result count from body: ${diag.resultCount ?? "unknown"}`);
    console.log(`Playwright anchor count: ${await page.locator("a").count().catch(() => 0)}`);

    await page.screenshot({
      path: path.join(DEBUG_DIR, `${slug(season)}.png`),
      fullPage: true,
    }).catch(() => {});
  } catch (e) {
    diag.errors.push(`page: ${e.message}`);
  } finally {
    page.removeListener("response", responseHandler);
  }

  const hitArrays = [];
  for (const r of captured) {
    const stack = [];
    const walk = (v, depth = 0) => {
      if (v == null || depth > 10) return;
      if (Array.isArray(v)) {
        for (const x of v) walk(x, depth + 1);
        return;
      }
      if (typeof v !== "object") return;
      if (Array.isArray(v.hits)) {
        hitArrays.push({
          url: r.url,
          hits: v.hits,
          page: v.page ?? null,
          nbHits: v.nbHits ?? null,
          hitsPerPage: v.hitsPerPage ?? null,
          nbPages: v.nbPages ?? null,
        });
      }
      for (const x of Object.values(v)) walk(x, depth + 1);
    };
    walk(r.json);
  }

  // Remove duplicate response objects that the site may emit more than once.
  const uniqueHitMap = new Map();
  for (const a of hitArrays) {
    for (const h of a.hits) {
      const id = String(h.objectID ?? h.id ?? h.song_key ?? sha1(JSON.stringify(h)));
      if (!uniqueHitMap.has(id)) uniqueHitMap.set(id, h);
    }
  }

  const rawHits = [...uniqueHitMap.values()];
  diag.hitArrays = hitArrays.length;
  diag.rawHits = hitArrays.reduce((n, a) => n + a.hits.length, 0);
  diag.uniqueHits = rawHits.length;
  diag.sample = rawHits.slice(0, 5).map(normaliseHit);

  console.log(`JSON responses: ${diag.jsonResponses}`);
  console.log(`Algolia-ish responses: ${diag.algoliaResponses}`);
  console.log(`Hit arrays: ${diag.hitArrays}`);
  console.log(`Raw hits: ${diag.rawHits}`);
  console.log(`Unique hits: ${diag.uniqueHits}`);

  const normalized = rawHits.map(normaliseHit)
    .filter(x => x.anime || x.song || x.artist || x.spotify);

  diag.normalized = normalized.length;

  const withSpotify = normalized.filter(x => !!x.spotify);
  const withDetailUrl = normalized.filter(x => !!x.detailUrl);
  console.log(`Normalized records with AniPlaylist detail URL: ${withDetailUrl.length}`);
  diag.withSpotify = withSpotify.length;
  diag.withDetailUrl = withDetailUrl.length;

  console.log(`Normalized records: ${diag.normalized}`);
  console.log(`Normalized records with AniPlaylist detail URL: ${diag.withDetailUrl}`);
  console.log(`Spotify directly in hit: ${diag.withSpotify}`);

  const usable = [];
  for (const item of normalized) {
    let spotify = item.spotify;
    if (!spotify && item.detailUrl) {
      spotify = await resolveSpotifyFromDetail(page, item);
    }
    if (spotify) usable.push({ ...item, spotify });
  }

  diag.resolvedSpotify = usable.length;
  console.log(`Spotify after detail resolution: ${diag.resolvedSpotify}`);

  // Save a concise but rich diagnostic file.
  await fs.writeFile(
    path.join(DEBUG_DIR, `${slug(season)}.json`),
    JSON.stringify({
      ...diag,
      hitMeta: hitArrays.map(x => ({
        url: x.url,
        page: x.page,
        nbHits: x.nbHits,
        hitsPerPage: x.hitsPerPage,
        nbPages: x.nbPages,
        count: x.hits.length,
      })),
      normalizedSamples: normalized.slice(0, 30),
      detailUrlSamples: normalized.filter(x => x.detailUrl).slice(0, 30).map(x => ({
        id: x.id,
        anime: x.anime,
        song: x.song,
        kind: x.kind,
        detailUrl: x.detailUrl
      })),
      usableSamples: usable.slice(0, 30),
    }, null, 2)
  );

  const rssItems = usable.map(x => makeRssItem(x, season));
  await fs.writeFile(
    path.join(RSS_DIR, `${slug(season)}.xml`),
    buildRss(season, rssItems)
  );

  console.log(
    `${season}: results=${diag.resultCount ?? "?"} uniqueHits=${diag.uniqueHits} normalized=${diag.normalized} directSpotify=${diag.withSpotify} resolvedSpotify=${diag.resolvedSpotify}`
  );

  summary.push(diag);
}

await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
await fs.writeFile(CACHE_PATH, JSON.stringify(resolveCache, null, 2) + "\n");

await browser.close();

const summaryText = summary.map(s =>
  `${s.season}: results=${s.resultCount ?? "?"} uniqueHits=${s.uniqueHits} normalized=${s.normalized} detailUrls=${s.withDetailUrl} directSpotify=${s.withSpotify} resolvedSpotify=${s.resolvedSpotify}`
).join("\n");

await fs.writeFile(path.join(ROOT, "build-summary.txt"), summaryText + "\n");
console.log("\n===== FINAL SUMMARY =====\n" + summaryText);

// Do not fail because an unreleased future season has no results.
// Do fail for a populated season if the site gave us hits but not even one
// recognizable record. That means the schema changed and needs attention.
const bad = summary.find(s =>
  Number.isFinite(s.resultCount) &&
  s.resultCount > 0 &&
  s.uniqueHits > 0 &&
  s.normalized === 0
);

if (bad) {
  console.error(
    `Schema extraction failed for ${bad.season}: AniPlaylist returned ${bad.resultCount} results and ${bad.uniqueHits} unique hits, but 0 hits could be normalized. See debug/${slug(bad.season)}.json.`
  );
  process.exit(2);
}
