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
  const stats = require('fs').statSync('app.js');
  console.log(`✓ Built app.js — ${(stats.size / 1024).toFixed(1)} KB`);
}).catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
