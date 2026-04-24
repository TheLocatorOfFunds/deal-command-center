// morning-sweep
//
// Fires daily at 12:00 UTC (8am EDT / 7am EST) via pg_cron. Walks every
// active deal, detects overnight activity, refreshes the AI case summary
// on deals that changed, compiles a cross-deal briefing, and sends it to
// Nathan as SMS (short) + email (full detail via Resend).
//
// Scope rules (Nathan-approved 2026-04-24):
// - Sweep ACTIVE deals only (status NOT IN closed/recovered/dead).
// - Deals with overnight activity → "Needs attention" (full detail).
// - Early-stage deals with no activity → compact line in "Active quiet".
// - Late-stage deals (filed/awaiting-distribution/probate/paid-out) with
//   no activity → one-liner in "Late-stage waiting" section. They don't
//   spam the digest every day just because they're still open.
//
// Auth: shared-secret header check. pg_cron sets the header from Vault.
//
// Request: POST with header X-Morning-Sweep-Secret: <value>
// Response: { deals_total, deals_attention, deals_refreshed, sms_sent, email_sent }

import { createClient } from 'jsr:@supabase/supabase-js@2';

const NATHAN_PHONE = '+15135162306';
const NATHAN_EMAIL = 'nathan@fundlocators.com';
const FROM_EMAIL = 'RefundLocators <hello@refundlocators.com>';

const LATE_STAGE = new Set(['filed', 'awaiting-distribution', 'probate', 'paid-out']);
const CLOSED_STAGE = new Set(['closed', 'recovered', 'dead']);

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 });

  // Shared-secret check
  const secret = Deno.env.get('MORNING_SWEEP_SECRET');
  if (!secret) return new Response(JSON.stringify({ error: 'MORNING_SWEEP_SECRET not configured' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
  const providedSecret = req.headers.get('X-Morning-Sweep-Secret');
  if (providedSecret !== secret) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY');
    const twilioSid = Deno.env.get('TWILIO_ACCOUNT_SID');
    const twilioToken = Deno.env.get('TWILIO_AUTH_TOKEN');
    const twilioFrom = Deno.env.get('TWILIO_FROM_NUMBER');
    const db = createClient(supabaseUrl, serviceKey);

    // 1. All active deals
    const { data: deals } = await db.from('deals')
      .select('id, name, address, type, status, meta, lead_tier, sales_stage, filed_at, created_at')
      .not('status', 'in', `(${[...CLOSED_STAGE].map(s => `"${s}"`).join(',')})`);

    if (!deals || deals.length === 0) {
      return new Response(JSON.stringify({ deals_total: 0, message: 'No active deals' }), { headers: { 'Content-Type': 'application/json' } });
    }

    const sinceIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    // 1b. Pull Justin's outreach_queue for pending drafts Nathan needs to
    // review. This is the human-approval gate that lives in DCC's Today view
    // via AutomationsQueue — we surface the same signal in the digest so
    // Nathan knows at-a-glance how many are waiting.
    const { data: pendingDrafts } = await db.from('outreach_queue')
      .select('id, deal_id, contact_phone, cadence_day, draft_body, status, scheduled_for, updated_at, created_at, draft_version')
      .in('status', ['queued', 'generating', 'pending'])
      .lte('scheduled_for', new Date().toISOString())
      .order('scheduled_for', { ascending: true });
    const draftsByDeal = new Map<string, any[]>();
    (pendingDrafts || []).forEach((d: any) => {
      const list = draftsByDeal.get(d.deal_id) || [];
      list.push(d);
      draftsByDeal.set(d.deal_id, list);
    });

    // 2. For each deal, detect overnight changes
    const classified: any[] = [];
    for (const deal of deals) {
      const [msgs, calls, emails, events, notes, activity] = await Promise.all([
        db.from('messages_outbound').select('id, direction, body, created_at').eq('deal_id', deal.id).gte('created_at', sinceIso),
        db.from('call_logs').select('id, direction, status, started_at, duration_seconds').eq('deal_id', deal.id).gte('started_at', sinceIso),
        db.from('emails').select('id, direction, subject, created_at').eq('deal_id', deal.id).gte('created_at', sinceIso),
        db.from('docket_events').select('id, event_type, description, event_date').eq('deal_id', deal.id).eq('is_backfill', false).gte('received_at', sinceIso),
        db.from('deal_notes').select('id, title, body, updated_at').eq('deal_id', deal.id).gte('updated_at', sinceIso),
        db.from('activity').select('id, action, created_at').eq('deal_id', deal.id).gte('created_at', sinceIso),
      ]);

      const dealDrafts = draftsByDeal.get(deal.id) || [];
      const hasPendingDraft = dealDrafts.length > 0;
      const changeCount = (msgs.data?.length || 0) + (calls.data?.length || 0) + (emails.data?.length || 0) + (events.data?.length || 0) + (notes.data?.length || 0) + (activity.data?.length || 0);
      // A pending outreach draft (from Justin's outreach_queue) also counts
      // as "needs attention" — Nathan has to approve/edit/send it.
      const hasActivity = changeCount > 0 || hasPendingDraft;
      const isLate = LATE_STAGE.has(deal.status);

      let bucket: 'attention' | 'active_quiet' | 'late_quiet';
      if (hasActivity) bucket = 'attention';
      else if (isLate) bucket = 'late_quiet';
      else bucket = 'active_quiet';

      classified.push({
        deal,
        bucket,
        changeCount,
        pendingDrafts: dealDrafts,
        overnight: {
          messages: msgs.data || [],
          calls: calls.data || [],
          emails: emails.data || [],
          events: events.data || [],
          notes: notes.data || [],
          activity: activity.data || [],
        },
      });
    }

    const attention = classified.filter(c => c.bucket === 'attention');
    const activeQuiet = classified.filter(c => c.bucket === 'active_quiet');
    const lateQuiet = classified.filter(c => c.bucket === 'late_quiet');

    // 3. Refresh AI summary on every deal that had overnight activity
    let refreshedCount = 0;
    for (const item of attention) {
      try {
        const resp = await fetch(`${supabaseUrl}/functions/v1/generate-case-summary`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ deal_id: item.deal.id }),
        });
        if (resp.ok) refreshedCount++;
      } catch (_) { /* non-fatal */ }
    }

    // 4. Compose digest context + ask Claude for the briefing
    const digestContext = {
      generated_at: new Date().toISOString(),
      counts: {
        active_total: classified.length,
        attention: attention.length,
        active_quiet: activeQuiet.length,
        late_quiet: lateQuiet.length,
        pending_drafts: (pendingDrafts || []).length,
      },
      attention: attention.map(c => ({
        deal_id: c.deal.id,
        name: c.deal.name,
        status: c.deal.status,
        tier: c.deal.lead_tier,
        county: c.deal.meta?.county,
        court_case: c.deal.meta?.courtCase,
        // Pending outreach drafts flagged for review per deal (from
        // outreach_queue, Justin's human-in-the-loop system).
        pending_drafts: (c.pendingDrafts || []).map((d: any) => ({
          id: d.id,
          cadence_day: d.cadence_day,
          status: d.status,
          draft_body: d.draft_body ? d.draft_body.slice(0, 300) : null,
          scheduled_for: d.scheduled_for,
          draft_version: d.draft_version,
        })),
        overnight_summary: {
          inbound_messages: c.overnight.messages.filter((m: any) => m.direction === 'inbound').map((m: any) => ({ body: (m.body || '').slice(0, 240), when: m.created_at })),
          outbound_messages: c.overnight.messages.filter((m: any) => m.direction === 'outbound').length,
          inbound_calls: c.overnight.calls.filter((x: any) => x.direction === 'inbound'),
          missed_calls: c.overnight.calls.filter((x: any) => ['missed', 'no-answer', 'busy'].includes(x.status)),
          new_emails: c.overnight.emails.map((e: any) => ({ direction: e.direction, subject: e.subject, when: e.created_at })),
          court_events: c.overnight.events.map((ev: any) => ({ type: ev.event_type, description: ev.description, date: ev.event_date })),
          notes_updated: c.overnight.notes.map((n: any) => ({ title: n.title, body: (n.body || '').slice(0, 200) })),
        },
      })),
      active_quiet_snapshot: activeQuiet.map(c => ({ deal_id: c.deal.id, name: c.deal.name, status: c.deal.status, tier: c.deal.lead_tier })),
      late_quiet_snapshot: lateQuiet.map(c => {
        const filedAt = c.deal.filed_at || c.deal.meta?.filed_at;
        const daysSinceFiled = filedAt ? Math.floor((Date.now() - new Date(filedAt).getTime()) / 86400000) : null;
        return { deal_id: c.deal.id, name: c.deal.name, status: c.deal.status, days_since_filed: daysSinceFiled };
      }),
    };

    let digestText = '';
    if (anthropicKey && attention.length > 0) {
      const systemPrompt = `You are writing Nathan's daily morning briefing on his foreclosure recovery business. Output Markdown with this exact structure:

**Top of your morning** — one sentence on what matters most today.

### 🔔 Needs your attention today
For each deal with overnight activity, one block:
- **[Client Name]** · [status] · [tier]
  - What happened (1-3 concrete facts — who messaged, what the attorney said, what court action, etc.)
  - What to do (1-2 concrete next actions — "reply to Russ Cope", "open Casey's thread", "log judgment update")
Facts + actions only. No hedging. No filler. Money amounts when you know them. Tag time-sensitive items with ⏰.

If a deal has pending_drafts, note them first in that deal's block — "📝 N AI draft(s) awaiting your review (day-X cadence)". Those are the highest-priority touch because they're one tap from sending.

### 📅 Active cases · quiet overnight
One line each, most-recent-stage first. Just: name · stage · tier.

### 💤 Late-stage · waiting on court
One line each. Name · stage · days since filed. No commentary.

Hard rules: no "I believe", no "it appears", no preamble, no meta-commentary. If there's no attention section (no overnight activity), open with "Quiet morning — no overnight activity across N active cases" and skip to the quiet lists.`;

      const userMsg = `Briefing date: ${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}\n\nData (JSON):\n\n\`\`\`json\n${JSON.stringify(digestContext, null, 2)}\n\`\`\``;

      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5',
          max_tokens: 2000,
          system: systemPrompt,
          messages: [{ role: 'user', content: userMsg }],
        }),
      });
      if (resp.ok) {
        const apiBody = await resp.json();
        digestText = (apiBody.content || []).map((b: any) => b.text || '').join('').trim();
      }
    }

    // Fallback if no Claude or no attention items
    if (!digestText) {
      const lines: string[] = [];
      if (attention.length === 0) lines.push(`Quiet morning — no overnight activity across ${classified.length} active cases.`);
      else {
        lines.push(`## 🔔 Needs your attention today`);
        attention.forEach(c => lines.push(`- **${c.deal.name}** · ${c.deal.status} · ${c.overnight.messages.length + c.overnight.calls.length + c.overnight.emails.length + c.overnight.events.length} overnight signals`));
      }
      if (activeQuiet.length > 0) {
        lines.push(``, `## 📅 Active · quiet overnight`);
        activeQuiet.forEach(c => lines.push(`- ${c.deal.name} · ${c.deal.status}${c.deal.lead_tier ? ` · Tier ${c.deal.lead_tier}` : ''}`));
      }
      if (lateQuiet.length > 0) {
        lines.push(``, `## 💤 Late-stage · waiting on court`);
        lateQuiet.forEach(c => {
          const filedAt = c.deal.filed_at || c.deal.meta?.filed_at;
          const days = filedAt ? Math.floor((Date.now() - new Date(filedAt).getTime()) / 86400000) : null;
          lines.push(`- ${c.deal.name} · ${c.deal.status}${days != null ? ` · ${days}d since filed` : ''}`);
        });
      }
      digestText = lines.join('\n');
    }

    // 5. Send SMS (short summary) + email (full digest)
    const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    const topNames = attention.slice(0, 3).map(c => (c.deal.name || '').split(' - ')[0]).filter(Boolean).join(', ');
    const pendingDraftCount = (pendingDrafts || []).length;
    const draftsSuffix = pendingDraftCount > 0
      ? ` · 📝 ${pendingDraftCount} AI draft${pendingDraftCount === 1 ? '' : 's'} awaiting review`
      : '';
    const smsBody = attention.length === 0
      ? `🌅 ${dateStr} morning digest · quiet morning, no overnight activity across ${classified.length} active cases${draftsSuffix}.`
      : `🌅 ${dateStr} morning digest · ${attention.length} need${attention.length === 1 ? 's' : ''} attention${topNames ? ` (${topNames}${attention.length > 3 ? '…' : ''})` : ''} · ${activeQuiet.length} active quiet · ${lateQuiet.length} late-stage${draftsSuffix} · full brief in email.`;

    let smsSent = false;
    if (twilioSid && twilioToken && twilioFrom) {
      try {
        const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`, {
          method: 'POST',
          headers: { 'Authorization': 'Basic ' + btoa(`${twilioSid}:${twilioToken}`), 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ To: NATHAN_PHONE, From: twilioFrom, Body: smsBody.slice(0, 320) }).toString(),
        });
        smsSent = resp.ok;
      } catch (_) { /* non-fatal */ }
    }

    // Email via Resend (pull key from vault)
    let emailSent = false;
    const { data: keyRow } = await db.from('vault.decrypted_secrets').select('decrypted_secret').eq('name', 'resend_api_key').single();
    const resendKey = keyRow?.decrypted_secret;
    if (resendKey) {
      // Light markdown → HTML
      const htmlBody = digestText
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/^### (.+)$/gm, '<h3 style="margin:20px 0 8px;color:#0b1f3a;">$1</h3>')
        .replace(/^## (.+)$/gm, '<h2 style="margin:22px 0 10px;color:#0b1f3a;">$1</h2>')
        .replace(/^- (.+)$/gm, '<li>$1</li>')
        .replace(/\n\n/g, '</p><p>')
        .replace(/\n/g, '<br/>');
      const draftsFooter = pendingDraftCount > 0
        ? ` · 📝 ${pendingDraftCount} outreach draft${pendingDraftCount === 1 ? '' : 's'} awaiting approval — review on the Today view`
        : '';
      const fullHtml = `<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;max-width:680px;margin:0 auto;padding:24px;color:#1a1a1a;background:#fbf8f1;"><div style="background:#fff;padding:24px 28px;border-radius:14px;border:1px solid #e5dfd0;"><div style="font-size:11px;font-weight:700;letter-spacing:.14em;color:#d8b560;text-transform:uppercase;margin-bottom:8px;">Morning Digest · ${dateStr}</div><p style="font-size:14px;line-height:1.6;">${htmlBody}</p><hr style="border:none;border-top:1px solid #e5dfd0;margin:24px 0 16px;"/><p style="font-size:11px;color:#888;">${classified.length} active deals · ${attention.length} with overnight activity · ${refreshedCount} AI summaries refreshed${draftsFooter}. Open DCC at <a href="https://app.refundlocators.com/" style="color:#17355e;">app.refundlocators.com</a>.</p></div></body></html>`;

      try {
        const resp = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: FROM_EMAIL,
            to: [NATHAN_EMAIL],
            subject: `🌅 DCC Morning Digest · ${dateStr} · ${attention.length} needing attention`,
            html: fullHtml,
            text: digestText,
          }),
        });
        emailSent = resp.ok;
      } catch (_) { /* non-fatal */ }
    }

    return new Response(JSON.stringify({
      deals_total: classified.length,
      deals_attention: attention.length,
      deals_active_quiet: activeQuiet.length,
      deals_late_quiet: lateQuiet.length,
      deals_refreshed: refreshedCount,
      pending_drafts: pendingDraftCount,
      sms_sent: smsSent,
      email_sent: emailSent,
      digest_preview: digestText.slice(0, 400),
    }), { headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
});
