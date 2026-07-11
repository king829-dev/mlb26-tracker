// Builds src/app.html (the served dashboard) from app/app.jsx + app/template.html.
// The JSX is compiled and bundled together with React at build time — the served page has no
// CDN dependencies and no in-browser Babel compile step. Run via `npm run build` in worker/
// after editing anything under app/, then commit the regenerated src/app.html (it's checked in
// so `wrangler deploy` keeps working with no build step for people who don't touch the UI).
import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

const result = await build({
  entryPoints: [join(root, 'app', 'app.jsx')],
  bundle: true,
  minify: true,
  format: 'iife',
  jsx: 'automatic',
  target: ['es2018'],
  define: { 'process.env.NODE_ENV': '"production"' },
  write: false,
  legalComments: 'none',
});

// Escape any </script> inside the bundle (only ever inside string/regex literals, where
// <\/script> is equivalent) so it can't terminate the inline <script> tag early.
const js = result.outputFiles[0].text.replace(/<\/script>/gi, '<\\/script>');

const template = readFileSync(join(root, 'app', 'template.html'), 'utf8');
if (!template.includes('<!--APP_JS-->')) {
  throw new Error('app/template.html is missing the <!--APP_JS--> placeholder');
}
const banner = '<!-- GENERATED FILE — built from worker/app/ by `npm run build`. Edit app/app.jsx or app/template.html instead. -->\n';
const html = banner + template.replace('<!--APP_JS-->', () => '<script>' + js + '</script>');

const out = join(root, 'src', 'app.html');
writeFileSync(out, html);
console.log(`built ${out} (${(html.length / 1024).toFixed(0)} KB, bundle ${(js.length / 1024).toFixed(0)} KB)`);
