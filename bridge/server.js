// claudian-ignis bridge
// Kör Claude Code CLI på servern och exponerar processens stdio över WebSocket,
// så att Claudian-pluginets fjärrspawn i webbläsaren kan prata med den.
//
// Processer är FRIKOPPLADE från anslutningen (sedan 2026-08-23): en klient
// som stänger fliken (eller skickar kill) kopplas bara loss — CLI-processen
// lever vidare på servern så att samma konversation kan fortsätta från
// Claude-appen via Remote Control. Nästa klient som startar med
// `--resume <session-id>` kopplas på den levande processen i stället för att
// spawna en ny. Inaktiva frikopplade processer städas efter DETACH_TTL_MS.
//
// Säkerhet: binder till 127.0.0.1 som standard. Klienten får INTE välja
// kommando — bryggan kör alltid CLAUDE_BIN. Args/cwd/env tas emot från
// klienten (SDK:t bygger dem), med cwd-mappning och skyddad env-merge.

'use strict';

const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');
const os = require('os');
const path = require('path');

const HOST = process.env.BRIDGE_HOST || '127.0.0.1';
const PORT = Number(process.env.BRIDGE_PORT || 8095);
// Sätts BRIDGE_TOKEN krävs ?token=<värde> i WS-URL:en (Caddy exponerar bryggan
// för LAN/Tailscale via wss, och den kör godtyckliga claude-kommandon).
const TOKEN = process.env.BRIDGE_TOKEN || '';
const DEBUG_PROTO = process.env.BRIDGE_DEBUG === '1';
// Frikopplade processer (utan ansluten klient) får leva så här länge utan
// trafik innan de städas bort. Remote Control (Claude-appen) pratar med dem
// via Anthropics brygga, inte via oss, så stdout-aktivitet räknas som liv.
const DETACH_TTL_MS = Number(process.env.BRIDGE_DETACH_TTL_MS || 8 * 60 * 60 * 1000);
const MAX_DETACHED = Number(process.env.BRIDGE_MAX_DETACHED || 8);
const CLAUDE_BIN = process.env.CLAUDE_BIN || path.join(os.homedir(), '.local', 'bin', 'claude');
// Ignis-containern ser vaulten som /vaults/... — på värden ligger den här:
const PATH_MAP_FROM = process.env.PATH_MAP_FROM || '/vaults';
const PATH_MAP_TO = process.env.PATH_MAP_TO || path.join(os.homedir(), 'ignis', 'vaults');

const LOCAL_BIN = path.join(os.homedir(), '.local', 'bin');

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function mapPath(p) {
  if (typeof p !== 'string' || p.length === 0) return p;
  // Idempotens: mobilklienter (Obsidian iOS) hämtar vaultRoot från /config och
  // skickar redan värd-sökvägar — de får inte prefixas en gång till.
  if (p === PATH_MAP_TO || p.startsWith(PATH_MAP_TO + '/')) return p;
  if (p === PATH_MAP_FROM) return PATH_MAP_TO;
  // Ignis exponerar vaultroten som "/" — då mappas alla absoluta sökvägar
  if (PATH_MAP_FROM === '/' && p.startsWith('/')) return PATH_MAP_TO + p;
  if (p.startsWith(PATH_MAP_FROM + '/')) return PATH_MAP_TO + p.slice(PATH_MAP_FROM.length);
  return p;
}

function buildEnv(clientEnv) {
  const env = { ...process.env };
  if (clientEnv && typeof clientEnv === 'object') {
    for (const [k, v] of Object.entries(clientEnv)) {
      if (typeof v !== 'string') continue;
      // Låt inte klienten sabba grunderna
      if (k === 'HOME' || k === 'USER' || k === 'SHELL') continue;
      if (k === 'PATH') continue; // sätts nedan
      env[k] = v;
    }
  }
  const basePath = env.PATH || '/usr/local/bin:/usr/bin:/bin';
  env.PATH = basePath.includes(LOCAL_BIN) ? basePath : `${LOCAL_BIN}:${basePath}`;
  return env;
}

// Läs-API över HTTP för Claude-transkripten (~/.claude/projects), så att
// Claudian i webbläsaren kan replaya konversationshistorik. Endast läsning,
// endast under READ_ROOTS, samma token som WS-protokollet.
const http = require('http');
const fsSync = require('fs');
const fsPromises = require('fs/promises');

const HOME = os.homedir();
// Vaultroten ingår för mobilklienter (Obsidian iOS): där finns ingen Ignis-fs,
// så även vault-läsningar på klientsidan går via detta API. Ignis-klienter
// läser vaulten via sin egen fs-shim och berörs inte.
const READ_ROOTS = [path.join(HOME, '.claude', 'projects'), PATH_MAP_TO];

function hasValidToken(reqUrl) {
  if (!TOKEN) return true;
  try {
    return new URL(reqUrl, 'http://localhost').searchParams.get('token') === TOKEN;
  } catch {
    return false;
  }
}

function resolveReadablePath(rawPath) {
  if (typeof rawPath !== 'string' || rawPath.length === 0) return null;
  const resolved = path.resolve(rawPath);
  for (const root of READ_ROOTS) {
    if (resolved === root || resolved.startsWith(root + path.sep)) {
      try {
        // Symlänkar får inte peka ut ur läsroten.
        const real = fsSync.realpathSync(resolved);
        if (real === root || real.startsWith(fsSync.realpathSync(root) + path.sep)) {
          return real;
        }
      } catch {
        return null; // finns inte → 404 nedan
      }
      return null;
    }
  }
  return null;
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(data);
}

async function handleHttp(req, res) {
  const url = new URL(req.url, 'http://localhost');
  // Via tunneln kommer sökvägen som /claudian-bridge/..., direkt som /...
  const route = url.pathname.replace(/^\/claudian-bridge(?=\/|$)/, '') || '/';

  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'method not allowed' });
    return;
  }
  if (!hasValidToken(req.url)) {
    sendJson(res, 401, { error: 'unauthorized' });
    return;
  }

  if (route === '/config') {
    sendJson(res, 200, {
      home: HOME,
      vaultRoot: PATH_MAP_TO,
      remoteReadRoots: READ_ROOTS,
    });
    return;
  }

  if (route === '/sessions') {
    sendJson(res, 200, { sessions: [...allProcs].map(describeProc) });
    return;
  }

  const target = url.searchParams.get('path');

  if (route === '/fs/stat' || route === '/fs/readdir' || route === '/fs/read') {
    const resolved = resolveReadablePath(target);
    if (!resolved) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    try {
      if (route === '/fs/stat') {
        const stat = await fsPromises.stat(resolved);
        sendJson(res, 200, {
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          isFile: stat.isFile(),
          isDirectory: stat.isDirectory(),
        });
      } else if (route === '/fs/readdir') {
        const entries = await fsPromises.readdir(resolved, { withFileTypes: true });
        sendJson(res, 200, {
          entries: entries.map((entry) => ({
            name: entry.name,
            type: entry.isFile() ? 'file' : entry.isDirectory() ? 'dir' : 'other',
          })),
        });
      } else {
        const contents = await fsPromises.readFile(resolved);
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(contents);
      }
    } catch (err) {
      sendJson(res, err && err.code === 'ENOENT' ? 404 : 500, { error: String(err && err.code || err) });
    }
    return;
  }

  sendJson(res, 404, { error: 'unknown route' });
}

// ---------------------------------------------------------------------------
// Processregister: session-id → levande CLI-process med 0..n anslutna klienter
// ---------------------------------------------------------------------------

/** @type {Map<string, ProcEntry>} nyckel = CLI:ns session_id (från system/init) */
const procsBySession = new Map();
/** @type {Set<ProcEntry>} alla levande processer, även de som inte hunnit få session_id */
const allProcs = new Set();
let procSeq = 0;

function parseStartArgs(args) {
  let resumeId = null;
  let fork = false;
  let oneShot = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if ((a === '--resume' || a === '-r') && typeof args[i + 1] === 'string') resumeId = args[i + 1];
    else if (a.startsWith('--resume=')) resumeId = a.slice('--resume='.length);
    else if (a === '--fork-session') fork = true;
    else if (a === '--input-format' && args[i + 1] !== 'stream-json') oneShot = true;
    // Ingen transkript-persistens = inget att återansluta till (titelgenerering,
    // runtime-prober). Behåll inte processen frikopplad när klienten stänger.
    else if (a === '--no-session-persistence') oneShot = true;
  }
  // Utan stream-json-stdin är det en engångsfråga (t.ex. titelgenerering):
  // prompten ligger i argumenten och processen avslutar sig själv.
  if (!args.includes('--input-format')) oneShot = true;
  return { resumeId, fork, oneShot };
}

// Replay-buffert: mobilklienter (Obsidian iOS) tappar WebSocketen varje gång
// appen hamnar i bakgrunden. Utdata som produceras under tiden buffras per
// process med sekvensnummer, så att en återansluten klient kan få exakt det
// den missade (attach med sinceSeq) i stället för ingenting.
const REPLAY_MAX_FRAMES = Number(process.env.BRIDGE_REPLAY_MAX_FRAMES || 5000);
const REPLAY_MAX_BYTES = Number(process.env.BRIDGE_REPLAY_MAX_BYTES || 8 * 1024 * 1024);

function createProcEntry(child, meta) {
  const entry = {
    id: ++procSeq,
    child,
    pid: child.pid,
    sessionId: null,
    clients: new Set(),
    stdoutBuf: '',
    lastActivity: Date.now(),
    detachedAt: null,
    oneShot: meta.oneShot,
    resumeId: meta.resumeId,
    startedAt: Date.now(),
    outSeq: 0,
    replay: [],       // [{seq, frame}] för stdout/stderr
    replayBytes: 0,
  };
  allProcs.add(entry);
  return entry;
}

function pushReplay(entry, frame) {
  const size = frame.data ? frame.data.length : 0;
  entry.replay.push({ seq: frame.seq, frame });
  entry.replayBytes += size;
  while (
    entry.replay.length > REPLAY_MAX_FRAMES
    || (entry.replayBytes > REPLAY_MAX_BYTES && entry.replay.length > 1)
  ) {
    const dropped = entry.replay.shift();
    entry.replayBytes -= dropped.frame.data ? dropped.frame.data.length : 0;
  }
}

function broadcast(entry, obj) {
  // stdout/stderr stämplas med seq och buffras för attach-replay.
  if (obj.type === 'stdout' || obj.type === 'stderr') {
    obj.seq = ++entry.outSeq;
    pushReplay(entry, obj);
  }
  const data = JSON.stringify(obj);
  for (const ws of entry.clients) {
    if (ws.readyState === ws.OPEN) ws.send(data);
  }
}

function registerSession(entry, sessionId) {
  if (!sessionId || entry.sessionId === sessionId) return;
  if (entry.sessionId) procsBySession.delete(entry.sessionId);
  const previous = procsBySession.get(sessionId);
  if (previous && previous !== entry && previous.child.exitCode === null) {
    // Två processer på samma transkript är aldrig rätt. Den nya vinner
    // (den har just tagit över Remote Control-sessionen); den gamla får gå
    // om ingen sitter på den.
    if (previous.clients.size === 0) {
      log(`session ${sessionId}: ersätter frikopplad pid ${previous.pid} med pid ${entry.pid}`);
      terminate(previous, 'ersatt av ny process');
    } else {
      log(`session ${sessionId}: VARNING två levande processer (pid ${previous.pid} med ${previous.clients.size} klient(er), pid ${entry.pid})`);
    }
  }
  entry.sessionId = sessionId;
  procsBySession.set(sessionId, entry);
  log(`pid ${entry.pid} ↔ session ${sessionId}`);
  // Tala om för anslutna klienter vilken session processen fick, så att de
  // kan återansluta med attach efter ett WS-tapp (mobil-backgrounding).
  broadcast(entry, { type: 'session', sessionId });
}

function terminate(entry, reason) {
  if (entry.child.exitCode !== null || entry.child.killed) return;
  log(`avslutar pid ${entry.pid} (${entry.sessionId || 'ingen session'}): ${reason}`);
  entry.child.kill('SIGTERM');
  const c = entry.child;
  setTimeout(() => {
    if (c.exitCode === null) c.kill('SIGKILL');
  }, 5000).unref();
}

function forgetProc(entry) {
  allProcs.delete(entry);
  if (entry.sessionId && procsBySession.get(entry.sessionId) === entry) {
    procsBySession.delete(entry.sessionId);
  }
}

function attachClient(entry, ws) {
  entry.clients.add(ws);
  entry.detachedAt = null;
  entry.lastActivity = Date.now();
}

/** Kopplar loss en klient. Processen lever vidare (om den har en session). */
function detachClient(entry, ws, reason) {
  if (!entry.clients.delete(ws)) return;
  if (entry.clients.size === 0) entry.detachedAt = Date.now();
  const alive = entry.child.exitCode === null && !entry.child.killed;
  if (!alive) return;
  if (!entry.sessionId || entry.oneShot) {
    // Ingen session att fortsätta från, eller en engångsfråga → riktig kill.
    terminate(entry, `${reason} (ingen delbar session)`);
    return;
  }
  log(`klient frikopplad från pid ${entry.pid} (session ${entry.sessionId}): ${reason}; ${entry.clients.size} kvar`);
}

function handleStdoutLine(entry, line) {
  entry.lastActivity = Date.now();
  if (line.length > 0 && line.charCodeAt(0) === 123 /* { */) {
    // Billig titt efter init utan att parsa varje rad fullt ut.
    if (line.includes('"subtype":"init"') && line.includes('"session_id"')) {
      try {
        const m = JSON.parse(line);
        if (m && m.type === 'system' && m.subtype === 'init' && typeof m.session_id === 'string') {
          registerSession(entry, m.session_id);
        }
      } catch { /* ofullständig/ogiltig rad — ignorera */ }
    }
  }
  if (DEBUG_PROTO) log(`[proto] stdout (pid=${entry.pid}): ${line.slice(0, 120)}`);
  broadcast(entry, { type: 'stdout', data: Buffer.from(line + '\n', 'utf8').toString('base64') });
}

function spawnProc(args, cwd, env, meta) {
  log(`spawn: ${CLAUDE_BIN} ${args.join(' ')} (cwd=${cwd})`);
  const child = spawn(CLAUDE_BIN, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const entry = createProcEntry(child, meta);
  child.on('error', (err) => broadcast(entry, { type: 'error', message: `processfel: ${err.message}` }));
  child.stdout.on('data', (d) => {
    entry.stdoutBuf += d.toString('utf8');
    let idx;
    while ((idx = entry.stdoutBuf.indexOf('\n')) >= 0) {
      const line = entry.stdoutBuf.slice(0, idx);
      entry.stdoutBuf = entry.stdoutBuf.slice(idx + 1);
      handleStdoutLine(entry, line);
    }
  });
  child.stderr.on('data', (d) => {
    if (DEBUG_PROTO) log(`[proto] stderr ${d.length}B (pid=${entry.pid}): ${d.toString('utf8').slice(0, 200).replace(/\n/g, '\\n')}`);
    broadcast(entry, { type: 'stderr', data: d.toString('base64') });
  });
  child.on('exit', (code, signal) => {
    log(`process ${entry.pid} avslutad: code=${code} signal=${signal} (session ${entry.sessionId || '-'}, ${entry.clients.size} klient(er))`);
    if (entry.stdoutBuf.length > 0) {
      broadcast(entry, { type: 'stdout', data: Buffer.from(entry.stdoutBuf, 'utf8').toString('base64') });
      entry.stdoutBuf = '';
    }
    broadcast(entry, { type: 'exit', code, signal });
    forgetProc(entry);
  });
  return entry;
}

function describeProc(entry) {
  return {
    pid: entry.pid,
    sessionId: entry.sessionId,
    clients: entry.clients.size,
    idleMs: Date.now() - entry.lastActivity,
    detachedMs: entry.detachedAt ? Date.now() - entry.detachedAt : null,
    startedAt: entry.startedAt,
    oneShot: entry.oneShot,
  };
}

// Reaper: städa frikopplade processer som varit tysta länge, och håll antalet
// frikopplade under MAX_DETACHED (äldst inaktiva först).
setInterval(() => {
  const now = Date.now();
  const detached = [...allProcs]
    .filter((e) => e.clients.size === 0 && e.child.exitCode === null)
    .sort((a, b) => a.lastActivity - b.lastActivity);
  for (const entry of detached) {
    if (now - entry.lastActivity > DETACH_TTL_MS) {
      terminate(entry, `inaktiv i ${Math.round((now - entry.lastActivity) / 60000)} min`);
    }
  }
  const stillDetached = detached.filter((e) => e.child.exitCode === null && !e.child.killed);
  while (stillDetached.length > MAX_DETACHED) {
    terminate(stillDetached.shift(), `fler än ${MAX_DETACHED} frikopplade`);
  }
}, 60 * 1000).unref();

const httpServer = http.createServer((req, res) => {
  handleHttp(req, res).catch((err) => {
    log(`http-fel: ${err && err.message}`);
    try { sendJson(res, 500, { error: 'internal' }); } catch { /* redan stängd */ }
  });
});

const wss = new WebSocketServer({ server: httpServer });

httpServer.listen(PORT, HOST, () => log(`bridge lyssnar på ws+http://${HOST}:${PORT}, CLAUDE_BIN=${CLAUDE_BIN}`));

wss.on('connection', (ws, req) => {
  const peer = req.socket.remoteAddress;
  if (!hasValidToken(req.url)) {
    log(`avvisad anslutning från ${peer}: fel/saknad token`);
    ws.close(4001, 'unauthorized');
    return;
  }
  log(`anslutning från ${peer}`);
  /** @type {ProcEntry|null} processen denna anslutning sitter på */
  let entry = null;

  const send = (obj) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  };

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      send({ type: 'error', message: 'ogiltig JSON' });
      return;
    }

    if (msg.type === 'start') {
      if (entry) {
        send({ type: 'error', message: 'process redan startad på denna anslutning' });
        return;
      }
      const args = Array.isArray(msg.args) ? msg.args.map(String) : [];
      const cwd = mapPath(msg.cwd) || PATH_MAP_TO;
      const env = buildEnv(msg.env);
      const meta = parseStartArgs(args);

      const live = meta.resumeId && !meta.fork ? procsBySession.get(meta.resumeId) : null;
      if (live && live.child.exitCode === null && !live.child.killed) {
        entry = live;
        attachClient(entry, ws);
        log(`attach: klient ${peer} → pid ${entry.pid} (session ${entry.sessionId}, ${entry.clients.size} klient(er))`);
        // seq ger klienten en baslinje så en senare reattach inte får gammal
        // replay från tiden före denna anslutning.
        send({ type: 'started', pid: entry.pid, attached: true, sessionId: entry.sessionId, seq: entry.outSeq });
        return;
      }

      try {
        entry = spawnProc(args, cwd, env, meta);
      } catch (err) {
        send({ type: 'error', message: `spawn misslyckades: ${err.message}` });
        return;
      }
      attachClient(entry, ws);
      if (entry.child.pid) {
        send({ type: 'started', pid: entry.child.pid });
      } else {
        entry.child.once('spawn', () => send({ type: 'started', pid: entry.child.pid }));
      }
      return;
    }

    // Återanslutning efter WS-tapp (mobil-backgrounding): klienten anger sin
    // session och det högsta seq den sett; bryggan spelar upp resten.
    if (msg.type === 'attach') {
      if (entry) {
        send({ type: 'error', message: 'process redan startad på denna anslutning' });
        return;
      }
      const sessionId = typeof msg.sessionId === 'string' ? msg.sessionId : null;
      const sinceSeq = Number.isFinite(Number(msg.sinceSeq)) ? Number(msg.sinceSeq) : 0;
      const live = sessionId ? procsBySession.get(sessionId) : null;
      if (!live || live.child.exitCode !== null || live.child.killed) {
        send({ type: 'attach_failed', message: `ingen levande process för session ${sessionId || '?'}` });
        return;
      }
      entry = live;
      attachClient(entry, ws);
      send({ type: 'started', pid: entry.pid, attached: true, sessionId, seq: entry.outSeq });
      let replayed = 0;
      for (const item of entry.replay) {
        if (item.seq > sinceSeq) {
          send(item.frame);
          replayed += 1;
        }
      }
      log(`reattach: klient ${peer} → pid ${entry.pid} (session ${sessionId}, sinceSeq=${sinceSeq}, replay=${replayed}, ${entry.clients.size} klient(er))`);
      return;
    }

    if (msg.type === 'stdin') {
      const buf = Buffer.from(String(msg.data), 'base64');
      if (DEBUG_PROTO) log(`[proto] stdin ${buf.length}B (pid=${entry?.pid})`);
      if (entry) {
        entry.lastActivity = Date.now();
        if (entry.child.stdin.writable) entry.child.stdin.write(buf);
      }
      return;
    }

    if (msg.type === 'stdin_end') {
      if (DEBUG_PROTO) log(`[proto] stdin_end (pid=${entry?.pid})`);
      // Bara en ensam klient får stänga processens stdin (engångsfrågor).
      // På en delad process betyder det "jag är klar" → koppla loss.
      if (entry) {
        if (entry.clients.size <= 1 && (entry.oneShot || !entry.sessionId)) {
          entry.child.stdin.end();
        } else {
          detachClient(entry, ws, 'stdin_end');
          send({ type: 'exit', code: null, signal: 'SIGTERM' });
          entry = null;
        }
      }
      return;
    }

    if (msg.type === 'kill') {
      if (DEBUG_PROTO) log(`[proto] kill ${msg.signal || 'SIGTERM'} (pid=${entry?.pid})`);
      if (entry) {
        const e = entry;
        entry = null;
        detachClient(e, ws, `kill ${msg.signal || 'SIGTERM'} från klient`);
        // Klienten (SDK:t) väntar på exit för att städa — svara som om
        // processen dog, även när den bara frikopplades.
        send({ type: 'exit', code: null, signal: msg.signal || 'SIGTERM' });
      }
      return;
    }

    // Keepalive: Cloudflare-kanten stänger tysta WebSockets (~100 s). Klienten
    // pingar var 30:e sekund; svaret håller trafik i båda riktningarna.
    if (msg.type === 'ping') {
      send({ type: 'pong' });
      return;
    }

    if (msg.type === 'clientlog') {
      log(`[client ${peer}] ${String(msg.message).slice(0, 2000)}`);
      return;
    }

    send({ type: 'error', message: `okänd meddelandetyp: ${msg.type}` });
  });

  ws.on('close', () => {
    log(`anslutning stängd (${peer})`);
    if (entry) {
      const e = entry;
      entry = null;
      detachClient(e, ws, 'anslutning stängd');
    }
  });
});
