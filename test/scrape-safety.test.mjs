import test from "node:test";
import assert from "node:assert/strict";
import {
  assertCompleteScrape,
  buildSpotifyReferences,
  cdataSafe,
} from "../lib/scrape-safety.mjs";
import { validateSpotifySources } from "../lib/spotify-safety.mjs";

const completeSeason = {
  season: "Winter 2027",
  pageLoaded: true,
  errors: [],
  hitArrays: [
    { hitsPerPage: 16, nbHits: 13, nbPages: 1, page: 0 },
  ],
  uniqueHits: 13,
  normalized: 13,
  resultCount: 13,
};

test("accepts complete populated and explicitly empty seasons", () => {
  assert.deepEqual(assertCompleteScrape(completeSeason), {
    expectedHits: 13,
    expectedPages: 1,
    receivedPages: 1,
  });

  assert.deepEqual(assertCompleteScrape({
    ...completeSeason,
    resultCount: null,
    uniqueHits: 0,
    normalized: 0,
    hitArrays: [{ hitsPerPage: 16, nbHits: 0, nbPages: 0, page: 0 }],
  }), {
    expectedHits: 0,
    expectedPages: 0,
    receivedPages: 0,
  });
});

test("rejects failed navigation, missing metadata, and partial pagination", () => {
  assert.throws(() => assertCompleteScrape({
    ...completeSeason,
    pageLoaded: false,
  }), /page load failed/);
  assert.throws(() => assertCompleteScrape({
    ...completeSeason,
    hitArrays: [],
  }), /no valid paginated search response/);
  assert.throws(() => assertCompleteScrape({
    ...completeSeason,
    hitArrays: [
      { hitsPerPage: 16, nbHits: 13, nbPages: 0, page: 0 },
    ],
  }), /only 0 pages/);
  assert.throws(() => assertCompleteScrape({
    ...completeSeason,
    uniqueHits: 12,
  }), /incomplete pagination/);
  assert.throws(() => assertCompleteScrape({
    ...completeSeason,
    hitArrays: [
      { hitsPerPage: 16, nbHits: 32, nbPages: 2, page: 0 },
    ],
    uniqueHits: 32,
  }), /search page 2 of 2 was not captured/);
  assert.throws(() => assertCompleteScrape({
    ...completeSeason,
    normalized: 12,
  }), /could normalize 12 of 13/);
});

test("builds ordered Spotify track and album references without duplicate IDs", () => {
  assert.deepEqual(buildSpotifyReferences([
    {
      spotify: "https://open.spotify.com/track/abc123",
      song: "First",
    },
    {
      spotify: "https://open.spotify.com/intl-ja/track/abc123",
      song: "Duplicate",
    },
    {
      spotify: "https://open.spotify.com/album/album123",
      song: "Album song",
    },
    {
      spotify: "https://open.spotify.com/album/album123",
      song: "Another song from the same album",
    },
  ]).map(({ type, id, song }) => ({ type, id, song })), [
    { type: "track", id: "abc123", song: "First" },
    { type: "album", id: "album123", song: "Album song" },
    { type: "album", id: "album123", song: "Another song from the same album" },
  ]);
});

test("splits CDATA terminators without changing description text", () => {
  assert.equal(cdataSafe("A ]] > B"), "A ]] > B");
  assert.equal(cdataSafe("A ]]> B"), "A ]]]]><![CDATA[> B");
});

test("requires complete Spotify source metadata before playlist synchronization", () => {
  const sources = {
    "Winter 2027": {
      complete: true,
      resultCount: 13,
      refs: [{ type: "track", id: "track123" }],
    },
    "Spring 2027": {
      complete: true,
      resultCount: 0,
      refs: [],
    },
  };

  assert.deepEqual(validateSpotifySources(
    ["Winter 2027", "Spring 2027"],
    sources
  ), {
    "Winter 2027": sources["Winter 2027"].refs,
    "Spring 2027": [],
  });
  assert.throws(() => validateSpotifySources(
    ["Winter 2027"],
    { "Winter 2027": [] }
  ), /complete scrape record/);
  assert.throws(() => validateSpotifySources(
    ["Winter 2027"],
    { "Winter 2027": { complete: true, resultCount: 0, refs: [{ type: "track", id: "abc" }] } }
  ), /more Spotify references than captured/);
  assert.throws(() => validateSpotifySources(
    ["Winter 2027"],
    { "Winter 2027": { complete: true, resultCount: 1, refs: ["abc"] } }
  ), /invalid reference/);
});

