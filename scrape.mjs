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
for (const [file, fallback] of [[STATE_PATH, {}], [CACHE_PATH, {}]]) {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8"));
    if (file === STATE_PATH) state = parsed;
    else resolveCache = parsed;
  } catch {
    if (file === STATE_PATH) state = fallback;
    else resolveCache = fallback;
  }
}

const TYPES = [
  "Opening", "Ending", "Insert", "OST", "Vocal Album", "Character Song",
  "Music Video", "Image Album", "Image Song", "Theme Song", "Other", "PV Song",
];
const TYPE_RE = /^(?:OP|ED|IN|OST|VA|CS|MV|IMGA|IMGS|TS|PV|Other)(?:\d+)?(?:\s*\([^)]*\))?$/i;
const SPOTIFY_RE = /https?:\/\/open\.spotify\.com\/(?:track|album|playlist|artist)\/[A-Za-z0-9]+/i;

function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
function clean(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}
function hash(s) {
  return crypto.createHash("sha1").update(s).digest("hex").slice(0, 16);
}
function deepFind(obj, predicate, limit = 200, out = []) {
  if (out.length >= limit || obj == null) return out;
  if (Array.isArray(obj)) {
    for (const x of obj) deepFind(x, predicate, limit, out);
    return out;
  }
  if (typeof obj !== "object") return out;
  try {
    if (predicate(obj)) out.push(obj);
  } catch {}
  for (const v of Object.values(obj)) deepFind(v, predicate, limit, out);
  return out;
}
function firstString(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === "string" && v.trim()) return clean(v);
  }
  return "";
}
function firstUrl(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === "string" && /^https?:\/\//i.test(v)) return v;
  }
  return "";
}
function scanSpotify(obj) {
  const hits = deepFind(
    obj,
    x => Object.entries(x).some(([k, v]) =>
      /spotify/i.test(k) && typeof v === "string" && SPOTIFY_RE.test(v)
    ),
    20
  );
  for (const x of hits) {
    for (const [k, v] of Object.entries(x)) {
      if (/spotify/i.test(k) && typeof v === "string" && SPOTIFY_RE.test(v)) {
        return v.match(SPOTIFY_RE)?.[0] || v;
      }
    }
  }
  return "";
}

function normaliseHit(h, season) {
  const anime = firstString(h, ["anime", "animeTitle", "anime_name", "series", "show"]);
  const kind = firstString(h, ["kind", "type", "category", "songType", "song_type"]);
  const name = firstString(h, ["name", "song", "track", "trackName", "title"]);
  const artist = firstString(h, ["artist", "artistName", "artist_name", "performer", "singer"]);
  const url = firstUrl(h, ["url", "link", "permalink", "href"]);
  const spotify = scanSpotify(h) || firstUrl(h, ["spotifyUrl", "spotify_url", "spotify"]);
  const seasonValue = firstString(h, ["season", "seasons"]);
  const id = firstString(h, ["objectID", "id", "_id"]);
  return {
    anime, kind, name, artist, url, spotify, seasonValue, id,
    rawKeys: Object.keys(h)
  };
}

function likelySong(h) {
  const keys = Object.keys(h).join(" ").toLowerCase();
  return /anime|song|track|artist|kind|spotify|type/.test(keys);
}

async function resolveSpotify(page, item) {
  if (!item.url || !item.url.startsWith("http")) return "";
  const key = item.url;
  if (resolveCache[key]?.spotify) return resolveCache[key].spotify;

  try {
    const response = await page.request.get(item.url, {
      timeout: 30000,
      failOnStatusCode: false,
      headers: { "user-agent": "Mozilla/5.0" }
    });
    const html = await response.text();
    const matches = [...html.matchAll(/https?:\/\/open\.spotify\.com\/(?:track|album|playlist|artist)\/[A-Za-z0-9]+/gi)];
    const spotify = matches[0]?.[0] || "";
    resolveCache[key] = { spotify, checkedAt: new Date().toISOString() };
    return spotify;
  } catch {
    resolveCache[key] = { spotify: "", checkedAt: new Date().toISOString() };
    return "";
  }
}

function rssEscape(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function makeItem(item, season) {
  const kind = item.kind || "Other";
  const title = `[${kind}] ${item.anime || "Unknown anime"} — ${item.name || "Unknown song"}`;
  const description = [
    item.anime && `Anime: ${item.anime}`,
    `Type: ${kind}`,
    item.name && `Song: ${item.name}`,
    item.artist && `Artist: ${item.artist}`,
    `Season: ${season}`,
  ].filter(Boolean).join("\n");
  const key = hash([season, item.anime, kind, item.name, item.artist, item.spotify].join("|"));
  const firstSeen = state[key]?.firstSeen || new Date().toISOString();
  state[key] = { firstSeen, ...item };
  return {
    key, title, description, link: item.spotify, guid: `aniplaylist:${key}`, pubDate: firstSeen
  };
}

function buildRss(season, items) {
  const channelTitle = `AniPlaylist — ${season}`;
  const now = new Date().toISOString();
  const entries = items
    .sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate))
    .map(i => `    <item>
      <title>${rssEscape(i.title)}</title>
      <description>${rssEscape(i.description)}</description>
      <link>${rssEscape(i.link)}</link>
      <guid isPermaLink="false">${rssEscape(i.guid)}</guid>
      <pubDate>${new Date(i.pubDate).toUTCString()}</pubDate>
    </item>`).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${rssEscape(channelTitle)}</title>
    <link>https://aniplaylist.com/?seasons=${encodeURIComponent(season)}</link>
    <description>New AniPlaylist entries for ${rssEscape(season)} with Spotify links.</description>
    <lastBuildDate>${new Date(now).toUTCString()}</lastBuildDate>
${entries}
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
  const diagnostics = {
    season,
    url: `https://aniplaylist.com/?seasons=${encodeURIComponent(season)}`,
    resultCount: null,
    jsonResponses: 0,
    algoliaResponses: 0,
    hitArrays: 0,
    hits: 0,
    normalized: 0,
    directSpotify: 0,
    resolvedSpotify: 0,
    bodyTextLength: 0,
    anchorsViaPlaywright: 0,
    linksViaPlaywright: [],
    responseUrls: [],
    sampleHitKeys: [],
    errors: [],
  };

  console.log(`\n=== ${season} ===`);
  console.log(`Loading ${diagnostics.url}`);

  const responseData = [];
  const handler = async (resp) => {
    const ct = (resp.headers()["content-type"] || "").toLowerCase();
    const u = resp.url();
    if (ct.includes("json") || /algolia|\/search(?:\/|\\?|$)|api/i.test(u)) {
      diagnostics.jsonResponses++;
      diagnostics.responseUrls.push(u.slice(0, 500));
      try {
        const text = await resp.text();
        if (text.length > 0 && text.length < 8_000_000) {
          const json = JSON.parse(text);
          if (/algolia/i.test(u)) diagnostics.algoliaResponses++;
          responseData.push({ url: u, json });
        }
      } catch {}
    }
  };
  page.on("response", handler);

  try {
    await page.goto(diagnostics.url, { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.waitForTimeout(8000);

    // Scroll to encourage any virtualized/infinite content to materialize.
    for (let i = 0; i < 15; i++) {
      await page.mouse.wheel(0, 1500);
      await page.waitForTimeout(300);
    }

    const bodyText = await page.locator("body").innerText().catch(() => "");
    diagnostics.bodyTextLength = bodyText.length;
    const m = bodyText.match(/([\d,]+)\s+results found/i);
    if (m) diagnostics.resultCount = Number(m[1].replace(/,/g, ""));
    console.log(`Result count from body: ${diagnostics.resultCount ?? "unknown"}`);

    diagnostics.anchorsViaPlaywright = await page.locator("a").count().catch(() => 0);
    diagnostics.linksViaPlaywright = await page.locator("a").evaluateAll(
      as => as.map(a => ({ href: a.href || "", text: (a.innerText || "").trim() }))
        .filter(x => x.href).slice(0, 100)
    ).catch(() => []);

    const cardCount = await page.locator(".song-card").count().catch(() => 0);
    console.log(`Playwright .song-card count: ${cardCount}`);
    console.log(`Playwright anchor count: ${diagnostics.anchorsViaPlaywright}`);

    await page.screenshot({ path: path.join(DEBUG_DIR, `${slug(season)}.png`), fullPage: true }).catch(() => {});

  } catch (e) {
    diagnostics.errors.push(`page: ${e.message}`);
  } finally {
    page.removeListener("response", handler);
  }

  const hitArrays = [];
  for (const r of responseData) {
    const arrays = deepFind(r.json, x => Array.isArray(x.hits) && x.hits.length > 0, 50);
    for (const x of arrays) hitArrays.push(x);
  }
  diagnostics.hitArrays = hitArrays.length;
  const rawHits = hitArrays.flatMap(x => x.hits || []);
  diagnostics.hits = rawHits.length;
  diagnostics.sampleHitKeys = rawHits.slice(0, 5).map(h => Object.keys(h));

  console.log(`JSON responses: ${diagnostics.jsonResponses}`);
  console.log(`Algolia-ish responses: ${diagnostics.algoliaResponses}`);
  console.log(`Hit arrays: ${diagnostics.hitArrays}`);
  console.log(`Hits: ${diagnostics.hits}`);
  console.log(`Sample hit keys: ${JSON.stringify(diagnostics.sampleHitKeys)}`);

  // Deduplicate hits by stable JSON/objectID.
  const dedupe = new Map();
  for (const h of rawHits) {
    if (!likelySong(h)) continue;
    const n = normaliseHit(h, season);
    if (!n.anime && !n.name && !n.url) continue;
    const key = n.id || hash(JSON.stringify(h));
    if (!dedupe.has(key)) dedupe.set(key, n);
  }
  const candidates = [...dedupe.values()];
  diagnostics.normalized = candidates.length;
  diagnostics.directSpotify = candidates.filter(x => !!x.spotify).length;

  const usable = [];
  for (const item of candidates) {
    const typeOk = !item.kind || TYPES.some(t => item.kind.toLowerCase().startsWith(t.toLowerCase())) || TYPE_RE.test(item.kind);
    if (!typeOk) continue;

    let spotify = item.spotify;
    if (!spotify && item.url) {
      spotify = await resolveSpotify(page, item);
    }
    if (spotify) {
      usable.push({ ...item, spotify });
    }
  }
  diagnostics.resolvedSpotify = usable.length;

  const rssItems = usable.map(i => makeItem(i, season));
  await fs.writeFile(path.join(RSS_DIR, `${slug(season)}.xml`), buildRss(season, rssItems));

  await fs.writeFile(
    path.join(DEBUG_DIR, `${slug(season)}.json`),
    JSON.stringify({
      ...diagnostics,
      responseUrls: diagnostics.responseUrls,
      linksViaPlaywright: diagnostics.linksViaPlaywright,
      samples: rawHits.slice(0, 10),
      normalizedCandidates: candidates.slice(0, 20),
      usable: usable.slice(0, 20),
    }, null, 2)
  );

  console.log(`${season}: resultCount=${diagnostics.resultCount ?? "?"} hits=${diagnostics.hits} normalized=${diagnostics.normalized} directSpotify=${diagnostics.directSpotify} resolvedSpotify=${diagnostics.resolvedSpotify}`);

  summary.push(diagnostics);
}

await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
await fs.writeFile(CACHE_PATH, JSON.stringify(resolveCache, null, 2) + "\n");
await browser.close();

const summaryText = summary.map(s =>
  `${s.season}: results=${s.resultCount ?? "?"} json=${s.jsonResponses} algolia=${s.algoliaResponses} hitArrays=${s.hitArrays} hits=${s.hits} normalized=${s.normalized} directSpotify=${s.directSpotify} resolvedSpotify=${s.resolvedSpotify}`
).join("\n");
await fs.writeFile(path.join(ROOT, "build-summary.txt"), summaryText + "\n");

const anyResults = summary.some(s => Number.isFinite(s.resultCount) && s.resultCount > 0);
const anyExtracted = summary.some(s => s.resolvedSpotify > 0);
if (anyResults && !anyExtracted) {
  console.error("AniPlaylist returned results, but no Spotify entries were extracted. Inspect debug/*.json and the network diagnostics.");
  process.exit(2);
}
