import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { chromium } from "playwright";

const ROOT = process.cwd();
const CFG = JSON.parse(await fs.readFile(path.join(ROOT, "seasons.json"), "utf8"));
const RSS_DIR = path.join(ROOT, "rss");
const DEBUG_DIR = path.join(ROOT, "debug");
const SITE_DIR = path.join(ROOT, "site");
const SONGS_DIR = path.join(SITE_DIR, "song");
const BROWSE_DIR = path.join(SITE_DIR, "browse");
const STATE_PATH = path.join(ROOT, "state.json");
const CACHE_PATH = path.join(ROOT, "resolve-cache.json");

await fs.mkdir(RSS_DIR, { recursive: true });
await fs.mkdir(DEBUG_DIR, { recursive: true });
await fs.mkdir(SONGS_DIR, { recursive: true });
await fs.mkdir(BROWSE_DIR, { recursive: true });

const SITE_BASE = String(
  process.env.SITE_BASE || "https://chintune.github.io/aniplaylist-rss"
).replace(/\/$/, "");

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
    thumbnail: findAniPlaylistThumbnail(hit.thumbnail)
      || findAniPlaylistThumbnail(hit.thumbnail_hash)
      || findAniPlaylistThumbnail(hit.blur_image),
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


function findAniPlaylistThumbnail(value, baseUrl = "https://aniplaylist.com", depth = 0) {
  if (value == null || depth > 10) return "";

  if (typeof value === "string") {
    const v = value.trim();
    if (!v || v.startsWith("data:") || v.startsWith("blob:")) return "";

    // Direct CDN/image URL.
    if (/^https?:\/\//i.test(v)) {
      if (/cdn\.aniplaylist\.com\/thumbnails\//i.test(v) || /\.(?:jpe?g|png|webp)(?:\?|$)/i.test(v)) {
        return v;
      }
      return "";
    }

    // AniPlaylist's current thumbnail records can expose the image as a
    // 40-character SHA-1-like hash. The site's CDN uses @2xl.jpg.
    if (/^[a-f0-9]{40,64}$/i.test(v)) {
      return `https://cdn.aniplaylist.com/thumbnails/${v}@2xl.jpg`;
    }

    // Current AniPlaylist Algolia records expose the image as a
    // relative path such as:
    //   thumbnails/5b4a1c4f93e24d5357ed3c39b671d41549beae04.jpg
    // The site's CDN uses the same hash with an @2xl suffix.
    const relativeThumb = v.match(/^thumbnails\/([^/?#]+)\.(jpe?g|png|webp)$/i);
    if (relativeThumb) {
      const hash = relativeThumb[1];
      const ext = relativeThumb[2].toLowerCase();
      return `https://cdn.aniplaylist.com/thumbnails/${hash}@2xl.${ext}`;
    }

    if (v.startsWith("/")) {
      try {
        return new URL(v, baseUrl).href;
      } catch {}
    }

    return "";
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findAniPlaylistThumbnail(item, baseUrl, depth + 1);
      if (found) return found;
    }
    return "";
  }

  if (typeof value === "object") {
    // Prefer thumbnail-specific fields.
    const preferredKeys = [
      "url", "src", "href", "image", "thumbnail", "thumbnail_url",
      "thumbnailUrl", "thumbnail_hash", "hash", "original", "large", "2xl"
    ];

    for (const key of preferredKeys) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        const found = findAniPlaylistThumbnail(value[key], baseUrl, depth + 1);
        if (found) return found;
      }
    }

    // Then scan remaining nested values.
    for (const nested of Object.values(value)) {
      const found = findAniPlaylistThumbnail(nested, baseUrl, depth + 1);
      if (found) return found;
    }
  }

  return "";
}

function thumbnailResolverSelfTest() {
  return findAniPlaylistThumbnail(
    "thumbnails/5b4a1c4f93e24d5357ed3c39b671d41549beae04.jpg"
  );
}

function firstUrl(value, depth = 0) {
  if (value == null || depth > 8) return "";
  if (typeof value === "string") {
    return /^https?:\/\//i.test(value) ? value.trim() : "";
  }
  if (Array.isArray(value)) {
    for (const v of value) {
      const u = firstUrl(v, depth + 1);
      if (u) return u;
    }
    return "";
  }
  if (typeof value === "object") {
    for (const v of Object.values(value)) {
      const u = firstUrl(v, depth + 1);
      if (u) return u;
    }
  }
  return "";
}

function prettyKind(kind) {
  const map = {
    OP: "Opening",
    ED: "Ending",
    IN: "Insert",
    OST: "OST",
    CS: "Character Song",
    VA: "Vocal Album",
    IMGA: "Image Album",
    IMGS: "Image Song",
    TS: "Theme Song",
    MV: "Music Video",
    PV: "PV Song",
  };
  return map[String(kind || "").toUpperCase()] || kind || "Other";
}

function platformButton(label, url, className) {
  if (!url) return "";
  return `<a class="platform ${className}" href="${htmlEscape(url)}" target="_blank" rel="noopener noreferrer"><span>${htmlEscape(label)}</span><span class="arrow">↗</span></a>`;
}


function extractMetaContent(html, propertyName) {
  const tags = html.match(/<meta\b[^>]*>/gi) || [];

  for (const tag of tags) {
    const propertyMatch =
      tag.match(/\bproperty\s*=\s*["']([^"']+)["']/i)
      || tag.match(/\bname\s*=\s*["']([^"']+)["']/i);

    if (!propertyMatch || propertyMatch[1].toLowerCase() !== propertyName.toLowerCase()) {
      continue;
    }

    const contentMatch = tag.match(/\bcontent\s*=\s*["']([^"']+)["']/i);
    if (contentMatch?.[1]) return contentMatch[1];
  }

  return "";
}

function normalizeImageUrl(url, baseUrl) {
  if (!url) return "";
  try {
    return new URL(url, baseUrl).href;
  } catch {
    return "";
  }
}

async function resolveImageFromDetail(page, item) {
  if (!item.detailUrl || !/^https?:\/\//i.test(item.detailUrl)) return "";

  // The direct record thumbnail remains preferred. The detail page is the
  // authoritative fallback for the exact song/anime page.
  if (item.thumbnail && /^https?:\/\//i.test(item.thumbnail)) {
    return item.thumbnail;
  }

  try {
    const res = await page.request.get(item.detailUrl, {
      timeout: 30000,
      failOnStatusCode: false,
      headers: { "user-agent": "Mozilla/5.0" },
    });

    if (!res.ok()) return "";

    const html = await res.text();

    const candidates = [
      extractMetaContent(html, "og:image"),
      extractMetaContent(html, "twitter:image"),
    ];

    for (const candidate of candidates) {
      const url = normalizeImageUrl(candidate, item.detailUrl);
      if (url) return url;
    }

    // As a final fallback, use a thumbnail path embedded in the page HTML.
    const thumbMatch = html.match(
      /(?:https?:\/\/cdn\.aniplaylist\.com\/)?thumbnails\/([a-f0-9]+)\.(jpe?g|png|webp)/i
    );

    if (thumbMatch) {
      const ext = thumbMatch[2].toLowerCase();
      return `https://cdn.aniplaylist.com/thumbnails/${thumbMatch[1]}@2xl.${ext}`;
    }
  } catch {}

  return "";
}

function buildSongPage(item, season, key) {
  const title = `[${item.kind || "Other"}] ${item.anime || "Unknown anime"}`;
  const anime = item.anime || "Unknown anime";
  const song = item.song || "Unknown song";
  const artist = item.artist || "";
  const thumb = normalizeImageUrl(item.thumbnail, SITE_BASE);
  const canonical = `${SITE_BASE}/song/${key}/`;

  const buttons = [
    platformButton("Spotify", item.spotify, "spotify"),
    platformButton("Apple Music", item.apple, "apple"),
  ].filter(Boolean).join("\n");

  const image = thumb
    ? `<img class="cover" src="${htmlEscape(thumb)}" alt="" loading="eager">`
    : `<div class="cover fallback">♪</div>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#0b0d12">
  <title>${htmlEscape(title)} — AniPlaylist RSS</title>
  <meta name="description" content="${htmlEscape(`${anime} · ${song}${artist ? ` · ${artist}` : ""} · ${prettyKind(item.kind)}`)}">
  <link rel="canonical" href="${htmlEscape(canonical)}">

  <meta property="og:type" content="music.song">
  <meta property="og:title" content="${htmlEscape(title)}">
  <meta property="og:description" content="${htmlEscape(`${song}${artist ? ` · ${artist}` : ""} · ${prettyKind(item.kind)} · ${season}`)}">
  <meta property="og:url" content="${htmlEscape(canonical)}">
  ${thumb ? `<meta property="og:image" content="${htmlEscape(thumb)}">` : ""}
  <meta property="og:site_name" content="AniPlaylist RSS">

  <meta name="twitter:card" content="${thumb ? "summary_large_image" : "summary"}">
  <meta name="twitter:title" content="${htmlEscape(title)}">
  <meta name="twitter:description" content="${htmlEscape(`${song}${artist ? ` · ${artist}` : ""} · ${prettyKind(item.kind)} · ${season}`)}">
  ${thumb ? `<meta name="twitter:image" content="${htmlEscape(thumb)}">` : ""}

  <style>
    :root {
      color-scheme: dark;
      --bg: #0b0d12;
      --panel: #131821;
      --border: #272f3b;
      --text: #f2f5f9;
      --muted: #9ca6b5;
      --purple: #8e72ff;
      --green: #5fd39b;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 24px;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background:
        radial-gradient(700px 420px at 0% 0%, rgba(142,114,255,.14), transparent 60%),
        radial-gradient(600px 400px at 100% 100%, rgba(95,211,155,.06), transparent 60%),
        var(--bg);
      color: var(--text);
    }

    .card {
      width: min(520px, 100%);
      overflow: hidden;
      border: 1px solid var(--border);
      border-radius: 22px;
      background: rgba(19,24,33,.96);
      box-shadow: 0 26px 80px rgba(0,0,0,.35);
    }

    .hero {
      aspect-ratio: 16 / 9;
      background: #171d27;
      overflow: hidden;
    }

    .cover {
      width: 100%;
      height: 100%;
      display: block;
      object-fit: cover;
    }

    .cover.fallback {
      display: grid;
      place-items: center;
      font-size: 72px;
      color: #7563d2;
    }

    .content {
      padding: 24px;
    }

    .badge {
      display: inline-flex;
      padding: 6px 10px;
      border-radius: 999px;
      background: rgba(142,114,255,.12);
      color: #c2b5ff;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: .03em;
    }

    h1 {
      margin: 15px 0 0;
      font-size: clamp(24px, 5vw, 32px);
      line-height: 1.12;
      letter-spacing: -.035em;
    }

    .song {
      margin: 10px 0 0;
      font-size: 17px;
      color: #d7dde6;
    }

    .artist {
      margin: 5px 0 0;
      color: var(--muted);
      font-size: 14px;
    }

    .meta {
      margin: 18px 0 0;
      color: var(--muted);
      font-size: 13px;
    }

    .platforms {
      display: grid;
      gap: 10px;
      margin-top: 20px;
    }

    .platform {
      display: flex;
      align-items: center;
      justify-content: space-between;
      min-height: 50px;
      padding: 0 15px;
      border-radius: 13px;
      text-decoration: none;
      font-weight: 700;
      color: white;
      transition: transform .15s ease, filter .15s ease;
    }

    .platform:hover {
      transform: translateY(-1px);
      filter: brightness(1.05);
    }

    .platform.spotify {
      background: linear-gradient(135deg, #1f9d61, #1db954);
    }

    .platform.apple {
      background: linear-gradient(135deg, #eb5b78, #ff2f58);
    }

    .arrow {
      font-size: 18px;
      opacity: .85;
    }

    .source {
      margin-top: 18px;
      padding-top: 16px;
      border-top: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      gap: 12px;
      color: #788394;
      font-size: 12px;
    }

    .source a {
      color: #a9b2bf;
      text-decoration: none;
    }

    .source a:hover { color: var(--text); }
  </style>
</head>
<body>
  <main class="card">
    <div class="hero">${image}</div>
    <div class="content">
      <div class="badge">${htmlEscape(prettyKind(item.kind))}</div>
      <h1>${htmlEscape(anime)}</h1>
      <div class="song">${htmlEscape(song)}</div>
      ${artist ? `<div class="artist">${htmlEscape(artist)}</div>` : ""}
      <div class="meta">${htmlEscape(season)}</div>

      <div class="platforms">
        ${buttons}
      </div>

      <div class="source">
        <span>AniPlaylist RSS</span>
        <a href="https://aniplaylist.com/" target="_blank" rel="noopener noreferrer">Source ↗</a>
      </div>
    </div>
  </main>
</body>
</html>`;
}

function htmlEscape(s) {
  return rssEscape(s);
}

function makePlatformHtml(label, url) {
  return `<p><strong>${htmlEscape(label)}</strong> — <a href="${htmlEscape(url)}">Open ${htmlEscape(label)}</a></p>`;
}

function browsePlatformButton(label, url, className) {
  if (!url) return "";
  return `<a class="platform ${className}" href="${htmlEscape(url)}" target="_blank" rel="noopener noreferrer">${htmlEscape(label)} ↗</a>`;
}

function buildBrowsePage(season, items) {
  const slugSeason = slug(season);
  const feedUrl = `${SITE_BASE}/rss/${slugSeason}.xml`;

  const cards = items
    .slice()
    .sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate))
    .map((item, index) => {
      const image = item.thumbnail
        ? `<img src="${htmlEscape(item.thumbnail)}" alt="" loading="${index < 4 ? "eager" : "lazy"}">`
        : `<div class="cover-fallback">♪</div>`;

      const platforms = [
        browsePlatformButton("Spotify", item.spotify, "spotify"),
        browsePlatformButton("Apple Music", item.apple, "apple"),
      ].filter(Boolean).join("\n");

      const dateText = Number.isFinite(new Date(item.pubDate).getTime())
        ? new Date(item.pubDate).toLocaleDateString("en", {
            year: "numeric",
            month: "short",
            day: "numeric",
          })
        : "";

      return `
        <article class="song-card">
          <div class="rank">${index + 1}</div>
          <div class="art">${image}</div>
          <div class="song-main">
            <div class="song-head">
              <span class="kind">${htmlEscape(item.kind || "Other")}</span>
              <span class="date">${htmlEscape(dateText)}</span>
            </div>
            <h2>${htmlEscape(item.anime || "Unknown anime")}</h2>
            <div class="song-title">${htmlEscape(item.song || "Unknown song")}</div>
            ${item.artist ? `<div class="artist">${htmlEscape(item.artist)}</div>` : ""}
            <div class="platforms">${platforms}</div>
            <a class="details" href="${SITE_BASE}/song/${htmlEscape(item.key)}/">Song page ↗</a>
          </div>
        </article>
      `;
    }).join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#0b0d12">
  <title>${htmlEscape(`AniPlaylist RSS — ${season}`)}</title>
  <meta name="description" content="${htmlEscape(`AniPlaylist ${season} releases with Spotify and Apple Music links.`)}">
  <style>
    :root {
      color-scheme: dark;
      --bg: #0b0d12;
      --panel: #121720;
      --panel-2: #171d28;
      --border: #262e3b;
      --text: #eef2f7;
      --muted: #9da7b5;
      --accent: #9d7bff;
      --green: #5fd39b;
      --apple: #ff4f73;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--text);
      background:
        radial-gradient(850px 450px at 0% -5%, rgba(157,123,255,.13), transparent 60%),
        radial-gradient(650px 430px at 100% 20%, rgba(95,211,155,.05), transparent 62%),
        var(--bg);
    }
    .wrap { width: min(980px, calc(100% - 28px)); margin: 0 auto; }
    header { padding: 48px 0 24px; }
    .back {
      display: inline-flex;
      color: var(--muted);
      text-decoration: none;
      font-size: 13px;
      margin-bottom: 18px;
    }
    .back:hover { color: var(--text); }
    .eyebrow {
      display: inline-flex;
      align-items: center;
      padding: 6px 10px;
      border-radius: 999px;
      background: rgba(157,123,255,.10);
      color: #c5b8ff;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: .03em;
    }
    h1 {
      margin: 14px 0 0;
      font-size: clamp(30px, 5vw, 48px);
      line-height: 1;
      letter-spacing: -.04em;
    }
    .sub {
      margin: 12px 0 0;
      color: var(--muted);
      font-size: 15px;
    }
    .top-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 9px;
      margin-top: 18px;
    }
    .top-actions a {
      display: inline-flex;
      align-items: center;
      min-height: 38px;
      padding: 0 13px;
      border-radius: 10px;
      text-decoration: none;
      border: 1px solid var(--border);
      color: #dbe1e9;
      background: #131821;
      font-size: 13px;
    }
    .top-actions a.primary {
      background: linear-gradient(135deg, #735edf, #9d7bff);
      color: white;
      border-color: transparent;
      font-weight: 600;
    }
    main { padding: 6px 0 56px; }
    .song-list {
      display: grid;
      gap: 13px;
    }
    .song-card {
      position: relative;
      display: grid;
      grid-template-columns: 34px 118px minmax(0, 1fr);
      gap: 14px;
      align-items: stretch;
      padding: 12px;
      border: 1px solid var(--border);
      border-radius: 18px;
      background: linear-gradient(180deg, rgba(23,29,40,.96), rgba(18,23,32,.96));
      box-shadow: 0 14px 45px rgba(0,0,0,.18);
      overflow: hidden;
    }
    .rank {
      align-self: start;
      display: grid;
      place-items: center;
      width: 28px;
      height: 28px;
      border-radius: 9px;
      background: #1a202b;
      color: #8994a4;
      font-size: 12px;
      font-weight: 700;
      margin-top: 2px;
    }
    .art {
      width: 118px;
      height: 118px;
      border-radius: 13px;
      overflow: hidden;
      background: #1a202b;
    }
    .art img {
      width: 100%;
      height: 100%;
      display: block;
      object-fit: cover;
    }
    .cover-fallback {
      width: 100%;
      height: 100%;
      display: grid;
      place-items: center;
      color: #7565d0;
      font-size: 44px;
      background: linear-gradient(145deg, #171d28, #20263a);
    }
    .song-main { min-width: 0; }
    .song-head {
      display: flex;
      align-items: center;
      gap: 9px;
      flex-wrap: wrap;
    }
    .kind {
      padding: 5px 8px;
      border-radius: 999px;
      background: rgba(95,211,155,.09);
      color: #8be0b3;
      font-size: 11px;
      font-weight: 700;
    }
    .date {
      color: #737e8d;
      font-size: 11px;
    }
    h2 {
      margin: 8px 0 0;
      font-size: clamp(17px, 2.3vw, 22px);
      line-height: 1.15;
      letter-spacing: -.025em;
    }
    .song-title {
      margin-top: 6px;
      color: #d9dee6;
      font-size: 15px;
      line-height: 1.35;
    }
    .artist {
      margin-top: 4px;
      color: var(--muted);
      font-size: 13px;
    }
    .platforms {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 13px;
    }
    .platform {
      display: inline-flex;
      align-items: center;
      min-height: 34px;
      padding: 0 11px;
      border-radius: 9px;
      text-decoration: none;
      color: white;
      font-size: 12px;
      font-weight: 700;
    }
    .platform.spotify { background: #1db954; }
    .platform.apple { background: linear-gradient(135deg, #ff496b, #d9438a); }
    .details {
      display: inline-block;
      margin-top: 9px;
      color: #7e8999;
      text-decoration: none;
      font-size: 12px;
    }
    .details:hover { color: var(--text); }
    footer {
      padding-bottom: 34px;
      color: #687383;
      font-size: 12px;
    }
    @media (max-width: 680px) {
      .song-card { grid-template-columns: 28px 92px minmax(0,1fr); gap: 11px; }
      .art { width: 92px; height: 92px; }
      .rank { width: 25px; height: 25px; }
    }
    @media (max-width: 500px) {
      .song-card { grid-template-columns: 26px 78px minmax(0,1fr); }
      .art { width: 78px; height: 78px; }
      h2 { font-size: 16px; }
      .song-title { font-size: 14px; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <header>
      <a class="back" href="${SITE_BASE}/">← All seasons</a>
      <div class="eyebrow">AniPlaylist RSS</div>
      <h1>${htmlEscape(season)}</h1>
      <div class="sub">${items.length} ${items.length === 1 ? "release" : "releases"} · newest first</div>
      <div class="top-actions">
        <a class="primary" href="${feedUrl}">RSS feed ↗</a>
        <a href="https://aniplaylist.com/?seasons=${encodeURIComponent(season)}" target="_blank" rel="noopener noreferrer">AniPlaylist ↗</a>
      </div>
    </header>

    <main>
      <div class="song-list">
        ${cards || `<div style="padding:24px;color:#9da7b5;border:1px solid #262e3b;border-radius:16px;background:#121720;">No Spotify or Apple Music entries yet.</div>`}
      </div>
    </main>

    <footer>AniPlaylist RSS · ${htmlEscape(season)}</footer>
  </div>
</body>
</html>`;
}

function buildBrowseRedirectPage(season, items) {
  // Kept as a separate helper so future layouts can be swapped without
  // changing RSS generation.
  return buildBrowsePage(season, items);
}

async function makeRssItem(item, season) {
  const kind = item.kind || "Other";
  const title = `[${kind}] ${item.anime || "Unknown anime"}`;

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

  const relativePage = `song/${key}/`;
  const pageDir = path.join(SITE_DIR, relativePage);
  await fs.mkdir(pageDir, { recursive: true });
  await fs.writeFile(
    path.join(pageDir, "index.html"),
    buildSongPage(item, season, key)
  );

  const pageUrl = `${SITE_BASE}/${relativePage}`;

  const descriptionLines = [
    item.song ? `Song: ${item.song}` : "",
    item.artist ? `Artist: ${item.artist}` : "",
    `Open the item page for Spotify and Apple Music.`,
  ].filter(Boolean);

  return {
    title,
    description: descriptionLines.join("\n"),
    link: pageUrl,
    guid: `aniplaylist:${key}`,
    pubDate: firstSeen,
    key,
    anime: item.anime,
    song: item.song,
    artist: item.artist,
    kind: item.kind,
    thumbnail: item.thumbnail,
    spotify: item.spotify,
    apple: item.apple,
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
    <description>New AniPlaylist entries for ${rssEscape(season)}. Each item links to a page with Spotify and Apple Music options.</description>
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
console.log(`Thumbnail resolver self-test: ${thumbnailResolverSelfTest()}`);

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
    recordThumbnails: 0,
    detailImagesResolved: 0,
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
  diag.thumbnailFieldSamples = rawHits.slice(0, 12).map(h => ({
    id: h.objectID ?? h.id ?? "",
    thumbnailType: Array.isArray(h.thumbnail) ? "array" : typeof h.thumbnail,
    thumbnail: h.thumbnail,
    thumbnailHashType: Array.isArray(h.thumbnail_hash) ? "array" : typeof h.thumbnail_hash,
    thumbnail_hash: h.thumbnail_hash,
    blurImageType: Array.isArray(h.blur_image) ? "array" : typeof h.blur_image,
    blur_image: h.blur_image,
    resolved: findAniPlaylistThumbnail(h.thumbnail)
      || findAniPlaylistThumbnail(h.thumbnail_hash)
      || findAniPlaylistThumbnail(h.blur_image)
      || ""
  }));

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
  diag.recordThumbnails = normalized.filter(x => !!x.thumbnail).length;
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

  // For the small set that actually enters the RSS feed, resolve the image
  // from the exact AniPlaylist detail page when the record did not give us a
  // usable absolute image URL. This avoids title/card matching and guarantees
  // the image belongs to the same song page.
  for (const item of usable) {
    if (!item.thumbnail || !/^https?:\/\//i.test(item.thumbnail)) {
      const image = await resolveImageFromDetail(page, item);
      if (image) {
        item.thumbnail = image;
        diag.detailImagesResolved++;
      }
    }
  }

  diag.resolvedSpotify = usable.filter(item => !!item.spotify).length;
  console.log(`Entries accepted from record itself (Spotify or Apple Music): ${usable.length}`);
  console.log(`Spotify accepted: ${diag.resolvedSpotify}`);
  console.log(`Apple Music accepted: ${usable.filter(item => !!item.apple).length}`);
  console.log(`Images resolved from exact AniPlaylist pages: ${diag.detailImagesResolved}`);

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

  const rssItems = await Promise.all(usable.map(x => makeRssItem(x, season)));

  const browsePath = path.join(BROWSE_DIR, slug(season), "index.html");
  await fs.mkdir(path.dirname(browsePath), { recursive: true });
  await fs.writeFile(
    browsePath,
    buildBrowsePage(season, rssItems)
  );

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
