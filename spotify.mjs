import fs from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const CONFIG_PATH = path.join(ROOT, "spotify-playlists.json");
const SPOTIFY_CURRENT_PATH = path.join(ROOT, "spotify-current.json");

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
const MAX_ITEMS_PER_REQUEST = 100;
const MAX_RETRIES = 5;

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function chunk(array, size) {
  const output = [];
  for (let i = 0; i < array.length; i += size) {
    output.push(array.slice(i, i + size));
  }
  return output;
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[’‘\u0060]/g, "'")
    .replace(/["“”]/g, '"')
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function artistsMatch(track, artist) {
  const wanted = normalizeText(artist);
  if (!wanted) return true;

  const artists = Array.isArray(track?.artists)
    ? track.artists.map(item => normalizeText(item?.name)).filter(Boolean)
    : [];

  if (!artists.length) return false;

  return artists.some(
    name =>
      name === wanted ||
      name.includes(wanted) ||
      wanted.includes(name)
  );
}

function normalizeCurrentSource(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("spotify-current.json must contain an object.");
  }

  if (
    data.seasons &&
    typeof data.seasons === "object" &&
    !Array.isArray(data.seasons)
  ) {
    return data.seasons;
  }

  return data;
}

async function refreshAccessToken() {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: REFRESH_TOKEN,
    client_id: CLIENT_ID,
  });

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  const text = await response.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      "Spotify token endpoint returned invalid JSON: " +
        text.slice(0, 500)
    );
  }

  if (!response.ok) {
    throw new Error(
      "Spotify token refresh failed (" +
        response.status +
        "): " +
        JSON.stringify(data)
    );
  }

  if (!data.access_token) {
    throw new Error(
      "Spotify token refresh succeeded but no access_token was returned."
    );
  }

  return data.access_token;
}

async function spotifyRequest(token, endpoint, options = {}) {
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(API + endpoint, {
        ...options,
        headers: {
          Accept: "application/json",
          Authorization: "Bearer " + token,
          ...(options.body
            ? { "Content-Type": "application/json" }
            : {}),
          ...(options.headers || {}),
        },
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

      if (response.ok) {
        return data;
      }

      const retryAfter = response.headers.get("retry-after");
      const retryable =
        response.status === 429 ||
        response.status >= 500;

      if (!retryable || attempt === MAX_RETRIES) {
        let message =
          "Spotify API request failed (" +
          response.status +
          ") " +
          endpoint;

        if (retryAfter) {
          message += "; Retry-After: " + retryAfter;
        }

        if (typeof data === "string") {
          message += ": " + data.slice(0, 1000);
        } else {
          message += ": " + JSON.stringify(data);
        }

        throw new Error(message);
      }

      const retryAfterMs =
        retryAfter && /^\d+(?:\.\d+)?$/.test(retryAfter)
          ? Number(retryAfter) * 1000
          : 0;

      const backoffMs = Math.min(
        30000,
        1000 * 2 ** (attempt - 1)
      );

      const waitMs = Math.max(
        retryAfterMs,
        backoffMs
      );

      console.warn(
        "Spotify API " +
          response.status +
          " on " +
          endpoint +
          "; retrying in " +
          Math.ceil(waitMs / 1000) +
          "s (attempt " +
          attempt +
          "/" +
          MAX_RETRIES +
          ")"
      );

      await sleep(waitMs);
    } catch (error) {
      lastError = error;

      if (attempt === MAX_RETRIES) {
        break;
      }

      const waitMs = Math.min(
        30000,
        1000 * 2 ** (attempt - 1)
      );

      console.warn(
        "Spotify request error on " +
          endpoint +
          ": " +
          error.message +
          ". Retrying in " +
          Math.ceil(waitMs / 1000) +
          "s..."
      );

      await sleep(waitMs);
    }
  }

  throw lastError || new Error(
    "Spotify API request failed: " + endpoint
  );
}

async function getAlbumTracks(token, albumId) {
  const tracks = [];
  let offset = 0;

  while (true) {
    const data = await spotifyRequest(
      token,
      "/albums/" +
        albumId +
        "/tracks?limit=50&offset=" +
        offset,
      { method: "GET" }
    );

    const items = Array.isArray(data?.items)
      ? data.items
      : [];

    tracks.push(...items);

    if (!items.length || !data?.next) {
      break;
    }

    offset += items.length;
    await sleep(100);
  }

  return tracks;
}

async function resolveAlbumTrack(token, ref) {
  const songTitle = String(ref.song || "").trim();
  const artist = String(ref.artist || "").trim();

  console.log(
    "Resolving Spotify album " +
      ref.id +
      " for \"" +
      (songTitle || "unknown title") +
      "\" by \"" +
      (artist || "unknown artist") +
      "\"..."
  );

  const tracks = await getAlbumTracks(token, ref.id);

  if (!tracks.length) {
    throw new Error(
      "Spotify album " +
        ref.id +
        " returned no tracks."
    );
  }

  const usableTracks = tracks.filter(
    track => track?.id
  );

  if (!usableTracks.length) {
    throw new Error(
      "Spotify album " +
        ref.id +
        " contains no usable tracks."
    );
  }

  const wantedTitle = normalizeText(songTitle);

  if (wantedTitle) {
    const exactTitleArtist =
      usableTracks.find(
        track =>
          normalizeText(track.name) === wantedTitle &&
          artistsMatch(track, artist)
      );

    if (exactTitleArtist) {
      console.log(
        "Album match: exact title + artist -> \"" +
          exactTitleArtist.name +
          "\" (" +
          exactTitleArtist.id +
          ")"
      );
      return exactTitleArtist;
    }

    const exactTitle =
      usableTracks.filter(
        track => normalizeText(track.name) === wantedTitle
      );

    if (exactTitle.length === 1) {
      console.log(
        "Album match: exact title -> \"" +
          exactTitle[0].name +
          "\" (" +
          exactTitle[0].id +
          ")"
      );
      return exactTitle[0];
    }

    if (exactTitle.length > 1) {
      const titleArtist =
        exactTitle.find(
          track => artistsMatch(track, artist)
        );

      if (titleArtist) {
        console.log(
          "Album match: duplicate exact title + artist -> \"" +
            titleArtist.name +
            "\" (" +
            titleArtist.id +
            ")"
        );
        return titleArtist;
      }

      console.log(
        "Album match: duplicate exact title; using first -> \"" +
          exactTitle[0].name +
          "\" (" +
          exactTitle[0].id +
          ")"
      );
      return exactTitle[0];
    }

    const partial =
      usableTracks.filter(track => {
        const trackTitle =
          normalizeText(track.name);

        return (
          trackTitle &&
          (
            trackTitle.includes(wantedTitle) ||
            wantedTitle.includes(trackTitle)
          )
        );
      });

    if (partial.length) {
      const artistPartial =
        partial.find(
          track => artistsMatch(track, artist)
        );

      const chosen =
        artistPartial || partial[0];

      console.log(
        "Album match: partial title -> \"" +
          chosen.name +
          "\" (" +
          chosen.id +
          ")"
      );

      return chosen;
    }
  }

  const firstTrack = usableTracks[0];

  console.warn(
    "Album " +
      ref.id +
      ": no title match for \"" +
      (songTitle || "unknown title") +
      "\" by \"" +
      (artist || "unknown artist") +
      "\". Using FIRST album track: \"" +
      firstTrack.name +
      "\" (" +
      firstTrack.id +
      ")."
  );

  return firstTrack;
}

async function resolveReference(token, ref, season, index) {
  if (
    !ref ||
    typeof ref !== "object" ||
    Array.isArray(ref)
  ) {
    console.warn(
      season +
        ": skipping invalid Spotify reference #" +
        (index + 1) +
        "."
    );
    return "";
  }

  const type = String(
    ref.type || ""
  ).toLowerCase();

  const id = String(
    ref.id || ""
  ).trim();

  if (
    !id ||
    !["track", "album"].includes(type)
  ) {
    console.warn(
      season +
        ": skipping invalid/unsupported Spotify reference #" +
        (index + 1) +
        " (type=" +
        type +
        ", id=" +
        id +
        ")."
    );
    return "";
  }

  if (type === "track") {
    return id;
  }

  const resolved =
    await resolveAlbumTrack(
      token,
      {
        id,
        song: ref.song,
        artist: ref.artist,
      }
    );

  return resolved?.id || "";
}

async function resolveSeasonTracks(
  token,
  season,
  refs
) {
  if (!Array.isArray(refs)) {
    throw new Error(
      "spotify-current.json: \"" +
        season +
        "\" must be an array."
    );
  }

  console.log(
    season +
      ": " +
      refs.length +
      " Spotify source reference(s)"
  );

  const trackIds = [];
  const seen = new Set();

  for (
    let index = 0;
    index < refs.length;
    index++
  ) {
    const trackId =
      await resolveReference(
        token,
        refs[index],
        season,
        index
      );

    if (!trackId) continue;

    if (seen.has(trackId)) {
      console.log(
        season +
          ": duplicate resolved track " +
          trackId +
          "; keeping first occurrence."
      );
      continue;
    }

    seen.add(trackId);
    trackIds.push(trackId);
  }

  return trackIds;
}

async function replacePlaylistItems(
  token,
  playlistId,
  trackIds
) {
  if (!trackIds.length) {
    throw new Error(
      "Cannot replace playlist " +
        playlistId +
        " with zero tracks."
    );
  }

  const uris =
    trackIds.map(
      id => "spotify:track:" + id
    );

  const batches =
    chunk(
      uris,
      MAX_ITEMS_PER_REQUEST
    );

  console.log(
    "Writing " +
      trackIds.length +
      " track(s) to playlist " +
      playlistId +
      " in " +
      batches.length +
      " request(s)."
  );

  await spotifyRequest(
    token,
    "/playlists/" +
      playlistId +
      "/items",
    {
      method: "PUT",
      body: JSON.stringify({
        uris: batches[0],
      }),
    }
  );

  for (
    let i = 1;
    i < batches.length;
    i++
  ) {
    await spotifyRequest(
      token,
      "/playlists/" +
        playlistId +
        "/items",
      {
        method: "POST",
        body: JSON.stringify({
          uris: batches[i],
        }),
      }
    );

    await sleep(150);
  }
}

async function createPlaylist(
  token,
  season
) {
  const playlist =
    await spotifyRequest(
      token,
      "/me/playlists",
      {
        method: "POST",
        body: JSON.stringify({
          name:
            "AniPlaylist — " +
            season,
          description:
            "Automatically updated from AniPlaylist. " +
            "Source: https://aniplaylist.com/?seasons=" +
            encodeURIComponent(season),
          public: true,
          collaborative: false,
        }),
      }
    );

  if (!playlist?.id) {
    throw new Error(
      "Spotify created \"" +
        season +
        "\" but returned no playlist ID."
    );
  }

  return playlist;
}

async function removePlaylistFromLibrary(
  token,
  playlistId
) {
  await spotifyRequest(
    token,
    "/me/library?uris=" +
      encodeURIComponent(
        "spotify:playlist:" +
          playlistId
      ),
    {
      method: "DELETE",
    }
  );
}

function playlistEntryNeedsUpdate(
  entry,
  playlistId,
  desiredTracks
) {
  const expectedUrl =
    "https://open.spotify.com/playlist/" +
    playlistId;

  const oldTrackIds =
    Array.isArray(entry?.trackIds)
      ? entry.trackIds
      : [];

  return (
    entry.id !== playlistId ||
    entry.url !== expectedUrl ||
    JSON.stringify(oldTrackIds) !==
      JSON.stringify(desiredTracks)
  );
}

const config =
  await readJson(
    CONFIG_PATH
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

const seasons =
  Object.keys(config);

if (!seasons.length) {
  throw new Error(
    "spotify-playlists.json contains no seasons."
  );
}

let currentSource;

try {
  currentSource =
    normalizeCurrentSource(
      await readJson(
        SPOTIFY_CURRENT_PATH
      )
    );
} catch (error) {
  throw new Error(
    "Could not read " +
      path.basename(
        SPOTIFY_CURRENT_PATH
      ) +
      ": " +
      error.message
  );
}

const accessToken =
  await refreshAccessToken();

/*
 * Source of truth:
 *
 * scrape.mjs -> spotify-current.json -> spotify.mjs
 *
 * state.json is historical RSS metadata and is never used to decide
 * current Spotify playlist membership.
 */

const desiredBySeason = {};

for (const season of seasons) {
  console.log("");
  console.log(
    "=== Resolving current Spotify source: " +
      season +
      " ==="
  );

  const refs =
    currentSource[season] || [];

  desiredBySeason[season] =
    await resolveSeasonTracks(
      accessToken,
      season,
      refs
    );

  console.log(
    season +
      ": " +
      desiredBySeason[season].length +
      " unique Spotify track(s) resolved."
  );
}

let totalCreated = 0;
let totalSynced = 0;
let totalRemoved = 0;
let totalTracks = 0;
let configChanged = false;

for (const season of seasons) {
  const originalEntry =
    config[season];

  const entry =
    originalEntry &&
    typeof originalEntry === "object" &&
    !Array.isArray(originalEntry)
      ? originalEntry
      : {};

  const desiredTracks =
    desiredBySeason[season];

  console.log("");
  console.log(
    "=== Syncing Spotify: " +
      season +
      " ==="
  );

  if (!desiredTracks.length) {
    if (entry.id) {
      console.log(
        "Current AniPlaylist source has 0 Spotify tracks. " +
          "Removing playlist " +
          entry.id +
          " from Your Library..."
      );

      await removePlaylistFromLibrary(
        accessToken,
        entry.id
      );

      console.log(
        season +
          ": empty playlist removed from Your Library."
      );

      totalRemoved++;
    } else {
      console.log(
        season +
          ": no Spotify tracks and no existing playlist."
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

    config[season] = {
      id: "",
      url: "",
      trackIds: [],
    };

    continue;
  }

  let playlistId =
    String(entry.id || "").trim();

  let createdHere = false;

  if (!playlistId) {
    console.log(
      "Creating Spotify playlist: AniPlaylist — " +
        season
    );

    const playlist =
      await createPlaylist(
        accessToken,
        season
      );

    playlistId = playlist.id;
    createdHere = true;
    totalCreated++;

    console.log(
      "Created playlist " +
        playlistId
    );
  }

  try {
    console.log(
      "Current RSS Spotify tracks: " +
        desiredTracks.length
    );

    if (
      playlistEntryNeedsUpdate(
        entry,
        playlistId,
        desiredTracks
      )
    ) {
      await replacePlaylistItems(
        accessToken,
        playlistId,
        desiredTracks
      );

      console.log(
        season +
          ": playlist contents synchronized to current source."
      );
    } else {
      console.log(
        season +
          ": playlist already matches recorded source; no write needed."
      );
    }
  } catch (error) {
    if (createdHere) {
      try {
        await removePlaylistFromLibrary(
          accessToken,
          playlistId
        );

        console.warn(
          season +
            ": newly created playlist " +
            playlistId +
            " was removed from Your Library after sync failure."
        );
      } catch (cleanupError) {
        console.warn(
          season +
            ": cleanup of newly created playlist " +
            playlistId +
            " failed: " +
            cleanupError.message
        );
      }
    }

    throw error;
  }

  const expectedUrl =
    "https://open.spotify.com/playlist/" +
    playlistId;

  if (
    entry.id !== playlistId ||
    entry.url !== expectedUrl ||
    JSON.stringify(entry.trackIds || []) !==
      JSON.stringify(desiredTracks)
  ) {
    configChanged = true;
  }

  entry.id = playlistId;
  entry.url = expectedUrl;
  entry.trackIds = desiredTracks;

  config[season] = entry;

  totalSynced++;
  totalTracks += desiredTracks.length;

  console.log(
    season +
      ": " +
      desiredTracks.length +
      " track(s), newest source item is playlist position #1."
  );
}

if (configChanged) {
  await fs.writeFile(
    CONFIG_PATH,
    JSON.stringify(config, null, 2) +
      "\n",
    "utf8"
  );

  console.log(
    "Updated " +
      path.relative(
        ROOT,
        CONFIG_PATH
      )
  );
}

console.log("");
console.log("===== SPOTIFY SYNC =====");
console.log(
  "Playlists created: " +
    totalCreated
);
console.log(
  "Playlists synchronized: " +
    totalSynced
);
console.log(
  "Playlists removed from Library: " +
    totalRemoved
);
console.log(
  "Current RSS Spotify tracks: " +
    totalTracks
);
console.log(
  "Album/OST links contribute ONE track only."
);
console.log(
  "Album resolution: exact title + artist -> exact title -> partial title -> FIRST album track."
);
console.log(
  "Source: spotify-current.json generated by scrape.mjs."
);
console.log(
  "Historical state.json is not used for Spotify playlist membership."
);
console.log("========================");
