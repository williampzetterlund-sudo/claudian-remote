// Ignis (browser) build of Claudian. Ignis runs Obsidian in the browser with
// a partial Node shim registry; this build aliases the gaps to real browser
// shims in src/ignis-shims/, injects a working Buffer/process, and skips the
// Brotli-compressed static assets (no zlib in the browser). The Claude CLI is
// reached through the WebSocket bridge (see remoteSpawn.ts), so child_process
// and friends stay external and resolve to the Ignis throwing stubs.
//
// Usage: node esbuild.ignis.mjs [deployDir]
//   deployDir defaults to $IGNIS_PLUGIN_DIR; when set, main.js, manifest.json,
//   and styles.css are copied there after a successful build.
import esbuild from 'esbuild';
import { builtinModules } from 'node:module';
import path from 'path';
import process from 'process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import rendererSafeUnrefHelpers from './scripts/rendererSafeUnref.js';
import sourcePackageAliasHelpers from './scripts/sourcePackageAliases.js';
import pierreShikiBundleHelpers from './scripts/pierreShikiBundle.js';
import patchSdkImportMetaHelpers from './scripts/patchSdkImportMeta.js';

const {
  findUnsafeTimerUnrefSites,
  patchRendererUnsafeUnrefSites,
} = rendererSafeUnrefHelpers;
const { createSourcePackageAliases } = sourcePackageAliasHelpers;
const { createPierreShikiBundlePlugin } = pierreShikiBundleHelpers;
const { patchSdkImportMeta } = patchSdkImportMetaHelpers;
const { promises: fsPromises } = await import('fs');

const shimDirectory = path.join(process.cwd(), 'src', 'ignis-shims');

// Modules the SDK or Claudian need real behavior for in the browser.
// path/crypto/util used to pass through to the Ignis window.require registry,
// but Obsidian mobile has no registry — the bundle carries its own shims so
// one build serves both environments.
const shimmedModules = {
  events: 'events.js',
  stream: 'stream.js',
  readline: 'readline.js',
  string_decoder: 'string_decoder.js',
  os: 'os.js',
  url: 'url.js',
  module: 'module.js',
  async_hooks: 'async_hooks.js',
  zlib: 'zlib.js',
  fs: 'fs.js',
  'fs/promises': 'fs-promises.js',
  process: 'process.js',
  buffer: 'buffer.js',
  path: 'path.js',
  crypto: 'crypto.js',
  util: 'util.js',
  // Loud stubs: require() succeeds (mobile has no registry to fall back on),
  // any actual use throws. These are only reached on desktop code paths.
  child_process: 'stubs/child_process.js',
  net: 'stubs/net.js',
  tls: 'stubs/tls.js',
  http: 'stubs/http.js',
  https: 'stubs/https.js',
  dgram: 'stubs/dgram.js',
  sqlite: 'stubs/sqlite.js',
};

const shimAliases = {};
for (const [name, file] of Object.entries(shimmedModules)) {
  const target = path.join(shimDirectory, file);
  shimAliases[name] = target;
  shimAliases[`node:${name}`] = target;
}

// Everything else Node-flavored stays external and resolves through the Ignis
// window.require registry (path/crypto/util are real there; child_process,
// net, and http are stubs that fail loudly on use).
const passthroughBuiltins = builtinModules.filter((name) => !(name in shimmedModules));

const external = [
  'obsidian',
  'electron',
  '@codemirror/autocomplete',
  '@codemirror/collab',
  '@codemirror/commands',
  '@codemirror/language',
  '@codemirror/lint',
  '@codemirror/search',
  '@codemirror/state',
  '@codemirror/view',
  '@lezer/common',
  '@lezer/highlight',
  '@lezer/lr',
  ...passthroughBuiltins,
  ...passthroughBuiltins.map((name) => `node:${name}`),
];

function readBridgeToken() {
  const tokenFile = process.env.CLAUDIAN_BRIDGE_TOKEN_FILE
    ?? path.join(process.env.HOME ?? '', 'claudian-ignis', 'bridge', '.env');
  try {
    if (existsSync(tokenFile)) {
      const match = readFileSync(tokenFile, 'utf8').match(/^BRIDGE_TOKEN=(.+)$/m);
      if (match) return match[1].trim();
    }
  } catch {
    // Token stays empty; the bridge then runs without auth enforcement.
  }
  return '';
}

const patchRendererUnsafeUnref = {
  name: 'patch-renderer-unsafe-unref',
  setup(build) {
    build.onEnd(async (result) => {
      if (result.errors.length > 0) return;
      const bundlePath = path.join(process.cwd(), 'main.js');
      if (!existsSync(bundlePath)) return;
      const originalContents = await fsPromises.readFile(bundlePath, 'utf8');
      const patchedBundle = patchRendererUnsafeUnrefSites(originalContents);
      if (patchedBundle.contents !== originalContents) {
        await fsPromises.writeFile(bundlePath, patchedBundle.contents, 'utf8');
      }
      const unsafeMatches = findUnsafeTimerUnrefSites(patchedBundle.contents);
      if (unsafeMatches.length > 0) {
        const details = unsafeMatches
          .slice(0, 5)
          .map((match) => `line ${match.line}: ${match.snippet}`)
          .join('\n');
        throw new Error(`Renderer-unsafe timer .unref() calls remain in main.js:\n${details}`);
      }
    });
  },
};

const deployDirectory = process.argv[2] ?? process.env.IGNIS_PLUGIN_DIR ?? null;

// Körs EFTER minifieringspasset — kopiering som onEnd-plugin skulle skeppa
// den ominifierade bundeln.
function deployToDirectory() {
  if (!deployDirectory) return;
  if (!existsSync(deployDirectory)) {
    mkdirSync(deployDirectory, { recursive: true });
  }
  for (const file of ['main.js', 'styles.css']) {
    if (existsSync(file)) {
      copyFileSync(file, path.join(deployDirectory, file));
      console.log(`Copied ${file} to ${deployDirectory}`);
    }
  }
  // Ignis ships Obsidian 1.12.x and reports Platform.isMobile, so both the
  // desktop version gate (1.13.0) and isDesktopOnly would silently skip
  // the plugin.
  const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
  manifest.minAppVersion = '1.12.0';
  manifest.isDesktopOnly = false;
  writeFileSync(
    path.join(deployDirectory, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  console.log(`Copied manifest.json (minAppVersion 1.12.0) to ${deployDirectory}`);
}

const context = await esbuild.context({
  entryPoints: ['src/main.ts'],
  alias: {
    ws: path.join(shimDirectory, 'ws.js'),
    ...createSourcePackageAliases(),
    ...shimAliases,
  },
  inject: [path.join(shimDirectory, 'inject-globals.js')],
  define: {
    // Baking the token is a LOCAL deploy convenience only (Ignis on the same
    // host as the bridge). Release builds must never carry it — the plugin
    // reads the token from localStorage via the settings UI instead.
    CLAUDIAN_BRIDGE_TOKEN: JSON.stringify(
      process.env.CLAUDIAN_BAKE_TOKEN === '1' ? readBridgeToken() : '',
    ),
  },
  banner: {
    js: "var __filename='/plugins/realclaudian/main.js';var __dirname='/plugins/realclaudian';",
  },
  bundle: true,
  plugins: [
    patchSdkImportMeta,
    createPierreShikiBundlePlugin(),
    patchRendererUnsafeUnref,

  ],
  external,
  format: 'cjs',
  loader: { '.wasm': 'binary' },
  // safari16: äldre mobil-JavaScriptCore kastar SyntaxError på hela bundeln
  // för es2022-syntax (static blocks m.m.) — Obsidian visar det bara som
  // "failed to load plugin". Regex-lookbehind kan esbuild inte transpilera;
  // de kräver iOS 16.4+.
  target: ['es2022', 'safari16'],
  charset: 'utf8',
  logLevel: 'info',
  // OBS: minifieringen sker i ett SEPARAT pass efter rebuild — patch-plugins
  // (patchSdkImportMeta m.fl.) matchar bara ominifierad utskrift.
  minify: false,
  sourcemap: false,
  treeShaking: true,
  outfile: 'main.js',
});

await context.rebuild();
await context.dispose();

// Minifieringspass på den redan patchade bundeln. Separat steg med flit:
// patch-plugins (patchSdkImportMeta, rendererSafeUnref) matchar bara
// ominifierad esbuild-utskrift, så ordningen är bundla → patcha → minifiera.
// keepNames skyddar kod som läser function-/klassnamn i runtime.
// CLAUDIAN_MINIFY: 'off' | 'ws' | 'syntax' | 'full' (default full)
const minifyMode = process.env.CLAUDIAN_MINIFY ?? 'full';
if (minifyMode !== 'off') {
  await esbuild.build({
    entryPoints: ['main.js'],
    outfile: 'main.js',
    allowOverwrite: true,
    bundle: false,
    minifyWhitespace: true,
    minifySyntax: minifyMode === 'syntax' || minifyMode === 'full',
    minifyIdentifiers: minifyMode === 'full',
    keepNames: process.env.CLAUDIAN_KEEPNAMES !== '0',
    target: ['es2022', 'safari16'],
    charset: 'utf8',
    logLevel: 'info',
  });
}

deployToDirectory();
process.exit(0);
