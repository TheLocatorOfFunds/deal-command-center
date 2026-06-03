#!/usr/bin/env node
// App Store Connect API verifier for the apple-side links of a release contract.
// READ-ONLY: mints a short-lived ES256 JWT from the local ASC API key and issues
// GET requests only. Never mutates anything at Apple.
//
// What it CAN verify: the app record, whether the bundle ID has the Push
// Notifications capability, signing-cert expiry, provisioning-profile state.
// What it CANNOT verify: APNs / VoIP *push* certificates - Apple does not expose
// push/VoIP certs through the ASC API (/v1/certificates returns signing certs
// only). That link stays human-verified (developer.apple.com or Twilio console)
// and is proven in practice by the runtime voice_sdk_status = registered row.
//
// Non-secret identifiers below (Key ID + Issuer ID are not sensitive). The actual
// secret is the .p8 private key, which stays at ~/.appstoreconnect/private_keys/
// and is NOT committed.
//
// Usage: node mobile/contracts/asc-verify.mjs [bundleId]
//   default bundleId = com.fundlocators.dcc

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const KEY_ID = 'R79VDA2SMJ';
const ISSUER_ID = 'd6deea26-4f16-4e54-89e7-c52415af4921';
const KEY_PATH = path.join(os.homedir(), '.appstoreconnect', 'private_keys', `AuthKey_${KEY_ID}.p8`);
const BUNDLE = process.argv[2] || 'com.fundlocators.dcc';

if (!fs.existsSync(KEY_PATH)) {
  console.error(`ASC key not found at ${KEY_PATH} -> apple links NEEDS-HUMAN (no key on this machine).`);
  process.exit(3);
}
const privateKey = fs.readFileSync(KEY_PATH, 'utf8');

function b64url(buf){ return Buffer.from(buf).toString('base64').replace(/=+$/,'').replace(/\+/g,'-').replace(/\//g,'_'); }
const now = Math.floor(Date.now()/1000);
const si = b64url(JSON.stringify({ alg:'ES256', kid:KEY_ID, typ:'JWT' })) + '.' +
           b64url(JSON.stringify({ iss:ISSUER_ID, iat:now, exp:now+1000, aud:'appstoreconnect-v1' }));
const sig = crypto.sign('sha256', Buffer.from(si), { key:privateKey, dsaEncoding:'ieee-p1363' });
const JWT = si + '.' + b64url(sig);

const BASE = 'https://api.appstoreconnect.apple.com';
async function api(p){
  const r = await fetch(BASE+p, { headers:{ Authorization:'Bearer '+JWT } });
  const t = await r.text();
  let j; try{ j=JSON.parse(t); }catch{ j={raw:t.slice(0,300)}; }
  return { status:r.status, j };
}

(async()=>{
  const out = { bundle: BUNDLE, keyId: KEY_ID, checks: {} };

  const apps = await api(`/v1/apps?filter[bundleId]=${BUNDLE}&limit=5&fields[apps]=name,bundleId`);
  out.checks.keyAuth = apps.status === 200 ? 'VERIFIED' : `BROKEN (HTTP ${apps.status})`;
  out.checks.app = apps.j.data?.[0] ? `${apps.j.data[0].attributes.name} (${apps.j.data[0].id})` : 'NOT FOUND';

  const bid = await api(`/v1/bundleIds?filter[identifier]=${BUNDLE}&include=bundleIdCapabilities&limit=5`);
  const caps = (bid.j.included||[]).filter(x=>x.type==='bundleIdCapabilities').map(c=>c.attributes.capabilityType);
  const hasPush = caps.includes('PUSH_NOTIFICATIONS');
  out.checks.pushCapability = hasPush ? 'VERIFIED (PUSH_NOTIFICATIONS enabled)' : 'BROKEN (Push Notifications NOT enabled on bundle)';
  out.checks.capabilities = caps;

  const profs = await api(`/v1/profiles?include=bundleId&limit=200&fields[profiles]=name,profileState,profileType,expirationDate`);
  const bidMap = {}; (profs.j.included||[]).forEach(x=>{ if(x.type==='bundleIds') bidMap[x.id]=x.attributes.identifier; });
  const mine = (profs.j.data||[]).filter(p=>bidMap[p.relationships?.bundleId?.data?.id]===BUNDLE)
    .map(p=>`${p.attributes.name} [${p.attributes.profileType}/${p.attributes.profileState} exp ${p.attributes.expirationDate}]`);
  out.checks.provisioningProfiles = mine.length ? mine : 'NONE in portal (EAS-managed credentials likely)';

  const certs = await api(`/v1/certificates?limit=200&fields[certificates]=certificateType,displayName,expirationDate`);
  out.checks.signingCerts = (certs.j.data||[]).map(c=>`${c.attributes.certificateType} (${c.attributes.displayName}) exp ${c.attributes.expirationDate}`);

  out.checks.voipPushCert = 'NEEDS-HUMAN (ASC API does not expose push/VoIP certs; verify at developer.apple.com / Twilio console; runtime voice_sdk_status=registered is the real proof)';

  console.log(JSON.stringify(out, null, 2));
})().catch(e=>{ console.error('ERR', e && e.message ? e.message : e); process.exit(1); });
