# Claudian bridge

A small WebSocket + HTTP server that spawns the Claude Code CLI on a host
machine and relays its stdio to remote Claudian clients — Obsidian on
iOS/Android, or Obsidian-in-browser setups (Ignis). The client never chooses
the command: the bridge always runs its own configured `CLAUDE_BIN`.

```
Obsidian mobile (plugin)                     Host (this bridge)
  wss://<your-host>/…  ── TLS proxy ──▶  server.js :8095 ──▶ claude CLI
                                             │                (cwd = vault)
                                             └ HTTP: /config, /fs/* (read-only)
```

## Features

- **Detached processes**: a client that disconnects (phone locks, tab closes)
  only detaches — the CLI keeps running and can be re-attached. Idle detached
  processes are reaped after `BRIDGE_DETACH_TTL_MS` (default 8 h).
- **Reattach with replay**: output frames carry sequence numbers and are
  buffered per process. A reconnecting client sends
  `{type:'attach', sessionId, sinceSeq}` and receives exactly what it missed.
- **Read-only fs API**: `/config` reports the vault root and readable roots;
  `/fs/stat|readdir|read` serve transcript/history files to the client.
- **Token auth**: set `BRIDGE_TOKEN` and every WS/HTTP request must carry
  `?token=<value>`.

## Install

```bash
cd bridge
npm install
cp claudian-bridge.service.example ~/.config/systemd/user/claudian-bridge.service
# create .env (chmod 600):
cat > .env << 'EOF'
BRIDGE_TOKEN=<long random string>
BRIDGE_HOST=0.0.0.0
PATH_MAP_FROM=/
PATH_MAP_TO=/absolute/path/to/your/vault
EOF
systemctl --user daemon-reload
systemctl --user enable --now claudian-bridge
```

Environment variables (all optional except the ones above):

| Variable | Default | Meaning |
|---|---|---|
| `BRIDGE_PORT` | `8095` | Listen port (ws + http) |
| `BRIDGE_HOST` | `127.0.0.1` | Bind address |
| `BRIDGE_TOKEN` | *(empty = no auth)* | Required `?token=` value |
| `CLAUDE_BIN` | `~/.local/bin/claude` | CLI binary to spawn |
| `PATH_MAP_FROM` / `PATH_MAP_TO` | `/vaults` / `~/ignis/vaults` | Client→host path mapping; mobile clients send host paths, which pass through untouched |
| `BRIDGE_DETACH_TTL_MS` | 8 h | Reap detached processes after this idle time |
| `BRIDGE_MAX_DETACHED` | `8` | Max detached processes kept alive |
| `BRIDGE_REPLAY_MAX_FRAMES` / `BRIDGE_REPLAY_MAX_BYTES` | `5000` / 8 MB | Replay buffer per process |

## Exposing it (TLS is required for mobile)

Obsidian mobile runs in a webview where plaintext `ws://` is blocked as mixed
content. Put a TLS reverse proxy with a real certificate in front, reachable
only on your private network (Tailscale or similar). Caddy example:

```caddyfile
@bridge host bridge.example.com
handle @bridge {
    reverse_proxy 127.0.0.1:8095
}
```

The bridge strips a leading `/claudian-bridge` path prefix, so a path-based
route on an existing hostname works too. **Never expose the bridge to the
public internet** — it runs a CLI with your account's full permissions;
the token is a second lock, not a substitute for network isolation.

## Protocol (client ↔ server, JSON over WS)

Client → server: `start {args, cwd, env}` · `attach {sessionId, sinceSeq}` ·
`stdin {data:base64}` · `stdin_end` · `kill {signal}` · `ping` ·
`clientlog {message}`

HTTP (GET): `/config` · `/fs/stat|readdir|read?path=` (paths under the
declared read roots). HTTP (POST, scoped to the vault's `.claudian/` subtree
— session metadata and client settings): `/fs/write|append?path=` (body =
content) · `/fs/mkdir|remove?path=` · `/fs/rmdir?path=&recursive=1` ·
`/fs/rename?path=&to=`. Mobile clients share `.claudian/` with the host this
way, since hidden files do not travel through vault sync.

Server → client: `started {pid, attached?, sessionId?, seq?}` ·
`session {sessionId}` · `stdout|stderr {data:base64, seq}` ·
`exit {code, signal}` · `attach_failed {message}` · `pong` · `error {message}`
