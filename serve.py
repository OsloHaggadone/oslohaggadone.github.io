"""Shows the site on this computer the way GitHub Pages publishes it (.github/workflows/pages.yml):
this folder at http://localhost:8080/, and Synopsist's website (Synopsist/player/) at /Synopsist/, so
the links between the two work here too. Run it in this folder: python3 serve.py (Ctrl+C stops it).
"""

import http.server
import os
import re
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
SYNOPSIST = os.path.join(ROOT, "Synopsist")
PLAYER = os.path.join(SYNOPSIST, "player")
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8080


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def translate_path(self, path):
        # /Synopsist/… comes from Synopsist/player/, as online; everything else from this folder
        local = super().translate_path(path)
        if local == SYNOPSIST or local.startswith(SYNOPSIST + os.sep):
            return PLAYER + local[len(SYNOPSIST):]
        return local

    def end_headers(self):
        self.send_header("Accept-Ranges", "bytes")  # so the browser can seek in a song, as online
        self.send_header("Cache-Control", "no-cache")  # so a reload always shows the latest edit
        super().end_headers()

    def send_head(self):
        # part of a file (a byte range), which the browser asks for when seeking in a song
        self.part = None
        match = re.fullmatch(r"bytes=(\d*)-(\d*)", self.headers.get("Range", "").strip())
        path = self.translate_path(self.path)
        if not match or match[1] == match[2] == "" or not os.path.isfile(path):
            return super().send_head()
        size = os.path.getsize(path)
        if match[1]:
            start, end = int(match[1]), min(int(match[2] or size - 1), size - 1)
        else:  # the last n bytes
            start, end = max(0, size - int(match[2])), size - 1
        if start > end:
            self.send_response(416)
            self.send_header("Content-Range", f"bytes */{size}")
            self.end_headers()
            return None
        file = open(path, "rb")
        file.seek(start)
        self.part = end - start + 1
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(self.part))
        self.end_headers()
        return file

    def copyfile(self, source, outputfile):
        if self.part is None:
            return super().copyfile(source, outputfile)
        left = self.part
        while left > 0 and (chunk := source.read(min(64 * 1024, left))):
            outputfile.write(chunk)
            left -= len(chunk)

    def send_error(self, code, message=None, explain=None):
        # a missing page gets the site's own "Page not found", as online
        page = os.path.join(ROOT, "404.html")
        if code != 404 or not os.path.isfile(page):
            return super().send_error(code, message, explain)
        with open(page, "rb") as file:
            body = file.read()
        self.send_response(404)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)


if __name__ == "__main__":
    print(f"The site: http://localhost:{PORT}/ (Synopsist at http://localhost:{PORT}/Synopsist/). Ctrl+C stops it.")
    try:
        http.server.ThreadingHTTPServer(("", PORT), Handler).serve_forever()
    except KeyboardInterrupt:
        pass
