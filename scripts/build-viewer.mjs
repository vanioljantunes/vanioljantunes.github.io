/* Builds the DICOM viewer bundle for /imaging/viewer/.
 *
 * The site has no build step and no bundler; this one page is the exception, because
 * Cornerstone3D ships a web worker and four Emscripten codecs that cannot be loaded
 * sensibly from a CDN import map.
 *
 * Three kinds of output, all into imaging/viewer/ next to index.html:
 *
 *   app.js                     the page bundle, ES module
 *   decodeImageFrameWorker.js  the decode worker, bundled separately
 *   *.wasm                     the codec binaries
 *
 * They must sit beside each other. @cornerstonejs/dicom-image-loader resolves the worker
 * as `new URL('./decodeImageFrameWorker.js', import.meta.url)`, which inside the bundle
 * means "next to app.js"; the Emscripten codecs then resolve their .wasm relative to the
 * worker script. Moving the bundle to /js/ would scatter eight binaries through the folder
 * that holds the site's hand-written modules, so the whole thing stays under the page.
 */

import * as esbuild from 'esbuild';
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'imaging', 'viewer');
const chdDir = join(root, 'imaging', 'chd');
const watch = process.argv.includes('--watch');

/* The decode worker is a second entry point rather than part of the main bundle: it runs in
   a Worker scope, so it cannot share a module graph with code that touches `document`. */
const WORKER_ENTRY = join(
  root,
  'node_modules',
  '@cornerstonejs',
  'dicom-image-loader',
  'dist',
  'esm',
  'decodeImageFrameWorker.js'
);

/* Emscripten builds locate their .wasm relative to the script that instantiates them, so
   every codec binary is copied flat into the output directory. */
const CODEC_PACKAGES = [
  'codec-charls',
  'codec-libjpeg-turbo-8bit',
  'codec-openjpeg',
  'codec-openjph',
];

/* The Emscripten codecs are built for both Node and the browser, so their glue code calls
   require('fs') and require('path') inside an `if (ENVIRONMENT_IS_NODE)` branch. In a
   browser that branch never runs, but esbuild still has to resolve the imports, and there
   is no fs in a browser. Stubbing them to an empty module drops the dead branch without
   patching vendor code. If a codec ever really reached for the filesystem at runtime it
   would throw on the empty object, which is the correct outcome rather than a silent one. */
const stubNodeBuiltins = {
  name: 'stub-node-builtins',
  setup(build) {
    const builtins = /^(fs|path|crypto|os|url|worker_threads)$/;
    build.onResolve({ filter: builtins }, (args) => ({
      path: args.path,
      namespace: 'node-stub',
    }));
    build.onLoad({ filter: /.*/, namespace: 'node-stub' }, () => ({
      contents: 'export default {};',
      loader: 'js',
    }));
  },
};

/* The codecs locate their own .wasm with `new URL('@cornerstonejs/codec-charls/decodewasm',
   import.meta.url)`. esbuild does not resolve a bare specifier inside new URL(), so it is
   left verbatim and the browser resolves it against the page: a page at /imaging/chd/ asks
   for /imaging/chd/@cornerstonejs/codec-charls/decodewasm and gets the 404 page, which then
   fails to compile as WebAssembly with "expected magic word". Rewriting each specifier to
   the plain filename makes it resolve next to the bundle, which is exactly where the binary
   is copied. The viewer never hit this because the archive hands it transfer syntaxes these
   three decoders are not asked for. */
const CODEC_URLS = {
  '@cornerstonejs/codec-charls/decodewasm': 'charlswasm_decode.wasm',
  '@cornerstonejs/codec-openjpeg/decodewasm': 'openjpegwasm_decode.wasm',
  '@cornerstonejs/codec-openjph/wasm': 'openjphjs.wasm',
  '@cornerstonejs/codec-libjpeg-turbo-8bit/decodewasm': 'libjpegturbowasm_decode.wasm',
};

const pointCodecsAtNeighbours = {
  name: 'codec-wasm-paths',
  setup(build) {
    build.onEnd(async () => {
      const outfile = build.initialOptions.outfile;
      if (!outfile) return;
      let source = await readFile(outfile, 'utf8');
      let changed = 0;
      for (const [specifier, filename] of Object.entries(CODEC_URLS)) {
        const parts = source.split(specifier);
        if (parts.length > 1) {
          changed += parts.length - 1;
          source = parts.join(filename);
        }
      }
      if (changed) await writeFile(outfile, source);
    });
  },
};

const shared = {
  bundle: true,
  plugins: [stubNodeBuiltins, pointCodecsAtNeighbours],
  format: 'esm',
  target: ['es2022'],
  /* Sourcemaps only while watching: the production map is 6.4 MB, far larger than the
     bundle, and it would be committed to a repo that is otherwise hand-written text. */
  sourcemap: watch,
  minify: !watch,
  logLevel: 'info',
  /* Cornerstone reads process.env.NODE_ENV in a few places; nothing polyfills it here. */
  define: { 'process.env.NODE_ENV': watch ? '"development"' : '"production"' },
};

async function copyCodecs(target, label) {
  let copied = 0;
  for (const pkg of CODEC_PACKAGES) {
    const dist = join(root, 'node_modules', '@cornerstonejs', pkg, 'dist');
    let entries;
    try {
      entries = await readdir(dist);
    } catch {
      throw new Error(`codec package ${pkg} is missing its dist/ - run npm install`);
    }
    for (const name of entries) {
      if (!name.endsWith('.wasm')) continue;
      const from = join(dist, name);
      if (!(await stat(from)).isFile()) continue;
      await cp(from, join(target, name));
      copied += 1;
    }
  }
  if (copied === 0) throw new Error('no codec .wasm files found - run npm install');
  console.log(`copied ${copied} codec wasm files into ${label}`);
}

async function main() {
  await mkdir(outDir, { recursive: true });
  await mkdir(chdDir, { recursive: true });
  await copyCodecs(outDir, 'imaging/viewer/');
  await copyCodecs(chdDir, 'imaging/chd/');

  const app = {
    ...shared,
    entryPoints: [join(root, 'imaging', 'viewer', 'src', 'main.ts')],
    outfile: join(outDir, 'app.js'),
  };

  /* The congenital heart page is a second entry point, with its own copy of the bundle, the
     decode worker and the codec binaries under its own folder. That duplicates 2.3 MB, and
     it is deliberate: the Emscripten codecs resolve their .wasm against the page that loads
     them, not against the worker, so a page at /imaging/chd/ asks for
     /imaging/chd/charlswasm_decode.wasm no matter where the bundle came from. Sharing one
     copy would mean every new page serving 404s for the decoders. */
  const chd = {
    ...shared,
    entryPoints: [join(root, 'imaging', 'chd', 'src', 'main.ts')],
    outfile: join(chdDir, 'app.js'),
  };

  const chdWorker = {
    ...shared,
    entryPoints: [WORKER_ENTRY],
    outfile: join(chdDir, 'decodeImageFrameWorker.js'),
  };

  const worker = {
    ...shared,
    entryPoints: [WORKER_ENTRY],
    outfile: join(outDir, 'decodeImageFrameWorker.js'),
  };

  if (watch) {
    for (const options of [app, chd, worker, chdWorker]) {
      const ctx = await esbuild.context(options);
      await ctx.watch();
    }
    console.log('watching imaging/viewer/src and imaging/chd/src for changes');
    return;
  }

  await Promise.all([
    esbuild.build(app),
    esbuild.build(chd),
    esbuild.build(worker),
    esbuild.build(chdWorker),
  ]);
  console.log('built imaging/viewer/ and imaging/chd/, each with its bundle and worker');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
