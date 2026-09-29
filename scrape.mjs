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
  return fs.readFile(file, "utf8").then((t) => JSON.parse(t)).catch(() => fallback);
}
let state = await loadJson(statePath, {});
let resolveCache = await loadJson(resolveCachePath, {});
if (!state || typeof state !== "object" || Array.isArray(state)) state = {};
if (!resolveCache || typeof resolveCache !== "object" || Array.isArray(resolveCache)) resolveCache = {};

const browser = await chromium.launch({ headless: true });
const api = await playwrightRequest.newContext({ extraHTTPHeaders: {
  "User-Agent": "Mozilla/5.0 (compatible; AniPlaylistRSS/5.0)",
  "Accept-Language": "en-US,en;q=0.9"
} });

const RECHECK_UNAVAILABLE_MS = 2 * 60 * 60 * 1000;
const RESOLVE_CONCURRENCY = 4;

function slug(season) { return season.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }
function cleanText(v) { return String(v ?? "").replace(/\s+/g, " ").trim(); }
function xmlEscape(v = "") { return String(v).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&apos;"); }
function decodeHtml(s) { return String(s).replaceAll("&amp;","&").replaceAll("&#x2F;","/").replaceAll("&#47;","/").replaceAll("\\/","/").replaceAll("\\u002F","/").replaceAll("\\u003A",":"); }

const TYPE_NAMES = {
  OP: "Opening", ED: "Ending", IN: "Insert Song", CS: "Character Song", OST: "Original Soundtrack",
  VA: "Vocal Album", IMGA: "Image Album", IMGS: "Image Song", TS: "Theme Song", MV: "Music Video", PV: "PV Song", OTHER: "Other"
};
const TYPE_ALIASES = {
  OPENING: "OP", ENDING: "ED", INSERT: "IN", "INSERT SONG": "IN", "CHARACTER SONG": "CS", OST: "OST",
  "ORIGINAL SOUNDTRACK": "OST", "VOCAL ALBUM": "VA", "IMAGE ALBUM": "IMGA", "IMAGE SONG": "IMGS",
  "THEME SONG": "TS", "MUSIC VIDEO": "MV", "PV SONG": "PV", OTHER: "OTHER"
};
function normalizeType(raw) {
  const text = cleanText(raw);
  const upper = text.toUpperCase().replace(/\s+/g, " ");
  const base = upper.replace(/\s*\([^)]*\)\s*/g, "").trim();
  const code = TYPE_ALIASES[base] || (TYPE_NAMES[base] ? base : base.match(/^(OP|ED|IN|CS|OST|VA|IMGA|IMGS|TS|MV|PV|OTHER)\d*$/)?.[1] || "");
  return { code: code || text.toUpperCase(), display: TYPE_NAMES[code] || text };
}
function typeLine(raw) {
  const t = cleanText(raw);
  return /^(OP|ED|IN|CS|OST|VA|IMGA|IMGS|TS|MV|PV)\d*(?:\s*\([^)]*\))?$/i.test(t) || /^(Other)(?:\s*\([^)]*\))?$/i.test(t);
}
function normalizeSpotifyUrl(raw) {
  const text = decodeHtml(raw);
  const m = text.match(/https?:\/\/open\.spotify\.com\/(?:intl-[^/]+\/)?(track|album)\/([A-Za-z0-9]+)/i);
  if (m) return `https://open.spotify.com/${m[1].toLowerCase()}/${m[2]}`;
  const s = text.match(/spotify:(track|album):([A-Za-z0-9]+)/i);
  return s ? `https://open.spotify.com/${s[1].toLowerCase()}/${s[2]}` : "";
}
function findSpotifyDeep(value, seen = new Set()) {
  if (value == null) return "";
  if (typeof value === "string") return normalizeSpotifyUrl(value);
  if (typeof value !== "object" || seen.has(value)) return "";
  seen.add(value);
  if (Array.isArray(value)) for (const v of value) { const s = findSpotifyDeep(v, seen); if (s) return s; }
  else for (const v of Object.values(value)) { const s = findSpotifyDeep(v, seen); if (s) return s; }
  return "";
}
function collectLeaves(value, path = [], out = [], seen = new Set()) {
  if (value == null || typeof value === "function") return out;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") { out.push({ path: path.join("."), value: String(value) }); return out; }
  if (typeof value !== "object" || seen.has(value)) return out;
  seen.add(value);
  if (Array.isArray(value)) value.forEach((v, i) => collectLeaves(v, [...path, String(i)], out, seen));
  else for (const [k, v] of Object.entries(value)) collectLeaves(v, [...path, k], out, seen);
  return out;
}
function pickByKey(leaves, re) {
  return leaves.find((x) => re.test(x.path) && x.value.trim())?.value.trim() || "";
}
function looksLikeHit(x) { return x && typeof x === "object" && !Array.isArray(x); }
function extractHitArrays(obj, out = [], path = "$", depth = 0, seen = new Set()) {
  if (depth > 6 || obj == null || typeof obj !== "object" || seen.has(obj)) return out;
  seen.add(obj);
  if (Array.isArray(obj.hits) && obj.hits.every(looksLikeHit)) out.push({ path: `${path}.hits`, hits: obj.hits, meta: obj });
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === "object") extractHitArrays(v, out, `${path}.${k}`, depth + 1, seen);
  }
  return out;
}
function parseNetworkHit(hit) {
  const leaves = collectLeaves(hit);
  const spotify = findSpotifyDeep(hit);
  if (!spotify) return null;
  const typeRaw = pickByKey(leaves, /(^|\.)type(ship|s)?$|(^|\.)(song_)?type$/i) || leaves.find((x) => typeLine(x.value))?.value || "";
  const type = normalizeType(typeRaw);
  const anime = pickByKey(leaves, /(^|\.)(anime|animeTitle|animeName|series|seriesTitle|show|showTitle|media|mediaTitle)(\.|$)/i);
  const artist = pickByKey(leaves, /(^|\.)(artist|artists|performer|performers|singer|vocalist|composer|creator|by)(\.|$)/i);
  let song = pickByKey(leaves, /(^|\.)(song|songTitle|songName|track|trackTitle|trackName)(\.|$)/i);
  if (!song) song = pickByKey(leaves, /(^|\.)(title|name)(\.|$)/i);
  if (!song) song = leaves.find((x) => /title|song|track|name/i.test(x.path) && !/(anime|series|show)/i.test(x.path))?.value || "";
  if (!song || !anime || !type.code) return null;
  return { anime: cleanText(anime), type: type.code, typeLabel: type.display, song: cleanText(song), artist: cleanText(artist), spotify };
}

function parseCardText(text, playUrl = "") {
  const lines = String(text).split(/\r?\n/).map(cleanText).filter(Boolean);
  let typeIndex = lines.findIndex(typeLine);
  if (typeIndex < 1) return null;
  const after = lines.slice(typeIndex + 1);
  const byIndex = after.findIndex((x) => /^by\s+/i.test(x));
  if (byIndex < 1) return null;
  const before = lines.slice(0, typeIndex).filter((x) => !/^(Open|Read more|Spotify|Apple Music|Deezer|YouTube Music)$/i.test(x));
  const songLines = after.slice(0, byIndex).filter((x) => !/^\d+$/.test(x) && !/^(Open|Read more|Spotify|Apple Music|Deezer|YouTube Music)$/i.test(x));
  const anime = before.at(-1) || "";
  const song = songLines[0] || "";
  const artist = after[byIndex].replace(/^by\s+/i, "");
  if (!anime || !song) return null;
  return { anime, ...normalizeType(lines[typeIndex]), song, artist, playUrl, unavailable: lines.some((x) => /not available for streaming yet/i.test(x)) };
}

async function waitForCards(page) {
  await page.waitForTimeout(2500);
  try {
    await page.waitForFunction(() => {
      const txt = document.body?.innerText || "";
      const lines = txt.split(/\n/).map(x => x.trim()).filter(Boolean);
      const types = lines.filter(x => /^(OP|ED|IN|CS|OST|VA|IMGA|IMGS|TS|MV|PV)\d*(?:\s*\([^)]*\))?$/i.test(x)).length;
      const bys = (txt.match(/\nby\s+/gi) || []).length;
      return types > 0 && bys > 0;
    }, { timeout: 30000 });
  } catch {}
  await page.waitForTimeout(2000);
}

async function exhaustResults(page) {
  for (let i = 0; i < 30; i++) {
    await page.mouse.wheel(0, 5000);
    await page.waitForTimeout(500);
  }
}

async function extractSeason(page, season) {
  const url = `https://aniplaylist.com/?seasons=${encodeURIComponent(season)}`;
  console.log(`\n=== ${season} ===\nLoading ${url}`);
  const algoliaResponses = [];
  const algoliaTasks = [];
  const responseHandler = (response) => {
    const u = response.url();
    if (!/algolia/i.test(u)) return;
    algoliaTasks.push((async () => {
      let data = null;
      try { data = await response.json(); } catch { return; }
      const hitArrays = extractHitArrays(data);
      algoliaResponses.push({ url: u, status: response.status(), keys: Object.keys(data || {}), hitArrays: hitArrays.map((x) => ({ path: x.path, count: x.hits.length, nbHits: x.meta?.nbHits ?? null, nbPages: x.meta?.nbPages ?? null })), sample: hitArrays[0]?.hits?.[0] ?? null, data });
    })().catch(() => {}));
  };
  page.on("response", responseHandler);

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
  await waitForCards(page);
  await exhaustResults(page);
  await page.waitForTimeout(2500);
  await Promise.allSettled(algoliaTasks);

  const diagnostics = await page.evaluate(() => {
    const body = document.body?.innerText || "";
    const countMatch = body.match(/([\d,]+)\s+results found/i);
    const lines = body.split(/\n/).map((x) => x.trim()).filter(Boolean);
    return {
      url: location.href,
      title: document.title,
      bodyLength: body.length,
      resultCount: countMatch ? Number(countMatch[1].replaceAll(",", "")) : null,
      typeLines: lines.filter(typeLine).length,
      byLines: lines.filter((x) => /^by\s+/i.test(x)).length,
      anchors: document.querySelectorAll("a[href]").length,
      bodyStart: lines.slice(0, 160),
    };
  });

  console.log(`Rendered result count: ${diagnostics.resultCount ?? "unknown"}`);
  console.log(`Card type lines in DOM: ${diagnostics.typeLines}`);
  console.log(`Artist lines in DOM: ${diagnostics.byLines}`);
  console.log(`Anchors in DOM: ${diagnostics.anchors}`);
  console.log(`Algolia JSON responses: ${algoliaResponses.length}`);
  console.log(`Algolia hit records: ${algoliaResponses.reduce((n, r) => n + r.hitArrays.reduce((m, a) => m + a.count, 0), 0)}`);

  // DOM text-card extraction: use leaf elements containing an AniPlaylist type,
  // then walk upward until the ancestor contains the full card text.
  const domRaw = await page.evaluate(() => {
    const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
    const isType = (line) => /^(OP|ED|IN|CS|OST|VA|IMGA|IMGS|TS|MV|PV)\d*(?:\s*\([^)]*\))?$/i.test(line) || /^Other(?:\s*\([^)]*\))?$/i.test(line);
    const found = [];
    const seen = new Set();
    for (const el of [...document.querySelectorAll("body *")]) {
      if (el.children.length !== 0) continue;
      const t = clean(el.textContent);
      if (!isType(t)) continue;
      let node = el;
      for (let depth = 0; depth < 10 && node; depth++, node = node.parentElement) {
        const txt = String(node.innerText || "").trim();
        if (txt.length < 10 || txt.length > 1200) continue;
        if (!/\nby\s+/i.test(`\n${txt}`)) continue;
        const hrefs = [...node.querySelectorAll("a[href]")].map(a => a.href).filter(Boolean);
        const attrs = {};
        for (const n of [node, node.parentElement, node.parentElement?.parentElement]) {
          if (!n) continue;
          for (const a of [...n.attributes]) if (/href|url|route|link|path|slug|id/i.test(a.name)) attrs[a.name] = a.value;
        }
        const key = txt;
        if (seen.has(key)) break;
        seen.add(key);
        found.push({ text: txt, hrefs: hrefs.slice(0, 8), attrs });
        break;
      }
    }
    return found;
  });

  const domCards = [];
  for (const x of domRaw) {
    const href = x.hrefs.find((h) => /aniplaylist\.com/i.test(h) && !/[?#]/.test(h)) || "";
    const c = parseCardText(x.text, href);
    if (c) domCards.push(c);
  }

  const networkCards = [];
  const seenSpotify = new Set();
  for (const r of algoliaResponses) {
    for (const ha of r.hitArrays) {
      for (const hit of ha.hits) {
        const c = parseNetworkHit(hit);
        if (!c || seenSpotify.has(c.spotify)) continue;
        seenSpotify.add(c.spotify);
        networkCards.push(c);
      }
    }
  }

  // Network hits are preferred because they contain platform links directly and
  // are independent of the site's visual DOM. DOM cards are retained as fallback.
  const cards = networkCards.length ? networkCards : domCards;

  await fs.writeFile(path.join(debugDir, `${slug(season)}.json`), JSON.stringify({ diagnostics, algoliaResponses: algoliaResponses.map(({data, ...r}) => r), domCardCount: domCards.length, networkCardCount: networkCards.length, domSamples: domRaw.slice(0, 20), networkSamples: networkCards.slice(0, 20) }, null, 2), "utf8");
  await fs.writeFile(path.join(debugDir, `${slug(season)}.txt`), JSON.stringify({ diagnostics, domCardCount: domCards.length, networkCardCount: networkCards.length, algoliaResponses: algoliaResponses.map(({data,...r})=>r), bodyStart: diagnostics.bodyStart }, null, 2), "utf8");

  console.log(`DOM card candidates: ${domCards.length}`);
  console.log(`Network card candidates: ${networkCards.length}`);

  if (diagnostics.resultCount !== null && diagnostics.resultCount > 0 && cards.length === 0) {
    throw new Error(`Could not extract any cards. AniPlaylist reported ${diagnostics.resultCount}. AlgoliaResponses=${algoliaResponses.length}. See debug/${slug(season)}.json.`);
  }
  return { diagnostics, cards };
}

async function resolveSpotifyForCard(card, fallbackPage) {
  if (card.spotify) return card.spotify;
  const cacheKey = card.playUrl || `${card.anime}|${card.type}|${card.song}|${card.artist}`;
  const now = Date.now();
  const cached = resolveCache[cacheKey];
  if (cached?.spotify) return cached.spotify;
  if (cached?.checkedAt && now - new Date(cached.checkedAt).getTime() < RECHECK_UNAVAILABLE_MS) return "";
  let spotify = "";
  if (card.playUrl) {
    try {
      const r = await api.get(card.playUrl, { timeout: 30000 });
      const html = await r.text();
      spotify = normalizeSpotifyUrl(html);
      if (!spotify) {
        await fallbackPage.goto(card.playUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
        await fallbackPage.waitForTimeout(1200);
        spotify = await fallbackPage.evaluate(() => {
          const all = [document.documentElement?.outerHTML || "", ...[...document.querySelectorAll("a,button,[data-spotify],[onclick]")].map(e => e.outerHTML || "")];
          for (const x of all) { const s = String(x).match(/https?:\/\/open\.spotify\.com\/(?:intl-[^/]+\/)?(track|album)\/([A-Za-z0-9]+)/i); if (s) return `https://open.spotify.com/${s[1].toLowerCase()}/${s[2]}`; }
          return "";
        });
      }
    } catch (e) { console.log(`  resolve failed ${cacheKey}: ${e.message}`); }
  }
  resolveCache[cacheKey] = { spotify, checkedAt: new Date().toISOString() };
  return spotify;
}
async function withConcurrency(items, limit, fn) {
  const out = new Array(items.length); let cursor = 0;
  async function worker() { while (true) { const i = cursor++; if (i >= items.length) return; try { out[i] = await fn(items[i], i); } catch (e) { out[i] = null; } } }
  await Promise.all(Array.from({length: Math.min(limit, items.length)}, worker));
  return out;
}
function itemKey(item) { return createHash("sha256").update([item.spotify,item.playUrl,item.anime,item.type,item.song,item.artist].filter(Boolean).join("|")).digest("hex"); }
function pubDateFor(key) { if (!state[key]) state[key] = new Date().toISOString(); return new Date(state[key]); }
function buildRss(season, parsed) {
  const unique = new Map(); for (const x of parsed) { const key=itemKey(x); if(!unique.has(key)) unique.set(key,{...x,key}); }
  const items=[...unique.values()].sort((a,b)=>pubDateFor(a.key)-pubDateFor(b.key)).map(x=>[
    "    <item>",`      <title>${xmlEscape(`[${x.type}] ${x.anime} — ${x.song}`)}</title>`,`      <link>${xmlEscape(x.spotify)}</link>`,`      <guid isPermaLink="false">${xmlEscape(x.key)}</guid>`,
    `      <description><![CDATA[<strong>${xmlEscape(x.anime)}</strong><br>${xmlEscape(x.typeLabel)} (${xmlEscape(x.type)}) — ${xmlEscape(x.song)}${x.artist?`<br>by ${xmlEscape(x.artist)}`:""}<br><a href="${xmlEscape(x.spotify)}">Open on Spotify</a>${x.playUrl?`<br><a href="${xmlEscape(x.playUrl)}">AniPlaylist</a>`:""}]]></description>`,`      <pubDate>${pubDateFor(x.key).toUTCString()}</pubDate>`,"    </item>"].join("\n")).join("\n");
  const latest=[...unique.values()].map(x=>pubDateFor(x.key)).sort((a,b)=>b-a)[0]||new Date(0);
  return ['<?xml version="1.0" encoding="UTF-8"?>','<rss version="2.0">','  <channel>',`    <title>AniPlaylist — ${xmlEscape(season)}</title>`,`    <link>https://aniplaylist.com/?seasons=${encodeURIComponent(season)}</link>`,`    <description>AniPlaylist entries with Spotify links for ${xmlEscape(season)}.</description>`,`    <lastBuildDate>${latest.toUTCString()}</lastBuildDate>`,items,"  </channel>","</rss>",""].join("\n");
}

try {
  if (!Array.isArray(CONFIG.seasons) || !CONFIG.seasons.length) throw new Error("seasons.json must contain a non-empty seasons array");
  for (const season of CONFIG.seasons) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/154 Safari/537.36" });
    try {
      const { diagnostics, cards } = await extractSeason(page, season);
      console.log(`Using cards: ${cards.length}`);
      const need = cards.filter(c => !c.unavailable && !resolveCache[c.playUrl || `${c.anime}|${c.type}|${c.song}|${c.artist}`]?.spotify && !c.spotify);
      const fallbackPages = []; for (let i=0;i<Math.min(RESOLVE_CONCURRENCY,need.length);i++) fallbackPages.push(await browser.newPage({viewport:{width:1200,height:900}}));
      try { await withConcurrency(need, RESOLVE_CONCURRENCY, async (c,i)=>{ const p=fallbackPages[i%Math.max(1,fallbackPages.length)]; const s=await resolveSpotifyForCard(c,p); if(s) console.log(`  Spotify: ${c.anime} / ${c.type} / ${c.song}`); }); }
      finally { await Promise.all(fallbackPages.map(p=>p.close())); }
      const parsed=[];
      for(const c of cards){ if(c.unavailable) continue; const cacheKey=c.playUrl||`${c.anime}|${c.type}|${c.song}|${c.artist}`; const spotify=c.spotify||resolveCache[cacheKey]?.spotify||""; if(!spotify) continue; parsed.push({...c, spotify, playUrl:c.playUrl||""}); }
      console.log(`${season}: rendered=${diagnostics.resultCount??"?"} cards=${cards.length} spotifyResolved=${parsed.length}`);
      await fs.writeFile(path.join(outDir,`${slug(season)}.xml`),buildRss(season,parsed),"utf8");
    } finally { await page.close(); }
  }
  await fs.writeFile(statePath,`${JSON.stringify(state,null,2)}\n`);
  await fs.writeFile(resolveCachePath,`${JSON.stringify(resolveCache,null,2)}\n`);
} finally { await api.dispose(); await browser.close(); }
