export function assertCompleteScrape({
  season,
  pageLoaded,
  errors = [],
  hitArrays = [],
  uniqueHits = 0,
  normalized = 0,
  resultCount = null,
}) {
  if (!pageLoaded || errors.length) {
    throw new Error(
      `${season}: AniPlaylist page load failed: ${errors.join("; ") || "navigation did not complete"}`
    );
  }

  const searchResponses = hitArrays.filter(response =>
    Number.isFinite(response?.hitsPerPage) &&
    response.hitsPerPage > 0 &&
    Number.isSafeInteger(response?.nbHits) &&
    response.nbHits >= 0 &&
    Number.isSafeInteger(response?.nbPages) &&
    response.nbPages >= 0
  );

  if (!searchResponses.length) {
    throw new Error(`${season}: no valid paginated search response was captured.`);
  }

  const expectedHits = Math.max(...searchResponses.map(response => response.nbHits));
  const matchingResponses = searchResponses.filter(response => response.nbHits === expectedHits);
  const expectedPages = Math.max(...matchingResponses.map(response => response.nbPages));
  const maxHitsPerPage = Math.max(...matchingResponses.map(response => response.hitsPerPage));
  const receivedPages = new Set(
    matchingResponses
      .map(response => response.page)
      .filter(Number.isSafeInteger)
  );

  if (Number.isFinite(resultCount) && resultCount > expectedHits) {
    throw new Error(
      `${season}: page reports ${resultCount} results but the search API reports only ${expectedHits}.`
    );
  }

  if (uniqueHits < expectedHits) {
    throw new Error(
      `${season}: incomplete pagination; received ${uniqueHits} unique hits out of ${expectedHits}.`
    );
  }

  if (expectedHits > 0 && expectedPages < Math.ceil(expectedHits / maxHitsPerPage)) {
    throw new Error(
      `${season}: search metadata advertises ${expectedHits} results across only ${expectedPages} pages.`
    );
  }

  const missingPage = Array.from(
    { length: expectedPages },
    (_, page) => page
  ).find(page => !receivedPages.has(page));
  if (missingPage !== undefined) {
    throw new Error(
      `${season}: incomplete pagination; search page ${missingPage + 1} of ${expectedPages} was not captured.`
    );
  }

  if (normalized !== uniqueHits) {
    throw new Error(
      `${season}: could normalize ${normalized} of ${uniqueHits} unique search hits.`
    );
  }

  return {
    expectedHits,
    expectedPages,
    receivedPages: expectedHits === 0 ? 0 : receivedPages.size,
  };
}

export function buildSpotifyReferences(items) {
  const references = new Map();

  for (const item of items) {
    const url = String(item.spotify || "");
    const match = url.match(
      /https?:\/\/open\.spotify\.com\/(?:intl-[^/]+\/)?(track|album)\/([A-Za-z0-9]+)/i
    );
    if (!match) continue;

    const type = match[1].toLowerCase();
    const id = match[2];
    const key = type === "track"
      ? `${type}:${id}`
      : [type, id, item.song || "", item.artist || ""].join(":");
    if (!references.has(key)) {
      references.set(key, {
        type,
        id,
        url,
        anime: item.anime || "",
        song: item.song || "",
        artist: item.artist || "",
        kind: item.kind || "",
        aniPlaylistId: item.id || "",
        firstSeen: item.firstSeen || item.pubDate || "",
      });
    }
  }

  return [...references.values()];
}

export function cdataSafe(value) {
  return String(value ?? "").replace(/\]\]>/g, "]]]]><![CDATA[>");
}

