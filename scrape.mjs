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
    "User-Agent": "Mozilla/5.0 (compatible; AniPlaylistRSS/4.0)",
    "Accept-Language": "en-US,en;q=0.9",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  },
});

const RECHECK_UNAVAILABLE_MS = 2 * 60 * 60 * 1000;
const RESOLVE_CONCURRENCY = 4;

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

  // AniPlaylist's card order is: anime, type, song, by artist.
  // There can be extra accessibility/artist/platform text around it, so take the
  // last meaningful line before the type as anime and the first line before "by" as song.
  const animeCandidates = before.filter((line) =>
    !/^Image:/i.test(line) && !/^(Open|Read more|Spotify|Apple Music|Deezer|YouTube Music)$/i.test(line)
  );
  const anime = animeCandidates.at(-1) || "";

  const songCandidates = after.slice(0, byIndex).filter((line) =>
    !/^Image:/i.test(line) && !/^\d+$/.test(line) && !/^(Open|Read more|Spotify|Apple Music|Deezer|YouTube Music)$/i.test(line)
  );
  const song = songCandidates.at(0) || "";
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
      () => {
        const text = document.body?.innerText || "";
        return /\b[\d,]+\s+results found\b/i.test(text)
          || /no results/i.test(text)
          || document.querySelectorAll('img[alt*="CD cover for"]').length > 0;
      },
      { timeout: 45000 },
    );
  } catch {
    // Some empty/future filters do not expose a result-count line.
  }
}

async function exhaustResults(page) {
  // The current site appears to render a finite result set rather than a classic
  // pagination widget, but we still scroll to trigger lazy-rendered cards.
  let previousHeight = -1;
  let stable = 0;
  for (let i = 0; i < 60; i++) {
    const before = await page.evaluate(() => document.body?.scrollHeight || 0);
    await page.mouse.wheel(0, 3500);
    await page.waitForTimeout(350);
    const after = await page.evaluate(() => document.body?.scrollHeight || 0);
    if (after === before && after === previousHeight) stable++;
    else stable = 0;
    previousHeight = after;
    if (stable >= 5) break;
  }

  for (let round = 0; round < 10; round++) {
    const clicked = await page.evaluate(() => {
      const clean = (s) => String(s).replace(/\s+/g, " ").trim();
      const controls = [...document.querySelectorAll("button, a")];
      const target = controls.find((el) => {
        const text = clean(el.textContent || "");
        const disabled = el.disabled || el.getAttribute("aria-disabled") === "true";
        return !disabled && /^(show more|load more|more)$/i.test(text);
      });
      if (!target) return false;
      target.click();
      return true;
    });
    if (!clicked) break;
    await page.waitForTimeout(700);
  }
}

function canonicalInternalUrl(raw) {
  try {
    const url = new URL(raw, "https://aniplaylist.com");
    if (url.origin !== "https://aniplaylist.com") return "";
    if (!url.pathname || url.pathname === "/") return "";
    if (/\.(css|js|png|jpg|jpeg|webp|svg|ico|woff2?)$/i.test(url.pathname)) return "";
    return url.href;
  } catch {
    return "";
  }
}

async function extractSeason(page, season) {
  const url = `https://aniplaylist.com/?seasons=${encodeURIComponent(season)}`;
  console.log(`\n=== ${season} ===`);
  console.log(`Loading ${url}`);

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
  await waitForResults(page);
  await page.waitForTimeout(2500);
  await exhaustResults(page);
  await page.waitForTimeout(500);

  const diagnostics = await page.evaluate(() => {
    const body = document.body?.innerText || "";
    const countMatch = body.match(/([\d,]+)\s+results found/i);
    const imgs = [...document.querySelectorAll('img[alt*="CD cover for"]')];
    return {
      url: location.href,
      title: document.title,
      bodyLength: body.length,
      resultCount: countMatch ? Number(countMatch[1].replaceAll(",", "")) : null,
      cdCovers: imgs.length,
      anchors: document.querySelectorAll("a[href]").length,
      spotifyAnchors: [...document.querySelectorAll("a[href]")].filter((a) => /spotify\.com/i.test(a.href)).length,
    };
  });

  console.log(`Rendered result count: ${diagnostics.resultCount ?? "unknown"}`);
  console.log(`CD cover images in DOM: ${diagnostics.cdCovers}`);
  console.log(`Anchors in DOM: ${diagnostics.anchors}`);
  console.log(`Spotify anchors in DOM: ${diagnostics.spotifyAnchors}`);

  const raw = await page.evaluate(() => {
    const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
    const isType = (line) =>
      /^(OP|ED|IN|CS|OST|VA|IMGA|IMGS|TS|MV|PV)\d*(?:\s*\([^)]*\))?$/i.test(line)
      || /^Other(?:\s*\([^)]*\))?$/i.test(line);

    const candidates = [];
    const seen = new Set();

    function addCandidate(href, el, source) {
      if (!href) return;
      const lines = String(el?.innerText || "")
        .split(/\r?\n/)
        .map(clean)
        .filter(Boolean);
      if (lines.length < 4 || lines.length > 50) return;
      if (!lines.some(isType)) return;
      if (!lines.some((line) => /^by\s+/i.test(line))) return;

      const key = `${href}|${lines.join("\n")}`;
      if (seen.has(key)) return;
      seen.add(key);
      candidates.push({ href, source, lines });
    }

    // 1) Actual card/image links. This is the preferred path on the current site.
    for (const img of [...document.querySelectorAll('img[alt*="CD cover for"]')]) {
      const link = img.closest("a[href]");
      if (link) addCandidate(link.getAttribute("href"), link, "img-closest-a");

      let node = img.parentElement;
      for (let depth = 0; depth < 8 && node; depth++, node = node.parentElement) {
        const href = node.getAttribute?.("data-href") || node.getAttribute?.("data-url") || node.getAttribute?.("data-link");
        if (href) addCandidate(href, node, `img-data-${depth}`);
        const handler = node.getAttribute?.("onclick") || "";
        const match = handler.match(/(?:location\.href|window\.open|href)\s*[:=(]\s*["']([^"']+)["']/i);
        if (match) addCandidate(match[1], node, `img-onclick-${depth}`);
      }
    }

    // 2) Any internal anchor that contains a whole result card.
    for (const a of [...document.querySelectorAll("a[href]")]) {
      const href = a.getAttribute("href") || "";
      if (!href || href.startsWith("#") || /^javascript:/i.test(href)) continue;
      if (/^(mailto:|tel:|https?:\/\/(?!aniplaylist\.com))/i.test(href)) continue;
      addCandidate(href, a, "anchor");
    }

    // 3) Some client-rendered cards are not anchors but have route data on the
    // nearest wrapper. Collect those as a last resort.
    for (const el of [...document.querySelectorAll("[data-href],[data-url],[data-link]")]) {
      const href = el.getAttribute("data-href") || el.getAttribute("data-url") || el.getAttribute("data-link") || "";
      addCandidate(href, el, "data-route");
    }

    return {
      candidates,
      bodyText: document.body?.innerText || "",
      anchorSamples: [...document.querySelectorAll("a[href]")].slice(0, 120).map((a) => ({
        href: a.href,
        text: clean(a.innerText).slice(0, 220),
      })),
      coverSamples: [...document.querySelectorAll('img[alt*="CD cover for"]')].slice(0, 20).map((img) => ({
        alt: img.getAttribute("alt"),
        closestHref: img.closest("a[href]")?.href || "",
        parent: img.parentElement?.outerHTML?.slice(0, 1600) || "",
      })),
    };
  });

  const parsedCards = [];
  const seenPlayUrls = new Set();
  for (const candidate of raw.candidates) {
    const playUrl = canonicalInternalUrl(candidate.href);
    if (!playUrl || seenPlayUrls.has(playUrl)) continue;

    const parsed = parseCardLines(candidate.lines);
    if (!parsed) continue;

    // Keep only URLs that look like an AniPlaylist song/album page. Navigation
    // pages also contain "by" in some cases, so use the card evidence plus a
    // non-root internal URL. We don't hard-code /play/ because the current site
    // uses top-level slugs for song pages.
    if (new URL(playUrl).pathname.split("/").filter(Boolean).length < 1) continue;

    seenPlayUrls.add(playUrl);
    parsedCards.push({ ...parsed, playUrl, source: candidate.source });
  }

  await fs.writeFile(
    path.join(debugDir, `${slug(season)}.json`),
    JSON.stringify({ diagnostics, candidateCount: raw.candidates.length, cards: parsedCards, anchorSamples: raw.anchorSamples, coverSamples: raw.coverSamples }, null, 2),
    "utf8",
  );
  await fs.writeFile(
    path.join(debugDir, `${slug(season)}.txt`),
    [`URL=${diagnostics.url}`, `TITLE=${diagnostics.title}`, `RESULT_COUNT=${diagnostics.resultCount ?? "unknown"}`, `CD_COVERS=${diagnostics.cdCovers}`, `ANCHORS=${diagnostics.anchors}`, `SPOTIFY_ANCHORS=${diagnostics.spotifyAnchors}`, `CANDIDATES=${raw.candidates.length}`, `EXTRACTED_CARDS=${parsedCards.length}`, "", raw.bodyText].join("\n"),
    "utf8",
  );

  return { diagnostics, cards: parsedCards };
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

function normalizeSpotifyUrl(raw) {
  const text = decodeHtml(raw).replace(/\\\//g, "/");
  const m = text.match(/https?:\/\/open\.spotify\.com\/(?:intl-[^/]+\/)?(track|album)\/([A-Za-z0-9]+)(?:[?#][^\s"'<>)]*)?/i);
  if (m) return `https://open.spotify.com/${m[1].toLowerCase()}/${m[2]}`;
  const s = text.match(/spotify:(track|album):([A-Za-z0-9]+)/i);
  if (s) return `https://open.spotify.com/${s[1].toLowerCase()}/${s[2]}`;
  return "";
}

function extractSpotifyFromHtml(html) {
  const text = decodeHtml(html);
  return normalizeSpotifyUrl(text);
}

async function resolveSpotify(playUrl, fallbackPage) {
  const cached = resolveCache[playUrl];
  const now = Date.now();
  if (cached?.spotify) return cached.spotify;
  if (cached?.checkedAt && now - new Date(cached.checkedAt).getTime() < RECHECK_UNAVAILABLE_MS) return "";

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
      await fallbackPage.waitForTimeout(1500);

      spotify = await fallbackPage.evaluate(() => {
        const values = [];
        const attrs = ["href", "src", "data-href", "data-url", "data-spotify", "data-link", "onclick", "aria-label", "title"];
        for (const el of document.querySelectorAll("a,button,[data-href],[data-url],[data-spotify],[data-link],[onclick]")) {
          for (const attr of attrs) {
            const v = el.getAttribute?.(attr);
            if (v) values.push(v);
          }
          if (/spotify/i.test(el.textContent || "")) values.push(el.outerHTML || "");
        }
        values.push(document.documentElement?.outerHTML || "");

        for (const raw of values) {
          const text = String(raw)
            .replaceAll("&amp;", "&")
            .replaceAll("\\/", "/")
            .replaceAll("\\u002F", "/")
            .replaceAll("\\u003A", ":");
          const m = text.match(/https?:\/\/open\.spotify\.com\/(?:intl-[^/]+\/)?(track|album)\/([A-Za-z0-9]+)(?:[?#][^\s"'<>)]*)?/i);
          if (m) return `https://open.spotify.com/${m[1].toLowerCase()}/${m[2]}`;
          const s = text.match(/spotify:(track|album):([A-Za-z0-9]+)/i);
          if (s) return `https://open.spotify.com/${s[1].toLowerCase()}/${s[2]}`;
        }
        return "";
      });

      // Last resort: click a Spotify-labelled link/button and capture a popup.
      if (!spotify) {
        const locator = fallbackPage.locator('a,button').filter({ hasText: /Spotify/i }).first();
        if (await locator.count()) {
          const href = await locator.getAttribute("href").catch(() => "");
          spotify = normalizeSpotifyUrl(href || "");
          if (!spotify) {
            const popupPromise = fallbackPage.waitForEvent("popup", { timeout: 5000 }).catch(() => null);
            await locator.click({ timeout: 5000 }).catch(() => {});
            const popup = await popupPromise;
            if (popup) {
              await popup.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
              spotify = normalizeSpotifyUrl(popup.url());
              await popup.close().catch(() => {});
            }
            if (!spotify) spotify = normalizeSpotifyUrl(fallbackPage.url());
          }
        }
      }
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
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/154 Safari/537.36",
    });

    try {
      const { diagnostics, cards } = await extractSeason(page, season);
      console.log(`Parsed AniPlaylist cards: ${cards.length}`);

      // Safety guard: if AniPlaylist tells us there are results but our parser
      // finds zero cards, fail rather than publishing an empty feed over a good one.
      if (diagnostics.resultCount !== null && diagnostics.resultCount > 0 && cards.length === 0) {
        throw new Error(`Parser found 0 cards even though AniPlaylist reported ${diagnostics.resultCount} results. See debug/${slug(season)}.json.`);
      }

      const unresolved = cards.filter((item) => !item.unavailable && !resolveCache[item.playUrl]?.spotify);
      console.log(`Need Spotify resolution: ${unresolved.length}`);

      const fallbackPages = [];
      for (let i = 0; i < Math.min(RESOLVE_CONCURRENCY, unresolved.length); i++) {
        fallbackPages.push(await browser.newPage({
          viewport: { width: 1200, height: 900 },
          userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/154 Safari/537.36",
        }));
      }

      try {
        let nextFallback = 0;
        await withConcurrency(unresolved, RESOLVE_CONCURRENCY, async (card) => {
          const fallback = fallbackPages[nextFallback++ % Math.max(1, fallbackPages.length)] || null;
          const spotify = await resolveSpotify(card.playUrl, fallback);
          if (spotify) console.log(`  Spotify: ${card.anime} / ${card.typeRaw} / ${card.song}`);
          else console.log(`  NO SPOTIFY: ${card.anime} / ${card.typeRaw} / ${card.song} -> ${card.playUrl}`);
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

      console.log(`${season}: rendered=${diagnostics.resultCount ?? "?"} cards=${cards.length} spotifyResolved=${parsed.length}`);
      const file = path.join(outDir, `${slug(season)}.xml`);
      await fs.writeFile(file, buildRss(season, parsed), "utf8");
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
