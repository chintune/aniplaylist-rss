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

/*
 * Spotify source of truth for the CURRENT scrape only.
 *
 * This is intentionally separate from state.json.
 * state.json is historical and must never be used to determine
 * what belongs in the current Spotify playlists.
 */
const SPOTIFY_CURRENT_PATH = path.join(ROOT, "spotify-current.json");
const SPOTIFY_PLAYLISTS_PATH = path.join(ROOT, "spotify-playlists.json");
const currentSpotifyTracks = {};
let spotifyPlaylists = {};
try {
  spotifyPlaylists = JSON.parse(await fs.readFile(SPOTIFY_PLAYLISTS_PATH, "utf8"));
} catch {
  spotifyPlaylists = {};
}

await fs.mkdir(RSS_DIR, { recursive: true });
await fs.mkdir(DEBUG_DIR, { recursive: true });
await fs.mkdir(SONGS_DIR, { recursive: true });
await fs.mkdir(BROWSE_DIR, { recursive: true });

const SITE_BASE = String(
  process.env.SITE_BASE || "https://chintu-io.github.io/aniplaylist-rss"
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

function formatArtistNames(values) {
  const names = unique((values || []).map(clean).filter(isLikelyArtistDisplay));
  if (names.length < 2) return names[0] || "";
  if (names.length === 2) return names[0] + " & " + names[1];
  return names.slice(0, -1).join(", ") + " & " + names[names.length - 1];
}

function sourceKindLabel(hit, kind) {
  // Preserve source labels such as "Insert (ep 3)" rather than only "IN".
  const candidates = [
    ...collectStrings(hit.type),
    ...collectStrings(hit.song_type),
    ...collectStrings(hit.label),
    ...collectStrings(hit.tags),
  ].map(clean).filter(Boolean);
  const pattern = /^(opening|ending|insert(?:ion)?(?:\s+song)?|theme\s+song|ost|original soundtrack|character song|vocal album|image album|image song|music video|pv song)\b/i;
  const labels = candidates.filter(value => pattern.test(value));
  const detailed = labels.find(value =>
    /\b(?:ep|episode)\s*\.?\s*#?\s*\d+\b/i.test(value)
    || /\(\s*ep\b[^)]*\)/i.test(value)
  );
  return detailed || labels[0] || prettyKind(kind) || kind || "Other";
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

  // Keep the primary artist stable for RSS identity and playlist sync, while
  // retaining the full collaboration credit for the website display.
  const artist = displayArtists.find(isLikelyArtistDisplay)
    || artists.find(isLikelyArtistDisplay)
    || textFrom(hit.artist, ["name", "artist"]);
  const artistDisplay = formatArtistNames(displayArtists) || artist;

  const kind = clean(
    hit.song_type_short
    || hit.song_type
    || hit.type
    || ""
  );
  const kindLabel = sourceKindLabel(hit, kind);

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
    artistDisplay,
    kind,
    kindLabel,
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
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
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
  const videoUrl = item.animethemesVideo?.url || "";

  const spotifyIcon = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.4a9.6 9.6 0 1 0 0 19.2 9.6 9.6 0 0 0 0-19.2Zm4.1 13.6a.58.58 0 0 1-.8.2c-2.2-1.35-4.97-1.65-8.24-.91a.58.58 0 1 1-.26-1.13c3.58-.82 6.65-.48 9.14 1.03.28.17.37.53.16.81Zm1.12-2.51a.72.72 0 0 1-.99.24c-2.51-1.54-6.35-1.99-9.32-1.08a.72.72 0 1 1-.42-1.38c3.4-1.04 7.65-.54 10.48 1.19.34.21.45.66.25 1.03Zm.1-2.65c-3.01-1.78-7.97-1.95-10.85-1.08a.87.87 0 1 1-.5-1.67c3.31-1 8.8-.81 12.29 1.26a.87.87 0 0 1-.94 1.49Z"/></svg>';
  const appleIcon = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M15.9 12.8c0-2 1.6-3 1.7-3.1-.9-1.3-2.4-1.5-2.9-1.5-1.2-.1-2.3.7-2.9.7-.6 0-1.5-.7-2.5-.7-1.3 0-2.5.8-3.2 1.9-1.4 2.3-.4 5.7 1 7.5.7.9 1.4 1.9 2.5 1.8 1 0 1.4-.6 2.6-.6 1.2 0 1.5.6 2.6.6 1.1 0 1.8-.9 2.5-1.8.8-1 1.1-2.1 1.1-2.2-.1 0-2.1-.8-2.5-2.6Zm-1.9-5.8c.5-.7.9-1.7.8-2.7-.9 0-1.9.6-2.5 1.3-.5.6-.9 1.6-.8 2.5 1 .1 1.9-.4 2.5-1.1Z"/></svg>';
  const watchIcon = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.3v13.4a1.1 1.1 0 0 0 1.68.94l9.8-6.7a1.12 1.12 0 0 0 0-1.88l-9.8-6.7A1.1 1.1 0 0 0 8 5.3Z"/></svg>';
  const action = (url, cls, icon, label, watch = false) => url
    ? '<a class="icon-action ' + cls + '" href="' + htmlEscape(url) + '"' +
      (watch ? ' data-watch-trigger="true" data-watch-url="' + htmlEscape(url) + '"' : ' target="_blank" rel="noopener noreferrer"') +
      ' title="' + htmlEscape(label) + '" aria-label="' + htmlEscape(label) + '">' +
      icon + '<span class="sr-only">' + htmlEscape(label) + '</span></a>'
    : "";

  const buttons = [
    action(item.spotify, "spotify", spotifyIcon, "Open on Spotify"),
    action(item.apple, "apple", appleIcon, "Open on Apple Music"),
    videoUrl ? action(videoUrl, "watch", watchIcon, "Watch AnimeThemes video", true) : "",
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
      --bg: #090711;
      --line: rgba(255,255,255,.09);
      --line2: rgba(255,255,255,.14);
      --text: #f7f3ff;
      --muted: #aaa2b5;
      --muted2: #766d82;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      color: var(--text);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background:
        radial-gradient(900px 540px at 8% -10%, rgba(169,120,255,.2), transparent 60%),
        radial-gradient(800px 520px at 100% 18%, rgba(255,92,168,.1), transparent 60%),
        linear-gradient(180deg, #090711, #0c0912 52%, #090711);
    }
    body::before {
      content: "";
      position: fixed;
      inset: 0;
      pointer-events: none;
      opacity: .15;
      background-image:
        linear-gradient(rgba(255,255,255,.02) 1px, transparent 1px),
        linear-gradient(90deg, rgba(255,255,255,.014) 1px, transparent 1px);
      background-size: 42px 42px;
    }
    a { color: inherit; }
    .page { width: min(1160px, calc(100% - 28px)); margin: 0 auto; padding: 22px 0 46px; }
    .topbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 16px; }
    .back { color: var(--muted); text-decoration: none; font-size: 11px; font-weight: 800; }
    .back:hover { color: #fff; }
    .card {
      width: min(900px, 100%);
      margin: 0 auto;
      overflow: hidden;
      border: 1px solid var(--line);
      border-radius: 24px;
      background: linear-gradient(145deg, rgba(23,18,37,.97), rgba(10,8,17,.98));
      box-shadow: 0 30px 100px rgba(0,0,0,.4);
    }
    .hero {
      position: relative;
      width: 100%;
      min-height: 360px;
      display: grid;
      place-items: center;
      padding: 22px;
      overflow: hidden;
      background:
        radial-gradient(circle at 45% 20%, rgba(169,120,255,.17), transparent 40%),
        linear-gradient(145deg, rgba(18,13,28,.98), rgba(8,6,13,.99));
    }
    .hero::after {
      content: "";
      position: absolute;
      inset: 10%;
      border-radius: 50%;
      background: radial-gradient(circle, rgba(169,120,255,.12), transparent 64%);
      filter: blur(26px);
      pointer-events: none;
    }
    .cover {
      position: relative;
      z-index: 1;
      width: min(100%, 330px);
      max-height: 360px;
      aspect-ratio: 1;
      display: block;
      object-fit: cover;
      border-radius: 18px;
      box-shadow: 0 24px 70px rgba(0,0,0,.42);
    }
    .cover.fallback {
      width: min(75%, 420px);
      aspect-ratio: 1;
      display: grid;
      place-items: center;
      border-radius: 20px;
      font-size: 94px;
      color: #a27dff;
      background: linear-gradient(145deg, #171126, #0d0a15);
    }
    .content { padding: 28px 32px 30px; }
    .badge {
      display: inline-flex;
      align-items: center;
      min-height: 29px;
      padding: 0 10px;
      border: 1px solid rgba(169,120,255,.24);
      border-radius: 999px;
      background: rgba(169,120,255,.08);
      color: #d1bcff;
      font-size: 9px;
      font-weight: 900;
      letter-spacing: .13em;
      text-transform: uppercase;
    }
    h1 { margin: 14px 0 0; font-size: clamp(25px, 4vw, 42px); line-height: 1; letter-spacing: -.055em; }
    .song { margin: 11px 0 0; color: #e2dae9; font-size: 17px; line-height: 1.45; font-weight: 800; }
    .artist { margin-top: 5px; color: var(--muted); font-size: 13px; }
    .meta { margin-top: 16px; color: var(--muted2); font-size: 10px; font-weight: 900; letter-spacing: .1em; text-transform: uppercase; }
    .platforms { display: flex; flex-wrap: wrap; gap: 9px; margin-top: 23px; }
    .icon-action {
      position: relative;
      display: inline-grid;
      place-items: center;
      width: 46px;
      height: 46px;
      border: 1px solid transparent;
      border-radius: 13px;
      color: #fff;
      text-decoration: none;
      box-shadow: 0 12px 32px rgba(0,0,0,.16);
      transition: transform .15s ease, filter .15s ease;
    }
    .icon-action:hover { transform: translateY(-2px) scale(1.02); filter: brightness(1.07); }
    .icon-action svg { width: 22px; height: 22px; }
    .icon-action.spotify { background: linear-gradient(135deg, #17b85a, #1ed760); }
    .icon-action.apple { background: linear-gradient(135deg, #ff466f, #c92f87); }
    .icon-action.watch { background: linear-gradient(135deg, #5f71ff, #8f62ff); }
    .source {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 22px;
      padding-top: 18px;
      border-top: 1px solid var(--line);
    }
    .source a {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      min-height: 34px;
      padding: 0 10px;
      border: 1px solid var(--line);
      border-radius: 10px;
      background: rgba(255,255,255,.025);
      color: #958b9e;
      text-decoration: none;
      font-size: 10px;
      font-weight: 800;
    }
    .source a:hover { color: #fff; border-color: var(--line2); }
    .source a:first-child::before { content: "◔"; opacity: .8; }
    .source a + a::before { content: "↗"; opacity: .7; }
    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0,0,0,0);
      white-space: nowrap;
      border: 0;
    }
    .song-watch-modal {
      position: fixed; inset: 0; z-index: 100; display: grid; place-items: center;
      padding: 16px; background: rgba(5,3,9,.82); backdrop-filter: blur(18px);
    }
    .song-watch-modal[hidden] { display: none !important; }
    .song-watch-dialog {
      width: min(1040px, 100%); max-height: calc(100vh - 32px); overflow: auto;
      border: 1px solid var(--line2); border-radius: 22px; background: #0e0a16;
      box-shadow: 0 45px 140px rgba(0,0,0,.54);
    }
    .song-watch-head {
      display: flex; align-items: flex-start; justify-content: space-between; gap: 14px;
      padding: 16px 18px; border-bottom: 1px solid var(--line);
    }
    .song-watch-kicker { color: #a89dab; font-size: 9px; font-weight: 900; text-transform: uppercase; letter-spacing: .12em; }
    .song-watch-title { margin-top: 4px; font-size: 18px; font-weight: 900; }
    .song-watch-song { margin-top: 3px; color: #aaa1b3; font-size: 11px; }
    .song-watch-close {
      width: 36px; height: 36px; border: 1px solid var(--line); border-radius: 10px;
      background: rgba(255,255,255,.04); color: #aaa1b4; cursor: pointer; font-size: 17px;
    }
    .song-watch-video-wrap { padding: 12px; }
    .song-watch-video-wrap video { display: block; width: 100%; max-height: 74vh; border-radius: 14px; background: #050308; }
    .song-watch-direct { display: inline-flex; margin: 0 12px 14px; color: #c9b7ff; text-decoration: none; font-size: 10px; font-weight: 800; }

    @media (max-width: 640px) {
      body { padding: 0; }
      .page { width: min(100%, calc(100% - 16px)); padding-top: 10px; }
      .card { border-radius: 20px; }
      .hero { padding: 12px; }
      .cover { width: min(100%, 300px); max-height: 48vh; border-radius: 14px; }
      .content { padding: 24px 18px 22px; }
      h1 { font-size: 34px; }
      .icon-action { width: 43px; height: 43px; }
    }
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
        <a href="${SITE_BASE}/rss/${slug(season)}.xml">RSS feed</a>
        <a href="${SITE_BASE}/browse/${slug(season)}/">Season hub</a>
        <a href="https://aniplaylist.com/" target="_blank" rel="noopener noreferrer">AniPlaylist</a>
      </div>
    </div>
  </main>

  ${videoUrl ? `
  <div id="song-watch-modal" class="song-watch-modal" hidden>
    <div class="song-watch-dialog" role="dialog" aria-modal="true" aria-labelledby="song-watch-title">
      <div class="song-watch-head">
        <div>
          <div class="song-watch-kicker">AnimeThemes · ${htmlEscape(prettyKind(item.kind))}</div>
          <div id="song-watch-title" class="song-watch-title">${htmlEscape(anime)}</div>
          <div class="song-watch-song">${htmlEscape(song)}</div>
        </div>
        <button id="song-watch-close" class="song-watch-close" type="button" aria-label="Close video">×</button>
      </div>
      <div class="song-watch-video-wrap">
        <video id="song-watch-video" controls playsinline preload="metadata"></video>
      </div>
      <a class="song-watch-direct" href="${htmlEscape(videoUrl)}" target="_blank" rel="noopener noreferrer">Open direct AnimeThemes video ↗</a>
    </div>
  </div>

  <script>
    (() => {
      const modal = document.getElementById("song-watch-modal");
      const video = document.getElementById("song-watch-video");
      const closeButton = document.getElementById("song-watch-close");
      const trigger = document.querySelector("[data-watch-trigger]");

      function closePlayer() {
        if (video) { video.pause(); video.removeAttribute("src"); video.load(); }
        if (modal) modal.hidden = true;
        document.body.style.overflow = "";
        trigger?.focus();
      }

      function openPlayer() {
        if (!trigger || !video || !modal) return;
        const url = trigger.dataset.watchUrl || "";
        if (!url) return;
        video.src = url;
        modal.hidden = false;
        document.body.style.overflow = "hidden";
        const play = video.play();
        if (play?.catch) play.catch(() => {});
      }

      trigger?.addEventListener("click", event => { event.preventDefault(); openPlayer(); });
      closeButton?.addEventListener("click", closePlayer);
      modal?.addEventListener("click", event => { if (event.target === modal) closePlayer(); });
      document.addEventListener("keydown", event => {
        if (event.key === "Escape" && modal && !modal.hidden) closePlayer();
      });
    })();
  </script>
  ` : ""}
</body>
</html>`;
}

function htmlEscape(s) {
  return rssEscape(s);
}

function makePlatformHtml(label, url) {
  return `<p><strong>${htmlEscape(label)}</strong> — <a href="${htmlEscape(url)}">Open ${htmlEscape(label)}</a></p>`;
}

function browsePlatformIcon(className) {
  const icons = {
    spotify: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.4a9.6 9.6 0 1 0 0 19.2 9.6 9.6 0 0 0-9.6-9.6Zm4.1 13.6a.58.58 0 0 1-.8.2c-2.2-1.35-4.97-1.65-8.24-.91a.58.58 0 1 1-.26-1.13c3.58-.82 6.65-.48 9.14 1.03.28.17.37.53.16.81Zm1.12-2.51a.72.72 0 0 1-.99.24c-2.51-1.54-6.35-1.99-9.32-1.08a.72.72 0 1 1-.42-1.38c3.4-1.04 7.65-.54 10.48 1.19.34.21.45.66.25 1.03Zm.1-2.65c-3.01-1.78-7.97-1.95-10.85-1.08a.87.87 0 1 1-.5-1.67c3.31-1 8.8-.81 12.29 1.26a.87.87 0 0 1-.94 1.49Z"/></svg>',
    apple: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M15.9 12.8c0-2 1.6-3 1.7-3.1-.9-1.3-2.4-1.5-2.9-1.5-1.2-.1-2.3.7-2.9.7-.6 0-1.5-.7-2.5-.7-1.3 0-2.5.8-3.2 1.9-1.4 2.3-.4 5.7 1 7.5.7.9 1.4 1.9 2.5 1.8 1 0 1.4-.6 2.6-.6 1.2 0 1.5.6 2.6.6 1.1 0 1.8-.9 2.5-1.8.8-1 1.1-2.1 1.1-2.2-.1 0-2.1-.8-2.5-2.6Zm-1.9-5.8c.5-.7.9-1.7.8-2.7-.9 0-1.9.6-2.5 1.3-.5.6-.9 1.6-.8 2.5 1 .1 1.9-.4 2.5-1.1Z"/></svg>',
    watch: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.3v13.4a1.1 1.1 0 0 0 1.68.94l9.8-6.7a1.12 1.12 0 0 0 0-1.88l-9.8-6.7A1.1 1.1 0 0 0 8 5.3Z"/></svg>',
  };
  return icons[className] || "";
}

function browsePlatformButton(label, url, className) {
  if (!url) return "";
  const icon = browsePlatformIcon(className);
  const aria = "Open " + label;
  return `<a class="platform ${className} icon-only" href="${htmlEscape(url)}" target="_blank" rel="noopener noreferrer" title="${htmlEscape(aria)}" aria-label="${htmlEscape(aria)}">${icon}<span class="sr-only">${htmlEscape(label)}</span></a>`;
}


const JAPANESE_TITLE_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uff66-\uff9f]/;

const ENGLISH_HINTS = new Set([
  "a", "an", "the", "and", "or", "of", "to", "in", "on", "with", "from",
  "for", "is", "are", "be", "my", "your", "our", "world", "worlds",
  "strongest", "witch", "secret", "saint", "tale", "great", "reincarnated",
  "limitless", "influence", "idol", "days", "season", "story", "dream",
  "star", "stars", "night", "moon", "sun", "love", "heart", "life",
  "girl", "girls", "boy", "boys", "school", "hero", "heroes", "magic",
  "king", "queen", "road", "brick", "flower", "flowers", "song", "songs",
]);

const ROMAJI_HINTS = new Set([
  "no", "wa", "ga", "wo", "o", "ni", "de", "to", "mo", "he", "kara", "made",
  "nara", "ne", "yo", "desu", "masu", "shita", "shite", "suru", "seka",
  "sekai", "majo", "hajimemashita", "tensei", "reijou", "jou", "kanashii",
  "bokura", "kimi", "boku", "watashi", "kokoro", "hoshi", "meguru",
  "eikyouroku", "saikyou", "uta", "yoru", "kaze", "hana",
]);

function hasJapaneseScript(value) {
  return JAPANESE_TITLE_RE.test(String(value || ""));
}

function isLikelyArtistDisplay(value) {
  const s = clean(value);
  if (!s) return false;
  if (/^\d+$/.test(s)) return false;
  if (/^[A-Za-z0-9_-]{16,}$/.test(s) && !/\s/.test(s)) return false;
  return true;
}

function titleVariantScore(value, mode) {
  const text = normalizeForMatch(value);
  if (!text) return -Infinity;

  const words = text.split(" ").filter(Boolean);
  const englishHits = words.filter(w => ENGLISH_HINTS.has(w)).length;
  const romajiHits = words.filter(w => ROMAJI_HINTS.has(w)).length;

  if (mode === "english") {
    return (englishHits * 6)
      - (romajiHits * 4)
      + (words.length > 1 ? 1 : 0)
      + (/^[A-Za-z0-9 .,'’!?:+&-]+$/.test(String(value || "")) ? 1 : 0);
  }

  if (mode === "romaji") {
    return (romajiHits * 6)
      - (englishHits * 4)
      + (/[aeiou]/i.test(String(value || "")) ? 1 : 0);
  }

  return 0;
}

function chooseBestCandidate(candidates, mode, exclude = "") {
  const pool = unique(candidates).filter(v => v && v !== exclude && !hasJapaneseScript(v));
  if (!pool.length) return "";

  return pool
    .map((value, index) => ({
      value,
      score: titleVariantScore(value, mode),
      index,
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)[0].value;
}

function getTitleVariants(candidates, fallback = "") {
  const all = unique([...(Array.isArray(candidates) ? candidates : []), fallback]).filter(Boolean);
  if (!all.length) {
    return { english: "", romaji: "", japanese: "" };
  }

  const japanese = all.find(hasJapaneseScript) || "";
  const latin = all.filter(v => !hasJapaneseScript(v));

  let english = chooseBestCandidate(latin, "english");
  let romaji = chooseBestCandidate(latin, "romaji", english);

  if (!english) english = latin[0] || fallback || japanese;
  if (!romaji) romaji = latin.find(v => v !== english) || english || fallback || japanese;

  if (latin.length === 1) {
    english = latin[0];
    romaji = latin[0];
  }

  return {
    english: english || fallback || romaji || japanese,
    romaji: romaji || fallback || english || japanese,
    japanese: japanese || fallback || english || romaji,
  };
}


const ANIMETHEMES_INCLUDE =
  "animesynonyms,animethemes.animethemeentries.videos,animethemes.song,animethemes.song.artists";

function animeThemesNormalize(value) {
  return String(value || "")
    .toLocaleLowerCase()
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\u3040-\u30ff\u3400-\u9fff]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function animeThemesScore(query, candidate) {
  const a = animeThemesNormalize(query);
  const b = animeThemesNormalize(candidate);
  if (!a || !b) return 0;
  if (a === b) return 1000;

  const compactA = a.replace(/\s+/g, "");
  const compactB = b.replace(/\s+/g, "");

  if (compactA && compactA === compactB) return 950;
  if (a.includes(b) || b.includes(a)) return 650;

  const aw = new Set(a.split(" ").filter(Boolean));
  const bw = new Set(b.split(" ").filter(Boolean));
  let overlap = 0;
  for (const word of aw) if (bw.has(word)) overlap++;
  return overlap ? 300 * overlap / Math.max(aw.size, bw.size) : 0;
}

function animeThemesBestScore(queries, candidates) {
  let best = 0;
  for (const query of queries || []) {
    for (const candidate of candidates || []) {
      best = Math.max(best, animeThemesScore(query, candidate));
    }
  }
  return best;
}

function animeThemeArtistNames(theme) {
  const names = [];

  if (Array.isArray(theme?.song?.performances)) {
    for (const performance of theme.song.performances) {
      names.push(performance?.as);
      names.push(performance?.alias);
      names.push(performance?.artist?.name);
    }
  }

  if (Array.isArray(theme?.song?.artists)) {
    for (const artist of theme.song.artists) {
      names.push(artist?.name);
      names.push(artist?.artistsong?.as);
    }
  }

  return unique(names);
}

function animeThemeVideoUrl(video) {
  const direct = clean(video?.link || "");
  if (/^https?:\/\//i.test(direct)) return direct;

  const basename = clean(video?.basename || "");
  return basename ? `https://v.animethemes.moe/${basename}` : "";
}

function chooseAnimeThemeVideo(theme) {
  const candidates = [];

  for (const entry of (theme?.entries || theme?.animethemeentries || [])) {
    if (entry?.deleted_at || entry?.spoiler || entry?.nsfw) continue;

    for (const video of entry?.videos || []) {
      if (video?.deleted_at) continue;

      const url = animeThemeVideoUrl(video);
      if (!url) continue;

      const tags = String(video?.tags || "")
        .toLocaleLowerCase()
        .split(/[\s,]+/)
        .filter(Boolean);

      let score = 0;
      if (video?.nc) score += 500;
      if (!tags.includes("spoiler")) score += 120;
      if (!tags.includes("nsfw")) score += 120;
      if (video?.overlap === "None" || video?.overlap === "none") score += 60;
      if (video?.source === "WEB") score += 20;
      if (video?.uncen) score += 10;
      if (video?.subbed) score += 5;
      if (video?.lyrics) score -= 2;

      const resolution = Number(video?.resolution) || 0;
      score += Math.min(resolution, 2160) / 10;

      const version = Number(entry?.version) || 1;
      score -= Math.min(version - 1, 5) * 8;

      candidates.push({
        url,
        basename: clean(video?.basename || ""),
        resolution,
        score,
        version,
      });
    }
  }

  return candidates.sort(
    (a, b) => b.score - a.score || b.resolution - a.resolution || a.version - b.version
  )[0] || null;
}

async function fetchAnimeThemesSeason(page, season) {
  const match = String(season || "").match(/^(Winter|Spring|Summer|Fall)\s+(\d{4})$/i);
  if (!match) return [];

  const seasonName = match[1].toLocaleLowerCase();
  const year = match[2];
  const url = `https://animethemes.moe/year/${year}/${seasonName}`;

  try {
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });

    await page.waitForTimeout(800);

    const animeLinks = await page.locator('a[href^="/anime/"]').evaluateAll(links =>
      links
        .map(link => ({
          name: String(link.textContent || "").replace(/\s+/g, " ").trim(),
          href: link.getAttribute("href") || "",
        }))
        .filter(item => /^\/anime\/[^/]+\/?$/.test(item.href))
        .map(item => ({
          name: item.name,
          slug: item.href.replace(/^\/anime\//, "").replace(/\/$/, ""),
        }))
    );

    const uniqueLinks = [];
    const seen = new Set();

    for (const item of animeLinks) {
      if (!item.slug || seen.has(item.slug)) continue;
      seen.add(item.slug);
      uniqueLinks.push(item);
    }

    console.log(
      `AnimeThemes ${season}: season page=${url} anime links=${uniqueLinks.length}`
    );

    return uniqueLinks;
  } catch (error) {
    console.warn(`AnimeThemes season page failed for ${season}:`, error);
    return [];
  }
}

function pickAnimeThemesIndexAnime(item, indexAnimes) {
  const animeCandidates = unique([
    ...(item.animeCandidates || []),
    item.anime,
  ]).filter(Boolean);

  let bestAnime = null;
  let bestScore = 0;

  for (const anime of indexAnimes || []) {
    const names = [anime?.name, anime?.slug].filter(Boolean);
    const score = animeThemesBestScore(animeCandidates, names);

    if (score > bestScore) {
      bestScore = score;
      bestAnime = anime;
    }
  }

  return { bestAnime, bestScore };
}

const animeThemesPageCache = new Map();

async function fetchAnimeThemesAnimePage(page, animeSlug) {
  const slugValue = clean(animeSlug);
  if (!slugValue) return null;

  if (animeThemesPageCache.has(slugValue)) {
    return animeThemesPageCache.get(slugValue);
  }

  const promise = (async () => {
    const url = `https://animethemes.moe/anime/${encodeURIComponent(slugValue)}`;

    try {
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 45000,
      });

      const raw = await page.locator("#__NEXT_DATA__").textContent().catch(() => "");
      if (!raw) {
        console.warn(`AnimeThemes page has no __NEXT_DATA__ for ${slugValue}`);
        return null;
      }

      const json = JSON.parse(raw);
      const anime =
        json?.props?.pageProps?.anime ||
        json?.props?.pageProps?.data?.anime ||
        null;

      if (!anime) {
        console.warn(`AnimeThemes page has no anime data for ${slugValue}`);
        return null;
      }

      return anime;
    } catch (error) {
      console.warn(`AnimeThemes anime page failed for ${slugValue}:`, error);
      return null;
    }
  })();

  animeThemesPageCache.set(slugValue, promise);
  return promise;
}

async function loadAnimeThemesSeasonDetails(page, indexAnimes, items) {
  const candidates = [];

  for (const item of items || []) {
    const picked = pickAnimeThemesIndexAnime(item, indexAnimes);
    if (picked.bestAnime && picked.bestScore >= 650) {
      candidates.push(picked.bestAnime);
    }
  }

  const uniqueAnimes = [];
  const seen = new Set();

  for (const anime of candidates) {
    if (!anime?.slug || seen.has(anime.slug)) continue;
    seen.add(anime.slug);
    uniqueAnimes.push(anime);
  }

  const details = [];
  let failed = 0;

  for (const anime of uniqueAnimes) {
    const detail = await fetchAnimeThemesAnimePage(page, anime.slug);
    if (detail) details.push(detail);
    else failed++;
  }

  console.log(
    `AnimeThemes detail pages: requested=${uniqueAnimes.length} ok=${details.length} failed=${failed}`
  );

  return details;
}

function pickAnimeThemesAnime(item, detailedAnimes) {
  const animeCandidates = unique([
    ...(item.animeCandidates || []),
    item.anime,
  ]).filter(Boolean);

  let bestAnime = null;
  let bestScore = 0;

  for (const anime of detailedAnimes || []) {
    const names = [
      anime?.name,
      anime?.slug,
      ...(Array.isArray(anime?.synonyms)
        ? anime.synonyms.map(x => x?.text)
        : []),
      ...(Array.isArray(anime?.animesynonyms)
        ? anime.animesynonyms.map(x => x?.text)
        : []),
    ].filter(Boolean);

    const score = animeThemesBestScore(animeCandidates, names);

    if (score > bestScore) {
      bestScore = score;
      bestAnime = anime;
    }
  }

  return { bestAnime, bestScore };
}

async function attachAnimeThemesVideo(item, detailedAnimes) {
  const picked = pickAnimeThemesAnime(item, detailedAnimes);

  if (!picked.bestAnime || picked.bestScore < 650) {
    return null;
  }

  const kind = String(item.kind || "").toUpperCase();
  if (!["OP", "ED"].includes(kind)) return null;

  const songCandidates = unique([
    ...(item.titleCandidates || []),
    item.song,
  ]).filter(Boolean);

  const artistCandidates = unique([
    ...(item.artistCandidates || []),
    item.artist,
  ]).filter(Boolean);

  let bestTheme = null;
  let bestThemeScore = 0;

  for (const theme of (picked.bestAnime.themes || picked.bestAnime.animethemes || [])) {
    if (String(theme?.type || "").toUpperCase() !== kind) continue;

    const artistScore = animeThemesBestScore(
      artistCandidates,
      animeThemeArtistNames(theme)
    );

    const songScore = animeThemesBestScore(
      songCandidates,
      theme?.song?.title ? [theme.song.title] : []
    );

    // Song title is the primary identity check. Artist matching is used as
    // corroboration but is not mandatory because AnimeThemes can list aliases
    // differently from AniPlaylist.
    if (songScore < 650) continue;

    let score = songScore * 2 + artistScore;

    if ((Number(theme?.sequence) || 0) === 1) score += 20;
    if (songScore >= 1000) score += 250;
    if (artistScore >= 650) score += 50;

    if (score > bestThemeScore) {
      bestThemeScore = score;
      bestTheme = theme;
    }
  }

  if (!bestTheme) return null;

  const video = chooseAnimeThemeVideo(bestTheme);
  if (!video) return null;

  return {
    url: video.url,
    basename: video.basename,
    animeSlug: clean(picked.bestAnime.slug || ""),
    themeSlug: clean(bestTheme.slug || ""),
    type: kind,
    sequence: Number(bestTheme.sequence) || 1,
    version: video.version,
  };
}

async function resolveAnimeThemesForSeason(page, items, season) {
  const needsWatch = items.filter(item =>
    ["OP", "ED"].includes(String(item.kind || "").toUpperCase())
  );

  if (!needsWatch.length) {
    return { matched: 0, checked: 0, seasonLinks: 0 };
  }

  const indexAnimes = await fetchAnimeThemesSeason(page, season);
  const detailedAnimes = await loadAnimeThemesSeasonDetails(
    page,
    indexAnimes,
    needsWatch
  );

  let matched = 0;
  let animeMatched = 0;

  for (const item of needsWatch) {
    const picked = pickAnimeThemesAnime(item, detailedAnimes);

    if (picked.bestAnime && picked.bestScore >= 650) {
      animeMatched++;
    }

    const video = await attachAnimeThemesVideo(item, detailedAnimes);
    item.animethemesVideo = video;

    if (video) matched++;
  }

  console.log(
    `AnimeThemes ${season}: checked=${needsWatch.length} animeMatched=${animeMatched} videosMatched=${matched}`
  );

  return {
    matched,
    checked: needsWatch.length,
    seasonLinks: indexAnimes.length,
  };
}


function buildHomePage(seasons, featuredSeason) {
  const rows = Array.isArray(seasons) ? seasons : [];
  const featured =
    rows.find(row => String(row.season) === String(featuredSeason)) ||
    rows.find(row => Number(row.releases || 0) > 0) ||
    rows[0] ||
    {};

  const featuredSlug = featured.season ? slug(featured.season) : "";
  const featuredUrl = featuredSlug
    ? `${SITE_BASE}/browse/${featuredSlug}/`
    : `${SITE_BASE}/`;

  const seasonCards = rows
    .filter(row => String(row.season) !== String(featuredSeason))
    .map(row => {
    const season = String(row.season || "Season");
    const seasonSlug = slug(season);
    const releases = Number(row.releases || 0);
    const videos = Number(row.watchVideos || 0);
    const playlist = row.spotifyPlaylist || "";
    const images = Array.isArray(row.featureImages) ? row.featureImages.slice(0, 3).filter(Boolean) : [];

    const mosaic = images.length
      ? `<div class="season-mosaic">${images.map(src => `<img src="${htmlEscape(src)}" alt="" loading="lazy">`).join("")}</div>`
      : '<div class="season-mosaic empty"><span>No releases yet</span></div>';

    return `
      <article class="season-card">
        ${mosaic}
        <div class="season-card-body">
          <div class="season-kicker">${releases ? "AVAILABLE" : "COMING SOON"}</div>
          <h3>${htmlEscape(season)}</h3>
          <div class="season-meta"><span>${releases} releases</span><span>${videos} videos</span></div>
          <div class="season-actions">
            <a class="season-open" href="${htmlEscape(SITE_BASE)}/browse/${htmlEscape(seasonSlug)}/">Browse season <span>→</span></a>
            ${playlist ? `<a class="season-spotify" href="${htmlEscape(playlist)}" target="_blank" rel="noopener noreferrer" title="Spotify playlist">Spotify</a>` : ""}
          </div>
        </div>
      </article>
    `;
  }).join("");

  const featuredImages = Array.isArray(featured.featureImages)
    ? featured.featureImages.slice(0, 3).filter(Boolean)
    : [];

  const featuredArt = featuredImages.length
    ? `<div class="featured-art">${featuredImages.map(src => `<img src="${htmlEscape(src)}" alt="" loading="eager">`).join("")}</div>`
    : '<div class="featured-art fallback"><span>No cover art yet</span></div>';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#090711">
  <link rel="icon" type="image/svg+xml" href="${htmlEscape(SITE_BASE)}/favicon.svg">
  <link rel="canonical" href="${htmlEscape(SITE_BASE)}/">
  <title>AniPlaylist — Anime Music Hub</title>
  <meta name="description" content="Anime openings, endings, insert songs and OSTs organized by season.">

  <style>
    :root {
      color-scheme: dark;
      --bg: #090711;
      --panel: rgba(20,16,30,.9);
      --line: rgba(255,255,255,.09);
      --line2: rgba(255,255,255,.14);
      --text: #f7f3ff;
      --muted: #aaa2b5;
      --muted2: #766d82;
      --purple: #a978ff;
      --pink: #ff5ca8;
    }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; background: var(--bg); }
    body {
      margin: 0;
      min-height: 100vh;
      color: var(--text);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background:
        radial-gradient(900px 540px at 8% -10%, rgba(169,120,255,.2), transparent 60%),
        radial-gradient(800px 520px at 100% 18%, rgba(255,92,168,.1), transparent 62%),
        linear-gradient(180deg, #090711 0%, #0b0811 55%, #090711 100%);
    }
    body::before {
      content: "";
      position: fixed;
      inset: 0;
      pointer-events: none;
      opacity: .13;
      background-image:
        linear-gradient(rgba(255,255,255,.02) 1px, transparent 1px),
        linear-gradient(90deg,rgba(255,255,255,.014) 1px,transparent 1px);
      background-size: 44px 44px;
    }
    a { color: inherit; }
    svg { display:block; width:1em; height:1em; }

    .wrap { width:min(1180px,calc(100% - 30px)); margin:0 auto; }

    .topbar {
      height:76px;
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:16px;
    }
    .brand {
      display:inline-flex;
      align-items:center;
      gap:11px;
      text-decoration:none;
    }
    .brand-mark {
      display:grid;
      place-items:center;
      width:42px;
      height:42px;
      border-radius:13px;
      border:1px solid rgba(255,255,255,.12);
      background:linear-gradient(135deg,rgba(169,120,255,.96),rgba(120,87,255,.8) 52%,rgba(255,92,168,.82));
      box-shadow:0 14px 35px rgba(120,87,255,.23);
      font-size:17px;
    }
    .brand-copy strong { display:block; font-size:15px; line-height:1; letter-spacing:-.02em; }
    .brand-copy span { display:block; margin-top:4px; color:var(--muted2); font-size:10px; font-weight:800; }

    .topnav { display:flex; gap:7px; }
    .topnav a {
      display:inline-flex;
      align-items:center;
      min-height:34px;
      padding:0 11px;
      border:1px solid var(--line);
      border-radius:10px;
      color:#9c93a8;
      text-decoration:none;
      font-size:10px;
      font-weight:900;
    }
    .topnav a:hover { color:#fff; background:rgba(255,255,255,.03); border-color:var(--line2); }

    .hero {
      position:relative;
      overflow:hidden;
      padding:52px;
      border:1px solid var(--line);
      border-radius:30px;
      background:
        radial-gradient(520px 260px at 8% 0%,rgba(169,120,255,.18),transparent 72%),
        radial-gradient(500px 260px at 92% 100%,rgba(255,92,168,.09),transparent 72%),
        linear-gradient(135deg,rgba(24,18,40,.92),rgba(11,8,18,.97));
      box-shadow:0 30px 100px rgba(0,0,0,.3);
    }
    .hero-grid { display:grid; grid-template-columns:minmax(0,1fr) 280px; gap:36px; align-items:center; }
    .eyebrow {
      display:inline-flex;
      align-items:center;
      gap:8px;
      min-height:27px;
      padding:0 10px;
      border:1px solid rgba(169,120,255,.25);
      border-radius:999px;
      background:rgba(169,120,255,.08);
      color:#ccb7ff;
      font-size:9px;
      font-weight:900;
      text-transform:uppercase;
      letter-spacing:.13em;
    }
    .eyebrow-dot { width:6px; height:6px; border-radius:50%; background:var(--pink); box-shadow:0 0 14px rgba(255,92,168,.8); }
    h1 { margin:15px 0 0; max-width:730px; font-size:clamp(45px,6.4vw,78px); line-height:.92; letter-spacing:-.065em; }
    .hero-copy { max-width:690px; margin-top:17px; color:var(--muted); font-size:14px; line-height:1.7; }
    .hero-copy strong { color:#e7ddf3; }
    .hero-actions { display:flex; flex-wrap:wrap; gap:8px; margin-top:23px; }
    .primary,.secondary {
      display:inline-flex;
      align-items:center;
      min-height:42px;
      padding:0 14px;
      border-radius:12px;
      text-decoration:none;
      font-size:10px;
      font-weight:900;
      transition:transform .15s ease,filter .15s ease;
    }
    .primary { color:#fff; background:linear-gradient(135deg,#8d6aff,#6a57ff); box-shadow:0 14px 32px rgba(120,87,255,.18); }
    .secondary { color:#b7afc0; border:1px solid var(--line); background:rgba(255,255,255,.025); }
    .primary:hover,.secondary:hover { transform:translateY(-1px); filter:brightness(1.06); }

    .hero-eq { height:170px; display:flex; align-items:flex-end; justify-content:center; gap:9px; }
    .hero-eq i {
      display:block;
      width:9px;
      border-radius:999px;
      background:linear-gradient(180deg,#f5eaff,#a978ff 55%,#6b50ff);
      box-shadow:0 0 26px rgba(169,120,255,.2);
      animation:bounce 1.15s ease-in-out infinite alternate;
      transform-origin:bottom;
    }
    .hero-eq i:nth-child(1){height:36px;animation-delay:-.2s}
    .hero-eq i:nth-child(2){height:80px;animation-delay:-.7s}
    .hero-eq i:nth-child(3){height:130px;animation-delay:-.1s}
    .hero-eq i:nth-child(4){height:68px;animation-delay:-.55s}
    .hero-eq i:nth-child(5){height:112px;animation-delay:-.3s}
    .hero-eq i:nth-child(6){height:56px;animation-delay:-.9s}
    .hero-eq i:nth-child(7){height:96px;animation-delay:-.45s}
    @keyframes bounce { from{transform:scaleY(.48);opacity:.65} to{transform:scaleY(1);opacity:1} }

    .section { padding-top:30px; }
    .section-head { display:flex; justify-content:space-between; align-items:end; gap:14px; margin-bottom:13px; }
    .section-head h2 { margin:0; font-size:22px; letter-spacing:-.04em; }
    .section-head p { margin:4px 0 0; color:var(--muted2); font-size:10px; }

    .featured {
      display:grid;
      grid-template-columns:minmax(0,.7fr) minmax(0,1.3fr);
      overflow:hidden;
      border:1px solid var(--line);
      border-radius:24px;
      background:linear-gradient(145deg,rgba(23,18,37,.94),rgba(12,9,19,.97));
    }
    .featured-art {
      height:260px;
      display:grid;
      grid-template-columns:1.15fr .85fr;
      grid-template-rows:1fr 1fr;
      gap:3px;
      padding:3px;
      overflow:hidden;
      background:#100b18;
    }
    .featured-art img {
      width:100%;
      height:100%;
      min-width:0;
      min-height:0;
      object-fit:cover;
      border-radius:11px;
    }
    .featured-art img:first-child { grid-row:1 / span 2; }
    .featured-art img:nth-child(n+4) { display:none; }
    .featured-art.fallback {
      display:grid;
      place-items:center;
      color:#81768e;
      font-size:10px;
      font-weight:900;
      letter-spacing:.08em;
      text-transform:uppercase;
    }
    .featured-copy { min-width:0; padding:28px 30px; display:flex; flex-direction:column; justify-content:center; }
    .featured-kicker { color:#97899f; font-size:9px; font-weight:900; text-transform:uppercase; letter-spacing:.13em; }
    .featured h2 { margin:8px 0 0; font-size:clamp(28px,3.5vw,46px); line-height:.96; letter-spacing:-.055em; }
    .featured-text { margin-top:9px; color:var(--muted); font-size:11px; line-height:1.6; }
    .stats { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:7px; margin-top:18px; }
    .stat { min-width:0; padding:11px 12px; border:1px solid var(--line); border-radius:12px; background:rgba(255,255,255,.02); }
    .stat label { display:block; color:var(--muted2); font-size:8px; font-weight:900; text-transform:uppercase; letter-spacing:.1em; }
    .stat strong { display:block; margin-top:4px; font-size:18px; }
    .featured-actions { display:flex; flex-wrap:wrap; gap:7px; margin-top:17px; }

    .season-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:13px; }
    .season-card { overflow:hidden; border:1px solid var(--line); border-radius:19px; background:linear-gradient(145deg,rgba(22,17,34,.92),rgba(12,9,19,.97)); transition:transform .16s ease,border-color .16s ease; }
    .season-card:hover { transform:translateY(-3px); border-color:rgba(169,120,255,.24); }
    .season-mosaic {
      position: relative;
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      width: 100%;
      height: 118px !important;
      min-height: 118px !important;
      max-height: 118px !important;
      gap: 3px;
      overflow: hidden;
      background: #100b18;
    }
    .season-mosaic img {
      display: block;
      width: 100% !important;
      height: 118px !important;
      min-height: 0 !important;
      max-height: 118px !important;
      object-fit: cover;
      overflow: hidden;
    }
    .season-mosaic.empty {
      display:grid;
      place-items:center;
      color:#655d6c;
      font-size:9px;
      font-weight:900;
      letter-spacing:.1em;
      text-transform:uppercase;
      background:
        radial-gradient(circle at 30% 25%, rgba(169,120,255,.08), transparent 45%),
        radial-gradient(circle at 75% 75%, rgba(255,92,168,.055), transparent 45%),
        #100b18;
    }
    .season-card-body {
      position: relative;
      z-index: 2;
      min-height: 118px;
      padding: 15px 16px 16px;
      background: linear-gradient(180deg, rgba(14,10,22,.98), rgba(10,8,17,1));
    }

    .season-card h3 {
      margin: 8px 0 0;
      color: var(--text);
      font-size: 23px;
      line-height: 1.05;
      letter-spacing: -.045em;
      text-shadow: 0 1px 18px rgba(0,0,0,.28);
    }
    .season-kicker { color:#8e819b; font-size:8px; font-weight:900; letter-spacing:.13em; }
    .season-meta { display:flex; gap:8px; margin-top:6px; color:var(--muted2); font-size:10px; font-weight:800; }
    .season-actions { display:flex; justify-content:space-between; align-items:center; gap:10px; margin-top:13px; }
    .season-open { display:inline-flex; align-items:center; gap:6px; color:#d8cdf0; text-decoration:none; font-size:10px; font-weight:900; }
    .season-open:hover { color:#fff; }
    .season-spotify { color:#6fda9a; text-decoration:none; font-size:9px; font-weight:900; }
    footer { padding:28px 0 36px; color:#5f5768; text-align:center; font-size:9px; }
    .github-link { color:#8d82a0; text-decoration:none; font-weight:900; }
    .github-link:hover { color:#d9ceeb; }

    @media(max-width:920px){
      .hero-grid{grid-template-columns:1fr}
      .hero-eq{display:none}
      .featured{grid-template-columns:1fr}
      .featured-art{height:260px;min-height:260px}
      .season-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
    }
    @media(max-width:640px){
      .wrap{width:min(100%,calc(100% - 18px))}
      .topbar{height:66px}
      .topnav{display:none}
      .hero{padding:30px 20px;border-radius:22px}
      h1{font-size:48px}
      .hero-copy{font-size:13px}
      .featured-copy{padding:24px 20px}
      .stats{grid-template-columns:repeat(2,minmax(0,1fr))}
      .season-grid{grid-template-columns:1fr}
    }
    @media(prefers-reduced-motion:reduce){
      *,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}
    }
  </style>
</head>
<body>
  <div class="wrap">
    <header class="topbar">
      <a class="brand" href="${htmlEscape(SITE_BASE)}/" aria-label="AniPlaylist home">
        <span class="brand-mark">♫</span>
        <span class="brand-copy"><strong>AniPlaylist</strong><span>Anime Music Hub</span></span>
      </a>
      <nav class="topnav" aria-label="Site navigation">
        <a href="#seasons">Seasons</a>
        ${featuredSlug ? `<a href="${htmlEscape(featuredUrl)}">Current releases</a>` : ""}
      </nav>
    </header>

    <main>
      <section class="hero">
        <div class="hero-grid">
          <div>
            <div class="eyebrow"><span class="eyebrow-dot"></span> Anime Music · RSS · Streaming · Video</div>
            <h1>Anime music,<br>organized by season.</h1>
            <div class="hero-copy">
              A focused hub for <strong>anime openings, endings, insert songs, and OSTs</strong>.
              Browse a season, search multilingual titles, open your streaming link, or watch a verified AnimeThemes video.
            </div>
            <div class="hero-actions">
              <a class="primary" href="#featured">Browse seasons →</a>
            </div>
          </div>
          <div class="hero-eq" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>
        </div>
      </section>

      ${featured.season ? `
      <section id="featured" class="section">
        <div class="section-head">
          <div>
            <h2>Featured season</h2>
            <p>Choose the season, then use the full catalog tools there.</p>
          </div>
        </div>
        <article class="featured">
          ${featuredArt}
          <div class="featured-copy">
            <div class="featured-kicker">Current catalog</div>
            <h2>${htmlEscape(featured.season)}</h2>
            <div class="featured-text">
              ${Number(featured.releases || 0)} releases · ${Number(featured.watchVideos || 0)} verified AnimeThemes videos.
              Search, language switching, release-type filters, video-only filtering, and pagination live on the season page.
            </div>
            <div class="stats">
              <div class="stat"><label>Releases</label><strong>${Number(featured.releases || 0)}</strong></div>
              <div class="stat"><label>Watch videos</label><strong>${Number(featured.watchVideos || 0)}</strong></div>
              <div class="stat"><label>Spotify</label><strong>${Number(featured.spotifyLinks || 0)}</strong></div>
              <div class="stat"><label>Apple Music</label><strong>${Number(featured.appleLinks || 0)}</strong></div>
            </div>
            <div class="featured-actions">
              <a class="primary" href="${htmlEscape(featuredUrl)}">Open ${htmlEscape(featured.season)} →</a>
              <a class="secondary" href="${htmlEscape(SITE_BASE)}/rss/${htmlEscape(slug(featured.season))}.xml">RSS Feed</a>
              ${featured.spotifyPlaylist ? `<a class="secondary" href="${htmlEscape(featured.spotifyPlaylist)}" target="_blank" rel="noopener noreferrer">Spotify Playlist</a>` : ""}
            </div>
          </div>
        </article>
      </section>
      ` : ""}

      <section id="seasons" class="section">
        <div class="section-head">
          <div>
            <h2>Next seasons</h2>
            <p>Explore upcoming and additional season catalogs.</p>
          </div>
        </div>
        <div class="season-grid">
          ${seasonCards || '<div class="season-empty">No other seasons configured yet.</div>'}
        </div>
      </section>
    </main>

    <footer>
      AniPlaylist · Anime Music Hub · Spotify · Apple Music · RSS · AnimeThemes ·
      <a class="github-link" href="https://github.com/chintu-io" target="_blank" rel="noopener noreferrer">GitHub ↗</a>
    </footer>
  </div>
</body>
</html>`;
}
function buildBrowsePage(season, items, options = {}) {
  const isHome = options.isHome === true;
  const slugSeason = slug(season);
  const feedUrl = `${SITE_BASE}/rss/${slugSeason}.xml`;
  const orderedItems = items
    .slice()
    .sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

  const watchCount = orderedItems.filter(item =>
    item.animethemesVideo?.url &&
    ["OP", "ED"].includes(String(item.kind || "").toUpperCase())
  ).length;
  const spotifyCount = orderedItems.filter(item => !!item.spotify).length;
  const appleCount = orderedItems.filter(item => !!item.apple).length;

  const seasonNav = Array.isArray(CFG.seasons)
    ? CFG.seasons.map(value => {
        const active = String(value) === String(season);
        const href = `${SITE_BASE}/browse/${slug(value)}/`;
        return `<a class="season-pill${active ? " active" : ""}" href="${htmlEscape(href)}"${active ? ' aria-current="page"' : ""}>${htmlEscape(value)}</a>`;
      }).join("")
    : "";

  const cards = orderedItems.map((item, index) => {
    const kind = String(item.kind || "Other").toUpperCase();
    const watchable = Boolean(
      item.animethemesVideo?.url &&
      ["OP", "ED"].includes(kind)
    );

    const image = item.thumbnail
      ? `<img src="${htmlEscape(item.thumbnail)}" alt="" loading="${index < 6 ? "eager" : "lazy"}">`
      : '<div class="cover-fallback"><span>♪</span></div>';

    const watchButton = watchable
      ? `<a class="platform watch icon-only" href="${htmlEscape(item.animethemesVideo.url)}"
          data-watch-url="${htmlEscape(item.animethemesVideo.url)}"
          data-watch-poster="${htmlEscape(item.thumbnail || "")}"
          data-watch-title="${htmlEscape(item.anime || "Anime")}"
          data-watch-song="${htmlEscape(item.song || "Theme")}"
          data-watch-kind="${htmlEscape(kind)}"
          title="Watch AnimeThemes video"
          aria-label="Watch ${htmlEscape(item.song || "theme")}"><span class="play-button-glyph">▶</span></a>`
      : "";

    const platforms = [
      browsePlatformButton("Spotify", item.spotify, "spotify"),
      browsePlatformButton("Apple Music", item.apple, "apple"),
      watchButton,
    ].filter(Boolean).join("\n");

    const dateText = Number.isFinite(new Date(item.pubDate).getTime())
      ? new Date(item.pubDate).toLocaleDateString("en", {
          year: "numeric",
          month: "short",
          day: "numeric",
        })
      : "";

    const animeVariants = getTitleVariants(item.animeCandidates, item.anime);
    const songVariants = getTitleVariants(item.titleCandidates, item.song);
    const artistCandidates = (item.artistCandidates || []).filter(isLikelyArtistDisplay);
    const artistVariants = getTitleVariants(artistCandidates, item.artist);

    const searchText = unique([
      item.anime,
      item.song,
      item.artist,
      item.artistDisplay,
      item.kind,
      ...(item.animeCandidates || []),
      ...(item.titleCandidates || []),
      ...artistCandidates,
    ]).join(" ");

    const variantAttrs = variants => [
      `data-en="${htmlEscape(variants.english)}"`,
      `data-romaji="${htmlEscape(variants.romaji)}"`,
      `data-ja="${htmlEscape(variants.japanese)}"`,
    ].join(" ");

    return `
      <article class="song-card"
        data-kind="${htmlEscape(kind)}"
        data-has-video="${watchable ? "1" : "0"}"
        data-search="${htmlEscape(searchText)}">
        <div class="card-art">
          <div class="rank-badge">#${index + 1}</div>
          <div class="cover-wrap">
            ${image}
            ${watchable ? '<div class="video-badge" aria-hidden="true"><span class="play-glyph">▶</span> VIDEO</div>' : ""}
          </div>
        </div>

        <div class="song-main">
          <div class="song-head">
            <span class="kind kind-${htmlEscape(kind.toLowerCase())}">${htmlEscape(item.kindLabel || prettyKind(kind))}</span>
            <span class="date">${htmlEscape(dateText)}</span>
          </div>

          <h2 class="anime-title" ${variantAttrs(animeVariants)}>${htmlEscape(animeVariants.english || "Unknown anime")}</h2>
          <div class="song-title" ${variantAttrs(songVariants)}>${htmlEscape(songVariants.english || "Unknown song")}</div>
          ${artistVariants.english ? `<div class="artist" ${variantAttrs(artistVariants)}>${htmlEscape(item.artistDisplay || artistVariants.english)}</div>` : ""}

          <div class="card-bottom">
            <div class="platforms">${platforms}</div>
            <a class="details" href="${htmlEscape(SITE_BASE)}/song/${htmlEscape(item.key)}/" aria-label="Open song page for ${htmlEscape(item.song || "this release")}">Details ↗</a>
          </div>
        </div>
      </article>
    `;
  }).join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#0b0712">
  <link rel="icon" type="image/svg+xml" href="${isHome ? "./favicon.svg" : "../../favicon.svg"}">
  <title>${htmlEscape(`AniPlaylist — ${season}`)}</title>
  <meta name="description" content="${htmlEscape(`Anime music releases for ${season}, with Spotify, Apple Music, and verified AnimeThemes OP/ED videos.`)}">
  <style>
    :root {
      color-scheme: dark;
      --bg: #090711;
      --bg-2: #100c1b;
      --panel: rgba(21, 17, 31, .82);
      --panel-strong: #171225;
      --line: rgba(255,255,255,.08);
      --line-strong: rgba(255,255,255,.13);
      --text: #f7f3ff;
      --muted: #a8a0b6;
      --muted-2: #756c84;
      --purple: #a978ff;
      --purple-2: #7857ff;
      --pink: #ff5ca8;
      --cyan: #56d7ff;
      --green: #30d77b;
      --shadow: 0 30px 90px rgba(0,0,0,.32);
    }

    * { box-sizing: border-box; }

    html {
      scroll-behavior: smooth;
      background: var(--bg);
    }

    body {
      margin: 0;
      min-height: 100vh;
      color: var(--text);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background:
        radial-gradient(900px 520px at 7% -10%, rgba(169,120,255,.22), transparent 58%),
        radial-gradient(900px 550px at 100% 18%, rgba(255,92,168,.12), transparent 60%),
        radial-gradient(760px 500px at 50% 100%, rgba(86,215,255,.08), transparent 65%),
        linear-gradient(180deg, #090711 0%, #0c0912 45%, #090711 100%);
    }

    body::before {
      content: "";
      position: fixed;
      inset: 0;
      pointer-events: none;
      background-image:
        linear-gradient(rgba(255,255,255,.025) 1px, transparent 1px),
        linear-gradient(90deg, rgba(255,255,255,.018) 1px, transparent 1px);
      background-size: 44px 44px;
      mask-image: linear-gradient(to bottom, black, transparent 82%);
      opacity: .22;
    }

    a { color: inherit; }

    svg {
      display: block;
      width: 1em;
      height: 1em;
      flex: 0 0 auto;
    }

    button, input { font: inherit; }

    .wrap {
      width: min(1320px, calc(100% - 34px));
      margin: 0 auto;
    }

    .site-header {
      padding: 22px 0 30px;
      position: relative;
    }

    .nav-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 28px;
    }

    .brand-link {
      display: inline-flex;
      align-items: center;
      gap: 12px;
      color: var(--text);
      text-decoration: none;
      font-weight: 900;
      letter-spacing: -.025em;
    }

    .brand-mark {
      position: relative;
      display: grid;
      place-items: center;
      width: 42px;
      height: 42px;
      border: 1px solid rgba(255,255,255,.12);
      border-radius: 13px;
      background:
        radial-gradient(circle at 30% 25%, rgba(255,255,255,.32), transparent 28%),
        linear-gradient(135deg, rgba(169,120,255,.95), rgba(120,87,255,.76) 52%, rgba(255,92,168,.8));
      box-shadow: 0 14px 36px rgba(120,87,255,.26);
      overflow: hidden;
    }

    .brand-note {
      position: relative;
      z-index: 2;
      font-size: 17px;
      transform: translateY(-1px);
    }

    .brand-link strong { font-size: 15px; }
    .brand-link span:last-child { color: var(--muted); font-size: 12px; font-weight: 700; }

    .back {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      color: var(--muted);
      text-decoration: none;
      font-size: 12px;
      font-weight: 700;
    }

    .back:hover { color: var(--text); }

    .hero {
      position: relative;
      overflow: hidden;
      padding: 30px;
      border: 1px solid var(--line);
      border-radius: 30px;
      background:
        radial-gradient(500px 240px at 12% 0%, rgba(169,120,255,.17), transparent 72%),
        radial-gradient(600px 260px at 84% 100%, rgba(255,92,168,.08), transparent 72%),
        linear-gradient(135deg, rgba(23,18,37,.94), rgba(13,10,22,.9));
      box-shadow: var(--shadow);
    }

    .hero::after {
      content: "";
      position: absolute;
      width: 360px;
      height: 360px;
      right: -130px;
      top: -150px;
      border-radius: 50%;
      background: radial-gradient(circle, rgba(169,120,255,.18), transparent 66%);
      filter: blur(4px);
      pointer-events: none;
    }

    .hero-top {
      position: relative;
      z-index: 1;
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 24px;
    }

    .eyebrow {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 7px 11px;
      border: 1px solid rgba(169,120,255,.24);
      border-radius: 999px;
      background: rgba(169,120,255,.08);
      color: #ceb8ff;
      font-size: 11px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: .12em;
    }

    .eyebrow-dot {
      width: 6px;
      height: 6px;
      border-radius: 999px;
      background: var(--pink);
      box-shadow: 0 0 14px rgba(255,92,168,.8);
    }

    h1 {
      margin: 12px 0 0;
      font-size: clamp(38px, 6vw, 72px);
      line-height: .94;
      letter-spacing: -.06em;
    }

    .hero-copy {
      max-width: 720px;
      margin-top: 15px;
      color: var(--muted);
      font-size: 14px;
      line-height: 1.6;
    }

    .hero-copy strong { color: #e4d8ff; }

    .hero-visual {
      flex: 0 0 auto;
      display: flex;
      align-items: flex-end;
      gap: 7px;
      min-height: 94px;
      padding: 0 8px 8px 0;
    }

    .eq {
      display: flex;
      align-items: flex-end;
      gap: 6px;
      height: 90px;
    }

    .eq i {
      display: block;
      width: 7px;
      min-height: 14px;
      border-radius: 99px;
      background: linear-gradient(180deg, #f6eaff, #a978ff 52%, #6b50ff);
      box-shadow: 0 0 22px rgba(169,120,255,.28);
      animation: equalize 1s ease-in-out infinite alternate;
      transform-origin: bottom;
    }

    .eq i:nth-child(1) { height: 26px; animation-delay: -.55s; }
    .eq i:nth-child(2) { height: 58px; animation-delay: -.2s; }
    .eq i:nth-child(3) { height: 40px; animation-delay: -.75s; }
    .eq i:nth-child(4) { height: 76px; animation-delay: -.35s; }
    .eq i:nth-child(5) { height: 32px; animation-delay: -.6s; }
    .eq i:nth-child(6) { height: 64px; animation-delay: -.1s; }
    .eq i:nth-child(7) { height: 46px; animation-delay: -.45s; }

    @keyframes equalize {
      0% { transform: scaleY(.46); opacity: .65; }
      100% { transform: scaleY(1); opacity: 1; }
    }

    .stats {
      position: relative;
      z-index: 1;
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 10px;
      margin-top: 28px;
    }

    .stat {
      padding: 13px 14px;
      border: 1px solid var(--line);
      border-radius: 16px;
      background: rgba(255,255,255,.025);
    }

    .stat .label {
      color: var(--muted-2);
      font-size: 10px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: .11em;
    }

    .stat .value {
      margin-top: 4px;
      font-size: 19px;
      font-weight: 900;
      letter-spacing: -.03em;
    }

    .hero-actions {
      position: relative;
      z-index: 1;
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      margin-top: 18px;
    }

    .resource-button {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      min-height: 38px;
      padding: 0 12px;
      border: 1px solid var(--line);
      border-radius: 11px;
      background: rgba(255,255,255,.035);
      color: #eee8f5;
      text-decoration: none;
      font-size: 10px;
      font-weight: 900;
      white-space: nowrap;
      transition: transform .15s ease, filter .15s ease, border-color .15s ease;
    }

    .resource-button:hover {
      transform: translateY(-1px);
      filter: brightness(1.05);
      border-color: var(--line-strong);
    }

    .resource-button.rss {
      background: rgba(255,255,255,.04);
    }

    .resource-button.spotify {
      background: linear-gradient(135deg, #17b85a, #1ed760);
      border-color: transparent;
    }

    .resource-button[hidden] {
      display: none !important;
    }

    .resource-icon {
      display: grid;
      place-items: center;
      width: 18px;
      height: 18px;
      flex: 0 0 18px;
    }

    .resource-icon svg {
      width: 18px;
      height: 18px;
    }

    .resource-note {
      color: var(--muted-2);
      font-size: 10px;
      font-weight: 800;
    }

    .season-strip {
      display: flex;
      gap: 7px;
      overflow-x: auto;
      padding: 16px 0 4px;
      scrollbar-width: none;
    }

    .season-strip::-webkit-scrollbar { display: none; }

    .season-pill {
      flex: 0 0 auto;
      display: inline-flex;
      align-items: center;
      min-height: 34px;
      padding: 0 12px;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: rgba(255,255,255,.022);
      color: #a79fad;
      text-decoration: none;
      font-size: 11px;
      font-weight: 800;
      transition: transform .15s ease, border-color .15s ease, color .15s ease, background .15s ease;
    }

    .season-pill:hover {
      transform: translateY(-1px);
      color: var(--text);
      border-color: var(--line-strong);
      background: rgba(255,255,255,.05);
    }

    .season-pill.active {
      color: white;
      border-color: rgba(169,120,255,.32);
      background: linear-gradient(135deg, rgba(169,120,255,.2), rgba(120,87,255,.12));
      box-shadow: inset 0 0 0 1px rgba(169,120,255,.06);
    }

    .tools {
      margin-top: 18px;
      padding: 14px;
      border: 1px solid var(--line);
      border-radius: 20px;
      background: rgba(8,6,13,.55);
      backdrop-filter: blur(16px);
    }

    .search-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 10px;
    }

    .search-shell {
      position: relative;
      min-width: 0;
    }

    .search-icon {
      position: absolute;
      left: 15px;
      top: 50%;
      transform: translateY(-50%);
      color: #7e7589;
      font-size: 16px;
      pointer-events: none;
    }

    .search-input {
      width: 100%;
      min-height: 52px;
      padding: 0 17px 0 43px;
      border: 1px solid var(--line);
      border-radius: 14px;
      outline: none;
      background: rgba(255,255,255,.035);
      color: var(--text);
      font-size: 14px;
    }

    .search-input::placeholder { color: #766e80; }

    .search-input:focus {
      border-color: rgba(169,120,255,.52);
      box-shadow: 0 0 0 4px rgba(169,120,255,.1);
    }

    .language-switch {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 4px;
      border: 1px solid var(--line);
      border-radius: 14px;
      background: rgba(255,255,255,.03);
    }

    .language-button {
      min-height: 42px;
      padding: 0 12px;
      border: 0;
      border-radius: 10px;
      background: transparent;
      color: #857c90;
      cursor: pointer;
      font-size: 11px;
      font-weight: 800;
    }

    .language-button:hover { color: var(--text); }

    .language-button.active {
      color: white;
      background: linear-gradient(135deg, rgba(169,120,255,.85), rgba(120,87,255,.78));
      box-shadow: 0 8px 24px rgba(120,87,255,.2);
    }

    .filter-row {
      display: flex;
      align-items: center;
      gap: 7px;
      flex-wrap: wrap;
      margin-top: 11px;
    }

    .filter-label {
      margin-right: 2px;
      color: var(--muted-2);
      font-size: 10px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: .1em;
    }

    .filter-button {
      min-height: 32px;
      padding: 0 11px;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: rgba(255,255,255,.025);
      color: #8f8799;
      cursor: pointer;
      font-size: 11px;
      font-weight: 800;
      transition: .15s ease;
    }

    .filter-button:hover {
      color: var(--text);
      border-color: var(--line-strong);
    }

    .filter-button.active {
      color: white;
      border-color: rgba(255,92,168,.3);
      background: linear-gradient(135deg, rgba(255,92,168,.18), rgba(169,120,255,.16));
    }

    .result-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-top: 13px;
      color: var(--muted);
      font-size: 11px;
    }

    .result-row strong { color: #e2dce8; }

    main { padding: 22px 0 48px; }

    .song-list {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 16px;
      align-items: start;
    }

    .song-card {
      position: relative;
      min-width: 0;
      border: 1px solid var(--line);
      border-radius: 22px;
      overflow: hidden;
      background:
        linear-gradient(180deg, rgba(24,19,35,.95), rgba(16,13,24,.96));
      box-shadow: 0 18px 55px rgba(0,0,0,.18);
      transition: transform .18s ease, border-color .18s ease, box-shadow .18s ease;
    }

    .song-card::before {
      content: "";
      position: absolute;
      inset: 0;
      background: linear-gradient(120deg, rgba(169,120,255,.08), transparent 34%, rgba(255,92,168,.045));
      pointer-events: none;
    }

    .song-card:hover {
      transform: translateY(-4px);
      border-color: rgba(169,120,255,.2);
      box-shadow: 0 24px 70px rgba(0,0,0,.28), 0 0 0 1px rgba(169,120,255,.04);
    }

    .song-card[hidden] { display: none !important; }

    .card-art {
      padding: 12px 12px 0;
    }

    .cover-wrap {
      position: relative;
      aspect-ratio: 1;
      border-radius: 17px;
      overflow: hidden;
      background:
        radial-gradient(circle at 30% 15%, rgba(169,120,255,.22), transparent 36%),
        linear-gradient(135deg, #171126, #0d0a15);
    }

    .cover-wrap img,
    .cover-fallback {
      width: 100%;
      height: 100%;
      display: block;
      object-fit: cover;
    }

    .cover-wrap img {
      transform: scale(1.005);
      transition: transform .35s ease;
    }

    .song-card:hover .cover-wrap img { transform: scale(1.035); }

    .cover-fallback {
      display: grid;
      place-items: center;
      font-size: 74px;
      color: #9b79ff;
      background:
        radial-gradient(circle at 50% 40%, rgba(169,120,255,.19), transparent 38%),
        linear-gradient(145deg, #171126, #0d0a15);
    }

    .cover-fallback span { transform: translateY(-2px); }

    .rank-badge {
      position: absolute;
      z-index: 3;
      top: 21px;
      left: 21px;
      min-width: 38px;
      height: 30px;
      padding: 0 10px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: 1px solid rgba(255,255,255,.12);
      border-radius: 10px;
      background: rgba(10,7,17,.7);
      backdrop-filter: blur(12px);
      color: #f5effb;
      font-size: 11px;
      font-weight: 900;
    }

    .video-badge {
      position: absolute;
      z-index: 2;
      right: 11px;
      bottom: 11px;
      display: inline-flex;
      align-items: center;
      gap: 7px;
      min-height: 28px;
      padding: 0 9px;
      border: 1px solid rgba(255,255,255,.14);
      border-radius: 9px;
      background: rgba(10,7,17,.72);
      backdrop-filter: blur(12px);
      color: #fff;
      font-size: 9px;
      font-weight: 900;
      letter-spacing: .08em;
    }

    .play-glyph {
      display: inline-grid;
      place-items: center;
      width: 14px;
      height: 14px;
      color: white;
      font-size: 8px;
    }

    .song-main {
      position: relative;
      padding: 14px 14px 15px;
    }

    .song-head {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      flex-wrap: wrap;
    }

    .kind {
      display: inline-flex;
      align-items: center;
      min-height: 25px;
      padding: 0 9px;
      border-radius: 999px;
      font-size: 9px;
      font-weight: 900;
      letter-spacing: .11em;
      text-transform: uppercase;
      background: rgba(169,120,255,.12);
      color: #c9b7ff;
      border: 1px solid rgba(169,120,255,.18);
    }

    .kind-ed {
      background: rgba(255,92,168,.11);
      color: #ffb1d0;
      border-color: rgba(255,92,168,.2);
    }

    .kind-in, .kind-ost, .kind-other {
      background: rgba(86,215,255,.09);
      color: #a9eaff;
      border-color: rgba(86,215,255,.16);
    }

    .date {
      color: var(--muted-2);
      font-size: 10px;
      font-weight: 700;
    }

    .anime-title {
      margin: 10px 0 0;
      font-size: clamp(18px, 2.1vw, 22px);
      line-height: 1.12;
      letter-spacing: -.035em;
    }

    .song-title {
      margin-top: 6px;
      color: #ddd7e4;
      font-size: 13px;
      line-height: 1.45;
      font-weight: 700;
    }

    .artist {
      margin-top: 4px;
      color: var(--muted);
      font-size: 11px;
      line-height: 1.4;
    }

    .card-bottom {
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: 10px;
      margin-top: 14px;
    }

    .platforms {
      display: flex;
      flex-wrap: wrap;
      gap: 7px;
      min-width: 0;
    }

    .platform.icon-only {
      width: 34px;
      height: 34px;
      min-height: 34px;
      padding: 0;
      border-radius: 9px;
    }

    .platform.icon-only svg {
      width: 17px;
      height: 17px;
    }

    .play-button-glyph {
      display: grid;
      place-items: center;
      width: 100%;
      height: 100%;
      font-size: 11px;
      line-height: 1;
    }

    .platform.icon-only .sr-only,
    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }

    .platform {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 34px;
      padding: 0 10px;
      border: 1px solid transparent;
      border-radius: 10px;
      color: white;
      text-decoration: none;
      font-size: 10px;
      font-weight: 900;
      white-space: nowrap;
      transition: transform .15s ease, filter .15s ease, box-shadow .15s ease;
    }

    .platform:hover {
      transform: translateY(-1px);
      filter: brightness(1.06);
    }

    .platform.spotify {
      background: linear-gradient(135deg, #17b85a, #1ed760);
      box-shadow: 0 10px 26px rgba(29,215,96,.1);
    }

    .platform.apple {
      background: linear-gradient(135deg, #ff466f, #c92f87);
      box-shadow: 0 10px 26px rgba(255,70,111,.1);
    }

    .platform.watch {
      border-color: rgba(135,105,255,.28);
      background: linear-gradient(135deg, #5f71ff, #8f62ff);
      box-shadow: 0 10px 26px rgba(120,87,255,.16);
    }

    .details {
      flex: 0 0 auto;
      color: #7f7689;
      text-decoration: none;
      font-size: 10px;
      font-weight: 800;
      white-space: nowrap;
    }

    .details:hover { color: var(--text); }

    .pagination-wrap {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 7px;
      flex-wrap: wrap;
      margin-top: 25px;
    }

    .page-button {
      min-width: 36px;
      height: 36px;
      padding: 0 10px;
      border: 1px solid var(--line);
      border-radius: 10px;
      background: rgba(255,255,255,.025);
      color: #948a9e;
      cursor: pointer;
      font-size: 10px;
      font-weight: 900;
    }

    .page-button:hover:not(:disabled) {
      color: white;
      border-color: var(--line-strong);
    }

    .page-button.active {
      color: white;
      border-color: rgba(169,120,255,.36);
      background: linear-gradient(135deg, rgba(169,120,255,.48), rgba(120,87,255,.48));
    }

    .page-button:disabled {
      opacity: .36;
      cursor: not-allowed;
    }

    .page-ellipsis {
      color: #675f70;
      padding: 0 2px;
      font-size: 12px;
    }

    footer {
      padding: 0 0 34px;
      color: #625a69;
      font-size: 10px;
      text-align: center;
    }

    .watch-modal {
      position: fixed;
      inset: 0;
      z-index: 100;
      display: grid;
      place-items: center;
      padding: 20px;
      background: rgba(5,3,9,.78);
      backdrop-filter: blur(18px);
    }

    .watch-modal[hidden] { display: none !important; }

    .watch-dialog {
      width: min(1080px, 100%);
      max-height: min(900px, calc(100vh - 40px));
      overflow: auto;
      border: 1px solid var(--line-strong);
      border-radius: 24px;
      background: linear-gradient(180deg, rgba(21,17,31,.98), rgba(11,9,17,.98));
      box-shadow: 0 45px 140px rgba(0,0,0,.54);
    }

    .watch-dialog-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 18px;
      padding: 18px 18px 14px;
      border-bottom: 1px solid var(--line);
    }

    .watch-dialog-copy { min-width: 0; }

    .watch-dialog-kicker {
      color: #a99aba;
      font-size: 9px;
      font-weight: 900;
      text-transform: uppercase;
      letter-spacing: .14em;
    }

    .watch-dialog-title {
      margin-top: 5px;
      font-size: clamp(18px, 3vw, 26px);
      line-height: 1.15;
      letter-spacing: -.035em;
    }

    .watch-dialog-song {
      margin-top: 4px;
      color: #b6afbf;
      font-size: 12px;
    }

    .watch-close {
      flex: 0 0 auto;
      min-width: 38px;
      height: 38px;
      border: 1px solid var(--line);
      border-radius: 11px;
      background: rgba(255,255,255,.04);
      color: #bcb3c6;
      cursor: pointer;
      font-size: 16px;
    }

    .watch-close:hover { color: white; }

    .watch-video-wrap {
      padding: 14px;
    }

    .theme-video {
      display: block;
      width: 100%;
      max-height: 70vh;
      border-radius: 16px;
      background: #050308;
    }

    .watch-error {
      display: none;
      padding: 28px;
      border: 1px solid var(--line);
      border-radius: 16px;
      background: rgba(255,255,255,.02);
      color: #a89fb0;
      text-align: center;
      font-size: 12px;
    }

    .watch-error.show { display: block; }

    .watch-error a {
      display: inline-flex;
      margin-top: 12px;
      color: #c9b7ff;
      text-decoration: none;
      font-weight: 800;
    }

    .watch-meta {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 0 14px 14px;
      color: #6f6877;
      font-size: 10px;
    }

    .watch-meta a {
      color: #ab9bff;
      text-decoration: none;
      font-weight: 800;
    }

    .empty-state {
      grid-column: 1 / -1;
      padding: 54px 20px;
      border: 1px dashed var(--line-strong);
      border-radius: 22px;
      text-align: center;
      color: var(--muted);
      background: rgba(255,255,255,.018);
    }

    @media (max-width: 1180px) {
      .song-list { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    }

    @media (max-width: 900px) {
      .song-list { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .hero-visual { display: none; }
    }

    @media (max-width: 760px) {
      .wrap { width: min(100%, calc(100% - 22px)); }
      .site-header { padding-top: 13px; }
      .hero { padding: 20px; border-radius: 22px; }
      .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .search-row { grid-template-columns: 1fr; }
      .language-switch { width: 100%; }
      .language-button { flex: 1; }
      .card-bottom { align-items: flex-start; flex-direction: column; }
      .details { padding-top: 1px; }
    }

    @media (max-width: 560px) {
      .song-list { grid-template-columns: 1fr; gap: 13px; }
      h1 { font-size: 43px; }
      .hero-copy { font-size: 13px; }
      .stats { gap: 8px; }
      .stat { padding: 11px 12px; }
      .stat .value { font-size: 17px; }
      .watch-dialog { max-height: calc(100vh - 18px); border-radius: 18px; }
      .watch-modal { padding: 9px; }
    }

    @media (prefers-reduced-motion: reduce) {
      html { scroll-behavior: auto; }
      *, *::before, *::after {
        animation-duration: .01ms !important;
        animation-iteration-count: 1 !important;
        transition-duration: .01ms !important;
      }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <header class="site-header">
      <div class="nav-row">
        <a class="brand-link" href="${htmlEscape(SITE_BASE)}/" aria-label="AniPlaylist home">
          <span class="brand-mark"><span class="brand-note">♫</span></span>
          <span>
            <strong>AniPlaylist</strong><br>
            <span>Anime Music Hub</span>
          </span>
        </a>
        ${isHome ? "" : `<a class="back" href="${htmlEscape(SITE_BASE)}/">← Home</a>`}
      </div>

      <section class="hero" aria-labelledby="season-title">
        <div class="hero-top">
          <div>
            <div class="eyebrow"><span class="eyebrow-dot"></span> AniPlaylist RSS · ${htmlEscape(season)}</div>
            <h1 id="season-title">${htmlEscape(season)}</h1>
            <div class="hero-copy">
              Explore <strong>${orderedItems.length}</strong> anime music releases from this season.${isHome ? " This is the main AniPlaylist music hub." : ""}
              Search across English, romaji, and Japanese titles, jump to Spotify or Apple Music,
              and <strong>watch verified OP/ED videos</strong> directly from AnimeThemes when a real video is available.
            </div>
          </div>

          <div class="hero-visual" aria-hidden="true">
            <div class="eq"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>
          </div>
        </div>

        <div class="stats" aria-label="Season statistics">
          <div class="stat"><div class="label">Releases</div><div class="value">${orderedItems.length}</div></div>
          <div class="stat"><div class="label">Watch videos</div><div class="value">${watchCount}</div></div>
          <div class="stat"><div class="label">Spotify</div><div class="value">${spotifyCount}</div></div>
          <div class="stat"><div class="label">Apple Music</div><div class="value">${appleCount}</div></div>
        </div>


        <div class="hero-actions" aria-label="Season resources">
          <a class="resource-button rss" href="${feedUrl}" title="Open ${htmlEscape(season)} RSS feed" aria-label="Open ${htmlEscape(season)} RSS feed">
            <span class="resource-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M5 5h.01"></path><path d="M5 11a8 8 0 0 1 8 8"></path><path d="M5 5a14 14 0 0 1 14 14"></path><circle cx="5" cy="19" r="1.5" fill="currentColor" stroke="none"></circle></svg></span>
            RSS Feed
          </a>
          <a id="spotify-playlist" class="resource-button spotify" href="#" target="_blank" rel="noopener noreferrer" title="Open ${htmlEscape(season)} Spotify playlist" aria-label="Open ${htmlEscape(season)} Spotify playlist" hidden>
            <span class="resource-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.4a9.6 9.6 0 1 0 0 19.2 9.6 9.6 0 0 0 0-19.2Zm4.1 13.6a.58.58 0 0 1-.8.2c-2.2-1.35-4.97-1.65-8.24-.91a.58.58 0 1 1-.26-1.13c3.58-.82 6.65-.48 9.14 1.03.28.17.37.53.16.81Zm1.12-2.51a.72.72 0 0 1-.99.24c-2.51-1.54-6.35-1.99-9.32-1.08a.72.72 0 1 1-.42-1.38c3.4-1.04 7.65-.54 10.48 1.19.34.21.45.66.25 1.03Zm.1-2.65c-3.01-1.78-7.97-1.95-10.85-1.08a.87.87 0 1 1-.5-1.67c3.31-1 8.8-.81 12.29 1.26a.87.87 0 0 1-.94 1.49Z"/></svg></span>
            Spotify Playlist
          </a>
        </div>
        <nav class="season-strip" aria-label="Anime seasons">
          ${seasonNav}
        </nav>

        <div class="tools">
          <div class="search-row">
            <div class="search-shell">
              <span class="search-icon" aria-hidden="true">⌕</span>
              <input id="browse-search" class="search-input" type="search"
                placeholder="Search anime, song, artist, Japanese, romaji..."
                aria-label="Search ${htmlEscape(season)} releases"
                autocomplete="off" spellcheck="false">
            </div>

            <div class="language-switch" role="group" aria-label="Display title language">
              <button type="button" class="language-button active" data-language="en" aria-pressed="true">English</button>
              <button type="button" class="language-button" data-language="romaji" aria-pressed="false">Romaji</button>
              <button type="button" class="language-button" data-language="ja" aria-pressed="false">日本語</button>
            </div>
          </div>

          <div class="filter-row" role="group" aria-label="Release type">
            <span class="filter-label">Type</span>
            <button type="button" class="filter-button active" data-type-filter="" aria-pressed="true">All</button>
            <button type="button" class="filter-button" data-type-filter="OP" aria-pressed="false">OP</button>
            <button type="button" class="filter-button" data-type-filter="ED" aria-pressed="false">ED</button>
            <button type="button" class="filter-button" data-type-filter="IN" aria-pressed="false">IN</button>
            <button type="button" class="filter-button" data-type-filter="OST" aria-pressed="false">OST</button>
            <button type="button" class="filter-button" data-type-filter="Other" aria-pressed="false">Other</button>
            <button type="button" class="filter-button" data-type-filter="VIDEO" aria-pressed="false">Video</button>
          </div>

          <div class="result-row">
            <span id="search-summary">Showing 0 releases</span>
            <span>24 releases per page</span>
          </div>
        </div>
      </section>
    </header>

    <main>
      <div id="song-list" class="song-list">
        ${cards || '<div class="empty-state">No Spotify or Apple Music entries yet.</div>'}
      </div>
      <div id="pagination" class="pagination-wrap" aria-label="Pagination"></div>
    </main>

    <footer>
      AniPlaylist RSS · ${htmlEscape(season)} · Verified AnimeThemes videos link directly to AnimeThemes media
    </footer>
  </div>

  <div id="watch-modal" class="watch-modal" hidden>
    <div class="watch-dialog" role="dialog" aria-modal="true" aria-labelledby="watch-dialog-title">
      <div class="watch-dialog-head">
        <div class="watch-dialog-copy">
          <div class="watch-dialog-kicker" id="watch-dialog-kicker">AnimeThemes · OP</div>
          <div class="watch-dialog-title" id="watch-dialog-title">Anime</div>
          <div class="watch-dialog-song" id="watch-dialog-song">Theme</div>
        </div>
        <button id="watch-close" class="watch-close" type="button" aria-label="Close video">×</button>
      </div>

      <div class="watch-video-wrap">
        <video id="theme-video" class="theme-video" controls playsinline preload="metadata"></video>
        <div id="watch-error" class="watch-error">
          This AnimeThemes video could not be played in the embedded player.
          <br>
          <a id="watch-direct" href="#" target="_blank" rel="noopener noreferrer">Open the direct AnimeThemes video ↗</a>
        </div>
      </div>

      <div class="watch-meta">
        <span>Video hosted by AnimeThemes</span>
        <a href="https://animethemes.moe/" target="_blank" rel="noopener noreferrer">AnimeThemes ↗</a>
      </div>
    </div>
  </div>

  <script>
    (() => {
      const PAGE_SIZE = 24;
      const input = document.getElementById("browse-search");
      const list = document.getElementById("song-list");
      const summary = document.getElementById("search-summary");
      const pagination = document.getElementById("pagination");
      const cards = [...list.querySelectorAll(".song-card")];
      const languageButtons = [...document.querySelectorAll(".language-button")];
      const filterButtons = [...document.querySelectorAll(".filter-button")];

      const urlParams = new URLSearchParams(location.search);
      let selectedType = urlParams.get("type") || "";
      let currentPage = Number(urlParams.get("page") || "1");
      if (!["", "OP", "ED", "IN", "OST", "Other", "VIDEO"].includes(selectedType)) selectedType = "";
      if (!Number.isFinite(currentPage) || currentPage < 1) currentPage = 1;
      input.value = urlParams.get("q") || "";

      function normalize(value) {
        return String(value || "")
          .toLocaleLowerCase()
          .normalize("NFKC")
          .replace(/[\u200B-\u200D\uFEFF]/g, "")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/\s+/g, " ")
          .trim();
      }

      function updateLanguage(language) {
        const selected = ["en", "romaji", "ja"].includes(language) ? language : "en";

        cards.forEach(card => {
          card.querySelectorAll("[data-en][data-romaji][data-ja]").forEach(el => {
            const next =
              el.getAttribute("data-" + selected) ||
              el.getAttribute("data-en") ||
              el.textContent ||
              "";
            el.textContent = next;
          });
        });

        languageButtons.forEach(button => {
          const active = button.dataset.language === selected;
          button.classList.toggle("active", active);
          button.setAttribute("aria-pressed", active ? "true" : "false");
        });

        try { localStorage.setItem("aniplaylist-language", selected); } catch {}
      }

      function getFilteredCards() {
        const query = normalize(input.value);
        return cards.filter(card => {
          const textMatches = !query || normalize(card.dataset.search || "").includes(query);
          const typeMatches =
            !selectedType ||
            (selectedType === "VIDEO"
              ? card.dataset.hasVideo === "1"
              : card.dataset.kind === selectedType);
          return textMatches && typeMatches;
        });
      }

      function makePageButton(label, page, active, disabled) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "page-button" + (active ? " active" : "");
        button.textContent = label;
        button.disabled = !!disabled;
        if (!disabled) {
          button.addEventListener("click", () => {
            currentPage = page;
            renderPage(true);
          });
        }
        return button;
      }

      function pushPageNumber(label, page, totalPages, fragment) {
        if (fragment === "...") {
          const span = document.createElement("span");
          span.className = "page-ellipsis";
          span.textContent = "…";
          pagination.appendChild(span);
          return;
        }
        pagination.appendChild(makePageButton(label, page, page === currentPage, false));
      }

      function renderPagination(totalPages) {
        pagination.textContent = "";
        if (totalPages <= 1) return;

        pagination.appendChild(makePageButton("←", Math.max(1, currentPage - 1), false, currentPage === 1));

        const pages = [];
        if (totalPages <= 7) {
          for (let page = 1; page <= totalPages; page++) pages.push(page);
        } else {
          pages.push(1);
          if (currentPage > 4) pages.push("...");
          const start = Math.max(2, currentPage - 1);
          const end = Math.min(totalPages - 1, currentPage + 1);
          for (let page = start; page <= end; page++) pages.push(page);
          if (currentPage < totalPages - 3) pages.push("...");
          pages.push(totalPages);
        }

        pages.forEach(page => {
          if (page === "...") {
            pushPageNumber("…", 1, totalPages, "...");
          } else {
            pushPageNumber(String(page), page, totalPages, page);
          }
        });

        pagination.appendChild(makePageButton("→", Math.min(totalPages, currentPage + 1), false, currentPage === totalPages));
      }

      function syncUrl() {
        const url = new URL(location.href);
        const query = input.value.trim();
        if (query) url.searchParams.set("q", query);
        else url.searchParams.delete("q");

        if (selectedType) url.searchParams.set("type", selectedType);
        else url.searchParams.delete("type");

        if (currentPage > 1) url.searchParams.set("page", String(currentPage));
        else url.searchParams.delete("page");

        history.replaceState(null, "", url);
      }

      function renderPage(scrollTop) {
        const filtered = getFilteredCards();
        const total = filtered.length;
        const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

        if (currentPage > totalPages) currentPage = totalPages;

        cards.forEach(card => {
          card.hidden = true;
          card.classList.remove("page-visible");
        });

        const start = (currentPage - 1) * PAGE_SIZE;
        const visible = filtered.slice(start, start + PAGE_SIZE);

        visible.forEach((card, index) => {
          card.hidden = false;
          card.classList.add("page-visible");
          const rank = card.querySelector(".rank-badge");
          if (rank) rank.textContent = "#" + (start + index + 1);
        });

        if (summary) {
          if (!total) {
            summary.innerHTML = "<strong>0</strong> releases";
          } else {
            const from = start + 1;
            const to = Math.min(start + PAGE_SIZE, total);
            summary.innerHTML =
              "Showing <strong>" + from + "–" + to + "</strong> of <strong>" + total + "</strong> releases";
          }
        }

        renderPagination(totalPages);
        syncUrl();

        if (scrollTop) {
          window.scrollTo({ top: Math.max(0, document.querySelector(".song-list").offsetTop - 24), behavior: "smooth" });
        }
      }

      function applySearch() {
        currentPage = 1;
        renderPage(false);
      }

      input.addEventListener("input", applySearch);
      input.addEventListener("change", applySearch);
      input.addEventListener("search", applySearch);

      filterButtons.forEach(button => {
        button.addEventListener("click", () => {
          selectedType = button.dataset.typeFilter || "";
          currentPage = 1;

          filterButtons.forEach(other => {
            const active = other === button;
            other.classList.toggle("active", active);
            other.setAttribute("aria-pressed", active ? "true" : "false");
          });

          renderPage(false);
        });
      });

      languageButtons.forEach(button => {
        button.addEventListener("click", () => updateLanguage(button.dataset.language));
      });

      filterButtons.forEach(button => {
        const active = (button.dataset.typeFilter || "") === selectedType;
        button.classList.toggle("active", active);
        button.setAttribute("aria-pressed", active ? "true" : "false");
      });

      let savedLanguage = "en";
      try { savedLanguage = localStorage.getItem("aniplaylist-language") || "en"; } catch {}
      updateLanguage(savedLanguage);
      renderPage(false);

      const spotifyPlaylist = document.getElementById("spotify-playlist");
      if (spotifyPlaylist) {
        fetch("${SITE_BASE}/spotify-playlists.json", { cache: "no-store" })
          .then(res => res.ok ? res.json() : {})
          .then(data => {
            const playlist = data["${season}"];
            if (playlist?.url) {
              spotifyPlaylist.href = playlist.url;
              spotifyPlaylist.hidden = false;
            }
          })
          .catch(() => {});
      }

      const modal = document.getElementById("watch-modal");
      const video = document.getElementById("theme-video");
      const closeButton = document.getElementById("watch-close");
      const dialog = modal.querySelector(".watch-dialog");
      const dialogTitle = document.getElementById("watch-dialog-title");
      const dialogSong = document.getElementById("watch-dialog-song");
      const dialogKicker = document.getElementById("watch-dialog-kicker");
      const errorBox = document.getElementById("watch-error");
      const directLink = document.getElementById("watch-direct");
      let lastTrigger = null;

      function closePlayer() {
        if (video) {
          video.pause();
          video.removeAttribute("src");
          video.removeAttribute("poster");
          video.load();
        }
        modal.hidden = true;
        document.body.style.overflow = "";
        if (lastTrigger) {
          lastTrigger.focus();
          lastTrigger = null;
        }
      }

      function openPlayer(trigger) {
        const url = String(trigger.dataset.watchUrl || "").trim();
        if (!url) return;

        lastTrigger = trigger;
        dialogTitle.textContent = trigger.dataset.watchTitle || "AnimeThemes";
        dialogSong.textContent = trigger.dataset.watchSong || "Theme";
        dialogKicker.textContent = "AnimeThemes · " + (trigger.dataset.watchKind || "OP");

        errorBox.classList.remove("show");
        directLink.href = url;
        video.poster = trigger.dataset.watchPoster || "";
        video.src = url;

        modal.hidden = false;
        document.body.style.overflow = "hidden";

        const playPromise = video.play();
        if (playPromise?.catch) playPromise.catch(() => {});
      }

      document.querySelectorAll(".platform.watch").forEach(link => {
        link.addEventListener("click", event => {
          event.preventDefault();
          openPlayer(link);
        });
      });

      video.addEventListener("error", () => {
        errorBox.classList.add("show");
      });

      closeButton.addEventListener("click", closePlayer);

      modal.addEventListener("click", event => {
        if (event.target === modal) closePlayer();
      });

      document.addEventListener("keydown", event => {
        if (event.key === "Escape" && !modal.hidden) closePlayer();
      });

      if (dialog) {
        dialog.addEventListener("click", event => event.stopPropagation());
      }
    })();
  </script>
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
    item.artist && item.song
      ? `${item.artist} - ${item.song}`
      : (item.song || item.artist || ""),
  ].filter(Boolean);

  return {
    title,
    description: descriptionLines.join("\n"),
    link: pageUrl,
    guid: `aniplaylist:${key}`,
    pubDate: firstSeen,
    key,
    id: item.id || "",
    season,
    firstSeen,
    detailUrl: item.detailUrl || "",
    anime: item.anime,
    song: item.song,
    artist: item.artist,
    artistDisplay: item.artistDisplay || item.artist,
    kind: item.kind,
    kindLabel: item.kindLabel || prettyKind(item.kind),
    animeCandidates: Array.isArray(item.animeCandidates) ? item.animeCandidates : [],
    titleCandidates: Array.isArray(item.titleCandidates) ? item.titleCandidates : [],
    artistCandidates: Array.isArray(item.artistCandidates) ? item.artistCandidates : [],
    thumbnail: item.thumbnail,
    spotify: item.spotify,
    apple: item.apple,
    animethemesVideo: item.animethemesVideo || null,
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
    <description>Anime music releases for ${rssEscape(season)}. Each item uses the format [TYPE] Anime Title with Artist - Song Name and links to the AniPlaylist release page.</description>
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
const catalogRecords = [];
let homeSeason = "";
let homeSeasonItems = [];
console.log(`Thumbnail resolver self-test: ${thumbnailResolverSelfTest()}`);

for (const season of CFG.seasons) {
  const url = `https://aniplaylist.com/?seasons=${encodeURIComponent(season)}`;
  const diag = {
    season,
    url,
    resultCount: null,
    animeThemesChecked: 0,
    animeThemesMatched: 0,
    animeThemesSeasonLinks: 0,
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

  /*
   * ==========================================================
   * CURRENT SPOTIFY SOURCE OF TRUTH
   * ==========================================================
   *
   * `usable` is the EXACT set of records that is going into the
   * current RSS for this season.
   *
   * Therefore spotify-current.json represents the Spotify tracks
   * belonging to the current RSS, rather than anything historical
   * in state.json.
   */
  currentSpotifyTracks[season] = [
    ...new Set(
      usable
        .map(item => {
          const match = String(item.spotify || "").match(
            /https?:\/\/open\.spotify\.com\/track\/([A-Za-z0-9]+)/i
          );

          return match?.[1] || "";
        })
        .filter(Boolean)
    ),
  ];

  console.log(
    `${season}: current Spotify tracks=${currentSpotifyTracks[season].length}`
  );

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

  const animeThemesResult = await resolveAnimeThemesForSeason(page, usable, season);
  diag.animeThemesChecked = animeThemesResult.checked;
  diag.animeThemesMatched = animeThemesResult.matched;
  diag.animeThemesSeasonLinks = animeThemesResult.seasonLinks;
  diag.animeThemesSeasonLinks = animeThemesResult.seasonLinks;

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

  diag.releases = rssItems.length;
  diag.watchVideos = rssItems.filter(item => !!item.animethemesVideo?.url).length;
  diag.spotifyLinks = rssItems.filter(item => !!item.spotify).length;
  diag.appleLinks = rssItems.filter(item => !!item.apple).length;
  diag.featureImages = rssItems.map(item => item.thumbnail).filter(Boolean).slice(0, 4);
  diag.spotifyPlaylist = spotifyPlaylists?.[season]?.url || "";

  const browsePath = path.join(BROWSE_DIR, slug(season), "index.html");
  await fs.mkdir(path.dirname(browsePath), { recursive: true });
  await fs.writeFile(
    browsePath,
    buildBrowsePage(season, rssItems)
  );

  if (!homeSeasonItems.length && rssItems.length) {
    homeSeason = season;
    homeSeasonItems = rssItems;
  }

  // buildRss sorts by pubDate (firstSeen) descending; preserve that exact
  // previous Browse/RSS order in the single-page catalog.
  const rssXml = buildRss(season, rssItems);
  await fs.writeFile(
    path.join(RSS_DIR, `${slug(season)}.xml`),
    rssXml
  );
  catalogRecords.push(...rssItems.map(item => ({
    ...item,
    season,
    firstSeen: item.firstSeen || item.pubDate,
  })));

  console.log(
    `${season}: results=${diag.resultCount ?? "?"} uniqueHits=${diag.uniqueHits} normalized=${diag.normalized} directSpotify=${diag.withSpotify} resolvedSpotify=${diag.resolvedSpotify}`
  );

  summary.push(diag);
}

// The catalog is made from this run's actual usable releases, not all the
// historical records retained in state.json. That keeps artwork, links, and
// release order aligned with the original season RSS/Browse pages.
await fs.writeFile(
  path.join(SITE_DIR, "catalog.json"),
  JSON.stringify({
    generatedAt: new Date().toISOString(),
    records: catalogRecords,
  }, null, 2) + "\n"
);

/*
 * The root URL is the primary UI. Keep it focused on the first populated
 * configured season instead of maintaining a second, older landing page.
 */
await fs.writeFile(
  path.join(SITE_DIR, "index.html"),
  buildHomePage(summary, homeSeason)
);

/*
 * Persist ONLY the Spotify IDs discovered during this run.
 *
 * This file is intentionally separate from state.json.
 * spotify.mjs must read this file instead of state.json.
 */
await fs.writeFile(
  SPOTIFY_CURRENT_PATH,
  JSON.stringify(currentSpotifyTracks, null, 2) + "\n"
);

await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
resolveCache.__cacheVersion = 2;
await fs.writeFile(CACHE_PATH, JSON.stringify(resolveCache, null, 2) + "\n");

await browser.close();

const summaryText = summary.map(s =>
  `${s.season}: results=${s.resultCount ?? "?"} uniqueHits=${s.uniqueHits} normalized=${s.normalized} spotify=${s.withSpotify} apple=${s.withApple} accepted=${s.resolvedSpotify}`
).join("\n");

await fs.writeFile(path.join(ROOT, "build-summary.txt"), summaryText + "\n");
console.log("\n===== FINAL SUMMARY =====\n" + summaryText);

console.log("\n===== CURRENT SPOTIFY SOURCE OF TRUTH =====");
for (const season of CFG.seasons) {
  console.log(
    `${season}: ${currentSpotifyTracks[season]?.length || 0} tracks`
  );
}
console.log(`Written: ${SPOTIFY_CURRENT_PATH}`);

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
