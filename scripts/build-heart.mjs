/* Builds the beating-heart viewer bundle for /imaging/heart/.
 *
 * Same arrangement as build-viewer.mjs: the site itself has no build step, so the bundle is
 * built here and committed. three.js is the reason this page needs one at all, since its
 * example modules (GLTFLoader, OrbitControls) are not usable as bare imports in a browser.
 */
import * as esbuild from 'esbuild';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');

const options = {
  entryPoints: [join(root, 'imaging', 'heart', 'src', 'main.ts')],
  outfile: join(root, 'imaging', 'heart', 'app.js'),
  bundle: true,
  format: 'esm',
  target: ['es2022'],
  minify: !watch,
  sourcemap: false,
  logLevel: 'info',
};

if (watch) {
  const context = await esbuild.context(options);
  await context.watch();
  console.log('watching imaging/heart/src');
} else {
  await esbuild.build(options);
}
