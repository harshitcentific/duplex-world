#!/usr/bin/env python3
"""Static server for the Duplex World demo page.

Deliberately NOT `python -m http.server`. That one is single-threaded with a listen backlog of 5,
so a browser that opens several parallel sockets (Chrome preconnects and then leaves them idle)
can occupy the accept queue and wedge the server. The page then hangs on load and looks dead while
the process is still running and still answers a lone curl. ThreadingHTTPServer takes each
connection on its own thread, so that cannot happen.

Also: no caching, so editing walkmap.js and reloading actually shows the edit.
"""
import functools
import http.server
import os
import socket
import socketserver
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8920
ROOT = os.path.dirname(os.path.abspath(__file__))


class Handler(http.server.SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"          # keep-alive, so the payload fetches reuse a socket

    def send_head(self):
        """Serve byte ranges as well as whole files.

        SimpleHTTPRequestHandler ignores Range entirely and always answers 200 with the
        whole body. A browser reads that as "not seekable": video.seekable collapses to
        [0,0] and every currentTime write is silently discarded, so a scroll-scrubbed
        video sits frozen on frame 0 with no error anywhere. The page is fine; the server
        is the thing that has to answer 206.
        """
        rng = self.headers.get("Range")
        if not rng or not rng.startswith("bytes="):
            return super().send_head()

        path = self.translate_path(self.path)
        if os.path.isdir(path):
            return super().send_head()
        try:
            f = open(path, "rb")
        except OSError:
            self.send_error(404, "File not found")
            return None

        size = os.fstat(f.fileno()).st_size
        first, _, lastspec = rng[6:].partition("-")
        try:
            if first:
                start = int(first)
                end = int(lastspec) if lastspec else size - 1
            else:
                # A suffix range ("bytes=-500") counts back from the end.
                start, end = max(0, size - int(lastspec)), size - 1
        except ValueError:
            f.close()
            self.send_error(400, "Bad Range")
            return None

        if start >= size:
            f.close()
            self.send_response(416)
            self.send_header("Content-Range", f"bytes */{size}")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return None

        end = min(end, size - 1)
        f.seek(start)
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Accept-Ranges", "bytes")
        self.end_headers()
        return _Slice(f, end - start + 1)

    def end_headers(self):
        # no-store everywhere EXCEPT media. A 24 MB video re-downloads on every reload
        # otherwise, and over a real link a scroll-scrub issues a fresh range request per
        # seek that cancels the last one: measured, only 34 of 89.5 seconds ever arrived.
        media = self.path.rsplit("?", 1)[0].lower().endswith((".mp4", ".webm", ".m4v"))
        self.send_header("Cache-Control", "public, max-age=600" if media else "no-store")
        # Announced on every response, not just 206: the browser checks this before it
        # will treat a media file as seekable at all.
        self.send_header("Accept-Ranges", "bytes")
        super().end_headers()

    def log_message(self, fmt, *args):     # one line per request, no address lookup stalls
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))


class _Slice:
    """A read-only window onto an open file, so copyfile() stops at the range end."""

    def __init__(self, fh, remaining):
        self.fh = fh
        self.remaining = remaining

    def read(self, n=-1):
        if self.remaining <= 0:
            return b""
        if n is None or n < 0:
            n = self.remaining
        chunk = self.fh.read(min(n, self.remaining))
        self.remaining -= len(chunk)
        return chunk

    def close(self):
        self.fh.close()


class Server(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True
    request_queue_size = 64


if __name__ == "__main__":
    Server.address_family = socket.AF_INET
    with Server(("0.0.0.0", PORT), functools.partial(Handler, directory=ROOT)) as httpd:
        print(f"duplexworld  http://127.0.0.1:{PORT}/                    the page", flush=True)
        print(f"             http://127.0.0.1:{PORT}/duplexworld.html    the single-file export",
              flush=True)
        print(f"             root {ROOT}", flush=True)
        httpd.serve_forever()
