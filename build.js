// build.js — pre-compile src/app.jsx to app.js so the browser doesn't run
// Babel-Standalone at runtime. Eliminates the 500KB deopt threshold issue.
//
// Run: `npm run build` (or `node build.js` after npm install)
//
// React, ReactDOM, and supabase are loaded as CDN globals from index.html,
// so we don't bundle them — bundle: false. esbuild handles JSX → JS.

const esbuild = require('esbuild');

esbuild.build({
  entryPoints: ['src/app.jsx'],
  outfile: 'app.js',
  bundle: false,
  minify: true,
  target: 'es2020',
  loader: { '.jsx': 'jsx' },
  jsx: 'transform',         // produces React.createElement calls (matches what Babel was doing)
  jsxFactory: 'React.createElement',
  jsxFragment: 'React.Fragment',
  legalComments: 'none',
  logLevel: 'info',
}).then(() => {
  const fs = require('fs');
  const crypto = require('crypto');
  const stats = fs.statSync('app.js');

  // Cache-bust: stamp index.html's `app.js?v=…` with a content hash of the
  // freshly-built bundle. Previously this was a hand-typed static string
  // (`?v=20260505i`) that nobody remembered to bump — so every deploy reused
  // the same URL and browsers kept serving the OLD app.js from cache. Operators
  // keep the DCC tab open all day (it auto-refreshes DATA, never the JS), so a
  // fix could be live for days while they still ran a months-old bundle. The
  // 2026-06-03 "Kill button still broken" report was exactly this. Now the URL
  // changes whenever the bundle changes, and the in-app version checker (see
  // VersionWatcher in src/app.jsx) reads this token to detect a new deploy.
  const hash = crypto.createHash('sha256').update(fs.readFileSync('app.js')).digest('hex').slice(0, 12);
  const html = fs.readFileSync('index.html', 'utf8');
  const stamped = html.replace(/app\.js\?v=[^"']*/g, `app.js?v=${hash}`);
  if (stamped !== html) {
    fs.writeFileSync('index.html', stamped);
    console.log(`✓ Stamped index.html → app.js?v=${hash}`);
  } else {
    console.log(`✓ index.html already at app.js?v=${hash}`);
  }
  console.log(`✓ Built app.js — ${(stats.size / 1024).toFixed(1)} KB`);
}).catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
