# Claudian Remote — Obsidian mobile & browser support

This fork of [Claudian](https://github.com/YishenTu/claudian) makes the plugin
work where `child_process` does not exist: **Obsidian on iOS/iPadOS/Android**
and **Obsidian-in-browser** setups (e.g. Ignis). The Claude Code CLI runs on a
host machine behind a small WebSocket bridge; the plugin becomes a thin client
that streams stdio over the network. Everything else — the chat UI, tools,
sessions, history — is unchanged upstream Claudian.

```
Obsidian mobile / browser (this plugin, installed via BRAT)
   └── wss://<your-host>  (TLS, private network only)
         └── bridge/server.js  — spawns `claude` with your vault as cwd
```

File edits made by the agent land on the host's copy of the vault and reach
your device through whatever vault sync you already run (the reference setup
uses Obsidian LiveSync/CouchDB).

## What the fork adds

- **Remote runtime detection** — on mobile (or with a configured bridge URL)
  the plugin spawns through the bridge instead of `child_process`.
- **Browser build** (`node esbuild.ignis.mjs <outdir>`) — Node builtins are
  shimmed or stubbed so the bundle runs in a plain webview: real
  implementations for `path`/`crypto` (sync SHA-1/SHA-256)/`util`/`fs`-over-
  bridge, loud throw-on-use stubs for `child_process`/`net`/`tls`/`http(s)`.
- **Reconnect with replay** — mobile OSes drop the WebSocket on every
  backgrounding. The bridge buffers output with sequence numbers; the client
  reattaches with `sinceSeq` and receives exactly what it missed, with
  exponential backoff and a visibility-change fast path. No error dialogs for
  routine app switches.
- **Per-device bridge settings** — URL + token live in `localStorage`, never
  in `data.json`, so secrets never travel through vault sync. Configure them
  under *Settings → Claudian → Remote bridge* or with the command
  **"Configure remote bridge"** (fastest path on a phone).

## Setup

1. **Host**: install the bridge — see [`bridge/README.md`](bridge/README.md).
   Put TLS in front (mobile webviews block plaintext `ws://`) and keep it
   reachable only on your private network (Tailscale or similar).
2. **Device**: install [BRAT](https://github.com/TfTHacker/obsidian42-brat)
   from the community plugin store, then *Add beta plugin* →
   `williampzetterlund-sudo/claudian-remote`.
3. **Connect**: run the command **"Configure remote bridge"**, enter
   `wss://<your-host>` (or `wss://<host>/claudian-bridge` for a path route)
   and the bridge token, press **Test** — you should see the host-side vault
   root. Open the Claudian view and chat.

## Security model

The bridge executes a CLI with the host account's full permissions. The token
gates every request, but the real boundary is the network: bind it to a
private overlay network and never publish it to the internet. Release builds
never contain a token; the local-deploy convenience flag
(`CLAUDIAN_BAKE_TOKEN=1`) exists only for same-host browser setups.

## Building locally

```bash
npm install
node scripts/build-css.mjs
node esbuild.ignis.mjs dist        # browser/mobile bundle → dist/
npm run build                      # regular desktop build (unchanged)
```

Releases are produced by `.github/workflows/release.yml` on version tags and
contain `main.js`, `manifest.json`, `styles.css` — exactly what BRAT needs.

## Credits

All the heavy lifting is [YishenTu/claudian](https://github.com/YishenTu/claudian)
(MIT). This fork only teaches it to phone home.
