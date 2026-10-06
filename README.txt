ANIPlayList RSS + Spotify Fix

Replace these two files in the repository:

1. spotify.mjs
   Repository root; replace the existing spotify.mjs.

2. .github/workflows/build-rss.yml
   Replace the existing workflow file.

Do NOT upload:
- apply-scrape-spotify-fix.mjs
- scrape-spotify-source-fix.txt
- spotify-current.json

Do NOT modify scrape.mjs manually.

Then run:
GitHub -> Actions -> Build RSS -> Run workflow

The new workflow automatically applies the required scrape.mjs Spotify-source
change to the temporary GitHub Actions runner copy before building RSS. Your
repository's scrape.mjs is not changed or committed.
