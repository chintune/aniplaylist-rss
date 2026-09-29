import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { chromium, request as playwrightRequest } from "playwright";

const CONFIG = JSON.parse(await fs.readFile("./seasons.json", "utf8"));
const outDir = path.resolve("./rss");
const statePath = path.resolve("./rss-state.json");
const resolveCachePath = path.resolve("./resolve-cache.json");
const debugDir = path.resolve("./debug");

await fs.mkdir(outDir, { recursive: true });
await fs.mkdir(debugDir, { recursive: true });

function loadJson(file, fallback) {
  return fs.readFile(file, "utf8")
    .then((text) => JSON.parse(text))
    .catch(() => fallback);
}

let state = await loadJson(statePath, {});
if (!state || typeof state !== "object" || Array.isArray(state)) state = {};

let resolveCache = await loadJson(resolveCachePath, {});
if (!resolveCache || typeof resolveCache !== "object" || Array.isArray(resolveCache)) resolveCache = {};

const browser = await chromium.launch({ headless: true });
const api = await playwrightRequest.newContext({
  extraHTTPHeaders: {
    "User-Agent": "Mozilla/5.0 (compatible; AniPlaylistRSS/3.0)",
    "Accept-Language": "en-US,en;q=0.9",
  },
});

const RECHECK_UNAVAILABLE_MS = 2 * 60 * 60 * 1000; // retry Spotify-unavailable items every 2h
const RESOLVE_CONCURRENCY = 6;

function slug(season) {
  return season.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function xmlEscape(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

const TYPE_NAMES = {
  OP: "Opening",
  ED: "Ending",
  IN: "Insert Song",
  CS: "Character Song",
  OST: "Original Soundtrack",
  VA: "Vocal Album",
  IMGA: "Image Album",
  IMGS: "Image Song",
  TS: "Theme Song",
  MV: "Music Video",
  PV: "PV Song",
  OTHER: "Other",
};

function normalizeType(raw) {
  const text = cleanText(raw);
  const code = text
    .replace(/\s*\([^)]*\)\s*/g, "")
    .trim()
    .toUpperCase();
  const base = code.replace(/\d+$/, "");
  return {
    code,
    display: TYPE_NAMES[base] || TYPE_NAMES[code] || text,
  };
}

function isTypeLine(line) {
  const text = cleanText(line);
  return /^(OP|ED|IN|CS|OST|VA|IMGA|IMGS|TS|MV|PV)\d*(?:\s*\([^)]*\))?$/i.test(text)
    || /^Other(?:\s*\([^)]*\))?$/i.test(text);
}

function parseCardLines(lines) {
  const cleaned = lines.map(cleanText).filter(Boolean);
  if (cleaned.length < 4) return null;

  const typeIndex = cleaned.findIndex(isTypeLine);
  if (typeIndex < 1) return null;

  const before = cleaned.slice(0, typeIndex);
  const after = cleaned.slice(typeIndex + 1);
  const byIndex = after.findIndex((line) => /^by\s+/i.test(line));
  if (byIndex < 1) return null;

  const anime = before.at(-1) || "";
  const song = after.slice(0, byIndex).find((line) => line && !/^by\s+/i.test(line)) || "";
  const artist = cleanText(after[byIndex].replace(/^by\s+/i, ""));

  if (!anime || !song) return null;

  return {
    anime,
    typeRaw: cleaned[typeIndex],
    song,
    artist,
    unavailable: cleaned.some((line) => /not available for streaming yet/i.test(line)),
  };
}

async function waitForResults(page) {
  try {
    await page.waitForFunction(
      () => /\b[\d,]+\s+results found\b/i.test(document.body?.innerText || ""),
      { timeout: 45000 },
    );
  } catch {
    // Continue; some transient/empty filter states render without the text.
  }
}

async function exhaustResults(page) {
  let stable = 0;
  let previousHeight = -1;

  for (let i = 0; i < 50; i++) {
    const height = await page.evaluate(() => document.body?.scrollHeight || 0);
    await page.mouse.wheel(0, 3000);
    await page.waitForTimeout(450);
    const newHeight = await page.evaluate(() => document.body?.scrollHeight || 0);

    if (newHeight === previousHeight && height === newHeight) stable++;
    else stable = 0;
    previousHeight = newHeight;
    if (stable >= 4) break;
  }

  for (let round = 0; round < 20; round++) {
    const clicked = await page.evaluate(() => {
      const clean = (s) => String(s).replace(/\s+/g, " ").trim();
      const controls = [...document.querySelectorAll("button, a")];
      const target = controls.find((el) => {
        const text = clean(el.textContent || "");
        const disabled = el.disabled || el.getAttribute("aria-disabled") === "true";
        return !disabled && /^(show more|load more|more|next)$/i.test(text);
      });
      if (!target) return false;
      target.click();
      return true;
    });
    if (!clicked) break;
    await page.waitForTimeout(800);
  }
}

async function extractSeason(page, season) {
  const url = `https://aniplaylist.com/?seasons=${encodeURIComponent(season)}`;
  console.log(`\n=== ${season} ===`);
  console.log(`Loading ${url}`);

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
  await waitForResults(page);
  await page.waitForTimeout(2000);
  await exhaustResults(page);

  const diagnostics = await page.evaluate(() => {
    const body = document.body?.innerText || "";
    const countMatch = body.match(/([\d,]+)\s+results found/i);
    return {
      url: location.href,
      title: document.title,
      bodyLength: body.length,
      resultCount: countMatch ? Number(countMatch[1].replaceAll(",", "")) : null,
      playLinkCount: document.querySelectorAll('a[href*="/play/"]').length,
    };
  });

  console.log(`Rendered result count: ${diagnostics.resultCount ?? "unknown"}`);
  console.log(`AniPlaylist play links in DOM: ${diagnostics.playLinkCount}`);

  const cards = await page.evaluate(() => {
    const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
    const isType = (line) =>
      /^(OP|ED|IN|CS|OST|VA|IMGA|IMGS|TS|MV|PV)\d*(?:\s*\([^)]*\))?$/i.test(line)
      || /^Other(?:\s*\([^)]*\))?$/i.test(line);

    const out = [];
    const seen = new Set();

    for (const anchor of [...document.querySelectorAll('a[href*="/play/"]')]) {
      const href = anchor.href;
      if (!href || !/^https?:\/\/aniplaylist\.com\/play\//i.test(href)) continue;

      let chosen = null;
      let node = anchor;
      for (let depth = 0; depth < 14 && node; depth++, node = node.parentElement) {
        const lines = (node.innerText || "")
          .split(/\r?\n/)
          .map(clean)
          .filter(Boolean);
        if (lines.length < 4 || lines.length > 40) continue;
        const typeIndex = lines.findIndex(isType);
        if (typeIndex < 1) continue;
        const after = lines.slice(typeIndex + 1);
        const byIndex = after.findIndex((line) => /^by\s+/i.test(line));
        if (byIndex < 1) continue;
        chosen = { lines, depth, typeIndex };
        break;
      }

      if (!chosen) continue;
      const parsed = (() => {
        const lines = chosen.lines;
        const typeIndex = chosen.typeIndex;
        const before = lines.slice(0, typeIndex);
        const after = lines.slice(typeIndex + 1);
        const byIndex = after.findIndex((line) => /^by\s+/i.test(line));
        const anime = before.at(-1) || "";
        const song = after.slice(0, byIndex).find((line) => line && !/^by\s+/i.test(line)) || "";
        const artist = byIndex >= 0 ? clean(after[byIndex].replace(/^by\s+/i, "")) : "";
        return {
          anime,
          typeRaw: lines[typeIndex],
          song,
          artist,
          unavailable: lines.some((line) => /not available for streaming yet/i.test(line)),
        };
      })();

      if (!parsed.anime || !parsed.song) continue;
      const key = `${href}|${parsed.typeRaw}|${parsed.song}|${parsed.artist}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...parsed, playUrl: href });
    }

    return out;
  });

  const bodyText = await page.locator("body").innerText().catch(() => "");
  await fs.writeFile(
    path.join(debugDir, `${slug(season)}.txt`),
    [
      `URL=${diagnostics.url}`,
      `TITLE=${diagnostics.title}`,
      `RESULT_COUNT=${diagnostics.resultCount ?? "unknown"}`,
      `PLAY_LINKS=${diagnostics.playLinkCount}`,
      `EXTRACTED_CARDS=${cards.length}`,
      "",
      bodyText,
    ].join("\n"),
    "utf8",
  );

  return { diagnostics, cards };
}

function decodeHtml(s) {
  return String(s)
    .replaceAll("&amp;", "&")
    .replaceAll("&#x2F;", "/")
    .replaceAll("&#47;", "/")
    .replaceAll("\\/", "/")
    .replaceAll("\\u002F", "/")
    .replaceAll("\\u003A", ":");
}

function extractSpotifyFromHtml(html) {
  const text = decodeHtml(html);
  const patterns = [
    /https?:\\?\/\\?\/open\.spotify\.com\/(?:intl-[^/]+\/)?(?:track|album)\/[A-Za-z0-9]+(?:\?[^"'<>\\s]*)?/gi,
    /spotify:(?:track|album):([A-Za-z0-9]+)/gi,
  ];

  for (const pattern of patterns) {
    const matches = [...text.matchAll(pattern)];
    for (const match of matches) {
      const value = match[0];
      if (value.startsWith("spotify:")) {
        const [, kind, id] = value.match(/^spotify:(track|album):([A-Za-z0-9]+)$/i) || [];
        if (kind && id) return `https://open.spotify.com/${kind.toLowerCase()}/${id}`;
      }
      const normalized = value.replace(/\\\//g, "/").replace(/&amp;/g, "&");
      if (/^https?:\/\/open\.spotify\.com\/(?:track|album)\//i.test(normalized)) return normalized;
    }
  }
  return "";
}

async function resolveSpotify(playUrl, fallbackPage) {
  const cached = resolveCache[playUrl];
  const now = Date.now();
  if (cached?.spotify) return cached.spotify;
  if (cached?.checkedAt && now - new Date(cached.checkedAt).getTime() < RECHECK_UNAVAILABLE_MS) {
    return "";
  }

  let spotify = "";
  try {
    const response = await api.get(playUrl, { timeout: 30000 });
    const html = await response.text();
    spotify = extractSpotifyFromHtml(html);
  } catch (error) {
    console.log(`  request failed ${playUrl}: ${error.message}`);
  }

  if (!spotify && fallbackPage) {
    try {
      await fallbackPage.goto(playUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
      await fallbackPage.waitForTimeout(900);
      spotify = await fallbackPage.evaluate(() => {
        const attrs = ["href", "data-href", "data-url", "data-spotify", "data-link"];
        const values = [];
        for (const el of document.querySelectorAll("a,button,[data-href],[data-url],[data-spotify],[data-link]")) {
          for (const attr of attrs) {
            const v = el.getAttribute?.(attr);
            if (v) values.push(v);
          }
        }
        const html = document.documentElement?.outerHTML || "";
        values.push(html);
        for (const raw of values) {
          const text = String(raw).replaceAll("&amp;", "&").replaceAll("\\/", "/").replaceAll("\\u002F", "/");
          const m = text.match(/https?:\/\/open\.spotify\.com\/(?:intl-[^/]+\/)?(track|album)\/([A-Za-z0-9]+)(?:\?[^\s"'<>]*)?/i);
          if (m) return `https://open.spotify.com/${m[1].toLowerCase()}/${m[2]}`;
          const s = text.match(/spotify:(track|album):([A-Za-z0-9]+)/i);
          if (s) return `https://open.spotify.com/${s[1].toLowerCase()}/${s[2]}`;
        }
        return "";
      });
    } catch (error) {
      console.log(`  browser fallback failed ${playUrl}: ${error.message}`);
    }
  }

  resolveCache[playUrl] = {
    spotify,
    checkedAt: new Date().toISOString(),
  };
  return spotify;
}

async function withConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      try {
        results[index] = await fn(items[index], index);
      } catch (error) {
        results[index] = { error };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

function itemKey(item) {
  const basis = [item.playUrl, item.spotify, item.anime, item.type, item.song, item.artist]
    .filter(Boolean)
    .join("|");
  return createHash("sha256").update(basis).digest("hex");
}

function pubDateFor(key) {
  if (!state[key]) state[key] = new Date().toISOString();
  return new Date(state[key]);
}

function buildRss(season, parsed) {
  const unique = new Map();
  for (const item of parsed) {
    const key = itemKey(item);
    if (!unique.has(key)) unique.set(key, { ...item, key });
  }

  const items = [...unique.values()]
    .sort((a, b) => pubDateFor(a.key) - pubDateFor(b.key))
    .map((item) => {
      const title = `[${item.type}] ${item.anime} — ${item.song}`;
      const description =
        `<strong>${xmlEscape(item.anime)}</strong><br>` +
        `${xmlEscape(item.typeLabel)} (${xmlEscape(item.type)}) — ${xmlEscape(item.song)}` +
        (item.artist ? `<br>by ${xmlEscape(item.artist)}` : "") +
        `<br><a href="${xmlEscape(item.spotify)}">Open on Spotify</a>` +
        (item.playUrl ? `<br><a href="${xmlEscape(item.playUrl)}">AniPlaylist</a>` : "");
      const pubDate = pubDateFor(item.key).toUTCString();

      return [
        "    <item>",
        `      <title>${xmlEscape(title)}</title>`,
        `      <link>${xmlEscape(item.spotify)}</link>`,
        `      <guid isPermaLink="false">${xmlEscape(item.key)}</guid>`,
        `      <description><![CDATA[${description}]]></description>`,
        `      <pubDate>${pubDate}</pubDate>`,
        "    </item>",
      ].join("\n");
    })
    .join("\n");

  const latest = [...unique.values()]
    .map((item) => pubDateFor(item.key))
    .sort((a, b) => b - a)[0] || new Date(0);

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0">',
    "  <channel>",
    `    <title>AniPlaylist — ${xmlEscape(season)}</title>`,
    `    <link>https://aniplaylist.com/?seasons=${encodeURIComponent(season)}</link>`,
    `    <description>Spotify-available AniPlaylist entries for ${xmlEscape(season)}.</description>`,
    `    <lastBuildDate>${latest.toUTCString()}</lastBuildDate>`,
    items,
    "  </channel>",
    "</rss>",
    "",
  ].join("\n");
}

try {
  if (!Array.isArray(CONFIG.seasons) || CONFIG.seasons.length === 0) {
    throw new Error("seasons.json must contain a non-empty 'seasons' array");
  }

  for (const season of CONFIG.seasons) {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
      userAgent: "Mozilla/5.0 (compatible; AniPlaylistRSS/3.0)",
    });

    try {
      const { diagnostics, cards } = await extractSeason(page, season);
      console.log(`Parsed AniPlaylist cards: ${cards.length}`);

      const unresolved = cards.filter((item) => !item.unavailable && !resolveCache[item.playUrl]?.spotify);
      console.log(`Need Spotify resolution: ${unresolved.length}`);

      const fallbackPages = [];
      for (let i = 0; i < Math.min(RESOLVE_CONCURRENCY, unresolved.length); i++) {
        fallbackPages.push(await browser.newPage({
          viewport: { width: 1200, height: 900 },
          userAgent: "Mozilla/5.0 (compatible; AniPlaylistRSS/3.0)",
        }));
      }

      try {
        let nextFallback = 0;
        await withConcurrency(unresolved, RESOLVE_CONCURRENCY, async (card) => {
          const fallback = fallbackPages[nextFallback++ % Math.max(1, fallbackPages.length)] || null;
          const spotify = await resolveSpotify(card.playUrl, fallback);
          if (spotify) console.log(`  Spotify: ${card.anime} / ${card.typeRaw} / ${card.song}`);
          return spotify;
        });
      } finally {
        await Promise.all(fallbackPages.map((p) => p.close()));
      }

      const parsed = [];
      for (const card of cards) {
        if (card.unavailable) continue;
        const spotify = resolveCache[card.playUrl]?.spotify || "";
        if (!spotify) continue;
        const type = normalizeType(card.typeRaw);
        parsed.push({
          anime: card.anime,
          type: type.code,
          typeLabel: type.display,
          song: card.song,
          artist: card.artist,
          spotify,
          playUrl: card.playUrl,
        });
      }

      console.log(
        `${season}: rendered=${diagnostics.resultCount ?? "?"} cards=${cards.length} spotifyResolved=${parsed.length}`,
      );

      const file = path.join(outDir, `${slug(season)}.xml`);
      await fs.writeFile(file, buildRss(season, parsed), "utf8");
    } catch (error) {
      console.error(`${season}: scrape failed:`, error);
      throw error;
    } finally {
      await page.close();
    }
  }

  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await fs.writeFile(resolveCachePath, `${JSON.stringify(resolveCache, null, 2)}\n`, "utf8");
} finally {
  await api.dispose();
  await browser.close();
}
