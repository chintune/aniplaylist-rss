# 🎵 AniPlaylist RSS

<p align="center">
  <a href="https://chintune.github.io/aniplaylist-rss/">
    <img src="https://raw.githubusercontent.com/chintune/aniplaylist-rss/main/site/favicon.svg" alt="AniPlaylist" width="88">
  </a>
</p>

<h1 align="center">AniPlaylist RSS</h1>

<p align="center"><strong>Anime music releases, organized by season with RSS, Spotify, Apple Music, and verified AnimeThemes video links.</strong></p>

<p align="center">
  <a href="https://chintune.github.io/aniplaylist-rss/"><strong>🌐 Open AniPlaylist Music Hub</strong></a>
  ·
  <a href="https://github.com/chintune/aniplaylist-rss"><strong>💻 View Source</strong></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Updates-Every%2030%20minutes-7c5cff?style=for-the-badge" alt="Updates every 30 minutes">
  <img src="https://img.shields.io/badge/Spotify-Playlists-1ed760?style=for-the-badge&logo=spotify&logoColor=white" alt="Spotify playlists">
  <img src="https://img.shields.io/badge/Apple%20Music-Supported-f04487?style=for-the-badge&logo=applemusic&logoColor=white" alt="Apple Music">
  <img src="https://img.shields.io/badge/AnimeThemes-Verified%20Video-8b68ff?style=for-the-badge" alt="AnimeThemes verified video">
</p>

## ✨ What this project does

AniPlaylist RSS turns seasonal anime music listings from [AniPlaylist](https://aniplaylist.com/) into a continuously rebuilt static music hub.

Each season gets its own catalog with:

- Opening, ending, insert, OST, and other anime music entries
- Spotify and Apple Music links when available
- Verified AnimeThemes OP/ED WebM videos when a real matching video exists
- Dedicated release pages
- Seasonal RSS feeds
- Spotify playlists
- Multilingual title display and search
- Release-type and **video-only** filtering
- Pagination instead of an endless catalog

The public site is static and hosted on GitHub Pages. Data collection and enrichment happen during the GitHub Actions build.

## 🌸 Site structure

### Main hub

`https://chintune.github.io/aniplaylist-rss/`

The homepage is a discovery page rather than a duplicate release catalog. It presents the AniPlaylist brand, highlights the current season, and links to other seasons.

### Season catalog

Example:

`https://chintune.github.io/aniplaylist-rss/browse/fall-2026/`

A season page provides:

- Release and platform statistics
- RSS feed and Spotify playlist links
- English / Romaji / 日本語 display
- Search across anime, songs, artists, and title variants
- OP / ED / IN / OST / Other filters
- **Video** filter for only releases with verified AnimeThemes video
- 24 releases per page with numbered pagination
- Direct Spotify / Apple Music actions
- Inline AnimeThemes video playback for verified releases

### Individual release pages

Every release has a permanent URL under:

`/song/<id>/`

These pages provide artwork, metadata, streaming actions, season links, and inline AnimeThemes playback when a verified video is attached.

## 📡 RSS feeds

Each configured season has its own feed under:

`/rss/<season>.xml`

Example:

`https://chintune.github.io/aniplaylist-rss/rss/fall-2026.xml`

RSS items use a deliberately compact format:

**Title**
```text
[OP] Anime Title
```

**Description**
```text
Artist - Song Name
```

**Link**

The link points to the permanent AniPlaylist release page.

This format is designed to stay clean in feed readers, Telegram, and other RSS clients.

## 🎧 Spotify playlists

When Spotify matches are available, a season can have a dedicated playlist. The season catalog exposes the playlist directly, and the homepage can link to the featured season playlist when one exists.

Playlist metadata is maintained in `spotify-playlists.json`.

## 🎬 AnimeThemes integration

The build resolves real AnimeThemes theme videos for OP/ED releases.

The resolver:

1. Loads AnimeThemes season data.
2. Matches the AniPlaylist anime against AnimeThemes titles and synonyms.
3. Matches theme type and song title.
4. Uses artist information as corroborating evidence.
5. Stores only a verified direct AnimeThemes video URL.

A **Watch** action is not shown when a verified video is unavailable.

The generated player uses AnimeThemes-hosted WebM video and also exposes a direct-video fallback link.

## 🔄 Automatic updates

The GitHub Actions workflow runs every 30 minutes and can also be started manually.

The build:

1. Collects seasonal AniPlaylist data.
2. Normalizes titles, artists, types, and links.
3. Resolves Spotify and Apple Music links.
4. Resolves AnimeThemes OP/ED videos.
5. Generates RSS XML.
6. Generates static HTML for the homepage, season pages, and release pages.
7. Publishes the result to GitHub Pages.

No runtime server is required for the public site.

## 🗂️ Repository layout

```text
.
├── scrape.mjs
├── seasons.json
├── spotify-playlists.json
├── spotify-current.json
├── state.json
├── resolve-cache.json
├── rss/
├── site/
│   ├── index.html
│   ├── browse/
│   └── song/
└── .github/
    └── workflows/
        └── build-rss.yml
```

`site/` is generated output. The main source of truth for the pipeline and UI is `scrape.mjs` plus the configuration/state files.

## 🛠️ Local development

Requirements:

- Node.js 22+
- npm
- Playwright / Chromium

Install dependencies:

```bash
npm install
npx playwright install chromium
```

Run the build:

```bash
node scrape.mjs
```

The generated website is written to `site/` and RSS feeds to `rss/`.

## ⚙️ Configuration

Configured seasons are defined in `seasons.json`.

Example:

```json
{
  "seasons": [
    "Fall 2026",
    "Winter 2027",
    "Spring 2027",
    "Summer 2027",
    "Fall 2027"
  ]
}
```

`SITE_BASE` can be overridden during generation when the deployment URL differs from the default GitHub Pages URL.

## 🔐 GitHub Actions and secrets

Spotify playlist synchronization uses repository GitHub Actions secrets/configuration. Keep credentials and refresh tokens in **GitHub Secrets**, not committed source files.

The public site does not need a long-running application server.

## 📌 Important notes

- AniPlaylist is the primary source of seasonal release metadata.
- Spotify and Apple Music links are included only when matching links are found.
- AnimeThemes Watch buttons are shown only for verified OP/ED videos.
- RSS descriptions intentionally use the compact `Artist - Song Name` format.
- The project generates static files; GitHub Pages serves the result.

## 👤 Project

**Maintainer:** [chintune](https://github.com/chintune)

- 🌐 Website: https://chintune.github.io/aniplaylist-rss/
- 💻 GitHub: https://github.com/chintune/aniplaylist-rss