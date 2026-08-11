# DuplexWorld

Project page for *DuplexWorld: Can voice agents help you get through the day?*

A scroll flight over the benchmark: six worlds of an ordinary day, eleven conversation
types, and one twelve-metric suite in three pillars, across 3,825 scored conversations and
387 hours of simulated speech.

Live: https://harshitcentific.github.io/duplex-world/

## Looking at it locally

    python3 serve.py 8080      then open http://127.0.0.1:8080/

Do NOT use `python3 -m http.server`. It ignores HTTP Range, so the browser treats the film
as unseekable and the page shows a frozen first frame with no error. Any real static host
(GitHub Pages, S3, Netlify, Cloudflare Pages) answers Range.

## What is in here

| Path | What it is |
|---|---|
| `index.html` | the page, with its config inline |
| `flight.js` · `world.css` · `alt-split.css` · `map.css` | the scroll-flight engine and its styles |
| `walkmap.js` · `geo_*.json` | the live walk renderer and the six recorded Pathfinding walks |
| `bank_*.json` | three recorded enterprise calls, replayed as transcript excerpts |
| `flight.mp4` | the film the left half scrubs through |
| `img/` | world art, vendor marks and the figures lifted from the submission |

The page is self-contained: no build step, no CDN, no external font or stylesheet, and no
outbound request of any kind. Every number on it comes from the submission and nowhere else.
