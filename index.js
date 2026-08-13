#!/usr/bin/env node
const { spawn, execSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");

// ── Config ──────────────────────────────────────────────
const CONF_DIR = path.join(os.homedir(), ".open-tunnel");
const KEY_PATH = path.join(CONF_DIR, "tunnel_key");
const SERVER = "serveo.net";
const DEFAULT_PORT = 3000;
const DASHBOARD_PORT = 4040;

// ── CLI args ────────────────────────────────────────────
const args = process.argv.slice(2);

function argVal(flag, short) {
  const idx = args.findIndex(a => a === flag || (short && a === short));
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : null;
}

function hasFlag(flag, short) {
  return args.includes(flag) || (short && args.includes(short));
}

const _pv = argVal("--port", "-p") || args.find(a => /^\d+$/.test(a)) || String(DEFAULT_PORT);
let port = parseInt(_pv) || DEFAULT_PORT;
const subdomain = argVal("--subdomain", "-s") || "";
const backend = args.includes("--bore") ? "bore" : "serveo";
const noDashboard = hasFlag("--no-dash", "-n");
let currentSsh = null;

// ── Help ────────────────────────────────────────────────
if (hasFlag("--help", "-h")) {
  console.log(`
  open-tunnel  --  zero-config tunnel + dashboard

  Usage:
    node index.js [options]

  Options:
    --port,  -p <n>     Local port (default: ${DEFAULT_PORT})
    --subdomain, -s <s> Custom subdomain (serveo only)
    --open,  -o         Open dashboard in browser
    --no-dash, -n       Disable dashboard server
    --bore              Use bore.pub backend
    --help,  -h         Show this help

  Dashboard: http://localhost:${DASHBOARD_PORT}
`);
  process.exit(0);
}

// ── Utils ───────────────────────────────────────────────
function info(msg) { process.stdout.write(`  > ${msg}\n`); }
function ok(msg) { process.stdout.write(`  + ${msg}\n`); }
function warn(msg) { process.stdout.write(`  ! ${msg}\n`); }

function findSsh() {
  const cmd = process.platform === "win32" ? "where ssh" : "which ssh";
  try { return execSync(cmd, { encoding: "utf8", stdio: ["pipe","pipe","ignore"] }).trim().split("\n")[0]; }
  catch { return "ssh"; }
}

function ensureKey() {
  fs.mkdirSync(CONF_DIR, { recursive: true });
  if (!fs.existsSync(KEY_PATH)) {
    info("Generating SSH key...");
    try {
      execSync(`ssh-keygen -t ed25519 -f "${KEY_PATH}" -N "" -C "open-tunnel" -q`, { stdio: "ignore" });
      ok("Key: " + KEY_PATH);
    } catch (e) {
      warn("Key generation failed, using anonymous (random URL each time)");
      return null;
    }
  }
  return KEY_PATH;
}

// ── Dashboard state ────────────────────────────────────
const state = {
  online: false,
  publicUrl: null,
  localPort: port,
  startTime: Date.now(),
  totalRequests: 0,
  okRequests: 0,
  totalLatency: 0,
  requests: [],
  recentLogs: [],
  statusBreakdown: { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0 },
  requestTimes: [],
  latencyBuckets: { lt10: 0, lt50: 0, lt200: 0, gt200: 0 },
  bytesIn: 0,
  bytesOut: 0,
  disconnectionCount: 0,
  onlineSince: null,
  totalOnlineMs: 0,
  connectionGaps: [],
  endpointStats: {},
  lastLatency: 0,
};

function recordRequest(method, path, status, latency) {
  state.totalRequests++;
  if (status >= 200 && status < 400) state.okRequests++;
  state.totalLatency += latency;
  state.lastLatency = latency;
  state.requests.push({ time: Date.now(), method, path, status, latency });
  state.recentLogs.push({ method, path, status, latency });
  if (state.requests.length > 500) state.requests = state.requests.slice(-500);
  if (state.recentLogs.length > 200) state.recentLogs = state.recentLogs.slice(-200);

  const sc = Math.floor(status / 100);
  if (sc === 2) state.statusBreakdown["2xx"]++;
  else if (sc === 3) state.statusBreakdown["3xx"]++;
  else if (sc === 4) state.statusBreakdown["4xx"]++;
  else if (sc === 5) state.statusBreakdown["5xx"]++;

  if (latency < 10) state.latencyBuckets.lt10++;
  else if (latency < 50) state.latencyBuckets.lt50++;
  else if (latency < 200) state.latencyBuckets.lt200++;
  else state.latencyBuckets.gt200++;

  state.requestTimes.push(Date.now());
  const cutoff = Date.now() - 60000;
  while (state.requestTimes.length && state.requestTimes[0] < cutoff) state.requestTimes.shift();

  if (!state.endpointStats[path]) state.endpointStats[path] = 0;
  state.endpointStats[path]++;

  if (method === "POST") state.bytesIn += 128;
  state.bytesOut += 512;
}

// ── Dashboard HTTP server ───────────────────────────────
function serveFile(res, filePath, contentType) {
  try {
    const data = fs.readFileSync(filePath);
    res.writeHead(200, { "Content-Type": contentType });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("404");
  }
}

function formatShortJson(data) {
  // Pre-compute these once
  const avgLat = state.totalRequests > 0 ? Math.round(state.totalLatency / state.totalRequests) : 0;
  const activeOnlineMs = state.online && state.onlineSince ? Date.now() - state.onlineSince : 0;
  const totalOnline = state.totalOnlineMs + activeOnlineMs;
  const totalElapsed = Date.now() - state.startTime;
  const uptimePct = totalElapsed > 0 ? Math.round((totalOnline / totalElapsed) * 1000) / 10 : 0;
  const rpsCutoff = Date.now() - 10000;
  const recentReqs = state.requestTimes.filter(t => t > rpsCutoff).length;
  const rps10s = Math.round(recentReqs / 10 * 10) / 10;
  const topPaths = Object.entries(state.endpointStats).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([p, c]) => ({ path: p, count: c }));

  return JSON.stringify({
    online: state.online, publicUrl: state.publicUrl, localPort: state.localPort,
    startTime: state.startTime, totalRequests: state.totalRequests, okRequests: state.okRequests,
    avgLatency: avgLat, lastLatency: state.lastLatency, connections: 1,
    requests: state.requests.slice(-200).map(r => ({ time: r.time, method: r.method, path: r.path, status: r.status, latency: r.latency })),
    recentLogs: state.recentLogs.slice(-8),
    statusBreakdown: state.statusBreakdown, latencyBuckets: state.latencyBuckets,
    rps10s, requestTimes: state.requestTimes.slice(-300),
    bytesIn: state.bytesIn, bytesOut: state.bytesOut,
    disconnectionCount: state.disconnectionCount, uptimePct, totalOnlineMs: totalOnline,
    connectionGaps: state.connectionGaps.slice(-20), topPaths,
  });
}

function startDashboard() {
  const publicDir = path.join(__dirname, "public");

  const dashboard = http.createServer((req, res) => {
    const t0 = Date.now();
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

    if (req.url === "/api/status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(formatShortJson());
      recordRequest("GET", "/api/status", 200, Date.now() - t0);
      return;
    }

    if (req.url === "/api/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, target: `localhost:${port}`, uptime: Math.floor((Date.now() - state.startTime) / 1000) }));
      recordRequest("GET", "/api/health", 200, Date.now() - t0);
      return;
    }

    if (req.url === "/api/port" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          const { port: newPort } = JSON.parse(body);
          const p = parseInt(newPort);
          if (!p || p < 1 || p > 65535) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: "Invalid port" }));
            recordRequest("POST", "/api/port", 400, Date.now() - t0);
            return;
          }
          port = p; state.localPort = p; state.publicUrl = null; state.online = false;
          if (currentSsh) { currentSsh.kill(); currentSsh = null; }
          startServeo(ensureKey());
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true, port: p }));
          recordRequest("POST", "/api/port", 200, Date.now() - t0);
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, error: e.message }));
          recordRequest("POST", "/api/port", 400, Date.now() - t0);
        }
      });
      return;
    }

    if (req.url === "/" || req.url === "/dashboard") {
      serveFile(res, path.join(publicDir, "dashboard.html"), "text/html; charset=utf-8");
      recordRequest("GET", req.url, 200, Date.now() - t0);
      return;
    }

    if (req.url.startsWith("/public/") || req.url.startsWith("/assets/")) {
      const f = path.join(publicDir, path.basename(req.url));
      const mime = { ".css": "text/css", ".js": "application/javascript", ".html": "text/html" }[path.extname(req.url)] || "text/plain";
      serveFile(res, f, mime);
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("404");
    recordRequest("GET", req.url, 404, Date.now() - t0);
  });

  dashboard.listen(DASHBOARD_PORT, () => {
    ok(`Dashboard: http://localhost:${DASHBOARD_PORT}`);
  });
  return dashboard;
}

// ── Serveo backend ──────────────────────────────────────
function startServeo(keyPath) {
  const sshArgs = [
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=" + (process.platform === "win32" ? "NUL" : "/dev/null"),
    "-o", "ServerAliveInterval=30",
    "-o", "ServerAliveCountMax=3",
    "-o", "ExitOnForwardFailure=yes",
  ];
  if (keyPath && fs.existsSync(keyPath)) {
    sshArgs.unshift("-i", keyPath);
  }
  const remote = subdomain ? `${subdomain}:80:localhost:${port}` : `80:localhost:${port}`;
  sshArgs.push("-R", remote, SERVER);

  const ssh = spawn(findSsh(), sshArgs, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  currentSsh = ssh;

  let url = null;
  let lineBuf = "";

  ssh.stdout.on("data", (chunk) => {
    lineBuf += chunk.toString();
    const lines = lineBuf.split("\n");
    lineBuf = lines.pop();
    for (const line of lines) {
      const m = line.match(/https?:\/\/[\w.-]+(?:serveousercontent\.com|serveo\.net)/);
      if (m && !url) {
        url = m[0];
        state.online = true;
        state.publicUrl = url;
        state.onlineSince = Date.now();
        onConnected(url);
      }
    }
  });

  ssh.stderr.on("data", (chunk) => {
    const msg = chunk.toString();
    if (msg.includes("Warning:") || msg.includes("error:") || msg.includes("Connection")) {
      process.stdout.write(`  ${msg.trim()}\n`);
    }
  });

  ssh.on("error", (err) => {
    warn("SSH error: " + err.message);
    if (err.code === "ENOENT") {
      warn("OpenSSH not found. Install: Settings > Apps > Optional Features > OpenSSH Client");
    }
  });

  ssh.on("close", (code) => {
    currentSsh = null;
    if (state.online && state.onlineSince) {
      state.totalOnlineMs += Date.now() - state.onlineSince;
      state.connectionGaps.push({
        start: state.onlineSince, end: Date.now(), duration: Date.now() - state.onlineSince,
      });
      if (state.connectionGaps.length > 50) state.connectionGaps = state.connectionGaps.slice(-50);
    }
    state.online = false;
    state.onlineSince = null;
    state.disconnectionCount++;
    if (url) warn("Tunnel disconnected, reconnecting in 5s...");
    setTimeout(() => startServeo(keyPath), 5000);
  });

  return ssh;
}

// ── Connected ──────────────────────────────────────────
let connectedOnce = false;
function onConnected(url) {
  if (connectedOnce) return;
  connectedOnce = true;
  console.log("");
  console.log(`  ==================================================`);
  console.log("");
  console.log(`    Public URL : ${url}`);
  console.log(`    Local Port : localhost:${port}`);
  console.log(`    Dashboard  : http://localhost:${DASHBOARD_PORT}`);
  console.log("");
  console.log(`    Ctrl+C to stop`);
  console.log("");
}

// ── Main ────────────────────────────────────────────────
console.log("");
console.log(`  open-tunnel // zero-config tunnel`);
console.log(`  --------------------------------------------------`);

if (backend === "serveo") {
  try { execSync(`${findSsh()} -V`, { stdio: "ignore" }); } catch {
    warn("OpenSSH not found");
    process.exit(1);
  }
}

const keyPath = ensureKey();
if (subdomain) info(`Subdomain: ${subdomain}`);

if (!noDashboard) { startDashboard(); }
info(`Connecting to ${SERVER} on port ${port}...`);
startServeo(keyPath);

process.stdin.resume();

if (hasFlag("--open", "-o") && !noDashboard) {
  setTimeout(() => {
    const cmd = process.platform === "win32" ? "start" : process.platform === "darwin" ? "open" : "xdg-open";
    try { execSync(`${cmd} http://localhost:${DASHBOARD_PORT}`, { stdio: "ignore" }); } catch {}
  }, 2000);
}