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

// v7/v8 cached arbitrary Spotify URLs from rendered pages. Never reuse them.
// v9 starts a new validated resolver cache.
try {
  const oldCache = JSON.parse(await fs.readFile(CACHE_PATH, "utf8"));
  resolveCache = oldCache && oldCache.__cacheVersion === 2 ? oldCache : { __cacheVersion: 2 };
} catch {
  resolveCache = { __cacheVersion: 2 };
}

const SPOTIFY_RE = /https?:\/\/open\.spotify\.com\/(?:track|album|playlist|artist)\/[A-Za-z0-9]+/i;
const APPLE_RE = /https?:\/\/(?:geo\.)?music\.apple\.com\/[^\s"'<>]+/i;

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

function findAppleMusic(value, depth = 0) {
  if (value == null || depth > 12) return "";

  if (typeof value === "string") {
    const match = value.match(APPLE_RE);
    return match ? match[0].replace(/[),.;]+$/, "") : "";
  }

  if (Array.isArray(value)) {
    for (const v of value) {
      const found = findAppleMusic(v, depth + 1);
      if (found) return found;
    }
    return "";
  }

  if (typeof value === "object") {
    for (const [key, v] of Object.entries(value)) {
      if (/apple|itunes/i.test(key)) {
        const found = findAppleMusic(v, depth + 1);
        if (found) return found;
      }
    }
    for (const v of Object.values(value)) {
      const found = findAppleMusic(v, depth + 1);
      if (found) return found;
    }
  }

  return "";
}

function normaliseHit(hit) {
  const titles = textListFrom(hit.titles, ["title", "name", "text"]);
  const animeTitles = textListFrom(hit.anime_titles, ["title", "name", "text"]);
  const artists = textListFrom(hit.artists, ["name", "artist", "title"]);
  const displayArtists = textListFrom(hit.display_artists, ["name", "artist", "title"]);

  // AniPlaylist generally puts its preferred English/display title first.
  // Use that single title in RSS instead of concatenating every alias.
  const anime =
    animeTitles[0]
    || textFrom(hit.anime, ["title", "name", "text"])
    || textFrom(hit.series, ["title", "name"]);

  const song =
    titles[0]
    || textFrom(hit.song_key, ["name", "title"])
    || textFrom(hit.name, ["name", "title"])
    || textFrom(hit.title, ["title", "name"]);

  const artist = displayArtists[0]
    || artists[0]
    || textFrom(hit.artist, ["name", "artist"]);

  const kind = clean(
    hit.song_type_short
    || hit.song_type
    || hit.type
    || ""
  );

  const spotify = findSpotify(hit.links) || findSpotify(hit.platforms);
  const apple = findAppleMusic(hit.links) || findAppleMusic(hit.platforms);

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
    apple,
    detailUrl,
    season: textFrom(hit.season, ["name", "title"]),
    rawKeys: Object.keys(hit),
    titleCandidates: titles,
    animeCandidates: animeTitles,
    artistCandidates: artists,
  };
}
function normalizeForMatch(value) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[^a-z0-9\u3040-\u30ff\u3400-\u9fff]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function significantWords(value) {
  return normalizeForMatch(value)
    .split(" ")
    .filter(w => w.length >= 3)
    .slice(0, 12);
}

function pageMatchesItem(bodyText, item) {
  const body = normalizeForMatch(bodyText);
  const song = normalizeForMatch(item.song);
  const anime = normalizeForMatch(item.anime);

  // The detail page must at least mention the song title.
  if (song && !body.includes(song)) return false;

  // Anime title is a second guard against accidentally resolving a generic/
  // stale page. For very long titles, accept a strong word overlap.
  if (anime) {
    if (body.includes(anime)) return true;

    const words = significantWords(anime);
    const matches = words.filter(w => body.includes(w)).length;
    if (words.length >= 3 && matches >= Math.max(2, Math.ceil(words.length * 0.5))) return true;

    return false;
  }

  return !!song;
}

function pageSaysUnavailable(bodyText) {
  const body = normalizeForMatch(bodyText);

  const phrases = [
    "not available for streaming yet",
    "not yet released on streaming platforms",
    "not available on streaming",
    "notify me",
    "add it to your wishlist",
    "wishlist to be notified",
  ];

  return phrases.some(p => body.includes(p));
}

async function resolveSpotifyFromDetail(page, item) {
  if (!item.detailUrl || !/^https?:\/\//i.test(item.detailUrl)) return "";

  const key = item.detailUrl;
  const cached = resolveCache[key];

  // Only reuse the new validated cache format. Older v7/v8 cache entries may
  // contain false positives produced by the old resolver.
  if (cached && cached.version === 2 && typeof cached.spotify === "string") {
    return cached.spotify;
  }

  try {
    await page.goto(item.detailUrl, {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });

    await page.waitForTimeout(1200);

    const bodyText = await page.locator("body").innerText().catch(() => "");
    const matchesItem = pageMatchesItem(bodyText, item);

    if (!matchesItem) {
      resolveCache[key] = {
        version: 2,
        spotify: "",
        status: "mismatch",
        checkedAt: new Date().toISOString(),
      };
      return "";
    }

    // This is the most important guard: AniPlaylist explicitly marks these
    // cards/pages as unavailable and shows "Notify me". Never trust any
    // unrelated Spotify URL that happens to be present in the page HTML.
    if (pageSaysUnavailable(bodyText)) {
      resolveCache[key] = {
        version: 2,
        spotify: "",
        status: "unavailable",
        checkedAt: new Date().toISOString(),
      };
      return "";
    }

    // Only use a Spotify URL from a real anchor, not arbitrary text in scripts,
    // JSON-LD, site navigation, recommendations, etc.
    const hrefs = await page.locator('a[href]').evaluateAll(as =>
      as.map(a => ({
        href: a.href || "",
        text: (a.innerText || a.getAttribute("aria-label") || "").trim()
      }))
    ).catch(() => []);

    const candidates = hrefs
      .map(x => x.href)
      .filter(h => SPOTIFY_RE.test(h));

    const spotify = candidates[0]?.match(SPOTIFY_RE)?.[0] || "";

    resolveCache[key] = {
      version: 2,
      spotify,
      status: spotify ? "available" : "no-spotify-link",
      checkedAt: new Date().toISOString(),
    };

    return spotify;
  } catch (e) {
    resolveCache[key] = {
      version: 2,
      spotify: "",
      status: "error",
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

function htmlEscape(s) {
  return rssEscape(s);
}

function makePlatformHtml(label, url) {
  return `<p><strong>${htmlEscape(label)}</strong> — <a href="${htmlEscape(url)}">Open ${htmlEscape(label)}</a></p>`;
}

function makeRssItem(item, season) {
  const kind = item.kind || "Other";
  const title = `[${kind}] ${item.anime || "Unknown anime"}`;

  const platformParts = [];
  if (item.spotify) platformParts.push(makePlatformHtml("Spotify", item.spotify));
  if (item.apple) platformParts.push(makePlatformHtml("Apple Music", item.apple));

  const description = platformParts.join("\n")
    || `<p>${htmlEscape(item.song || "Music entry")}</p>`;

  // Keep the GUID independent of platform URLs. A later Apple/Spotify link
  // being added must update the existing item, not create a duplicate item.
  const key = sha1([
    season,
    item.id || "",
    item.anime,
    item.kind,
    item.song,
    item.artist,
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
    link: item.spotify || item.apple,
    guid: `aniplaylist:${key}`,
    pubDate: firstSeen,
  };
}

function buildRss(season, items) {
  items.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

  const body = items.map(i => `    <item>
      <title>${rssEscape(i.title)}</title>
      <description><![CDATA[${i.description}]]></description>
      <link>${rssEscape(i.link)}</link>
      <guid isPermaLink="false">${rssEscape(i.guid)}</guid>
      <pubDate>${new Date(i.pubDate).toUTCString()}</pubDate>
    </item>`).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${rssEscape(`AniPlaylist — ${season}`)}</title>
    <link>https://aniplaylist.com/?seasons=${encodeURIComponent(season)}</link>
    <description>New AniPlaylist entries for ${rssEscape(season)} with Spotify and Apple Music links.</description>
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
    withApple: 0,
    withDetailUrl: 0,
    resolvedSpotify: 0,
    unavailableDetailPages: 0,
    mismatchedDetailPages: 0,
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
  const withApple = normalized.filter(x => !!x.apple);
  const withPlatform = normalized.filter(x => !!x.spotify || !!x.apple);
  const withDetailUrl = normalized.filter(x => !!x.detailUrl);
  console.log(`Normalized records with AniPlaylist detail URL: ${withDetailUrl.length}`);
  diag.withSpotify = withSpotify.length;
  diag.withApple = withApple.length;
  diag.withDetailUrl = withDetailUrl.length;

  console.log(`Normalized records: ${diag.normalized}`);
  console.log(`Normalized records with AniPlaylist detail URL: ${diag.withDetailUrl}`);
  console.log(`Spotify links in hit: ${diag.withSpotify}`);
  console.log(`Apple Music links in hit: ${diag.withApple}`);
  console.log(`Entries with Spotify or Apple Music: ${withPlatform.length}`);

  // v10: only trust a Spotify URL explicitly attached to this exact Algolia
  // record's `links`/`platforms` fields. Do not scrape arbitrary Spotify URLs
  // from detail pages, because unrelated/recommended links can leak in.
  const usable = normalized.filter(item => !!item.spotify || !!item.apple);

  diag.resolvedSpotify = usable.filter(item => !!item.spotify).length;
  console.log(`Entries accepted from record itself (Spotify or Apple Music): ${usable.length}`);
  console.log(`Spotify accepted: ${diag.resolvedSpotify}`);
  console.log(`Apple Music accepted: ${usable.filter(item => !!item.apple).length}`);

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
      platformSamples: usable.slice(0, 30).map(x => ({
        id: x.id,
        anime: x.anime,
        song: x.song,
        kind: x.kind,
        spotify: x.spotify,
        apple: x.apple
      })),
    }, null, 2)
  );

  diag.unavailableDetailPages = 0;
  diag.mismatchedDetailPages = 0;

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
resolveCache.__cacheVersion = 2;
await fs.writeFile(CACHE_PATH, JSON.stringify(resolveCache, null, 2) + "\n");

await browser.close();

const summaryText = summary.map(s =>
  `${s.season}: results=${s.resultCount ?? "?"} uniqueHits=${s.uniqueHits} normalized=${s.normalized} spotify=${s.withSpotify} apple=${s.withApple} accepted=${s.resolvedSpotify}`
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
