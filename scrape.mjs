import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { chromium } from "playwright";

const CONFIG = JSON.parse(await fs.readFile("./seasons.json", "utf8"));
const outDir = path.resolve("./rss");
const statePath = path.resolve("./rss-state.json");
const debugDir = path.resolve("./debug");

await fs.mkdir(outDir, { recursive: true });
await fs.mkdir(debugDir, { recursive: true });

let state = {};
try {
  state = JSON.parse(await fs.readFile(statePath, "utf8"));
  if (!state || typeof state !== "object" || Array.isArray(state)) state = {};
} catch {
  state = {};
}

const browser = await chromium.launch({ headless: true });

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
  IN: "Insert",
  CS: "Character Song",
  OST: "OST",
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

function findType(lines) {
  for (let i = 0; i < lines.length; i++) {
    const line = cleanText(lines[i]);
    if (!line) continue;
    if (/^(OP|ED|IN|CS|OST|VA|IMGA|IMGS|TS|MV|PV)\d*(?:\s*\([^)]*\))?$/i.test(line)) {
      return { index: i, raw: line };
    }
    if (/^Other(?:\s*\([^)]*\))?$/i.test(line)) {
      return { index: i, raw: "Other" };
    }
  }
  return null;
}

async function waitForResults(page) {
  try {
    await page.waitForFunction(
      () => /\b[\d,]+\s+results found\b/i.test(document.body?.innerText || ""),
      { timeout: 45000 },
    );
  } catch {
    // Keep going; some filtered states can take a different rendering path.
  }
}

async function exhaustResults(page) {
  let stable = 0;
  let previousHeight = -1;

  for (let i = 0; i < 40; i++) {
    const height = await page.evaluate(() => document.body.scrollHeight || 0);
    await page.mouse.wheel(0, 3000);
    await page.waitForTimeout(500);

    const newHeight = await page.evaluate(() => document.body.scrollHeight || 0);
    if (newHeight === previousHeight && height === newHeight) stable++;
    else stable = 0;
    previousHeight = newHeight;

    if (stable >= 3) break;
  }

  for (let round = 0; round < 15; round++) {
    const clicked = await page.evaluate(() => {
      const buttons = [...document.querySelectorAll("button, a")];
      const target = buttons.find((el) => {
        const text = clean(el.textContent || "");
        const disabled = el.disabled || el.getAttribute("aria-disabled") === "true";
        return !disabled && /^(show more|load more|more|next)$/i.test(text);
      });
      if (!target) return false;
      target.click();
      return true;

      function clean(s) {
        return String(s).replace(/\s+/g, " ").trim();
      }
    });
    if (!clicked) break;
    await page.waitForTimeout(1000);
  }
}

async function extractSeason(page, season) {
  const url = `https://aniplaylist.com/?seasons=${encodeURIComponent(season)}`;
  console.log(`\\n=== ${season} ===`);
  console.log(`Loading ${url}`);

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
  await waitForResults(page);
  await page.waitForTimeout(2500);
  await exhaustResults(page);

  const diagnostics = await page.evaluate(() => {
    const body = document.body?.innerText || "";
    const countMatch = body.match(/([\d,]+)\s+results found/i);
    const spotify = [...document.querySelectorAll('a[href*="open.spotify.com/"]')]
      .map((a) => a.href)
      .filter((href) => /open\.spotify\.com\/(track|album)\//i.test(href));
    return {
      url: location.href,
      title: document.title,
      bodyLength: body.length,
      resultCount: countMatch ? Number(countMatch[1].replaceAll(",", "")) : null,
      spotifyLinkCount: spotify.length,
    };
  });

  console.log(`Rendered result count: ${diagnostics.resultCount ?? "unknown"}`);
  console.log(`Spotify links in DOM: ${diagnostics.spotifyLinkCount}`);

  const result = await page.evaluate(() => {
    const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
    const spotifyAnchors = [...document.querySelectorAll('a[href*="open.spotify.com/"]')]
      .filter((a) => /open\.spotify\.com\/(track|album)\//i.test(a.href));

    const out = [];
    const seen = new Set();

    const typeRe = /^(OP|ED|IN|CS|OST|VA|IMGA|IMGS|TS|MV|PV)\d*(?:\s*\([^)]*\))?$/i;

    for (const anchor of spotifyAnchors) {
      let node = anchor;
      const candidates = [];

      for (let depth = 0; depth < 12 && node; depth++, node = node.parentElement) {
        const lines = (node.innerText || "")
          .split(/\r?\n/)
          .map(clean)
          .filter(Boolean);

        if (lines.length < 3 || lines.length > 30) continue;

        let typeIndex = -1;
        let typeRaw = "";
        for (let i = 0; i < lines.length; i++) {
          if (typeRe.test(lines[i]) || /^Other(?:\s*\([^)]*\))?$/i.test(lines[i])) {
            typeIndex = i;
            typeRaw = lines[i];
            break;
          }
        }
        if (typeIndex < 1) continue;

        const hasBy = lines.some((line) => /^by\s+/i.test(line));
        if (!hasBy) continue;

        candidates.push({ depth, lines, typeIndex, typeRaw });
      }

      if (!candidates.length) continue;
      candidates.sort((a, b) => a.depth - b.depth);
      const card = candidates[0];

      const before = card.lines.slice(0, card.typeIndex);
      const after = card.lines.slice(card.typeIndex + 1);
      const anime = before.at(-1) || "";
      const song = after.find((line) => line && !/^by\s+/i.test(line)) || "";
      const byLine = after.find((line) => /^by\s+/i.test(line));
      const artist = byLine ? clean(byLine.replace(/^by\s+/i, "")) : "";

      if (!anime || !song) continue;

      const links = [...(nodeOrParents(card.depth, anchor)?.querySelectorAll?.("a[href]") || [])]
        .map((a) => ({ href: a.href, text: clean(a.innerText) }));
      const play = links.find((x) => /aniplaylist\.com\/play\//i.test(x.href));

      const item = {
        anime,
        typeRaw: card.typeRaw,
        song,
        artist,
        spotify: anchor.href,
        aniplaylist: play?.href || "",
      };

      const sig = [item.anime, item.typeRaw, item.song, item.artist, item.spotify].join("|");
      if (seen.has(sig)) continue;
      seen.add(sig);
      out.push(item);
    }

    return out;

    function nodeOrParents(depth, start) {
      let node = start;
      for (let i = 0; i < depth && node; i++) node = node.parentElement;
      return node;
    }
  });

  const baseFile = path.join(debugDir, `${slug(season)}.txt`);
  const bodyText = await page.locator("body").innerText().catch(() => "");
  await fs.writeFile(
    baseFile,
    [
      `URL=${diagnostics.url}`,
      `TITLE=${diagnostics.title}`,
      `RESULT_COUNT=${diagnostics.resultCount ?? "unknown"}`,
      `SPOTIFY_LINKS=${diagnostics.spotifyLinkCount}`,
      `EXTRACTED_CARDS=${result.length}`,
      "",
      bodyText,
    ].join("\n"),
    "utf8",
  );

  return { diagnostics, result };
}

function parseItem(item) {
  const lines = [item.anime, item.typeRaw, item.song, item.artist].map(cleanText).filter(Boolean);
  const type = normalizeType(item.typeRaw);
  if (!item.anime || !item.song || !item.spotify) return null;
  return {
    anime: item.anime,
    type: type.code,
    typeLabel: type.display,
    song: item.song,
    artist: item.artist,
    spotify: item.spotify,
    aniplaylist: item.aniplaylist,
  };
}

function itemKey(item) {
  const basis = [item.spotify, item.anime, item.type, item.song, item.artist]
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
        (item.aniplaylist ? `<br><a href="${xmlEscape(item.aniplaylist)}">AniPlaylist</a>` : "") +
        `<br><a href="${xmlEscape(item.spotify)}">Open on Spotify</a>`;
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

  // Deterministic: do not use the current time here, otherwise every 30-minute
  // poll would create a pointless git commit and redeploy.
  const latest = [...unique.values()]
    .map((item) => pubDateFor(item.key))
    .sort((a, b) => b - a)[0] || new Date(0);

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0">',
    "  <channel>",
    `    <title>AniPlaylist — ${xmlEscape(season)}</title>`,
    `    <link>https://aniplaylist.com/?seasons=${encodeURIComponent(season)}</link>`,
    `    <description>All Spotify-available AniPlaylist entries for ${xmlEscape(season)}.</description>`,
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
      userAgent: "Mozilla/5.0 (compatible; AniPlaylistRSS/2.0)",
    });

    try {
      const { diagnostics, result } = await extractSeason(page, season);
      const parsed = result.map(parseItem).filter(Boolean);
      const spotifyOnly = parsed.filter((x) => /open\.spotify\.com\/(track|album)\//i.test(x.spotify));

      console.log(
        `${season}: rendered=${diagnostics.resultCount ?? "?"} spotifyLinks=${diagnostics.spotifyLinkCount} extracted=${spotifyOnly.length}`,
      );

      const file = path.join(outDir, `${slug(season)}.xml`);
      await fs.writeFile(file, buildRss(season, spotifyOnly), "utf8");
    } catch (error) {
      console.error(`${season}: scrape failed:`, error);
      throw error;
    } finally {
      await page.close();
    }
  }

  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
} finally {
  await browser.close();
}
