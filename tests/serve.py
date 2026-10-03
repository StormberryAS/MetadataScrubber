#!/usr/bin/env python3
"""A local stand-in for https://metadata.stormberry.as, for browser tests.

It serves this repository the way production does, as far as a page can tell:

  * every response, 404s included, carries the exact Content-Security-Policy header that
    Cloudflare adds on the stormberry.as zone, plus the other security headers the zone
    sends (HSTS, nosniff, frame and opener policies, referrer and permissions policies);
  * the Cloudflare "Speed Brain" speculation-rules header is sent, and
    /cdn-cgi/speculation answers with the same rules Cloudflare serves, so the browser
    behaves as it does on the live site;
  * only what GitHub Pages would publish is served: paths listed under `exclude:` in
    _config.yml, and anything whose name starts with a dot or an underscore, give 404;
  * cache lifetimes match the live site (HTML 600 s, everything else 14,400 s);
  * .js and .mjs are text/javascript, .css text/css, .svg image/svg+xml, .woff2
    font/woff2, .md text/markdown, all with charset where it applies.

It binds to 127.0.0.1 on a free port (or --port) and prints one line when ready:

    READY http://127.0.0.1:PORT/
    READY https://127.0.0.1:PORT/ spki=BASE64     (with --tls)

With --tls it makes a throwaway self-signed certificate for metadata.stormberry.as with
openssl and serves HTTPS, so a browser can load the page under its real name and scheme
(map the name to this port and trust the printed SPKI hash; tests/e2e.mjs does this).

One JSON line per request goes to stderr, or to --log FILE. Only GET and HEAD are served.

    python3 tests/serve.py [--port N] [--tls] [--log FILE] [--quiet]

Standard library only. It never writes inside the repository.
"""

import argparse
import base64
import email.utils
import hashlib
import http.server
import json
import os
import pathlib
import shutil
import signal
import ssl
import subprocess
import sys
import tempfile
import time
import urllib.parse

ROOT = pathlib.Path(__file__).resolve().parent.parent
HOST_NAME = "metadata.stormberry.as"

# Verbatim from the zone (checked against a live Labs host on 2026-10-01).
ZONE_CSP = (
    "default-src 'self'; script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com; "
    "style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; "
    "connect-src 'self' https://stormberry-contact-form.marcos-495.workers.dev; "
    "frame-src https://challenges.cloudflare.com; frame-ancestors 'none'; base-uri 'self'; "
    "form-action 'self' https://stormberry-contact-form.marcos-495.workers.dev; object-src 'none'; "
    "upgrade-insecure-requests"
)

ZONE_HEADERS = [
    ("Content-Security-Policy", ZONE_CSP),
    ("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload"),
    ("X-Content-Type-Options", "nosniff"),
    ("X-Frame-Options", "DENY"),
    ("X-XSS-Protection", "0"),
    ("Referrer-Policy", "same-origin"),
    ("Cross-Origin-Opener-Policy", "same-origin"),
    ("Access-Control-Allow-Origin", "*"),
    ("Permissions-Policy",
     "geolocation=(), microphone=(), camera=(), payment=(), usb=(), serial=(), bluetooth=(), "
     "accelerometer=(), gyroscope=(), magnetometer=(), interest-cohort=(), browsing-topics=(), "
     "join-ad-interest-group=(), run-ad-auction=(), private-state-token-redemption=(), "
     "private-state-token-issuance=(), attribution-reporting=()"),
    ("Speculation-Rules", '"/cdn-cgi/speculation"'),
]

SPECULATION_PATH = "/cdn-cgi/speculation"
SPECULATION_BODY = (
    b'{"tag":"cf-speed-brain","prefetch":[{"eagerness":"conservative","source":"document",'
    b'"where":{"and":[{"href_matches":"/*","relative_to":"document"}]}}]}'
)

TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".md": "text/markdown; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".xml": "application/xml",
}

NOT_FOUND = b"<!DOCTYPE html><html lang=\"en\"><title>404</title><p>File not found.</p></html>\n"


def jekyll_excludes():
    """The `exclude:` list of _config.yml, as plain names. A tiny reader for this one shape."""
    cfg = ROOT / "_config.yml"
    out = []
    if not cfg.is_file():
        return out
    inside = False
    for raw in cfg.read_text(encoding="utf-8").splitlines():
        line = raw.split("#", 1)[0].rstrip()
        if not line:
            continue
        if not raw.startswith((" ", "-", "\t")):
            inside = line.strip() == "exclude:"
            continue
        if inside and line.strip().startswith("- "):
            out.append(line.strip()[2:].strip().strip("'\"").rstrip("/"))
    return out


EXCLUDES = jekyll_excludes()


def published(rel: pathlib.PurePosixPath) -> bool:
    """Whether GitHub Pages (Jekyll) would publish this repository path."""
    parts = rel.parts
    if any(p.startswith((".", "_", "#")) or p.endswith("~") for p in parts):
        return False
    text = rel.as_posix()
    for ex in EXCLUDES:
        if text == ex or text.startswith(ex + "/"):
            return False
    return True


class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "stormberry-local"
    sys_version = ""
    protocol_version = "HTTP/1.1"
    log_file = None
    quiet = False

    def log_message(self, fmt, *args):  # replaced by log_json
        pass

    def log_json(self, status, path, size):
        if self.quiet:
            return
        line = json.dumps({
            "t": round(time.time(), 3), "method": self.command, "path": path,
            "host": self.headers.get("Host", ""), "status": status, "bytes": size,
            "fetch_dest": self.headers.get("Sec-Fetch-Dest", ""),
            "purpose": self.headers.get("Sec-Purpose", "") or self.headers.get("Purpose", ""),
        })
        out = self.log_file or sys.stderr
        out.write(line + "\n")
        out.flush()

    def send_body(self, status, ctype, body, cache, path, extra=()):
        self.send_response(status)
        for k, v in ZONE_HEADERS:
            self.send_header(k, v)
        for k, v in extra:
            self.send_header(k, v)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self.send_header("Expires", email.utils.formatdate(time.time() + int(cache.split("=")[1]), usegmt=True)
                         if cache.startswith("max-age=") else "0")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)
        self.log_json(status, path, len(body))

    def not_found(self, path):
        self.send_body(404, "text/html; charset=utf-8", NOT_FOUND, "max-age=600", path)

    def do_GET(self):
        raw_path = urllib.parse.urlsplit(self.path).path
        path = urllib.parse.unquote(raw_path)
        if path == SPECULATION_PATH:
            extra = [("Vary", "Origin")]
            self.send_body(200, "application/speculationrules+json", SPECULATION_BODY, "max-age=600", path, extra)
            return
        if "\x00" in path or not path.startswith("/"):
            self.not_found(path)
            return
        rel = pathlib.PurePosixPath(path.lstrip("/"))
        if any(p == ".." for p in rel.parts):
            self.not_found(path)
            return
        target = (ROOT / rel).resolve() if rel.parts else ROOT
        try:
            target.relative_to(ROOT)
        except ValueError:
            self.not_found(path)
            return
        if target.is_dir():
            if not path.endswith("/"):
                # GitHub Pages redirects a folder without its slash.
                self.send_response(301)
                for k, v in ZONE_HEADERS:
                    self.send_header(k, v)
                self.send_header("Location", raw_path + "/")
                self.send_header("Content-Length", "0")
                self.end_headers()
                self.log_json(301, path, 0)
                return
            target = target / "index.html"
            rel = rel / "index.html"
        if not target.is_file() or not published(pathlib.PurePosixPath(target.relative_to(ROOT).as_posix())):
            self.not_found(path)
            return
        body = target.read_bytes()
        ext = target.suffix.lower()
        ctype = TYPES.get(ext, "application/octet-stream")
        cache = "max-age=600" if ext == ".html" else "max-age=14400"
        etag = '"%s"' % hashlib.sha256(body).hexdigest()[:16]
        extra = [("ETag", etag), ("Last-Modified", email.utils.formatdate(target.stat().st_mtime, usegmt=True))]
        if self.headers.get("If-None-Match") == etag:
            self.send_response(304)
            for k, v in ZONE_HEADERS:
                self.send_header(k, v)
            self.send_header("ETag", etag)
            self.send_header("Content-Length", "0")
            self.end_headers()
            self.log_json(304, path, 0)
            return
        self.send_body(200, ctype, body, cache, path, extra)

    do_HEAD = do_GET

    def refuse(self):
        self.send_body(405, "text/plain; charset=utf-8", b"Method not allowed\n", "max-age=0",
                       urllib.parse.urlsplit(self.path).path, [("Allow", "GET, HEAD")])

    do_POST = do_PUT = do_DELETE = do_PATCH = do_OPTIONS = refuse


def make_certificate(folder: str):
    """A throwaway self-signed certificate for HOST_NAME and 127.0.0.1. Returns (cert, key, spki)."""
    if not shutil.which("openssl"):
        sys.exit("serve.py: --tls needs openssl")
    cert = os.path.join(folder, "cert.pem")
    key = os.path.join(folder, "key.pem")
    subprocess.run([
        "openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
        "-nodes", "-keyout", key, "-out", cert, "-days", "2", "-subj", "/CN=" + HOST_NAME,
        "-addext", "subjectAltName=DNS:%s,IP:127.0.0.1" % HOST_NAME,
    ], check=True, capture_output=True)
    pub = subprocess.run(["openssl", "x509", "-in", cert, "-pubkey", "-noout"], check=True, capture_output=True).stdout
    der = subprocess.run(["openssl", "pkey", "-pubin", "-outform", "der"], input=pub, check=True, capture_output=True).stdout
    spki = base64.b64encode(hashlib.sha256(der).digest()).decode()
    return cert, key, spki


def main():
    ap = argparse.ArgumentParser(description="Serve MetadataScrubber locally with the production headers.")
    ap.add_argument("--port", type=int, default=0, help="port on 127.0.0.1 (default: a free one)")
    ap.add_argument("--tls", action="store_true", help="serve HTTPS with a throwaway certificate")
    ap.add_argument("--log", help="write the request log here instead of stderr")
    ap.add_argument("--quiet", action="store_true", help="no request log")
    args = ap.parse_args()

    Handler.quiet = args.quiet
    if args.log:
        Handler.log_file = open(args.log, "a", encoding="utf-8")
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    httpd.daemon_threads = True
    scheme = "http"
    spki = None
    tmp = None
    if args.tls:
        tmp = tempfile.mkdtemp(prefix="ms-serve-tls-")
        cert, key, spki = make_certificate(tmp)
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(cert, key)
        httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
        scheme = "https"
    # A plain kill must still remove the throwaway certificate.
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    port = httpd.server_address[1]
    print("READY %s://127.0.0.1:%d/%s" % (scheme, port, " spki=" + spki if spki else ""), flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
        if tmp:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
