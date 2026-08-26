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

const deployToIgnis = {
  name: 'deploy-to-ignis',
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length > 0 || !deployDirectory) return;
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
    });
  },
};

const context = await esbuild.context({
  entryPoints: ['src/main.ts'],
  alias: {
    ws: path.join(shimDirectory, 'ws.js'),
    ...createSourcePackageAliases(),
    ...shimAliases,
  },
  inject: [path.join(shimDirectory, 'inject-globals.js')],
  define: {
    CLAUDIAN_BRIDGE_TOKEN: JSON.stringify(readBridgeToken()),
  },
  banner: {
    js: "var __filename='/plugins/realclaudian/main.js';var __dirname='/plugins/realclaudian';",
  },
  bundle: true,
  plugins: [
    patchSdkImportMeta,
    createPierreShikiBundlePlugin(),
    patchRendererUnsafeUnref,
    deployToIgnis,
  ],
  external,
  format: 'cjs',
  loader: { '.wasm': 'binary' },
  target: 'es2022',
  charset: 'utf8',
  logLevel: 'info',
  minify: false,
  sourcemap: false,
  treeShaking: true,
  outfile: 'main.js',
});

await context.rebuild();
await context.dispose();
process.exit(0);
