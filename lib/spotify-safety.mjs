export function validateSpotifySources(seasons, sources) {
  if (!sources || typeof sources !== "object" || Array.isArray(sources)) {
    throw new Error("spotify-current.json must contain a seasons object.");
  }

  const refsBySeason = {};
  for (const season of seasons) {
    const source = sources[season];
    if (
      !source ||
      typeof source !== "object" ||
      Array.isArray(source) ||
      source.complete !== true ||
      !Number.isSafeInteger(source.resultCount) ||
      source.resultCount < 0 ||
      !Array.isArray(source.refs)
    ) {
      throw new Error(
        "spotify-current.json: " + season +
          " is missing a validated, complete scrape record. No Spotify changes were made."
      );
    }

    for (const [index, ref] of source.refs.entries()) {
      const type = String(ref?.type || "").toLowerCase();
      const id = String(ref?.id || "").trim();
      if (
        !ref || typeof ref !== "object" || Array.isArray(ref) ||
        !["track", "album"].includes(type) || !/^[A-Za-z0-9]{1,128}$/.test(id)
      ) {
        throw new Error(
          "spotify-current.json: " + season + " has an invalid reference #" +
            (index + 1) + ". No Spotify changes were made."
        );
      }
    }

    if (source.refs.length > source.resultCount) {
      throw new Error(
        "spotify-current.json: " + season +
          " contains more Spotify references than captured AniPlaylist records. No Spotify changes were made."
      );
    }

    refsBySeason[season] = source.refs;
  }

  return refsBySeason;
}

