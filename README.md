# AniPlaylist → RSS

A GitHub Actions + Playwright RSS generator for AniPlaylist seasonal anime music.

It creates one static RSS feed per configured season. The feed includes **every AniPlaylist type that appears in that season**, provided the entry has a Spotify track/album link.

Examples of AniPlaylist types include:

- Opening / Ending
- Insert
- OST
- Character Song
- Theme Song
- Vocal Album
- Image Song / Image Album
- Music Video
- PV Song
- Other

The parser is not limited to this list: it also accepts short ALL-CAPS type markers shown by AniPlaylist, so a newly introduced type can be captured without changing the scraper first.

## RSS item format

Title:

`[OP] Anime Title — Song Title`

or, for example:

`[IN] Anime Title — Song Title`

`[OST] Anime Title — Album Title`

The RSS `<link>` points directly to Spotify. The description also contains the AniPlaylist page and the expanded type name.

## Setup

1. Create a new GitHub repository.
2. Upload all files from this folder.
3. Enable GitHub Pages:
   - Settings → Pages
   - Source: GitHub Actions
4. Run the `Build RSS` workflow once from Actions → Build RSS → Run workflow.
5. Your feed will be:

`https://YOUR-USERNAME.github.io/YOUR-REPO/rss/fall-2026.xml`

Add that URL to your RSS reader.

## Adding another season

Edit `seasons.json`:

```json
{
  "seasons": [
    "Fall 2026",
    "Winter 2027"
  ]
}
```

Commit the change. The next scheduled workflow run creates:

`rss/winter-2027.xml`

You can then add that URL to your RSS reader.

## How "new" is tracked

The workflow rebuilds the feed every 30 minutes.

`rss-state.json` stores a first-seen timestamp for each item. This means an existing item keeps its original RSS `pubDate` instead of appearing newly published on every rebuild.

Each item also has a stable SHA-256 GUID derived from its AniPlaylist URL, Spotify URL, anime, type and song title, so RSS readers can recognize previously seen entries.

## Spotify-only

Entries that AniPlaylist has not made available on Spotify yet are excluded. They will automatically enter the RSS feed on a later run once a Spotify track/album link becomes available.

## No seedbox required

Everything runs in GitHub Actions and is served as static XML through GitHub Pages.
