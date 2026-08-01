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
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(readHtml());
    }
    if (req.method === "GET" && (p === "/output" || p === "/output/")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
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
        len += c.length;
        if (len > 5e6) { tooBig = true; req.destroy(); return; }
        chunks.push(c);
      });
      req.on("aborted", () => { /* client gave up; nothing to answer */ });
      req.on("end", () => {
        if (tooBig) {
          cors(res, req); res.writeHead(413, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "config too large", limit: 5e6 }));
        }
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
      res._role = (u.query.role === "console") ? "console" : "output";
      sseClients.add(res);
      const ka = setInterval(() => { try { res.write(": ping\n\n"); } catch (e) {} }, 25000);
      req.on("close", () => { clearInterval(ka); sseClients.delete(res); });
      return;
    }
    if (p === "/pp" && req.method === "GET") {
      // The proxy can reach any http host the stream PC can. With a wildcard CORS
      // header a remote page could use it to read church-LAN devices, so it is
      // restricted to local callers like /config.
      if (!originAllowed(req)) return deny(res, "cross-origin use of the ProPresenter proxy");
      if (!u.query.target) { res.writeHead(400); return res.end("missing target"); }
      return proxyPP(u.query.target, res, req);
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
