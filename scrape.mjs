import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { chromium } from "playwright";
import { assertCompleteScrape, buildSpotifyReferences, cdataSafe } from "./lib/scrape-safety.mjs";
import { findHistoricalRecord, isValidAniPlaylistDetailUrl, recordKeyFor } from "./lib/record-identity.mjs";

const ROOT = process.cwd();
const CFG = JSON.parse(await fs.readFile(path.join(ROOT, "seasons.json"), "utf8"));
if (
  !CFG || !Array.isArray(CFG.seasons) || CFG.seasons.length === 0 ||
  CFG.seasons.some(season => typeof season !== "string" || !season.trim()) ||
  new Set(CFG.seasons).size !== CFG.seasons.length
) {
  throw new Error("seasons.json must contain a nonempty array of unique season names.");
}
const RSS_DIR = path.join(ROOT, "rss");
const DEBUG_DIR = path.join(ROOT, "debug");
const SITE_DIR = path.join(ROOT, "site");
const SONGS_DIR = path.join(SITE_DIR, "song");
const BROWSE_DIR = path.join(SITE_DIR, "browse");
const STATE_PATH = path.join(ROOT, "state.json");

/*
 * Spotify source of truth for the CURRENT scrape only.
 *
 * This is intentionally separate from state.json.
 * state.json is historical and must never be used to determine
 * what belongs in the current Spotify playlists.
 */
const SPOTIFY_CURRENT_PATH = path.join(ROOT, "spotify-current.json");
const SPOTIFY_PLAYLISTS_PATH = path.join(ROOT, "spotify-playlists.json");
const currentSpotifySources = {};
// Track keys already assigned in this build; a collision should stop publication.
const claimedRecordKeys = new Map();
let spotifyPlaylists = {};
spotifyPlaylists = JSON.parse(await fs.readFile(SPOTIFY_PLAYLISTS_PATH, "utf8"));
if (!spotifyPlaylists || typeof spotifyPlaylists !== "object" || Array.isArray(spotifyPlaylists)) {
  throw new Error("spotify-playlists.json must contain a JSON object.");
}

await fs.mkdir(RSS_DIR, { recursive: true });
await fs.mkdir(DEBUG_DIR, { recursive: true });
await fs.mkdir(SONGS_DIR, { recursive: true });
await fs.mkdir(BROWSE_DIR, { recursive: true });

const SITE_BASE = String(
  process.env.SITE_BASE || "https://chintu-io.github.io/aniplaylist-rss"
).replace(/\/$/, "");

const SITE_APP_TEMPLATE = await fs.readFile(path.join(SITE_DIR, "index.html"), "utf8");
if (!SITE_APP_TEMPLATE.includes("<html") || !SITE_APP_TEMPLATE.includes('id="trackList"')) {
  throw new Error("site/index.html is not the expected AniPlaylist app template.");
}

// One shared timestamp per scrape: tracks first detected in the same build
// then use the numeric source ID as a deterministic newest-first tie-breaker.
const BUILD_STARTED_AT = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();

let state = {};
try {
  state = JSON.parse(await fs.readFile(STATE_PATH, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") {
    throw new Error(`Could not read ${path.basename(STATE_PATH)}: ${error.message}`);
  }
}
if (!state || typeof state !== "object" || Array.isArray(state)) {
  throw new Error("state.json must contain a JSON object.");
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

function episodeValues(value) {
  const values = Array.isArray(value) ? value : value == null ? [] : [value];
  return unique(values.map(entry => {
    const raw = entry && typeof entry === "object"
      ? textFrom(entry, ["episode", "episode_number", "number", "name", "title", "value"])
      : clean(entry);
    if (!raw) return "";
    const match = raw.match(/(?:episode|ep)\s*\.?\s*#?\s*(\d+(?:\.\d+)?)/i)
      || raw.match(/^#?\s*(\d+(?:\.\d+)?)$/);
    return match ? match[1] : raw;
  }));
}

function sourceKindLabel(hit, kind, episodes = episodeValues(hit?.episodes)) {
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
  const base = detailed || labels[0] || prettyKind(kind) || kind || "Other";
  if (/^insert(?:ion)?(?:\s+song)?\b/i.test(base) && episodes.length && !/\(\s*ep\b/i.test(base)) {
    return "Insert (ep " + episodes.join(", ") + ")";
  }
  return base;
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

  // Keep the primary artist stable and Latin-first for RSS identity. The full
  // displayed credit is stored separately so collaborations are not lost.
  const artist = artists.find(isLikelyArtistDisplay)
    || displayArtists.find(isLikelyArtistDisplay)
    || textFrom(hit.artist, ["name", "artist"]);
  const artistDisplay = formatArtistNames(displayArtists) || artist;
  const artistDisplayCount = displayArtists.length || (artist ? 1 : 0);

  const kind = clean(
    hit.song_type_short
    || hit.song_type
    || hit.type
    || ""
  );
  const episodes = episodeValues(hit.episodes);
  const kindLabel = sourceKindLabel(hit, kind, episodes);

  const spotify = findSpotify(hit.links) || findSpotify(hit.platforms);
  const apple = findAppleMusic(hit.links) || findAppleMusic(hit.platforms);

  const detailUrl = [
    firstAniPlaylistUrl(hit.web),
    firstAniPlaylistUrl(hit.short_link),
    firstAniPlaylistUrl(hit.url),
  ].find(isValidAniPlaylistDetailUrl) || "";

  return {
    id: clean(hit.objectID || hit.id || hit.song_key || ""),
    anime,
    song,
    artist,
    artistDisplay,
    artistDisplayCount,
    kind,
    kindLabel,
    episodes,
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

function releaseTimestamp(item) {
  const raw = item?.firstSeen || item?.pubDate || item?.created_at || item?.updated_at || "";
  const parsed = raw ? Date.parse(raw) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function releaseNumericId(item) {
  const id = String(item?.id || "");
  return /^\d+$/.test(id) ? Number(id) : null;
}

function compareReleaseOrder(a, b) {
  const byDate = releaseTimestamp(b) - releaseTimestamp(a);
  if (byDate) return byDate;
  // Several songs first discovered in one build can share a millisecond.
  // AniPlaylist's numeric IDs are monotonic, so show the newest ID first.
  const aId = releaseNumericId(a);
  const bId = releaseNumericId(b);
  if (aId !== null && bId !== null && aId !== bId) return bId - aId;
  return String(b?.id || "").localeCompare(String(a?.id || ""))
    || String(a?.song || "").localeCompare(String(b?.song || ""));
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

function buildAppPage({ title, description, canonical, item = null }) {
  const baseTag = `<base href="${htmlEscape(SITE_BASE + "/")}">`;
  let page = SITE_APP_TEMPLATE.replace(/<head>/i, `<head>\n  ${baseTag}`);
  page = page.replace(/<title>[\s\S]*?<\/title>/i, `<title>${htmlEscape(title)}</title>`);
  page = page.replace(
    /<meta name="description" content="[^"]*">/i,
    `<meta name="description" content="${htmlEscape(description)}">`
  );

  const tags = [];
  if (canonical) {
    tags.push(`<link rel="canonical" href="${htmlEscape(canonical)}">`);
  }

  if (item) {
    const song = item.song || "Unknown song";
    const anime = item.anime || "Unknown anime";
    const artist = item.artist || "";
    const socialTitle = `[${item.kind || "Other"}] ${anime}`;
    const socialDescription = [song, artist, prettyKind(item.kind), item.season].filter(Boolean).join(" · ");
    const image = normalizeImageUrl(item.thumbnail, SITE_BASE);

    tags.push(
      '<meta property="og:type" content="music.song">',
      `<meta property="og:title" content="${htmlEscape(socialTitle)}">`,
      `<meta property="og:description" content="${htmlEscape(socialDescription)}">`,
      `<meta property="og:url" content="${htmlEscape(canonical)}">`,
      '<meta property="og:site_name" content="AniPlaylist">'
    );
    if (image) tags.push(`<meta property="og:image" content="${htmlEscape(image)}">`);
    tags.push(
      `<meta name="twitter:card" content="${image ? "summary_large_image" : "summary"}">`,
      `<meta name="twitter:title" content="${htmlEscape(socialTitle)}">`,
      `<meta name="twitter:description" content="${htmlEscape(socialDescription)}">`
    );
    if (image) tags.push(`<meta name="twitter:image" content="${htmlEscape(image)}">`);
  }

  return page.replace("</head>", tags.join("\n") + "\n</head>");
}

function buildSongPage(item, season, key) {
  const anime = item.anime || "Unknown anime";
  const song = item.song || "Unknown song";
  const artist = item.artist || "";
  const description = [anime, song, artist, prettyKind(item.kind), season].filter(Boolean).join(" · ");
  const canonical = `${SITE_BASE}/song/${key}/`;

  return buildAppPage({
    title: `${song} — ${anime} | AniPlaylist`,
    description,
    canonical,
    item: { ...item, season },
  });
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
  "again", "tomorrow", "beyond", "past", "super", "psychic", "policeman",
  "bloom", "blue", "sky", "future", "memory", "memories", "eternal", "beautiful",
]);

const ROMAJI_HINTS = new Set([
  "no", "wa", "ga", "wo", "o", "ni", "de", "to", "mo", "he", "kara", "made",
  "nara", "ne", "yo", "desu", "masu", "shita", "shite", "suru", "seka",
  "sekai", "majo", "hajimemashita", "tensei", "reijou", "jou", "kanashii",
  "bokura", "kimi", "boku", "watashi", "kokoro", "hoshi", "meguru",
  "eikyouroku", "saikyou", "uta", "yoru", "kaze", "hana",
  "mata", "ashita", "choujun", "choujou", "senpai", "mikansei", "mirai",
  "yume", "sora", "koi", "suki", "daisuki", "natsu", "haru", "fuyu", "aki",
  "niji", "sakura", "akari", "hikari", "yami", "ame", "arigatou", "tsuki",
  "aisuru", "aisite", "minna", "kirai", "shiawase", "hajimari", "owari",
]);

function hasJapaneseScript(value) {
  return JAPANESE_TITLE_RE.test(String(value || ""));
}

function isLikelyArtistDisplay(value) {
  const s = clean(value);
  if (!s) return false;
  if (/^\d+$/.test(s)) return false;
  // Preserve long all-lowercase romanizations (e.g. senntimirimenntaru);
  // platform IDs normally contain digits, mixed case, underscores, or hyphens.
  if (/^[A-Za-z0-9_-]{16,}$/.test(s) && !/\s/.test(s)
      && (/[0-9]/.test(s) || /[A-Z]/.test(s) || /[_-]/.test(s))) return false;
  return true;
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


function buildBrowsePage(season, items, options = {}) {
  const slugSeason = slug(season);
  const canonical = `${SITE_BASE}/browse/${slugSeason}/`;
  const count = Array.isArray(items) ? items.length : 0;

  return buildAppPage({
    title: `AniPlaylist — ${season} | anime music`,
    description: `Browse ${count} anime music releases from ${season}. Search tracks, filter by type, watch videos, and open streaming links.`,
    canonical,
  });
}

async function makeRssItem(item, season) {
  const kind = item.kind || "Other";

  const itemId = clean(item.id);
  const itemDetailUrl = isValidAniPlaylistDetailUrl(item.detailUrl) ? clean(item.detailUrl) : "";
  const sourceItem = { ...item, detailUrl: itemDetailUrl };
  const matchedPrior = findHistoricalRecord(sourceItem, season, state);
  const priorRecord = matchedPrior?.record || null;

  // Numeric source IDs always retain a deterministic, per-track key. A shared
  // placeholder URL such as /hidden can never make two releases share a GUID.
  const key = recordKeyFor({
    season,
    item: sourceItem,
    priorKey: matchedPrior?.key || null,
  });
  const owner = `${season}|${itemId || [item.anime, item.kind, item.song, item.artist].join("|")}`;
  const keyOwner = claimedRecordKeys.get(key);
  if (keyOwner && keyOwner !== owner) {
    throw new Error(`${season}: record key collision ${key} between ${keyOwner} and ${owner}`);
  }
  claimedRecordKeys.set(key, owner);

  const priorTimestamp = Date.parse(priorRecord?.firstSeen || "");
  const firstSeen = Number.isFinite(priorTimestamp)
    ? new Date(Math.floor(priorTimestamp / 1000) * 1000).toISOString()
    : (priorRecord?.firstSeen || BUILD_STARTED_AT);

  const currentEpisodes = episodeValues(item.episodes);
  const mergedItem = {
    ...(priorRecord || {}),
    ...item,
    id: itemId,
    detailUrl: itemDetailUrl,
    firstSeen,
    season,
    kind,
    kindLabel: item.kindLabel || prettyKind(kind),
    episodes: currentEpisodes.length ? currentEpisodes : episodeValues(priorRecord?.episodes),
    // Never merge translation candidates from historical records. Each array
    // must describe this source hit only; old state may already be polluted.
    titleCandidates: Array.isArray(item.titleCandidates) ? [...item.titleCandidates] : [],
    animeCandidates: Array.isArray(item.animeCandidates) ? [...item.animeCandidates] : [],
    artistCandidates: Array.isArray(item.artistCandidates) ? [...item.artistCandidates] : [],
  };

  // Remove duplicate historical entries for the same source ID after migrating
  // it back to its canonical key. This cleans up keys created by older builds.
  if (itemId) {
    for (const [oldKey, oldRecord] of Object.entries(state)) {
      if (oldKey !== key
          && String(oldRecord?.season || "") === String(season)
          && clean(oldRecord?.id) === itemId) {
        delete state[oldKey];
      }
    }
  }
  state[key] = mergedItem;

  const relativePage = "song/" + key + "/";
  const pageDir = path.join(SITE_DIR, relativePage);
  await fs.mkdir(pageDir, { recursive: true });
  await fs.writeFile(path.join(pageDir, "index.html"), buildSongPage(mergedItem, season, key));

  const pageUrl = SITE_BASE + "/" + relativePage;
  const descriptionLines = [
    mergedItem.artist && mergedItem.song
      ? mergedItem.artist + " - " + mergedItem.song
      : (mergedItem.song || mergedItem.artist || ""),
  ].filter(Boolean);

  return {
    title: "[" + kind + "] " + (mergedItem.anime || "Unknown anime"),
    description: descriptionLines.join("\n"),
    link: pageUrl,
    guid: "aniplaylist:" + key,
    pubDate: firstSeen,
    key,
    id: item.id || "",
    season,
    firstSeen,
    detailUrl: mergedItem.detailUrl || "",
    anime: mergedItem.anime,
    song: mergedItem.song,
    artist: mergedItem.artist,
    artistDisplay: mergedItem.artistDisplay || mergedItem.artist,
    artistDisplayCount: mergedItem.artistDisplayCount || (mergedItem.artist ? 1 : 0),
    kind: mergedItem.kind,
    kindLabel: mergedItem.kindLabel || prettyKind(mergedItem.kind),
    episodes: episodeValues(mergedItem.episodes),
    animeCandidates: mergedItem.animeCandidates,
    titleCandidates: mergedItem.titleCandidates,
    artistCandidates: mergedItem.artistCandidates,
    thumbnail: mergedItem.thumbnail,
    spotify: mergedItem.spotify,
    apple: mergedItem.apple,
    animethemesVideo: mergedItem.animethemesVideo || null,
  };
}

function buildRss(season, items) {
  items.sort(compareReleaseOrder);

  const body = items.map(i => `    <item>
      <title>${rssEscape(i.title)}</title>
      <description><![CDATA[${cdataSafe(i.description)}]]></description>
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
console.log(`Thumbnail resolver self-test: ${thumbnailResolverSelfTest()}`);

for (const season of CFG.seasons) {
  const url = `https://aniplaylist.com/?seasons=${encodeURIComponent(season)}`;
  const diag = {
    season,
    url,
    pageLoaded: false,
    scrapeValidated: false,
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
    diag.pageLoaded = true;
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

  try {
    const completeness = assertCompleteScrape({
      season,
      pageLoaded: diag.pageLoaded,
      errors: diag.errors,
      hitArrays,
      uniqueHits: diag.uniqueHits,
      normalized: diag.normalized,
      resultCount: diag.resultCount,
    });
    Object.assign(diag, completeness, { scrapeValidated: true });
  } catch (error) {
    diag.errors.push(error.message);
    await fs.writeFile(
      path.join(DEBUG_DIR, `${slug(season)}.json`),
      JSON.stringify({
        ...diag,
        hitMeta: hitArrays.map(response => ({
          url: response.url,
          page: response.page,
          nbHits: response.nbHits,
          hitsPerPage: response.hitsPerPage,
          nbPages: response.nbPages,
          count: response.hits.length,
        })),
      }, null, 2)
    );
    await browser.close();
    throw error;
  }

  const withSpotify = normalized.filter(x => !!x.spotify);
  const withApple = normalized.filter(x => !!x.apple);
  const withPlatform = normalized.filter(x => !!x.spotify || !!x.apple);
  const withDetailUrl = normalized.filter(x => !!x.detailUrl);
  diag.recordThumbnails = normalized.filter(x => !!x.thumbnail).length;
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
      sourceMetadataSamples: rawHits.filter(hit => {
        const titles = textListFrom(hit.titles, ["title", "name", "text"]);
        const label = titles.join(" ");
        return /Kanawanai|Mata Ashita|TINY LUCK|Hikari|Dead Flutter|Steel My Soul|pavilion|Choux Cream|Hoshizora ni Akogare/i.test(label);
      }).slice(0, 12).map(hit => ({
        id: clean(hit.objectID || hit.id || hit.song_key || ""),
        titles: hit.titles,
        rawArtists: hit.artists,
        rawDisplayArtists: hit.display_artists,
        type: hit.type,
        song_type: hit.song_type,
        song_type_short: hit.song_type_short,
        label: hit.label,
        tags: hit.tags,
        episodeFields: Object.fromEntries(Object.entries(hit).filter(([key]) => /episode|\bep\b|sequence|number|track|order|position|type|label|tag/i.test(key))),
      })),
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

  // buildRss sorts by pubDate (firstSeen) descending; preserve that exact
  // previous Browse/RSS order in the single-page catalog.
  const rssXml = buildRss(season, rssItems);
  await fs.writeFile(
    path.join(RSS_DIR, `${slug(season)}.xml`),
    rssXml
  );

  // buildRss sorts rssItems in place with the same comparator used by the
  // website catalog: newest first, stable source-ID tie-break for same-batch entries.
  // Create Spotify refs only after this sort, so playlist order follows the site.
  currentSpotifySources[season] = {
    complete: true,
    resultCount: diag.expectedHits,
    refs: buildSpotifyReferences(rssItems),
  };

  console.log(
    `${season}: current Spotify references=${currentSpotifySources[season].refs.length}`
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
 * Persist ONLY the Spotify IDs discovered during this run.
 *
 * This file is intentionally separate from state.json.
 * spotify.mjs must read this file instead of state.json.
 */
await fs.writeFile(
  SPOTIFY_CURRENT_PATH,
  JSON.stringify({
    version: 2,
    generatedAt: BUILD_STARTED_AT,
    seasons: currentSpotifySources,
  }, null, 2) + "\n"
);

await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2) + "\n");

await browser.close();

const summaryText = summary.map(s =>
  `${s.season}: results=${s.resultCount ?? "?"} uniqueHits=${s.uniqueHits} normalized=${s.normalized} spotify=${s.withSpotify} apple=${s.withApple} accepted=${s.resolvedSpotify}`
).join("\n");

await fs.writeFile(path.join(ROOT, "build-summary.txt"), summaryText + "\n");
console.log("\n===== FINAL SUMMARY =====\n" + summaryText);

console.log("\n===== CURRENT SPOTIFY SOURCE OF TRUTH =====");
for (const [season, source] of Object.entries(currentSpotifySources)) {
  console.log(`${season}: ${source.refs.length} references`);
}
console.log(`Written: ${SPOTIFY_CURRENT_PATH}`);
