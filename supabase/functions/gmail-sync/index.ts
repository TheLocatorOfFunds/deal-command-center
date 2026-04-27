// gmail-sync — Business Communications Pipeline
//
// Pulls Gmail (Justin + Nathan) and Granola meeting notes for the past 7 days.
// Summarizes each with Claude, writes to team_communications table.
// Run Saturday night so Monday Memo has fresh context.
//
// Auth: POST with X-Gmail-Sync-Secret header
// Schedule: 0 5 * * 0  (Sunday 5am UTC = Sunday 1am EDT, 2hrs before Monday Memo at 7am UTC)
//
// Gmail access: Google service account with domain-wide delegation (DWD)
//   - Impersonates justin@fundlocators.com and nathan@fundlocators.com
//   - Service account JSON stored in GOOGLE_SERVICE_ACCOUNT_JSON secret
//   - Required OAuth scope: https://www.googleapis.com/auth/gmail.readonly
//
// Granola access: Granola API key (team plan)
//   - GRANOLA_API_KEY secret
//   - Pulls both Justin and Nathan's meetings via team endpoints

import { createClient } from 'jsr:@supabase/supabase-js@2';

const TEAM_MEMBERS = [
  { person: 'justin', email: 'justin@fundlocators.com' },
  { person: 'nathan', email: 'nathan@fundlocators.com' },
];

// Gmail labels/senders to skip — reduces noise in the summary
const GMAIL_SKIP_PATTERNS = [
  'invoice+statements@', 'receipts@', 'noreply@', 'no-reply@',
  'donotreply@', '@stripe.com', '@paypal.com', 'fundlocators+expenses@',
  'hello@refundlocators.com', // skip our own morning-sweep / monday-memo
];

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 });

  const secret = Deno.env.get('GMAIL_SYNC_SECRET');
  if (!secret) return new Response(JSON.stringify({ error: 'GMAIL_SYNC_SECRET not configured' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
  if (req.headers.get('X-Gmail-Sync-Secret') !== secret)
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });

  try {
    const supabaseUrl    = Deno.env.get('SUPABASE_URL')!;
    const serviceKey     = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const anthropicKey   = Deno.env.get('ANTHROPIC_API_KEY')!;
    const serviceAccJson = Deno.env.get('GOOGLE_SERVICE_ACCOUNT_JSON');
    const granolaKey     = Deno.env.get('GRANOLA_API_KEY');
    const db             = createClient(supabaseUrl, serviceKey);

    const now       = new Date();
    const weekAgo   = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const weekOf    = getSundayDate(now);   // normalize to Sunday
    const afterDate = weekAgo.toISOString().split('T')[0].replace(/-/g, '/'); // YYYY/MM/DD for Gmail query

    const results: Record<string, any> = {};

    // ── 1. Gmail via service account DWD ─────────────────────────────────────
    if (serviceAccJson) {
      for (const member of TEAM_MEMBERS) {
        try {
          const accessToken = await getGoogleAccessToken(serviceAccJson, member.email);
          const threads = await fetchGmailThreads(accessToken, member.email, afterDate);
          const filtered = threads.filter((t: any) => !shouldSkipThread(t));

          const summary = filtered.length > 0
            ? await summarizeWithClaude(anthropicKey, member.person, 'gmail', filtered)
            : `No notable email threads for ${member.person} this week.`;

          await db.from('team_communications').upsert({
            week_of:  weekOf,
            person:   member.person,
            source:   'gmail',
            summary,
            raw_data: filtered.slice(0, 50), // cap storage
          }, { onConflict: 'week_of,person,source' });

          results[`gmail_${member.person}`] = { threads: filtered.length };
        } catch (e) {
          results[`gmail_${member.person}_error`] = (e as Error).message;
        }
      }
    } else {
      results['gmail'] = 'skipped — GOOGLE_SERVICE_ACCOUNT_JSON not configured';
    }

    // ── 2. Granola via API ────────────────────────────────────────────────────
    if (granolaKey) {
      try {
        const meetings = await fetchGranolaMeetings(granolaKey, weekAgo.toISOString());
        // Group meetings by person (note creator)
        const byPerson: Record<string, any[]> = { justin: [], nathan: [], team: [] };
        for (const m of meetings) {
          const creator = m.creator_email?.includes('nathan') ? 'nathan' : 'justin';
          byPerson[creator].push(m);
          // Also add to 'team' if both attended
          if (m.participants?.length > 1) byPerson['team'].push(m);
        }

        for (const [person, mtgs] of Object.entries(byPerson)) {
          if (mtgs.length === 0) continue;
          const summary = await summarizeWithClaude(anthropicKey, person, 'granola', mtgs);
          await db.from('team_communications').upsert({
            week_of:  weekOf,
            person,
            source:   'granola',
            summary,
            raw_data: mtgs,
          }, { onConflict: 'week_of,person,source' });
          results[`granola_${person}`] = { meetings: mtgs.length };
        }
      } catch (e) {
        results['granola_error'] = (e as Error).message;
      }
    } else {
      results['granola'] = 'skipped — GRANOLA_API_KEY not configured';
    }

    return new Response(JSON.stringify({ ok: true, week_of: weekOf, results }),
      { headers: { 'Content-Type': 'application/json' } });

  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function getSundayDate(d: Date): string {
  const day = d.getDay(); // 0 = Sunday
  const sunday = new Date(d);
  sunday.setDate(d.getDate() - day);
  return sunday.toISOString().split('T')[0];
}

function shouldSkipThread(thread: any): boolean {
  const sender = (thread.sender || '').toLowerCase();
  const subject = (thread.subject || '').toLowerCase();
  return GMAIL_SKIP_PATTERNS.some(p => sender.includes(p.toLowerCase())) ||
    subject.includes('unsubscribe') || subject.includes('receipt from');
}

async function getGoogleAccessToken(serviceAccountJson: string, impersonateEmail: string): Promise<string> {
  // Build a JWT for Google service account OAuth
  // Scope: Gmail read-only
  const sa = JSON.parse(serviceAccountJson);
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: sa.client_email,
    sub: impersonateEmail,  // DWD: impersonate this user
    scope: 'https://www.googleapis.com/auth/gmail.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };

  // Encode JWT header + claim
  const header = { alg: 'RS256', typ: 'JWT' };
  const enc = (obj: any) => btoa(JSON.stringify(obj)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const signingInput = `${enc(header)}.${enc(claim)}`;

  // Sign with the private key using Web Crypto
  const pemKey = sa.private_key.replace(/-----BEGIN PRIVATE KEY-----/, '').replace(/-----END PRIVATE KEY-----/, '').replace(/\n/g, '');
  const keyData = Uint8Array.from(atob(pemKey), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey('pkcs8', keyData, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, new TextEncoder().encode(signingInput));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(signature))).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const jwt = `${signingInput}.${sigB64}`;

  // Exchange JWT for access token
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) throw new Error(`Token exchange failed: ${JSON.stringify(tokenData)}`);
  return tokenData.access_token;
}

async function fetchGmailThreads(accessToken: string, userEmail: string, afterDate: string): Promise<any[]> {
  // Search business-relevant threads: client communications, attorney emails, vendor discussions
  const query = encodeURIComponent(
    `after:${afterDate} -category:promotions -category:social -in:spam`
  );
  const listRes = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/${userEmail}/threads?q=${query}&maxResults=50`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!listRes.ok) throw new Error(`Gmail list failed for ${userEmail}: ${listRes.status}`);
  const listData = await listRes.json();
  const threadIds: string[] = (listData.threads || []).map((t: any) => t.id);

  // Fetch snippet + subject + sender for each thread (no full bodies — keep it lean)
  const threads: any[] = [];
  for (const tid of threadIds.slice(0, 40)) {
    try {
      const tRes = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/${userEmail}/threads/${tid}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Date`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      if (!tRes.ok) continue;
      const tData = await tRes.json();
      const msgs = tData.messages || [];
      const first = msgs[0];
      const last = msgs[msgs.length - 1];
      const getHeader = (msg: any, name: string) =>
        (msg?.payload?.headers || []).find((h: any) => h.name === name)?.value || '';

      threads.push({
        id:       tid,
        subject:  getHeader(first, 'Subject'),
        sender:   getHeader(first, 'From'),
        to:       getHeader(first, 'To'),
        date:     getHeader(last, 'Date'),
        snippet:  last?.snippet?.slice(0, 200) || '',
        replies:  msgs.length,
      });
    } catch (_) { /* skip */ }
  }
  return threads;
}

async function fetchGranolaMeetings(apiKey: string, since: string): Promise<any[]> {
  // Granola team API — pulls all team meetings
  // NOTE: Granola API endpoint TBD — update once confirmed
  // For now, returns empty and we populate via the scheduled Claude task instead
  try {
    const res = await fetch(`https://api.granola.so/v1/meetings?since=${since}&limit=50`, {
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.meetings || data || [];
  } catch (_) {
    return [];
  }
}

async function summarizeWithClaude(apiKey: string, person: string, source: string, data: any[]): Promise<string> {
  const dataStr = JSON.stringify(data.slice(0, 20), null, 2);
  const sourceLabel = source === 'gmail' ? 'email threads' : 'meeting notes';
  const prompt = `Summarize these ${sourceLabel} for ${person} from the past week for a business executive briefing. Focus only on business-relevant content: client communications, case updates, legal proceedings, vendor negotiations, strategic decisions, problems encountered. Skip receipts, automated notifications, and personal topics. Be concise — 3-8 bullet points max. Each bullet should carry real information.\n\n${dataStr}`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model:      'claude-haiku-4-5',  // fast + cheap for summarization
        max_tokens: 500,
        messages:   [{ role: 'user', content: prompt }],
      }),
    });
    if (!r.ok) return `[summarization failed: ${r.status}]`;
    const body = await r.json();
    return (body.content || []).map((b: any) => b.text || '').join('').trim();
  } catch (e) {
    return `[summarization error: ${(e as Error).message}]`;
  }
}
