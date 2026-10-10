import crypto from "node:crypto";

const clean = value => String(value ?? "").replace(/\s+/g, " ").trim();

export function isValidAniPlaylistDetailUrl(value) {
  if (typeof value !== "string" || !value.trim()) return false;

  try {
    const url = new URL(value.trim());
    if (!["https:", "http:"].includes(url.protocol)) return false;
    if (!["aniplaylist.com", "www.aniplaylist.com"].includes(url.hostname.toLowerCase())) {
      return false;
    }

    // /hidden is a generic/obfuscated placeholder, not a unique song identity.
    // Accept real source slugs without assuming a specific character set.
    const match = url.pathname.match(/^\/play\/([^/]+)\/?$/i);
    if (!match) return false;
    let slug;
    try {
      slug = decodeURIComponent(match[1]).trim().toLocaleLowerCase();
    } catch {
      return false;
    }
    return !!slug && !["hidden", "unknown", "undefined", "null"].includes(slug);
  } catch {
    return false;
  }
}

function identityText(value) {
  return clean(value)
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "");
}

function episodeSet(value) {
  const entries = Array.isArray(value) ? value : value == null ? [] : [value];
  return new Set(entries.map(entry => {
    if (entry && typeof entry === "object") {
      return identityText(
        entry.episode ?? entry.episode_number ?? entry.number ?? entry.name ?? entry.title ?? entry.value ?? ""
      );
    }
    return identityText(entry);
  }).filter(Boolean));
}

function episodesConflict(a, b) {
  const left = episodeSet(a);
  const right = episodeSet(b);
  if (!left.size || !right.size) return false;
  for (const episode of left) {
    if (right.has(episode)) return false;
  }
  return true;
}

function sameSeason(record, season) {
  return record && String(record.season ?? "") === String(season);
}

function directIdentityMatches(item, record) {
  const song = identityText(item.song);
  const anime = identityText(item.anime);
  const artist = identityText(item.artist);
  if (!song || !anime || !artist) return false;

  return identityText(record.song) === song
    && identityText(record.anime) === anime
    && identityText(record.artist) === artist
    && clean(record.kind).toUpperCase() === clean(item.kind).toUpperCase()
    && !episodesConflict(item.episodes, record.episodes);
}

function firstSeenMillis(record) {
  const value = Date.parse(record?.firstSeen || "");
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

function chooseBestEntry(entries, item) {
  return entries.slice().sort((a, b) => {
    const score = entry => {
      const record = entry[1];
      let value = 0;
      if (identityText(record.song) === identityText(item.song)) value += 1;
      if (identityText(record.anime) === identityText(item.anime)) value += 1;
      if (identityText(record.artist) === identityText(item.artist)) value += 1;
      if (isValidAniPlaylistDetailUrl(item.detailUrl)
          && isValidAniPlaylistDetailUrl(record.detailUrl)
          && record.detailUrl === item.detailUrl) value += 4;
      return value;
    };
    return score(b) - score(a)
      || firstSeenMillis(a[1]) - firstSeenMillis(b[1])
      || a[0].localeCompare(b[0]);
  })[0] || null;
}

/**
 * Match exactly one safe historical record.
 *
 * Historical translation candidate arrays are deliberately ignored: previous
 * builds may contain corrupted aliases, so candidates must never be identity
 * evidence. Match by source ID, a validated unique /play/<slug> URL, or the
 * exact song + anime + artist + kind tuple.
 */
export function findHistoricalRecord(item, season, state) {
  const entries = Object.entries(state || {}).filter(([, record]) =>
    sameSeason(record, season)
  );

  const itemId = clean(item.id);
  if (itemId) {
    const byId = entries.filter(([, record]) => clean(record.id) === itemId);
    const found = chooseBestEntry(byId, item);
    if (found) return { key: found[0], record: found[1], match: "id" };
  }

  const detailUrl = isValidAniPlaylistDetailUrl(item.detailUrl) ? item.detailUrl : "";
  if (detailUrl) {
    const byDetailUrl = entries.filter(([, record]) =>
      isValidAniPlaylistDetailUrl(record.detailUrl)
      && record.detailUrl === detailUrl
    );
    const found = chooseBestEntry(byDetailUrl, item);
    if (found) return { key: found[0], record: found[1], match: "detail-url" };
  }

  const byDirectIdentity = entries.filter(([, record]) => directIdentityMatches(item, record));
  const found = chooseBestEntry(byDirectIdentity, item);
  if (found) return { key: found[0], record: found[1], match: "direct-identity" };

  return null;
}

export function recordKeyFor({ season, item, priorKey = null }) {
  const id = clean(item?.id);

  // Numeric AniPlaylist IDs are stable source identities. Always derive their
  // key from the ID instead of reusing a possibly collided historical key.
  if (/^\d+$/.test(id)) {
    return crypto.createHash("sha1")
      .update([season, "id", id].join("|"))
      .digest("hex")
      .slice(0, 16);
  }

  if (priorKey) return priorKey;

  return crypto.createHash("sha1")
    .update([
      season,
      id,
      clean(item?.anime),
      clean(item?.kind),
      clean(item?.song),
      clean(item?.artist),
    ].join("|"))
    .digest("hex")
    .slice(0, 16);
}
