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

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

async function readJson(file, fallback = null) {
  try {
    const text = await fs.readFile(file, "utf8");
    return JSON.parse(text);
  } catch (error) {
    if (fallback !== null) {
      return fallback;
    }
    throw error;
  }
}

async function refreshAccessToken() {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: REFRESH_TOKEN,
    client_id: CLIENT_ID
  });

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      `Spotify token endpoint returned invalid JSON: ${text.slice(0, 500)}`
    );
  }

  if (!response.ok) {
    throw new Error(
      `Spotify token refresh failed (${response.status}): ${JSON.stringify(
        data
      )}`
    );
  }

  if (!data.access_token) {
    throw new Error("Spotify token refresh succeeded but no access_token was returned.");
  }

  return data.access_token;
}

async function spotifyRequest(token, endpoint, options = {}) {
  const response = await fetch(`${API}${endpoint}`, {
    ...options,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      ...(options.body
        ? {
            "Content-Type": "application/json"
          }
        : {}),
      ...(options.headers || {})
    }
  });

  const text = await response.text();

  let data = null;

  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    const retryAfter = response.headers.get("retry-after");

    let message = `Spotify API request failed (${response.status}) ${endpoint}`;

    if (retryAfter) {
      message += `; Retry-After: ${retryAfter}`;
    }

    if (typeof data === "string") {
      message += `: ${data.slice(0, 1000)}`;
    } else {
      message += `: ${JSON.stringify(data)}`;
    }

    throw new Error(message);
  }

  return data;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function slug(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function decodeXml(value) {
  return String(value || "")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
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
  return String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractXmlTag(block, tag) {
  const regex = new RegExp(
    `<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`,
    "i"
  );

  const match = String(block).match(regex);

  if (!match) {
    return "";
  }

  return decodeXml(match[1].trim());
}

function extractSpotifyUrl(value) {
  const text = String(value || "");

  const match = text.match(
    /https?:\/\/open\.spotify\.com\/(?:intl-[^/]+\/)?(?:track|album)\/[A-Za-z0-9]+[^\s"'<>)]*/i
  );

  if (!match) {
    return "";
  }

  return match[0]
    .replace(/[.,;:]+$/, "")
    .trim();
}

function extractPageField(html, field) {
  const escaped = String(field).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const patterns = [
    new RegExp(
      `<meta[^>]+(?:name|property)=["']${escaped}["'][^>]+content=["']([^"']*)["'][^>]*>`,
      "i"
    ),
    new RegExp(
      `<meta[^>]+content=["']([^"']*)["'][^>]+(?:name|property)=["']${escaped}["'][^>]*>`,
      "i"
    ),
    new RegExp(
      `<[^>]+data-${escaped}=["']([^"']*)["'][^>]*>`,
      "i"
    )
  ];

  for (const pattern of patterns) {
    const match = String(html).match(pattern);

    if (match?.[1]) {
      return decodeXml(stripHtml(match[1]).trim());
    }
  }

  return "";
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/["“”]/g, '"')
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function artistsMatch(track, artist) {
  const wanted = normalizeText(artist);

  if (!wanted) {
    return true;
  }

  const artists = Array.isArray(track?.artists)
    ? track.artists
        .map((item) => normalizeText(item?.name))
        .filter(Boolean)
    : [];

  if (!artists.length) {
    return false;
  }

  return artists.some(
    (name) =>
      name === wanted ||
      name.includes(wanted) ||
      wanted.includes(name)
  );
}

/* -------------------------------------------------------------------------- */
/* Spotify album / track resolution                                            */
/* -------------------------------------------------------------------------- */

async function getAlbumTracks(token, albumId) {
  const tracks = [];
  let offset = 0;

  while (true) {
    const data = await spotifyRequest(
      token,
      `/albums/${albumId}/tracks?limit=50&offset=${offset}`,
      {
        method: "GET"
      }
    );

    const items = Array.isArray(data?.items) ? data.items : [];

    tracks.push(...items);

    if (items.length === 0 || !data?.next) {
      break;
    }

    offset += items.length;

    // Small delay so a large album does not hammer the API.
    await sleep(100);
  }

  return tracks;
}

async function resolveAlbumTrack(
  token,
  albumId,
  songTitle,
  artist
) {
  console.log(
    `Resolving Spotify album ${albumId} for "${songTitle}" by "${artist}"...`
  );

  const tracks = await getAlbumTracks(token, albumId);

  if (!tracks.length) {
    throw new Error(
      `Spotify album ${albumId} returned no tracks.`
    );
  }

  const wantedTitle = normalizeText(songTitle);

  const usableTracks = tracks.filter(
    (track) => track?.id
  );

  if (!usableTracks.length) {
    throw new Error(
      `Spotify album ${albumId} contains no usable tracks.`
    );
  }

  /* ---------------------------------------------------------------------- */
  /* 1. Exact title + artist                                                 */
  /* ---------------------------------------------------------------------- */

  let match = usableTracks.find(
    (track) =>
      normalizeText(track.name) === wantedTitle &&
      artistsMatch(track, artist)
  );

  if (match) {
    console.log(
      `Matched Spotify album track exactly: "${match.name}" (${match.id})`
    );

    return match;
  }

  /* ---------------------------------------------------------------------- */
  /* 2. Exact title                                                          */
  /* ---------------------------------------------------------------------- */

  const exactTitleMatches = usableTracks.filter(
    (track) =>
      normalizeText(track.name) === wantedTitle
  );

  if (exactTitleMatches.length === 1) {
    match = exactTitleMatches[0];

    console.log(
      `Matched Spotify album track by exact title: "${match.name}" (${match.id})`
    );

    return match;
  }

  if (exactTitleMatches.length > 1) {
    const artistMatch = exactTitleMatches.find(
      (track) => artistsMatch(track, artist)
    );

    if (artistMatch) {
      console.log(
        `Matched Spotify album track by exact title + artist candidate: "${artistMatch.name}" (${artistMatch.id})`
      );

      return artistMatch;
    }

    match = exactTitleMatches[0];

    console.log(
      `Multiple exact title matches found; using first: "${match.name}" (${match.id})`
    );

    return match;
  }

  /* ---------------------------------------------------------------------- */
  /* 3. Partial / normalized title matching                                 */
  /* ---------------------------------------------------------------------- */

  if (wantedTitle) {
    const partialMatches = usableTracks.filter((track) => {
      const trackTitle = normalizeText(track.name);

      return (
        trackTitle &&
        (
          trackTitle.includes(wantedTitle) ||
          wantedTitle.includes(trackTitle)
        )
      );
    });

    if (partialMatches.length) {
      const artistPartialMatch = partialMatches.find(
        (track) => artistsMatch(track, artist)
      );

      match = artistPartialMatch || partialMatches[0];

      console.log(
        `Matched Spotify album track by normalized/partial title: "${match.name}" (${match.id})`
      );

      return match;
    }
  }

  /* ---------------------------------------------------------------------- */
  /* 4. FALLBACK: first track in album                                       */
  /* ---------------------------------------------------------------------- */

  const firstTrack = usableTracks[0];

  if (firstTrack?.id) {
    console.warn(
      `Spotify album ${albumId}: no matching track found for "${songTitle}" by "${artist}". ` +
        `Using FIRST album track: "${firstTrack.name}" (${firstTrack.id}).`
    );

    return firstTrack;
  }

  /* ---------------------------------------------------------------------- */
  /* 5. Nothing usable                                                       */
  /* ---------------------------------------------------------------------- */

  throw new Error(
    `Could not resolve a usable track from Spotify album ${albumId}.`
  );
}

/* -------------------------------------------------------------------------- */
/* Local AniPlaylist page handling                                             */
/* -------------------------------------------------------------------------- */

async function localSongPageFromUrl(pageUrl) {
  if (!pageUrl) {
    return null;
  }

  try {
    const url = new URL(pageUrl);

    const base = new URL(`${SITE_BASE}/`);

    let pathname = url.pathname;

    const basePath = base.pathname.replace(/\/$/, "");

    if (
      basePath &&
      basePath !== "/" &&
      pathname.startsWith(basePath)
    ) {
      pathname = pathname.slice(basePath.length);
    }

    pathname = pathname.replace(/^\/+/, "");

    if (!pathname) {
      return null;
    }

    const candidates = [
      path.join(SITE_DIR, pathname, "index.html"),
      path.join(SITE_DIR, pathname)
    ];

    for (const candidate of candidates) {
      try {
        const stat = await fs.stat(candidate);

        if (stat.isFile()) {
          return candidate;
        }
      } catch {
        // Continue.
      }
    }

    return null;
  } catch {
    return null;
  }
}

async function extractCurrentRssItems(season) {
  const rssPath = path.join(
    RSS_DIR,
    `${slug(season)}.xml`
  );

  let xml;

  try {
    xml = await fs.readFile(rssPath, "utf8");
  } catch (error) {
    throw new Error(
      `Could not read RSS file for ${season}: ${error.message}`
    );
  }

  const blocks = [
    ...String(xml).matchAll(
      /<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi
    )
  ].map((match) => match[0]);

  return blocks.map((block) => ({
    title: extractXmlTag(block, "title"),
    link: extractXmlTag(block, "link"),
    description: extractXmlTag(block, "description")
  }));
}

/* -------------------------------------------------------------------------- */
/* Resolve Spotify tracks from current RSS                                     */
/* -------------------------------------------------------------------------- */

async function resolveSeasonTracks(token, season) {
  const items = await extractCurrentRssItems(season);

  console.log(
    `${season}: found ${items.length} RSS item(s)`
  );

  const trackIds = [];
  const seen = new Set();

  for (const item of items) {
    if (!item.link) {
      continue;
    }

    const pagePath = await localSongPageFromUrl(item.link);

    if (!pagePath) {
      continue;
    }

    let html;

    try {
      html = await fs.readFile(pagePath, "utf8");
    } catch {
      continue;
    }

    const combinedText = [
      item.title,
      item.description,
      html
    ].join("\n");

    const spotifyUrl =
      extractSpotifyUrl(combinedText);

    if (!spotifyUrl) {
      continue;
    }

    let spotifyMatch;

    try {
      spotifyMatch = new URL(spotifyUrl).pathname.match(
        /\/(track|album)\/([A-Za-z0-9]+)/
      );
    } catch {
      continue;
    }

    if (!spotifyMatch) {
      continue;
    }

    const spotifyType = spotifyMatch[1];
    const spotifyId = spotifyMatch[2];

    const song =
      extractPageField(html, "song") ||
      extractPageField(html, "music:song") ||
      extractPageField(html, "og:title") ||
      item.title;

    const artist =
      extractPageField(html, "artist") ||
      extractPageField(html, "music:musician") ||
      "";

    let trackId = "";

    try {
      if (spotifyType === "track") {
        trackId = spotifyId;

        console.log(
          `${season}: direct Spotify track -> ${trackId}`
        );
      } else {
        const resolved = await resolveAlbumTrack(
          token,
          spotifyId,
          song,
          artist
        );

        trackId = resolved?.id || "";

        if (trackId) {
          console.log(
            `${season}: Spotify album -> "${resolved.name}" (${trackId})`
          );
        }
      }
    } catch (error) {
      console.warn(
        `${season}: Spotify resolution failed for "${song}" by "${artist}": ${error.message}`
      );

      continue;
    }

    if (!trackId) {
      continue;
    }

    if (seen.has(trackId)) {
      continue;
    }

    seen.add(trackId);
    trackIds.push(trackId);
  }

  return trackIds;
}

/* -------------------------------------------------------------------------- */
/* Playlist operations                                                        */
/* -------------------------------------------------------------------------- */

async function replacePlaylistItems(
  token,
  playlistId,
  trackIds
) {
  const uris = trackIds.map(
    (id) => `spotify:track:${id}`
  );

  /*
   * Spotify accepts up to 100 items per playlist request.
   *
   * PUT first batch:
   *   replaces playlist contents
   *
   * POST remaining batches:
   *   appends additional tracks
   */

  const firstBatch = uris.slice(0, 100);
  const remaining = uris.slice(100);

  await spotifyRequest(
    token,
    `/playlists/${playlistId}/items`,
    {
      method: "PUT",
      body: JSON.stringify({
        uris: firstBatch
      })
    }
  );

  for (let i = 0; i < remaining.length; i += 100) {
    const batch = remaining.slice(i, i + 100);

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

    await sleep(150);
  }
}

async function removePlaylistFromLibrary(
  token,
  playlistId
) {
  /*
   * Remove the playlist from the user's Spotify Library.
   *
   * This does not attempt to delete the playlist globally.
   */

  await spotifyRequest(
    token,
    `/me/library?uris=${encodeURIComponent(
      `spotify:playlist:${playlistId}`
    )}`,
    {
      method: "DELETE"
    }
  );
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

const config = await readJson(
  CONFIG_PATH,
  null
);

if (
  !config ||
  typeof config !== "object" ||
  Array.isArray(config)
) {
  throw new Error(
    "spotify-playlists.json must contain a JSON object."
  );
}

const seasons = Object.keys(config);

if (!seasons.length) {
  throw new Error(
    "spotify-playlists.json contains no seasons."
  );
}

const accessToken =
  await refreshAccessToken();

/*
 * Resolve everything BEFORE modifying Spotify.
 *
 * This prevents one bad season from partially modifying another
 * playlist before we know what the RSS currently contains.
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
let totalRemoved = 0;
let totalTracks = 0;
let configChanged = false;

/* -------------------------------------------------------------------------- */
/* Synchronize playlists                                                      */
/* -------------------------------------------------------------------------- */

for (const season of seasons) {
  const originalEntry = config[season];

  const entry =
    originalEntry &&
    typeof originalEntry === "object"
      ? originalEntry
      : {};

  const desiredTracks =
    desiredBySeason[season];

  console.log("");
  console.log(`=== ${season} ===`);

  /* ---------------------------------------------------------------------- */
  /* No tracks                                                               */
  /* ---------------------------------------------------------------------- */

  if (desiredTracks.length === 0) {
    if (entry.id) {
      console.log(
        "Current RSS has 0 Spotify tracks."
      );

      console.log(
        "Removing existing playlist from Spotify Library..."
      );

      await removePlaylistFromLibrary(
        accessToken,
        entry.id
      );

      console.log(
        "Empty Spotify playlist removed from Your Library."
      );

      totalRemoved++;
    } else {
      console.log(
        "No current Spotify tracks. No playlist exists."
      );
    }

    if (
      entry.id ||
      entry.url ||
      (
        Array.isArray(entry.trackIds) &&
        entry.trackIds.length
      )
    ) {
      configChanged = true;
    }

    entry.id = "";
    entry.url = "";
    entry.trackIds = [];

    config[season] = entry;

    continue;
  }

  /* ---------------------------------------------------------------------- */
  /* Create playlist if necessary                                            */
  /* ---------------------------------------------------------------------- */

  if (!entry.id) {
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
            name: `AniPlaylist — ${season}`,
            description:
              "Automatically updated from AniPlaylist RSS. " +
              `Source: https://aniplaylist.com/?seasons=${encodeURIComponent(
                season
              )}`,
            public: true,
            collaborative: false
          })
        }
      );

    if (!playlist?.id) {
      throw new Error(
        `Spotify created playlist for ${season} but returned no playlist ID.`
      );
    }

    entry.id = playlist.id;

    totalCreated++;
    configChanged = true;

    console.log(
      `Created Spotify playlist: ${entry.id}`
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Playlist URL                                                            */
  /* ---------------------------------------------------------------------- */

  const expectedUrl =
    `https://open.spotify.com/playlist/${entry.id}`;

  if (entry.url !== expectedUrl) {
    entry.url = expectedUrl;
    configChanged = true;
  }

  /* ---------------------------------------------------------------------- */
  /* Replace playlist contents                                               */
  /* ---------------------------------------------------------------------- */

  console.log(
    `Current RSS Spotify tracks: ${desiredTracks.length}`
  );

  console.log(
    "Replacing Spotify playlist contents with current RSS order..."
  );

  await replacePlaylistItems(
    accessToken,
    entry.id,
    desiredTracks
  );

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

  entry.trackIds = desiredTracks;

  config[season] = entry;

  totalSynced++;
  totalTracks += desiredTracks.length;

  console.log(
    `Playlist synchronized exactly: ${desiredTracks.length} track(s).`
  );

  console.log(
    "Newest RSS track is now playlist position #1."
  );
}

/* -------------------------------------------------------------------------- */
/* Save config                                                                */
/* -------------------------------------------------------------------------- */

if (configChanged) {
  await fs.writeFile(
    CONFIG_PATH,
    JSON.stringify(config, null, 2) + "\n",
    "utf8"
  );

  console.log(
    `Updated ${path.relative(ROOT, CONFIG_PATH)}`
  );
}

/* -------------------------------------------------------------------------- */
/* Summary                                                                    */
/* -------------------------------------------------------------------------- */

console.log("");
console.log("===== SPOTIFY SYNC =====");
console.log(
  `Playlists created: ${totalCreated}`
);
console.log(
  `Playlists synchronized: ${totalSynced}`
);
console.log(
  `Playlists removed from Library: ${totalRemoved}`
);
console.log(
  `Current RSS Spotify tracks: ${totalTracks}`
);
console.log(
  "Album/OST links contribute ONE track only."
);
console.log(
  "If an album has no matching song title, the FIRST album track is used."
);
console.log(
  "New tracks follow RSS order, with newest at the top."
);
console.log(
  "Empty seasons have no Spotify playlist in Your Library."
);
console.log("========================");
