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
  function cors(res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }
  function broadcast(cfg) {
    const payload = "data: " + JSON.stringify({ type: "program", cfg }) + "\n\n";
    for (const res of sseClients) { try { res.write(payload); } catch (e) {} }
  }
  function proxyPP(target, res) {
    let t;
    try { t = new url.URL(target); } catch (e) { res.writeHead(400); return res.end("bad target"); }
    if (t.protocol !== "http:") { res.writeHead(400); return res.end("http only"); }
    const opts = { hostname: t.hostname, port: t.port || 80, path: t.pathname + t.search, method: "GET", timeout: 4000 };
    // Fail safely whether or not the client response headers were already piped.
    // Writing headers a second time throws ERR_HTTP_HEADERS_SENT; unhandled, that
    // would crash the relay and take the OBS output offline mid-service.
    const fail = () => {
      if (res.headersSent) { try { res.end(); } catch (e) {} return; }
      try { cors(res); res.writeHead(502, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "pp unreachable" })); } catch (e) {}
    };
    const preq = http.request(opts, (pres) => {
      cors(res);
      res.writeHead(pres.statusCode || 502, { "Content-Type": pres.headers["content-type"] || "application/json" });
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

    if (req.method === "OPTIONS") { cors(res); res.writeHead(204); return res.end(); }

    if (req.method === "GET" && (p === "/" || p === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(readHtml());
    }
    if (req.method === "GET" && (p === "/output" || p === "/output/")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(readHtml());
    }
    if (p === "/config" && req.method === "GET") {
      cors(res); res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(programConfig || {}));
    }
    if (p === "/config" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => { body += c; if (body.length > 5e6) req.destroy(); });
      req.on("end", () => {
        try { programConfig = JSON.parse(body); broadcast(programConfig); } catch (e) {}
        cors(res); res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"ok":true}');
      });
      return;
    }
    if (p === "/events" && req.method === "GET") {
      cors(res);
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
      res.write("retry: 2000\n\n");
      if (programConfig) res.write("data: " + JSON.stringify({ type: "program", cfg: programConfig }) + "\n\n");
      sseClients.add(res);
      const ka = setInterval(() => { try { res.write(": ping\n\n"); } catch (e) {} }, 25000);
      req.on("close", () => { clearInterval(ka); sseClients.delete(res); });
      return;
    }
    if (p === "/pp" && req.method === "GET") {
      if (!u.query.target) { res.writeHead(400); return res.end("missing target"); }
      return proxyPP(u.query.target, res);
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
