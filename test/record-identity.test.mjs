import test from "node:test";
import assert from "node:assert/strict";
import {
  findHistoricalRecord,
  isValidAniPlaylistDetailUrl,
  recordKeyFor,
} from "../lib/record-identity.mjs";

const season = "Fall 2026";

function record(overrides = {}) {
  return {
    id: "100",
    season,
    kind: "ED",
    song: "ROAD TO BE BLUE",
    anime: "Diamond no Ace: Act II Second Season Part 2",
    artist: "OxT",
    detailUrl: "https://aniplaylist.com/play/diamond-no-ace-ending",
    titleCandidates: ["ROAD TO BE BLUE"],
    animeCandidates: ["Diamond no Ace: Act II Second Season Part 2"],
    artistCandidates: ["OxT"],
    firstSeen: "2026-10-10T17:00:00.000Z",
    ...overrides,
  };
}

test("rejects generic hidden URLs as song identities", () => {
  assert.equal(isValidAniPlaylistDetailUrl("https://aniplaylist.com/hidden"), false);
  assert.equal(isValidAniPlaylistDetailUrl("https://aniplaylist.com/"), false);
  assert.equal(isValidAniPlaylistDetailUrl("https://example.com/play/a-song"), false);
  assert.equal(isValidAniPlaylistDetailUrl("javascript:alert(1)"), false);
  assert.equal(isValidAniPlaylistDetailUrl("https://aniplaylist.com/play/a-song"), true);
  assert.equal(isValidAniPlaylistDetailUrl("https://www.aniplaylist.com/play/a-song/"), true);
});

test("does not match unrelated tracks using polluted historical candidate arrays", () => {
  const current = record({
    id: "200",
    song: "Firestarter",
    anime: "The Vermilion Mask",
    artist: "MAN WITH A MISSION",
    detailUrl: "",
    titleCandidates: ["Firestarter"],
    animeCandidates: ["The Vermilion Mask"],
    artistCandidates: ["MAN WITH A MISSION"],
  });
  const pollutedPrior = record({
    id: "100",
    song: "ROAD TO BE BLUE",
    anime: "Diamond no Ace: Act II Second Season Part 2",
    artist: "OxT",
    detailUrl: "https://aniplaylist.com/hidden",
    // Simulates the bug: aliases from many unrelated tracks were merged here.
    titleCandidates: ["ROAD TO BE BLUE", "Firestarter"],
    animeCandidates: ["Diamond no Ace: Act II Second Season Part 2", "The Vermilion Mask"],
    artistCandidates: ["OxT", "MAN WITH A MISSION"],
  });

  assert.equal(findHistoricalRecord(current, season, { old: pollutedPrior }), null);
});

test("matches the exact source ID without using other tracks' aliases", () => {
  const current = record({
    id: "100",
    song: "ROAD TO BE BLUE",
    anime: "Diamond no Ace: Act II Second Season Part 2",
    artist: "OxT",
    titleCandidates: ["ROAD TO BE BLUE"],
  });
  const historical = record({
    id: "100",
    titleCandidates: ["ROAD TO BE BLUE", "unrelated song"],
    animeCandidates: ["correct anime", "unrelated anime"],
    artistCandidates: ["OxT", "unrelated artist"],
  });

  const match = findHistoricalRecord(current, season, { historical });
  assert.equal(match?.key, "historical");
  assert.equal(match?.match, "id");
  assert.equal(match?.record, historical);
});

test("uses a unique validated detail URL, not /hidden, for migration matching", () => {
  const current = record({ id: "new-id" });
  const exactUrlPrior = record({ id: "legacy-id" });
  const hiddenPrior = record({
    id: "other-id",
    song: "A different song",
    anime: "A different anime",
    artist: "A different artist",
    detailUrl: "https://aniplaylist.com/hidden",
  });

  assert.equal(
    findHistoricalRecord(current, season, { exactUrlPrior, hiddenPrior })?.key,
    "exactUrlPrior"
  );

  const noValidUrl = record({ ...current, detailUrl: "https://aniplaylist.com/hidden" });
  assert.equal(
    findHistoricalRecord(noValidUrl, season, { hiddenPrior }),
    null
  );
});

test("numeric source IDs always generate distinct deterministic record keys", () => {
  const a = record({ id: "28064" });
  const b = record({ id: "28067" });
  const keyA = recordKeyFor({ season, item: a, priorKey: "ea8139001be33b74" });
  const keyB = recordKeyFor({ season, item: b, priorKey: "ea8139001be33b74" });

  assert.notEqual(keyA, keyB);
  assert.equal(keyA, recordKeyFor({ season, item: a }));
});
