#!/usr/bin/env node
// Build the password-gated pitch.html.
//
//   node scripts/build-pitch-gated.js <password>
//
// Reads pitch.source.html (the plaintext deck), encrypts it with AES-256-GCM
// using a password-derived key (PBKDF2-SHA256, 250k iterations), and writes
// pitch.html — a tiny shell that prompts for the password, decrypts the
// payload in the browser via WebCrypto, and document.write()s the result.
//
// pitch.source.html is gitignored. Keep it on the machine you edit from.
// If you lose it, recover from git commit f729e42 on the
// claude/vigilant-rubin-ee0426 branch.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PROJECT_ROOT = path.join(__dirname, '..');
const SOURCE = path.join(PROJECT_ROOT, 'pitch.source.html');
const TARGET = path.join(PROJECT_ROOT, 'pitch.html');

const ITERATIONS = 250000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const KEY_BYTES = 32;

const password = process.argv[2];
if (!password || password.length < 6) {
  console.error('Usage: node scripts/build-pitch-gated.js <password>');
  console.error('Password must be at least 6 chars.');
  process.exit(1);
}

if (!fs.existsSync(SOURCE)) {
  console.error('Missing ' + SOURCE);
  console.error('That file is the plaintext source. Restore it from git or your local copy.');
  process.exit(1);
}

const plaintext = fs.readFileSync(SOURCE, 'utf8');

const salt = crypto.randomBytes(SALT_BYTES);
const iv = crypto.randomBytes(IV_BYTES);
const key = crypto.pbkdf2Sync(password, salt, ITERATIONS, KEY_BYTES, 'sha256');

const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
const tag = cipher.getAuthTag();

// Layout: [salt(16)] [iv(12)] [ciphertext] [tag(16)]
const blob = Buffer.concat([salt, iv, ct, tag]).toString('base64');

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#0b1f3a">
<meta name="robots" content="noindex,nofollow,noarchive,nosnippet">
<meta name="googlebot" content="noindex,nofollow">
<title>Private &middot; RefundLocators</title>
<link rel="icon" type="image/svg+xml" href="icon-portal.svg" />
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root {
    --navy: #0b1f3a;
    --navy-deep: #061327;
    --navy-darker: #03081a;
    --gold: #c9a24a;
    --gold-light: #d8b560;
    --gold-glow: rgba(201, 162, 74, 0.35);
    --cream: #fbf8f1;
    --red: #a83232;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { width: 100%; min-height: 100%; }
  body {
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
    background:
      radial-gradient(ellipse 80% 60% at 70% 30%, rgba(201,162,74,0.10) 0%, transparent 60%),
      radial-gradient(ellipse 60% 40% at 20% 70%, rgba(74,111,165,0.16) 0%, transparent 65%),
      linear-gradient(180deg, var(--navy-deep) 0%, var(--navy-darker) 100%);
    color: var(--cream);
    -webkit-font-smoothing: antialiased;
    min-height: 100vh;
    display: flex; align-items: center; justify-content: center;
    padding: 40px 24px;
  }
  .gate { width: 100%; max-width: 460px; text-align: center; }
  .brand {
    display: flex; align-items: center; justify-content: center; gap: 10px;
    font-family: 'Fraunces', serif; font-weight: 700; font-size: 18px;
    color: var(--cream); margin-bottom: 56px;
  }
  .brand-dot { width: 9px; height: 9px; background: var(--gold); border-radius: 50%; box-shadow: 0 0 14px var(--gold-glow); }
  .lock {
    width: 56px; height: 56px;
    border: 1px solid rgba(201, 162, 74, 0.35);
    background: rgba(201, 162, 74, 0.08);
    border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    color: var(--gold); margin: 0 auto 28px;
  }
  h1 {
    font-family: 'Fraunces', serif; font-weight: 500;
    font-size: 32px; letter-spacing: -0.02em;
    color: var(--cream); margin-bottom: 12px;
  }
  .sub {
    font-size: 14px; color: rgba(251,248,241,0.6); line-height: 1.55;
    margin-bottom: 36px;
  }
  form { display: flex; flex-direction: column; gap: 12px; }
  input[type="password"] {
    width: 100%;
    padding: 14px 18px;
    background: rgba(255, 252, 245, 0.04);
    border: 1px solid rgba(201, 162, 74, 0.3);
    border-radius: 10px;
    color: var(--cream);
    font-family: inherit; font-size: 15px;
    outline: none;
    transition: border-color .2s, background .2s;
  }
  input[type="password"]:focus {
    border-color: var(--gold);
    background: rgba(255, 252, 245, 0.06);
  }
  input[type="password"]::placeholder { color: rgba(251,248,241,0.35); }
  button {
    width: 100%;
    padding: 14px 18px;
    background: var(--gold);
    color: var(--navy);
    border: none; border-radius: 10px;
    font-family: inherit; font-size: 14px; font-weight: 600;
    cursor: pointer;
    transition: transform .2s, box-shadow .2s, opacity .2s;
  }
  button:hover { transform: translateY(-1px); box-shadow: 0 12px 28px var(--gold-glow); }
  button:disabled { opacity: 0.5; cursor: not-allowed; transform: none; box-shadow: none; }
  .err {
    margin-top: 14px; font-size: 13px;
    color: var(--red); min-height: 18px;
    font-family: 'JetBrains Mono', monospace;
    letter-spacing: 0.04em;
  }
  .foot {
    margin-top: 56px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px; letter-spacing: 0.18em; text-transform: uppercase;
    color: rgba(251, 248, 241, 0.3);
  }
  .spin {
    display: inline-block; width: 14px; height: 14px;
    border: 2px solid rgba(11, 31, 58, 0.25);
    border-top-color: var(--navy);
    border-radius: 50%;
    animation: spin .7s linear infinite;
    vertical-align: -2px; margin-right: 8px;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
  <main class="gate">
    <div class="brand"><span class="brand-dot"></span> RefundLocators</div>
    <div class="lock" aria-hidden="true">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
    </div>
    <h1>Private preview</h1>
    <p class="sub">This page is for Nathan and Justin. Enter the access phrase to continue.</p>
    <form id="f" autocomplete="off">
      <input id="p" type="password" placeholder="Access phrase" autofocus required minlength="4" />
      <button id="b" type="submit">Unlock</button>
    </form>
    <div class="err" id="e" role="alert" aria-live="polite"></div>
    <div class="foot">RefundLocators</div>
  </main>
<script>
(function () {
  var BLOB = "${blob}";
  var ITER = ${ITERATIONS};
  var SALT_LEN = ${SALT_BYTES};
  var IV_LEN = ${IV_BYTES};
  var TAG_LEN = 16;
  var STORAGE_KEY = 'rl_pitch_unlock';

  var f = document.getElementById('f');
  var p = document.getElementById('p');
  var b = document.getElementById('b');
  var e = document.getElementById('e');

  function b64decode(s) {
    var bin = atob(s);
    var arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  }

  async function deriveKey(password, salt) {
    var enc = new TextEncoder();
    var keyMat = await crypto.subtle.importKey(
      'raw', enc.encode(password), { name: 'PBKDF2' }, false, ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: salt, iterations: ITER, hash: 'SHA-256' },
      keyMat,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt']
    );
  }

  async function tryUnlock(password) {
    var data = b64decode(BLOB);
    var salt = data.slice(0, SALT_LEN);
    var iv = data.slice(SALT_LEN, SALT_LEN + IV_LEN);
    var ct = data.slice(SALT_LEN + IV_LEN);
    var key = await deriveKey(password, salt);
    var pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv }, key, ct);
    return new TextDecoder().decode(pt);
  }

  function render(html) {
    document.open();
    document.write(html);
    document.close();
  }

  // Auto-unlock if we already verified this session.
  try {
    var cached = sessionStorage.getItem(STORAGE_KEY);
    if (cached) {
      tryUnlock(cached).then(render).catch(function () {
        sessionStorage.removeItem(STORAGE_KEY);
      });
    }
  } catch (err) { /* sessionStorage unavailable, ignore */ }

  f.addEventListener('submit', async function (ev) {
    ev.preventDefault();
    e.textContent = '';
    b.disabled = true;
    b.innerHTML = '<span class="spin"></span>Unlocking';
    try {
      var html = await tryUnlock(p.value);
      try { sessionStorage.setItem(STORAGE_KEY, p.value); } catch (err) {}
      render(html);
    } catch (err) {
      e.textContent = 'wrong phrase';
      b.disabled = false;
      b.textContent = 'Unlock';
      p.select();
    }
  });
})();
</script>
</body>
</html>
`;

fs.writeFileSync(TARGET, html, 'utf8');

const sizeIn = Buffer.byteLength(plaintext, 'utf8');
const sizeOut = fs.statSync(TARGET).size;
console.log('Encrypted ' + SOURCE);
console.log('  plaintext: ' + sizeIn.toLocaleString() + ' bytes');
console.log('  ciphertext: ' + ct.length.toLocaleString() + ' bytes');
console.log('  output: ' + sizeOut.toLocaleString() + ' bytes (' + TARGET + ')');
console.log('  password length: ' + password.length);
