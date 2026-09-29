import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { chromium } from "playwright";

const CONFIG = JSON.parse(await fs.readFile("./seasons.json", "utf8"));
const outDir = path.resolve("./rss");
const statePath = path.resolve("./rss-state.json");
await fs.mkdir(outDir, { recursive: true });

let state = {};
try {
  state = JSON.parse(await fs.readFile(statePath, "utf8"));
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

function cleanText(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

// AniPlaylist currently displays these compact type codes on result cards.
// The parser also accepts any short ALL-CAPS token, so a newly introduced
// type can still be captured without changing this list first.
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
  const code = cleanText(raw)
    .replace(/\s*\([^)]*\)\s*/g, "")
    .trim()
    .toUpperCase();

  const base = code.replace(/\d+$/, "");
  const display = TYPE_NAMES[base] || TYPE_NAMES[code] || raw.trim();

  return {
    code,
    display,
  };
}

function findTypeLine(lines) {
  for (let i = 0; i < lines.length; i++) {
    const line = cleanText(lines[i]);
    if (!line) continue;

    // Examples: OP, OP1, ED2, IN (ep 8), OST, CS, TS, IMGS, PV, MV.
    if (/^[A-Z]{2,6}\d*(?:\s*\([^)]*\))?$/.test(line)) {
      return { index: i, raw: line };
    }

    if (/^Other$/i.test(line)) {
      return { index: i, raw: "Other" };
    }
  }
  return null;
}

async function extractSeason(page, season) {
  const url = `https://aniplaylist.com/?seasons=${encodeURIComponent(season)}`;
  console.log(`Loading ${url}`);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });

  await page.waitForTimeout(5000);

  for (let i = 0; i < 8; i++) {
    await page.mouse.wheel(0, 2500);
    await page.waitForTimeout(500);
  }

  // Try pagination / lazy-loading controls without assuming one exact UI.
  for (let round = 0; round < 20; round++) {
    const clicked = await page.evaluate(() => {
      const els = [...document.querySelectorAll("button, a")];
      const target = els.find((el) => {
        const t = (el.textContent || "").trim().toLowerCase();
        const disabled = el.disabled || el.getAttribute("aria-disabled") === "true";
        return !disabled && (
          t === "next" ||
          t === "show more" ||
          t === "load more" ||
          t === "more"
        );
      });
      if (target) {
        target.click();
        return true;
      }
      return false;
    });
    if (!clicked) break;
    await page.waitForTimeout(1200);
  }

  return await page.evaluate(() => {
    const spotifyLinks = [...document.querySelectorAll('a[href*="open.spotify.com/"]')];
    const result = [];
    const seen = new Set();

    for (const a of spotifyLinks) {
      const spotify = a.href;
      if (!/^https?:\/\/open\.spotify\.com\/(track|album)\//.test(spotify)) continue;

      let node = a;
      let candidate = null;

      // Find the smallest ancestor that looks like one result card and has
      // a recognizable AniPlaylist type marker.
      for (let depth = 0; depth < 10 && node; depth++, node = node.parentElement) {
        const rawText = node.innerText || "";
        const lines = rawText
          .split(/\r?\n/)
          .map((x) => x.replace(/\s+/g, " ").trim())
          .filter(Boolean);

        if (lines.length < 3 || lines.length > 25) continue;

        const type = lines
          .map((line, index) => ({ line, index }))
          .find(({ line }) =>
            /^[A-Z]{2,6}\d*(?:\s*\([^)]*\))?$/.test(line) || /^Other$/i.test(line)
          );

        if (!type) continue;

        const links = [...node.querySelectorAll("a[href]")].map((x) => ({
          href: x.href,
          text: (x.innerText || "").replace(/\s+/g, " ").trim(),
        }));

        const play = links.find((x) => /aniplaylist\.com\/play\//.test(x.href));

        candidate = {
          lines,
          typeRaw: type.line,
          typeIndex: type.index,
          spotify,
          aniplaylist: play?.href || "",
        };
        break;
      }

      if (!candidate) continue;

      // Build a stable-ish raw card signature to avoid duplicate extraction.
      const signature = [candidate.aniplaylist, candidate.spotify, ...candidate.lines].join("|");
      if (seen.has(signature)) continue;
      seen.add(signature);

      result.push(candidate);
    }

    return result;
  });
}

function parseCard(item) {
  const lines = item.lines.map(cleanText).filter(Boolean);
  const typeInfo = findTypeLine(lines);
  if (!typeInfo) return null;

  const typeIndex = typeInfo.index;
  const { code, display } = normalizeType(typeInfo.raw);

  // Expected card shape is approximately:
  // Anime title
  // TYPE
  // Song / Album title
  // by Artist
  // optional artwork/platform metadata
  const before = lines.slice(0, typeIndex);
  if (!before.length) return null;

  // AniPlaylist sometimes repeats the anime title as a heading and card text.
  const anime = cleanText(before[before.length - 1]);
  if (!anime) return null;

  const after = lines.slice(typeIndex + 1);
  if (!after.length) return null;

  // Stop before platform/no-streaming text. In normal cards, the first line
  // after the type is the song/album title and the following line begins "by".
  const song = cleanText(after[0]);
  if (!song) return null;

  let artist = "";
  const byLine = after.find((line) => /^by\s+/i.test(line));
  if (byLine) artist = cleanText(byLine.replace(/^by\s+/i, ""));

  return {
    anime,
    type: code,
    typeLabel: display,
    song,
    artist,
    spotify: item.spotify,
    aniplaylist: item.aniplaylist,
  };
}

function itemKey(x) {
  const basis = [x.aniplaylist, x.spotify, x.anime, x.type, x.song]
    .filter(Boolean)
    .join("|");
  return createHash("sha256").update(basis).digest("hex");
}

function pubDateFor(key) {
  if (!state[key]) {
    state[key] = new Date().toISOString();
  }
  return new Date(state[key]).toUTCString();
}

function buildRss(season, parsed) {
  const now = new Date().toUTCString();
  const unique = new Map();

  for (const x of parsed) {
    const key = itemKey(x);
    if (!unique.has(key)) unique.set(key, { ...x, key });
  }

  const items = [...unique.values()].map((x) => {
    const title = `[${x.type}] ${x.anime} — ${x.song}`;
    const description =
      `<strong>${xmlEscape(x.anime)}</strong><br>` +
      `${xmlEscape(x.typeLabel)} (${xmlEscape(x.type)}) — ${xmlEscape(x.song)}` +
      (x.artist ? `<br>by ${xmlEscape(x.artist)}` : "") +
      (x.aniplaylist ? `<br><a href="${xmlEscape(x.aniplaylist)}">AniPlaylist</a>` : "") +
      `<br><a href="${xmlEscape(x.spotify)}">Open on Spotify</a>`;

    return `    <item>\n` +
      `      <title>${xmlEscape(title)}</title>\n` +
      `      <link>${xmlEscape(x.spotify)}</link>\n` +
      `      <guid isPermaLink="false">${xmlEscape(x.key)}</guid>\n` +
      `      <description><![CDATA[${description}]]></description>\n` +
      `      <pubDate>${pubDateFor(x.key)}</pubDate>\n` +
      `    </item>`;
  }).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<rss version="2.0">\n` +
    `  <channel>\n` +
    `    <title>AniPlaylist — ${xmlEscape(season)}</title>\n` +
    `    <link>https://aniplaylist.com/?seasons=${encodeURIComponent(season)}</link>\n` +
    `    <description>All Spotify-available AniPlaylist entries for ${xmlEscape(season)}.</description>\n` +
    `    <lastBuildDate>${now}</lastBuildDate>\n` +
    (items ? `${items}\n` : "") +
    `  </channel>\n` +
    `</rss>\n`;
}

try {
  for (const season of CONFIG.seasons) {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
      userAgent: "Mozilla/5.0 (compatible; AniPlaylistRSS/1.0)",
    });

    try {
      const rawItems = await extractSeason(page, season);
      const parsed = rawItems.map(parseCard).filter(Boolean);
      const spotifyOnly = parsed.filter((x) =>
        /^https?:\/\/open\.spotify\.com\/(track|album)\//.test(x.spotify)
      );

      console.log(`${season}: ${spotifyOnly.length} Spotify entries across all AniPlaylist types`);

      const file = path.join(outDir, `${slug(season)}.xml`);
      await fs.writeFile(file, buildRss(season, spotifyOnly), "utf8");
    } finally {
      await page.close();
    }
  }

  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
} finally {
  await browser.close();
}
