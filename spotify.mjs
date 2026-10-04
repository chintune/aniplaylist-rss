import fs from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const CONFIG_PATH = path.join(ROOT, "spotify-playlists.json");
const RSS_DIR = path.join(ROOT, "rss");
const SITE_DIR = path.join(ROOT, "site");

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const REFRESH_TOKEN = process.env.SPOTIFY_REFRESH_TOKEN;

if (!CLIENT_ID || !REFRESH_TOKEN) {
  console.log(
    "Spotify secrets are not configured; skipping Spotify playlist sync."
  );
  process.exit(0);
}

const API = "https://api.spotify.com/v1";
const TOKEN_URL = "https://accounts.spotify.com/api/token";

const SITE_BASE = String(
  process.env.SITE_BASE ||
    "https://chintune.github.io/aniplaylist-rss"
).replace(/\/$/, "");

async function readJson(file, fallback = undefined) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (fallback !== undefined) return fallback;
    throw new Error(
      `Could not read ${file}: ${error.message}`
    );
  }
}

async function refreshAccessToken() {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: REFRESH_TOKEN,
      client_id: CLIENT_ID
    })
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      `Spotify token refresh failed: ${
        data.error || response.status
      } ${data.error_description || ""}`.trim()
    );
  }

  return data.access_token;
}

async function spotifyRequest(token, endpoint, options = {}) {
  const response = await fetch(`${API}${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  const text = await response.text();

  let data = {};

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }

  if (!response.ok) {
    const retryAfter = response.headers.get("retry-after");

    throw new Error(
      `Spotify API ${response.status}: ${
        data.error?.message || text || "request failed"
      }${retryAfter ? ` (Retry-After: ${retryAfter}s)` : ""}`
    );
  }

  return data;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function slug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function decodeXml(value) {
  return String(value ?? "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, n) => {
      try {
        return String.fromCodePoint(Number(n));
      } catch {
        return _;
      }
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => {
      try {
        return String.fromCodePoint(parseInt(n, 16));
      } catch {
        return _;
      }
    });
}

function stripHtml(value) {
  return decodeXml(
    String(value ?? "")
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<[^>]*>/g, " ")
  )
    .replace(/\s+/g, " ")
    .trim();
}

function extractXmlTag(block, tagName) {
  const re = new RegExp(
    `<${tagName}\\b[^>]*>([\\s\\S]*?)</${tagName}>`,
    "i"
  );

  const match = block.match(re);

  return match ? decodeXml(match[1].trim()) : "";
}

function extractSpotifyUrl(html) {
  const match = String(html ?? "").match(
    /https?:\/\/open\.spotify\.com\/(track|album)\/([A-Za-z0-9]+)/i
  );

  if (!match) {
    return "";
  }

  return `https://open.spotify.com/${match[1].toLowerCase()}/${match[2]}`;
}

function extractPageField(html, className) {
  const re = new RegExp(
    `<div\\s+class=["']${className}["'][^>]*>([\\s\\S]*?)<\\/div>`,
    "i"
  );

  const match = String(html ?? "").match(re);

  return match ? stripHtml(match[1]) : "";
}

function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function artistsMatch(trackArtists, wantedArtist) {
  if (!wantedArtist) {
    return true;
  }

  const wanted = normalizeText(wantedArtist);

  if (!wanted) {
    return true;
  }

  return trackArtists.some(artist => {
    const actual = normalizeText(artist);

    return (
      actual === wanted ||
      actual.includes(wanted) ||
      wanted.includes(actual)
    );
  });
}

async function getAlbumTracks(token, albumId) {
  const tracks = [];
  let offset = 0;

  while (true) {
    const data = await spotifyRequest(
      token,
      `/albums/${albumId}/tracks?limit=50&offset=${offset}`,
      { method: "GET" }
    );

    const items = Array.isArray(data.items)
      ? data.items
      : [];

    tracks.push(...items);

    if (
      items.length === 0 ||
      !data.next
    ) {
      break;
    }

    offset += items.length;
  }

  return tracks;
}

/*
 * IMPORTANT:
 *
 * An AniPlaylist album/OST URL represents ONE AniPlaylist song.
 *
 * We inspect the album only to find the exact song inside it.
 * We NEVER add the entire album to the Spotify playlist.
 *
 * Example:
 * Album = OST with 100+ songs
 * AniPlaylist song = "Jinsuke no Theme"
 *
 * Result:
 * Only "Jinsuke no Theme" is added.
 */
async function resolveAlbumTrack(
  token,
  albumId,
  songTitle,
  artist
) {
  const tracks =
    await getAlbumTracks(
      token,
      albumId
    );

  if (!tracks.length) {
    throw new Error(
      `Spotify album ${albumId} returned no tracks.`
    );
  }

  const wantedTitle =
    normalizeText(songTitle);

  /*
   * First preference:
   * exact song title.
   */
  const exactTitle = tracks.filter(
    track =>
      normalizeText(track.name) ===
      wantedTitle
  );

  /*
   * Best match:
   * exact song title + matching artist.
   */
  const exactTitleAndArtist =
    exactTitle.find(track =>
      artistsMatch(
        Array.isArray(track.artists)
          ? track.artists.map(a => a?.name || "")
          : [],
        artist
      )
    );

  if (exactTitleAndArtist?.id) {
    return exactTitleAndArtist;
  }

  /*
   * Sometimes AniPlaylist and Spotify format the
   * artist differently.
   *
   * If there is only one exact-title match,
   * use that ONE track.
   */
  if (
    exactTitle.length === 1 &&
    exactTitle[0]?.id
  ) {
    return exactTitle[0];
  }

  /*
   * Last-resort title containment.
   */
  const titleCandidate =
    tracks.find(track => {
      const actual =
        normalizeText(track.name);

      return (
        actual === wantedTitle ||
        actual.includes(wantedTitle) ||
        wantedTitle.includes(actual)
      );
    });

  if (titleCandidate?.id) {
    return titleCandidate;
  }

  throw new Error(
    `Could not find "${songTitle}" by "${artist}" in Spotify album ${albumId}.`
  );
}

function localSongPageFromUrl(pageUrl) {
  const page = new URL(pageUrl);
  const base = new URL(SITE_BASE);

  let relative = page.pathname;

  if (
    base.pathname &&
    base.pathname !== "/" &&
    relative.startsWith(
      base.pathname.replace(/\/$/, "") + "/"
    )
  ) {
    relative = relative.slice(
      base.pathname.replace(/\/$/, "").length + 1
    );
  } else {
    relative = relative.replace(
      /^\/+/,
      ""
    );
  }

  relative = relative.replace(
    /\/+$/,
    ""
  );

  if (!relative) {
    throw new Error(
      `RSS item link does not point to a song page: ${pageUrl}`
    );
  }

  return path.join(
    SITE_DIR,
    relative,
    "index.html"
  );
}

async function extractCurrentRssItems(season) {
  const rssPath = path.join(
    RSS_DIR,
    `${slug(season)}.xml`
  );

  let xml;

  try {
    xml = await fs.readFile(
      rssPath,
      "utf8"
    );
  } catch (error) {
    throw new Error(
      `RSS file missing for ${season}: ${rssPath}: ${error.message}`
    );
  }

  const blocks = [
    ...xml.matchAll(
      /<item\b[^>]*>([\s\S]*?)<\/item>/gi
    )
  ].map(match => match[1]);

  const items = [];

  for (const block of blocks) {
    const pageUrl =
      extractXmlTag(
        block,
        "link"
      );

    if (!pageUrl) {
      continue;
    }

    items.push({
      pageUrl,
      title: extractXmlTag(
        block,
        "title"
      )
    });
  }

  return items;
}

async function resolveSeasonTracks(
  token,
  season
) {
  const rssItems =
    await extractCurrentRssItems(
      season
    );

  const trackIds = [];
  const seen = new Set();

  /*
   * RSS order is the desired Spotify order.
   *
   * scrape.mjs sorts RSS items newest-first before writing
   * the XML, so the first track here becomes Spotify #1.
   */
  for (
    let index = 0;
    index < rssItems.length;
    index++
  ) {
    const rssItem =
      rssItems[index];

    const pagePath =
      localSongPageFromUrl(
        rssItem.pageUrl
      );

    let html;

    try {
      html = await fs.readFile(
        pagePath,
        "utf8"
      );
    } catch (error) {
      throw new Error(
        `Song page for ${season} item #${index + 1} could not be read: ${pagePath}: ${error.message}`
      );
    }

    const spotifyUrl =
      extractSpotifyUrl(html);

    /*
     * No Spotify link on this RSS item.
     *
     * It remains in RSS, but it is not added
     * to the Spotify playlist.
     */
    if (!spotifyUrl) {
      continue;
    }

    const songTitle =
      extractPageField(
        html,
        "song"
      );

    const artist =
      extractPageField(
        html,
        "artist"
      );

    const match =
      spotifyUrl.match(
        /https?:\/\/open\.spotify\.com\/(track|album)\/([A-Za-z0-9]+)/i
      );

    if (!match) {
      continue;
    }

    const type =
      match[1].toLowerCase();

    const spotifyId =
      match[2];

    let trackId = "";

    /*
     * Normal Spotify track link.
     *
     * Directly use the track ID.
     */
    if (type === "track") {
      trackId = spotifyId;
    }

    /*
     * Spotify album / OST link.
     *
     * Find the ONE matching song inside it.
     *
     * NEVER add the whole album.
     */
    else if (type === "album") {
      const track =
        await resolveAlbumTrack(
          token,
          spotifyId,
          songTitle,
          artist
        );

      trackId =
        track.id || "";

      console.log(
        `${season}: resolved Spotify album ${spotifyId} -> track ${trackId} for "${songTitle}"`
      );
    }

    if (!trackId) {
      throw new Error(
        `Spotify track could not be resolved for ${season}: "${songTitle}" (${spotifyUrl})`
      );
    }

    /*
     * Prevent duplicate Spotify tracks inside
     * the same seasonal playlist.
     *
     * First occurrence wins.
     */
    if (!seen.has(trackId)) {
      seen.add(trackId);
      trackIds.push(trackId);
    }
  }

  return trackIds;
}

async function replacePlaylistItems(
  token,
  playlistId,
  trackIds
) {
  const uris =
    trackIds.map(
      id => `spotify:track:${id}`
    );

  /*
   * PUT completely replaces the playlist.
   *
   * [] means clear the playlist.
   */
  await spotifyRequest(
    token,
    `/playlists/${playlistId}/items`,
    {
      method: "PUT",
      body: JSON.stringify({
        uris: uris.slice(0, 100)
      })
    }
  );

  /*
   * If there are >100 current tracks,
   * append the remainder in the same order.
   */
  for (
    let i = 100;
    i < uris.length;
    i += 100
  ) {
    const batch =
      uris.slice(
        i,
        i + 100
      );

    await spotifyRequest(
      token,
      `/playlists/${playlistId}/items`,
      {
        method: "POST",
        body: JSON.stringify({
          uris: batch
        })
      }
    );

    if (
      i + 100 <
      uris.length
    ) {
      await sleep(500);
    }
  }
}

const config =
  await readJson(
    CONFIG_PATH,
    null
  );

if (
  !config ||
  typeof config !== "object" ||
  Array.isArray(config)
) {
  throw new Error(
    "spotify-playlists.json is invalid."
  );
}

const seasons =
  Object.keys(config);

if (!seasons.length) {
  throw new Error(
    "spotify-playlists.json contains no seasons."
  );
}

const accessToken =
  await refreshAccessToken();

/*
 * Resolve EVERYTHING first.
 *
 * If an album-linked song cannot be resolved,
 * the workflow stops BEFORE modifying any playlist.
 *
 * This prevents partially updated playlists.
 */
const desiredBySeason = {};

for (const season of seasons) {
  console.log("");
  console.log(
    `=== Resolving RSS tracks: ${season} ===`
  );

  desiredBySeason[season] =
    await resolveSeasonTracks(
      accessToken,
      season
    );

  console.log(
    `${season}: ${desiredBySeason[season].length} Spotify track(s) resolved from current RSS`
  );
}

let totalCreated = 0;
let totalSynced = 0;
let totalTracks = 0;
let configChanged = false;

for (const season of seasons) {
  const originalEntry =
    config[season];

  const entry =
    originalEntry &&
    typeof originalEntry === "object"
      ? originalEntry
      : {};

  const desiredTracks =
    desiredBySeason[season];

  /*
   * EMPTY SEASON
   *
   * If there are no Spotify tracks:
   *
   * - do NOT create a playlist
   * - clear an old playlist if it exists
   * - remove the URL
   *
   * site/index.html already checks playlist.url,
   * so the Spotify button disappears automatically.
   */
  if (desiredTracks.length === 0) {
    console.log("");
    console.log(
      `=== ${season} ===`
    );

    if (entry.id) {
      console.log(
        "Current RSS has 0 Spotify tracks. Clearing existing Spotify playlist..."
      );

      await replacePlaylistItems(
        accessToken,
        entry.id,
        []
      );

      console.log(
        "Existing Spotify playlist cleared."
      );
    } else {
      console.log(
        "No Spotify tracks in current RSS. No playlist created."
      );
    }

    if (
      entry.url ||
      (Array.isArray(entry.trackIds) &&
        entry.trackIds.length)
    ) {
      configChanged = true;
    }

    entry.url = "";
    entry.trackIds = [];

    config[season] =
      entry;

    continue;
  }

  /*
   * NON-EMPTY SEASON
   *
   * Only create a Spotify playlist when
   * there is at least one current Spotify track.
   */
  if (!entry.id) {
    console.log("");
    console.log(
      `Creating Spotify playlist: ${season}`
    );

    const playlist =
      await spotifyRequest(
        accessToken,
        "/me/playlists",
        {
          method: "POST",
          body: JSON.stringify({
            name:
              `AniPlaylist — ${season}`,
            description:
              "Automatically updated from AniPlaylist RSS. " +
              "Source: https://aniplaylist.com/?seasons=" +
              encodeURIComponent(
                season
              ),
            public: true,
            collaborative: false
          })
        }
      );

    entry.id =
      playlist.id;

    totalCreated++;

    configChanged = true;
  }

  /*
   * Restore URL if the playlist exists
   * and the season now has tracks again.
   */
  const expectedUrl =
    `https://open.spotify.com/playlist/${entry.id}`;

  if (
    entry.url !== expectedUrl
  ) {
    entry.url =
      expectedUrl;

    configChanged = true;
  }

  console.log("");
  console.log(
    `=== ${season} ===`
  );

  console.log(
    `Current RSS Spotify tracks: ${desiredTracks.length}`
  );

  console.log(
    "Replacing Spotify playlist contents with current RSS order..."
  );

  /*
   * This makes Spotify exactly match
   * the current RSS track list.
   */
  await replacePlaylistItems(
    accessToken,
    entry.id,
    desiredTracks
  );

  /*
   * Bookkeeping only.
   *
   * RSS/song pages remain the source of truth.
   */
  const oldTrackIds =
    Array.isArray(entry.trackIds)
      ? entry.trackIds
      : [];

  if (
    JSON.stringify(oldTrackIds) !==
    JSON.stringify(desiredTracks)
  ) {
    configChanged = true;
  }

  entry.trackIds =
    desiredTracks;

  config[season] =
    entry;

  totalSynced++;
  totalTracks +=
    desiredTracks.length;

  console.log(
    `Playlist synchronized exactly: ${desiredTracks.length} track(s).`
  );

  console.log(
    "Newest RSS track is now playlist position #1."
  );
}

if (configChanged) {
  await fs.writeFile(
    CONFIG_PATH,
    JSON.stringify(
      config,
      null,
      2
    ) + "\n"
  );
}

console.log("");
console.log(
  "===== SPOTIFY SYNC ====="
);

console.log(
  `Playlists created: ${totalCreated}`
);

console.log(
  `Playlists synchronized: ${totalSynced}`
);

console.log(
  `Current RSS Spotify tracks: ${totalTracks}`
);

console.log(
  "Old/stale tracks are removed by replacing playlist contents."
);

console.log(
  "New tracks follow RSS order, with newest at the top."
);

console.log(
  "Album/OST links contribute ONE matching track only."
);

console.log(
  "Empty seasons have no Spotify playlist button."
);

console.log(
  "========================"
);
