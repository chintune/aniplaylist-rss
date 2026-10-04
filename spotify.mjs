import fs from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();

const CONFIG_PATH = path.join(
  ROOT,
  "spotify-playlists.json"
);

const RSS_DIR = path.join(
  ROOT,
  "rss"
);

const SITE_DIR = path.join(
  ROOT,
  "site"
);

const CLIENT_ID =
  process.env.SPOTIFY_CLIENT_ID;

const REFRESH_TOKEN =
  process.env.SPOTIFY_REFRESH_TOKEN;

if (
  !CLIENT_ID ||
  !REFRESH_TOKEN
) {
  console.log(
    "Spotify secrets are not configured; skipping Spotify playlist sync."
  );

  process.exit(0);
}

const API =
  "https://api.spotify.com/v1";

const TOKEN_URL =
  "https://accounts.spotify.com/api/token";

const SITE_BASE = String(
  process.env.SITE_BASE ||
    "https://chintune.github.io/aniplaylist-rss"
).replace(/\/$/, "");


/* =========================================================
   JSON
   ========================================================= */

async function readJson(
  file,
  fallback = undefined
) {
  try {
    return JSON.parse(
      await fs.readFile(
        file,
        "utf8"
      )
    );
  } catch (error) {
    if (
      fallback !== undefined
    ) {
      return fallback;
    }

    throw new Error(
      `Could not read ${file}: ${error.message}`
    );
  }
}


/* =========================================================
   SPOTIFY AUTH
   ========================================================= */

async function refreshAccessToken() {
  const response =
    await fetch(TOKEN_URL, {
      method: "POST",

      headers: {
        "Content-Type":
          "application/x-www-form-urlencoded"
      },

      body:
        new URLSearchParams({
          grant_type:
            "refresh_token",

          refresh_token:
            REFRESH_TOKEN,

          client_id:
            CLIENT_ID
        })
    });

  const data =
    await response.json();

  if (!response.ok) {
    throw new Error(
      `Spotify token refresh failed: ${
        data.error ||
        response.status
      } ${
        data.error_description ||
        ""
      }`.trim()
    );
  }

  return data.access_token;
}


async function spotifyRequest(
  token,
  endpoint,
  options = {}
) {
  const response =
    await fetch(
      `${API}${endpoint}`,
      {
        ...options,

        headers: {
          Authorization:
            `Bearer ${token}`,

          "Content-Type":
            "application/json",

          ...(options.headers || {})
        }
      }
    );

  const text =
    await response.text();

  let data = {};

  try {
    data = text
      ? JSON.parse(text)
      : {};
  } catch {
    data = {};
  }

  if (!response.ok) {
    const retryAfter =
      response.headers.get(
        "retry-after"
      );

    throw new Error(
      `Spotify API ${
        response.status
      }: ${
        data.error?.message ||
        text ||
        "request failed"
      }${
        retryAfter
          ? ` (Retry-After: ${retryAfter}s)`
          : ""
      }`
    );
  }

  return data;
}


function sleep(ms) {
  return new Promise(
    resolve =>
      setTimeout(resolve, ms)
  );
}


/* =========================================================
   TEXT / HTML / XML HELPERS
   ========================================================= */

function slug(value) {
  return String(value)
    .toLowerCase()
    .replace(
      /[^a-z0-9]+/g,
      "-"
    )
    .replace(
      /^-+|-+$/g,
      "");
}


function decodeXml(value) {
  return String(
    value ?? ""
  )
    .replace(
      /&lt;/g,
      "<"
    )
    .replace(
      /&gt;/g,
      ">"
    )
    .replace(
      /&quot;/g,
      '"'
    )
    .replace(
      /&apos;/g,
      "'"
    )
    .replace(
      /&#39;/g,
      "'"
    )
    .replace(
      /&amp;/g,
      "&"
    )
    .replace(
      /&#(\d+);/g,
      (_, n) => {
        try {
          return String.fromCodePoint(
            Number(n)
          );
        } catch {
          return _;
        }
      }
    )
    .replace(
      /&#x([0-9a-f]+);/gi,
      (_, n) => {
        try {
          return String.fromCodePoint(
            parseInt(
              n,
              16
            )
          );
        } catch {
          return _;
        }
      }
    );
}


function stripHtml(value) {
  return decodeXml(
    String(value ?? "")
      .replace(
        /<br\s*\/?>/gi,
        " "
      )
      .replace(
        /<[^>]*>/g,
        " "
      )
  )
    .replace(
      /\s+/g,
      " "
    )
    .trim();
}


function extractXmlTag(
  block,
  tagName
) {
  const regex =
    new RegExp(
      `<${tagName}\\b[^>]*>([\\s\\S]*?)</${tagName}>`,
      "i"
    );

  const match =
    block.match(regex);

  return match
    ? decodeXml(
        match[1].trim()
      )
    : "";
}


function extractSpotifyUrl(
  html
) {
  const match =
    String(html ?? "").match(
      /https?:\/\/open\.spotify\.com\/(track|album)\/([A-Za-z0-9]+)/i
    );

  if (!match) {
    return "";
  }

  return `https://open.spotify.com/${match[1].toLowerCase()}/${match[2]}`;
}


function extractPageField(
  html,
  className
) {
  const regex =
    new RegExp(
      `<div\\s+class=["']${className}["'][^>]*>([\\s\\S]*?)<\\/div>`,
      "i"
    );

  const match =
    String(html ?? "").match(
      regex
    );

  return match
    ? stripHtml(match[1])
    : "";
}


function normalizeText(
  value
) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(
      /[\u0300-\u036f]/g,
      ""
    )
    .toLowerCase()
    .replace(
      /&/g,
      " and "
    )
    .replace(
      /[^a-z0-9]+/g,
      " "
    )
    .replace(
      /\s+/g,
      " "
    )
    .trim();
}


function artistsMatch(
  trackArtists,
  wantedArtist
) {
  const wanted =
    normalizeText(
      wantedArtist
    );

  if (!wanted) {
    return true;
  }

  return trackArtists.some(
    artist => {
      const actual =
        normalizeText(
          artist
        );

      return (
        actual === wanted ||
        actual.includes(wanted) ||
        wanted.includes(actual)
      );
    }
  );
}


/* =========================================================
   SPOTIFY ALBUM -> ONE TRACK
   ========================================================= */

/*
 * IMPORTANT:
 *
 * AniPlaylist may give us:
 *
 * https://open.spotify.com/album/XXXXXXXX
 *
 * That does NOT mean:
 *
 * "Add every song from this album."
 *
 * It means:
 *
 * "This AniPlaylist song is represented by an album link."
 *
 * We inspect the album and add ONLY ONE TRACK.
 *
 * Resolution order:
 *
 * 1. Exact title + artist
 * 2. Exact title
 * 3. Partial / normalized title
 * 4. FIRST TRACK OF ALBUM
 *
 * The first-track fallback is intentional.
 *
 * Some AniPlaylist OST entries use the album title as
 * the song title, so there may be no matching track name.
 *
 * We should not fail the entire Spotify sync because of
 * that metadata mismatch.
 */

async function getAlbumTracks(
  token,
  albumId
) {
  const tracks = [];

  let offset = 0;

  while (true) {
    const data =
      await spotifyRequest(
        token,
        `/albums/${albumId}/tracks?limit=50&offset=${offset}`,
        {
          method: "GET"
        }
      );

    const items =
      Array.isArray(
        data.items
      )
        ? data.items
        : [];

    tracks.push(
      ...items
    );

    if (
      items.length === 0 ||
      !data.next
    ) {
      break;
    }

    offset +=
      items.length;
  }

  return tracks;
}


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
    normalizeText(
      songTitle
    );


  /*
   * ---------------------------------------------------------
   * 1. EXACT TITLE
   * ---------------------------------------------------------
   */

  const exactTitle =
    tracks.filter(
      track =>
        normalizeText(
          track.name
        ) === wantedTitle
    );


  /*
   * ---------------------------------------------------------
   * 1A. EXACT TITLE + ARTIST
   * ---------------------------------------------------------
   */

  const exactTitleArtist =
    exactTitle.find(
      track =>
        artistsMatch(
          Array.isArray(
            track.artists
          )
            ? track.artists.map(
                a =>
                  a?.name || ""
              )
            : [],
          artist
        )
    );

  if (
    exactTitleArtist?.id
  ) {
    return exactTitleArtist;
  }


  /*
   * ---------------------------------------------------------
   * 2. EXACT TITLE ONLY
   * ---------------------------------------------------------
   *
   * If only one track has the exact title, use it even
   * if the artist metadata is formatted differently.
   */

  if (
    exactTitle.length === 1 &&
    exactTitle[0]?.id
  ) {
    return exactTitle[0];
  }


  /*
   * ---------------------------------------------------------
   * 3. PARTIAL / NORMALIZED TITLE
   * ---------------------------------------------------------
   */

  const fallback =
    tracks.find(
      track => {
        const actual =
          normalizeText(
            track.name
          );

        return (
          actual ===
            wantedTitle ||
          actual.includes(
            wantedTitle
          ) ||
          wantedTitle.includes(
            actual
          )
        );
      }
    );

  if (fallback?.id) {
    return fallback;
  }


  /*
   * ---------------------------------------------------------
   * 4. FIRST TRACK OF ALBUM
   * ---------------------------------------------------------
   *
   * NEW FIX
   *
   * If AniPlaylist's title does not correspond to an
   * actual Spotify track, DO NOT FAIL THE WORKFLOW.
   *
   * Simply use the first usable track from the album.
   *
   * This handles cases such as:
   *
   * AniPlaylist:
   *   Original Soundtrack Vol.1
   *
   * Spotify album:
   *   Original Soundtrack Vol.1
   *
   * where the album title is being supplied as the
   * "song" title but no track has that exact name.
   */

  const firstTrack =
    tracks.find(
      track =>
        track?.id
    );

  if (
    firstTrack?.id
  ) {
    const firstTrackArtists =
      Array.isArray(
        firstTrack.artists
      )
        ? firstTrack.artists
            .map(
              a =>
                a?.name || ""
            )
            .filter(Boolean)
            .join(", ")
        : "";

    console.warn(
      `Spotify album ${albumId}: no matching track found for "${songTitle}" by "${artist}". Using FIRST album track: "${firstTrack.name}"${firstTrackArtists ? ` by ${firstTrackArtists}` : ""} (${firstTrack.id}).`
    );

    return firstTrack;
  }


  /*
   * This should only happen if Spotify returned album
   * entries without usable track IDs.
   */

  throw new Error(
    `Spotify album ${albumId} returned no usable tracks for "${songTitle}" by "${artist}".`
  );
}


/* =========================================================
   LOCAL SONG PAGE
   ========================================================= */

function localSongPageFromUrl(
  pageUrl
) {
  const page =
    new URL(pageUrl);

  const base =
    new URL(SITE_BASE);

  let relative =
    page.pathname;

  const basePath =
    base.pathname.replace(
      /\/$/,
      ""
    );

  if (
    basePath &&
    basePath !== "/" &&
    relative.startsWith(
      basePath + "/"
    )
  ) {
    relative =
      relative.slice(
        basePath.length + 1
      );
  } else {
    relative =
      relative.replace(
        /^\/+/,
        ""
      );
  }

  relative =
    relative.replace(
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


/* =========================================================
   CURRENT RSS
   ========================================================= */

async function extractCurrentRssItems(
  season
) {
  const rssPath =
    path.join(
      RSS_DIR,
      `${slug(season)}.xml`
    );

  let xml;

  try {
    xml =
      await fs.readFile(
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
  ].map(
    match => match[1]
  );

  const items = [];

  for (
    const block of blocks
  ) {
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
      title:
        extractXmlTag(
          block,
          "title"
        )
    });
  }

  return items;
}


/* =========================================================
   RESOLVE CURRENT RSS -> SPOTIFY TRACK IDS
   ========================================================= */

async function resolveSeasonTracks(
  token,
  season
) {
  const rssItems =
    await extractCurrentRssItems(
      season
    );

  const trackIds = [];

  const seen =
    new Set();

  /*
   * RSS order is the Spotify playlist order.
   *
   * scrape.mjs writes RSS newest-first.
   *
   * Therefore:
   *
   * RSS item #1
   *      ↓
   * Spotify playlist #1
   */

  for (
    let index = 0;
    index <
      rssItems.length;
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
      html =
        await fs.readFile(
          pagePath,
          "utf8"
        );
    } catch (error) {
      throw new Error(
        `Song page for ${season} item #${
          index + 1
        } could not be read: ${pagePath}: ${error.message}`
      );
    }

    const spotifyUrl =
      extractSpotifyUrl(
        html
      );

    /*
     * No Spotify link:
     * keep it in RSS, but don't add it to Spotify.
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

    let trackId =
      "";


    /*
     * -------------------------------------------------------
     * DIRECT TRACK
     * -------------------------------------------------------
     */

    if (
      type === "track"
    ) {
      trackId =
        spotifyId;
    }


    /*
     * -------------------------------------------------------
     * ALBUM / OST
     * -------------------------------------------------------
     *
     * Resolve ONE song only.
     *
     * If exact matching fails, resolveAlbumTrack()
     * automatically uses the first album track.
     */

    else if (
      type === "album"
    ) {
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
        `${season}: resolved Spotify album ${spotifyId} -> ONE track ${trackId} for "${songTitle}"`
      );
    }


    if (!trackId) {
      throw new Error(
        `Spotify track could not be resolved for ${season}: "${songTitle}" (${spotifyUrl})`
      );
    }


    /*
     * Prevent duplicate tracks within the same season.
     *
     * First occurrence wins.
     */

    if (
      !seen.has(
        trackId
      )
    ) {
      seen.add(
        trackId
      );

      trackIds.push(
        trackId
      );
    }
  }

  return trackIds;
}


/* =========================================================
   REPLACE PLAYLIST ITEMS
   ========================================================= */

async function replacePlaylistItems(
  token,
  playlistId,
  trackIds
) {
  const uris =
    trackIds.map(
      id =>
        `spotify:track:${id}`
    );

  /*
   * PUT replaces the complete playlist.
   *
   * [] clears it.
   *
   * Spotify allows up to 100 items in this replacement
   * request.
   */

  await spotifyRequest(
    token,
    `/playlists/${playlistId}/items`,
    {
      method: "PUT",

      body:
        JSON.stringify({
          uris:
            uris.slice(
              0,
              100
            )
        })
    }
  );


  /*
   * If more than 100 tracks exist,
   * append remaining batches.
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

        body:
          JSON.stringify({
            uris:
              batch
          })
      }
    );

    if (
      i + 100 <
      uris.length
    ) {
      await sleep(
        500
      );
    }
  }
}


/* =========================================================
   REMOVE PLAYLIST FROM USER'S LIBRARY
   ========================================================= */

/*
 * IMPORTANT:
 *
 * Spotify does not have a "delete playlist" Web API operation.
 *
 * Removing your own playlist from Your Library is effectively
 * unfollowing/removing that playlist from your library.
 *
 * Spotify's current generic endpoint is:
 *
 * DELETE /me/library
 *
 * with:
 *
 * spotify:playlist:{playlistId}
 *
 * This is what we use for empty seasons.
 */

async function removePlaylistFromLibrary(
  token,
  playlistId
) {
  const playlistUri =
    `spotify:playlist:${playlistId}`;

  await spotifyRequest(
    token,
    `/me/library?uris=${encodeURIComponent(
      playlistUri
    )}`,
    {
      method: "DELETE"
    }
  );
}


/* =========================================================
   LOAD CONFIG
   ========================================================= */

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
  Object.keys(
    config
  );

if (
  !seasons.length
) {
  throw new Error(
    "spotify-playlists.json contains no seasons."
  );
}


/* =========================================================
   AUTHENTICATE
   ========================================================= */

const accessToken =
  await refreshAccessToken();


/* =========================================================
   RESOLVE EVERYTHING BEFORE MODIFYING SPOTIFY
   ========================================================= */

/*
 * This is deliberate.
 *
 * We resolve ALL seasons first.
 *
 * If there is a genuine Spotify/API problem, the workflow
 * stops before changing any playlist.
 *
 * Album title mismatches are NOT fatal anymore because
 * resolveAlbumTrack() falls back to the first album track.
 */

const desiredBySeason =
  {};

for (
  const season of seasons
) {
  console.log("");

  console.log(
    `=== Resolving RSS tracks: ${season} ===`
  );

  desiredBySeason[
    season
  ] =
    await resolveSeasonTracks(
      accessToken,
      season
    );

  console.log(
    `${season}: ${
      desiredBySeason[
        season
      ].length
    } Spotify track(s) resolved from current RSS`
  );
}


/* =========================================================
   SYNC
   ========================================================= */

let totalCreated =
  0;

let totalSynced =
  0;

let totalRemoved =
  0;

let totalTracks =
  0;

let configChanged =
  false;


for (
  const season of seasons
) {
  const originalEntry =
    config[season];

  const entry =
    originalEntry &&
    typeo
