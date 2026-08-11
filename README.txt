Duplex World project page.

Upload the contents of this folder to any static host that answers HTTP Range
requests (GitHub Pages, S3, Netlify, Cloudflare Pages all do). index.html is the
page; everything beside it is referenced relatively, so the folder can sit at a
site root or in a subdirectory.

To look at it locally:

    python3 serve.py 8080      then open http://127.0.0.1:8080/

Do NOT use `python3 -m http.server`: it ignores Range, so the browser treats the
film as unseekable and the page shows a frozen first frame with no error.
