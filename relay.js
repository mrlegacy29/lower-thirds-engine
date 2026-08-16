#!/usr/bin/env node
/* ============================================================================
   Lower Thirds Engine — local relay
   ----------------------------------------------------------------------------
   Sits between the operator console and the OBS Browser Source so the OBS URL
   never changes: the console POSTs config here on "Take", outputs subscribe via
   SSE. Also proxies ProPresenter so the browser never hits a CORS wall.

   Two ways to run:
     1) Standalone (no Electron):   node relay.js
            console:  http://localhost:7777
            OBS:      http://localhost:7777/output
     2) Embedded in the desktop app (Electron main calls start()):
            const relay = require('./relay');
            relay.start({ port: 7777, htmlFile: '/abs/path/to/lt.html' });

   Behaviour is identical in both modes.
   ========================================================================== */

const http = require("http");
const fs   = require("fs");
const path = require("path");
const url  = require("url");

/* Ceiling on a /config POST.
   This was 5,000,000 bytes and it was WRONG — not as a safety valve, but as a product
   decision. A look with a church logo and a background loop embedded as base64 goes past
   5 MB easily, and every Take then answered 413: nothing reached OBS, the output sat blank,
   and the only clue was a red line in the corner of the console. Brandon hit exactly that
   mid-service. There is no reason for a tight cap here — the relay listens on 127.0.0.1
   only, the client is the operator's own app on the same machine, and the body is written
   straight into one in-memory object.
   It is not UNLIMITED: an unbounded POST is a way to OOM the process that is holding the
   OBS output up, which is the one thing that must never die mid-service. 512 MB is far
   above any real look and far below the point where a modern PC is in trouble.
   Env override for anyone who genuinely needs more. */
const CONFIG_MAX = Math.max(5e6, parseInt(process.env.LT_CONFIG_MAX || "", 10) || 512 * 1024 * 1024);

// Headers for the two routes that serve the app itself (/ and /output). frame-ancestors
// 'none' + X-Frame-Options DENY stop any other page on the machine from framing the
// operator console, which carries a one-click TAKE.
const HTML_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "frame-ancestors 'none'"
};

// Pick the app HTML file. In the desktop app, main.js passes an absolute path.
// Standalone, prefer lt.html, fall back to the deploy-bundle filename.
function defaultHtmlFile() {
  const candidates = [
    path.join(__dirname, "lt.html"),
    path.join(__dirname, "propresenter-lower-thirds.html"),
  ];
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch (e) {} }
  return candidates[0];
}

function createServer(htmlFile) {
  let programConfig = null;          // last config the console "took" to program
  const sseClients  = new Set();     // open /events connections (the outputs)

  function readHtml() {
    try { return fs.readFileSync(htmlFile); }
    catch (e) {
      return Buffer.from(
        "<h1>App HTML not found</h1><p>Expected at: " + htmlFile + "</p>");
    }
  }
  /* ----- origin policy -------------------------------------------------------
     This used to answer every route with Access-Control-Allow-Origin: *, which
     meant ANY web page open on the stream PC could POST /config and put its own
     text on air mid-service, and could read church-LAN hosts back through /pp.
     Both were reproduced against the running relay.

     CORS alone does NOT fix a state-changing POST — the browser blocks reading
     the RESPONSE, but the write has already happened. So /config POST is gated
     on the origin itself and answers 403.

     Allowed: no Origin header (same-origin navigations, OBS, curl, the tests)
     and loopback origins. "null" (file:// and sandboxed iframes) is refused for
     writes, because any hostile page can produce it from a sandboxed frame. */
  const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
  function originOf(req) { return (req && req.headers && req.headers.origin) || ""; }
  function originAllowed(req) { const o = originOf(req); return !o || LOCAL_ORIGIN.test(o); }
  // A no-Origin allowance is right for curl/OBS/tests, but a browser also omits Origin
  // on a plain no-cors GET — so a remote page could still drive /pp and /fetch (it
  // cannot READ the reply, but it can make the stream PC issue the request, which is
  // the SSRF that matters). Sec-Fetch-Site is sent by every current browser and is
  // forbidden to script, so it distinguishes "a browser, cross-site" from "not a
  // browser" without breaking the legitimate no-Origin callers.
  function proxyAllowed(req) {
    if (!originAllowed(req)) return false;
    const site = (req && req.headers && req.headers["sec-fetch-site"]) || "";
    if (site && site !== "same-origin" && site !== "same-site" && site !== "none") return false;
    return true;
  }
  function cors(res, req) {
    const o = originOf(req);
    // Echo the origin only when it is local; otherwise send no ACAO at all so a
    // remote page cannot read the body.
    if (o && LOCAL_ORIGIN.test(o)) res.setHeader("Access-Control-Allow-Origin", o);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }
  function deny(res, why) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "forbidden", detail: why }));
  }
  function broadcast(cfg) {
    const payload = "data: " + JSON.stringify({ type: "program", cfg }) + "\n\n";
    for (const res of sseClients) { try { res.write(payload); } catch (e) {} }
  }
  function proxyPP(target, res, req) {
    let t;
    try { t = new url.URL(target); } catch (e) { res.writeHead(400); return res.end("bad target"); }
    if (t.protocol !== "http:") { res.writeHead(400); return res.end("http only"); }
    const opts = { hostname: t.hostname, port: t.port || 80, path: t.pathname + t.search, method: "GET", timeout: 4000 };
    // Fail safely whether or not the client response headers were already piped.
    // Writing headers a second time throws ERR_HTTP_HEADERS_SENT; unhandled, that
    // would crash the relay and take the OBS output offline mid-service.
    const fail = () => {
      if (res.headersSent) { try { res.end(); } catch (e) {} return; }
      try { cors(res, req); res.writeHead(502, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "pp unreachable" })); } catch (e) {}
    };
    const preq = http.request(opts, (pres) => {
      cors(res, req);
      // Always application/json, never the upstream's Content-Type. Echoing it let
      // any http:// host serve HTML/JS on the relay's OWN origin, which would put
      // attacker script next to the console's localStorage.
      res.writeHead(pres.statusCode || 502, {
        "Content-Type": "application/json",
        "X-Content-Type-Options": "nosniff",
      });
      pres.on("error", () => { try { res.destroy(); } catch (e) {} });   // upstream tore down mid-body
      pres.pipe(res);
    });
    preq.on("timeout", () => { preq.destroy(); fail(); });   // also ends a half-open (headers-then-stall) response
    preq.on("error", fail);
    preq.end();
  }

  return http.createServer((req, res) => {
    const u = url.parse(req.url, true);
    const p = u.pathname;

    if (req.method === "OPTIONS") { cors(res, req); res.writeHead(204); return res.end(); }

    if (req.method === "GET" && (p === "/" || p === "/index.html")) {
      // Deny framing. The console carries a one-click TAKE, so any page open on the stream
      // PC could otherwise iframe it invisibly and clickjack a graphic on air. lt.html uses
      // no iframes of its own, so this costs nothing.
      res.writeHead(200, HTML_HEADERS);
      return res.end(readHtml());
    }
    if (req.method === "GET" && (p === "/output" || p === "/output/")) {
      // Deny framing. The console carries a one-click TAKE, so any page open on the stream
      // PC could otherwise iframe it invisibly and clickjack a graphic on air. lt.html uses
      // no iframes of its own, so this costs nothing.
      res.writeHead(200, HTML_HEADERS);
      return res.end(readHtml());
    }
    if (p === "/config" && req.method === "GET") {
      cors(res, req); res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(programConfig || {}));
    }
    if (p === "/config" && req.method === "POST") {
      // Gate the WRITE, not just the response read — see the origin policy above.
      if (!originAllowed(req)) return deny(res, "cross-origin write to /config");
      // Buffer as Buffers and decode once. Concatenating chunks into a string
      // decoded each chunk independently, so any multi-byte character split
      // across a 64KB socket boundary became U+FFFD and went to air corrupted.
      const chunks = []; let len = 0; let tooBig = false;
      req.on("data", (c) => {
        if (tooBig) return;
        len += c.length;
        if (len > CONFIG_MAX) {
          // Do NOT req.destroy() here: killing the socket means the 413 never reaches
          // the console, so an over-size Take failed silently and the operator was told
          // it was on air. Stop buffering, answer honestly, then close.
          tooBig = true; chunks.length = 0;
          cors(res, req);
          res.writeHead(413, { "Content-Type": "application/json", "Connection": "close" });
          res.end(JSON.stringify({ ok: false, error: "config too large", limit: CONFIG_MAX }));
          return;
        }
        chunks.push(c);
      });
      req.on("aborted", () => { /* client gave up; nothing to answer */ });
      req.on("end", () => {
        if (tooBig) return;                 // already answered with 413 above
        let ok = true, detail = null;
        try { programConfig = JSON.parse(Buffer.concat(chunks).toString("utf8")); broadcast(programConfig); }
        catch (e) { ok = false; detail = String((e && e.message) || e); }
        cors(res, req);
        // Report a parse failure honestly. Answering 200 made a failed Take look
        // like a successful one, so the console said "ON AIR" with nothing sent.
        res.writeHead(ok ? 200 : 400, { "Content-Type": "application/json" });
        res.end(JSON.stringify(ok ? { ok: true } : { ok: false, error: "bad json", detail }));
      });
      return;
    }
    // Lightweight health probe for the console: how many outputs (OBS browser
    // sources / output tabs) are actually subscribed right now.
    if (p === "/status" && req.method === "GET") {
      // Count OUTPUTS separately from consoles. The console subscribes to /events
      // as well, so a raw client count would show "connected" with nothing on air.
      let outputs = 0;
      for (const c of sseClients) if (c._role === "output") outputs++;
      cors(res, req); res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({
        ok: true,
        clients: outputs,                 // what the OBS lamp reads
        totalClients: sseClients.size,
        consoles: sseClients.size - outputs,
        hasProgram: !!programConfig,
        uptime: Math.round(process.uptime()),
      }));
    }
    if (p === "/events" && req.method === "GET") {
      cors(res, req);
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
      res.write("retry: 2000\n\n");
      if (programConfig) res.write("data: " + JSON.stringify({ type: "program", cfg: programConfig }) + "\n\n");
      // Default to "output": an OBS Browser Source added before this change (or any
      // third-party consumer) has no role param, and it IS an output.
      // The role is a self-declared hint used only for the console's "is OBS attached?"
      // lamp — never for access control. A cross-site subscriber is not counted at all,
      // so a stray page cannot make the lamp read green when no output is connected.
      // (SSE is same-origin-readable only, so this is about accuracy, not secrecy.)
      const sfs = (req.headers && req.headers["sec-fetch-site"]) || "";
      const foreign = sfs && sfs !== "same-origin" && sfs !== "same-site" && sfs !== "none";
      res._role = foreign ? "foreign" : ((u.query.role === "console") ? "console" : "output");
      sseClients.add(res);
      const ka = setInterval(() => { try { res.write(": ping\n\n"); } catch (e) {} }, 25000);
      req.on("close", () => { clearInterval(ka); sseClients.delete(res); });
      return;
    }
    // Live-data fetch for bound sources (Google Sheets CSV, a JSON endpoint, RSS).
    // Same origin gate as /pp — this can reach anything the stream PC can, so it must
    // not be usable by a remote page. https is allowed here (unlike /pp, which talks
    // to ProPresenter on the LAN over http).
    if (p === "/fetch" && req.method === "GET") {
      if (!proxyAllowed(req)) return deny(res, "cross-origin use of the data proxy");
      const target = u.query.target;
      if (!target) { res.writeHead(400); return res.end("missing target"); }
      let t;
      try { t = new url.URL(target); } catch (e) { res.writeHead(400); return res.end("bad target"); }
      if (t.protocol !== "http:" && t.protocol !== "https:") { res.writeHead(400); return res.end("http(s) only"); }
      let done = false;
      const fail = (why) => {
        if (done) return; done = true;
        if (res.headersSent) { try { res.end(); } catch (e) {} return; }
        try { cors(res, req); res.writeHead(502, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "fetch failed", detail: String(why || "") })); } catch (e) {}
      };
      // Follow redirects. Google answers a published-Sheet CSV URL — the documented
      // primary source — with a 307 to googleusercontent.com. Passing that straight
      // through dropped the Location header (every header is replaced below) and
      // returned an empty body, so the source could NEVER load. Bounded hops, and the
      // scheme is re-validated each time so a redirect cannot walk us to file: or
      // some other protocol.
      const hop = (u, left) => {
        if (done) return;
        if (left < 0) return fail("too many redirects");
        const mod = u.protocol === "https:" ? require("https") : http;
        const opts = { hostname: u.hostname, port: u.port || (u.protocol === "https:" ? 443 : 80),
                       path: u.pathname + u.search, method: "GET", timeout: 8000,
                       headers: { "User-Agent": "LowerThirdsEngine", "Accept": "*/*" } };
        const freq = mod.request(opts, (pres) => {
          const code = pres.statusCode || 0;
          if (code >= 300 && code < 400 && pres.headers.location) {
            pres.resume();                                  // drain, we only want the header
            let next;
            try { next = new url.URL(pres.headers.location, u); } catch (e) { return fail("bad redirect target"); }
            if (next.protocol !== "http:" && next.protocol !== "https:") return fail("redirect to a non-http(s) scheme");
            return hop(next, left - 1);
          }
          // Cap the body: a bound source that turns into a huge download must not be
          // able to exhaust memory mid-service. The cap applies to every hop.
          let len = 0; const chunks = [];
          pres.on("data", (c) => { len += c.length; if (len > 2e6) { pres.destroy(); return fail("response too large"); } chunks.push(c); });
          pres.on("end", () => {
            if (done) return; done = true;
            cors(res, req);
            // Always text/plain + nosniff: the body is untrusted third-party content and
            // must never be able to execute on the relay's own origin.
            res.writeHead(code || 502, { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff" });
            res.end(Buffer.concat(chunks).toString("utf8"));
          });
          pres.on("error", (e) => fail(e && e.message));
        });
        freq.on("timeout", () => { freq.destroy(); fail("timeout"); });
        freq.on("error", (e) => fail(e && e.message));
        freq.end();
      };
      hop(t, 5);
      return;
    }
    if (p === "/pp" && req.method === "GET") {
      // The proxy can reach any http host the stream PC can. With a wildcard CORS
      // header a remote page could use it to read church-LAN devices, so it is
      // restricted to local callers like /config.
      if (!proxyAllowed(req)) return deny(res, "cross-origin use of the ProPresenter proxy");
      if (!u.query.target) { res.writeHead(400); return res.end("missing target"); }
      return proxyPP(u.query.target, res, req);
    }
    /* ----- local media, OBS-style ------------------------------------------------
       Serves a local media file to the output/console pages, so a look can point at
       C:\Videos\loop.mp4 instead of embedding it. Embedding pays base64 x 4/3 into a
       config (see CONFIG_MAX above) and blows past what localStorage can hold — while
       a served file costs the config ~100 bytes. This is the same trick OBS itself
       uses ("Local file" on a media source): the page is http-served, and an http page
       may not load file:// subresources, so the server hands the file over http.

       Guard rails, in order of what they protect:
       - proxyAllowed(): a hostile web page open on the stream PC could otherwise probe
         local files through <img>/<video> tags (CORS blocks READING the bytes, but not
         load/error timing). Sec-Fetch-Site refuses cross-site browser loads outright,
         while OBS, Electron, curl and the same-origin pages all pass.
       - extension allowlist: this must never become a generic local-file reader — a
         .txt/.key/.js path answers 403 no matter what it is named in the query.
       - SVG gets a no-script CSP: an <img> never runs SVG script, but a DIRECT
         navigation to /media would execute it on the relay's own origin, right next to
         the console's localStorage.
       The relay listens on 127.0.0.1 only (see start()), so none of this is reachable
       from the LAN at all. */
    if (p === "/media" && req.method === "GET") {
      if (!proxyAllowed(req)) return deny(res, "cross-origin use of local media");
      let fp = String(u.query.src || "");
      if (!fp) { res.writeHead(400); return res.end("missing src"); }
      // Accept a file:// URL as well as a plain path — both spellings are offered in
      // the console UI, and "Copy as path"/drag-and-drop produce either.
      if (/^file:\/\//i.test(fp)) {
        try { fp = url.fileURLToPath(fp); } catch (e) { res.writeHead(400); return res.end("bad file url"); }
      }
      const MEDIA_TYPES = {
        ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
        ".webp": "image/webp", ".avif": "image/avif", ".bmp": "image/bmp", ".svg": "image/svg+xml",
        ".mp4": "video/mp4", ".m4v": "video/x-m4v", ".webm": "video/webm",
        ".ogv": "video/ogg", ".ogg": "video/ogg", ".mov": "video/quicktime",
      };
      const type = MEDIA_TYPES[path.extname(fp).toLowerCase()];
      if (!type) return deny(res, "not a media file");
      fs.stat(fp, (err, st) => {
        if (err || !st.isFile()) {
          cors(res, req);
          res.writeHead(404, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "no such media file", path: fp }));
        }
        const headers = {
          "Content-Type": type,
          "X-Content-Type-Options": "nosniff",
          "Accept-Ranges": "bytes",
          // The operator's loop.mp4 gets re-exported over the top of itself; a cached
          // stale copy on air is exactly the kind of failure nobody can diagnose live.
          "Cache-Control": "no-cache",
        };
        if (type === "image/svg+xml") headers["Content-Security-Policy"] = "default-src 'none'; style-src 'unsafe-inline'";
        cors(res, req);
        // Single-range support: Chromium requests ranges for <video>, and without 206s
        // seeking stalls and a loop can hang at the wrap point.
        const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ""));
        if (m && (m[1] !== "" || m[2] !== "")) {
          let start = m[1] === "" ? Math.max(0, st.size - parseInt(m[2], 10)) : parseInt(m[1], 10);
          let end = (m[1] !== "" && m[2] !== "") ? Math.min(parseInt(m[2], 10), st.size - 1) : st.size - 1;
          if (isNaN(start) || isNaN(end) || start > end || start >= st.size) {
            res.writeHead(416, { "Content-Range": "bytes */" + st.size });
            return res.end();
          }
          headers["Content-Range"] = "bytes " + start + "-" + end + "/" + st.size;
          headers["Content-Length"] = end - start + 1;
          res.writeHead(206, headers);
          const rs = fs.createReadStream(fp, { start, end });
          rs.on("error", () => { try { res.destroy(); } catch (e) {} });
          return rs.pipe(res);
        }
        headers["Content-Length"] = st.size;
        res.writeHead(200, headers);
        const rs = fs.createReadStream(fp);
        rs.on("error", () => { try { res.destroy(); } catch (e) {} });
        rs.pipe(res);
      });
      return;
    }
    res.writeHead(404); res.end("not found");
  });
}

/**
 * Start the relay. Returns the http.Server (with a .close()).
 * opts.port      default 7777 (or PORT env when standalone)
 * opts.htmlFile  absolute path to the app HTML (defaults to lt.html next to this file)
 * opts.quiet     suppress the console banner (the desktop app sets this)
 */
function start(opts) {
  opts = opts || {};
  const port = opts.port || (process.env.PORT ? parseInt(process.env.PORT) : 7777);
  const htmlFile = opts.htmlFile || defaultHtmlFile();
  const server = createServer(htmlFile);
  // Bind to loopback only. OBS reads http://localhost:7777/output on the SAME PC,
  // so this keeps the open /pp proxy and writable /config off the church LAN.
  server.listen(port, "127.0.0.1", () => {
    if (opts.quiet) return;
    const line = "=".repeat(58);
    console.log("\n" + line);
    console.log("  Lower Thirds Engine — relay running");
    console.log(line);
    console.log("  Operator console : http://localhost:" + port);
    console.log("  OBS Browser Src  : http://localhost:" + port + "/output");
    console.log("                     (1920 x 1080, 'Shutdown source when not visible' OFF)");
    console.log(line);
    console.log("  Leave this window open during service. Ctrl+C to stop.\n");
  });
  return server;
}

module.exports = { start, createServer, defaultHtmlFile };

// Standalone: `node relay.js` keeps working exactly as before. Keep the relay
// alive on an unexpected error so the OBS output never goes dark mid-service.
if (require.main === module) {
  process.on("uncaughtException", (err) => { console.error("[relay] uncaught:", (err && err.message) || err); });
  start();
}
