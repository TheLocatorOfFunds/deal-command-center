const { useState, useEffect, useCallback, useRef } = React;
const SUPABASE_URL = 'https://rcfaashkfpurkvtmsmeb.supabase.co';
const SUPABASE_KEY = 'sb_publishable_BjBJSBQC2iJXQodut3y3Ag_8aKyPmwv';
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// ─── ErrorBoundary ───────────────────────────────────────────────────
// Catches render-time crashes inside a tab (e.g. Comms) so the whole app
// doesn't black-screen. Surfaces the actual error message + stack so we
// can debug instead of just seeing a blank page.
class ErrorBoundary extends React.Component {
  constructor(p) { super(p); this.state = { err: null, info: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  componentDidCatch(err, info) {
    this.setState({ info });
    // Also push to console so Cmd+Opt+J still shows the trace
    console.error('[ErrorBoundary]', this.props.label || 'tab', err, info);
  }
  reset = () => this.setState({ err: null, info: null });
  render() {
    if (!this.state.err) return this.props.children;
    return (
      React.createElement('div', { style: { padding: 20, background: '#1c1917', border: '1px solid #7f1d1d', borderRadius: 10, color: '#fafaf9', margin: 16 } },
        React.createElement('div', { style: { fontSize: 14, fontWeight: 700, color: '#fca5a5', marginBottom: 8 } }, '⚠ Something broke in this tab'),
        React.createElement('div', { style: { fontSize: 12, color: '#d6d3d1', marginBottom: 12, fontFamily: "'DM Mono', monospace", whiteSpace: 'pre-wrap', wordBreak: 'break-word' } },
          (this.state.err && this.state.err.message) || String(this.state.err)),
        this.state.info && this.state.info.componentStack ?
          React.createElement('details', { style: { fontSize: 10, color: '#78716c' } },
            React.createElement('summary', { style: { cursor: 'pointer' } }, 'Stack'),
            React.createElement('pre', { style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, this.state.info.componentStack))
          : null,
        React.createElement('button', { onClick: this.reset, style: { ...btnGhostFallback, marginTop: 12 } }, 'Try again')
      )
    );
  }
}
// Inline fallback in case btnGhost from later in the file isn't hoisted yet
const btnGhostFallback = { background: 'transparent', color: '#a8a29e', border: '1px solid #44403c', borderRadius: 6, padding: '6px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer' };

// ─── Helpers ────────────────────────────────────────────────────────
const fmt = (n) => "$" + Math.round(n || 0).toLocaleString();
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

const daysSince = (dateStr) => {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d)) return null;
  return Math.floor((Date.now() - d.getTime()) / 86400000);
};
const deadlineInfo = (dateStr) => {
  if (!dateStr) return { label: "", overdue: false, soon: false };
  const d = new Date(dateStr);
  if (isNaN(d)) return { label: "", overdue: false, soon: false };
  const diff = Math.ceil((d.getTime() - Date.now()) / 86400000);
  if (diff < 0) return { label: `${-diff}d overdue`, overdue: true, soon: false };
  if (diff === 0) return { label: "DUE TODAY", overdue: false, soon: true };
  if (diff <= 7) return { label: `Due in ${diff}d`, overdue: false, soon: true };
  if (diff <= 30) return { label: `Due in ${diff}d`, overdue: false, soon: false };
  return { label: "", overdue: false, soon: false };
};
// Best-available net profit for a deal without needing per-deal expenses loaded.
// Prefers actual_net when set (user's source of truth); else computes from meta.
const computeDealNet = (deal) => {
  if (deal.actual_net != null && deal.actual_net !== "") {
    const v = parseFloat(deal.actual_net);
    if (!isNaN(v)) return v;
  }
  const m = deal.meta || {};
  if (deal.type === "flip") {
    const strategy = m.strategy || "flip";
    const salePrice = strategy === "wholesale" ? (m.wholesalePrice || 0) : (m.listPrice || 0);
    const closingPct = ((m.buyerAgentPct || 0) + (m.closingMiscPct || 0)) / 100;
    const closingDollars = strategy === "wholesale" ? 0 : salePrice * closingPct + (m.flatFee || 0);
    return salePrice - (m.contractPrice || 0) - closingDollars;
  }
  // surplus / wholesale / rental / other → use projected fee minus attorney fee
  const projectedFee = ((m.estimatedSurplus || 0) * (m.feePct || 0)) / 100;
  return projectedFee - (m.attorneyFee || 0);
};
const csvEscape = (v) => {
  if (v == null) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const downloadCSV = (rows, filename) => {
  if (!rows.length) return;
  const headers = Object.keys(rows[0]);
  const csv = [headers.join(","), ...rows.map(r => headers.map(h => csvEscape(r[h])).join(","))].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

const DEAL_STATUSES = {
  flip: ["lead", "under-contract", "rehab", "listing", "under-offer", "closed", "dead"],
  surplus: ["new-lead", "signed", "filed", "probate", "awaiting-distribution", "recovered", "urgent", "dead"],
};
const STATUS_COLORS = {
  "lead": "#3b82f6", "under-contract": "#f59e0b", "rehab": "#d97706", "listing": "#8b5cf6",
  "under-offer": "#06b6d4", "closed": "#10b981", "dead": "#78716c",
  "new-lead": "#3b82f6", "signed": "#f59e0b", "filed": "#8b5cf6",
  "probate": "#ec4899", "awaiting-distribution": "#06b6d4", "recovered": "#10b981", "urgent": "#ef4444",
};
const EXPENSE_CATEGORIES = ["Acquisition","Inspection","Plumbing","Electrical","Well/Septic","Cleanup","Labor","Holding","Marketing","Setup","Site","Legal","Filing","Other"];

// ─── Styles ──────────────────────────────────────────────────────────
const inputStyle = { width: "100%", background: "#0c0a09", border: "1px solid #44403c", color: "#fafaf9", padding: "8px 10px", borderRadius: 6, fontSize: 13, outline: "none" };
const selectStyle = { background: "#1c1917", border: "1px solid #44403c", color: "#fafaf9", padding: "6px 10px", borderRadius: 6, fontSize: 12, fontWeight: 600 };
const btnPrimary = { background: "#d97706", color: "#0c0a09", border: "none", padding: "7px 14px", borderRadius: 6, fontSize: 12, fontWeight: 700 };
const btnGhost = { background: "transparent", color: "#78716c", border: "1px solid #44403c", padding: "4px 10px", borderRadius: 4, fontSize: 14, fontWeight: 600 };
const th = { textAlign: "left", padding: "10px 12px", fontSize: 10, fontWeight: 700, color: "#a8a29e", letterSpacing: "0.1em", textTransform: "uppercase" };
const td = { padding: "10px 12px", verticalAlign: "top" };

// ─── Shell ───────────────────────────────────────────────────────────
function Shell({ children }) {
  return (
    <div className="shell" style={{ minHeight: "100vh", padding: "20px 24px" }}>
      <div style={{ maxWidth: 1340, margin: "0 auto" }}>{children}</div>
    </div>
  );
}

// ─── Login ───────────────────────────────────────────────────────────
function Login() {
  const [email, setEmail]       = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode]         = useState("password"); // "password" | "magic" | "reset"
  const [sent, setSent]         = useState(false);
  const [err, setErr]           = useState("");
  const [busy, setBusy]         = useState(false);

  const signInWithPassword = async () => {
    if (!email || !password) return;
    setBusy(true); setErr("");
    const { error } = await sb.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) { setErr(error.message); }
  };

  const sendMagicLink = async () => {
    if (!email) return;
    setBusy(true); setErr("");
    const { error } = await sb.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin + window.location.pathname }
    });
    setBusy(false);
    if (error) { setErr(error.message); return; }
    setSent(true);
  };

  const sendReset = async () => {
    if (!email) return;
    setBusy(true); setErr("");
    const { error } = await sb.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin + window.location.pathname
    });
    setBusy(false);
    if (error) { setErr(error.message); return; }
    setSent(true);
  };

  const linkStyle = { background: "none", border: "none", color: "#a8a29e", fontSize: 12, cursor: "pointer", textDecoration: "underline", padding: 0 };

  return (
    <Shell>
      <div style={{ maxWidth: 420, margin: "120px auto", textAlign: "center" }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: "#d97706", letterSpacing: "0.15em", textTransform: "uppercase" }}>RefundLocators</div>
        <div style={{ fontSize: 32, fontWeight: 700, marginTop: 6 }}>Deal Command Center</div>
        <div style={{ fontSize: 13, color: "#a8a29e", marginTop: 8, marginBottom: 32 }}>
          {mode === "password" && "Sign in with your email and password."}
          {mode === "magic"    && "We'll email you a sign-in link."}
          {mode === "reset"    && "Enter your email to set or reset your password."}
        </div>
        {sent ? (
          <div style={{ background: "#1c1917", border: "1px solid #292524", borderRadius: 10, padding: 22 }}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>Check your email</div>
            <div style={{ fontSize: 12, color: "#a8a29e", marginTop: 8 }}>
              {mode === "reset"
                ? <>A password reset link was sent to <b>{email}</b>.</>
                : <>Click the link in <b>{email}</b> to sign in.</>}
            </div>
          </div>
        ) : (
          <div style={{ background: "#1c1917", border: "1px solid #292524", borderRadius: 10, padding: 22 }}>
            <input
              type="email" autoFocus value={email}
              onChange={e => setEmail(e.target.value)}
              onKeyDown={e => e.key === "Enter" && mode === "password" && document.getElementById("dcc-pw-input")?.focus()}
              placeholder="you@refundlocators.com"
              style={{ ...inputStyle, fontSize: 14, padding: "10px 12px" }}
            />
            {mode === "password" && (
              <input
                id="dcc-pw-input" type="password" value={password}
                onChange={e => setPassword(e.target.value)}
                onKeyDown={e => e.key === "Enter" && signInWithPassword()}
                placeholder="Password"
                style={{ ...inputStyle, fontSize: 14, padding: "10px 12px", marginTop: 10 }}
              />
            )}
            <button
              onClick={mode === "password" ? signInWithPassword : mode === "magic" ? sendMagicLink : sendReset}
              disabled={busy || !email || (mode === "password" && !password)}
              style={{ ...btnPrimary, width: "100%", padding: "10px 14px", fontSize: 13, marginTop: 12, opacity: busy || !email || (mode === "password" && !password) ? 0.5 : 1 }}
            >
              {busy ? "..." : mode === "password" ? "Sign in" : mode === "magic" ? "Send magic link" : "Send reset link"}
            </button>
            {err && <div style={{ fontSize: 11, color: "#fca5a5", marginTop: 10 }}>{err}</div>}
            <div style={{ marginTop: 16, display: "flex", justifyContent: "center", gap: 16 }}>
              {mode !== "password" && <button style={linkStyle} onClick={() => { setMode("password"); setErr(""); }}>Sign in with password</button>}
              {mode !== "magic"    && <button style={linkStyle} onClick={() => { setMode("magic");    setErr(""); }}>Send magic link</button>}
              {mode !== "reset"    && <button style={linkStyle} onClick={() => { setMode("reset");    setErr(""); }}>Forgot password?</button>}
            </div>
          </div>
        )}
      </div>
    </Shell>
  );
}

// ─── Set New Password (post-reset flow) ──────────────────────────────
function SetNewPassword({ onDone }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm]   = useState("");
  const [busy, setBusy]         = useState(false);
  const [err, setErr]           = useState("");

  const save = async () => {
    if (password.length < 6) { setErr("Password must be at least 6 characters."); return; }
    if (password !== confirm) { setErr("Passwords don't match."); return; }
    setBusy(true); setErr("");
    const { error } = await sb.auth.updateUser({ password });
    setBusy(false);
    if (error) { setErr(error.message); return; }
    onDone();
  };

  return (
    <Shell>
      <div style={{ maxWidth: 420, margin: "120px auto", textAlign: "center" }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: "#d97706", letterSpacing: "0.15em", textTransform: "uppercase" }}>RefundLocators</div>
        <div style={{ fontSize: 32, fontWeight: 700, marginTop: 6 }}>Deal Command Center</div>
        <div style={{ fontSize: 13, color: "#a8a29e", marginTop: 8, marginBottom: 32 }}>Set your new password.</div>
        <div style={{ background: "#1c1917", border: "1px solid #292524", borderRadius: 10, padding: 22 }}>
          <input autoFocus type="password" value={password} onChange={e => setPassword(e.target.value)}
            onKeyDown={e => e.key === "Enter" && document.getElementById("dcc-pw-confirm")?.focus()}
            placeholder="New password" style={{ ...inputStyle, fontSize: 14, padding: "10px 12px" }} />
          <input id="dcc-pw-confirm" type="password" value={confirm} onChange={e => setConfirm(e.target.value)}
            onKeyDown={e => e.key === "Enter" && save()}
            placeholder="Confirm password" style={{ ...inputStyle, fontSize: 14, padding: "10px 12px", marginTop: 10 }} />
          <button onClick={save} disabled={busy || !password || !confirm}
            style={{ ...btnPrimary, width: "100%", padding: "10px 14px", fontSize: 13, marginTop: 12, opacity: busy || !password || !confirm ? 0.5 : 1 }}>
            {busy ? "Saving..." : "Set password"}
          </button>
          {err && <div style={{ fontSize: 11, color: "#fca5a5", marginTop: 10 }}>{err}</div>}
        </div>
      </div>
    </Shell>
  );
}

// ─── Root: session gate ──────────────────────────────────────────────
function Root() {
  const [session, setSession]       = useState(null);
  const [profile, setProfile]       = useState(null);
  const [checking, setChecking]     = useState(true);
  // Detect recovery link synchronously before any async calls resolve
  const [recovering, setRecovering] = useState(() => window.location.hash.includes('type=recovery'));

  useEffect(() => {
    sb.auth.getSession().then(({ data }) => { setSession(data.session); setChecking(false); });
    const { data: sub } = sb.auth.onAuthStateChange((evt, s) => {
      if (evt === "PASSWORD_RECOVERY") { setSession(s); setRecovering(true); }
      else if (evt === "USER_UPDATED")  { setRecovering(false); }
      else { setSession(s); }
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) { setProfile(null); return; }
    sb.from('profiles').select('*').eq('id', session.user.id).single().then(({ data }) => {
      if (data) setProfile(data);
      else setProfile({ id: session.user.id, name: session.user.email.split('@')[0], role: 'team' });
    });
  }, [session]);

  if (checking) return <Shell><div style={{ textAlign: "center", padding: 80, color: "#78716c" }}>Loading...</div></Shell>;
  if (recovering) return <SetNewPassword onDone={() => setRecovering(false)} />;
  if (!session) return <Login />;
  if (!profile) return <Shell><div style={{ textAlign: "center", padding: 80, color: "#78716c" }}>Loading profile...</div></Shell>;
  return <DealCommandCenter session={session} profile={profile} />;
}

// ─── Main App ────────────────────────────────────────────────────────
function DealCommandCenter({ session, profile }) {
  const [deals, setDeals] = useState([]);

  // ── Hash routing helpers ──────────────────────────────────────────
  const parseHash = () => {
    const parts = window.location.hash.replace('#', '').split('/').filter(Boolean);
    let tab = parts[2] || 'overview';
    // Legacy tab-name migration (Stage 1 consolidation, 2026-04-23):
    // old SMS + Activity tabs were merged into Comms. Bookmarks to the
    // retired names still resolve. Stage 2: vendors → contacts, notes → files.
    if (tab === 'sms' || tab === 'activity') tab = 'comms';
    if (tab === 'vendors') tab = 'contacts';
    if (tab === 'notes') tab = 'files';
    if (tab === 'documents') tab = 'files';
    return { dealId: parts[0] === 'deal' && parts[1] ? parts[1] : null, tab };
  };

  const [activeDealId, setActiveDealId] = useState(() => parseHash().dealId);
  const [loaded, setLoaded] = useState(false);
  const [showNewDeal, setShowNewDeal] = useState(false);
  const [teamMembers, setTeamMembers] = useState([profile.name]);
  const [recentActivity, setRecentActivity] = useState([]);
  const [showLog, setShowLog] = useState(false);
  const [showTeam, setShowTeam] = useState(false);
  const [showLeads, setShowLeads] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [showMoreSheet, setShowMoreSheet] = useState(false);
  const [newLeadCount, setNewLeadCount] = useState(0);
  const [unackDocketCount, setUnackDocketCount] = useState(0);
  const [pendingWalkthroughs, setPendingWalkthroughs] = useState([]);
  const [showWalkthroughs, setShowWalkthroughs] = useState(false);
  const [pendingOffersCount, setPendingOffersCount] = useState(0);
  const [showDocket, setShowDocket] = useState(false);
  const [showContacts, setShowContacts] = useState(false);
  const [showLibrary, setShowLibrary] = useState(false);
  const [showAccount, setShowAccount] = useState(false);
  const [view, setView] = useState("today"); // "today" | "active" | "archive" | "flagged"

  const userName = profile.name;
  const isAdmin = profile.role === 'admin' || profile.role === 'user';
  const isTeam = isAdmin || profile.role === 'va';

  const loadLeadCount = async () => {
    const { count } = await sb.from('leads').select('*', { count: 'exact', head: true }).eq('status', 'new');
    setNewLeadCount(count || 0);
  };

  const loadDocketCount = async () => {
    const { data } = await sb.rpc('docket_unacknowledged_count');
    setUnackDocketCount(data || 0);
  };

  const loadPendingWalkthroughs = async () => {
    const { data } = await sb.from('walkthrough_requests')
      .select('*, deals(name, address, meta)')
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(20);
    setPendingWalkthroughs(data || []);
  };

  const loadPendingOffersCount = async () => {
    const { count } = await sb.from('investor_offers').select('*', { count: 'exact', head: true })
      .in('status', ['new','pof-requested','pof-confirmed']);
    setPendingOffersCount(count || 0);
  };

  // Cmd+K / Ctrl+K → open search
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setShowSearch(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const loadDeals = async () => {
    const { data } = await sb.from('deals').select('*').order('created_at', { ascending: false });
    setDeals(data || []);
    setLoaded(true);
  };
  const loadTeam = async () => {
    const { data } = await sb.from('profiles').select('name').order('name');
    if (data) setTeamMembers(data.map(d => d.name));
  };
  const loadRecentActivity = async () => {
    const { data } = await sb.from('activity').select('*, profiles(name), deals(name)').order('created_at', { ascending: false }).limit(25);
    setRecentActivity(data || []);
  };

  useEffect(() => { loadDeals(); loadTeam(); loadRecentActivity(); loadLeadCount(); loadDocketCount(); loadPendingWalkthroughs(); loadPendingOffersCount(); }, []);

  // Presence heartbeat — every 60s while DCC is open in this tab, ping
  // touch_user_presence() so other team members see "active now". Skipped
  // when the tab is hidden (saves traffic). Driving the green dot in chat.
  useEffect(() => {
    let active = !document.hidden;
    const tick = () => { if (active) sb.rpc('touch_user_presence').then(() => {}, () => {}); };
    tick();  // immediate ping
    const iv = setInterval(tick, 60000);
    const onVis = () => { active = !document.hidden; if (active) tick(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(iv); document.removeEventListener('visibilitychange', onVis); };
  }, []);

  // realtime: any change to deals triggers refresh
  useEffect(() => {
    const ch = sb.channel('deals-ch')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'deals' }, loadDeals)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'activity' }, loadRecentActivity)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'leads' }, loadLeadCount)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'docket_events' }, loadDocketCount)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'walkthrough_requests' }, loadPendingWalkthroughs)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'investor_offers' }, loadPendingOffersCount)
      .subscribe();
    return () => { sb.removeChannel(ch); };
  }, []);

  const activeDeal = deals.find(d => d.id === activeDealId);

  // Sync activeDealId → hash (tab portion managed by DealDetail)
  useEffect(() => {
    if (activeDealId) {
      const { tab } = parseHash();
      window.location.hash = `#/deal/${activeDealId}/${tab}`;
    } else {
      window.location.hash = '#/';
    }
  }, [activeDealId]);

  // Back/forward button support
  useEffect(() => {
    const onHashChange = () => {
      const { dealId } = parseHash();
      setActiveDealId(dealId);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const addDeal = async (deal) => {
    const { error } = await sb.from('deals').insert({ ...deal, owner_id: session.user.id });
    if (error) { alert(error.message); return; }
    await loadDeals();
    setShowNewDeal(false);
    setActiveDealId(deal.id);
  };

  const updateDealMeta = async (id, patch) => {
    setDeals(ds => ds.map(d => d.id === id ? { ...d, ...patch } : d)); // optimistic
    await sb.from('deals').update(patch).eq('id', id);
  };

  const deleteDeal = async (id) => {
    if (!confirm("Delete this deal and all its data? This cannot be undone.")) return;
    await sb.from('deals').delete().eq('id', id);
    if (activeDealId === id) setActiveDealId(null);
    await loadDeals();
  };

  const signOut = async () => { await sb.auth.signOut(); };

  if (!loaded) return <Shell><div style={{ textAlign: "center", padding: 80, color: "#78716c" }}>Loading deals...</div></Shell>;

  return (
    <Shell>
      {/* Header */}
      <div className="header-bar" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 24, paddingBottom: 20, borderBottom: "1px solid #292524" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          {activeDeal && (
            <button onClick={() => setActiveDealId(null)} style={{ background: "transparent", border: "1px solid #44403c", color: "#a8a29e", padding: "6px 12px", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
              ← All Deals
            </button>
          )}
          <div>
            <div className="page-kicker" style={{ fontSize: 11, fontWeight: 600, color: "#d97706", letterSpacing: "0.15em", textTransform: "uppercase" }}>
              {activeDeal ? (activeDeal.type === "flip" ? "Flip Command Center" : "Surplus Fund Tracker") : "RefundLocators Deal Hub"}
            </div>
            {activeDeal ? (
              <InlineEditableName deal={activeDeal} canEdit={isTeam} onSave={(patch) => updateDealMeta(activeDeal.id, patch)} />
            ) : (
              <div className="page-title" style={{ fontSize: 32, fontWeight: 700, letterSpacing: "-0.02em", lineHeight: 1.1, marginTop: 4 }}>
                Deal Command Center
              </div>
            )}
            {activeDeal && (() => {
              // Click any field to edit inline. Suppresses the address if it's
              // just a duplicate of "[county] County" or "[county] County, OH"
              // (common data-import artifact from Castle / manual entry).
              const m = activeDeal.meta || {};
              const nameParts = (activeDeal.name || '').split(' - ');
              const addressFromName = nameParts.slice(1).join(' - ');
              const address = activeDeal.address || addressFromName || '';
              const courtCase = m.courtCase || '';
              const county = m.county || '';
              const addrNorm = address.trim().toLowerCase();
              const countyNorm = county.trim().toLowerCase();
              const isRedundantAddress = countyNorm && (
                addrNorm === `${countyNorm} county` ||
                addrNorm === `${countyNorm} county, oh` ||
                addrNorm === `${countyNorm} county, ohio`
              );
              const saveMeta = (patch) => updateDealMeta(activeDeal.id, { meta: { ...m, ...patch } });
              const saveAddress = (v) => updateDealMeta(activeDeal.id, { address: v || null });
              return (
                <div style={{ fontSize: 13, color: "#a8a29e", marginTop: 4, display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                  <InlineEditableText value={courtCase} label="case #" placeholder="e.g. CV-25-116796" canEdit={isTeam} onSave={(v) => saveMeta({ courtCase: v || null })} />
                  {(courtCase || county) && <span style={{ color: "#44403c" }}>·</span>}
                  <InlineEditableText
                    value={county ? `${county} County` : ''}
                    label="county"
                    placeholder="e.g. Cuyahoga"
                    canEdit={isTeam}
                    onSave={(v) => saveMeta({ county: v ? v.replace(/\s*County\s*$/i, '').trim() || null : null })}
                  />
                  {!isRedundantAddress && (
                    <>
                      {(courtCase || county) && <span style={{ color: "#44403c" }}>·</span>}
                      <InlineEditableText value={address} label="address" placeholder="e.g. 121 Main St, Cleveland, OH" canEdit={isTeam} onSave={saveAddress} />
                    </>
                  )}
                  {isRedundantAddress && isTeam && (
                    <button
                      onClick={() => saveAddress('')}
                      title="Clear the redundant address (it just says the county again)"
                      style={{ background: "transparent", border: "1px dashed #78350f", color: "#a5731c", padding: "1px 7px", borderRadius: 4, fontSize: 11, cursor: "pointer", fontFamily: "inherit" }}
                    >⚠ clear duplicate address</button>
                  )}
                </div>
              );
            })()}
          </div>
        </div>
        <div className="header-right" style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
          <span style={{ fontSize: 9, color: "#10b981", padding: "3px 8px", border: `1px solid #10b981`, borderRadius: 4, fontWeight: 700, letterSpacing: "0.06em" }}>SHARED</span>
          <span style={{ fontSize: 11, color: "#a8a29e" }}>{userName}</span>
          <button onClick={() => setShowSearch(true)} title="Search (⌘K)" style={{ ...btnGhost, fontSize: 11, display: "flex", alignItems: "center", gap: 6 }}>
            🔍 <span style={{ fontSize: 9, color: "#78716c", fontFamily: "'DM Mono', monospace", padding: "1px 5px", background: "#292524", borderRadius: 3 }}>⌘K</span>
          </button>
          {isTeam && <button onClick={() => setShowLeads(true)} style={{ ...btnGhost, fontSize: 11, position: "relative" }}>
            Leads {newLeadCount > 0 && <span style={{ display: "inline-block", marginLeft: 4, background: "#ef4444", color: "#fff", borderRadius: 8, padding: "0 6px", fontSize: 9, fontWeight: 700, minWidth: 14, textAlign: "center" }}>{newLeadCount}</span>}
          </button>}
          {isTeam && <button onClick={() => setShowDocket(true)} title="Docket events + scraper health" style={{ ...btnGhost, fontSize: 11, position: "relative", borderColor: unackDocketCount > 0 ? "#78350f" : "#44403c", color: unackDocketCount > 0 ? "#fbbf24" : "#78716c" }}>
            ⚖ Docket {unackDocketCount > 0 && <span style={{ display: "inline-block", marginLeft: 4, background: "#f59e0b", color: "#0c0a09", borderRadius: 8, padding: "0 6px", fontSize: 9, fontWeight: 700, minWidth: 14, textAlign: "center" }}>{unackDocketCount}</span>}
          </button>}
          {isTeam && pendingWalkthroughs.length > 0 && (
            <button onClick={() => setShowWalkthroughs(true)} title="Investor walkthrough requests" style={{ ...btnGhost, fontSize: 11, position: "relative", borderColor: "#78350f", color: "#fbbf24" }}>
              🏠 Walkthroughs <span style={{ display: "inline-block", marginLeft: 4, background: "#ef4444", color: "#fff", borderRadius: 8, padding: "0 6px", fontSize: 9, fontWeight: 700, minWidth: 14, textAlign: "center" }}>{pendingWalkthroughs.length}</span>
            </button>
          )}
          {isTeam && pendingOffersCount > 0 && (
            <button
              onClick={() => {
                // Find the first deal with a pending offer and jump to it; if user is on a deal already, do nothing.
                if (activeDealId) return;
                sb.from('investor_offers').select('deal_id').in('status', ['new','pof-requested','pof-confirmed']).order('submitted_at', { ascending: false }).limit(1).then(({ data }) => {
                  if (data && data[0]) setActiveDealId(data[0].deal_id);
                });
              }}
              title="Pending investor offers"
              style={{ ...btnGhost, fontSize: 11, position: "relative", borderColor: "#065f46", color: "#6ee7b7" }}
            >
              💰 Offers <span style={{ display: "inline-block", marginLeft: 4, background: "#10b981", color: "#0c0a09", borderRadius: 8, padding: "0 6px", fontSize: 9, fontWeight: 700, minWidth: 14, textAlign: "center" }}>{pendingOffersCount}</span>
            </button>
          )}
          {isTeam && <button onClick={() => setShowContacts(true)} title="Contacts / CRM" style={{ ...btnGhost, fontSize: 11 }}>👥 Contacts</button>}
          {isTeam && <button onClick={() => setShowLibrary(true)} title="Library (templates, SOPs, brand, legal)" style={{ ...btnGhost, fontSize: 11 }}>📚 Library</button>}
          {isTeam && <button onClick={() => setView("team")} title="Team chat with Justin + Lauren" style={{ ...btnGhost, fontSize: 11 }}>💬 Chat</button>}
          {isAdmin && <button onClick={() => setShowTeam(true)} title="Team management — invite, roles, status" style={{ ...btnGhost, fontSize: 11 }}>👥 Team</button>}
          <button onClick={() => setShowAccount(true)} title="Account settings" style={{ ...btnGhost, fontSize: 11 }}>⚙ Account</button>
          <button onClick={signOut} style={{ ...btnGhost, fontSize: 11 }}>Sign out</button>
        </div>
      </div>

      {showWalkthroughs && <WalkthroughRequestsModal onClose={() => setShowWalkthroughs(false)} userId={session.user.id} onJumpToDeal={(id) => { setActiveDealId(id); setShowWalkthroughs(false); }} />}
      {showNewDeal && <NewDealModal onAdd={addDeal} onClose={() => setShowNewDeal(false)} teamMembers={teamMembers} />}
      {showLog && <ActivityLogModal onClose={() => setShowLog(false)} onJumpToDeal={(id) => { setActiveDealId(id); setShowLog(false); }} />}
      {showTeam && <TeamModal onClose={() => setShowTeam(false)} currentUserId={session.user.id} />}
      {showAccount && <AccountSettingsModal onClose={() => setShowAccount(false)} userId={session.user.id} userEmail={session.user.email} />}
      {showLeads && <LeadsModal onClose={() => { setShowLeads(false); loadLeadCount(); }} userName={userName} onConverted={() => { loadDeals(); loadLeadCount(); }} />}
      {showSearch && <SearchModal deals={deals} onClose={() => setShowSearch(false)} onSelect={(id) => { setActiveDealId(id); setShowSearch(false); }} />}
      {showDocket && <DocketOverviewModal onClose={() => { setShowDocket(false); loadDocketCount(); }} onJumpToDeal={(id) => { setActiveDealId(id); setShowDocket(false); }} />}
      {showContacts && <ContactsModal onClose={() => setShowContacts(false)} isAdmin={isAdmin} userId={session.user.id} deals={deals} onJumpToDeal={(id) => { setActiveDealId(id); setShowContacts(false); }} />}
      {showLibrary && <LibraryModal onClose={() => setShowLibrary(false)} isAdmin={isAdmin} userId={session.user.id} />}

      {!activeDeal ? (
        <DealList deals={deals} activity={recentActivity} onSelect={setActiveDealId} onNew={() => setShowNewDeal(true)} onDelete={deleteDeal} onOpenLog={() => setShowLog(true)} view={view} setView={setView} teamMembers={teamMembers} onUpdateDeal={updateDealMeta} isAdmin={isAdmin} onToggleFlag={(id) => {
          const d = deals.find(x => x.id === id);
          if (!d) return;
          const m = d.meta || {};
          updateDealMeta(id, { meta: { ...m, flagged: !m.flagged } });
        }} />
      ) : (
        <DealDetail key={activeDeal.id} deal={activeDeal} userName={userName} userId={session.user.id} teamMembers={teamMembers} isAdmin={isAdmin} onUpdateDeal={(patch) => updateDealMeta(activeDeal.id, patch)} initialTab={parseHash().tab} />
      )}

      {/* Mobile FAB — only visible on phone via CSS */}
      {!activeDeal && (
        <button className="fab" onClick={() => setShowNewDeal(true)} aria-label="Add new deal">+</button>
      )}

      {/* Mobile bottom-nav — LeadConnector-style. Hidden on deal detail
          so the full viewport belongs to the conversation/content view. */}
      {!activeDeal && (
        <nav className="bottom-nav" aria-label="Primary navigation">
          <div className="bottom-nav-inner">
            <button className={view === 'today' ? 'active' : ''} onClick={() => setView('today')}>
              <span className="nav-icon">📌</span>Today
            </button>
            <button className={view === 'pipeline' ? 'active' : ''} onClick={() => setView('pipeline')}>
              <span className="nav-icon">🧭</span>Pipeline
            </button>
            <button className={view === 'tasks' ? 'active' : ''} onClick={() => setView('tasks')}>
              <span className="nav-icon">✓</span>Tasks
            </button>
            <button className={view === 'active' ? 'active' : ''} onClick={() => setView('active')}>
              <span className="nav-icon">📁</span>Deals
            </button>
            <button onClick={() => setShowMoreSheet(true)}>
              <span className="nav-icon">⋯</span>More
              {(newLeadCount + unackDocketCount) > 0 && <span className="nav-badge">{newLeadCount + unackDocketCount}</span>}
            </button>
          </div>
        </nav>
      )}

      {/* Mobile More sheet — overflow of secondary views + modals */}
      {showMoreSheet && (
        <Modal onClose={() => setShowMoreSheet(false)} title="More">
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {[
              { label: '⚑ Flagged',     onClick: () => setView('flagged'),  count: 0 },
              { label: '🩺 Hygiene',    onClick: () => setView('hygiene'),  count: 0 },
              { label: '📦 Closed',     onClick: () => setView('archive'),  count: 0 },
              ...(isAdmin ? [
                { label: '📈 Reports',   onClick: () => setView('reports'),   count: 0 },
                { label: '📊 Analytics', onClick: () => setView('analytics'), count: 0 },
              ] : []),
              { sep: 'Quick access' },
              { label: '🤖 Chat with Lauren', onClick: () => window.dispatchEvent(new Event('dcc:open-lauren')), count: 0 },
              { label: '📥 Leads',       onClick: () => setShowLeads(true),    count: newLeadCount },
              { label: '⚖ Docket',       onClick: () => setShowDocket(true),   count: unackDocketCount, show: isTeam },
              { label: '👥 Contacts',    onClick: () => setShowContacts(true), count: 0, show: isTeam },
              { label: '📚 Library',     onClick: () => setShowLibrary(true),  count: 0, show: isTeam },
              { label: '🔍 Search',      onClick: () => setShowSearch(true),   count: 0 },
              ...(pendingWalkthroughs.length > 0 ? [{ label: '🏠 Walkthroughs', onClick: () => setShowWalkthroughs(true), count: pendingWalkthroughs.length }] : []),
              { sep: 'Account' },
              ...(isAdmin ? [{ label: '👤 Team',        onClick: () => setShowTeam(true),     count: 0 }] : []),
              { label: '↪ Sign out',     onClick: signOut, count: 0, destructive: true },
            ].filter(i => i.show !== false).map((item, idx) => {
              if (item.sep) {
                return <div key={'sep-' + idx} style={{ fontSize: 10, fontWeight: 700, color: '#57534e', letterSpacing: '0.12em', textTransform: 'uppercase', padding: '12px 8px 4px' }}>{item.sep}</div>;
              }
              return (
                <button key={item.label} onClick={() => { item.onClick(); setShowMoreSheet(false); }}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    width: '100%', padding: '14px 12px', fontSize: 14, fontWeight: 600,
                    background: 'transparent', border: 'none',
                    borderBottom: '1px solid #1c1917',
                    color: item.destructive ? '#fca5a5' : '#d6d3d1',
                    cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit',
                  }}>
                  <span>{item.label}</span>
                  {item.count > 0 && <span style={{ background: '#ef4444', color: '#fff', borderRadius: 10, padding: '1px 8px', fontSize: 11, fontWeight: 700 }}>{item.count}</span>}
                </button>
              );
            })}
          </div>
        </Modal>
      )}
    </Shell>
  );
}

// ─── Deal List ───────────────────────────────────────────────────────
function DealList({ deals, activity, onSelect, onNew, onDelete, onOpenLog, view, setView, onToggleFlag, teamMembers, onUpdateDeal, isAdmin }) {
  const [searchQ, setSearchQ] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [layoutMode, setLayoutMode] = useState("cards"); // "cards" | "kanban"

  const ARCHIVE_STATUSES = ["closed", "recovered", "dead"];
  const activeDeals = deals.filter(d => !ARCHIVE_STATUSES.includes(d.status));
  const archivedDeals = deals.filter(d => ARCHIVE_STATUSES.includes(d.status));

  // Kanban drag-and-drop: persist the new status (and stamp closed_at
  // on close/recover, clear it on move-back-to-active).
  const onMoveDeal = (id, prev, next) => {
    const patch = { status: next };
    const d = deals.find(x => x.id === id);
    const wasClosed = ARCHIVE_STATUSES.includes(prev);
    const isClosedNow = ARCHIVE_STATUSES.includes(next);
    if (isClosedNow && !wasClosed && !(d && d.closed_at)) patch.closed_at = new Date().toISOString();
    if (!isClosedNow && wasClosed) patch.closed_at = null;
    onUpdateDeal(id, patch);
  };
  const flaggedDeals = deals.filter(d => d.meta?.flagged);

  const allStatuses = [...new Set([...DEAL_STATUSES.flip, ...DEAL_STATUSES.surplus])];

  const preFiltered = view === "archive" ? archivedDeals : view === "flagged" ? flaggedDeals : activeDeals;
  const visible = preFiltered.filter(d => {
    const q = searchQ.toLowerCase();
    if (q && !(d.name || "").toLowerCase().includes(q) && !(d.address || "").toLowerCase().includes(q)) return false;
    if (statusFilter !== "all" && d.status !== statusFilter) return false;
    return true;
  });
  const flips = visible.filter(d => d.type === "flip");
  const surplus = visible.filter(d => d.type === "surplus");

  const year = new Date().getFullYear();
  const closedYtd = deals.filter(d => (d.status === "closed" || d.status === "recovered") && (!d.closed_at || new Date(d.closed_at).getFullYear() === year));
  const ytdProfit = closedYtd.reduce((s, d) => s + (computeDealNet(d) || 0), 0);
  const pipeline = activeDeals;
  const estFlipProfit = activeDeals.filter(d => d.type === "flip").reduce((s, d) => s + (computeDealNet(d) || 0), 0);
  const estSurplusProfit = activeDeals.filter(d => d.type === "surplus").reduce((s, d) => s + (computeDealNet(d) || 0), 0);
  const estProfit = estFlipProfit + estSurplusProfit;
  const stale = activeDeals.filter(d => {
    const last = d.updated_at || d.created;
    return last && daysSince(last) > 14;
  });

  const exportCSV = () => {
    const rows = visible.map(d => ({
      id: d.id, type: d.type, name: d.name, address: d.address || "",
      status: d.status, flagged: d.meta?.flagged ? "Y" : "", lead_source: d.meta?.lead_source || d.lead_source || "", deadline: d.meta?.deadline || d.deadline || "",
      filed_at: d.meta?.filed_at || d.filed_at || "", actual_net: d.actual_net || "",
      list_price: d.meta?.listPrice || "", contract_price: d.meta?.contractPrice || "",
      estimated_surplus: d.meta?.estimatedSurplus || "", county: d.meta?.county || "",
      created: d.created || "",
    }));
    downloadCSV(rows, `deals-${view}-${new Date().toISOString().slice(0,10)}.csv`);
  };

  const viewBtn = (id, label, count) => (
    <button key={id} onClick={() => setView(id)} style={{
      background: view === id ? "#292524" : "transparent",
      color: view === id ? "#fafaf9" : "#78716c",
      border: view === id ? "1px solid #44403c" : "1px solid transparent",
      padding: "6px 14px", borderRadius: 6, fontSize: 12, fontWeight: view === id ? 700 : 500, cursor: "pointer",
    }}>{label}{count > 0 ? ` (${count})` : ""}</button>
  );

  // Group button — highlights when ANY child view is active. Clicking sets
  // view to the default child. Used for hubs (Outreach / Deals / Insights)
  // that consolidate multiple sibling views into one top-nav entry.
  const groupBtn = (defaultId, label, groupIds, count) => {
    const active = groupIds.includes(view);
    return (
      <button key={defaultId} onClick={() => setView(defaultId)} style={{
        background: active ? "#292524" : "transparent",
        color: active ? "#fafaf9" : "#78716c",
        border: active ? "1px solid #44403c" : "1px solid transparent",
        padding: "6px 14px", borderRadius: 6, fontSize: 12, fontWeight: active ? 700 : 500, cursor: "pointer",
      }}>{label}{count > 0 ? ` (${count})` : ""}</button>
    );
  };

  // Sub-chip — smaller, lives in the hub's second-level chip bar.
  const chipBtn = (id, label) => (
    <button key={id} onClick={() => setView(id)} style={{
      background: view === id ? "#1c1917" : "transparent",
      color: view === id ? "#fafaf9" : "#78716c",
      border: view === id ? "1px solid #44403c" : "1px solid transparent",
      padding: "5px 11px", borderRadius: 5, fontSize: 11, fontWeight: view === id ? 700 : 500, cursor: "pointer",
    }}>{label}</button>
  );

  return (
    <div>
      {/* Portfolio summary */}
      <div className="portfolio-stats" style={{ display: "grid", gridTemplateColumns: isAdmin ? "repeat(5, 1fr)" : "repeat(3, 1fr)", gap: 12, marginBottom: 20 }}>
        {isAdmin && <PortfolioStat label={`${year} Profit Booked`} value={fmt(ytdProfit)} sub={`${closedYtd.length} closed deals`} color="#10b981" />}
        <PortfolioStat label="Active Pipeline" value={pipeline.length} sub={`${activeDeals.filter(d => d.type === "flip").length} flips · ${activeDeals.filter(d => d.type === "surplus").length} surplus`} color="#3b82f6" />
        <PortfolioStat label="Flagged" value={flaggedDeals.length} sub={flaggedDeals.length ? "needs review" : "none flagged"} color={flaggedDeals.length ? "#f59e0b" : "#78716c"} />
        {isAdmin && <PortfolioStat label="Estimated Profit" value={fmt(estProfit)} sub={`${fmt(estFlipProfit)} flips · ${fmt(estSurplusProfit)} surplus`} color="#f59e0b" />}
        <PortfolioStat label="Closed Deals" value={archivedDeals.length} sub={`${archivedDeals.filter(d=>d.status==="dead").length} dead · ${archivedDeals.filter(d=>d.status!=="dead").length} won`} color="#a8a29e" />
      </div>

      <div className="view-controls" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <div style={{ display: "flex", gap: 4, alignItems: "center", background: "#1c1917", borderRadius: 8, padding: 3, border: "1px solid #292524" }}>
          {viewBtn("today", "📌 Today", 0)}
          {viewBtn("attention", "🔔 Attention", 0)}
          {groupBtn("outreach", "🎯 Outreach", ["outreach", "leads", "forecast"], 0)}
          {groupBtn("active", "🏠 Deals", ["active", "flagged", "hygiene", "archive", "pipeline"], flaggedDeals.length)}
          {viewBtn("tasks", "✓ Tasks", 0)}
          {isAdmin && groupBtn("reports", "📊 Insights", ["reports", "analytics", "traffic"], 0)}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={exportCSV} style={btnGhost}>Export CSV</button>
          <button className="desktop-new-deal" onClick={onNew} style={btnPrimary}>+ New Deal</button>
        </div>
      </div>

      {/* Hub sub-chips — second-level nav inside the consolidated tabs.
          Outreach hub:  drafts/replies · leads · forecast
          Deals hub:     active · flagged · hygiene · closed · kanban
          Insights hub:  reports · analytics · traffic */}
      {["outreach", "leads", "forecast"].includes(view) && (
        <div style={{ display: "flex", gap: 4, marginBottom: 16, background: "#0c0a09", borderRadius: 8, padding: 3, border: "1px solid #292524", width: "fit-content" }}>
          {chipBtn("outreach", "🤖 Drafts & Replies")}
          {chipBtn("leads", "📨 Leads")}
          {chipBtn("forecast", "📅 Forecast")}
        </div>
      )}
      {["active", "flagged", "hygiene", "archive", "pipeline"].includes(view) && (
        <div style={{ display: "flex", gap: 4, marginBottom: 16, background: "#0c0a09", borderRadius: 8, padding: 3, border: "1px solid #292524", width: "fit-content", flexWrap: "wrap" }}>
          {chipBtn("active", `Active${activeDeals.length ? ` (${activeDeals.length})` : ""}`)}
          {chipBtn("flagged", `⚑ Flagged${flaggedDeals.length ? ` (${flaggedDeals.length})` : ""}`)}
          {chipBtn("hygiene", "🩺 Hygiene")}
          {chipBtn("archive", `Closed${archivedDeals.length ? ` (${archivedDeals.length})` : ""}`)}
          {chipBtn("pipeline", "🧭 Kanban")}
        </div>
      )}
      {isAdmin && ["reports", "analytics", "traffic"].includes(view) && (
        <div style={{ display: "flex", gap: 4, marginBottom: 16, background: "#0c0a09", borderRadius: 8, padding: 3, border: "1px solid #292524", width: "fit-content" }}>
          {chipBtn("reports", "📈 Reports")}
          {chipBtn("analytics", "📊 Analytics")}
          {chipBtn("traffic", "🌐 Traffic")}
        </div>
      )}

      {/* Search / Filter / Layout toggle bar (hidden on Today / Reports / Analytics / Hygiene / Pipeline / Tasks / Team / Leads views) */}
      {view !== "today" && view !== "attention" && view !== "outreach" && view !== "forecast" && view !== "leads" && view !== "reports" && view !== "analytics" && view !== "traffic" && view !== "hygiene" && view !== "pipeline" && view !== "tasks" && view !== "team" && (
        <div style={{ display: "flex", gap: 10, marginBottom: 18, alignItems: "center", flexWrap: "wrap" }}>
          <input value={searchQ} onChange={e => setSearchQ(e.target.value)} placeholder="Search deals by name or address..." style={{ ...inputStyle, maxWidth: 300, background: "#1c1917" }} />
          <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} style={{ ...selectStyle, minWidth: 140 }}>
            <option value="all">All Statuses</option>
            <optgroup label="Flip Statuses">
              {DEAL_STATUSES.flip.map(s => <option key={s} value={s}>{s.replace(/-/g, " ").toUpperCase()}</option>)}
            </optgroup>
            <optgroup label="Surplus Statuses">
              {DEAL_STATUSES.surplus.map(s => <option key={s} value={s}>{s.replace(/-/g, " ").toUpperCase()}</option>)}
            </optgroup>
          </select>
          <div style={{ marginLeft: "auto", display: "flex", gap: 4, background: "#1c1917", borderRadius: 6, padding: 2, border: "1px solid #292524" }}>
            <button onClick={() => setLayoutMode("cards")} style={{ background: layoutMode === "cards" ? "#292524" : "transparent", color: layoutMode === "cards" ? "#fafaf9" : "#78716c", border: "none", padding: "5px 12px", borderRadius: 5, fontSize: 11, fontWeight: 600, cursor: "pointer" }}>Cards</button>
            <button onClick={() => setLayoutMode("kanban")} style={{ background: layoutMode === "kanban" ? "#292524" : "transparent", color: layoutMode === "kanban" ? "#fafaf9" : "#78716c", border: "none", padding: "5px 12px", borderRadius: 5, fontSize: 11, fontWeight: 600, cursor: "pointer" }}>Kanban</button>
          </div>
        </div>
      )}

      <div className="main-grid" style={{ display: "grid", gridTemplateColumns: (view === "attention" || view === "outreach" || view === "forecast" || view === "leads" || view === "reports" || view === "analytics" || view === "traffic" || view === "pipeline" || view === "tasks" || view === "team") ? "1fr" : "1fr 320px", gap: 20 }}>
        <div>
          {view === "today" ? (
            <TodayView deals={deals} onSelect={onSelect} isAdmin={isAdmin} setView={setView} />
          ) : view === "attention" ? (
            <AttentionView deals={deals} onSelect={onSelect} />
          ) : view === "outreach" ? (
            <OutreachView deals={deals} onSelect={onSelect} />
          ) : view === "forecast" ? (
            <ForecastView deals={deals} onSelect={onSelect} />
          ) : view === "leads" ? (
            <LeadsOutreachView />
          ) : view === "reports" ? (
            <ReportsView deals={deals} onSelect={onSelect} />
          ) : view === "analytics" ? (
            <AnalyticsView deals={deals} onSelect={onSelect} />
          ) : view === "traffic" ? (
            <WebTrafficView />
          ) : view === "hygiene" ? (
            <HygieneDashboard deals={deals} onSelect={onSelect} />
          ) : view === "pipeline" ? (
            <SalesPipeline deals={deals} onSelect={onSelect} onUpdateDeal={(id, patch) => onUpdateDeal(id, patch)} />
          ) : view === "tasks" ? (
            <GlobalTasksView deals={deals} onJumpToDeal={onSelect} />
          ) : view === "team" ? (
            <TeamView teamMembers={teamMembers} />
          ) : layoutMode === "kanban" ? (
            <div>
              {flips.length > 0 && (
                <div style={{ marginBottom: 28 }}>
                  <SectionLabel icon="🏠" label="Flips — Kanban" />
                  <KanbanBoard deals={flips} statuses={DEAL_STATUSES.flip} onSelect={onSelect} type="flip" onMoveDeal={onMoveDeal} />
                </div>
              )}
              {surplus.length > 0 && (
                <div>
                  <SectionLabel icon="💰" label="Surplus — Kanban" />
                  <KanbanBoard deals={surplus} statuses={DEAL_STATUSES.surplus} onSelect={onSelect} type="surplus" onMoveDeal={onMoveDeal} />
                </div>
              )}
              {visible.length === 0 && (
                <div style={{ textAlign: "center", padding: 60, color: "#78716c", border: "1px dashed #292524", borderRadius: 10 }}>
                  {view === "active" ? <>No active deals. Click <b>+ New Deal</b> to add one.</> : view === "flagged" ? "No flagged deals." : "No closed deals yet."}
                </div>
              )}
            </div>
          ) : (
            <div>
              {flips.length > 0 && (<>
                <SectionLabel icon="🏠" label={view === "archive" ? "Closed Flips" : view === "flagged" ? "Flagged Flips" : "Real Estate Flips"} />
                <div className="deal-grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 14, marginBottom: 28 }}>
                  {flips.map(d => <DealCard key={d.id} deal={d} onClick={() => onSelect(d.id)} onDelete={() => onDelete(d.id)} onToggleFlag={() => onToggleFlag(d.id)} />)}
                </div>
              </>)}
              {surplus.length > 0 && (<>
                <SectionLabel icon="💰" label={view === "archive" ? "Closed Surplus" : view === "flagged" ? "Flagged Surplus" : "Surplus Fund Cases"} />
                <div className="deal-grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 14 }}>
                  {surplus.map(d => <SurplusCard key={d.id} deal={d} onClick={() => onSelect(d.id)} onDelete={() => onDelete(d.id)} onToggleFlag={() => onToggleFlag(d.id)} />)}
                </div>
              </>)}
              {visible.length === 0 && (
                <div style={{ textAlign: "center", padding: 60, color: "#78716c", border: "1px dashed #292524", borderRadius: 10 }}>
                  {view === "active" ? <>No active deals. Click <b>+ New Deal</b> to add one.</> : view === "flagged" ? "No flagged deals. Click the ⚑ icon on a deal card to flag it for review." : "No closed deals yet. Closed, recovered, and dead deals appear here."}
                </div>
              )}
            </div>
          )}
        </div>
        {view !== "reports" && view !== "analytics" && view !== "traffic" && view !== "pipeline" && view !== "tasks" && <div>
          <div style={{ background: "#1c1917", border: "1px solid #292524", borderRadius: 10, padding: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#78716c", letterSpacing: "0.12em", textTransform: "uppercase" }}>Team Activity</div>
              <button onClick={onOpenLog} style={{ background: "transparent", border: "1px solid #44403c", color: "#d97706", padding: "4px 10px", borderRadius: 5, fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", cursor: "pointer" }}>Full Log →</button>
            </div>
            {(!activity || activity.length === 0) ? (
              <div style={{ fontSize: 12, color: "#78716c", padding: "8px 0" }}>No recent activity.</div>
            ) : activity.slice(0, 25).map(a => {
              const who = a.profiles?.name || "Unknown";
              return (
                <div key={a.id} onClick={() => a.deal_id && onSelect(a.deal_id)} style={{ padding: "8px 0", borderBottom: "1px solid #292524", fontSize: 11, cursor: a.deal_id ? "pointer" : "default" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 6 }}>
                    <span style={{ fontWeight: 700, background: personColor(who), padding: "1px 6px", borderRadius: 3, fontSize: 10, color: "#fafaf9" }}>{who}</span>
                    <span style={{ color: "#78716c" }}>{new Date(a.created_at).toLocaleDateString()} {new Date(a.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                  </div>
                  <div style={{ color: "#a8a29e", marginTop: 3 }}>{a.action}</div>
                  {a.deals?.name && <div style={{ color: "#78716c", marginTop: 2, fontStyle: "italic" }}>on {a.deals.name} →</div>}
                </div>
              );
            })}
          </div>
          {stale.length > 0 && view === "active" && (
            <div style={{ background: "#1c1917", border: "1px solid #292524", borderRadius: 10, padding: 16, marginTop: 16 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#ef4444", letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 10 }}>Stale Deals (14+ days)</div>
              {stale.map(d => (
                <div key={d.id} onClick={() => onSelect(d.id)} style={{ padding: "6px 0", borderBottom: "1px solid #292524", fontSize: 11, cursor: "pointer" }}>
                  <span style={{ color: "#fafaf9", fontWeight: 600 }}>{d.name}</span>
                  <span style={{ color: "#78716c", marginLeft: 8 }}>{daysSince(d.updated_at || d.created)}d ago</span>
                </div>
              ))}
            </div>
          )}
        </div>}
      </div>
    </div>
  );
}

// ─── Sales Pipeline (CRM-style GHL replacement) ──────────────────────
// Parallel lens to deal `status`. While status tracks where the CASE is
// (filed → probate → awaiting-distribution), sales_stage tracks where the
// LEAD is in Nathan + Eric's outreach funnel (new → texted → responded →
// signed → ...). Two boards: Surplus (long-arc recovery) and 30DTS (auction
// within 30 days, may get wholesaled).
//
// Castle feeds the scoring columns (lead_tier A/B/C, is_30dts, death_signal,
// surplus_estimate, days_to_sale, scored_at). This view reads them, renders
// tier badges, filters by tier, and sorts A/30DTS first with earliest sale
// date up top so Eric always works the most urgent + highest-value first.

const SURPLUS_STAGES = [
  { key: 'new',             label: 'New',              color: '#3b82f6' },
  { key: 'texted',          label: 'Texted',           color: '#8b5cf6' },
  { key: 'responded',       label: 'Responded',        color: '#06b6d4' },
  { key: 'agreement-sent',  label: 'Agreement Sent',   color: '#d97706' },
  { key: 'signed',          label: 'Signed',           color: '#f59e0b' },
  { key: 'filed',           label: 'Filed',            color: '#ec4899' },
  { key: 'paid-out',        label: 'Paid Out',         color: '#10b981' },
];
const DTS_STAGES = [
  { key: 'new',                   label: 'New',              color: '#ef4444' },
  { key: 'texted',                label: 'Texted',           color: '#8b5cf6' },
  { key: 'responded',             label: 'Responded',        color: '#06b6d4' },
  { key: 'wholesale-offer',       label: 'Wholesale Offer',  color: '#d97706' },
  { key: 'under-contract',        label: 'Under Contract',   color: '#f59e0b' },
  { key: 'auction',               label: 'Auction',          color: '#a83232' },
  { key: 'post-auction-surplus',  label: 'Post-Auction',     color: '#10b981' },
];

const TIER_META = {
  A: { label: 'A', bg: '#d8b560', fg: '#0c0a09', title: 'A lead — $100k+ surplus, owner alive' },
  B: { label: 'B · estate', bg: '#8b5cf6', fg: '#fafaf9', title: 'B lead — $100k+, likely deceased (family/heirs outreach)' },
  C: { label: 'C', bg: '#44403c', fg: '#d6d3d1', title: 'C lead — $10k–$99,999 surplus' },
};

function TierBadge({ deal }) {
  const t = deal.lead_tier;
  if (!t || !TIER_META[t]) return null;
  // Override label for deceased B-leads OR any tier with a death signal
  const meta = TIER_META[t];
  const finalLabel = (t !== 'B' && deal.death_signal) ? (meta.label + ' · estate') : meta.label;
  return (
    <span
      title={meta.title}
      style={{
        fontSize: 9,
        fontWeight: 700,
        padding: '2px 7px',
        borderRadius: 3,
        background: meta.bg,
        color: meta.fg,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        whiteSpace: 'nowrap',
      }}
    >{finalLabel}</span>
  );
}

function DTSCountdown({ days }) {
  if (days == null || days < 0) return null;
  const urgent = days <= 7;
  return (
    <span style={{
      fontSize: 9,
      fontWeight: 700,
      padding: '2px 7px',
      borderRadius: 3,
      background: urgent ? '#7f1d1d' : '#78350f',
      color: urgent ? '#fca5a5' : '#fbbf24',
      letterSpacing: '0.06em',
      textTransform: 'uppercase',
      fontFamily: "'DM Mono', monospace",
      whiteSpace: 'nowrap',
      animation: urgent ? 'pulse 2s ease-in-out infinite' : 'none',
    }}>
      {days === 0 ? 'SALE TODAY' : days === 1 ? '1d to sale' : `${days}d to sale`}
    </span>
  );
}

function StalenessTag({ lastContactedAt }) {
  if (!lastContactedAt) return <span style={{ fontSize: 9, color: '#ef4444', fontWeight: 700 }}>· never contacted</span>;
  const hrs = Math.floor((Date.now() - new Date(lastContactedAt).getTime()) / 3_600_000);
  const days = Math.floor(hrs / 24);
  if (days > 14) return <span style={{ fontSize: 9, color: '#ef4444' }}>· {days}d cold</span>;
  if (days > 7)  return <span style={{ fontSize: 9, color: '#f59e0b' }}>· {days}d since contact</span>;
  if (days > 0)  return <span style={{ fontSize: 9, color: '#78716c' }}>· {days}d ago</span>;
  return <span style={{ fontSize: 9, color: '#78716c' }}>· today</span>;
}

// Compares name vs. "Lastname - Street" split to show "Estate of Kemper Ansel"
// for deceased leads where the handoff wants heir-focused framing.
function DealCardName({ deal }) {
  const first = (deal.name || '').split(' - ')[0] || deal.name || 'Unnamed';
  const isEstate = deal.death_signal || deal.lead_tier === 'B';
  return (
    <div style={{ fontSize: 12, fontWeight: 700, lineHeight: 1.3, color: '#fafaf9' }}>
      {isEstate ? <span style={{ color: '#c4b5fd' }}>Estate of </span> : null}
      {first}
    </div>
  );
}

// ─── Team Chat (Phase 1) ─────────────────────────────────────────────
// Internal messaging for N + J inside DCC. Phase 2 brings file attachments
// and Lauren as a participant. Phase 3 = multi-thread, reactions, threading.
//
// Schema lives in 20260427000000_team_chat_phase1.sql:
//   team_threads · team_messages · team_message_reads · team_reactions
function TeamView({ teamMembers }) {
  const [threads, setThreads] = useState([]);
  const [activeThreadId, setActiveThreadId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [profilesById, setProfilesById] = useState({});
  const [me, setMe] = useState({ id: null, name: '', role: 'admin' });
  const [pendingAttachments, setPendingAttachments] = useState([]);  // [{name, size, type, path, url}]
  const [uploadingFiles, setUploadingFiles] = useState(false);
  const [lightboxUrl, setLightboxUrl] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [showNewThreadModal, setShowNewThreadModal] = useState(false);
  const [actionsByMessageId, setActionsByMessageId] = useState({});  // pending action map for current thread
  const [participantsByThreadId, setParticipantsByThreadId] = useState({});
  const [reactionsByMessageId, setReactionsByMessageId] = useState({});  // { msgId: [{emoji,user_id,...}] }
  const [reactionPickerForId, setReactionPickerForId] = useState(null);
  const [editingMessageId, setEditingMessageId] = useState(null);
  const [editingBody, setEditingBody] = useState('');
  const [mentionState, setMentionState] = useState(null);  // { open, prefix, anchorPos }
  const dragDepth = useRef(0);
  const messagesEndRef = useRef(null);
  const composerRef = useRef(null);
  const fileInputRef = useRef(null);

  // Load current user + initial threads + their profile names
  const loadThreads = async () => {
    const { data: t } = await sb.from('team_threads').select('*').is('archived_at', null).order('created_at', { ascending: true });
    setThreads(t || []);
    // Hydrate participant lists for any DMs (so we can label "DM with Justin" instead of generic title)
    const dmIds = (t || []).filter(x => x.thread_type === 'dm').map(x => x.id);
    if (dmIds.length) {
      const { data: parts } = await sb.from('team_thread_participants').select('thread_id, user_id').in('thread_id', dmIds);
      const map = {};
      (parts || []).forEach(p => {
        if (!map[p.thread_id]) map[p.thread_id] = [];
        map[p.thread_id].push(p.user_id);
      });
      setParticipantsByThreadId(map);
    }
    return t;
  };

  useEffect(() => {
    (async () => {
      const { data: { user } } = await sb.auth.getUser();
      if (user) {
        const { data: prof } = await sb.from('profiles').select('id, name, role').eq('id', user.id).single();
        setMe({ id: user.id, name: prof?.name || user.email || 'Me', role: prof?.role || 'admin' });
      }
      const t = await loadThreads();
      if (t && t.length > 0 && !activeThreadId) setActiveThreadId(t[0].id);

      // Cache all team profiles for sender display
      const { data: profs } = await sb.from('profiles').select('id, name, display_name, avatar_path, last_active_at').in('role', ['admin','user','va']);
      const byId = {};
      (profs || []).forEach(p => {
        let avatarUrl = null;
        if (p.avatar_path) {
          const { data } = sb.storage.from('avatars').getPublicUrl(p.avatar_path);
          avatarUrl = data?.publicUrl || null;
        }
        byId[p.id] = { ...p, avatar_url: avatarUrl };
      });
      setProfilesById(byId);
    })();
    // eslint-disable-next-line
  }, []);

  // Subscribe to thread-list changes (so a new thread created from another device shows up)
  useEffect(() => {
    const ch = sb.channel('team-threads-list')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'team_threads' }, () => loadThreads())
      .subscribe();
    return () => { sb.removeChannel(ch); };
  }, []);

  // Load messages for active thread + subscribe to realtime
  useEffect(() => {
    if (!activeThreadId) return;
    let cancelled = false;
    (async () => {
      const { data } = await sb.from('team_messages')
        .select('*')
        .eq('thread_id', activeThreadId)
        .is('deleted_at', null)
        .order('created_at', { ascending: true })
        .limit(500);
      if (cancelled) return;
      setMessages(data || []);
      // Mark thread read
      if (me.id) {
        await sb.from('team_message_reads').upsert({
          thread_id: activeThreadId, user_id: me.id, last_read_at: new Date().toISOString()
        }, { onConflict: 'thread_id,user_id' });
      }
    })();
    const ch = sb.channel('team-msgs-' + activeThreadId)
      .on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'team_messages', filter: `thread_id=eq.${activeThreadId}`
      }, (payload) => {
        const row = payload.new;
        setMessages(prev => prev.find(m => m.id === row.id) ? prev : [...prev, row]);
        // If new message is from someone else, mark thread as read shortly after
        if (me.id && row.sender_id !== me.id) {
          setTimeout(() => {
            sb.from('team_message_reads').upsert({
              thread_id: activeThreadId, user_id: me.id, last_read_at: new Date().toISOString()
            }, { onConflict: 'thread_id,user_id' });
          }, 800);
        }
      })
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'team_messages', filter: `thread_id=eq.${activeThreadId}`
      }, (payload) => {
        setMessages(prev => prev.map(m => m.id === payload.new.id ? payload.new : m));
      })
      .subscribe();
    return () => { cancelled = true; sb.removeChannel(ch); };
    // eslint-disable-next-line
  }, [activeThreadId, me.id]);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (messagesEndRef.current) messagesEndRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length]);

  // Load + subscribe to reactions for the active thread's messages.
  useEffect(() => {
    if (!activeThreadId || messages.length === 0) return;
    let cancelled = false;
    const messageIds = messages.map(m => m.id);
    const loadReactions = async () => {
      const { data } = await sb.from('team_reactions').select('*').in('message_id', messageIds);
      if (cancelled) return;
      const map = {};
      (data || []).forEach(r => {
        if (!map[r.message_id]) map[r.message_id] = [];
        map[r.message_id].push(r);
      });
      setReactionsByMessageId(map);
    };
    loadReactions();
    const ch = sb.channel('team-reactions-' + activeThreadId)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'team_reactions' }, loadReactions)
      .subscribe();
    return () => { cancelled = true; sb.removeChannel(ch); };
  }, [activeThreadId, messages.length]);

  const toggleReaction = async (messageId, emoji) => {
    const existing = (reactionsByMessageId[messageId] || []).find(r => r.user_id === me.id && r.emoji === emoji);
    if (existing) {
      await sb.from('team_reactions').delete().eq('id', existing.id);
    } else {
      await sb.from('team_reactions').insert({ message_id: messageId, user_id: me.id, emoji });
    }
    setReactionPickerForId(null);
  };

  const startEdit = (msg) => {
    setEditingMessageId(msg.id);
    setEditingBody(msg.body);
  };
  const cancelEdit = () => {
    setEditingMessageId(null);
    setEditingBody('');
  };
  const saveEdit = async () => {
    if (!editingMessageId) return;
    const trimmed = editingBody.trim();
    if (!trimmed) return cancelEdit();
    await sb.from('team_messages').update({ body: trimmed, edited_at: new Date().toISOString() }).eq('id', editingMessageId).eq('sender_id', me.id);
    cancelEdit();
  };

  const deleteMessage = async (msg) => {
    if (!window.confirm('Delete this message?')) return;
    await sb.from('team_messages').update({ deleted_at: new Date().toISOString() }).eq('id', msg.id).eq('sender_id', me.id);
  };

  // @mention autocomplete: scan composer body for an open '@'-prefix at the
  // current caret position. Returns null when not in a mention context.
  const computeMentionState = (text, caret) => {
    const before = text.slice(0, caret);
    const m = before.match(/(?:^|\s)@(\w*)$/);
    if (!m) return null;
    return { prefix: m[1].toLowerCase(), startPos: caret - m[1].length - 1 };
  };

  // Suggestions for the current mention prefix
  const mentionSuggestions = (() => {
    if (!mentionState) return [];
    const candidates = [
      { id: 'lauren', label: 'Lauren', icon: '🤖' },
      ...Object.values(profilesById).filter(p => p.id !== me.id).map(p => ({ id: p.id, label: p.display_name || p.name || 'Teammate', icon: '👤' })),
    ];
    const q = mentionState.prefix;
    return candidates.filter(c => !q || c.label.toLowerCase().startsWith(q)).slice(0, 6);
  })();

  const insertMention = (suggestion) => {
    if (!mentionState) return;
    const before = body.slice(0, mentionState.startPos);
    const after = body.slice(composerRef.current?.selectionEnd ?? body.length);
    const insertion = '@' + suggestion.label + ' ';
    const next = before + insertion + after;
    setBody(next);
    setMentionState(null);
    setTimeout(() => {
      if (composerRef.current) {
        const pos = before.length + insertion.length;
        composerRef.current.focus();
        composerRef.current.setSelectionRange(pos, pos);
      }
    }, 0);
  };

  // Load + subscribe to Lauren's pending action proposals for the active thread.
  // These render as confirm/reject cards below the message that proposed them.
  useEffect(() => {
    if (!activeThreadId) return;
    let cancelled = false;
    const loadActions = async () => {
      const { data } = await sb.from('lauren_pending_actions')
        .select('*')
        .eq('thread_id', activeThreadId)
        .order('created_at', { ascending: false })
        .limit(50);
      if (cancelled) return;
      const map = {};
      (data || []).forEach(a => {
        if (a.message_id) {
          if (!map[a.message_id]) map[a.message_id] = [];
          map[a.message_id].push(a);
        }
      });
      setActionsByMessageId(map);
    };
    loadActions();
    const ch = sb.channel('lauren-actions-' + activeThreadId)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'lauren_pending_actions', filter: `thread_id=eq.${activeThreadId}` }, loadActions)
      .subscribe();
    return () => { cancelled = true; sb.removeChannel(ch); };
  }, [activeThreadId]);

  // HEIC → JPEG conversion (reused from JV portal pattern)
  const isHeic = (f) => /heic|heif/i.test(f?.type || '') || /\.(heic|heif)$/i.test(f?.name || '');
  const ensureHeicLib = async () => {
    if (window.heic2any) return true;
    return new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js';
      s.onload = () => resolve(!!window.heic2any);
      s.onerror = () => resolve(false);
      document.head.appendChild(s);
    });
  };
  const maybeConvertHeic = async (file) => {
    if (!isHeic(file)) return file;
    if (!(await ensureHeicLib())) return file;
    try {
      const blob = await window.heic2any({ blob: file, toType: 'image/jpeg', quality: 0.9 });
      return new File([Array.isArray(blob) ? blob[0] : blob], file.name.replace(/\.(heic|heif)$/i, '.jpg'), { type: 'image/jpeg', lastModified: file.lastModified });
    } catch { return file; }
  };

  // Upload attached files to team-chat bucket. Each file gets a unique
  // path: <thread_id>/<timestamp>-<safename>. Returns the metadata that
  // gets stored in team_messages.attachments.
  const uploadAttachments = async (files) => {
    if (!files.length || !activeThreadId) return [];
    setUploadingFiles(true);
    const out = [];
    for (const raw of files) {
      try {
        const file = await maybeConvertHeic(raw);
        const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
        const path = `${activeThreadId}/${Date.now()}-${Math.random().toString(36).slice(2,6)}-${safeName}`;
        const { error: upErr } = await sb.storage.from('team-chat').upload(path, file, { upsert: false, contentType: file.type || 'application/octet-stream' });
        if (upErr) { alert(`Upload failed: ${file.name} — ${upErr.message}`); continue; }
        const { data: signed } = await sb.storage.from('team-chat').createSignedUrl(path, 3600);
        out.push({ path, name: file.name, size: file.size, type: file.type || 'application/octet-stream', url: signed?.signedUrl || null });
      } catch (ex) {
        alert(`Upload failed: ${raw.name} — ${ex.message || ex}`);
      }
    }
    setUploadingFiles(false);
    return out;
  };

  const onPickFiles = async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    const uploaded = await uploadAttachments(files);
    setPendingAttachments(prev => [...prev, ...uploaded]);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const removePending = async (idx) => {
    const att = pendingAttachments[idx];
    if (att?.path) await sb.storage.from('team-chat').remove([att.path]).catch(() => {});
    setPendingAttachments(prev => prev.filter((_, i) => i !== idx));
  };

  // Drag-drop into composer
  const onDragEnter = (e) => {
    if (!Array.from(e.dataTransfer?.types || []).includes('Files')) return;
    e.preventDefault(); dragDepth.current += 1; setDragOver(true);
  };
  const onDragOver = (e) => {
    if (!Array.from(e.dataTransfer?.types || []).includes('Files')) return;
    e.preventDefault(); e.dataTransfer.dropEffect = 'copy';
  };
  const onDragLeave = (e) => {
    e.preventDefault(); dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragOver(false);
  };
  const onDrop = async (e) => {
    e.preventDefault(); dragDepth.current = 0; setDragOver(false);
    const files = Array.from(e.dataTransfer?.files || []);
    if (!files.length) return;
    const uploaded = await uploadAttachments(files);
    setPendingAttachments(prev => [...prev, ...uploaded]);
  };

  const send = async () => {
    const trimmed = body.trim();
    if ((!trimmed && pendingAttachments.length === 0) || sending || !me.id || !activeThreadId) return;
    setSending(true);
    // Strip the URL field — signed URLs expire; we re-sign on render
    const attachmentsForDb = pendingAttachments.map(({ path, name, size, type }) => ({ path, name, size, type }));
    const { error } = await sb.from('team_messages').insert({
      thread_id: activeThreadId,
      sender_id: me.id,
      sender_kind: me.role === 'va' ? 'va' : 'admin',
      body: trimmed,
      attachments: attachmentsForDb,
    });
    setSending(false);
    if (error) { alert('Could not send: ' + error.message); return; }
    setBody('');
    setPendingAttachments([]);
    if (composerRef.current) composerRef.current.focus();
  };

  const onKeyDown = (e) => {
    // Mention autocomplete navigation
    if (mentionState && mentionSuggestions.length) {
      if (e.key === 'Escape') { e.preventDefault(); setMentionState(null); return; }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        insertMention(mentionSuggestions[0]);
        return;
      }
    }
    // Cmd/Ctrl+Enter sends; plain Enter inserts newline (chat convention)
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      send();
    }
  };

  const onBodyChange = (e) => {
    const newVal = e.target.value;
    setBody(newVal);
    // Recompute mention state
    const caret = e.target.selectionStart || newVal.length;
    setMentionState(computeMentionState(newVal, caret));
  };

  const activeThread = threads.find(t => t.id === activeThreadId);
  const senderName = (msg) => {
    if (msg.sender_kind === 'lauren') return 'Lauren';
    if (msg.sender_id && profilesById[msg.sender_id]) {
      const p = profilesById[msg.sender_id];
      return p.display_name || p.name || 'Unknown';
    }
    return 'Unknown';
  };
  const senderAvatar = (msg) => {
    if (msg.sender_kind === 'lauren') return null;  // emoji avatar for now
    if (msg.sender_id && profilesById[msg.sender_id]) return profilesById[msg.sender_id].avatar_url;
    return null;
  };
  const senderInitial = (msg) => {
    if (msg.sender_kind === 'lauren') return '🤖';
    return (senderName(msg).charAt(0) || '?').toUpperCase();
  };
  // Online if last_active_at is within 2 minutes
  const isOnline = (msg) => {
    if (msg.sender_kind === 'lauren') return false;
    const last = profilesById[msg.sender_id]?.last_active_at;
    if (!last) return false;
    return (Date.now() - new Date(last).getTime()) < 2 * 60 * 1000;
  };
  const senderColor = (id) => {
    // Hash sender id to a stable color so each person has their own bubble color
    if (!id) return '#a8a29e';
    const palette = ['#d97706', '#3b82f6', '#22c55e', '#a855f7', '#ef4444', '#06b6d4', '#fbbf24'];
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    return palette[h % palette.length];
  };
  const formatTime = (ts) => {
    if (!ts) return '';
    const d = new Date(ts);
    const today = new Date();
    const sameDay = d.toDateString() === today.toDateString();
    if (sameDay) return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    const diff = (today.getTime() - d.getTime()) / (1000 * 60 * 60 * 24);
    if (diff < 7) return d.toLocaleDateString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  };

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '220px 1fr',
      gap: 0,
      background: '#0c0a09',
      border: '1px solid #292524',
      borderRadius: 10,
      overflow: 'hidden',
      height: 'calc(100vh - 280px)',
      minHeight: 500,
    }}>
      {/* Thread list */}
      <div style={{ borderRight: '1px solid #292524', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '14px 16px', borderBottom: '1px solid #292524', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: '#78716c', letterSpacing: '0.12em', textTransform: 'uppercase' }}>Threads</span>
          <button onClick={() => setShowNewThreadModal(true)} title="Create a channel, DM, or per-deal thread"
            style={{ background: '#292524', color: '#fbbf24', border: '1px solid #44403c', borderRadius: 5, padding: '3px 8px', fontSize: 11, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>
            + New
          </button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: 6 }}>
          {threads.map(t => {
            const icon = t.thread_type === 'dm' ? '💬' : t.thread_type === 'deal' ? '🏠' : '#';
            // For DMs, show the OTHER participant's name (not your own)
            let label = t.title;
            if (t.thread_type === 'dm') {
              const others = (participantsByThreadId[t.id] || []).filter(uid => uid !== me.id);
              const otherProf = others[0] && profilesById[others[0]];
              if (otherProf) label = otherProf.display_name || otherProf.name || t.title;
            }
            return (
              <button
                key={t.id}
                onClick={() => setActiveThreadId(t.id)}
                style={{
                  display: 'block', width: '100%', textAlign: 'left',
                  background: activeThreadId === t.id ? '#1c1917' : 'transparent',
                  color: activeThreadId === t.id ? '#fafaf9' : '#a8a29e',
                  border: 'none',
                  padding: '10px 12px', borderRadius: 6,
                  fontSize: 13, fontWeight: 600,
                  cursor: 'pointer', fontFamily: 'inherit',
                  marginBottom: 2,
                }}
              >
                <span style={{ marginRight: 6 }}>{icon}</span>{label}
              </button>
            );
          })}
          {threads.length === 0 && (
            <div style={{ padding: 16, fontSize: 12, color: '#57534e', fontStyle: 'italic' }}>No threads yet. Tap + New.</div>
          )}
        </div>
      </div>

      {/* Active thread */}
      <div
        style={{ display: 'flex', flexDirection: 'column', minHeight: 0, position: 'relative' }}
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {dragOver && (
          <div style={{
            position: 'absolute', inset: 0, zIndex: 30,
            background: 'rgba(120, 53, 15, 0.18)',
            border: '3px dashed #d97706',
            borderRadius: 8, margin: 8,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            pointerEvents: 'none',
          }}>
            <div style={{ background: '#1c1917', padding: '14px 20px', borderRadius: 8, border: '1px solid #d97706' }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: '#fbbf24' }}>📥 Drop to attach</div>
            </div>
          </div>
        )}
        {activeThread ? (
          <>
            {/* Thread header */}
            <div style={{ padding: '14px 18px', borderBottom: '1px solid #292524', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: '#fafaf9' }}># {activeThread.title}</div>
                <div style={{ fontSize: 11, color: '#78716c', marginTop: 2 }}>
                  {messages.length} message{messages.length === 1 ? '' : 's'}
                  {activeThread.lauren_enabled && <> · 🤖 mention <code style={{ background: '#0c0a09', padding: '0 4px', borderRadius: 3 }}>@lauren</code> to summon</>}
                </div>
              </div>
              {(me.role === 'admin' || me.role === 'user') && (
                <button
                  onClick={async () => {
                    const next = !activeThread.lauren_enabled;
                    // Optimistic local update — realtime sub will reconcile.
                    setThreads(prev => prev.map(t => t.id === activeThread.id ? { ...t, lauren_enabled: next } : t));
                    const { error } = await sb.from('team_threads')
                      .update({ lauren_enabled: next })
                      .eq('id', activeThread.id);
                    if (error) {
                      setThreads(prev => prev.map(t => t.id === activeThread.id ? { ...t, lauren_enabled: !next } : t));
                      alert('Could not toggle Lauren: ' + error.message);
                    }
                  }}
                  title={activeThread.lauren_enabled ? 'Lauren is on for this thread — click to turn off' : 'Lauren is off for this thread — click to turn on'}
                  style={{
                    fontSize: 11, fontWeight: 600, padding: '5px 10px', borderRadius: 6,
                    border: '1px solid ' + (activeThread.lauren_enabled ? '#78350f' : '#292524'),
                    background: activeThread.lauren_enabled ? '#1c1209' : '#0c0a09',
                    color: activeThread.lauren_enabled ? '#fbbf24' : '#78716c',
                    cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0,
                  }}
                >
                  🤖 Lauren: {activeThread.lauren_enabled ? 'On' : 'Off'}
                </button>
              )}
            </div>

            {/* Message list */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '14px 18px' }}>
              {messages.length === 0 ? (
                <div style={{ textAlign: 'center', padding: 40, color: '#57534e', fontSize: 13 }}>
                  No messages yet. Say hi 👋
                </div>
              ) : messages.filter(m => !m.deleted_at).map((m, i, arr) => {
                const prev = arr[i - 1];
                const grouped = prev && prev.sender_id === m.sender_id && prev.sender_kind === m.sender_kind &&
                  (new Date(m.created_at).getTime() - new Date(prev.created_at).getTime() < 3 * 60 * 1000);
                const isMe = m.sender_id === me.id;
                const color = senderColor(m.sender_id);
                const reactions = reactionsByMessageId[m.id] || [];
                const reactionCounts = reactions.reduce((acc, r) => {
                  if (!acc[r.emoji]) acc[r.emoji] = { count: 0, mine: false, names: [] };
                  acc[r.emoji].count++;
                  if (r.user_id === me.id) acc[r.emoji].mine = true;
                  const reactor = profilesById[r.user_id];
                  acc[r.emoji].names.push(reactor?.display_name || reactor?.name || '?');
                  return acc;
                }, {});
                const isEditing = editingMessageId === m.id;
                const canEdit = isMe;  // Lauren / others = no edit
                return (
                  <div key={m.id} className="team-msg-row" style={{ display: 'flex', gap: 10, marginTop: grouped ? 2 : 14, position: 'relative' }}>
                    {grouped ? (
                      <div style={{ width: 32, flexShrink: 0 }} />
                    ) : (
                      <div style={{ position: 'relative', width: 32, height: 32, flexShrink: 0 }}>
                        <div style={{
                          width: 32, height: 32,
                          borderRadius: '50%',
                          background: senderAvatar(m) ? `center/cover no-repeat url(${senderAvatar(m)})` : color,
                          color: '#fff',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontSize: 13, fontWeight: 700,
                        }}>{!senderAvatar(m) && senderInitial(m)}</div>
                        {/* Green dot if online (active in last 2 min) */}
                        {isOnline(m) && (
                          <div style={{
                            position: 'absolute', bottom: -1, right: -1,
                            width: 10, height: 10, borderRadius: '50%',
                            background: '#10b981',
                            border: '2px solid #0c0a09',
                          }} title="Online" />
                        )}
                      </div>
                    )}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      {!grouped && (
                        <div style={{ fontSize: 12, marginBottom: 2 }}>
                          <span style={{ color: '#fafaf9', fontWeight: 700 }}>{senderName(m)}</span>
                          {isMe && <span style={{ color: '#57534e', fontSize: 10, marginLeft: 6 }}>(you)</span>}
                          <span style={{ color: '#57534e', fontSize: 10, marginLeft: 8 }}>{formatTime(m.created_at)}</span>
                          {m.edited_at && <span style={{ color: '#57534e', fontSize: 10, marginLeft: 6, fontStyle: 'italic' }}>(edited)</span>}
                        </div>
                      )}
                      {isEditing ? (
                        <div>
                          <textarea
                            value={editingBody}
                            autoFocus
                            onChange={e => setEditingBody(e.target.value)}
                            onKeyDown={e => {
                              if (e.key === 'Escape') cancelEdit();
                              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); saveEdit(); }
                            }}
                            style={{ width: '100%', minHeight: 60, padding: 8, background: '#1c1917', border: '1px solid #44403c', borderRadius: 6, color: '#fafaf9', fontSize: 13, fontFamily: 'inherit' }}
                          />
                          <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                            <button onClick={saveEdit} style={{ ...btnPrimary, fontSize: 11, padding: '4px 10px' }}>Save</button>
                            <button onClick={cancelEdit} style={{ ...btnGhost, fontSize: 11, padding: '4px 10px' }}>Cancel</button>
                            <span style={{ fontSize: 10, color: '#57534e', alignSelf: 'center' }}>⌘+Enter to save · Esc to cancel</span>
                          </div>
                        </div>
                      ) : (
                        m.body && (
                          <div style={{ fontSize: 13, color: '#e7e5e4', lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                            {m.body}
                          </div>
                        )
                      )}
                      {!isEditing && Array.isArray(m.attachments) && m.attachments.length > 0 && (
                        <TeamAttachments attachments={m.attachments} onLightbox={setLightboxUrl} />
                      )}
                      {!isEditing && actionsByMessageId[m.id] && actionsByMessageId[m.id].map(a => (
                        <LaurenActionCard key={a.id} action={a} />
                      ))}
                      {/* Reaction pills */}
                      {!isEditing && Object.keys(reactionCounts).length > 0 && (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
                          {Object.entries(reactionCounts).map(([emoji, info]) => (
                            <button key={emoji}
                              onClick={() => toggleReaction(m.id, emoji)}
                              title={info.names.join(', ')}
                              style={{
                                background: info.mine ? '#78350f44' : '#1c1917',
                                border: '1px solid ' + (info.mine ? '#92400e' : '#292524'),
                                color: info.mine ? '#fbbf24' : '#a8a29e',
                                borderRadius: 12, padding: '2px 8px', fontSize: 12, cursor: 'pointer',
                                fontFamily: 'inherit', display: 'inline-flex', alignItems: 'center', gap: 4,
                              }}>
                              <span>{emoji}</span><span style={{ fontWeight: 600 }}>{info.count}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    {/* Per-message hover actions: react + edit + delete */}
                    {!isEditing && (
                      <div className="team-msg-actions" style={{
                        position: 'absolute', top: -10, right: 0,
                        display: 'flex', gap: 2,
                        background: '#0c0a09', border: '1px solid #292524', borderRadius: 6,
                        padding: 2, opacity: 0, transition: 'opacity 0.1s',
                      }}>
                        <button
                          onClick={() => setReactionPickerForId(reactionPickerForId === m.id ? null : m.id)}
                          title="React"
                          style={{ background: 'transparent', border: 'none', color: '#a8a29e', cursor: 'pointer', padding: '4px 6px', fontSize: 12, fontFamily: 'inherit' }}
                        >😀</button>
                        {canEdit && <button onClick={() => startEdit(m)} title="Edit" style={{ background: 'transparent', border: 'none', color: '#a8a29e', cursor: 'pointer', padding: '4px 6px', fontSize: 12, fontFamily: 'inherit' }}>✎</button>}
                        {canEdit && <button onClick={() => deleteMessage(m)} title="Delete" style={{ background: 'transparent', border: 'none', color: '#fca5a5', cursor: 'pointer', padding: '4px 6px', fontSize: 12, fontFamily: 'inherit' }}>×</button>}
                      </div>
                    )}
                    {/* Reaction emoji picker */}
                    {reactionPickerForId === m.id && (
                      <div style={{
                        position: 'absolute', top: 8, right: 0,
                        background: '#1c1917', border: '1px solid #44403c', borderRadius: 8,
                        padding: 4, display: 'flex', gap: 2,
                        boxShadow: '0 4px 12px rgba(0,0,0,0.5)', zIndex: 5,
                      }}>
                        {['👍','❤️','😂','🎉','🔥','✅','👀','🤔'].map(emoji => (
                          <button key={emoji} onClick={() => toggleReaction(m.id, emoji)}
                            style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: '4px 6px', fontSize: 18, fontFamily: 'inherit' }}>{emoji}</button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
              <div ref={messagesEndRef} />
            </div>

            {/* Composer */}
            <div style={{ padding: '12px 14px', borderTop: '1px solid #292524', background: '#0c0a09', position: 'relative' }}>
              {/* @mention autocomplete dropdown — floats above the textarea */}
              {mentionState && mentionSuggestions.length > 0 && (
                <div style={{
                  position: 'absolute', bottom: '100%', left: 14, marginBottom: 6,
                  background: '#1c1917', border: '1px solid #44403c', borderRadius: 8,
                  boxShadow: '0 -4px 16px rgba(0,0,0,0.5)',
                  minWidth: 220, maxHeight: 240, overflowY: 'auto',
                  zIndex: 20,
                }}>
                  {mentionSuggestions.map((s, i) => (
                    <button key={s.id}
                      onClick={() => insertMention(s)}
                      style={{
                        display: 'flex', width: '100%', alignItems: 'center', gap: 10,
                        padding: '8px 12px',
                        background: i === 0 ? '#292524' : 'transparent',
                        color: '#fafaf9',
                        border: 'none', textAlign: 'left',
                        cursor: 'pointer', fontFamily: 'inherit', fontSize: 13,
                      }}
                    >
                      <span style={{ fontSize: 16 }}>{s.icon}</span>
                      <span style={{ fontWeight: 600 }}>{s.label}</span>
                      {i === 0 && <span style={{ marginLeft: 'auto', fontSize: 9, color: '#78716c' }}>↵ Tab</span>}
                    </button>
                  ))}
                </div>
              )}
              {/* Pending attachments preview */}
              {pendingAttachments.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                  {pendingAttachments.map((a, i) => (
                    <div key={i} style={{ background: '#1c1917', border: '1px solid #292524', borderRadius: 6, padding: '4px 8px', display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
                      <span style={{ color: '#fafaf9' }}>{(/^image\//.test(a.type) ? '🖼' : /^video\//.test(a.type) ? '🎥' : '📄')} {a.name}</span>
                      <span style={{ color: '#57534e' }}>{a.size < 1024 ? `${a.size}B` : a.size < 1048576 ? `${(a.size/1024).toFixed(0)}KB` : `${(a.size/1048576).toFixed(1)}MB`}</span>
                      <button onClick={() => removePending(i)} style={{ ...btnGhost, fontSize: 10, padding: '2px 6px', color: '#fca5a5', borderColor: '#7f1d1d' }} title="Remove">×</button>
                    </div>
                  ))}
                  {uploadingFiles && <span style={{ fontSize: 11, color: '#fbbf24' }}>uploading…</span>}
                </div>
              )}
              <textarea
                ref={composerRef}
                value={body}
                onChange={onBodyChange}
                onKeyDown={onKeyDown}
                placeholder={`Message #${activeThread.title}…   (⌘+Enter to send · drag files anywhere · @lauren to summon)`}
                rows={2}
                style={{
                  width: '100%',
                  background: '#1c1917',
                  border: '1px solid #292524',
                  borderRadius: 8,
                  padding: '10px 12px',
                  color: '#fafaf9',
                  fontSize: 13,
                  fontFamily: 'inherit',
                  resize: 'vertical',
                  minHeight: 40,
                  maxHeight: 200,
                  boxSizing: 'border-box',
                }}
              />
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8, gap: 8 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input ref={fileInputRef} type="file" multiple style={{ display: 'none' }} onChange={onPickFiles} />
                  <button
                    onClick={() => fileInputRef.current && fileInputRef.current.click()}
                    disabled={uploadingFiles}
                    style={{ ...btnGhost, fontSize: 12, padding: '6px 10px' }}
                    title="Attach files (or drag onto the message area)"
                  >📎 Attach</button>
                  <span style={{ fontSize: 10, color: '#57534e' }}>
                    Files, photos, videos · HEIC auto-converts
                  </span>
                </div>
                <button
                  onClick={send}
                  disabled={sending || (!body.trim() && pendingAttachments.length === 0)}
                  style={{ ...btnPrimary, opacity: (sending || (!body.trim() && pendingAttachments.length === 0)) ? 0.5 : 1 }}
                >
                  {sending ? 'Sending…' : 'Send'}
                </button>
              </div>
            </div>
          </>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1, color: '#78716c', fontSize: 14 }}>
            Loading…
          </div>
        )}
      </div>

      {/* Lightbox for attachment preview */}
      {lightboxUrl && (
        <div onClick={() => setLightboxUrl(null)} style={{
          position: 'fixed', inset: 0, zIndex: 1000,
          background: 'rgba(0,0,0,0.92)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: 20, cursor: 'zoom-out',
        }}>
          <img src={lightboxUrl} alt="" style={{ maxWidth: '90vw', maxHeight: '90vh', borderRadius: 6, objectFit: 'contain' }} />
        </div>
      )}

      {/* New thread modal */}
      {showNewThreadModal && (
        <NewThreadModal
          onClose={() => setShowNewThreadModal(false)}
          profilesById={profilesById}
          me={me}
          onCreated={(newThreadId) => { setShowNewThreadModal(false); setActiveThreadId(newThreadId); }}
        />
      )}
    </div>
  );
}

// Lauren proposes a write action — render a confirm/reject card under her
// chat message. Either teammate can approve. RPC handles the actual write
// in a transaction so failures don't leave half-applied state.
function LaurenActionCard({ action }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const isPending = action.status === 'pending';
  const isExecuted = action.status === 'executed';
  const isRejected = action.status === 'rejected';
  const isFailed = action.status === 'failed';
  const isExpired = action.status === 'expired';

  const confirm = async () => {
    if (!confirm_('Apply this change?\n\n' + action.action_label)) return;
    setBusy(true); setErr(null);
    const { data, error } = await sb.rpc('lauren_execute_action', { p_action_id: action.id });
    setBusy(false);
    if (error) { setErr(error.message); return; }
    if (data?.error) setErr(data.error);
  };
  const reject = async () => {
    setBusy(true); setErr(null);
    const { error } = await sb.rpc('lauren_reject_action', { p_action_id: action.id });
    setBusy(false);
    if (error) setErr(error.message);
  };

  const headerColor = isExecuted ? '#10b981' : isRejected ? '#a8a29e' : isFailed ? '#ef4444' : isExpired ? '#a8a29e' : '#fbbf24';
  const bgColor = isExecuted ? '#064e3b22' : isRejected || isExpired ? '#1c1917' : isFailed ? '#7f1d1d22' : '#78350f22';
  const statusLabel = isExecuted ? '✓ Applied' : isRejected ? '✗ Rejected' : isFailed ? '⚠ Failed' : isExpired ? '⏱ Expired' : 'Awaiting confirmation';

  return (
    <div style={{
      marginTop: 8, padding: '10px 12px',
      background: bgColor,
      border: '1px solid ' + headerColor,
      borderLeftWidth: 3,
      borderRadius: 6,
      maxWidth: 460,
    }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: headerColor, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 4 }}>
        🤖 Lauren proposes · {statusLabel}
      </div>
      <div style={{ fontSize: 12, color: '#e7e5e4', lineHeight: 1.55, marginBottom: isPending ? 8 : 0 }}>
        {action.action_label}
      </div>
      {isPending && (
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={confirm} disabled={busy} style={{ background: '#10b981', color: '#0c0a09', border: 'none', borderRadius: 5, padding: '5px 12px', fontSize: 11, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>
            {busy ? '…' : '✓ Confirm'}
          </button>
          <button onClick={reject} disabled={busy} style={{ background: 'transparent', color: '#a8a29e', border: '1px solid #44403c', borderRadius: 5, padding: '5px 12px', fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
            ✗ Reject
          </button>
        </div>
      )}
      {action.result?.error && <div style={{ fontSize: 11, color: '#fca5a5', marginTop: 6 }}>Error: {action.result.error}</div>}
      {err && <div style={{ fontSize: 11, color: '#fca5a5', marginTop: 6 }}>{err}</div>}
    </div>
  );
}
// Tiny shim so the linter doesn't yell about confirm
const confirm_ = (msg) => window.confirm(msg);

// Modal for creating a new thread (channel / DM / per-deal).
function NewThreadModal({ onClose, profilesById, me, onCreated }) {
  const [kind, setKind] = useState('channel');  // channel | dm
  const [name, setName] = useState('');
  const [otherUserId, setOtherUserId] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const teammates = Object.values(profilesById).filter(p => p.id !== me.id);

  const create = async () => {
    setBusy(true); setErr(null);
    try {
      if (kind === 'channel') {
        if (!name.trim()) { setErr('Name required.'); setBusy(false); return; }
        const { data, error } = await sb.from('team_threads')
          .insert({ title: name.trim(), thread_type: 'channel', created_by_id: me.id, lauren_enabled: false })
          .select('id').single();
        if (error) throw error;
        onCreated(data.id);
      } else if (kind === 'dm') {
        if (!otherUserId) { setErr('Pick a teammate.'); setBusy(false); return; }
        const { data, error } = await sb.rpc('team_create_dm', { p_other_user: otherUserId });
        if (error) throw error;
        onCreated(data);
      }
    } catch (ex) {
      setErr(ex.message || String(ex));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} title="New thread">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={() => setKind('channel')} style={{
            flex: 1, padding: '10px 12px',
            background: kind === 'channel' ? '#292524' : 'transparent',
            color: kind === 'channel' ? '#fbbf24' : '#a8a29e',
            border: '1px solid ' + (kind === 'channel' ? '#92400e' : '#292524'),
            borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
          }}># Channel</button>
          <button onClick={() => setKind('dm')} style={{
            flex: 1, padding: '10px 12px',
            background: kind === 'dm' ? '#292524' : 'transparent',
            color: kind === 'dm' ? '#fbbf24' : '#a8a29e',
            border: '1px solid ' + (kind === 'dm' ? '#92400e' : '#292524'),
            borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
          }}>💬 Direct Message</button>
        </div>

        {kind === 'channel' && (
          <Field label="Channel name (open to all admin/VA)">
            <input value={name} onChange={e => setName(e.target.value)} style={inputStyle} placeholder="e.g. casey-jennings, marketing, ideas" />
          </Field>
        )}
        {kind === 'dm' && (
          <Field label="DM with">
            <select value={otherUserId} onChange={e => setOtherUserId(e.target.value)} style={{ ...inputStyle, padding: '8px 10px' }}>
              <option value="">Pick a teammate…</option>
              {teammates.map(p => <option key={p.id} value={p.id}>{p.display_name || p.name}</option>)}
            </select>
          </Field>
        )}

        {err && <div style={{ fontSize: 12, color: '#fca5a5' }}>{err}</div>}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={btnGhost}>Cancel</button>
          <button onClick={create} disabled={busy} style={btnPrimary}>{busy ? 'Creating…' : 'Create'}</button>
        </div>
      </div>
    </Modal>
  );
}

// Renders attachments in a team_messages row. Re-signs URLs on render
// (signed URLs in the DB would expire) so we always have fresh links.
function TeamAttachments({ attachments, onLightbox }) {
  const [resolved, setResolved] = useState({});
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const out = {};
      await Promise.all(attachments.map(async (a) => {
        if (!a.path) return;
        const { data } = await sb.storage.from('team-chat').createSignedUrl(a.path, 3600);
        if (data?.signedUrl) out[a.path] = data.signedUrl;
      }));
      if (!cancelled) setResolved(out);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line
  }, [attachments.length]);

  const fmt = (n) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n/1024).toFixed(0)} KB` : `${(n/1048576).toFixed(1)} MB`;

  return (
    <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
      {attachments.map((a, i) => {
        const url = resolved[a.path];
        const isImage = /^image\//.test(a.type) || /\.(jpg|jpeg|png|webp|gif)$/i.test(a.name);
        const isVideo = /^video\//.test(a.type) || /\.(mp4|mov|m4v|webm)$/i.test(a.name);
        if (isImage) {
          return (
            <div key={i}
              onClick={() => url && onLightbox(url)}
              title={`${a.name} · ${fmt(a.size)}`}
              style={{
                width: 'fit-content', maxWidth: 320,
                aspectRatio: 'auto',
                background: url ? `#0c0a09 center/cover no-repeat url(${url})` : '#1c1917',
                borderRadius: 6,
                border: '1px solid #292524',
                cursor: url ? 'pointer' : 'default',
              }}
            >
              {url ? <img src={url} alt={a.name} style={{ display: 'block', maxWidth: 320, maxHeight: 240, borderRadius: 6 }} /> : <div style={{ width: 240, height: 160, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#57534e', fontSize: 11 }}>loading…</div>}
            </div>
          );
        }
        if (isVideo && url) {
          return <video key={i} src={url} controls preload="metadata" style={{ maxWidth: 360, maxHeight: 240, borderRadius: 6, background: '#000' }} />;
        }
        // Generic file
        return (
          <div key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: '#1c1917', border: '1px solid #292524', borderRadius: 6, maxWidth: 360 }}>
            <span style={{ fontSize: 18 }}>📄</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#fafaf9', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</div>
              <div style={{ fontSize: 10, color: '#78716c' }}>{fmt(a.size)}</div>
            </div>
            {url && <a href={url} target="_blank" rel="noopener" style={{ ...btnGhost, fontSize: 11, padding: '4px 10px', textDecoration: 'none' }}>Open</a>}
          </div>
        );
      })}
    </div>
  );
}

// Global /tasks view — Nathan's + Eric's morning queue. Shows tasks across
// every deal sorted by tier priority (A → 30DTS → B → C → unscored) then
// due-date asc. Overdue in red. One-click mark-done + jump-to-deal.
function GlobalTasksView({ deals, onJumpToDeal }) {
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('open'); // open | overdue | today | week | done
  const [updating, setUpdating] = useState(null);

  const load = async () => {
    const { data } = await sb.from('tasks')
      .select('*')
      .order('due_date', { ascending: true, nullsLast: true })
      .order('created_at', { ascending: true })
      .limit(200);
    setTasks(data || []);
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  useEffect(() => {
    const ch = sb.channel('tasks-global')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, load)
      .subscribe();
    return () => { sb.removeChannel(ch); };
  }, []);

  const markDone = async (t, done) => {
    setUpdating(t.id);
    await sb.from('tasks').update({ done }).eq('id', t.id);
    setUpdating(null);
    load();
  };

  const dealsById = {};
  deals.forEach(d => { dealsById[d.id] = d; });
  const today = new Date().toISOString().slice(0, 10);
  const weekFromNow = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const enriched = tasks.map(t => {
    const d = dealsById[t.deal_id];
    return {
      ...t,
      deal: d,
      tierOrder: d?.is_30dts ? 0.5 : ({ A: 0, B: 2, C: 3 }[d?.lead_tier] ?? 4),
      isOverdue: t.due_date && !t.done && t.due_date < today,
    };
  });

  let filtered;
  if (filter === 'done') filtered = enriched.filter(t => t.done);
  else if (filter === 'overdue') filtered = enriched.filter(t => t.isOverdue);
  else if (filter === 'today') filtered = enriched.filter(t => !t.done && t.due_date === today);
  else if (filter === 'week') filtered = enriched.filter(t => !t.done && t.due_date && t.due_date <= weekFromNow && t.due_date >= today);
  else filtered = enriched.filter(t => !t.done);

  filtered.sort((a, b) => {
    if (a.tierOrder !== b.tierOrder) return a.tierOrder - b.tierOrder;
    if (a.due_date && b.due_date) return a.due_date.localeCompare(b.due_date);
    if (a.due_date) return -1;
    if (b.due_date) return 1;
    return 0;
  });

  const counts = {
    open: enriched.filter(t => !t.done).length,
    overdue: enriched.filter(t => t.isOverdue).length,
    today: enriched.filter(t => !t.done && t.due_date === today).length,
    week: enriched.filter(t => !t.done && t.due_date && t.due_date <= weekFromNow && t.due_date >= today).length,
    done: enriched.filter(t => t.done).length,
  };

  const chip = (id, label) => (
    <button key={id} onClick={() => setFilter(id)} style={{
      fontSize: 12, padding: '6px 14px', borderRadius: 6,
      background: filter === id ? '#292524' : 'transparent',
      color: filter === id ? '#fafaf9' : '#78716c',
      border: '1px solid ' + (filter === id ? '#44403c' : 'transparent'),
      fontWeight: filter === id ? 700 : 500, cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.06em',
    }}>{label} · {counts[id]}</button>
  );

  return (
    <div>
      <div style={{ marginBottom: 16, padding: 16, background: "#1c1917", border: "1px solid #292524", borderRadius: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12, flexWrap: 'wrap', gap: 10 }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#78716c', letterSpacing: '0.1em', textTransform: 'uppercase' }}>✓ Tasks</div>
            <div style={{ fontSize: 13, color: '#a8a29e', marginTop: 4, lineHeight: 1.5 }}>
              {counts.overdue > 0 ? <><span style={{ color: '#fca5a5', fontWeight: 700 }}>{counts.overdue} overdue</span> · </> : null}
              {counts.today} due today · {counts.week} this week · sorted A → 30DTS → B → C
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 4, background: '#0c0a09', border: '1px solid #292524', borderRadius: 8, padding: 3, width: 'fit-content', flexWrap: 'wrap' }}>
          {chip('overdue', 'Overdue')}
          {chip('today', 'Today')}
          {chip('week', 'This week')}
          {chip('open', 'All open')}
          {chip('done', 'Done')}
        </div>
      </div>

      {loading && <div style={{ padding: 20, textAlign: 'center', color: '#78716c', fontSize: 12 }}>Loading…</div>}
      {!loading && filtered.length === 0 && (
        <div style={{ padding: 40, textAlign: 'center', color: '#78716c', border: '1px dashed #292524', borderRadius: 10 }}>
          {filter === 'overdue' ? '🎉 No overdue tasks.' : filter === 'today' ? 'Nothing due today.' : 'No tasks match this filter.'}
        </div>
      )}

      {filtered.map(t => {
        const d = t.deal;
        return (
          <div key={t.id} style={{ marginBottom: 8, padding: "10px 14px", background: '#1c1917', border: '1px solid ' + (t.isOverdue ? '#7f1d1d' : '#292524'), borderLeft: '3px solid ' + (t.isOverdue ? '#ef4444' : d?.lead_tier === 'A' ? '#d8b560' : d?.is_30dts ? '#ef4444' : d?.lead_tier === 'B' ? '#8b5cf6' : '#44403c'), borderRadius: 6, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <input type="checkbox" checked={!!t.done} onChange={e => markDone(t, e.target.checked)} disabled={updating === t.id} style={{ flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 200 }}>
              <div style={{ fontSize: 13, color: t.done ? '#78716c' : '#fafaf9', textDecoration: t.done ? 'line-through' : 'none', marginBottom: 2 }}>{t.title}</div>
              <div style={{ fontSize: 10, color: '#78716c', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'baseline' }}>
                {d && <span style={{ color: '#d6d3d1', cursor: 'pointer', textDecoration: 'underline' }} onClick={() => onJumpToDeal(d.id)}>{(d.name || '').split(' - ')[0]}</span>}
                {d && d.lead_tier && <TierBadge deal={d} />}
                {d && d.is_30dts && <DTSCountdown days={d.days_to_sale} />}
                {t.assigned_to && <span style={{ color: '#a8a29e' }}>· {t.assigned_to}</span>}
                {t.due_date && <span style={{ color: t.isOverdue ? '#ef4444' : '#a8a29e', fontFamily: "'DM Mono', monospace", fontWeight: t.isOverdue ? 700 : 400 }}>· {t.isOverdue ? 'OVERDUE ' : ''}due {new Date(t.due_date + 'T00:00:00').toLocaleDateString()}</span>}
              </div>
            </div>
            {d && <button onClick={() => onJumpToDeal(d.id)} style={{ ...btnGhost, fontSize: 10, padding: '4px 10px' }}>Open →</button>}
          </div>
        );
      })}
    </div>
  );
}

// Send Intro Text modal — loads an SMS template matching the deal's
// lead_tier (or 30DTS track), substitutes merge variables, lets Eric
// review/edit, sends via send-sms Edge Function (Twilio today; swap to
// iMessage bridge when Justin ships it). On success logs structured
// activity + flips sales_stage to 'texted'.
// ─── Send Personalized Link Button + Modal ─────────────────────
// Per-deal one-shot action to push refundlocators.com/s/<token> to a
// claimant via SMS, email, or clipboard. Lives in the deal detail header.
// Only renders when deal.refundlocators_token is set (auto-synced from
// Castle's personalized_links by tg_sync_refundlocators_token trigger).
//
// Distinct from BulkOutreachButton (Pipeline → mass-queue cadence) and
// SendIntroTextModal (Comms tab → full template-driven outbound). This
// is the "I want to text/email this one person their link RIGHT NOW"
// surface — three clicks max from any deal.
function SendPersonalizedLinkButton({ deal }) {
  const [open, setOpen] = useState(false);
  const token = deal?.refundlocators_token || '';
  if (!token) return null;
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="Push this deal's refundlocators.com/s/<token> URL to the claimant via SMS, email, or copy-to-clipboard"
        style={{ background: "transparent", border: "1px solid #44403c", color: "#fbbf24", padding: "4px 12px", borderRadius: 6, fontSize: 12, fontWeight: 700, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6 }}>
        🔗 Send link
      </button>
      {open && <SendPersonalizedLinkModal deal={deal} onClose={() => setOpen(false)} />}
    </>
  );
}

function SendPersonalizedLinkModal({ deal, onClose }) {
  const m = deal.meta || {};
  const firstName = ((m.homeownerName || deal.name || '').split(' - ')[0].split(' ')[0]) || 'there';
  const token = deal.refundlocators_token;
  const url = `https://refundlocators.com/s/${token}`;
  const phone = m.homeownerPhone || m.phone || '';
  const email = m.homeownerEmail || m.email || '';

  const [smsBody, setSmsBody] = useState(`Hi ${firstName}, this is Nathan from RefundLocators. I put together a quick page on your case with the details: ${url}`);
  const [emailSubject, setEmailSubject] = useState(`Your RefundLocators case page`);
  const [emailBody, setEmailBody] = useState(`Hi ${firstName},\n\nI put together a quick page with the details on your case. You can review it here:\n\n${url}\n\nIf you have any questions, just reply to this email or call/text me at (513) 516-2306.\n\n— Nathan\nRefundLocators`);
  const [busy, setBusy] = useState(null);
  const [msg, setMsg] = useState(null);

  const copyUrl = async () => {
    try { await navigator.clipboard.writeText(url); setMsg({ type: 'success', text: 'Link copied to clipboard' }); }
    catch (e) { setMsg({ type: 'error', text: 'Clipboard blocked. URL: ' + url }); }
  };

  const sendSms = async () => {
    if (!phone) { setMsg({ type: 'error', text: 'No phone number on this deal. Add meta.homeownerPhone first.' }); return; }
    setBusy('sms'); setMsg(null);
    try {
      const { data, error } = await sb.functions.invoke('send-sms', {
        body: { to: phone, body: smsBody, deal_id: deal.id },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.details || data.error);
      setMsg({ type: 'success', text: `SMS sent to ${phone}` });
      setTimeout(() => onClose(), 1200);
    } catch (e) {
      setMsg({ type: 'error', text: 'Send failed: ' + (e.message || 'unknown') });
    } finally { setBusy(null); }
  };

  const sendEmail = async () => {
    if (!email) { setMsg({ type: 'error', text: 'No email on this deal. Add meta.homeownerEmail first.' }); return; }
    setBusy('email'); setMsg(null);
    try {
      const { data, error } = await sb.functions.invoke('send-email', {
        body: { to: email, subject: emailSubject, body: emailBody, deal_id: deal.id },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.details || data.error);
      setMsg({ type: 'success', text: `Email sent to ${email}` });
      setTimeout(() => onClose(), 1200);
    } catch (e) {
      setMsg({ type: 'error', text: 'Send failed: ' + (e.message || 'unknown') });
    } finally { setBusy(null); }
  };

  return (
    <Modal onClose={onClose} title="🔗 Send personalized link">
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: '#78716c', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 6 }}>The URL</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', background: '#0c0a09', border: '1px solid #292524', borderRadius: 6, fontFamily: "'DM Mono', monospace", fontSize: 12, color: '#fbbf24', overflow: 'hidden' }}>
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{url}</span>
          <button onClick={copyUrl} disabled={busy !== null} style={{ ...btnGhost, fontSize: 11, padding: '4px 10px', whiteSpace: 'nowrap', flexShrink: 0 }}>📋 Copy</button>
        </div>
      </div>

      {msg && (
        <div style={{ padding: '8px 12px', borderRadius: 6, marginBottom: 14, fontSize: 12, background: msg.type === 'success' ? '#14532d' : '#7f1d1d', color: msg.type === 'success' ? '#bbf7d0' : '#fecaca' }}>
          {msg.text}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        {/* SMS column */}
        <div style={{ padding: 12, background: '#0c0a09', border: '1px solid #292524', borderRadius: 8 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#78716c', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 6 }}>📱 SMS</div>
          <div style={{ fontSize: 11, color: phone ? '#a8a29e' : '#fca5a5', marginBottom: 8 }}>
            {phone ? `To: ${phone}` : 'No phone on file (add meta.homeownerPhone)'}
          </div>
          <textarea
            value={smsBody}
            onChange={e => setSmsBody(e.target.value)}
            disabled={!phone || busy !== null}
            rows={5}
            style={{ ...inputStyle, fontSize: 12, fontFamily: 'inherit', resize: 'vertical', minHeight: 100, opacity: phone ? 1 : 0.5 }}
          />
          <div style={{ fontSize: 10, color: smsBody.length > 160 ? '#fbbf24' : '#57534e', marginTop: 4, fontFamily: "'DM Mono', monospace" }}>
            {smsBody.length} chars{smsBody.length > 160 ? ` · will send as ${Math.ceil(smsBody.length / 160)} segments` : ''}
          </div>
          <button
            onClick={sendSms}
            disabled={!phone || busy !== null}
            style={{ ...btnPrimary, width: '100%', marginTop: 10, opacity: (!phone || busy !== null) ? 0.5 : 1, cursor: (!phone || busy !== null) ? 'not-allowed' : 'pointer' }}>
            {busy === 'sms' ? '⏳ Sending…' : '📱 Send SMS'}
          </button>
        </div>

        {/* Email column */}
        <div style={{ padding: 12, background: '#0c0a09', border: '1px solid #292524', borderRadius: 8 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#78716c', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 6 }}>📧 Email</div>
          <div style={{ fontSize: 11, color: email ? '#a8a29e' : '#fca5a5', marginBottom: 8 }}>
            {email ? `To: ${email}` : 'No email on file (add meta.homeownerEmail)'}
          </div>
          <input
            value={emailSubject}
            onChange={e => setEmailSubject(e.target.value)}
            disabled={!email || busy !== null}
            placeholder="Subject"
            style={{ ...inputStyle, fontSize: 12, marginBottom: 8, opacity: email ? 1 : 0.5 }}
          />
          <textarea
            value={emailBody}
            onChange={e => setEmailBody(e.target.value)}
            disabled={!email || busy !== null}
            rows={5}
            style={{ ...inputStyle, fontSize: 12, fontFamily: 'inherit', resize: 'vertical', minHeight: 100, opacity: email ? 1 : 0.5 }}
          />
          <button
            onClick={sendEmail}
            disabled={!email || busy !== null}
            style={{ ...btnPrimary, width: '100%', marginTop: 10, opacity: (!email || busy !== null) ? 0.5 : 1, cursor: (!email || busy !== null) ? 'not-allowed' : 'pointer' }}>
            {busy === 'email' ? '⏳ Sending…' : '📧 Send email'}
          </button>
        </div>
      </div>

      <div style={{ marginTop: 14, padding: 10, background: '#0c0a09', border: '1px dashed #292524', borderRadius: 6, fontSize: 11, color: '#78716c', lineHeight: 1.55 }}>
        Drafts are pre-filled with Nathan's voice. Edit either before sending. Token comes from <code style={{ color: '#a8a29e' }}>deals.refundlocators_token</code> (auto-synced from Castle's <code style={{ color: '#a8a29e' }}>personalized_links</code>).
      </div>
    </Modal>
  );
}

function SendIntroTextModal({ deal, onClose, onSent }) {
  const [templates, setTemplates] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [body, setBody] = useState('');
  const [fromNumber, setFromNumber] = useState('');
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState(null);
  const [phoneNumbers, setPhoneNumbers] = useState([]);

  const m = deal.meta || {};
  const toNumber = m.homeownerPhone;
  const firstName = ((m.homeownerName || deal.name || '').split(' - ')[0].split(' ')[0]) || 'there';
  const ownerName = (m.homeownerName || deal.name || '').split(' - ')[0];
  const county = m.county || '';
  const saleDate = deal.days_to_sale != null
    ? new Date(Date.now() + deal.days_to_sale * 24 * 60 * 60 * 1000).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })
    : '';
  const token = deal.refundlocators_token || '';

  useEffect(() => {
    (async () => {
      const { data: t } = await sb.from('sms_templates').select('*').eq('active', true);
      setTemplates(t || []);
      // Pick starting template: prefer 30DTS if deal is_30dts, else match tier
      const preferredTier = deal.is_30dts ? '30DTS' : (deal.lead_tier || 'A');
      const match = (t || []).find(x => x.tier === preferredTier) || (t || [])[0];
      if (match) {
        setSelectedId(match.id);
        setBody(renderTemplate(match.body_template));
      }
      const { data: pn } = await sb.from('phone_numbers').select('*').eq('active', true);
      setPhoneNumbers(pn || []);
      if ((pn || []).length > 0) setFromNumber(pn[0].number);
    })();
    // eslint-disable-next-line
  }, []);

  function renderTemplate(tpl) {
    return (tpl || '')
      .replace(/\[FirstName\]/g, firstName)
      .replace(/\[OwnerName\]/g, ownerName)
      .replace(/\[sale_date\]/g, saleDate || '[sale date not set]')
      .replace(/\[token\]/g, token || '[token-pending]')
      .replace(/\[County\]/g, county);
  }

  const pickTemplate = (id) => {
    setSelectedId(id);
    const t = templates.find(x => x.id === id);
    if (t) setBody(renderTemplate(t.body_template));
  };

  const missingToken = !token;
  const missingPhone = !toNumber;

  const send = async () => {
    if (!toNumber) { setErr('Homeowner phone not set on this deal'); return; }
    if (!body.trim()) { setErr('Empty message'); return; }
    setSending(true); setErr(null);
    try {
      const { data, error } = await sb.functions.invoke('send-sms', {
        body: { to: toNumber, body: body.trim(), deal_id: deal.id, from_number: fromNumber || undefined },
      });
      if (error) {
        let msg = error.message;
        try { const body = await error.context?.json?.(); msg = body?.error || body?.message || msg; } catch {}
        throw new Error(msg);
      }
      if (data?.status === 'failed') throw new Error(data.error_message || 'Twilio error');

      // Structured activity + flip sales_stage
      await sb.rpc('log_deal_activity', {
        p_deal_id: deal.id,
        p_type: 'text',
        p_outcome: 'sent',
        p_body: body.trim(),
        p_next_followup_date: null,
        p_next_followup_note: null,
      });
      const stageField = deal.is_30dts ? 'sales_stage_30dts' : 'sales_stage';
      await sb.from('deals').update({ [stageField]: 'texted' }).eq('id', deal.id);

      onSent && onSent();
      onClose();
    } catch (e) { setErr(e.message); }
    finally { setSending(false); }
  };

  const charCount = body.length;
  const bubbleCount = Math.ceil(charCount / 160);

  return (
    <Modal onClose={onClose} title="💬 Send Intro Text" wide>
      <div style={{ marginBottom: 12, fontSize: 12, color: '#a8a29e', lineHeight: 1.5 }}>
        Sending to <b style={{ color: '#fbbf24' }}>{ownerName || 'homeowner'}</b>
        {toNumber && <> at <span style={{ fontFamily: "'DM Mono', monospace", color: '#d6d3d1' }}>{toNumber}</span></>}
        {deal.lead_tier && <> · <TierBadge deal={deal} /></>}
        {deal.is_30dts && <> · <DTSCountdown days={deal.days_to_sale} /></>}
      </div>

      {missingPhone && (
        <div style={{ padding: 12, background: '#7f1d1d22', border: '1px solid #7f1d1d', borderRadius: 6, fontSize: 12, color: '#fca5a5', marginBottom: 12 }}>
          ⚠ No phone number on file. Add homeowner phone to deal.meta.homeownerPhone first.
        </div>
      )}
      {missingToken && (
        <div style={{ padding: 12, background: '#78350f22', border: '1px solid #d97706', borderRadius: 6, fontSize: 12, color: '#fbbf24', marginBottom: 12 }}>
          ⚠ No refundlocators.com token on this deal yet. Castle generates these after scoring. Text will send with placeholder <code>[token-pending]</code> — edit the link manually or wait for Castle to backfill.
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10, marginBottom: 12 }}>
        <Field label="Template">
          <select value={selectedId || ''} onChange={e => pickTemplate(e.target.value)} style={{ ...inputStyle, padding: "8px 10px" }}>
            {templates.map(t => <option key={t.id} value={t.id}>[{t.tier}] {t.label}</option>)}
          </select>
        </Field>
        {phoneNumbers.length > 0 && (
          <Field label="Send from">
            <select value={fromNumber} onChange={e => setFromNumber(e.target.value)} style={{ ...inputStyle, padding: "8px 10px" }}>
              {phoneNumbers.map(p => <option key={p.number} value={p.number}>{p.label || p.number}</option>)}
            </select>
          </Field>
        )}
      </div>

      <Field label="Message body">
        <textarea value={body} onChange={e => setBody(e.target.value)} rows={10}
          style={{ ...inputStyle, width: '100%', resize: 'vertical', minHeight: 200, fontFamily: "inherit", fontSize: 13, lineHeight: 1.55 }} />
      </Field>
      <div style={{ fontSize: 10, color: '#78716c', marginTop: 4, display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'space-between' }}>
        <span>{charCount} chars · ~{bubbleCount} SMS segment{bubbleCount === 1 ? '' : 's'} (iMessage ignores this)</span>
        <span>Variables: [FirstName] [OwnerName] [sale_date] [token] [County]</span>
      </div>

      {err && <div style={{ padding: 10, background: '#7f1d1d22', border: '1px solid #7f1d1d', borderRadius: 4, fontSize: 12, color: '#fca5a5', marginTop: 12 }}>{err}</div>}

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16, paddingTop: 12, borderTop: '1px solid #292524' }}>
        <button onClick={onClose} style={btnGhost}>Cancel</button>
        <button onClick={send} disabled={sending || missingPhone} style={btnPrimary}>
          {sending ? 'Sending…' : '💬 Send'}
        </button>
      </div>
      <div style={{ fontSize: 10, color: '#57534e', marginTop: 8, textAlign: 'right' }}>
        Sending via Twilio (iMessage bridge TBD). On send → logs activity + moves stage to 'texted'.
      </div>
    </Modal>
  );
}

// ─── Bulk-outreach queue button ─────────────────────────────────
// One-click "queue first-text outreach for every visible A/B-tier deal"
// for the Monday A/B push. Filters in-scope candidates: tier A or B,
// has a contact phone, status not closed/dead/recovered, NOT already
// in an active outreach_queue row (anything not in skipped/cancelled/
// failed is considered active so we never double-queue). Inserts one
// row per qualifying deal at cadence_day=0, status='queued' — Justin's
// AutomationsQueue auto-fires generate-outreach to draft each.
//
// The intro draft (cadence_day=0) is human-gated: rows land in
// AutomationsQueue on Today / Outreach view, Nathan reviews + clicks
// Send for each. After the first send, the cadence engine takes over
// (Day 1 → Day 3 → Day 5 → weekly through Day 90).
function BulkOutreachButton({ candidates }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const alive = useAliveRef();

  const eligible = candidates.filter(d => (d.lead_tier === 'A' || d.lead_tier === 'B'));
  const eligibleWithPhone = eligible.filter(d => d.meta?.homeownerPhone || d.meta?.phone);

  const handleClick = async () => {
    if (busy) return;
    if (eligibleWithPhone.length === 0) {
      setResult({ type: 'info', text: 'No A/B-tier deals with a phone number in current view.' });
      return;
    }
    if (!window.confirm(`Queue first-text outreach for ${eligibleWithPhone.length} A/B-tier deal${eligibleWithPhone.length === 1 ? '' : 's'}?\n\nEach gets one cadence_day=0 draft. You'll review + send each from the Outreach view. After you send, the cadence engine handles Day 1/3/5 + weekly drip automatically.`)) return;

    setBusy(true); setResult(null);
    let queued = 0, skipped = 0, failed = 0;
    const reasons = { no_phone: 0, already_active: 0, dnd: 0, error: 0 };

    for (const d of eligible) {
      const phone = d.meta?.homeownerPhone || d.meta?.phone;
      if (!phone) { skipped++; reasons.no_phone++; continue; }

      try {
        // Check DNC
        const { data: dnc } = await sb.from('contacts')
          .select('id').eq('phone', phone).eq('do_not_text', true).limit(1).maybeSingle();
        if (dnc) { skipped++; reasons.dnd++; continue; }

        // Check existing active outreach_queue row for this deal (any cadence_day)
        const { data: existing } = await sb.from('outreach_queue')
          .select('id, status').eq('deal_id', d.id)
          .not('status', 'in', '(skipped,cancelled,failed,sent)')
          .limit(1).maybeSingle();
        if (existing) { skipped++; reasons.already_active++; continue; }

        // Insert the cadence_day=0 row. Justin's AutomationsQueue auto-fires
        // generate-outreach which drafts the SMS body using the deal's
        // refundlocators_token (synced from personalized_links by trigger).
        const { error: insErr } = await sb.from('outreach_queue').insert({
          deal_id: d.id,
          contact_phone: phone,
          cadence_day: 0,
          status: 'queued',
          scheduled_for: new Date().toISOString(),
        });
        if (insErr) { failed++; reasons.error++; console.error('bulk queue insert failed:', insErr); }
        else queued++;
      } catch (e) {
        failed++; reasons.error++;
        console.error('bulk queue exception:', e);
      }
    }

    if (!alive.current) return;
    setBusy(false);
    setResult({
      type: queued > 0 ? 'success' : skipped > 0 ? 'info' : 'error',
      text: `Queued ${queued} · Skipped ${skipped} (${reasons.no_phone} no phone, ${reasons.already_active} already active, ${reasons.dnd} DNC) · Failed ${failed}`,
    });
    if (queued > 0) {
      const timeoutId = setTimeout(() => { if (alive.current) setResult(null); }, 12000);
      // No cleanup needed — alive.current gates the setResult call
    }
  };

  // Don't render unless there are A/B candidates visible
  if (eligible.length === 0) return null;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto' }}>
      {result && (
        <span style={{ fontSize: 11, color: result.type === 'success' ? '#6ee7b7' : result.type === 'error' ? '#fca5a5' : '#a8a29e' }}>
          {result.text}
        </span>
      )}
      <button
        onClick={handleClick}
        disabled={busy}
        title={`Queue first-text outreach for ${eligibleWithPhone.length} A/B-tier deal${eligibleWithPhone.length === 1 ? '' : 's'} with a phone number in current view`}
        style={{
          fontSize: 11, fontWeight: 700, padding: '6px 14px', borderRadius: 5,
          background: busy ? '#1c1917' : '#78350f',
          color: busy ? '#78716c' : '#fbbf24',
          border: '1px solid #92400e',
          cursor: busy ? 'wait' : 'pointer',
          letterSpacing: '0.04em',
          fontFamily: 'inherit',
          whiteSpace: 'nowrap',
        }}>
        {busy ? '⏳ Queuing…' : `🚀 Queue outreach · ${eligibleWithPhone.length} A/B`}
      </button>
    </div>
  );
}

function SalesPipeline({ deals, onSelect, onUpdateDeal }) {
  const [track, setTrack] = useState('surplus'); // 'surplus' | '30dts'
  const [tierFilter, setTierFilter] = useState({ A: true, B: true, C: true, other: true });
  const [countyFilter, setCountyFilter] = useState('');
  const [search, setSearch] = useState('');
  const [dragId, setDragId] = useState(null);
  const [dragOverStage, setDragOverStage] = useState(null);
  const [textingDeal, setTextingDeal] = useState(null);

  const stageField = track === 'surplus' ? 'sales_stage' : 'sales_stage_30dts';
  const stages = track === 'surplus' ? SURPLUS_STAGES : DTS_STAGES;

  // Filter candidate deals for this track. A deal in the 30DTS track is
  // ANY deal with is_30dts=true regardless of sales_stage_30dts — so newly-
  // flagged ones land in "new" automatically via the seeding migration.
  const candidates = deals.filter(d => {
    if (['closed', 'dead', 'recovered'].includes(d.status)) return false;
    if (track === '30dts') return d.is_30dts === true;
    // Surplus track excludes 30DTS deals to avoid duplication
    return d.is_30dts !== true && d.sales_stage != null;
  });

  const counties = [...new Set(candidates.map(d => d.meta?.county).filter(Boolean))].sort();

  const filtered = candidates.filter(d => {
    const tier = d.lead_tier || 'other';
    if (!tierFilter[tier]) return false;
    if (countyFilter && (d.meta?.county || '') !== countyFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      const hay = [d.name, d.address, d.meta?.county, d.meta?.courtCase, d.id].filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  // Group by stage
  const grouped = Object.fromEntries(stages.map(s => [s.key, []]));
  const unassigned = [];
  filtered.forEach(d => {
    const s = d[stageField] || 'new';
    if (grouped[s]) grouped[s].push(d);
    else unassigned.push(d);
  });

  // Sort each column: tier order (A → B → C → other), then days_to_sale asc,
  // then surplus_estimate desc. 30DTS gets the additional sort boost.
  const tierOrder = { A: 0, B: 1, C: 2, other: 3 };
  Object.values(grouped).forEach(col => col.sort((a, b) => {
    const ta = tierOrder[a.lead_tier || 'other'];
    const tb = tierOrder[b.lead_tier || 'other'];
    if (ta !== tb) return ta - tb;
    const dtsa = a.days_to_sale ?? 9999;
    const dtsb = b.days_to_sale ?? 9999;
    if (dtsa !== dtsb) return dtsa - dtsb;
    const sa = Number(a.surplus_estimate) || 0;
    const sb = Number(b.surplus_estimate) || 0;
    return sb - sa;
  }));

  const moveStage = async (id, newStage) => {
    const patch = { [stageField]: newStage };
    // Nice side-effect: moving a deal to "signed" bumps the case status too
    // (sales signed = ready to file). Can always override manually.
    onUpdateDeal && onUpdateDeal(id, patch);
  };

  const handleDragStart = (e, id) => {
    setDragId(id);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', id);
  };
  const handleDragEnd = () => { setDragId(null); setDragOverStage(null); };
  const handleDragOver = (e, stage) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragOverStage !== stage) setDragOverStage(stage);
  };
  const handleDragLeave = (stage) => { if (dragOverStage === stage) setDragOverStage(null); };
  const handleDrop = (e, stage) => {
    e.preventDefault();
    const id = e.dataTransfer.getData('text/plain') || dragId;
    setDragId(null); setDragOverStage(null);
    if (!id) return;
    const d = filtered.find(x => x.id === id);
    if (!d || d[stageField] === stage) return;
    moveStage(id, stage);
  };

  const fmtMoneyShort = v => {
    const n = Number(v);
    if (!n || n <= 0) return null;
    if (n >= 1000000) return '$' + (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return '$' + Math.round(n / 1000) + 'k';
    return '$' + n;
  };

  // Summary stats at the top
  const pipelineValue = filtered.reduce((sum, d) => sum + (Number(d.surplus_estimate) || 0), 0);
  const aCount = filtered.filter(d => d.lead_tier === 'A').length;
  const bCount = filtered.filter(d => d.lead_tier === 'B').length;
  const cCount = filtered.filter(d => d.lead_tier === 'C').length;
  const unscored = filtered.filter(d => !d.lead_tier).length;

  return (
    <div>
      {/* Header + track switcher + summary */}
      <div style={{ marginBottom: 16, padding: 16, background: '#1c1917', border: '1px solid #292524', borderRadius: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 12, marginBottom: 14 }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#78716c', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
              🧭 Sales Pipeline
            </div>
            <div style={{ fontSize: 13, color: '#a8a29e', marginTop: 4, lineHeight: 1.5 }}>
              {filtered.length} active leads
              {pipelineValue > 0 && <> · <b style={{ color: '#fbbf24' }}>{fmtMoneyShort(pipelineValue) || '—'}</b> pipeline value</>}
              {aCount > 0 && <> · <span style={{ color: '#d8b560', fontWeight: 700 }}>{aCount} A</span></>}
              {bCount > 0 && <> · <span style={{ color: '#c4b5fd', fontWeight: 700 }}>{bCount} B estate</span></>}
              {cCount > 0 && <> · <span style={{ color: '#a8a29e', fontWeight: 700 }}>{cCount} C</span></>}
              {unscored > 0 && <> · <span style={{ color: '#78716c' }}>{unscored} unscored</span></>}
            </div>
          </div>

          <div style={{ display: 'flex', gap: 4, background: '#0c0a09', border: '1px solid #292524', borderRadius: 8, padding: 3 }}>
            <button onClick={() => setTrack('surplus')} style={{
              padding: '6px 14px', borderRadius: 5, border: '1px solid ' + (track === 'surplus' ? '#44403c' : 'transparent'),
              background: track === 'surplus' ? '#292524' : 'transparent',
              color: track === 'surplus' ? '#fafaf9' : '#78716c',
              fontSize: 12, fontWeight: track === 'surplus' ? 700 : 500, cursor: 'pointer',
            }}>💰 Surplus</button>
            <button onClick={() => setTrack('30dts')} style={{
              padding: '6px 14px', borderRadius: 5, border: '1px solid ' + (track === '30dts' ? '#44403c' : 'transparent'),
              background: track === '30dts' ? '#292524' : 'transparent',
              color: track === '30dts' ? '#fafaf9' : '#78716c',
              fontSize: 12, fontWeight: track === '30dts' ? 700 : 500, cursor: 'pointer',
            }}>⏰ 30DTS</button>
          </div>
        </div>

        {/* Filter bar */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ fontSize: 10, fontWeight: 700, color: '#78716c', letterSpacing: '0.08em', textTransform: 'uppercase', marginRight: 2 }}>Tier</span>
          {(['A', 'B', 'C', 'other']).map(t => {
            const meta = TIER_META[t] || { label: '?', bg: '#292524', fg: '#78716c' };
            const isOn = tierFilter[t];
            return (
              <button key={t} onClick={() => setTierFilter(f => ({ ...f, [t]: !f[t] }))} style={{
                fontSize: 10, padding: '4px 10px', borderRadius: 4,
                background: isOn ? meta.bg : 'transparent',
                color: isOn ? meta.fg : '#57534e',
                border: '1px solid ' + (isOn ? meta.bg : '#292524'),
                fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', cursor: 'pointer',
              }}>{t === 'other' ? '? Unscored' : meta.label}</button>
            );
          })}
          <select value={countyFilter} onChange={e => setCountyFilter(e.target.value)} style={{ ...selectStyle, fontSize: 11, padding: '4px 8px', minWidth: 140, marginLeft: 8 }}>
            <option value="">All counties</option>
            {counties.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search name / address / case #" style={{ ...inputStyle, fontSize: 11, padding: '4px 10px', maxWidth: 260, background: '#0c0a09' }} />
          <BulkOutreachButton candidates={filtered} />
        </div>
      </div>

      {/* Unassigned warning */}
      {unassigned.length > 0 && (
        <div style={{ marginBottom: 12, padding: '8px 12px', background: '#78350f22', border: '1px solid #d97706', borderRadius: 6, fontSize: 12, color: '#fbbf24' }}>
          ⚠ {unassigned.length} deal{unassigned.length === 1 ? '' : 's'} with unrecognized sales_stage value — open and set a stage.
        </div>
      )}

      {/* Kanban board */}
      <div style={{ overflowX: 'auto', paddingBottom: 10 }}>
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${stages.length}, minmax(220px, 1fr))`, gap: 10 }}>
          {stages.map(stage => {
            const cards = grouped[stage.key] || [];
            const isOver = dragOverStage === stage.key;
            return (
              <div
                key={stage.key}
                onDragOver={e => handleDragOver(e, stage.key)}
                onDragLeave={() => handleDragLeave(stage.key)}
                onDrop={e => handleDrop(e, stage.key)}
                style={{
                  background: isOver ? '#1f1c19' : '#1c1917',
                  border: `1px ${isOver ? 'dashed' : 'solid'} ${isOver ? stage.color : '#292524'}`,
                  borderRadius: 10, padding: 10,
                  borderTop: `3px solid ${stage.color}`,
                  minHeight: 180,
                  transition: 'background 0.1s, border-color 0.1s',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, padding: '0 4px' }}>
                  <span style={{ fontSize: 10, fontWeight: 700, color: stage.color, letterSpacing: '0.08em', textTransform: 'uppercase' }}>{stage.label}</span>
                  <span style={{ fontSize: 10, fontWeight: 700, color: '#78716c', background: '#292524', padding: '2px 7px', borderRadius: 8, minWidth: 20, textAlign: 'center' }}>{cards.length}</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {cards.map(d => {
                    const dragging = dragId === d.id;
                    return (
                      <div
                        key={d.id}
                        draggable
                        onDragStart={e => handleDragStart(e, d.id)}
                        onDragEnd={handleDragEnd}
                        onClick={() => onSelect(d.id)}
                        style={{
                          background: '#0c0a09', border: '1px solid ' + (d.is_30dts ? '#78350f' : '#292524'),
                          borderLeft: '3px solid ' + (d.lead_tier === 'A' ? '#d8b560' : d.lead_tier === 'B' ? '#8b5cf6' : d.lead_tier === 'C' ? '#44403c' : '#292524'),
                          borderRadius: 8, padding: 10, cursor: 'grab',
                          opacity: dragging ? 0.4 : 1,
                          transition: 'border-color 0.15s, opacity 0.1s',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 6, marginBottom: 4 }}>
                          <DealCardName deal={d} />
                          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                            {d.is_30dts && <DTSCountdown days={d.days_to_sale} />}
                            <TierBadge deal={d} />
                          </div>
                        </div>
                        <div style={{ fontSize: 10, color: '#78716c', marginBottom: 6, lineHeight: 1.4 }}>
                          {d.meta?.county && <>{d.meta.county} County</>}
                          {d.address && <> · <span title={d.address}>{(d.address.length > 40 ? d.address.slice(0, 40) + '…' : d.address)}</span></>}
                        </div>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                          {Number(d.surplus_estimate) > 0 && (
                            <span style={{ fontSize: 10, fontWeight: 700, color: '#fbbf24', fontFamily: "'DM Mono', monospace" }}>
                              {fmtMoneyShort(d.surplus_estimate)}
                            </span>
                          )}
                          <StalenessTag lastContactedAt={d.last_contacted_at} />
                        </div>
                        {/* Send Intro Text button: only in 'new' stage + has phone + token ready */}
                        {d[stageField] === 'new' && d.meta?.homeownerPhone && (
                          <button
                            onClick={e => { e.stopPropagation(); setTextingDeal(d); }}
                            style={{ marginTop: 8, width: '100%', padding: '5px 10px', background: '#064e3b', color: '#6ee7b7', border: '1px solid #065f46', borderRadius: 5, fontSize: 10, fontWeight: 700, cursor: 'pointer', letterSpacing: '0.04em', textTransform: 'uppercase' }}
                          >💬 Send Intro Text</button>
                        )}
                        {d[stageField] !== 'new' && d.meta?.homeownerPhone && (
                          <button
                            onClick={e => { e.stopPropagation(); setTextingDeal(d); }}
                            style={{ marginTop: 8, width: '100%', padding: '4px 10px', background: 'transparent', color: '#78716c', border: '1px solid #292524', borderRadius: 5, fontSize: 9, fontWeight: 600, cursor: 'pointer', letterSpacing: '0.04em', textTransform: 'uppercase' }}
                          >↻ Resend / Follow up</button>
                        )}
                      </div>
                    );
                  })}
                  {cards.length === 0 && <div style={{ fontSize: 10, color: '#57534e', textAlign: 'center', padding: '12px 0', fontStyle: 'italic' }}>{isOver ? 'Drop to move here' : 'Empty'}</div>}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {filtered.length === 0 && candidates.length > 0 && (
        <div style={{ marginTop: 20, padding: 30, textAlign: 'center', color: '#78716c', border: '1px dashed #292524', borderRadius: 10 }}>
          All {candidates.length} {track === '30dts' ? '30DTS' : 'surplus'} deal{candidates.length === 1 ? '' : 's'} are hidden by the current filter. Clear tier filters or county to see them.
        </div>
      )}

      {candidates.length === 0 && (
        <div style={{ marginTop: 20, padding: 40, textAlign: 'center', color: '#78716c', border: '1px dashed #292524', borderRadius: 10, fontSize: 13, lineHeight: 1.6 }}>
          {track === '30dts'
            ? 'No 30DTS deals. Castle flags a deal as 30DTS when the sale date is within 30 days. If this list is empty and you\'re expecting one here, check that Castle\'s scoring ran recently.'
            : 'No active surplus deals in the sales pipeline. Add a lead + set its stage, or wait for the homepage search to send one in.'
          }
        </div>
      )}

      {textingDeal && (
        <SendIntroTextModal
          deal={textingDeal}
          onClose={() => setTextingDeal(null)}
          onSent={() => { /* realtime on deals will reload */ }}
        />
      )}
    </div>
  );
}

function KanbanBoard({ deals, statuses, onSelect, type, onMoveDeal }) {
  const [dragId, setDragId] = useState(null);
  const [dragOverStatus, setDragOverStatus] = useState(null);

  const handleDragStart = (e, dealId) => {
    setDragId(dealId);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", dealId);
  };
  const handleDragEnd = () => {
    setDragId(null);
    setDragOverStatus(null);
  };
  const handleDragOver = (e, status) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (dragOverStatus !== status) setDragOverStatus(status);
  };
  const handleDragLeave = (status) => {
    if (dragOverStatus === status) setDragOverStatus(null);
  };
  const handleDrop = (e, status) => {
    e.preventDefault();
    const id = e.dataTransfer.getData("text/plain") || dragId;
    setDragId(null);
    setDragOverStatus(null);
    if (!id) return;
    const d = deals.find(x => x.id === id);
    if (!d || d.status === status) return;
    onMoveDeal && onMoveDeal(id, d.status, status);
  };

  return (
    <div className="kanban-board" style={{ overflowX: "auto", paddingBottom: 8 }}>
      <div className="kanban-columns" style={{ display: "grid", gridTemplateColumns: `repeat(${statuses.length}, minmax(180px, 1fr))`, gap: 10 }}>
        {statuses.map(status => {
          const col = STATUS_COLORS[status] || "#78716c";
          const cards = deals.filter(d => d.status === status);
          const isOver = dragOverStatus === status;
          return (
            <div key={status}
              onDragOver={e => handleDragOver(e, status)}
              onDragLeave={() => handleDragLeave(status)}
              onDrop={e => handleDrop(e, status)}
              style={{ background: isOver ? "#1f1c19" : "#1c1917", border: `1px ${isOver ? "dashed" : "solid"} ${isOver ? col : "#292524"}`, borderRadius: 10, padding: 10, borderTop: `3px solid ${col}`, minHeight: 120, transition: "background 0.1s, border-color 0.1s" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, padding: "0 4px" }}>
                <span style={{ fontSize: 10, fontWeight: 700, color: col, letterSpacing: "0.08em", textTransform: "uppercase" }}>{status.replace(/-/g, " ")}</span>
                <span style={{ fontSize: 10, fontWeight: 700, color: "#78716c", background: "#292524", padding: "2px 7px", borderRadius: 8, minWidth: 20, textAlign: "center" }}>{cards.length}</span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {cards.map(d => {
                  const m = d.meta || {};
                  const assignee = d.assigned_to || m.assigned_to;
                  const dragging = dragId === d.id;
                  return (
                    <div key={d.id}
                      draggable
                      onDragStart={e => handleDragStart(e, d.id)}
                      onDragEnd={handleDragEnd}
                      onClick={() => onSelect(d.id)}
                      style={{ background: "#0c0a09", border: "1px solid #292524", borderRadius: 8, padding: 10, cursor: "grab", opacity: dragging ? 0.4 : 1, transition: "border-color 0.15s, opacity 0.1s" }}
                      onMouseEnter={e => e.currentTarget.style.borderColor = "#44403c"}
                      onMouseLeave={e => e.currentTarget.style.borderColor = "#292524"}>
                      <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 4, lineHeight: 1.3 }}>{d.name}</div>
                      {d.address && <div style={{ fontSize: 10, color: "#78716c", marginBottom: 6 }}>{d.address}</div>}
                      <div style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center" }}>
                        {d.meta?.flagged && <span style={{ fontSize: 10, color: "#f59e0b" }}>⚑</span>}
                        {type === "flip" && m.listPrice > 0 && <span style={{ fontSize: 9, fontWeight: 600, color: "#a8a29e", fontFamily: "'DM Mono', monospace" }}>{fmt(m.listPrice)}</span>}
                        {type === "surplus" && m.estimatedSurplus > 0 && <span style={{ fontSize: 9, fontWeight: 600, color: "#a8a29e", fontFamily: "'DM Mono', monospace" }}>{fmt(m.estimatedSurplus)}</span>}
                        {assignee && <span style={{ fontSize: 8, fontWeight: 700, padding: "2px 6px", borderRadius: 3, background: personColor(assignee), color: "#fafaf9", marginLeft: "auto" }}>{assignee}</span>}
                      </div>
                    </div>
                  );
                })}
                {cards.length === 0 && <div style={{ fontSize: 10, color: "#57534e", textAlign: "center", padding: "12px 0", fontStyle: "italic" }}>{isOver ? "Drop to move here" : "No deals"}</div>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Inline-editable deal name in the header. Click to turn into an input;
// Enter or blur saves, Esc cancels. Preserves the legacy
// "Client Name - Address" concatenation: only the client portion is
// editable, the address tail stays intact.
function InlineEditableName({ deal, canEdit, onSave }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);

  const nameParts = (deal.name || '').split(' - ');
  const clientName = nameParts[0] || deal.id;
  const addressTail = nameParts.slice(1).join(' - ');

  const startEdit = () => {
    if (!canEdit) return;
    setValue(clientName);
    setEditing(true);
  };

  const commit = async () => {
    if (saving) return;
    const trimmed = value.trim();
    if (!trimmed || trimmed === clientName) { setEditing(false); return; }
    setSaving(true);
    const newName = addressTail ? `${trimmed} - ${addressTail}` : trimmed;
    await onSave({ name: newName });
    setSaving(false);
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        autoFocus
        value={value}
        disabled={saving}
        onChange={e => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === 'Enter') { e.preventDefault(); commit(); }
          else if (e.key === 'Escape') { e.preventDefault(); setEditing(false); }
        }}
        style={{
          fontSize: 26, fontWeight: 700, letterSpacing: '-0.02em', lineHeight: 1.1,
          marginTop: 4, background: '#0c0a09', color: '#fafaf9',
          border: '1px solid #44403c', borderRadius: 6, padding: '3px 10px',
          fontFamily: 'inherit', minWidth: 320, maxWidth: '100%',
        }}
      />
    );
  }

  return (
    <div
      className="page-title"
      onClick={startEdit}
      title={canEdit ? 'Click to edit the client name' : clientName}
      style={{
        fontSize: 26, fontWeight: 700, letterSpacing: '-0.02em', lineHeight: 1.1,
        marginTop: 4, cursor: canEdit ? 'pointer' : 'default',
        padding: '3px 6px', margin: '4px -6px 0', borderRadius: 6,
        transition: 'background 0.12s',
      }}
      onMouseEnter={e => { if (canEdit) e.currentTarget.style.background = '#1c1917'; }}
      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
    >
      {clientName}
      {canEdit && <span style={{ fontSize: 11, color: '#57534e', marginLeft: 10, fontWeight: 400, letterSpacing: 0 }}>✎</span>}
    </div>
  );
}

// Compact click-to-edit text for header subheader fields. Enter or blur
// saves, Escape cancels. Empty field shows a "+ Add <label>" button so
// missing data is easy to fill in without digging into the Case Details
// card. Used for courtCase / county / address in the deal subheader.
function InlineEditableText({ value, onSave, label, placeholder, canEdit = true }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  const startEdit = () => {
    if (!canEdit) return;
    setDraft(value || '');
    setEditing(true);
  };

  const commit = async () => {
    if (saving) return;
    const trimmed = draft.trim();
    if (trimmed === (value || '').trim()) { setEditing(false); return; }
    setSaving(true);
    await onSave(trimmed);
    setSaving(false);
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        disabled={saving}
        placeholder={placeholder}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === 'Enter') { e.preventDefault(); commit(); }
          else if (e.key === 'Escape') { e.preventDefault(); setEditing(false); }
        }}
        style={{
          fontSize: 13, color: "#fafaf9", background: "#0c0a09",
          border: "1px solid #44403c", borderRadius: 4, padding: "2px 6px",
          fontFamily: "inherit", minWidth: 120, maxWidth: 260,
        }}
      />
    );
  }

  if (!value) {
    return canEdit ? (
      <button
        onClick={startEdit}
        style={{ background: "transparent", border: "1px dashed #44403c", color: "#57534e", padding: "1px 7px", borderRadius: 4, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}
      >+ {label}</button>
    ) : null;
  }

  return (
    <span
      onClick={startEdit}
      title={canEdit ? `Click to edit ${label}` : undefined}
      style={{ cursor: canEdit ? "pointer" : "default", padding: "1px 4px", margin: "0 -4px", borderRadius: 3, transition: "background 0.12s" }}
      onMouseEnter={e => { if (canEdit) e.currentTarget.style.background = "#1c1917"; }}
      onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}
    >{value}</span>
  );
}

function PortfolioStat({ label, value, sub, color, onClick }) {
  const clickable = typeof onClick === 'function';
  return (
    <div
      className="portfolio-stat-card"
      onClick={clickable ? onClick : undefined}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={clickable ? (e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }) : undefined}
      style={{
        background: "#1c1917", border: "1px solid #292524", borderRadius: 10, padding: 14,
        borderTop: `2px solid ${color}`,
        cursor: clickable ? "pointer" : "default",
        transition: "transform 0.08s, border-color 0.12s, background 0.12s",
      }}
      onMouseEnter={clickable ? (e => { e.currentTarget.style.background = "#292524"; e.currentTarget.style.borderColor = "#57534e"; }) : undefined}
      onMouseLeave={clickable ? (e => { e.currentTarget.style.background = "#1c1917"; e.currentTarget.style.borderColor = "#292524"; }) : undefined}
    >
      <div className="portfolio-stat-label" style={{ fontSize: 10, fontWeight: 700, color: "#78716c", letterSpacing: "0.1em", textTransform: "uppercase", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span>{label}</span>
        {clickable && <span style={{ fontSize: 11, color: "#57534e", fontWeight: 400 }}>→</span>}
      </div>
      <div className="portfolio-stat-value" style={{ fontSize: 22, fontWeight: 700, fontFamily: "'DM Mono', monospace", marginTop: 6, color }}>{value}</div>
      <div style={{ fontSize: 10, color: "#78716c", marginTop: 2 }}>{sub}</div>
    </div>
  );
}

function SectionLabel({ icon, label }) {
  return <div style={{ fontSize: 11, fontWeight: 700, color: "#78716c", letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 12, display: "flex", alignItems: "center", gap: 8 }}><span>{icon}</span>{label}</div>;
}

// ─── Today View ──────────────────────────────────────────────────────
// Best-effort expected payout date for a deal.
// Prefers explicit meta.expected_payout, falls back to deadline, then
// filed_at + 120 days (Ohio surplus typical recovery timeline).
const expectedPayoutDate = (deal) => {
  const m = deal.meta || {};
  if (m.expected_payout) { const d = new Date(m.expected_payout); if (!isNaN(d)) return d; }
  const dl = m.deadline || deal.deadline;
  if (dl) { const d = new Date(dl); if (!isNaN(d)) return d; }
  const filed = m.filed_at || deal.filed_at;
  if (filed) { const d = new Date(filed); if (!isNaN(d)) { d.setDate(d.getDate() + 120); return d; } }
  return null;
};

// ─── Reports View ───────────────────────────────────────────────
// Operational dashboard: pipeline $ by Castle tier, surplus funnel with $ per
// stage, Castle scraper health, ops velocity (activities/day, task burndown),
// and client engagement. Complements AnalyticsView (which covers financial
// forecasting + attorney/county performance).
// ─── Attention View ─────────────────────────────────────────────
// Central dashboard of everything waiting on Nathan/Justin across ALL deals.
// Per-deal counts: un-acknowledged docket events, inbound SMS not yet read
// on Comms, missed/new calls, inbound emails, pending outreach drafts from
// Justin's outreach_queue. Sorted most-urgent-first. One click jumps into
// the deal with the right tab pre-selected.
// ── Castle scraper health (v_scraper_health view) ────────────
// Shared fetcher + two renderers. Data is ~5 rows, refresh every 60s.
// The view is created by Castle's migration (lives in scraper_agents +
// v_scraper_health). health_color values: 'green' | 'yellow' | 'red' |
// 'disabled' | 'never_run'. should_alert is pre-baked in the view.
function useScraperHealth(pollMs = 60000) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const { data, error } = await sb.from('v_scraper_health').select('*');
      if (!alive) return;
      if (error) { setErr(error.message); return; }
      setRows(data || []);
    };
    load();
    const id = setInterval(load, pollMs);
    return () => { alive = false; clearInterval(id); };
  }, [pollMs]);
  return { rows, err };
}

const HEALTH_DOT = {
  green:     { bg: '#10b981', label: 'Healthy' },
  yellow:    { bg: '#f59e0b', label: 'Stale' },
  red:       { bg: '#ef4444', label: 'Overdue' },
  disabled:  { bg: '#44403c', label: 'Paused' },
  never_run: { bg: '#78716c', label: 'Never run' },
};
function fmtAgeMinutes(m) {
  if (m == null) return '—';
  if (m < 1) return 'just now';
  if (m < 60) return Math.round(m) + 'm ago';
  if (m < 24 * 60) return (m / 60).toFixed(1) + 'h ago';
  return Math.round(m / 1440) + 'd ago';
}

// Compact strip — renders nothing when everything is green/disabled.
// Used at the top of AttentionView so operational issues surface next to deal issues.
function ScraperAlertStrip() {
  const { rows } = useScraperHealth();
  if (!rows) return null;
  const alerting = rows.filter(r => r.should_alert || r.health_color === 'red' || r.health_color === 'yellow');
  if (alerting.length === 0) return null;
  return (
    <div style={{ marginBottom: 14, padding: '10px 14px', background: '#1c1917', border: '1px solid #7f1d1d', borderLeft: '3px solid #ef4444', borderRadius: 8 }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: '#fca5a5', letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 6 }}>
        🐍 Castle scraper alerts
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {alerting.map(r => {
          const dot = HEALTH_DOT[r.health_color] || HEALTH_DOT.yellow;
          return (
            <div key={r.agent_id}
              title={r.last_status ? `Last: ${r.last_status} · ${r.fails_last_3h} fail(s) in last 3h` : 'No runs yet'}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '4px 10px', background: '#0c0a09', border: '1px solid #292524', borderRadius: 4, fontSize: 11 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: dot.bg, flexShrink: 0 }} />
              <span style={{ color: '#fafaf9', fontWeight: 600 }}>{r.display_name}</span>
              <span style={{ color: '#a8a29e', fontFamily: "'DM Mono', monospace" }}>
                {fmtAgeMinutes(r.age_minutes)}
              </span>
              {r.fails_last_3h > 0 && (
                <span style={{ color: '#fca5a5', fontWeight: 700 }}>
                  · {r.fails_last_3h} fail{r.fails_last_3h === 1 ? '' : 's'}/3h
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Full per-agent grid for ReportsView. Shows every agent regardless of status
// so Nathan sees the whole fleet at a glance.
function ScraperHealthPanel() {
  const { rows, err } = useScraperHealth();
  if (err) {
    return (
      <div style={{ padding: 14, border: '1px solid #7f1d1d', background: '#1c1917', color: '#fca5a5', borderRadius: 8, fontSize: 12 }}>
        Couldn't load scraper health: {err}
      </div>
    );
  }
  if (!rows) {
    return <div style={{ padding: 14, fontSize: 12, color: '#78716c' }}>Loading scraper fleet…</div>;
  }
  if (rows.length === 0) {
    return (
      <div style={{ padding: 20, textAlign: 'center', border: '1px dashed #292524', borderRadius: 10, fontSize: 13, color: '#78716c' }}>
        No scraper_agents configured yet. Castle hasn't populated its catalog.
      </div>
    );
  }
  return (
    <div style={{ background: '#1c1917', border: '1px solid #292524', borderRadius: 10, overflow: 'hidden' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={{ padding: '10px 12px', textAlign: 'left', fontSize: 10, fontWeight: 700, color: '#78716c', letterSpacing: '0.1em', textTransform: 'uppercase' }}>Agent</th>
            <th style={{ padding: '10px 12px', textAlign: 'left',  fontSize: 10, fontWeight: 700, color: '#78716c', letterSpacing: '0.1em', textTransform: 'uppercase' }}>County / Scope</th>
            <th style={{ padding: '10px 12px', textAlign: 'right', fontSize: 10, fontWeight: 700, color: '#78716c', letterSpacing: '0.1em', textTransform: 'uppercase' }}>Cadence</th>
            <th style={{ padding: '10px 12px', textAlign: 'right', fontSize: 10, fontWeight: 700, color: '#78716c', letterSpacing: '0.1em', textTransform: 'uppercase' }}>Last run</th>
            <th style={{ padding: '10px 12px', textAlign: 'left',  fontSize: 10, fontWeight: 700, color: '#78716c', letterSpacing: '0.1em', textTransform: 'uppercase' }}>Status</th>
            <th style={{ padding: '10px 12px', textAlign: 'right', fontSize: 10, fontWeight: 700, color: '#78716c', letterSpacing: '0.1em', textTransform: 'uppercase' }}>Fails/3h</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => {
            const dot = HEALTH_DOT[r.health_color] || HEALTH_DOT.yellow;
            const overdue = (r.age_minutes != null) && (r.age_minutes > (r.cadence_minutes + r.grace_minutes));
            return (
              <tr key={r.agent_id} style={{ borderTop: '1px solid #0c0a09' }}>
                <td style={{ padding: '10px 12px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span title={dot.label} style={{ width: 10, height: 10, borderRadius: '50%', background: dot.bg, flexShrink: 0, boxShadow: r.should_alert ? `0 0 0 3px ${dot.bg}33` : 'none' }} />
                    <div>
                      <div style={{ color: '#fafaf9', fontWeight: 600, fontSize: 13 }}>{r.display_name}</div>
                      <div style={{ color: '#57534e', fontSize: 10, fontFamily: "'DM Mono', monospace" }}>
                        {r.agent_id}{r.uses_selenium ? ' · selenium' : ' · httpx'}
                      </div>
                    </div>
                  </div>
                </td>
                <td style={{ padding: '10px 12px', color: '#a8a29e', fontSize: 12 }}>
                  {r.county_scope || '—'}
                </td>
                <td style={{ padding: '10px 12px', textAlign: 'right', color: '#a8a29e', fontSize: 12, fontFamily: "'DM Mono', monospace" }}>
                  {r.cadence_minutes}m <span style={{ color: '#44403c' }}>±{r.grace_minutes}</span>
                </td>
                <td style={{ padding: '10px 12px', textAlign: 'right', color: overdue ? '#fbbf24' : '#d6d3d1', fontSize: 12, fontFamily: "'DM Mono', monospace" }}>
                  {fmtAgeMinutes(r.age_minutes)}
                </td>
                <td style={{ padding: '10px 12px', color: r.last_status === 'success' ? '#6ee7b7' : r.last_status === 'failed' || r.last_status === 'error' ? '#fca5a5' : '#a8a29e', fontSize: 12, fontWeight: 600 }}>
                  {r.last_status || '—'}
                  {r.last_events_new > 0 && (
                    <span style={{ color: '#a8a29e', marginLeft: 6, fontWeight: 400, fontSize: 11 }}>
                      · {r.last_events_new} new
                    </span>
                  )}
                </td>
                <td style={{ padding: '10px 12px', textAlign: 'right', color: r.fails_last_3h > 0 ? '#fca5a5' : '#57534e', fontSize: 12, fontFamily: "'DM Mono', monospace", fontWeight: r.fails_last_3h > 0 ? 700 : 400 }}>
                  {r.fails_last_3h}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// Cross-deal deadline alert strip — silent when no deal has any docket event
// with a deadline_metadata countdown coming up in the next 14 days. Pinned at
// the top of AttentionView next to the Castle scraper alerts. The data
// comes from Castle's K.3 emission landing in docket_events.deadline_metadata.
function DeadlineAlertStrip({ onSelect }) {
  const [items, setItems] = useState(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      // Pull every event that has deadline_metadata + an event_date within the
      // last ~120 days. Compute the deadline client-side and filter to "upcoming
      // or just-expired" so Nathan gets a window of ~14 days forward + 3 days
      // backward (in case he wants to chase a just-missed deadline).
      const since = new Date(Date.now() - 120 * 86400000).toISOString().slice(0, 10);
      const { data } = await sb.from('docket_events')
        .select('id, deal_id, event_type, event_date, description, deadline_metadata')
        .gte('event_date', since)
        .not('deadline_metadata', 'is', null)
        .eq('is_backfill', false);
      if (!alive) return;

      // Pull the matching deal names so the strip can show them
      const dealIds = [...new Set((data || []).map(e => e.deal_id))];
      let dealsById = {};
      if (dealIds.length > 0) {
        const { data: deals } = await sb.from('deals').select('id, name, status').in('id', dealIds);
        dealsById = Object.fromEntries((deals || []).map(d => [d.id, d]));
      }

      const results = [];
      for (const e of (data || [])) {
        const d = eventDeadline(e);
        if (!d) continue;
        // Surface anything from -3 days (just expired, may still be salvageable)
        // to +14 days (approaching). Skip the comfortable zone.
        if (d.daysRemaining < -3 || d.daysRemaining > 14) continue;
        results.push({ event: e, deadline: d, deal: dealsById[e.deal_id] || { id: e.deal_id, name: e.deal_id } });
      }
      results.sort((a, b) => a.deadline.daysRemaining - b.deadline.daysRemaining);
      setItems(results);
    };
    load();
    const id = setInterval(load, 5 * 60 * 1000); // refresh every 5 min
    return () => { alive = false; clearInterval(id); };
  }, []);

  if (!items || items.length === 0) return null;

  return (
    <div style={{ marginBottom: 14, padding: '10px 14px', background: '#1c1917', border: '1px solid #92400e', borderLeft: '3px solid #f59e0b', borderRadius: 8 }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: '#fbbf24', letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 8 }}>
        ⏳ Approaching deadlines · {items.length}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {items.map(({ event, deadline, deal }) => {
          const c = deadlineColor(deadline.daysRemaining);
          return (
            <div key={event.id}
              onClick={() => onSelect && onSelect(deal.id)}
              style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 10px', background: '#0c0a09', border: '1px solid #292524', borderRadius: 5, cursor: 'pointer' }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: c, minWidth: 110, fontFamily: "'DM Mono', monospace" }}>
                {deadlineLabel(deadline)}
              </span>
              <span style={{ fontSize: 12, fontWeight: 600, color: '#fafaf9', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {deal.name || deal.id}
              </span>
              <span style={{ fontSize: 10, color: '#a8a29e', flexShrink: 0 }}>
                {deadlineKindLabel(deadline.kind)}
              </span>
              <span style={{ fontSize: 10, color: '#78716c', flexShrink: 0, fontFamily: "'DM Mono', monospace" }}>
                {deadline.deadlineDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── useAliveRef: gate setState calls after unmount ───────────
// Prevents async data-fetches from setting state on unmounted components
// (silences React warnings on rapid view nav). Pattern:
//   const alive = useAliveRef();
//   ... if (alive.current) setRows(data);
function useAliveRef() {
  const ref = useRef(true);
  useEffect(() => { ref.current = true; return () => { ref.current = false; }; }, []);
  return ref;
}

// ─── Forecast View ───────────────────────────────────────────────
// Proactive "next 7-14 days" planning surface — opposite philosophy from
// Attention (which is reactive — what just happened). Six sections pull
// from data that already lands in DCC's Supabase. Each section is empty-
// state-friendly so it lights up gracefully as Castle's pipeline matures
// (especially Castle's K.1/K.3/H.b emissions which haven't begun yet, and
// Phase 8's per-county scraper rollout which is months-away).
//
// Sections:
//   🏛 Court hearings · next 7 days     (docket_events.event_type='hearing_scheduled')
//   ⏳ Statutory deadlines · next 14d   (docket_events.deadline_metadata)
//   📤 Cadence drips · next 48h         (outreach_queue scheduled future)
//   💰 Disbursement watch · 14d+ stale  (litigation_stage='distribution_ordered' w/o paid)
//   🔥 Stale active deals · 14d+ silent (active deals w/ no recent outbound)
//   🏛 Sheriff sales · next 14 days     (foreclosure_cases.sale_date)
function ForecastView({ deals, onSelect }) {
  return (
    <div>
      <div style={{ marginBottom: 18 }}>
        <h2 style={{ fontSize: 22, fontWeight: 700, color: '#fafaf9', margin: 0, display: 'inline-flex', alignItems: 'center', gap: 10 }}>
          📅 Forecast
          <span style={{ fontSize: 12, fontWeight: 400, color: '#a8a29e' }}>· what's coming · 7-14 days out</span>
        </h2>
        <div style={{ fontSize: 11, color: '#78716c', marginTop: 6, lineHeight: 1.55 }}>
          Plan instead of react. Sections refresh every 5 min. Empty sections will populate as Castle's pipeline emits the data type — many event types and full county coverage are still rolling out (Phase 8: 5/88 counties live).
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, alignItems: 'start' }}>
        <ForecastHearings onSelect={onSelect} />
        <ForecastDeadlines onSelect={onSelect} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, alignItems: 'start', marginTop: 20 }}>
        <ForecastCadenceDrips deals={deals} onSelect={onSelect} />
        <ForecastDisbursementWatch onSelect={onSelect} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, alignItems: 'start', marginTop: 20 }}>
        <ForecastStaleDeals deals={deals} onSelect={onSelect} />
        <ForecastSheriffSales />
      </div>

      <div style={{ marginTop: 32, padding: 14, background: '#0c0a09', border: '1px dashed #292524', borderRadius: 8, fontSize: 11, color: '#78716c', lineHeight: 1.6 }}>
        <b style={{ color: '#a8a29e' }}>Coverage note:</b> sheriff sales + court hearings only show for counties Castle is actively monitoring. Currently <code style={{ color: '#a8a29e' }}>Hamilton</code>, <code style={{ color: '#a8a29e' }}>Franklin</code>, <code style={{ color: '#a8a29e' }}>Butler</code>, <code style={{ color: '#a8a29e' }}>Cuyahoga</code>, <code style={{ color: '#a8a29e' }}>Montgomery</code> (5 of 88 OH counties). The other 83 surface as Castle's Phase 8 ships per-county scrapers.
      </div>
    </div>
  );
}

// ─── Forecast: Court hearings · next 7 days ────────────────────
function ForecastHearings({ onSelect }) {
  const [rows, setRows] = useState(null);
  const alive = useAliveRef();
  const load = React.useCallback(async () => {
    const todayIso = new Date().toISOString().slice(0, 10);
    const in7d = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    const { data } = await sb.from('docket_events')
      .select('id, deal_id, event_type, event_date, description, court_system, county')
      .eq('event_type', 'hearing_scheduled')
      .gte('event_date', todayIso)
      .lte('event_date', in7d)
      .eq('is_backfill', false)
      .order('event_date', { ascending: true });
    if (!alive.current) return;
    if (!data || data.length === 0) { setRows([]); return; }
    const dealIds = [...new Set(data.map(d => d.deal_id))];
    const { data: deals } = await sb.from('deals').select('id, name, status').in('id', dealIds);
    if (!alive.current) return;
    const byId = Object.fromEntries((deals || []).map(d => [d.id, d]));
    setRows(data.map(e => ({ ...e, deal: byId[e.deal_id] || { id: e.deal_id, name: e.deal_id } })));
  }, [alive]);
  // Stable ref so the channel subscription doesn't churn when load identity changes
  const loadRef = useRef(load); loadRef.current = load;
  useEffect(() => { load(); const t = setInterval(() => loadRef.current(), 5 * 60 * 1000); return () => clearInterval(t); }, [load]);
  useEffect(() => {
    // Empty deps — subscribe once. useId would give per-instance unique names but
    // singleton names are fine since cleanup runs before any same-named re-subscribe.
    const ch = sb.channel('forecast-hearings').on('postgres_changes', { event: '*', schema: 'public', table: 'docket_events' }, () => loadRef.current()).subscribe();
    return () => { sb.removeChannel(ch); };
  }, []);

  return (
    <ForecastSection icon="🏛" label="Court hearings · next 7 days" sub="From docket_events. Castle event type: hearing_scheduled." count={rows?.length}>
      {rows === null && <ForecastLoading />}
      {rows && rows.length === 0 && <ForecastEmpty text="No hearings scheduled in the next 7 days for any monitored deal." />}
      {rows && rows.length > 0 && rows.map(e => (
        <ForecastRow key={e.id} onClick={() => onSelect && onSelect(e.deal_id)}>
          <ForecastDate iso={e.event_date} />
          <ForecastBody primary={e.deal.name} secondary={e.description ? e.description.slice(0, 80) : (e.county ? e.county + ' County' : '')} />
        </ForecastRow>
      ))}
    </ForecastSection>
  );
}

// ─── Forecast: Statutory deadlines · next 14 days ──────────────
function ForecastDeadlines({ onSelect }) {
  const [rows, setRows] = useState(null);
  const alive = useAliveRef();
  const load = React.useCallback(async () => {
    const since = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
    const { data } = await sb.from('docket_events')
      .select('id, deal_id, event_type, event_date, description, deadline_metadata')
      .gte('event_date', since)
      .not('deadline_metadata', 'is', null)
      .eq('is_backfill', false);
    if (!alive.current) return;
    if (!data || data.length === 0) { setRows([]); return; }
    const dealIds = [...new Set(data.map(d => d.deal_id))];
    const { data: deals } = await sb.from('deals').select('id, name, status').in('id', dealIds);
    if (!alive.current) return;
    const byId = Object.fromEntries((deals || []).map(d => [d.id, d]));
    const upcoming = [];
    for (const e of data) {
      const d = eventDeadline(e);
      if (!d) continue;
      if (d.daysRemaining < 0 || d.daysRemaining > 14) continue;
      upcoming.push({ ...e, deadline: d, deal: byId[e.deal_id] || { id: e.deal_id, name: e.deal_id } });
    }
    upcoming.sort((a, b) => a.deadline.daysRemaining - b.deadline.daysRemaining);
    setRows(upcoming);
  }, [alive]);
  const loadRef = useRef(load); loadRef.current = load;
  useEffect(() => { load(); const t = setInterval(() => loadRef.current(), 5 * 60 * 1000); return () => clearInterval(t); }, [load]);

  return (
    <ForecastSection icon="⏳" label="Statutory deadlines · next 14 days" sub="From docket_events.deadline_metadata. Castle's K.3 emission lights this up." count={rows?.length}>
      {rows === null && <ForecastLoading />}
      {rows && rows.length === 0 && <ForecastEmpty text="No statutory deadlines approaching. (Castle's deadline_metadata emission ships as motions/orders fire on monitored deals — empty until then.)" />}
      {rows && rows.length > 0 && rows.map(e => {
        const c = deadlineColor(e.deadline.daysRemaining);
        return (
          <ForecastRow key={e.id} onClick={() => onSelect && onSelect(e.deal_id)}>
            <div style={{ minWidth: 60, fontSize: 11, fontWeight: 700, color: c, fontFamily: "'DM Mono', monospace", textAlign: 'center' }}>
              {e.deadline.daysRemaining}d
            </div>
            <ForecastBody primary={e.deal.name} secondary={`${deadlineKindLabel(e.deadline.kind)} · due ${e.deadline.deadlineDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`} />
          </ForecastRow>
        );
      })}
    </ForecastSection>
  );
}

// ─── Forecast: Cadence drips · next 48h ────────────────────────
function ForecastCadenceDrips({ deals, onSelect }) {
  const [rows, setRows] = useState(null);
  const alive = useAliveRef();
  // Hold deals in a ref so load identity stays stable when deals reference changes —
  // prevents channel re-subscribe churn on every parent re-render.
  const dealsRef = useRef(deals); dealsRef.current = deals;
  const load = React.useCallback(async () => {
    const now = new Date();
    const in48h = new Date(Date.now() + 48 * 60 * 60 * 1000);
    const { data } = await sb.from('outreach_queue')
      .select('id, deal_id, contact_phone, cadence_day, status, draft_body, scheduled_for')
      .eq('status', 'pending')
      .gte('cadence_day', 1)
      .gte('scheduled_for', now.toISOString())
      .lte('scheduled_for', in48h.toISOString())
      .order('scheduled_for', { ascending: true })
      .limit(50);
    if (!alive.current) return;
    if (!data) { setRows([]); return; }
    const dealsById = Object.fromEntries((dealsRef.current || []).map(d => [d.id, d]));
    setRows(data.map(r => ({ ...r, deal: dealsById[r.deal_id] || { id: r.deal_id, name: r.deal_id } })));
  }, [alive]);
  const loadRef = useRef(load); loadRef.current = load;
  useEffect(() => { load(); const t = setInterval(() => loadRef.current(), 5 * 60 * 1000); return () => clearInterval(t); }, [load]);
  useEffect(() => {
    const ch = sb.channel('forecast-cadence').on('postgres_changes', { event: '*', schema: 'public', table: 'outreach_queue' }, () => loadRef.current()).subscribe();
    return () => { sb.removeChannel(ch); };
  }, []);

  return (
    <ForecastSection icon="📤" label="Cadence drips · next 48h" sub="What the cadence engine is about to send. Pause individual deals from their Comms tab." count={rows?.length}>
      {rows === null && <ForecastLoading />}
      {rows && rows.length === 0 && <ForecastEmpty text="No drips scheduled in the next 48h." />}
      {rows && rows.length > 0 && rows.map(r => {
        const fireAt = new Date(r.scheduled_for);
        const minsUntil = Math.max(0, Math.round((fireAt.getTime() - Date.now()) / 60000));
        const fmt = minsUntil < 60 ? `in ${minsUntil}m` : minsUntil < 1440 ? `in ${(minsUntil / 60).toFixed(1)}h` : `in ${(minsUntil / 1440).toFixed(1)}d`;
        return (
          <ForecastRow key={r.id} onClick={() => onSelect && onSelect(r.deal_id)}>
            <div style={{ minWidth: 60, fontSize: 11, fontWeight: 700, color: '#a78bfa', fontFamily: "'DM Mono', monospace", textAlign: 'center' }}>
              D{r.cadence_day}
            </div>
            <ForecastBody primary={r.deal.name} secondary={(r.draft_body || '(drafting…)').slice(0, 80)} />
            <div style={{ fontSize: 10, color: '#a78bfa', whiteSpace: 'nowrap', flexShrink: 0 }}>{fmt}</div>
          </ForecastRow>
        );
      })}
    </ForecastSection>
  );
}

// ─── Forecast: Disbursement watch · check overdue ──────────────
function ForecastDisbursementWatch({ onSelect }) {
  const [rows, setRows] = useState(null);
  const alive = useAliveRef();
  const load = React.useCallback(async () => {
    // Look for distribution_ordered events older than 14 days where the deal
    // hasn't yet had a distribution_paid event. The "where's my check" leading
    // indicator. Per Nathan's portal copy commitment of "24h after receipt" —
    // anything past 14 days from order-entry without payment deserves attention.
    const before14d = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
    const { data: ordered } = await sb.from('docket_events')
      .select('id, deal_id, event_type, event_date, description, litigation_stage')
      .or('event_type.eq.disbursement_ordered,litigation_stage.eq.distribution_ordered')
      .lte('event_date', before14d)
      .eq('is_backfill', false);
    if (!alive.current) return;
    if (!ordered || ordered.length === 0) { setRows([]); return; }
    const dealIds = [...new Set(ordered.map(o => o.deal_id))];
    const { data: paid } = await sb.from('docket_events')
      .select('deal_id')
      .or('event_type.eq.disbursement_paid,litigation_stage.eq.distribution_paid')
      .in('deal_id', dealIds);
    if (!alive.current) return;
    const paidSet = new Set((paid || []).map(p => p.deal_id));
    const unresolved = ordered.filter(o => !paidSet.has(o.deal_id));
    if (unresolved.length === 0) { setRows([]); return; }
    const { data: deals } = await sb.from('deals').select('id, name, status, meta').in('id', [...new Set(unresolved.map(o => o.deal_id))]);
    if (!alive.current) return;
    const byId = Object.fromEntries((deals || []).map(d => [d.id, d]));
    const enriched = unresolved.map(o => {
      const d = new Date(o.event_date);
      const days = Math.floor((Date.now() - d.getTime()) / 86400000);
      return { ...o, deal: byId[o.deal_id] || { id: o.deal_id, name: o.deal_id }, daysSinceOrdered: days };
    });
    enriched.sort((a, b) => b.daysSinceOrdered - a.daysSinceOrdered);
    setRows(enriched);
  }, [alive]);
  const loadRef = useRef(load); loadRef.current = load;
  useEffect(() => { load(); const t = setInterval(() => loadRef.current(), 5 * 60 * 1000); return () => clearInterval(t); }, [load]);

  return (
    <ForecastSection icon="💰" label="Disbursement watch · 14d+ stale" sub="Distribution ordered ≥14 days ago, no payment recorded. The 'where's my check?' leading indicator." count={rows?.length}>
      {rows === null && <ForecastLoading />}
      {rows && rows.length === 0 && <ForecastEmpty text="No stuck disbursements. Either nothing's been ordered yet or everything paid out within 14 days." />}
      {rows && rows.length > 0 && rows.map(o => (
        <ForecastRow key={o.id} onClick={() => onSelect && onSelect(o.deal_id)}>
          <div style={{ minWidth: 60, fontSize: 11, fontWeight: 700, color: o.daysSinceOrdered > 30 ? '#ef4444' : '#f59e0b', fontFamily: "'DM Mono', monospace", textAlign: 'center' }}>
            {o.daysSinceOrdered}d
          </div>
          <ForecastBody primary={o.deal.name} secondary={`Distribution ordered ${o.event_date}. No payment yet.`} />
        </ForecastRow>
      ))}
    </ForecastSection>
  );
}

// ─── Forecast: Stale active deals · 14d+ no contact ───────────
function ForecastStaleDeals({ deals, onSelect }) {
  const [rows, setRows] = useState(null);
  const alive = useAliveRef();
  const dealsRef = useRef(deals); dealsRef.current = deals;
  const load = React.useCallback(async () => {
    const ARCHIVE = new Set(['closed', 'recovered', 'dead']);
    const active = (dealsRef.current || []).filter(d => !ARCHIVE.has(d.status));
    if (active.length === 0) { if (alive.current) setRows([]); return; }
    const since = new Date(Date.now() - 14 * 86400000).toISOString();
    const { data: recentMsgs } = await sb.from('messages_outbound')
      .select('deal_id, created_at')
      .eq('direction', 'outbound')
      .gte('created_at', since)
      .in('deal_id', active.map(d => d.id));
    if (!alive.current) return;
    const recent = new Set((recentMsgs || []).map(m => m.deal_id));
    const stale = active.filter(d => !recent.has(d.id));
    stale.sort((a, b) => new Date(a.updated_at || 0).getTime() - new Date(b.updated_at || 0).getTime());
    setRows(stale.slice(0, 30));
  }, [alive]);
  const loadRef = useRef(load); loadRef.current = load;
  // Re-fire load when deals prop changes (new deal added, status changed, etc.)
  useEffect(() => { loadRef.current(); }, [deals]);
  useEffect(() => { load(); const t = setInterval(() => loadRef.current(), 5 * 60 * 1000); return () => clearInterval(t); }, [load]);

  return (
    <ForecastSection icon="🔥" label="Stale active deals · 14d+ no outbound" sub="Active deals you haven't messaged in 2+ weeks. Top 30, oldest first." count={rows?.length}>
      {rows === null && <ForecastLoading />}
      {rows && rows.length === 0 && <ForecastEmpty text="No stale deals. Every active deal has had outbound contact in the last 2 weeks." />}
      {rows && rows.length > 0 && rows.map(d => {
        const lastUpdated = d.updated_at ? Math.floor((Date.now() - new Date(d.updated_at).getTime()) / 86400000) : null;
        return (
          <ForecastRow key={d.id} onClick={() => onSelect && onSelect(d.id)}>
            <div style={{ minWidth: 60, fontSize: 11, fontWeight: 700, color: '#dc2626', fontFamily: "'DM Mono', monospace", textAlign: 'center' }}>
              {lastUpdated != null ? `${lastUpdated}d` : '—'}
            </div>
            <ForecastBody primary={d.name || d.id} secondary={`${d.status || 'active'}${d.lead_tier ? ' · Tier ' + d.lead_tier : ''}${d.meta?.county ? ' · ' + d.meta.county + ' Co.' : ''}`} />
          </ForecastRow>
        );
      })}
    </ForecastSection>
  );
}

// ─── Forecast: Sheriff sales · next 14 days ────────────────────
function ForecastSheriffSales() {
  const [rows, setRows] = useState(null);
  const alive = useAliveRef();
  const load = React.useCallback(async () => {
    const todayIso = new Date().toISOString().slice(0, 10);
    const in14d = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
    const { data } = await sb.from('foreclosure_cases')
      .select('id, case_number, county, property_address, sale_date, estimated_surplus_low, estimated_surplus_high, judgment_amount, source')
      .gte('sale_date', todayIso)
      .lte('sale_date', in14d)
      .order('sale_date', { ascending: true })
      .limit(50);
    if (!alive.current) return;
    setRows(data || []);
  }, [alive]);
  const loadRef = useRef(load); loadRef.current = load;
  useEffect(() => { load(); const t = setInterval(() => loadRef.current(), 5 * 60 * 1000); return () => clearInterval(t); }, [load]);

  return (
    <ForecastSection icon="🏛" label="Sheriff sales · next 14 days" sub="From foreclosure_cases (Castle auction sweeps). Castle covers 5 OH counties." count={rows?.length}>
      {rows === null && <ForecastLoading />}
      {rows && rows.length === 0 && <ForecastEmpty text="No upcoming sheriff sales in the next 14 days. (Castle's auction sweeps populate this — empty until next sweep run.)" />}
      {rows && rows.length > 0 && rows.map(s => {
        const surplusMid = s.estimated_surplus_low && s.estimated_surplus_high
          ? Math.round((Number(s.estimated_surplus_low) + Number(s.estimated_surplus_high)) / 2)
          : null;
        return (
          <ForecastRow key={s.id}>
            <ForecastDate iso={s.sale_date} />
            <ForecastBody primary={s.property_address || s.case_number} secondary={`${s.county || '—'} · case ${s.case_number || '—'}${surplusMid ? ' · est. surplus ~$' + surplusMid.toLocaleString() : ''}`} />
          </ForecastRow>
        );
      })}
    </ForecastSection>
  );
}

// ─── Shared Forecast helpers ────────────────────────────────────
function ForecastSection({ icon, label, sub, count, children }) {
  return (
    <div>
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: '#78716c', letterSpacing: '0.1em', textTransform: 'uppercase', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span>{icon}</span>
          <span>{label}</span>
          {count != null && count > 0 && <span style={{ background: '#292524', color: '#fafaf9', padding: '1px 8px', borderRadius: 10, fontSize: 10, fontWeight: 700, letterSpacing: 0 }}>{count}</span>}
        </div>
        {sub && <div style={{ fontSize: 11, color: '#57534e', marginTop: 3, lineHeight: 1.5 }}>{sub}</div>}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 360, overflowY: 'auto', paddingRight: 4 }}>
        {children}
      </div>
    </div>
  );
}
function ForecastRow({ children, onClick }) {
  return (
    <div onClick={onClick} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 10px', background: '#0c0a09', border: '1px solid #292524', borderRadius: 6, cursor: onClick ? 'pointer' : 'default' }}>
      {children}
    </div>
  );
}
function ForecastDate({ iso }) {
  const d = new Date(iso);
  const days = Math.floor((d.getTime() - Date.now()) / 86400000);
  return (
    <div style={{ minWidth: 60, textAlign: 'center', flexShrink: 0 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: '#fafaf9', fontFamily: "'DM Mono', monospace" }}>{d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</div>
      <div style={{ fontSize: 9, color: '#78716c', marginTop: 1 }}>{days <= 0 ? 'today' : days === 1 ? 'tmrw' : `${days}d`}</div>
    </div>
  );
}
function ForecastBody({ primary, secondary }) {
  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: '#fafaf9', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{primary}</div>
      {secondary && <div style={{ fontSize: 11, color: '#a8a29e', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{secondary}</div>}
    </div>
  );
}
function ForecastEmpty({ text }) {
  return <div style={{ fontSize: 11, color: '#78716c', padding: 14, border: '1px dashed #292524', borderRadius: 6, fontStyle: 'italic', lineHeight: 1.5 }}>{text}</div>;
}
function ForecastLoading() {
  return <div style={{ fontSize: 11, color: '#78716c', padding: 14 }}>Loading…</div>;
}

// ─── Outreach View ───────────────────────────────────────────────
// Workspace for "today's drip + replies + escalations." Top-level nav.
// Reuses Justin's AutomationsQueue (drafts ready to send) + a new
// ReplyInbox (cross-deal inbound SMS oldest-unread first). Stats tiles
// summarize the queue. This is the Monday-launch hub for A/B-tier
// outreach campaigns.
function OutreachView({ deals, onSelect }) {
  const [stats, setStats] = useState({ pending_drafts: 0, replies_waiting: 0, scheduled_24h: 0, sent_today: 0 });
  const alive = useAliveRef();

  const loadStats = React.useCallback(async () => {
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const next24h = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const [draftsRes, repliesRes, schedRes, sentRes] = await Promise.all([
      sb.from('outreach_queue').select('id', { count: 'exact', head: true }).in('status', ['queued', 'generating', 'pending']),
      sb.from('messages_outbound').select('id', { count: 'exact', head: true }).eq('direction', 'inbound').is('read_by_team_at', null),
      sb.from('outreach_queue').select('id', { count: 'exact', head: true }).eq('status', 'pending').lte('scheduled_for', next24h.toISOString()).gt('scheduled_for', new Date().toISOString()),
      sb.from('messages_outbound').select('id', { count: 'exact', head: true }).eq('direction', 'outbound').gte('created_at', todayStart.toISOString()),
    ]);
    if (!alive.current) return;
    setStats({
      pending_drafts: draftsRes.count || 0,
      replies_waiting: repliesRes.count || 0,
      scheduled_24h: schedRes.count || 0,
      sent_today: sentRes.count || 0,
    });
  }, [alive]);

  const loadStatsRef = useRef(loadStats); loadStatsRef.current = loadStats;
  useEffect(() => { loadStats(); }, [loadStats]);
  useEffect(() => {
    const ch = sb.channel('outreach-stats')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'outreach_queue' }, () => loadStatsRef.current())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'messages_outbound' }, () => loadStatsRef.current())
      .subscribe();
    return () => { sb.removeChannel(ch); };
  }, []);

  const Tile = ({ label, value, sub, color }) => (
    <div style={{ background: '#1c1917', border: '1px solid #292524', borderTop: `2px solid ${color}`, borderRadius: 10, padding: 14 }}>
      <div style={{ fontSize: 10, color: '#78716c', letterSpacing: '0.1em', textTransform: 'uppercase', fontWeight: 700 }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 700, color: '#fafaf9', fontFamily: "'DM Mono', monospace", marginTop: 4 }}>{value}</div>
      <div style={{ fontSize: 11, color: '#a8a29e', marginTop: 2 }}>{sub}</div>
    </div>
  );

  return (
    <div>
      <div style={{ marginBottom: 18 }}>
        <h2 style={{ fontSize: 22, fontWeight: 700, color: '#fafaf9', margin: 0, display: 'inline-flex', alignItems: 'center', gap: 10 }}>
          🚀 Outreach
          <span style={{ fontSize: 12, fontWeight: 400, color: '#a8a29e' }}>· campaigns + replies + escalations, all in one place</span>
        </h2>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 24 }}>
        <Tile label="Drafts ready to send" value={stats.pending_drafts} sub={stats.pending_drafts === 0 ? 'Nothing pending' : 'review + send below'} color="#d8b560" />
        <Tile label="Replies waiting" value={stats.replies_waiting} sub={stats.replies_waiting === 0 ? 'Inbox clear' : 'oldest first below'} color="#3b82f6" />
        <Tile label="Drips scheduled · next 24h" value={stats.scheduled_24h} sub="cadence engine" color="#a78bfa" />
        <Tile label="Sent today" value={stats.sent_today} sub="outbound count" color="#10b981" />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, alignItems: 'start' }}>
        <div>
          <SectionHeader icon="🤖" label="Drafts ready to send" sub="AI-drafted intro + cadence messages waiting on your review. Click any row to open the deal's Comms tab." />
          <AutomationsQueue onSelectDeal={onSelect} />
          {stats.pending_drafts === 0 && (
            <div style={{ fontSize: 12, color: '#78716c', padding: 18, border: '1px dashed #292524', borderRadius: 8, textAlign: 'center' }}>
              No drafts pending. Push an A/B-tier deal into outreach to queue one.
            </div>
          )}
        </div>
        <div>
          <SectionHeader icon="💬" label="Replies waiting" sub="Inbound SMS from claimants you haven't responded to yet. Oldest first — clear by replying or marking seen." />
          <ReplyInbox onSelect={onSelect} />
        </div>
      </div>

      <div style={{ marginTop: 32, padding: 14, background: '#0c0a09', border: '1px dashed #292524', borderRadius: 8, fontSize: 11, color: '#78716c', lineHeight: 1.6 }}>
        <b style={{ color: '#a8a29e' }}>How this hub works:</b> Drafts come from <code style={{ color: '#a8a29e' }}>outreach_queue</code> — Justin's AI auto-drafts the intro + each cadence-day follow-up the moment a deal is queued. You review + send. Replies surface from <code style={{ color: '#a8a29e' }}>messages_outbound</code> where direction='inbound' and read_by_team_at is null. Realtime — new replies pop in without refresh. Once Lauren intake-and-classify lands (Justin), some replies will auto-escalate or auto-draft responses for your review.
      </div>
    </div>
  );
}

// SectionHeader helper for OutreachView (matches ReportsView's pattern)
const SectionHeader = ({ icon, label, sub }) => (
  <div style={{ marginBottom: 12, marginTop: 4 }}>
    <div style={{ fontSize: 11, fontWeight: 700, color: "#78716c", letterSpacing: "0.12em", textTransform: "uppercase", display: "flex", alignItems: "center", gap: 8 }}>
      <span>{icon}</span>{label}
    </div>
    {sub && <div style={{ fontSize: 12, color: "#a8a29e", marginTop: 4, lineHeight: 1.5 }}>{sub}</div>}
  </div>
);

// ─── Leads (click-to-text outreach via personalized_links) ─────────
// Top-level view managing personalized_links rows. Three sub-tabs:
// Ready (has phone, untexted) / Texted / All. Each row shows lead +
// case info + a "Text [first] →" button that opens an sms: deep link
// with the personalized URL pre-filled, then marks texted_at so the
// row drops off Ready. Castle populates rows automatically; manual
// entry form at top of Ready handles ad-hoc adds.
//
// Distinct from LeadsModal (intake-form `leads` table). This view
// is `personalized_links` only.
function LeadsOutreachView() {
  const [status, setStatus] = useState('ready');
  const [rows, setRows] = useState([]);
  const [counts, setCounts] = useState({ ready: 0, texted: 0, all: 0 });
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [showManual, setShowManual] = useState(false);
  const [createdToken, setCreatedToken] = useState(null);
  const [copied, setCopied] = useState(false);
  const alive = useAliveRef();
  const PAGE = 50;

  const fmtMoney = (n) => n == null ? '—' : (Number(n) >= 1000 ? `$${Math.round(Number(n)/1000)}k` : `$${Number(n).toLocaleString()}`);
  const fmtPhone = (p) => {
    if (!p) return '—';
    const d = String(p).replace(/\D/g, '');
    if (d.length === 10) return `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}`;
    if (d.length === 11 && d[0] === '1') return `(${d.slice(1,4)}) ${d.slice(4,7)}-${d.slice(7)}`;
    return p;
  };
  const fmtRel = (iso) => {
    if (!iso) return '—';
    const sec = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    if (sec < 60) return `${sec}s ago`;
    if (sec < 3600) return `${Math.round(sec/60)}m ago`;
    if (sec < 86400) return `${Math.round(sec/3600)}h ago`;
    if (sec < 86400 * 7) return `${Math.round(sec/86400)}d ago`;
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };
  const smsHref = (row) => {
    if (!row.phone) return '';
    const d = String(row.phone).replace(/\D/g, '');
    const phone = d.length === 10 ? `+1${d}` : `+${d}`;
    const first = (row.first_name || '').trim();
    const addr = (row.property_address || '').split(',')[0].trim();
    const county = (row.county || '').trim();
    const lo = row.estimated_surplus_low, hi = row.estimated_surplus_high;
    const mid = (lo != null && hi != null) ? Math.round(((Number(lo) + Number(hi)) / 2) / 1000) : null;
    const body = `Hi${first ? ' ' + first : ''} — Nathan with RefundLocators. ${county || 'Your'} County may be holding ` +
      (mid ? `~$${mid}k` : 'surplus funds') +
      ` from your ${addr || 'former'} sale. Details: refundlocators.com/s/${row.token}`;
    // Note: leading '&' before body= is required for iOS iMessage compatibility.
    return `sms:${phone}&body=${encodeURIComponent(body)}`;
  };

  const COLS = 'token, first_name, last_name, phone, property_address, county, sale_date, sale_price, judgment_amount, estimated_surplus_low, estimated_surplus_high, case_number, source, created_at, texted_at, first_viewed_at, last_viewed_at, view_count, responded_at, claim_submitted_at';

  const loadCounts = React.useCallback(async () => {
    const [a, r, t] = await Promise.all([
      sb.from('personalized_links').select('token', { count: 'exact', head: true }).not('phone', 'is', null),
      sb.from('personalized_links').select('token', { count: 'exact', head: true }).not('phone', 'is', null).is('texted_at', null),
      sb.from('personalized_links').select('token', { count: 'exact', head: true }).not('phone', 'is', null).not('texted_at', 'is', null),
    ]);
    if (!alive.current) return;
    setCounts({ all: a.count || 0, ready: r.count || 0, texted: t.count || 0 });
  }, [alive]);

  const loadRows = React.useCallback(async () => {
    setLoading(true);
    let q = sb.from('personalized_links')
      .select(COLS, { count: 'exact' })
      .not('phone', 'is', null)
      .order('created_at', { ascending: false })
      .range(offset, offset + PAGE - 1);
    if (status === 'ready') q = q.is('texted_at', null);
    if (status === 'texted') q = q.not('texted_at', 'is', null);
    const { data, count } = await q;
    if (!alive.current) return;
    setRows(data || []);
    setTotal(count || 0);
    setLoading(false);
  }, [status, offset, alive]);

  useEffect(() => { loadRows(); }, [loadRows]);
  useEffect(() => { loadCounts(); }, [loadCounts]);

  const markTexted = async (token) => {
    await sb.from('personalized_links').update({ texted_at: new Date().toISOString() }).eq('token', token);
    if (status === 'ready') setRows(prev => prev.filter(r => r.token !== token));
    loadCounts();
  };
  const resetTexted = async (token) => {
    await sb.from('personalized_links').update({ texted_at: null }).eq('token', token);
    loadRows(); loadCounts();
  };
  const onTextClick = (row) => {
    const href = smsHref(row);
    if (!href) return;
    window.location.href = href;
    setTimeout(() => markTexted(row.token), 1500);
  };

  const copyUrl = async () => {
    if (!createdToken) return;
    try {
      await navigator.clipboard.writeText(`https://refundlocators.com/s/${createdToken}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) { /* clipboard blocked */ }
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE));
  const page = Math.floor(offset / PAGE) + 1;

  return (
    <div>
      <div style={{ marginBottom: 18 }}>
        <h2 style={{ fontSize: 22, fontWeight: 700, color: '#fafaf9', margin: 0, display: 'inline-flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          📨 Leads
          <span style={{ fontSize: 12, fontWeight: 400, color: '#a8a29e' }}>· click-to-text personalized URLs</span>
        </h2>
      </div>

      {/* Sub-tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 18, background: '#1c1917', borderRadius: 8, padding: 3, border: '1px solid #292524', width: 'fit-content' }}>
        {[['ready', 'Ready', counts.ready], ['texted', 'Texted', counts.texted], ['all', 'All', counts.all]].map(([k, label, c]) => (
          <button key={k} onClick={() => { setStatus(k); setOffset(0); }} style={{
            background: status === k ? '#292524' : 'transparent',
            color: status === k ? '#fafaf9' : '#78716c',
            border: status === k ? '1px solid #44403c' : '1px solid transparent',
            padding: '6px 14px', borderRadius: 6, fontSize: 12, fontWeight: status === k ? 700 : 500,
            cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 8, fontFamily: 'inherit',
          }}>
            {label}
            <span style={{ fontSize: 10, color: status === k ? '#d97706' : '#57534e', fontFamily: "'DM Mono', monospace" }}>{c.toLocaleString()}</span>
          </button>
        ))}
      </div>

      {/* Manual create — only on Ready */}
      {status === 'ready' && (
        <div style={{ marginBottom: 18 }}>
          {!showManual ? (
            <button onClick={() => setShowManual(true)} style={{ ...btnGhost, fontSize: 12 }}>＋ Manually add a lead</button>
          ) : (
            <ManualLeadForm onCancel={() => setShowManual(false)} onCreated={(token) => { setCreatedToken(token); setShowManual(false); loadRows(); loadCounts(); }} />
          )}
          {createdToken && (
            <div style={{ marginTop: 10, padding: '10px 14px', background: 'rgba(16,185,129,0.08)', border: '1px solid #064e3b', borderRadius: 8, display: 'flex', alignItems: 'center', gap: 12, justifyContent: 'space-between', flexWrap: 'wrap' }}>
              <div style={{ fontSize: 12, color: '#6ee7b7' }}>
                ✓ Lead created. URL: <code style={{ background: '#0c0a09', padding: '1px 6px', borderRadius: 4, fontFamily: "'DM Mono', monospace", color: '#fafaf9' }}>refundlocators.com/s/{createdToken}</code>
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button onClick={copyUrl} style={{ ...btnGhost, fontSize: 11 }}>{copied ? '✓ Copied' : 'Copy URL'}</button>
                <a href={`https://refundlocators.com/s/${createdToken}`} target="_blank" rel="noopener noreferrer" style={{ ...btnGhost, fontSize: 11, textDecoration: 'none', display: 'inline-block' }}>Preview ↗</a>
                <button onClick={() => setCreatedToken(null)} style={{ ...btnGhost, fontSize: 11 }}>Dismiss</button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Loading / empty / list */}
      {loading && <div style={{ padding: 60, textAlign: 'center', color: '#78716c', fontSize: 13 }}>Loading…</div>}

      {!loading && rows.length === 0 && (
        <div style={{ padding: '60px 24px', textAlign: 'center', color: '#a8a29e', fontSize: 13, lineHeight: 1.6, maxWidth: 480, margin: '0 auto' }}>
          {status === 'ready' && <><b style={{ color: '#fafaf9', display: 'block', marginBottom: 6 }}>No leads ready to text.</b>Once Castle writes rows to <code style={{ background: '#1c1917', padding: '1px 6px', borderRadius: 3, fontFamily: "'DM Mono', monospace", fontSize: 11 }}>personalized_links</code> with phone numbers populated, they'll appear here.</>}
          {status === 'texted' && 'Nothing texted yet — go send some.'}
          {status === 'all' && 'No leads with phone numbers in the database.'}
        </div>
      )}

      {!loading && rows.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {rows.map(row => (
            <div key={row.token} style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 18, alignItems: 'center', padding: '14px 18px', background: '#1c1917', border: '1px solid #292524', borderRadius: 10 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: '#fafaf9', display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
                  {(row.first_name || '—') + ' ' + (row.last_name || '')}
                  {row.claim_submitted_at && <span style={{ fontSize: 9, fontWeight: 700, padding: '2px 7px', borderRadius: 10, background: 'rgba(16,185,129,0.18)', color: '#10b981', letterSpacing: '0.05em', textTransform: 'uppercase' }}>✓ submitted claim</span>}
                  {row.responded_at && !row.claim_submitted_at && <span style={{ fontSize: 9, fontWeight: 700, padding: '2px 7px', borderRadius: 10, background: 'rgba(217,119,6,0.18)', color: '#fbbf24', letterSpacing: '0.05em', textTransform: 'uppercase' }}>responded</span>}
                  {row.first_viewed_at && !row.responded_at && <span style={{ fontSize: 9, fontWeight: 700, padding: '2px 7px', borderRadius: 10, background: 'rgba(78,164,255,0.15)', color: '#93c5fd', letterSpacing: '0.05em', textTransform: 'uppercase' }}>viewed {row.view_count || 1}×</span>}
                </div>
                <div style={{ fontSize: 12, color: '#a8a29e', marginBottom: 6 }}>{row.property_address || '—'}</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, fontSize: 11, color: '#78716c', fontFamily: "'DM Mono', monospace", marginBottom: 4 }}>
                  <span><span style={{ color: '#57534e', fontSize: 9, letterSpacing: '0.06em', textTransform: 'uppercase', marginRight: 5 }}>County</span>{row.county || '—'}</span>
                  <span><span style={{ color: '#57534e', fontSize: 9, letterSpacing: '0.06em', textTransform: 'uppercase', marginRight: 5 }}>Surplus</span>{fmtMoney(row.estimated_surplus_low)}–{fmtMoney(row.estimated_surplus_high)}</span>
                  <span><span style={{ color: '#57534e', fontSize: 9, letterSpacing: '0.06em', textTransform: 'uppercase', marginRight: 5 }}>Phone</span>{fmtPhone(row.phone)}</span>
                  <span><span style={{ color: '#57534e', fontSize: 9, letterSpacing: '0.06em', textTransform: 'uppercase', marginRight: 5 }}>Case</span>{row.case_number || '—'}</span>
                </div>
                <div style={{ fontSize: 10, color: '#57534e', fontFamily: "'DM Mono', monospace" }}>
                  Castle picked up {fmtRel(row.created_at)}
                  {row.texted_at && <> · texted {fmtRel(row.texted_at)}</>}
                  {row.first_viewed_at && <> · first viewed {fmtRel(row.first_viewed_at)}</>}
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 6, minWidth: 140 }}>
                <a href={`https://refundlocators.com/s/${row.token}`} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11, color: '#a8a29e', textDecoration: 'none', textAlign: 'center', padding: '5px 10px', borderRadius: 6, border: '1px solid #292524' }} title="Preview the page they'll see">
                  preview ↗
                </a>
                {row.texted_at ? (
                  <button onClick={() => resetTexted(row.token)} style={{ ...btnGhost, fontSize: 11 }} title="Bring this lead back to the Ready queue">reset</button>
                ) : (
                  <button onClick={() => onTextClick(row)} disabled={!row.phone} style={{ background: '#d97706', color: '#0c0a09', border: 0, padding: '10px 16px', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap', fontFamily: 'inherit' }}>
                    Text {row.first_name || 'lead'} →
                  </button>
                )}
              </div>
            </div>
          ))}

          {total > PAGE && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 4px', gap: 12 }}>
              <button onClick={() => setOffset(Math.max(0, offset - PAGE))} disabled={offset === 0} style={{ ...btnGhost, fontSize: 12, opacity: offset === 0 ? 0.4 : 1 }}>← prev</button>
              <span style={{ fontSize: 11, color: '#78716c', fontFamily: "'DM Mono', monospace" }}>page {page} / {totalPages} · {total.toLocaleString()} total</span>
              <button onClick={() => setOffset(offset + PAGE)} disabled={offset + PAGE >= total} style={{ ...btnGhost, fontSize: 12, opacity: offset + PAGE >= total ? 0.4 : 1 }}>next →</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Manual entry form for ad-hoc personalized_links rows.
// Generates an 8-char token via crypto.getRandomValues (compatible with
// the nanoid alphabet Castle uses), source='dcc-manual', expires_at=+90d.
function ManualLeadForm({ onCancel, onCreated }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [first, setFirst] = useState('');
  const [last, setLast] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [county, setCounty] = useState('');
  const [saleDate, setSaleDate] = useState('');
  const [salePrice, setSalePrice] = useState('');
  const [judgment, setJudgment] = useState('');
  const [low, setLow] = useState('');
  const [high, setHigh] = useState('');
  const [caseNum, setCaseNum] = useState('');
  const [showOpt, setShowOpt] = useState(false);

  const nanoid8 = () => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const arr = new Uint8Array(8);
    crypto.getRandomValues(arr);
    let id = '';
    for (let i = 0; i < 8; i++) id += alphabet[arr[i] % alphabet.length];
    return id;
  };

  const submit = async () => {
    setErr(null);
    if (!first.trim() || !last.trim() || !phone.trim() || !address.trim() || !county.trim()) {
      setErr('First name, last name, phone, property address, and county are all required.');
      return;
    }
    const phoneClean = phone.replace(/\D/g, '');
    if (phoneClean.length < 10) { setErr('Phone needs at least 10 digits.'); return; }
    setBusy(true);
    const token = nanoid8();
    const e164 = phoneClean.length === 10 ? `+1${phoneClean}` : phoneClean.length === 11 && phoneClean[0] === '1' ? `+${phoneClean}` : `+${phoneClean}`;
    const row = {
      token,
      first_name: first.trim(),
      last_name: last.trim(),
      phone: e164,
      property_address: address.trim(),
      county: county.trim(),
      source: 'dcc-manual',
      expires_at: new Date(Date.now() + 90 * 86400 * 1000).toISOString(),
    };
    if (saleDate)            row.sale_date = saleDate;
    if (salePrice)           row.sale_price = Number(salePrice);
    if (judgment)            row.judgment_amount = Number(judgment);
    if (low)                 row.estimated_surplus_low = Number(low);
    if (high)                row.estimated_surplus_high = Number(high);
    if (caseNum.trim())      row.case_number = caseNum.trim();

    const { error } = await sb.from('personalized_links').insert(row);
    setBusy(false);
    if (error) { setErr(error.message); return; }
    onCreated(token);
  };

  const fieldLabel = { fontSize: 9, fontWeight: 700, color: '#78716c', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 4 };
  const fieldInput = { ...inputStyle, fontSize: 12, width: '100%' };

  return (
    <div style={{ padding: 16, background: '#1c1917', border: '1px solid #44403c', borderRadius: 10 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: '#fafaf9', marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>＋ Add a lead manually</span>
        <button onClick={onCancel} style={{ ...btnGhost, fontSize: 11 }}>Cancel</button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 10 }}>
        <div>
          <div style={fieldLabel}>First name *</div>
          <input value={first} onChange={e => setFirst(e.target.value)} placeholder="Jane" style={fieldInput} />
        </div>
        <div>
          <div style={fieldLabel}>Last name *</div>
          <input value={last} onChange={e => setLast(e.target.value)} placeholder="Smith" style={fieldInput} />
        </div>
        <div>
          <div style={fieldLabel}>Phone *</div>
          <input value={phone} onChange={e => setPhone(e.target.value)} placeholder="(513) 555-0100" style={fieldInput} />
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 10, marginBottom: 10 }}>
        <div>
          <div style={fieldLabel}>Property address *</div>
          <input value={address} onChange={e => setAddress(e.target.value)} placeholder="123 Main St, Cincinnati, OH" style={fieldInput} />
        </div>
        <div>
          <div style={fieldLabel}>County *</div>
          <input value={county} onChange={e => setCounty(e.target.value)} placeholder="Hamilton" style={fieldInput} />
        </div>
      </div>
      <button onClick={() => setShowOpt(s => !s)} style={{ ...btnGhost, fontSize: 11, marginBottom: 10 }}>
        {showOpt ? '− Hide case details' : '+ Add case details (optional)'}
      </button>
      {showOpt && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 12 }}>
          <div>
            <div style={fieldLabel}>Sale date</div>
            <input type="date" value={saleDate} onChange={e => setSaleDate(e.target.value)} style={fieldInput} />
          </div>
          <div>
            <div style={fieldLabel}>Sale price</div>
            <input type="number" value={salePrice} onChange={e => setSalePrice(e.target.value)} placeholder="125000" style={fieldInput} />
          </div>
          <div>
            <div style={fieldLabel}>Judgment amount</div>
            <input type="number" value={judgment} onChange={e => setJudgment(e.target.value)} placeholder="80000" style={fieldInput} />
          </div>
          <div>
            <div style={fieldLabel}>Surplus low</div>
            <input type="number" value={low} onChange={e => setLow(e.target.value)} placeholder="35000" style={fieldInput} />
          </div>
          <div>
            <div style={fieldLabel}>Surplus high</div>
            <input type="number" value={high} onChange={e => setHigh(e.target.value)} placeholder="50000" style={fieldInput} />
          </div>
          <div>
            <div style={fieldLabel}>Case number</div>
            <input value={caseNum} onChange={e => setCaseNum(e.target.value)} placeholder="A2400123" style={fieldInput} />
          </div>
        </div>
      )}
      {err && <div style={{ fontSize: 11, color: '#fca5a5', marginBottom: 10 }}>{err}</div>}
      <button onClick={submit} disabled={busy} style={{ ...btnPrimary, fontSize: 13, opacity: busy ? 0.5 : 1, padding: '8px 16px' }}>
        {busy ? 'Creating…' : 'Create lead'}
      </button>
    </div>
  );
}

// ─── Reply Inbox ────────────────────────────────────────────────
// Cross-deal "messages_outbound where direction='inbound' and not yet
// seen by the team." Oldest unread first. Click to jump to the deal's
// Comms tab. Closes Castle's gap-analysis Tier 1 #2.
function ReplyInbox({ onSelect, limit = 30 }) {
  const [rows, setRows] = useState(null);
  const alive = useAliveRef();

  const load = React.useCallback(async () => {
    const { data: msgs } = await sb.from('messages_outbound')
      .select('id, deal_id, body, from_number, created_at, read_by_team_at')
      .eq('direction', 'inbound')
      .is('read_by_team_at', null)
      .order('created_at', { ascending: true })
      .limit(limit);
    if (!alive.current) return;
    if (!msgs || msgs.length === 0) { setRows([]); return; }
    const dealIds = [...new Set(msgs.map(m => m.deal_id).filter(Boolean))];
    const { data: deals } = dealIds.length > 0
      ? await sb.from('deals').select('id, name, status, lead_tier').in('id', dealIds)
      : { data: [] };
    if (!alive.current) return;
    const dealsById = Object.fromEntries((deals || []).map(d => [d.id, d]));
    setRows(msgs.map(m => ({ ...m, deal: dealsById[m.deal_id] || null })));
  }, [limit, alive]);

  const loadRef = useRef(load); loadRef.current = load;
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const ch = sb.channel('reply-inbox')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'messages_outbound' }, () => loadRef.current())
      .subscribe();
    return () => { sb.removeChannel(ch); };
  }, []);

  const markSeen = async (id) => {
    await sb.from('messages_outbound').update({ read_by_team_at: new Date().toISOString() }).eq('id', id);
    await load();
  };

  if (rows === null) return <div style={{ fontSize: 12, color: '#78716c', padding: 18 }}>Loading…</div>;
  if (rows.length === 0) return (
    <div style={{ fontSize: 12, color: '#78716c', padding: 18, border: '1px dashed #292524', borderRadius: 8, textAlign: 'center' }}>
      All caught up. Inbound replies will appear here in real time.
    </div>
  );

  const fmtAge = (iso) => {
    const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + 'm ago';
    if (m < 1440) return (m / 60).toFixed(1) + 'h ago';
    return Math.floor(m / 1440) + 'd ago';
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {rows.map(r => (
        <div key={r.id}
          style={{ background: '#0c0a09', border: '1px solid #292524', borderLeft: '3px solid #3b82f6', borderRadius: 7, padding: '10px 12px' }}>
          <div onClick={() => r.deal && onSelect && onSelect(r.deal.id)} style={{ cursor: r.deal ? 'pointer' : 'default' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: '#fafaf9', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
                {r.deal?.name || r.from_number || 'Unknown sender'}
                {r.deal?.lead_tier && <span style={{ fontSize: 10, fontWeight: 700, background: '#78350f', color: '#fbbf24', padding: '1px 6px', borderRadius: 3, marginLeft: 6, letterSpacing: '0.05em' }}>TIER {r.deal.lead_tier}</span>}
              </span>
              <span style={{ fontSize: 10, color: '#a8a29e', fontFamily: "'DM Mono', monospace", flexShrink: 0 }}>{fmtAge(r.created_at)}</span>
            </div>
            <div style={{ fontSize: 12, color: '#d6d3d1', lineHeight: 1.45, fontStyle: 'italic', overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
              "{r.body}"
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
            {r.deal && (
              <button onClick={() => onSelect && onSelect(r.deal.id)}
                style={{ ...btnGhost, fontSize: 10, padding: '3px 9px' }}>Open Comms →</button>
            )}
            <button onClick={() => markSeen(r.id)}
              style={{ ...btnGhost, fontSize: 10, padding: '3px 9px', color: '#a8a29e' }}>Mark seen</button>
            {r.from_number && (
              <span style={{ fontSize: 10, color: '#57534e', alignSelf: 'center', marginLeft: 'auto', fontFamily: "'DM Mono', monospace" }}>{r.from_number}</span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function AttentionView({ deals, onSelect }) {
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState([]);
  const [clearing, setClearing] = useState(null); // null | 'all' | <deal_id>

  // Hoist the user id so the clear handlers can upsert user_deal_views.
  const [userId, setUserId] = useState(null);
  useEffect(() => {
    sb.auth.getUser().then(({ data }) => setUserId(data?.user?.id || null));
  }, []);

  const load = React.useCallback(async () => {
      setLoading(true);
      const ARCHIVE = new Set(['closed', 'recovered', 'dead']);
      const active = deals.filter(d => !ARCHIVE.has(d.status));
      if (active.length === 0) { setRows([]); setLoading(false); return; }
      const ids = active.map(d => d.id);

      // Pull everything we need in parallel. Using per-deal grouping below.
      const [docketUnack, inboundSms, allCalls, inboundEmail, pendingDrafts] = await Promise.all([
        sb.from('docket_events').select('id, deal_id, event_type, description, event_date, received_at').in('deal_id', ids).eq('is_backfill', false).is('acknowledged_at', null),
        sb.from('messages_outbound').select('id, deal_id, body, from_number, created_at').in('deal_id', ids).eq('direction', 'inbound').order('created_at', { ascending: false }).limit(500),
        sb.from('call_logs').select('id, deal_id, direction, status, started_at, duration_seconds').in('deal_id', ids).order('started_at', { ascending: false }).limit(500),
        sb.from('emails').select('id, deal_id, subject, from_email, created_at').in('deal_id', ids).eq('direction', 'inbound').order('created_at', { ascending: false }).limit(500),
        sb.from('outreach_queue').select('id, deal_id, cadence_day, status, scheduled_for, draft_body').in('deal_id', ids).in('status', ['queued', 'generating', 'pending']),
      ]);

      // Use user_deal_views to know what's been seen per tab. For the
      // Attention dashboard we don't want already-acknowledged items (for
      // docket) or already-seen comms — so we subtract the user's seen time.
      const { data: views } = await sb.from('user_deal_views').select('deal_id, tab, last_seen_at');
      const seenByDeal = new Map();
      (views || []).forEach(v => {
        const cur = seenByDeal.get(v.deal_id) || {};
        cur[v.tab] = v.last_seen_at;
        seenByDeal.set(v.deal_id, cur);
      });

      const perDeal = new Map();
      for (const d of active) {
        const seen = seenByDeal.get(d.id) || {};
        const commsSince = seen.comms || '1970-01-01T00:00:00Z';
        perDeal.set(d.id, {
          deal: d,
          docket: (docketUnack.data || []).filter(r => r.deal_id === d.id),
          sms_unread: (inboundSms.data || []).filter(r => r.deal_id === d.id && new Date(r.created_at) > new Date(commsSince)),
          calls_unread: (allCalls.data || []).filter(r => r.deal_id === d.id && new Date(r.started_at) > new Date(commsSince)),
          emails_unread: (inboundEmail.data || []).filter(r => r.deal_id === d.id && new Date(r.created_at) > new Date(commsSince)),
          drafts_pending: (pendingDrafts.data || []).filter(r => r.deal_id === d.id),
        });
      }

      const list = [...perDeal.values()]
        .map(r => {
          const total = r.docket.length + r.sms_unread.length + r.calls_unread.length + r.emails_unread.length + r.drafts_pending.length;
          return { ...r, total };
        })
        .filter(r => r.total > 0)
        .sort((a, b) => b.total - a.total);
      setRows(list);
      setLoading(false);
  }, [deals]);

  useEffect(() => { load(); }, [load]);

  // Clear one deal — marks Comms + Docket seen-now for the current user and
  // acknowledges all un-acked docket events on that deal. Does NOT touch
  // pending outreach drafts; those clear only when Nathan sends or skips.
  const clearDeal = async (dealId, unackDocketIds) => {
    if (!userId || clearing) return;
    setClearing(dealId);
    const now = new Date().toISOString();
    try {
      await sb.from('user_deal_views').upsert([
        { user_id: userId, deal_id: dealId, tab: 'comms',  last_seen_at: now },
        { user_id: userId, deal_id: dealId, tab: 'docket', last_seen_at: now },
      ], { onConflict: 'user_id,deal_id,tab' });
      if (unackDocketIds && unackDocketIds.length > 0) {
        await Promise.all(unackDocketIds.map(id =>
          sb.rpc('acknowledge_docket_event', { p_event_id: id })
        ));
      }
      await load();
    } finally {
      setClearing(null);
    }
  };

  const clearAll = async () => {
    if (!userId || clearing || rows.length === 0) return;
    if (!window.confirm(`Mark everything seen across ${rows.length} deal${rows.length === 1 ? '' : 's'}? Pending outreach drafts are NOT cleared — those still need send or skip.`)) return;
    setClearing('all');
    const now = new Date().toISOString();
    const views = rows.flatMap(r => [
      { user_id: userId, deal_id: r.deal.id, tab: 'comms',  last_seen_at: now },
      { user_id: userId, deal_id: r.deal.id, tab: 'docket', last_seen_at: now },
    ]);
    const docketIds = rows.flatMap(r => r.docket.map(d => d.id));
    try {
      if (views.length > 0) await sb.from('user_deal_views').upsert(views, { onConflict: 'user_id,deal_id,tab' });
      if (docketIds.length > 0) await Promise.all(docketIds.map(id =>
        sb.rpc('acknowledge_docket_event', { p_event_id: id })
      ));
      await load();
    } finally {
      setClearing(null);
    }
  };

  if (loading) return <div style={{ textAlign: 'center', padding: 40, color: '#78716c' }}>Loading…</div>;

  const totalAll = rows.reduce((s, r) => s + r.total, 0);
  const totalDraftsOnly = rows.reduce((s, r) => s + (r.total === r.drafts_pending.length ? r.drafts_pending.length : 0), 0);

  // Can we show a meaningful "Mark all seen" button? Only if there are
  // any un-acked docket items OR unread comms. Drafts are not covered by it.
  const clearableCount = rows.reduce((s, r) => s + r.docket.length + r.sms_unread.length + r.calls_unread.length + r.emails_unread.length, 0);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
          <h2 style={{ fontSize: 22, fontWeight: 700, color: '#fafaf9', margin: 0 }}>🔔 Attention</h2>
          <div style={{ fontSize: 12, color: '#a8a29e' }}>
            {totalAll === 0 ? 'Nothing needs attention across your active deals right now.' : `${totalAll} item${totalAll === 1 ? '' : 's'} across ${rows.length} deal${rows.length === 1 ? '' : 's'}`}
          </div>
        </div>
        {clearableCount > 0 && (
          <button
            onClick={clearAll}
            disabled={clearing !== null}
            title="Mark everything (Comms + Docket) seen across all deals. Pending outreach drafts stay — those still need to be sent or skipped."
            style={{
              background: clearing === 'all' ? '#292524' : '#78350f',
              color: '#fbbf24',
              border: '1px solid #92400e',
              padding: '6px 14px',
              borderRadius: 6, fontSize: 12, fontWeight: 700,
              cursor: clearing ? 'wait' : 'pointer',
              letterSpacing: '0.06em',
              fontFamily: 'inherit',
            }}>
            {clearing === 'all' ? '⏳ Clearing…' : `✓ Mark all ${clearableCount} seen`}
          </button>
        )}
      </div>

      <ScraperAlertStrip />
      <DeadlineAlertStrip onSelect={onSelect} />

      {rows.length === 0 && (
        <div style={{ padding: 40, textAlign: 'center', color: '#78716c', border: '1px dashed #292524', borderRadius: 10, fontSize: 14 }}>
          All clear. No unread Comms, no un-acknowledged docket events, no pending outreach drafts.
        </div>
      )}

      {rows.map(r => {
        const parts = [];
        if (r.docket.length > 0)         parts.push({ label: `⚖ ${r.docket.length} docket`,           tab: 'docket', color: '#f59e0b' });
        if (r.sms_unread.length > 0)     parts.push({ label: `💬 ${r.sms_unread.length} SMS`,          tab: 'comms',  color: '#3b82f6' });
        if (r.calls_unread.length > 0)   parts.push({ label: `📞 ${r.calls_unread.length} call${r.calls_unread.length === 1 ? '' : 's'}`, tab: 'comms', color: '#8b5cf6' });
        if (r.emails_unread.length > 0)  parts.push({ label: `📧 ${r.emails_unread.length} email${r.emails_unread.length === 1 ? '' : 's'}`, tab: 'comms', color: '#06b6d4' });
        if (r.drafts_pending.length > 0) parts.push({ label: `📝 ${r.drafts_pending.length} draft${r.drafts_pending.length === 1 ? '' : 's'}`, tab: 'comms', color: '#22c55e' });

        const rowHasClearable = r.docket.length + r.sms_unread.length + r.calls_unread.length + r.emails_unread.length > 0;
        const isClearingThis = clearing === r.deal.id;
        return (
          <div key={r.deal.id}
            style={{ padding: "12px 14px", marginBottom: 8, background: "#0c0a09", border: "1px solid #292524", borderLeft: "3px solid #d97706", borderRadius: 8, display: "flex", alignItems: "center", gap: 14 }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: '#d97706', fontFamily: "'DM Mono', monospace", minWidth: 32, textAlign: "center" }}>{r.total}</div>
            <div style={{ flex: 1, minWidth: 0, cursor: 'pointer' }} onClick={() => onSelect(r.deal.id)}>
              <div style={{ fontSize: 14, fontWeight: 700, color: '#fafaf9', marginBottom: 3 }}>
                {r.deal.name || r.deal.id}
                <span style={{ fontSize: 11, fontWeight: 400, color: '#78716c', marginLeft: 8 }}>· {r.deal.status}</span>
                {r.deal.lead_tier && <span style={{ fontSize: 10, fontWeight: 700, background: '#78350f', color: '#fbbf24', padding: '1px 6px', borderRadius: 3, marginLeft: 6, letterSpacing: '0.05em' }}>TIER {r.deal.lead_tier}</span>}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {parts.map(p => (
                  <span key={p.label} style={{ fontSize: 10, fontWeight: 600, color: p.color, background: p.color + '1a', padding: '2px 8px', borderRadius: 4, letterSpacing: '0.04em' }}>{p.label}</span>
                ))}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
              {rowHasClearable && (
                <button
                  onClick={(e) => { e.stopPropagation(); clearDeal(r.deal.id, r.docket.map(d => d.id)); }}
                  disabled={clearing !== null}
                  title="Mark Comms + Docket seen for this deal. Pending drafts (if any) stay."
                  style={{ background: "transparent", border: "1px solid #292524", color: '#a8a29e', borderRadius: 5, padding: "4px 9px", fontSize: 10, fontWeight: 600, cursor: clearing ? 'wait' : 'pointer', letterSpacing: '0.04em', fontFamily: 'inherit' }}>
                  {isClearingThis ? '⏳' : '✓ Clear'}
                </button>
              )}
              <button onClick={() => onSelect(r.deal.id)}
                style={{ background: "transparent", border: "none", color: '#78716c', fontSize: 11, cursor: 'pointer', padding: '4px 4px', fontFamily: 'inherit' }}>
                Open →
              </button>
            </div>
          </div>
        );
      })}

      <div style={{ marginTop: 24, padding: 14, background: '#0c0a09', border: '1px dashed #292524', borderRadius: 8, fontSize: 11, color: '#78716c', lineHeight: 1.6 }}>
        <b style={{ color: '#a8a29e' }}>How this works:</b> counts reflect per-user unread state. Opening a deal's Comms tab marks all Comms items seen for you; same for Docket. Justin's reads don't mark items seen for you, and vice versa. Docket items also clear when someone clicks Acknowledge on them. Pending drafts are from Justin's outreach_queue and clear when you send or skip from the AutomationsQueue on Today.
      </div>
    </div>
  );
}

function ReportsView({ deals, onSelect }) {
  const [loading, setLoading] = useState(true);
  const [scrapeRuns, setScrapeRuns] = useState([]);
  const [docketLive7d, setDocketLive7d] = useState(0);
  const [docketLive30d, setDocketLive30d] = useState(0);
  const [unmatchedCount, setUnmatchedCount] = useState(0);
  const [activityByDay, setActivityByDay] = useState([]);
  const [taskStats, setTaskStats] = useState({ open: 0, done: 0, overdue: 0 });
  const [leadsLast90, setLeadsLast90] = useState([]);
  const [clientSignedIn, setClientSignedIn] = useState(0);
  const [clientTotal, setClientTotal] = useState(0);

  useEffect(() => {
    const load = async () => {
      const now = Date.now();
      const since7 = new Date(now - 7 * 86400000).toISOString();
      const since14 = new Date(now - 14 * 86400000).toISOString();
      const since30 = new Date(now - 30 * 86400000).toISOString();
      const since90 = new Date(now - 90 * 86400000).toISOString();

      const [runsRes, dock7Res, dock30Res, unmRes, actRes, tasksRes, leadsRes, clientRes] = await Promise.all([
        sb.from('scrape_runs').select('*').order('started_at', { ascending: false }).limit(30),
        sb.from('docket_events').select('id', { count: 'exact', head: true }).eq('is_backfill', false).gte('received_at', since7),
        sb.from('docket_events').select('id', { count: 'exact', head: true }).eq('is_backfill', false).gte('received_at', since30),
        sb.from('docket_events_unmatched').select('id', { count: 'exact', head: true }),
        sb.from('activity').select('created_at').gte('created_at', since14),
        sb.from('tasks').select('done, due_date'),
        sb.from('leads').select('created_at, status, metadata').gte('created_at', since90),
        sb.from('client_access').select('user_id, last_seen_at, enabled').eq('enabled', true),
      ]);

      setScrapeRuns(runsRes.data || []);
      setDocketLive7d(dock7Res.count || 0);
      setDocketLive30d(dock30Res.count || 0);
      setUnmatchedCount(unmRes.count || 0);

      // Activity per day, last 14 days
      const buckets = {};
      for (let i = 13; i >= 0; i--) {
        const d = new Date(now - i * 86400000);
        buckets[d.toISOString().slice(0, 10)] = 0;
      }
      (actRes.data || []).forEach(a => {
        const key = (a.created_at || '').slice(0, 10);
        if (buckets[key] !== undefined) buckets[key]++;
      });
      setActivityByDay(Object.entries(buckets).map(([date, count]) => ({ date, count })));

      const nowDate = new Date().toISOString().slice(0, 10);
      const allTasks = tasksRes.data || [];
      setTaskStats({
        open: allTasks.filter(t => !t.done).length,
        done: allTasks.filter(t => t.done).length,
        overdue: allTasks.filter(t => !t.done && t.due_date && t.due_date < nowDate).length,
      });

      setLeadsLast90(leadsRes.data || []);

      const clients = clientRes.data || [];
      setClientTotal(clients.length);
      setClientSignedIn(clients.filter(c => c.user_id && c.last_seen_at).length);

      setLoading(false);
    };
    load();
  }, []);

  const SectionHeader = ({ icon, label, sub }) => (
    <div style={{ marginBottom: 12, marginTop: 24 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: "#78716c", letterSpacing: "0.12em", textTransform: "uppercase", display: "flex", alignItems: "center", gap: 8 }}>
        <span>{icon}</span>{label}
      </div>
      {sub && <div style={{ fontSize: 12, color: "#a8a29e", marginTop: 4 }}>{sub}</div>}
    </div>
  );

  const ARCHIVE = ['closed', 'recovered', 'dead'];
  const active = deals.filter(d => !ARCHIVE.includes(d.status));
  const activeSurplus = active.filter(d => d.type === 'surplus');
  const activeFlip = active.filter(d => d.type === 'flip');

  // surplus_estimate is the column Castle populates; meta.estimatedSurplus is the hand-entered one
  const dealSurplus = (d) => Number(d.surplus_estimate) || Number(d.meta?.estimatedSurplus) || 0;
  const dealFlipValue = (d) => Number(d.meta?.listPrice) || Number(d.meta?.contractPrice) || 0;

  const surplusPipeline = activeSurplus.reduce((s, d) => s + dealSurplus(d), 0);
  const flipPipeline = activeFlip.reduce((s, d) => s + dealFlipValue(d), 0);

  // ── Pipeline $ by Castle tier ──
  const TIER_ORDER = ['A', 'B', 'C', '30DTS', 'Unscored'];
  const tierGroups = { A: [], B: [], C: [], '30DTS': [], Unscored: [] };
  activeSurplus.forEach(d => {
    const key = d.lead_tier || (d.is_30dts ? '30DTS' : 'Unscored');
    (tierGroups[key] || tierGroups.Unscored).push(d);
  });
  const tierStats = TIER_ORDER.map(tier => ({
    tier,
    count: tierGroups[tier].length,
    total: tierGroups[tier].reduce((s, d) => s + dealSurplus(d), 0),
  }));
  const maxTierTotal = Math.max(1, ...tierStats.map(t => t.total));
  const tierColor = { A: '#10b981', B: '#3b82f6', C: '#a8a29e', '30DTS': '#f59e0b', Unscored: '#57534e' };

  // ── Surplus funnel with $ per stage ──
  const SURPLUS_STAGES = ['new-lead', 'lead', 'signed', 'filed', 'awaiting-distribution', 'probate', 'closed'];
  const stageStats = SURPLUS_STAGES.map(status => {
    const at = deals.filter(d => d.type === 'surplus' && d.status === status);
    return { status, count: at.length, total: at.reduce((s, d) => s + dealSurplus(d), 0) };
  });
  const maxStage = Math.max(1, ...stageStats.map(s => s.count));

  // ── Conversion metrics ──
  const signedCount = deals.filter(d => d.type === 'surplus' && !['new-lead', 'lead'].includes(d.status)).length;
  const leadCount = deals.filter(d => d.type === 'surplus' && ['new-lead', 'lead'].includes(d.status)).length;
  const totalSurplusEver = deals.filter(d => d.type === 'surplus').length;
  const closedWon = deals.filter(d => d.type === 'surplus' && d.status === 'closed').length;
  const signedRate = totalSurplusEver > 0 ? Math.round((signedCount / totalSurplusEver) * 100) : 0;
  const winRate = totalSurplusEver > 0 ? Math.round((closedWon / totalSurplusEver) * 100) : 0;

  const avgDaysCreatedToFiled = (() => {
    const filed = deals.filter(d => d.filed_at && d.created_at);
    if (!filed.length) return null;
    return Math.round(filed.reduce((s, d) => s + (new Date(d.filed_at) - new Date(d.created_at)) / 86400000, 0) / filed.length);
  })();
  const avgDaysFiledToClose = (() => {
    const closedDeals = deals.filter(d => d.closed_at && d.filed_at && d.status === 'closed');
    if (!closedDeals.length) return null;
    return Math.round(closedDeals.reduce((s, d) => s + (new Date(d.closed_at) - new Date(d.filed_at)) / 86400000, 0) / closedDeals.length);
  })();

  // ── Leads trend ──
  const leads7d = leadsLast90.filter(l => new Date(l.created_at) > new Date(Date.now() - 7 * 86400000)).length;
  const leads30d = leadsLast90.filter(l => new Date(l.created_at) > new Date(Date.now() - 30 * 86400000)).length;
  const leadsBySource = {};
  leadsLast90.forEach(l => {
    const src = l.metadata?.source || l.metadata?.utm_source || 'direct';
    leadsBySource[src] = (leadsBySource[src] || 0) + 1;
  });
  const leadSourceRows = Object.entries(leadsBySource).sort((a, b) => b[1] - a[1]).slice(0, 5);

  // ── Castle scraper health ──
  const lastRun = scrapeRuns[0];
  const runsLast7d = scrapeRuns.filter(r => r.completed_at && new Date(r.completed_at) > new Date(Date.now() - 7 * 86400000));
  const errorRuns7d = runsLast7d.filter(r => r.status === 'error').length;
  const countiesCovered = new Set(scrapeRuns.map(r => r.county).filter(Boolean));

  const maxActivity = Math.max(1, ...activityByDay.map(a => a.count));

  if (loading) {
    return <div style={{ padding: 40, textAlign: 'center', color: '#78716c' }}>Loading reports…</div>;
  }

  return (
    <div>
      {/* Top summary strip — mirrors Today's layout so it feels familiar */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12, marginBottom: 20 }}>
        <PortfolioStat label="Surplus pipeline $" value={fmt(surplusPipeline)} sub={`${activeSurplus.length} active case${activeSurplus.length === 1 ? '' : 's'}`} color="#10b981" />
        <PortfolioStat label="Flip pipeline $" value={fmt(flipPipeline)} sub={`${activeFlip.length} active flip${activeFlip.length === 1 ? '' : 's'}`} color="#3b82f6" />
        <PortfolioStat label="New leads · 30d" value={leads30d} sub={`${leads7d} this week`} color="#8b5cf6" />
        <PortfolioStat label="Open tasks" value={taskStats.open} sub={taskStats.overdue > 0 ? `${taskStats.overdue} overdue` : 'on track'} color={taskStats.overdue > 0 ? '#ef4444' : '#a8a29e'} />
        <PortfolioStat label="Live docket · 7d" value={docketLive7d} sub={`${docketLive30d} in 30d`} color="#f59e0b" />
      </div>

      <SectionHeader icon="🎯" label="Pipeline by Castle tier" sub="Surplus $ broken out by Castle's tier scoring. Unscored = Castle hasn't rated yet." />
      <div style={{ background: "#1c1917", border: "1px solid #292524", borderRadius: 10, padding: 16 }}>
        {tierStats.every(t => t.count === 0) ? (
          <div style={{ textAlign: "center", color: "#78716c", fontSize: 13, padding: 20 }}>
            No surplus deals to rank yet. As Castle scores cases, A / B / C / 30DTS tiers populate here.
          </div>
        ) : (
          tierStats.map(t => {
            const pct = Math.round((t.total / maxTierTotal) * 100);
            return (
              <div key={t.tier} style={{ marginBottom: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 5 }}>
                  <span style={{ color: "#d6d3d1", fontWeight: 600 }}>
                    <span style={{ display: "inline-block", width: 10, height: 10, background: tierColor[t.tier], borderRadius: 2, marginRight: 8, verticalAlign: "middle" }}></span>
                    Tier {t.tier}
                    <span style={{ color: "#78716c", marginLeft: 8, fontWeight: 400 }}>· {t.count} case{t.count === 1 ? '' : 's'}</span>
                  </span>
                  <span style={{ color: "#10b981", fontFamily: "'DM Mono', monospace", fontWeight: 700 }}>{fmt(t.total)}</span>
                </div>
                <div style={{ height: 8, background: "#0c0a09", borderRadius: 4, overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${pct}%`, background: tierColor[t.tier], borderRadius: 4 }}></div>
                </div>
              </div>
            );
          })
        )}
      </div>

      <SectionHeader icon="🧭" label="Surplus funnel" sub="Count + $ at each stage. Dollars = sum of surplus_estimate (Castle) or meta.estimatedSurplus (hand-entered)." />
      <div style={{ background: "#1c1917", border: "1px solid #292524", borderRadius: 10, overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={th}>Stage</th>
              <th style={{ ...th, textAlign: "right" }}>Cases</th>
              <th style={{ ...th, textAlign: "right" }}>$ in stage</th>
              <th style={th}></th>
            </tr>
          </thead>
          <tbody>
            {stageStats.map(s => {
              const pct = Math.round((s.count / maxStage) * 100);
              const color = STATUS_COLORS[s.status] || "#78716c";
              return (
                <tr key={s.status}>
                  <td style={{ ...td, color: "#fafaf9", fontWeight: 600, textTransform: "capitalize", borderBottom: "1px solid #1c1917" }}>{s.status.replace(/-/g, ' ')}</td>
                  <td style={{ ...td, textAlign: "right", color: "#d6d3d1", fontFamily: "'DM Mono', monospace", borderBottom: "1px solid #1c1917" }}>{s.count}</td>
                  <td style={{ ...td, textAlign: "right", color: s.total > 0 ? "#10b981" : "#57534e", fontFamily: "'DM Mono', monospace", fontWeight: s.total > 0 ? 700 : 400, borderBottom: "1px solid #1c1917" }}>{s.total > 0 ? fmt(s.total) : '—'}</td>
                  <td style={{ ...td, width: "40%", borderBottom: "1px solid #1c1917" }}>
                    <div style={{ height: 6, background: "#0c0a09", borderRadius: 3, overflow: "hidden" }}>
                      <div style={{ height: "100%", width: `${pct}%`, background: color, borderRadius: 3 }}></div>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginTop: 14 }}>
        <div style={{ background: "#1c1917", border: "1px solid #292524", borderRadius: 10, padding: 14 }}>
          <div style={{ fontSize: 10, color: "#78716c", letterSpacing: "0.1em", textTransform: "uppercase", fontWeight: 700 }}>Signed rate</div>
          <div style={{ fontSize: 24, fontWeight: 700, color: "#fafaf9", fontFamily: "'DM Mono', monospace", marginTop: 4 }}>{signedRate}%</div>
          <div style={{ fontSize: 11, color: "#a8a29e", marginTop: 2 }}>{signedCount} of {totalSurplusEver} surplus deals</div>
        </div>
        <div style={{ background: "#1c1917", border: "1px solid #292524", borderRadius: 10, padding: 14 }}>
          <div style={{ fontSize: 10, color: "#78716c", letterSpacing: "0.1em", textTransform: "uppercase", fontWeight: 700 }}>Win rate</div>
          <div style={{ fontSize: 24, fontWeight: 700, color: "#10b981", fontFamily: "'DM Mono', monospace", marginTop: 4 }}>{winRate}%</div>
          <div style={{ fontSize: 11, color: "#a8a29e", marginTop: 2 }}>{closedWon} closed won</div>
        </div>
        <div style={{ background: "#1c1917", border: "1px solid #292524", borderRadius: 10, padding: 14 }}>
          <div style={{ fontSize: 10, color: "#78716c", letterSpacing: "0.1em", textTransform: "uppercase", fontWeight: 700 }}>Avg days · lead → filed</div>
          <div style={{ fontSize: 24, fontWeight: 700, color: "#fafaf9", fontFamily: "'DM Mono', monospace", marginTop: 4 }}>{avgDaysCreatedToFiled != null ? avgDaysCreatedToFiled + 'd' : '—'}</div>
        </div>
        <div style={{ background: "#1c1917", border: "1px solid #292524", borderRadius: 10, padding: 14 }}>
          <div style={{ fontSize: 10, color: "#78716c", letterSpacing: "0.1em", textTransform: "uppercase", fontWeight: 700 }}>Avg days · filed → closed</div>
          <div style={{ fontSize: 24, fontWeight: 700, color: "#fafaf9", fontFamily: "'DM Mono', monospace", marginTop: 4 }}>{avgDaysFiledToClose != null ? avgDaysFiledToClose + 'd' : '—'}</div>
        </div>
      </div>

      <SectionHeader icon="🐍" label="Castle scraper health" sub="Per-agent heartbeat from v_scraper_health. Refreshes every 60 seconds." />
      <ScraperHealthPanel />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginTop: 12 }}>
        <div style={{ background: "#1c1917", border: "1px solid #292524", borderRadius: 10, padding: 14 }}>
          <div style={{ fontSize: 10, color: "#78716c", letterSpacing: "0.1em", textTransform: "uppercase", fontWeight: 700 }}>Runs · last 7d</div>
          <div style={{ fontSize: 24, fontWeight: 700, color: "#fafaf9", fontFamily: "'DM Mono', monospace", marginTop: 4 }}>{runsLast7d.length}</div>
          <div style={{ fontSize: 11, color: errorRuns7d > 0 ? "#ef4444" : "#a8a29e", marginTop: 2 }}>
            {errorRuns7d > 0 ? `${errorRuns7d} error${errorRuns7d === 1 ? '' : 's'}` : 'all healthy'}
          </div>
        </div>
        <div style={{ background: "#1c1917", border: "1px solid #292524", borderRadius: 10, padding: 14 }}>
          <div style={{ fontSize: 10, color: "#78716c", letterSpacing: "0.1em", textTransform: "uppercase", fontWeight: 700 }}>Counties covered</div>
          <div style={{ fontSize: 24, fontWeight: 700, color: "#fafaf9", fontFamily: "'DM Mono', monospace", marginTop: 4 }}>{countiesCovered.size}</div>
          <div style={{ fontSize: 11, color: "#a8a29e", marginTop: 2 }}>
            {countiesCovered.size > 0 ? Array.from(countiesCovered).join(', ').slice(0, 40) : 'none yet'}
          </div>
        </div>
        <div style={{ background: "#1c1917", border: "1px solid #292524", borderRadius: 10, padding: 14 }}>
          <div style={{ fontSize: 10, color: "#78716c", letterSpacing: "0.1em", textTransform: "uppercase", fontWeight: 700 }}>Unmatched events</div>
          <div style={{ fontSize: 24, fontWeight: 700, color: unmatchedCount > 0 ? "#f59e0b" : "#fafaf9", fontFamily: "'DM Mono', monospace", marginTop: 4 }}>{unmatchedCount}</div>
          <div style={{ fontSize: 11, color: "#a8a29e", marginTop: 2 }}>
            {unmatchedCount > 0 ? 'needs Castle-side case mapping' : 'all matched to deals'}
          </div>
        </div>
      </div>
      {scrapeRuns.length > 0 && (
        <details style={{ marginTop: 12 }}>
          <summary style={{ cursor: "pointer", fontSize: 12, color: "#a8a29e", padding: 6 }}>
            Recent scrape runs · {scrapeRuns.length}
          </summary>
          <div style={{ background: "#1c1917", border: "1px solid #292524", borderRadius: 10, overflow: "hidden", marginTop: 8 }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={th}>County</th>
                  <th style={th}>Started</th>
                  <th style={{ ...th, textAlign: "right" }}>Events</th>
                  <th style={{ ...th, textAlign: "right" }}>New</th>
                  <th style={th}>Status</th>
                </tr>
              </thead>
              <tbody>
                {scrapeRuns.slice(0, 15).map(r => (
                  <tr key={r.id}>
                    <td style={{ ...td, color: "#fafaf9", fontWeight: 600, borderBottom: "1px solid #0c0a09" }}>{r.county || '—'}</td>
                    <td style={{ ...td, color: "#a8a29e", fontSize: 12, borderBottom: "1px solid #0c0a09" }}>{r.started_at ? new Date(r.started_at).toLocaleString() : '—'}</td>
                    <td style={{ ...td, textAlign: "right", color: "#d6d3d1", fontFamily: "'DM Mono', monospace", borderBottom: "1px solid #0c0a09" }}>{r.events_found ?? 0}</td>
                    <td style={{ ...td, textAlign: "right", color: r.events_new > 0 ? "#10b981" : "#57534e", fontFamily: "'DM Mono', monospace", fontWeight: r.events_new > 0 ? 700 : 400, borderBottom: "1px solid #0c0a09" }}>{r.events_new ?? 0}</td>
                    <td style={{ ...td, color: r.status === 'ok' ? "#10b981" : r.status === 'error' ? "#ef4444" : "#a8a29e", fontWeight: 600, borderBottom: "1px solid #0c0a09" }}>{r.status || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      <SectionHeader icon="⚡" label="Ops velocity · last 14 days" sub="Activity logged per day (calls, notes, emails, status changes)." />
      <div style={{ background: "#1c1917", border: "1px solid #292524", borderRadius: 10, padding: 16 }}>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 4, height: 120 }}>
          {activityByDay.map(a => {
            const pct = (a.count / maxActivity) * 100;
            return (
              <div key={a.date} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "flex-end" }}>
                  <div title={`${a.count} activities on ${a.date}`} style={{ width: "100%", height: `${pct}%`, background: a.count > 0 ? "#3b82f6" : "#292524", borderRadius: "3px 3px 0 0", minHeight: a.count > 0 ? 3 : 1 }}></div>
                </div>
                <div style={{ fontSize: 9, color: "#57534e", fontFamily: "'DM Mono', monospace" }}>{a.date.slice(5)}</div>
              </div>
            );
          })}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginTop: 14 }}>
        <div style={{ background: "#1c1917", border: "1px solid #292524", borderRadius: 10, padding: 16 }}>
          <div style={{ fontSize: 11, color: "#78716c", letterSpacing: "0.1em", textTransform: "uppercase", fontWeight: 700, marginBottom: 10 }}>Tasks</div>
          <div style={{ display: "flex", gap: 16 }}>
            <div><div style={{ fontSize: 22, fontWeight: 700, color: "#f59e0b", fontFamily: "'DM Mono', monospace" }}>{taskStats.open}</div><div style={{ fontSize: 11, color: "#a8a29e" }}>open</div></div>
            <div><div style={{ fontSize: 22, fontWeight: 700, color: "#ef4444", fontFamily: "'DM Mono', monospace" }}>{taskStats.overdue}</div><div style={{ fontSize: 11, color: "#a8a29e" }}>overdue</div></div>
            <div><div style={{ fontSize: 22, fontWeight: 700, color: "#10b981", fontFamily: "'DM Mono', monospace" }}>{taskStats.done}</div><div style={{ fontSize: 11, color: "#a8a29e" }}>done</div></div>
          </div>
        </div>
        <div style={{ background: "#1c1917", border: "1px solid #292524", borderRadius: 10, padding: 16 }}>
          <div style={{ fontSize: 11, color: "#78716c", letterSpacing: "0.1em", textTransform: "uppercase", fontWeight: 700, marginBottom: 10 }}>Client portal engagement</div>
          <div style={{ display: "flex", gap: 16 }}>
            <div><div style={{ fontSize: 22, fontWeight: 700, color: "#fafaf9", fontFamily: "'DM Mono', monospace" }}>{clientTotal}</div><div style={{ fontSize: 11, color: "#a8a29e" }}>total invited</div></div>
            <div><div style={{ fontSize: 22, fontWeight: 700, color: "#10b981", fontFamily: "'DM Mono', monospace" }}>{clientSignedIn}</div><div style={{ fontSize: 11, color: "#a8a29e" }}>signed in</div></div>
            <div><div style={{ fontSize: 22, fontWeight: 700, color: "#f59e0b", fontFamily: "'DM Mono', monospace" }}>{clientTotal - clientSignedIn}</div><div style={{ fontSize: 11, color: "#a8a29e" }}>unactivated</div></div>
          </div>
        </div>
      </div>

      <SectionHeader icon="🧲" label="Lead intake · last 90 days" sub={`${leadsLast90.length} lead${leadsLast90.length === 1 ? '' : 's'} total · top sources`} />
      {leadsLast90.length === 0 ? (
        <div style={{ padding: 20, textAlign: "center", color: "#78716c", fontSize: 13, border: "1px dashed #292524", borderRadius: 10 }}>
          No public leads in the last 90 days. Lead intake form at lead-intake.html → Supabase public.leads.
        </div>
      ) : (
        <div style={{ background: "#1c1917", border: "1px solid #292524", borderRadius: 10, overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr><th style={th}>Source</th><th style={{ ...th, textAlign: "right" }}>Leads</th></tr>
            </thead>
            <tbody>
              {leadSourceRows.map(([src, count]) => (
                <tr key={src}>
                  <td style={{ ...td, color: "#fafaf9", fontWeight: 600, borderBottom: "1px solid #0c0a09" }}>{src}</td>
                  <td style={{ ...td, textAlign: "right", color: "#d6d3d1", fontFamily: "'DM Mono', monospace", borderBottom: "1px solid #0c0a09" }}>{count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ marginTop: 32, padding: 16, background: "#0c0a09", border: "1px dashed #292524", borderRadius: 10, fontSize: 12, color: "#78716c", lineHeight: 1.55 }}>
        <b style={{ color: "#a8a29e" }}>About these reports</b><br/>
        Live from the DB — no caching. Castle tier data fills in as the scorer runs. Activity sparkline reflects the last 14 days of Activity rows across every deal. Scraper health reads <code style={{ color: "#a8a29e" }}>v_scraper_health</code> (Castle-owned view over scraper_agents + scrape_runs). Yellow = overdue past grace; red = &gt; 2× overdue or 3+ fails in last 3h.
      </div>
    </div>
  );
}

// ─── Web Traffic View ────────────────────────────────────────────
function WebTrafficView() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [range, setRange] = useState("7d"); // "1d" | "7d" | "30d" | "all"
  const [error, setError] = useState(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    const since = range === "1d"
      ? new Date(Date.now() - 86400000).toISOString()
      : range === "7d"
        ? new Date(Date.now() - 7 * 86400000).toISOString()
        : range === "30d"
          ? new Date(Date.now() - 30 * 86400000).toISOString()
          : null;

    let q = sb.from("analytics_events").select("*").order("received_at", { ascending: false }).limit(5000);
    if (since) q = q.gte("received_at", since);

    q.then(({ data, error: err }) => {
      setLoading(false);
      if (err) { setError(err.message); return; }
      setRows(data || []);
    });
  }, [range]);

  const pageviews = rows.filter(r => r.event_type === "pageview");
  const uniqueSessions = new Set(pageviews.map(r => r.session_id).filter(Boolean)).size;

  // Today's stats (always computed within the full fetch)
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const todayViews = rows.filter(r => r.event_type === "pageview" && new Date(r.received_at) >= todayStart);
  const todaySessions = new Set(todayViews.map(r => r.session_id).filter(Boolean)).size;

  // Top pages
  const pageCounts = {};
  pageviews.forEach(r => { if (r.path) pageCounts[r.path] = (pageCounts[r.path] || 0) + 1; });
  const topPages = Object.entries(pageCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const maxPageCount = topPages[0]?.[1] || 1;

  // Top referrers
  const refCounts = {};
  pageviews.forEach(r => {
    const ref = r.referrer && r.referrer !== "" && !r.referrer.includes("refundlocators.com") ? r.referrer : "(direct)";
    const host = ref === "(direct)" ? ref : (() => { try { return new URL(ref).hostname; } catch { return ref; } })();
    refCounts[host] = (refCounts[host] || 0) + 1;
  });
  const topRefs = Object.entries(refCounts).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const maxRefCount = topRefs[0]?.[1] || 1;

  // Device breakdown
  const deviceCounts = {};
  pageviews.forEach(r => { const k = r.device_type || "unknown"; deviceCounts[k] = (deviceCounts[k] || 0) + 1; });

  // Browser breakdown
  const browserCounts = {};
  pageviews.forEach(r => { const k = r.browser || "unknown"; browserCounts[k] = (browserCounts[k] || 0) + 1; });

  // Country breakdown
  const countryCounts = {};
  pageviews.forEach(r => { const k = r.country || "unknown"; countryCounts[k] = (countryCounts[k] || 0) + 1; });
  const topCountries = Object.entries(countryCounts).sort((a, b) => b[1] - a[1]).slice(0, 8);

  // Daily sparkline (last 14 days)
  const sparkDays = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - i);
    const next = new Date(d); next.setDate(next.getDate() + 1);
    const count = rows.filter(r => r.event_type === "pageview" && new Date(r.received_at) >= d && new Date(r.received_at) < next).length;
    sparkDays.push({ label: d.toLocaleDateString("en-US", { month: "short", day: "numeric" }), count });
  }
  const maxSpark = Math.max(1, ...sparkDays.map(d => d.count));

  const rangeLabel = { "1d": "Today", "7d": "Last 7 days", "30d": "Last 30 days", "all": "All time" }[range];
  const GOLD = "#d97706";

  if (loading) return <div style={{ padding: 40, textAlign: "center", color: "#78716c" }}>Loading traffic data…</div>;
  if (error) return <div style={{ padding: 40, textAlign: "center", color: "#ef4444", fontSize: 13 }}>Error: {error}</div>;

  if (pageviews.length === 0 && !loading) return (
    <div style={{ padding: 60, textAlign: "center" }}>
      <div style={{ fontSize: 32, marginBottom: 12 }}>🌐</div>
      <div style={{ fontSize: 16, fontWeight: 700, color: "#fafaf9", marginBottom: 8 }}>No traffic data yet</div>
      <div style={{ fontSize: 13, color: "#78716c", maxWidth: 400, margin: "0 auto", lineHeight: 1.6 }}>
        Pageviews will appear here as visitors hit refundlocators.com. Data is collected automatically — no action needed.
      </div>
    </div>
  );

  return (
    <div>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <div>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", color: GOLD, marginBottom: 4 }}>refundlocators.com</div>
          <div style={{ fontSize: 22, fontWeight: 800, color: "#fafaf9", letterSpacing: "-0.03em" }}>Web Traffic</div>
        </div>
        <div style={{ display: "flex", gap: 4, background: "#1c1917", borderRadius: 6, padding: 3, border: "1px solid #292524" }}>
          {["1d","7d","30d","all"].map(r => (
            <button key={r} onClick={() => setRange(r)} style={{
              background: range === r ? "#292524" : "transparent",
              color: range === r ? "#fafaf9" : "#78716c",
              border: "none", padding: "5px 12px", borderRadius: 4, fontSize: 11, fontWeight: 600, cursor: "pointer"
            }}>{r === "1d" ? "Today" : r === "7d" ? "7d" : r === "30d" ? "30d" : "All"}</button>
          ))}
        </div>
      </div>

      {/* Stat tiles */}
      <div className="metric-grid-4" style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 24 }}>
        {[
          { label: "Pageviews", value: pageviews.length, sub: rangeLabel, color: GOLD },
          { label: "Unique Sessions", value: uniqueSessions, sub: rangeLabel, color: "#3b82f6" },
          { label: "Today's Views", value: todayViews.length, sub: "since midnight", color: "#10b981" },
          { label: "Today's Sessions", value: todaySessions, sub: "unique visitors today", color: "#8b5cf6" },
        ].map(({ label, value, sub, color }) => (
          <div key={label} className="metric-card" style={{ background: "#1c1917", border: "1px solid #292524", borderRadius: 10, padding: 16 }}>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: "#78716c", marginBottom: 8 }}>{label}</div>
            <div style={{ fontSize: 28, fontWeight: 800, color, letterSpacing: "-0.04em", marginBottom: 4, fontFamily: "'DM Mono', monospace" }}>{value.toLocaleString()}</div>
            <div style={{ fontSize: 11, color: "#57534e" }}>{sub}</div>
          </div>
        ))}
      </div>

      {/* Sparkline — daily pageviews last 14 days */}
      <SectionHeader icon="📈" label="Daily Pageviews" sub="Last 14 days" />
      <div style={{ background: "#1c1917", border: "1px solid #292524", borderRadius: 10, padding: 16, marginBottom: 24 }}>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 4, height: 80 }}>
          {sparkDays.map((d, i) => (
            <div key={i} title={`${d.label}: ${d.count} views`} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", height: "100%", justifyContent: "flex-end" }}>
              <div style={{
                width: "100%", background: GOLD, borderRadius: "2px 2px 0 0",
                height: `${Math.max(d.count > 0 ? 4 : 0, (d.count / maxSpark) * 100)}%`,
                opacity: d.count === 0 ? 0.15 : 0.85, cursor: "default",
              }} />
            </div>
          ))}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, fontSize: 9, color: "#57534e" }}>
          <span>{sparkDays[0]?.label}</span><span>{sparkDays[sparkDays.length - 1]?.label}</span>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, marginBottom: 24 }}>
        {/* Top pages */}
        <div>
          <SectionHeader icon="📄" label="Top Pages" sub={`${rangeLabel} · ${topPages.length} pages`} />
          <div style={{ background: "#1c1917", border: "1px solid #292524", borderRadius: 10, overflow: "hidden" }}>
            {topPages.length === 0 ? (
              <div style={{ padding: 20, color: "#78716c", fontSize: 12 }}>No data yet.</div>
            ) : topPages.map(([path, count]) => (
              <div key={path} style={{ padding: "10px 14px", borderBottom: "1px solid #292524" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                  <span style={{ fontSize: 12, color: "#d6d3d1", fontFamily: "'DM Mono', monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "75%" }}>{path}</span>
                  <span style={{ fontSize: 11, fontWeight: 700, color: GOLD, fontFamily: "'DM Mono', monospace", flexShrink: 0 }}>{count}</span>
                </div>
                <div style={{ height: 3, background: "#0c0a09", borderRadius: 2 }}>
                  <div style={{ height: "100%", width: `${(count / maxPageCount) * 100}%`, background: GOLD, borderRadius: 2, opacity: 0.7 }} />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Top referrers */}
        <div>
          <SectionHeader icon="🔗" label="Top Referrers" sub={`${rangeLabel} · ${topRefs.length} sources`} />
          <div style={{ background: "#1c1917", border: "1px solid #292524", borderRadius: 10, overflow: "hidden" }}>
            {topRefs.length === 0 ? (
              <div style={{ padding: 20, color: "#78716c", fontSize: 12 }}>No data yet.</div>
            ) : topRefs.map(([ref, count]) => (
              <div key={ref} style={{ padding: "10px 14px", borderBottom: "1px solid #292524" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                  <span style={{ fontSize: 12, color: "#d6d3d1", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "75%" }}>{ref}</span>
                  <span style={{ fontSize: 11, fontWeight: 700, color: "#3b82f6", fontFamily: "'DM Mono', monospace", flexShrink: 0 }}>{count}</span>
                </div>
                <div style={{ height: 3, background: "#0c0a09", borderRadius: 2 }}>
                  <div style={{ height: "100%", width: `${(count / maxRefCount) * 100}%`, background: "#3b82f6", borderRadius: 2, opacity: 0.7 }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 20, marginBottom: 24 }}>
        {/* Devices */}
        <div>
          <SectionHeader icon="📱" label="Devices" sub="" />
          <div style={{ background: "#1c1917", border: "1px solid #292524", borderRadius: 10, padding: 14 }}>
            {Object.entries(deviceCounts).sort((a, b) => b[1] - a[1]).map(([k, v]) => {
              const total = pageviews.length || 1;
              const icon = k === "mobile" ? "📱" : k === "tablet" ? "🪙" : "🖥";
              return (
                <div key={k} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                  <span style={{ fontSize: 12, color: "#d6d3d1", textTransform: "capitalize" }}>{icon} {k}</span>
                  <span style={{ fontSize: 11, fontFamily: "'DM Mono', monospace", color: "#a8a29e" }}>{Math.round((v / total) * 100)}% <span style={{ color: "#57534e" }}>({v})</span></span>
                </div>
              );
            })}
            {Object.keys(deviceCounts).length === 0 && <div style={{ color: "#78716c", fontSize: 12 }}>No data yet.</div>}
          </div>
        </div>

        {/* Browsers */}
        <div>
          <SectionHeader icon="🌍" label="Browsers" sub="" />
          <div style={{ background: "#1c1917", border: "1px solid #292524", borderRadius: 10, padding: 14 }}>
            {Object.entries(browserCounts).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => {
              const total = pageviews.length || 1;
              return (
                <div key={k} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                  <span style={{ fontSize: 12, color: "#d6d3d1" }}>{k}</span>
                  <span style={{ fontSize: 11, fontFamily: "'DM Mono', monospace", color: "#a8a29e" }}>{Math.round((v / total) * 100)}% <span style={{ color: "#57534e" }}>({v})</span></span>
                </div>
              );
            })}
            {Object.keys(browserCounts).length === 0 && <div style={{ color: "#78716c", fontSize: 12 }}>No data yet.</div>}
          </div>
        </div>

        {/* Countries */}
        <div>
          <SectionHeader icon="🗺️" label="Countries" sub="" />
          <div style={{ background: "#1c1917", border: "1px solid #292524", borderRadius: 10, padding: 14 }}>
            {topCountries.map(([k, v]) => {
              const total = pageviews.length || 1;
              return (
                <div key={k} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                  <span style={{ fontSize: 12, color: "#d6d3d1" }}>{k}</span>
                  <span style={{ fontSize: 11, fontFamily: "'DM Mono', monospace", color: "#a8a29e" }}>{Math.round((v / total) * 100)}% <span style={{ color: "#57534e" }}>({v})</span></span>
                </div>
              );
            })}
            {topCountries.length === 0 && <div style={{ color: "#78716c", fontSize: 12 }}>No data yet.</div>}
          </div>
        </div>
      </div>

      {/* Recent events feed */}
      <SectionHeader icon="⚡" label="Recent Visits" sub="Last 20 pageviews" />
      <div style={{ background: "#1c1917", border: "1px solid #292524", borderRadius: 10, overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={th}>Time</th>
              <th style={th}>Page</th>
              <th style={th}>Referrer</th>
              <th style={th}>Device</th>
              <th style={th}>Browser</th>
              <th style={th}>Country</th>
            </tr>
          </thead>
          <tbody>
            {pageviews.slice(0, 20).map((r, i) => (
              <tr key={r.id || i} style={{ borderTop: "1px solid #292524" }}>
                <td style={{ ...td, fontSize: 11, color: "#78716c", fontFamily: "'DM Mono', monospace", whiteSpace: "nowrap" }}>
                  {new Date(r.received_at).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}
                  <div style={{ fontSize: 10, color: "#44403c" }}>{new Date(r.received_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</div>
                </td>
                <td style={{ ...td, fontSize: 12, color: "#d6d3d1", fontFamily: "'DM Mono', monospace", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.path || "/"}</td>
                <td style={{ ...td, fontSize: 11, color: "#78716c", maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {r.referrer && !r.referrer.includes("refundlocators.com") ? (() => { try { return new URL(r.referrer).hostname; } catch { return r.referrer; } })() : "(direct)"}
                </td>
                <td style={{ ...td, fontSize: 11, color: "#a8a29e", textTransform: "capitalize" }}>{r.device_type || "—"}</td>
                <td style={{ ...td, fontSize: 11, color: "#a8a29e" }}>{r.browser || "—"}</td>
                <td style={{ ...td, fontSize: 11, color: "#a8a29e" }}>{r.country || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: 16, padding: 12, background: "#0c0a09", border: "1px dashed #292524", borderRadius: 8, fontSize: 11, color: "#57534e", lineHeight: 1.55 }}>
        Data collected via TrafficBeacon on refundlocators.com. Pageviews fire on every route navigation. Country data not yet available (requires future IP geolocation enrichment). Sessions are tab-scoped — refresh resets the counter.
      </div>
    </div>
  );
}

// ─── Analytics View ─────────────────────────────────────────────
function AnalyticsView({ deals, onSelect }) {
  const now = new Date();
  const ARCHIVE_STATUSES = ["closed", "recovered", "dead"];
  const active = deals.filter(d => !ARCHIVE_STATUSES.includes(d.status));
  const closed = deals.filter(d => d.status === "closed" || d.status === "recovered");

  // ── Cash Flow Forecast: next 6 months ──
  const forecast = [];
  let forecastTotal = 0;
  for (let i = 0; i < 6; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    const next = new Date(now.getFullYear(), now.getMonth() + i + 1, 1);
    const label = d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
    const paying = active.filter(x => {
      const payDate = expectedPayoutDate(x);
      return payDate && payDate >= d && payDate < next;
    });
    const revenue = paying.reduce((s, x) => s + (computeDealNet(x) || 0), 0);
    const isCurrent = i === 0;
    forecast.push({ label, revenue, dealCount: paying.length, deals: paying, isCurrent });
    forecastTotal += revenue;
  }
  const maxForecast = Math.max(1, ...forecast.map(f => f.revenue));

  // ── Monthly trend: last 6 months ──
  const months = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const next = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
    const label = d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
    const added = deals.filter(x => {
      if (!x.created) return false;
      const c = new Date(x.created);
      return c >= d && c < next;
    });
    const closedThisMonth = closed.filter(x => {
      const ts = x.closed_at ? new Date(x.closed_at) : null;
      return ts && ts >= d && ts < next;
    });
    const booked = closedThisMonth.reduce((s, x) => s + (computeDealNet(x) || 0), 0);
    months.push({ label, added: added.length, closed: closedThisMonth.length, booked });
  }
  const maxMonthValue = Math.max(1, ...months.map(m => Math.max(m.added * 1000, m.booked)));
  const maxMonthAdded = Math.max(1, ...months.map(m => m.added));
  const maxMonthBooked = Math.max(1, ...months.map(m => m.booked));

  // ── Lead Source ROI ──
  const bySource = {};
  deals.forEach(d => {
    const src = (d.meta?.lead_source || d.lead_source || "Unspecified");
    if (!bySource[src]) bySource[src] = { source: src, deals: 0, closed: 0, netTotal: 0 };
    bySource[src].deals += 1;
    if (d.status === "closed" || d.status === "recovered") {
      bySource[src].closed += 1;
      bySource[src].netTotal += (computeDealNet(d) || 0);
    }
  });
  const leadRows = Object.values(bySource)
    .map(r => ({ ...r, closeRate: r.deals > 0 ? Math.round((r.closed / r.deals) * 100) : 0, avgNet: r.closed > 0 ? r.netTotal / r.closed : 0 }))
    .sort((a, b) => b.netTotal - a.netTotal);

  // ── Attorney Performance (surplus only) ──
  const surplusDeals = deals.filter(d => d.type === "surplus");
  const byAttorney = {};
  surplusDeals.forEach(d => {
    const a = d.meta?.attorney;
    if (!a) return;
    if (!byAttorney[a]) byAttorney[a] = { attorney: a, deals: 0, recovered: 0, netTotal: 0, daysTotal: 0, daysCount: 0 };
    byAttorney[a].deals += 1;
    if (d.status === "recovered") {
      byAttorney[a].recovered += 1;
      byAttorney[a].netTotal += (computeDealNet(d) || 0);
      // Days from filed to closed
      const filed = d.meta?.filed_at || d.filed_at;
      const closedAt = d.closed_at;
      if (filed && closedAt) {
        const days = Math.floor((new Date(closedAt).getTime() - new Date(filed).getTime()) / 86400000);
        if (days > 0 && days < 730) {
          byAttorney[a].daysTotal += days;
          byAttorney[a].daysCount += 1;
        }
      }
    }
  });
  const attorneyRows = Object.values(byAttorney)
    .map(r => ({ ...r,
      recoveryRate: r.deals > 0 ? Math.round((r.recovered / r.deals) * 100) : 0,
      avgDays: r.daysCount > 0 ? Math.round(r.daysTotal / r.daysCount) : null,
      avgFee: r.recovered > 0 ? r.netTotal / r.recovered : 0,
    }))
    .sort((a, b) => b.deals - a.deals);

  // ── Per-County performance (surplus only) ──
  const byCounty = {};
  surplusDeals.forEach(d => {
    const c = d.meta?.county || "Unspecified";
    if (!byCounty[c]) byCounty[c] = { county: c, deals: 0, recovered: 0, netTotal: 0, daysTotal: 0, daysCount: 0 };
    byCounty[c].deals += 1;
    if (d.status === "recovered") {
      byCounty[c].recovered += 1;
      byCounty[c].netTotal += (computeDealNet(d) || 0);
      const filed = d.meta?.filed_at || d.filed_at;
      const closedAt = d.closed_at;
      if (filed && closedAt) {
        const days = Math.floor((new Date(closedAt).getTime() - new Date(filed).getTime()) / 86400000);
        if (days > 0 && days < 730) {
          byCounty[c].daysTotal += days;
          byCounty[c].daysCount += 1;
        }
      }
    }
  });
  const countyRows = Object.values(byCounty)
    .map(r => ({ ...r,
      recoveryRate: r.deals > 0 ? Math.round((r.recovered / r.deals) * 100) : 0,
      avgDays: r.daysCount > 0 ? Math.round(r.daysTotal / r.daysCount) : null,
    }))
    .sort((a, b) => b.deals - a.deals);

  // ── Pipeline distribution ──
  const byStatus = {};
  active.forEach(d => {
    byStatus[d.status] = (byStatus[d.status] || 0) + 1;
  });
  const statusRows = Object.entries(byStatus).sort((a, b) => b[1] - a[1]);
  const maxStatus = Math.max(1, ...Object.values(byStatus));

  // Styles
  const th = { textAlign: "left", fontSize: 10, fontWeight: 700, color: "#78716c", letterSpacing: "0.1em", textTransform: "uppercase", padding: "10px 12px", borderBottom: "1px solid #292524" };
  const td = { fontSize: 13, padding: "10px 12px", borderBottom: "1px solid #1c1917", color: "#d6d3d1" };
  const tdNum = { ...td, fontFamily: "'DM Mono', monospace", textAlign: "right", fontVariantNumeric: "tabular-nums" };

  const SectionHeader = ({ icon, label, sub }) => (
    <div style={{ marginBottom: 12, marginTop: 24 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: "#78716c", letterSpacing: "0.12em", textTransform: "uppercase", display: "flex", alignItems: "center", gap: 8 }}>
        <span>{icon}</span>{label}
      </div>
      {sub && <div style={{ fontSize: 12, color: "#a8a29e", marginTop: 4 }}>{sub}</div>}
    </div>
  );

  return (
    <div>
      <SectionHeader icon="💰" label="Cash Flow Forecast" sub={`Projected revenue, next 6 months · total ${fmt(forecastTotal)}`} />
      <div style={{ background: "#1c1917", border: "1px solid #292524", borderRadius: 10, padding: 16 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 12 }}>
          {forecast.map((f, i) => (
            <div key={i} style={{
              padding: 12,
              borderRadius: 8,
              background: f.isCurrent ? "#064e3b" : "#0c0a09",
              border: f.isCurrent ? "1px solid #10b981" : "1px solid #292524",
              textAlign: "center",
            }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: f.isCurrent ? "#6ee7b7" : "#78716c", letterSpacing: "0.1em", textTransform: "uppercase" }}>
                {f.label}{f.isCurrent ? ' · current' : ''}
              </div>
              <div style={{ fontFamily: "'DM Mono', monospace", fontWeight: 700, fontSize: 18, color: f.revenue > 0 ? "#10b981" : "#57534e", marginTop: 6, letterSpacing: "-0.02em" }}>
                {f.revenue > 0 ? fmt(f.revenue) : '—'}
              </div>
              <div style={{ fontSize: 10, color: "#78716c", marginTop: 4 }}>
                {f.dealCount === 0 ? 'no cases' : f.dealCount === 1 ? '1 case' : `${f.dealCount} cases`}
              </div>
              <div style={{ height: 4, background: "#0c0a09", borderRadius: 2, overflow: "hidden", marginTop: 8 }}>
                <div style={{ height: "100%", width: `${(f.revenue / maxForecast) * 100}%`, background: "#10b981", borderRadius: 2 }}></div>
              </div>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 14, padding: "10px 12px", background: "#0c0a09", borderRadius: 6, fontSize: 11, color: "#78716c", lineHeight: 1.6 }}>
          Expected payout dates use (in order): <code style={{ color: "#d6d3d1" }}>meta.expected_payout</code> if set, else <code style={{ color: "#d6d3d1" }}>meta.deadline</code>, else <code style={{ color: "#d6d3d1" }}>filed_at + 120 days</code>. Revenue uses <code style={{ color: "#d6d3d1" }}>computeDealNet</code> (estimated surplus × fee % − attorney fee). As you close more cases, the averages tighten and these projections get sharper.
        </div>
      </div>

      <SectionHeader icon="📈" label="Monthly Trend" sub="Deals added and revenue booked, last 6 months" />
      <div style={{ background: "#1c1917", border: "1px solid #292524", borderRadius: 10, padding: 16 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 10 }}>
          {months.map((m, i) => (
            <div key={i} style={{ textAlign: "center" }}>
              <div style={{ fontSize: 10, color: "#78716c", marginBottom: 4 }}>{m.label}</div>
              <div style={{ height: 80, display: "flex", alignItems: "flex-end", justifyContent: "center", gap: 3, marginBottom: 6 }}>
                <div title={`${m.added} added`} style={{ width: 12, height: `${(m.added / maxMonthAdded) * 100}%`, background: "#3b82f6", borderRadius: "2px 2px 0 0", minHeight: m.added > 0 ? 3 : 0 }}></div>
                <div title={`${fmt(m.booked)} booked`} style={{ width: 12, height: `${(m.booked / maxMonthBooked) * 100}%`, background: "#10b981", borderRadius: "2px 2px 0 0", minHeight: m.booked > 0 ? 3 : 0 }}></div>
              </div>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#d6d3d1" }}>{m.added}</div>
              <div style={{ fontSize: 10, color: "#10b981", fontFamily: "'DM Mono', monospace" }}>{m.booked > 0 ? fmt(m.booked) : '—'}</div>
            </div>
          ))}
        </div>
        <div style={{ display: "flex", justifyContent: "center", gap: 20, marginTop: 12, fontSize: 10, color: "#78716c" }}>
          <span><span style={{ display: "inline-block", width: 10, height: 10, background: "#3b82f6", borderRadius: 2, verticalAlign: "middle", marginRight: 4 }}></span> Deals added</span>
          <span><span style={{ display: "inline-block", width: 10, height: 10, background: "#10b981", borderRadius: 2, verticalAlign: "middle", marginRight: 4 }}></span> Revenue booked</span>
        </div>
      </div>

      <SectionHeader icon="🧲" label="Lead Source ROI" sub={`Where your revenue actually comes from (${leadRows.length} source${leadRows.length === 1 ? '' : 's'})`} />
      {leadRows.length === 0 ? (
        <div style={{ padding: 20, textAlign: "center", color: "#78716c", fontSize: 13, border: "1px dashed #292524", borderRadius: 10 }}>No lead source data yet.</div>
      ) : (
        <div style={{ background: "#1c1917", border: "1px solid #292524", borderRadius: 10, overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr><th style={th}>Source</th><th style={{ ...th, textAlign: "right" }}>Deals</th><th style={{ ...th, textAlign: "right" }}>Closed</th><th style={{ ...th, textAlign: "right" }}>Close Rate</th><th style={{ ...th, textAlign: "right" }}>Avg Net</th><th style={{ ...th, textAlign: "right" }}>Total Booked</th></tr>
            </thead>
            <tbody>
              {leadRows.map(r => (
                <tr key={r.source}>
                  <td style={{ ...td, fontWeight: 600, color: "#fafaf9" }}>{r.source}</td>
                  <td style={tdNum}>{r.deals}</td>
                  <td style={tdNum}>{r.closed}</td>
                  <td style={tdNum}>{r.closeRate}%</td>
                  <td style={tdNum}>{r.closed > 0 ? fmt(r.avgNet) : '—'}</td>
                  <td style={{ ...tdNum, color: "#10b981", fontWeight: 700 }}>{r.netTotal > 0 ? fmt(r.netTotal) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <SectionHeader icon="⚖️" label="Attorney Performance" sub={`Surplus recoveries only — ranked by volume (${attorneyRows.length} attorney${attorneyRows.length === 1 ? '' : 's'})`} />
      {attorneyRows.length === 0 ? (
        <div style={{ padding: 20, textAlign: "center", color: "#78716c", fontSize: 13, border: "1px dashed #292524", borderRadius: 10 }}>No attorney data yet. Add attorneys to surplus deals to populate this table.</div>
      ) : (
        <div style={{ background: "#1c1917", border: "1px solid #292524", borderRadius: 10, overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr><th style={th}>Attorney</th><th style={{ ...th, textAlign: "right" }}>Cases</th><th style={{ ...th, textAlign: "right" }}>Recovered</th><th style={{ ...th, textAlign: "right" }}>Win Rate</th><th style={{ ...th, textAlign: "right" }}>Avg Days*</th><th style={{ ...th, textAlign: "right" }}>Avg Fee</th><th style={{ ...th, textAlign: "right" }}>Total Fee</th></tr>
            </thead>
            <tbody>
              {attorneyRows.map(r => (
                <tr key={r.attorney}>
                  <td style={{ ...td, fontWeight: 600, color: "#fafaf9" }}>{r.attorney}</td>
                  <td style={tdNum}>{r.deals}</td>
                  <td style={tdNum}>{r.recovered}</td>
                  <td style={tdNum}>{r.recoveryRate}%</td>
                  <td style={tdNum}>{r.avgDays != null ? r.avgDays + 'd' : '—'}</td>
                  <td style={tdNum}>{r.recovered > 0 ? fmt(r.avgFee) : '—'}</td>
                  <td style={{ ...tdNum, color: "#10b981", fontWeight: 700 }}>{r.netTotal > 0 ? fmt(r.netTotal) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div style={{ fontSize: 10, color: "#57534e", marginTop: 6, fontStyle: "italic" }}>
        * Average days from filed date to closed date for recovered cases. Requires both filed_at and closed_at to be set.
      </div>

      <SectionHeader icon="📍" label="Per-County Performance" sub={`Surplus cases only, ranked by volume (${countyRows.length} ${countyRows.length === 1 ? 'county' : 'counties'})`} />
      {countyRows.length === 0 ? (
        <div style={{ padding: 20, textAlign: "center", color: "#78716c", fontSize: 13, border: "1px dashed #292524", borderRadius: 10 }}>No county data yet.</div>
      ) : (
        <div style={{ background: "#1c1917", border: "1px solid #292524", borderRadius: 10, overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr><th style={th}>County</th><th style={{ ...th, textAlign: "right" }}>Cases</th><th style={{ ...th, textAlign: "right" }}>Recovered</th><th style={{ ...th, textAlign: "right" }}>Win Rate</th><th style={{ ...th, textAlign: "right" }}>Median Days</th><th style={{ ...th, textAlign: "right" }}>Total Fee</th></tr>
            </thead>
            <tbody>
              {countyRows.map(r => (
                <tr key={r.county}>
                  <td style={{ ...td, fontWeight: 600, color: "#fafaf9" }}>{r.county}</td>
                  <td style={tdNum}>{r.deals}</td>
                  <td style={tdNum}>{r.recovered}</td>
                  <td style={tdNum}>{r.recoveryRate}%</td>
                  <td style={tdNum}>{r.avgDays != null ? r.avgDays + 'd' : '—'}</td>
                  <td style={{ ...tdNum, color: "#10b981", fontWeight: 700 }}>{r.netTotal > 0 ? fmt(r.netTotal) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <SectionHeader icon="📊" label="Pipeline Distribution" sub={`Where your ${active.length} active deal${active.length === 1 ? ' is' : 's are'} right now`} />
      {statusRows.length === 0 ? (
        <div style={{ padding: 20, textAlign: "center", color: "#78716c", fontSize: 13, border: "1px dashed #292524", borderRadius: 10 }}>No active deals.</div>
      ) : (
        <div style={{ background: "#1c1917", border: "1px solid #292524", borderRadius: 10, padding: 16 }}>
          {statusRows.map(([status, count]) => {
            const pct = Math.round((count / maxStatus) * 100);
            const color = STATUS_COLORS[status] || "#78716c";
            return (
              <div key={status} style={{ marginBottom: 10 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
                  <span style={{ color: "#d6d3d1", textTransform: "capitalize" }}>{status.replace(/-/g, ' ')}</span>
                  <span style={{ color: "#a8a29e", fontFamily: "'DM Mono', monospace" }}>{count}</span>
                </div>
                <div style={{ height: 6, background: "#0c0a09", borderRadius: 3, overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${pct}%`, background: color, borderRadius: 3 }}></div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div style={{ marginTop: 32, padding: 16, background: "#0c0a09", border: "1px dashed #292524", borderRadius: 10, fontSize: 12, color: "#78716c", lineHeight: 1.55 }}>
        <b style={{ color: "#a8a29e" }}>About this data</b><br/>
        Analytics are computed live from your deal data. As you close more deals and populate filed/closed dates, the timelines get more accurate. The more cases we process through each attorney and county, the more reliable the averages become as forecasting tools.
      </div>
    </div>
  );
}

// ─── Outreach Approval Queue ─────────────────────────────────────────────────
// Loads pending AI-drafted outreach items from outreach_queue.
// Auto-triggers AI generation for 'queued' rows.
// Shows approval cards with: draft, reasoning, coach input, regenerate + send.

// ─── Outreach queue hook — Today view (all pending items) ─────────────────────
function useOutreachQueue() {
  const [items, setItems] = React.useState([]);
  const [deals, setDeals] = React.useState({});

  const load = React.useCallback(async () => {
    const now = new Date().toISOString();
    const { data } = await sb
      .from('outreach_queue')
      .select('*')
      .in('status', ['queued', 'generating', 'pending'])
      .lte('scheduled_for', now)
      .order('scheduled_for', { ascending: true });
    if (!data) return;
    setItems(data);
    const ids = [...new Set(data.map(r => r.deal_id))];
    if (ids.length === 0) return;
    const { data: dealRows } = await sb
      .from('deals')
      .select('id, name, address, meta, lead_tier')
      .in('id', ids);
    if (dealRows) {
      setDeals(prev => {
        const next = { ...prev };
        dealRows.forEach(d => { next[d.id] = d; });
        return next;
      });
    }
  }, []);

  React.useEffect(() => {
    load();
    const sub = sb
      .channel('outreach_queue_all')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'outreach_queue' }, load)
      .subscribe();
    // Poll every 3s as Realtime fallback
    const poll = setInterval(load, 3000);
    return () => { sb.removeChannel(sub); clearInterval(poll); };
  }, [load]);

  return { items, deals, reload: load };
}

// ─── Outreach queue hook — per-deal (for Comms tab) ───────────────────────────
function useOutreachQueueForDeal(dealId) {
  const [item, setItem] = React.useState(null);

  const load = React.useCallback(async () => {
    if (!dealId) return;
    const { data } = await sb
      .from('outreach_queue')
      .select('*')
      .eq('deal_id', dealId)
      .in('status', ['queued', 'generating', 'pending'])
      .order('scheduled_for', { ascending: true })
      .limit(1);
    setItem(data?.[0] || null);
  }, [dealId]);

  React.useEffect(() => {
    load();
    const sub = sb
      .channel('outreach_queue_deal_' + dealId)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'outreach_queue' }, load)
      .subscribe();
    // Poll every 3s as Realtime fallback — Realtime doesn't reliably fire on edge-function updates
    const poll = setInterval(load, 3000);
    return () => { sb.removeChannel(sub); clearInterval(poll); };
  }, [load, dealId]);

  return { item, reload: load };
}

// ─── Shared button style helper ────────────────────────────────────────────────
function btnStyle(variant) {
  const base = { padding: '7px 14px', borderRadius: 6, fontSize: 12, cursor: 'pointer', fontWeight: 600, border: '1px solid' };
  if (variant === 'gold')    return { ...base, background: '#d8b560', borderColor: '#d8b560', color: '#0c0a09' };
  if (variant === 'outline') return { ...base, background: 'transparent', borderColor: '#44403c', color: '#e7e5e4' };
  if (variant === 'ghost')   return { ...base, background: 'transparent', borderColor: 'transparent', color: '#78716c' };
  return base;
}

// ─── Full draft approval panel — lives inside Comms tab ───────────────────────
function OutreachDraftPanel({ item, deal, onSent, onSkipped }) {
  const [coachNote, setCoachNote] = React.useState('');
  const [isGen, setIsGen]         = React.useState(false);
  const [isSend, setIsSend]       = React.useState(false);
  const [editMode, setEditMode]   = React.useState(false);
  const sendingRef                = React.useRef(false);
  const [editBody, setEditBody]   = React.useState('');
  const [fromNum, setFromNum]     = React.useState('+15135162306');
  const [phoneNums, setPhoneNums] = React.useState([]);
  const [error, setError]         = React.useState(null);
  const [sentInfo, setSentInfo]   = React.useState(null);

  const meta      = deal?.meta || {};
  const firstName = ((meta.homeownerName || deal?.name || '').split(' - ')[0].split(' ')[0]) || 'them';
  const surplus   = meta.estimatedSurplus ? '$' + Number(meta.estimatedSurplus).toLocaleString() : null;
  const county    = meta.county || null;
  const toPhone   = item?.contact_phone || meta.homeownerPhone || '';

  React.useEffect(() => {
    sb.from('phone_numbers').select('number, label, gateway').then(({ data }) => {
      if (data) setPhoneNums(data);
    });
  }, []);

  function fmtPhone(p) {
    const d = (p || '').replace(/\D/g, '').replace(/^1/, '');
    if (d.length === 10) return `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}`;
    return p || '—';
  }

  async function callGenerate(note) {
    setIsGen(true); setError(null);
    try {
      const { data: sess } = await sb.auth.getSession();
      const token = sess?.session?.access_token;
      const r = await fetch(SUPABASE_URL + '/functions/v1/generate-outreach', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + (token || SUPABASE_KEY) },
        body: JSON.stringify({ queue_id: item.id, coach_note: note || undefined }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Generation failed');
    } catch (e) { setError(e.message); } finally { setIsGen(false); }
  }

  React.useEffect(() => {
    if (!item) return;
    if (item.status === 'queued') {
      callGenerate(null);
    } else if (item.status === 'generating') {
      // If stuck in 'generating' for > 3 minutes, reset to queued and retry
      const staleMs = Date.now() - new Date(item.updated_at).getTime();
      if (staleMs > 3 * 60 * 1000) {
        sb.from('outreach_queue').update({ status: 'queued' }).eq('id', item.id)
          .then(() => callGenerate(null));
      }
    }
  }, [item?.id, item?.status, item?.updated_at]); // eslint-disable-line

  async function handleSaveDraft() {
    if (!editBody.trim()) return;
    await sb.from('outreach_queue').update({ draft_body: editBody, status: 'pending' }).eq('id', item.id);
    setEditMode(false);
  }

  async function handleSend(bodyOverride) {
    if (sendingRef.current) return;   // prevent double-send on fast double-click
    sendingRef.current = true;
    setIsSend(true); setError(null);
    try {
      const bodyToSend = bodyOverride ?? (editMode ? editBody : item?.draft_body);
      const { data: sess } = await sb.auth.getSession();
      const token = sess?.session?.access_token;
      const r = await fetch(SUPABASE_URL + '/functions/v1/send-sms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + (token || SUPABASE_KEY) },
        body: JSON.stringify({ to: toPhone, body: bodyToSend, deal_id: item.deal_id, from_number: fromNum }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Send failed');
      const { data: authData } = await sb.auth.getUser();
      await sb.from('outreach_queue').update({
        status: 'sent', sent_at: new Date().toISOString(),
        message_id: j.id || null, approved_by: authData?.user?.id || null,
        draft_body: bodyToSend,
      }).eq('id', item.id);
      await sb.from('deals').update({ sales_stage: 'texted' }).eq('id', item.deal_id).eq('sales_stage', 'new');
      await sb.rpc('log_deal_activity', {
        p_deal_id: item.deal_id, p_type: 'sms', p_outcome: 'sent',
        p_body: '🤖 Auto-outreach sent: ' + bodyToSend.slice(0, 120),
      });
      setSentInfo({ at: new Date(), from: fromNum, to: toPhone, body: bodyToSend });
      setEditMode(false);
      onSent && onSent(item);
    } catch (e) { setError(e.message); }
    finally { setIsSend(false); sendingRef.current = false; }
  }

  async function handleSkip() {
    await sb.from('outreach_queue').update({ status: 'skipped', skipped_reason: 'manual_skip' }).eq('id', item.id);
    onSkipped && onSkipped(item);
  }

  const currentBody  = editMode ? editBody : (item?.draft_body || '');
  const charCount    = currentBody.length;
  const isLoading    = item?.status === 'queued' || item?.status === 'generating' || isGen;
  const cadenceLabel = item?.cadence_day === 0 ? 'Day 0 · Intro' : `Day ${item?.cadence_day} · Follow-up`;

  if (sentInfo) return (
    <div style={{ background: '#0a1f14', border: '1px solid #10b981', borderRadius: 8, padding: '12px 16px', marginBottom: 14, display: 'flex', alignItems: 'center', gap: 10 }}>
      <span style={{ fontSize: 18 }}>✅</span>
      <div>
        <div style={{ fontSize: 13, color: '#6ee7b7', fontWeight: 600 }}>
          Text sent at {sentInfo.at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </div>
        <div style={{ fontSize: 11, color: '#78716c', marginTop: 2 }}>
          From {fmtPhone(sentInfo.from)} → To {fmtPhone(sentInfo.to)}
        </div>
      </div>
    </div>
  );

  return (
    <div style={{ background: '#1c1917', border: '1px solid #d8b560', borderLeft: '4px solid #d8b560', borderRadius: 8, marginBottom: 14, overflow: 'hidden' }}>

      {/* Header — label + deal context */}
      <div style={{ padding: '9px 14px', borderBottom: '1px solid #292524', display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: '#d8b560', textTransform: 'uppercase', letterSpacing: '0.08em' }}>🤖 AI Draft · {cadenceLabel}</span>
        <span style={{ flex: 1 }} />
        {county  && <span style={{ fontSize: 11, color: '#78716c' }}>{county} Co.</span>}
        {surplus && <span style={{ fontSize: 11, color: '#6ee7b7', fontWeight: 600 }}>{surplus}</span>}
        {deal?.address && <span style={{ fontSize: 10, color: '#57534e' }}>{deal.address}</span>}
      </div>

      {/* From / To routing with number selector */}
      <div style={{ padding: '8px 14px', borderBottom: '1px solid #292524', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', background: '#161412' }}>
        <span style={{ fontSize: 11, color: '#78716c', whiteSpace: 'nowrap' }}>📱 From:</span>
        <select
          value={fromNum}
          onChange={e => setFromNum(e.target.value)}
          style={{ background: '#0c0a09', border: '1px solid #44403c', borderRadius: 4, color: '#e7e5e4', padding: '3px 7px', fontSize: 11, cursor: 'pointer', maxWidth: 220 }}>
          <option value="+15135162306">Nathan's iPhone · (513) 516-2306</option>
          {phoneNums.filter(p => p.number !== '+15135162306').map(p => (
            <option key={p.number} value={p.number}>{p.label || p.number}</option>
          ))}
        </select>
        <span style={{ fontSize: 11, color: '#57534e' }}>→</span>
        <span style={{ fontSize: 11, color: '#e7e5e4', fontWeight: 600 }}>{fmtPhone(toPhone)}</span>
        {toPhone && <span style={{ fontSize: 10, color: '#78716c' }}>({firstName})</span>}
      </div>

      {/* Draft body */}
      <div style={{ padding: '12px 14px' }}>
        {isLoading ? (
          <div style={{ color: '#78716c', fontSize: 13, fontStyle: 'italic', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: '#d8b560', animation: 'pulse 1.2s ease-in-out infinite' }} />
            Claude is drafting for {firstName}…
          </div>
        ) : editMode ? (
          <textarea
            value={editBody}
            onChange={e => setEditBody(e.target.value)}
            style={{ width: '100%', background: '#0c0a09', border: '1px solid #d8b560', borderRadius: 6, color: '#e7e5e4', padding: '8px 10px', fontSize: 13, resize: 'vertical', minHeight: 80, boxSizing: 'border-box', fontFamily: 'inherit' }}
            autoFocus
          />
        ) : (
          <div style={{ fontSize: 13, color: '#e7e5e4', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
            {item?.draft_body || '—'}
          </div>
        )}

        {!isLoading && item?.agent_reasoning && !editMode && (
          <div style={{ marginTop: 8, fontSize: 11, color: '#57534e', fontStyle: 'italic' }}>
            Why Claude wrote this: {item.agent_reasoning}
          </div>
        )}
        {!isLoading && (() => {
          // Mirror the server's splitAtPunctuation logic for the preview
          function splitPreview(text, limit = 160) {
            const t = (text || '').trim();
            if (t.length <= limit) return [t];
            const segs = []; let rem = t;
            while (rem.length > limit) {
              const chunk = rem.slice(0, limit);
              let idx = -1;
              for (let i = chunk.length - 1; i >= 0; i--) {
                const c = chunk[i], n = chunk[i + 1], a = chunk[i + 2];
                const isSentEnd = c === '.' || c === '?';
                const followedByCapOrEnd = n === undefined || (n === ' ' && (a === undefined || (a >= 'A' && a <= 'Z')));
                if (isSentEnd && followedByCapOrEnd) { idx = i + 1; break; }
              }
              if (idx === -1) for (let i = chunk.length - 1; i >= 0; i--) { if (chunk[i] === ' ') { idx = i; break; } }
              if (idx === -1) idx = limit;
              segs.push(rem.slice(0, idx).trim()); rem = rem.slice(idx).trim();
            }
            if (rem) segs.push(rem);
            return segs;
          }
          const parts = splitPreview(currentBody);
          const over = charCount > 160;
          return (
            <div style={{ marginTop: 4, fontSize: 10, color: over ? '#fbbf24' : '#57534e', textAlign: 'right' }}>
              {charCount} chars{over ? ` · will send as ${parts.length} texts, split at punctuation` : ' · fits in 1 text'}
            </div>
          );
        })()}
      </div>

      {/* Coach note + regenerate */}
      {!isLoading && (
        <div style={{ padding: '0 14px 10px', display: 'flex', gap: 8 }}>
          <input
            type="text"
            value={coachNote}
            onChange={e => setCoachNote(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && coachNote.trim()) { callGenerate(coachNote); setCoachNote(''); } }}
            placeholder='Coach: "make it shorter", "mention the auction date", "friendlier tone"…'
            style={{ flex: 1, background: '#0c0a09', border: '1px solid #44403c', borderRadius: 6, color: '#e7e5e4', padding: '7px 10px', fontSize: 12, outline: 'none' }}
          />
          <button
            onClick={() => { if (coachNote.trim()) { callGenerate(coachNote); setCoachNote(''); } }}
            disabled={!coachNote.trim() || isGen}
            style={{ padding: '7px 12px', background: coachNote.trim() ? '#292524' : '#1c1917', border: '1px solid #44403c', borderRadius: 6, color: coachNote.trim() ? '#e7e5e4' : '#57534e', fontSize: 12, cursor: coachNote.trim() ? 'pointer' : 'default', whiteSpace: 'nowrap' }}>
            ↺ Regenerate
          </button>
        </div>
      )}

      {error && <div style={{ padding: '0 14px 8px', fontSize: 12, color: '#fca5a5' }}>⚠ {error}</div>}

      {/* Action buttons */}
      {!isLoading && (
        <div style={{ padding: '0 14px 12px', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {editMode ? (
            <>
              <button onClick={() => setEditMode(false)} style={btnStyle('ghost')}>Cancel</button>
              <button onClick={handleSaveDraft} disabled={!editBody.trim()} style={btnStyle('outline')}>💾 Save Draft</button>
              <button onClick={() => handleSend(editBody)} disabled={isSend || !editBody.trim()} style={btnStyle('gold')}>
                {isSend ? 'Sending…' : '✓ Send'}
              </button>
            </>
          ) : (
            <>
              <button onClick={handleSkip} style={btnStyle('ghost')}>Skip</button>
              <button onClick={() => { setEditBody(item?.draft_body || ''); setEditMode(true); }} style={btnStyle('outline')}>✏ Edit</button>
              <button onClick={() => handleSend()} disabled={isSend || !item?.draft_body} style={btnStyle('gold')}>
                {isSend ? 'Sending…' : `✓ Send to ${firstName}`}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Thin wrapper: loads the queue item for a specific deal ───────────────────
function OutreachDraftPanelForDeal({ dealId, deal }) {
  const { item } = useOutreachQueueForDeal(dealId);
  if (!item) return null;
  return <OutreachDraftPanel item={item} deal={deal} onSent={() => {}} onSkipped={() => {}} />;
}

// ─── Today-view Automations section — compact list, click → deal Comms ────────
function AutomationsQueue({ onSelectDeal }) {
  const { items, deals } = useOutreachQueue();
  const firedRef = React.useRef(new Set());

  // Auto-fire generation for any 'queued' items the moment they appear in Today view
  React.useEffect(() => {
    items.forEach(async item => {
      if (item.status !== 'queued') return;
      if (firedRef.current.has(item.id)) return;
      firedRef.current.add(item.id);
      try {
        const { data: sess } = await sb.auth.getSession();
        const token = sess?.session?.access_token;
        await fetch(SUPABASE_URL + '/functions/v1/generate-outreach', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + (token || SUPABASE_KEY) },
          body: JSON.stringify({ queue_id: item.id }),
        });
      } catch(e) { /* silent — item stays queued, retry button will appear after 3 min */ }
    });
  }, [items]);

  if (items.length === 0) return null;

  function rowLabel(item) {
    const staleMs = Date.now() - new Date(item.updated_at).getTime();
    const isStuck = item.status === 'generating' && staleMs > 3 * 60 * 1000;
    if (isStuck) return { text: '⚠ Draft timed out — tap to retry', color: '#fca5a5', stuck: true };
    if (item.status === 'queued' || item.status === 'generating') return { text: '⏳ Claude is drafting…', color: '#78716c', stuck: false };
    if (item.cadence_day === 0) return { text: 'Intro draft ready', color: '#78716c', stuck: false };
    return { text: `Day ${item.cadence_day} follow-up ready`, color: '#78716c', stuck: false };
  }

  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: '#d8b560', textTransform: 'uppercase', letterSpacing: '0.08em' }}>🤖 Automations</span>
        <span style={{ fontSize: 10, background: '#292524', color: '#d8b560', borderRadius: 10, padding: '1px 7px', fontWeight: 700 }}>{items.length}</span>
        <span style={{ fontSize: 11, color: '#57534e', marginLeft: 2 }}>· tap a deal to review &amp; send</span>
      </div>
      {items.map(item => {
        const d = deals[item.deal_id];
        const meta = d?.meta || {};
        const county = meta.county;
        const label = rowLabel(item);
        const isDrafting = item.status === 'queued' || (item.status === 'generating' && !label.stuck);
        const isPending = item.status === 'pending';

        function navToComms() {
          if (!d || !onSelectDeal) return;
          window.location.hash = `#/deal/${d.id}/comms`;
          onSelectDeal(d.id);
        }

        async function handleRetry(e) {
          e.stopPropagation();
          firedRef.current.delete(item.id); // allow re-fire
          await sb.from('outreach_queue').update({ status: 'queued' }).eq('id', item.id);
          navToComms();
        }

        return (
          <div
            key={item.id}
            onClick={navToComms}
            style={{ background: '#1c1917', border: `1px solid ${label.stuck ? '#7f1d1d' : '#292524'}`, borderLeft: `3px solid ${label.stuck ? '#ef4444' : '#d8b560'}`, borderRadius: 7, padding: '10px 14px', marginBottom: 8, cursor: d ? 'pointer' : 'default', display: 'flex', alignItems: 'center', gap: 12 }}
            onMouseEnter={e => { if (d) e.currentTarget.style.background = '#222018'; }}
            onMouseLeave={e => e.currentTarget.style.background = '#1c1917'}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#e7e5e4', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {d?.name || item.deal_id}
              </div>
              <div style={{ fontSize: 11, color: label.color, marginTop: 2 }}>
                {label.text}{county && isPending ? ` · ${county} Co.` : ''}
              </div>
            </div>
            {label.stuck ? (
              <button onClick={handleRetry}
                style={{ padding: '4px 10px', background: '#7f1d1d', border: '1px solid #ef4444', borderRadius: 5, color: '#fca5a5', fontSize: 11, cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0 }}>
                ↺ Retry
              </button>
            ) : isPending ? (
              <span style={{ fontSize: 11, color: '#d8b560', fontWeight: 600, whiteSpace: 'nowrap', flexShrink: 0 }}>Review →</span>
            ) : isDrafting ? (
              <span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: '#d8b560', opacity: 0.7, flexShrink: 0 }} />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

// ─── Today View ────────────────────────────────────────────────────────────────
function TodayView({ deals, onSelect, isAdmin, setView }) {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const monthStart = new Date(year, month, 1);
  const monthEnd = new Date(year, month + 1, 0, 23, 59, 59);
  const monthName = now.toLocaleDateString(undefined, { month: "long", year: "numeric" });

  const isActive = (d) => !["closed", "recovered", "dead"].includes(d.status);
  const active = deals.filter(isActive);

  // Monthly stats
  const addedThisMonth = deals.filter(d => {
    if (!d.created) return false;
    const c = new Date(d.created);
    return !isNaN(c) && c >= monthStart && c <= monthEnd;
  });
  const payingThisMonth = active.filter(d => {
    const date = expectedPayoutDate(d);
    return date && date >= monthStart && date <= monthEnd;
  });
  const projectedRevenue = payingThisMonth.reduce((s, d) => s + (computeDealNet(d) || 0), 0);

  // Priority sections
  const urgent = active.filter(d => {
    const dl = d.meta?.deadline || d.deadline;
    if (!dl) return false;
    const info = deadlineInfo(dl);
    return info.overdue || info.soon;
  }).sort((a, b) => {
    const da = new Date(a.meta?.deadline || a.deadline).getTime();
    const db = new Date(b.meta?.deadline || b.deadline).getTime();
    return da - db;
  });

  const stale = active.filter(d => {
    const last = d.updated_at || d.created;
    return last && daysSince(last) > 14;
  }).sort((a, b) => {
    const la = a.updated_at || a.created;
    const lb = b.updated_at || b.created;
    return new Date(la).getTime() - new Date(lb).getTime();
  });

  const bonusesOwed = deals.filter(d => d.meta?.bonus_due);

  const unfiledSurplus = active.filter(d => {
    if (d.type !== "surplus") return false;
    if (d.status !== "new-lead") return false;
    const last = d.updated_at || d.created;
    return last && daysSince(last) > 5;
  });

  const hasAny = urgent.length + stale.length + bonusesOwed.length + unfiledSurplus.length > 0;

  const Row = ({ deal, right, tone }) => {
    const m = deal.meta || {};
    const typeIcon = deal.type === "flip" ? "🏠" : "💰";
    const rightColor = tone === "red" ? "#fca5a5" : tone === "amber" ? "#fbbf24" : tone === "green" ? "#6ee7b7" : "#a8a29e";
    return (
      <div onClick={() => onSelect(deal.id)} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 14px", background: "#1c1917", border: "1px solid #292524", borderRadius: 8, marginBottom: 6, cursor: "pointer" }}>
        <span style={{ fontSize: 14 }}>{typeIcon}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{deal.name}</div>
          <div style={{ fontSize: 11, color: "#78716c", marginTop: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {deal.address || "—"}{m.county ? ` · ${m.county}` : ""}{(m.attorney) ? ` · ${m.attorney}` : ""}
          </div>
        </div>
        <div style={{ fontSize: 10, fontWeight: 700, color: rightColor, letterSpacing: "0.06em", textTransform: "uppercase", whiteSpace: "nowrap" }}>{right}</div>
      </div>
    );
  };

  return (
    <div>
      {/* Monthly stats strip — each card is clickable */}
      <div style={{ display: "grid", gridTemplateColumns: isAdmin ? "repeat(3, 1fr)" : "repeat(2, 1fr)", gap: 12, marginBottom: 20 }}>
        <PortfolioStat onClick={() => setView && setView("active")}  label={`Deals Added · ${monthName}`} value={addedThisMonth.length} sub={addedThisMonth.length === 1 ? "1 new deal this month" : `${addedThisMonth.length} new deals this month`} color="#3b82f6" />
        {isAdmin && <PortfolioStat onClick={() => setView && setView("analytics")} label={`Projected Revenue · ${monthName}`} value={fmt(projectedRevenue)} sub={`Across ${payingThisMonth.length} case${payingThisMonth.length === 1 ? "" : "s"}`} color="#10b981" />}
        <PortfolioStat onClick={() => setView && setView("active")}  label={`Expected Payouts · ${monthName}`} value={payingThisMonth.length} sub={payingThisMonth.length === 0 ? "None expected" : payingThisMonth.length === 1 ? "1 case expected to close" : `${payingThisMonth.length} cases expected to close`} color="#f59e0b" />
      </div>

      {/* AI Automations Queue — compact list, click navigates to deal Comms tab */}
      <AutomationsQueue onSelectDeal={onSelect} />

      {/* Priority queue */}
      {!hasAny && (
        <div style={{ textAlign: "center", padding: 60, color: "#78716c", border: "1px dashed #292524", borderRadius: 10 }}>
          Nothing urgent. Go make some money.
        </div>
      )}

      {urgent.length > 0 && (
        <div style={{ marginBottom: 22 }}>
          <SectionLabel icon="🔥" label={`Urgent (${urgent.length})`} />
          {urgent.map(d => {
            const dl = d.meta?.deadline || d.deadline;
            const info = deadlineInfo(dl);
            return <Row key={d.id} deal={d} right={info.label} tone={info.overdue ? "red" : "amber"} />;
          })}
        </div>
      )}

      {stale.length > 0 && (
        <div style={{ marginBottom: 22 }}>
          <SectionLabel icon="⏳" label={`Stale · no update in 14+ days (${stale.length})`} />
          {stale.map(d => {
            const last = d.updated_at || d.created;
            const days = daysSince(last);
            return <Row key={d.id} deal={d} right={`${days}d idle`} tone={days > 30 ? "red" : "amber"} />;
          })}
        </div>
      )}

      {bonusesOwed.length > 0 && (
        <div style={{ marginBottom: 22 }}>
          <SectionLabel icon="💰" label={`Bonuses Owed (${bonusesOwed.length})`} />
          {bonusesOwed.map(d => <Row key={d.id} deal={d} right="Bonus due" tone="green" />)}
        </div>
      )}

      {unfiledSurplus.length > 0 && (
        <div style={{ marginBottom: 22 }}>
          <SectionLabel icon="📋" label={`Unfiled Surplus · new-lead > 5 days (${unfiledSurplus.length})`} />
          {unfiledSurplus.map(d => {
            const last = d.updated_at || d.created;
            return <Row key={d.id} deal={d} right={`${daysSince(last)}d in new-lead`} tone="amber" />;
          })}
        </div>
      )}
    </div>
  );
}

// ─── Hygiene Dashboard ───────────────────────────────────────────
// Scans every open surplus deal against 13 hygiene checks (phone, portal
// access, court case, filed date, attorney, deadline, financials, welcome
// video, documents, etc.) and shows per-deal completeness with a summary
// of the most-common gaps. Click any row to expand the detailed checklist;
// click "Open" to jump into that deal's detail view.
const HYGIENE_LABELS = {
  phone: 'Homeowner phone', email: 'Homeowner email', portal: 'Client portal',
  case: 'Court case #', county: 'County',
  filed: 'Filed date', deadline: 'Deadline',
  surplus: 'Est. surplus', fee: 'Fee %',
  attorney: 'Attorney named', atty_portal: 'Counsel portal',
  docs: 'Documents', video: 'Welcome video',
};
const hygieneLabel = (k) => HYGIENE_LABELS[k] || k;

function HygieneDashboard({ deals, onSelect }) {
  const openSurplus = deals.filter(d =>
    d.type === 'surplus' && !['closed', 'dead', 'recovered'].includes(d.status)
  );
  const [support, setSupport] = useState({ ca: new Map(), aa: new Map(), docs: new Map() });
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState(null);
  const [filter, setFilter] = useState('all');
  const [sortBy, setSortBy] = useState('completeness');

  const loadSupport = async () => {
    if (openSurplus.length === 0) { setLoading(false); return; }
    const ids = openSurplus.map(d => d.id);
    const [caRes, aaRes, docRes] = await Promise.all([
      sb.from('client_access').select('deal_id, enabled, email, user_id, last_seen_at').in('deal_id', ids),
      sb.from('attorney_assignments').select('deal_id, enabled, email, user_id').in('deal_id', ids),
      sb.from('documents').select('deal_id').in('deal_id', ids),
    ]);
    const ca = new Map();
    (caRes.data || []).forEach(r => {
      const arr = ca.get(r.deal_id) || [];
      arr.push(r);
      ca.set(r.deal_id, arr);
    });
    const aa = new Map();
    (aaRes.data || []).forEach(r => {
      const arr = aa.get(r.deal_id) || [];
      arr.push(r);
      aa.set(r.deal_id, arr);
    });
    const docs = new Map();
    (docRes.data || []).forEach(r => {
      docs.set(r.deal_id, (docs.get(r.deal_id) || 0) + 1);
    });
    setSupport({ ca, aa, docs });
    setLoading(false);
  };

  useEffect(() => { loadSupport(); /* eslint-disable-next-line */ }, [openSurplus.length]);

  const scoreOf = (deal) => {
    const m = deal.meta || {};
    const ca = support.ca.get(deal.id) || [];
    const aa = support.aa.get(deal.id) || [];
    const docCount = support.docs.get(deal.id) || 0;
    const attorneyNamed = !!(m.attorney && String(m.attorney).trim());

    const checks = [
      { key: 'phone',    label: HYGIENE_LABELS.phone,    passed: !!(m.homeownerPhone && String(m.homeownerPhone).trim()),  severity: 'high' },
      { key: 'email',    label: HYGIENE_LABELS.email,    passed: !!(m.homeownerEmail && String(m.homeownerEmail).trim()),  severity: 'high' },
      { key: 'portal',   label: HYGIENE_LABELS.portal,   passed: ca.some(r => r.enabled),                                  severity: 'high' },
      { key: 'case',     label: HYGIENE_LABELS.case,     passed: !!(m.courtCase && String(m.courtCase).trim()),            severity: 'high' },
      { key: 'county',   label: HYGIENE_LABELS.county,   passed: !!(m.county && String(m.county).trim()),                  severity: 'high' },
      { key: 'filed',    label: HYGIENE_LABELS.filed,    passed: !!(deal.filed_at || m.filed_at),                          severity: 'med'  },
      { key: 'deadline', label: HYGIENE_LABELS.deadline, passed: !!(deal.deadline || m.deadline),                          severity: 'med'  },
      { key: 'surplus',  label: HYGIENE_LABELS.surplus,  passed: !!(m.estimatedSurplus && Number(m.estimatedSurplus) > 0), severity: 'med'  },
      { key: 'fee',      label: HYGIENE_LABELS.fee,      passed: !!(m.feePct && Number(m.feePct) > 0),                     severity: 'med'  },
      { key: 'attorney', label: HYGIENE_LABELS.attorney, passed: attorneyNamed,                                            severity: 'med'  },
      { key: 'atty_portal', label: HYGIENE_LABELS.atty_portal, passed: (!attorneyNamed || aa.some(r => r.enabled)),        severity: 'med'  },
      { key: 'docs',     label: HYGIENE_LABELS.docs,     passed: docCount > 0,                                             severity: 'low'  },
      { key: 'video',    label: HYGIENE_LABELS.video,    passed: !!(m.welcome_video && m.welcome_video.path),              severity: 'low'  },
    ];

    const passed = checks.filter(c => c.passed).length;
    const total = checks.length;
    const highMissing = checks.filter(c => !c.passed && c.severity === 'high').length;
    return { checks, passed, total, highMissing };
  };

  const scored = openSurplus.map(d => ({ deal: d, score: scoreOf(d) }));

  // Gap stats: how many deals are missing each field?
  const gapStats = {};
  scored.forEach(({ score }) => {
    score.checks.forEach(c => {
      if (!c.passed) gapStats[c.key] = (gapStats[c.key] || 0) + 1;
    });
  });
  const topGaps = Object.entries(gapStats).sort((a, b) => b[1] - a[1]);

  const filtered = filter === 'all'
    ? scored
    : scored.filter(({ score }) => score.checks.some(c => !c.passed && c.key === filter));

  const sorted = [...filtered].sort((a, b) => {
    if (sortBy === 'completeness') {
      if (a.score.highMissing !== b.score.highMissing) return b.score.highMissing - a.score.highMissing;
      return a.score.passed - b.score.passed;
    }
    if (sortBy === 'name') return (a.deal.name || '').localeCompare(b.deal.name || '');
    return 0;
  });

  return (
    <div>
      {/* Summary + gap filter bar */}
      <div style={{ marginBottom: 16, padding: 16, background: "#1c1917", border: "1px solid #292524", borderRadius: 10 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10, gap: 12, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#78716c", letterSpacing: "0.1em", textTransform: "uppercase" }}>Deal Hygiene Scan</div>
            <div style={{ fontSize: 13, color: "#a8a29e", marginTop: 6, lineHeight: 1.5, maxWidth: 560 }}>
              {openSurplus.length} open surplus deal{openSurplus.length === 1 ? '' : 's'} scanned against 13 hygiene checks.
              Rows with missing high-priority fields (phone, portal access, case number) sort to the top.
              Click a row to expand, "Open" to fix it.
            </div>
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span style={{ fontSize: 10, color: "#78716c", letterSpacing: "0.08em", textTransform: "uppercase" }}>Sort</span>
            <select value={sortBy} onChange={e => setSortBy(e.target.value)} style={{ ...selectStyle, fontSize: 11, padding: "4px 8px", minWidth: 120 }}>
              <option value="completeness">Least complete first</option>
              <option value="name">Name (A–Z)</option>
            </select>
          </div>
        </div>

        {topGaps.length > 0 && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 4 }}>
            <span style={{ fontSize: 10, color: "#78716c", letterSpacing: "0.08em", textTransform: "uppercase", alignSelf: "center", marginRight: 4 }}>Top gaps</span>
            {topGaps.slice(0, 8).map(([key, count]) => (
              <button key={key} onClick={() => setFilter(filter === key ? 'all' : key)} style={{
                fontSize: 10,
                padding: "3px 9px",
                borderRadius: 4,
                cursor: "pointer",
                background: filter === key ? "#78350f" : "transparent",
                color: filter === key ? "#fbbf24" : "#a8a29e",
                border: "1px solid " + (filter === key ? "#d97706" : "#44403c"),
                letterSpacing: "0.04em",
              }}>
                {hygieneLabel(key)}: {count}
              </button>
            ))}
            {filter !== 'all' && (
              <button onClick={() => setFilter('all')} style={{ fontSize: 10, padding: "3px 9px", borderRadius: 4, cursor: "pointer", background: "transparent", color: "#78716c", border: "1px solid #44403c" }}>
                Clear filter
              </button>
            )}
          </div>
        )}
      </div>

      {loading && <div style={{ padding: 24, textAlign: "center", color: "#78716c", fontSize: 12 }}>Loading hygiene scan…</div>}

      {!loading && sorted.length === 0 && (
        <div style={{ padding: 40, textAlign: "center", color: "#78716c", border: "1px dashed #292524", borderRadius: 10, fontSize: 13 }}>
          {openSurplus.length === 0 ? "No open surplus deals to scan. Add a surplus deal first." : "No deals match the current filter."}
        </div>
      )}

      {!loading && sorted.map(({ deal, score }) => {
        const isExpanded = expandedId === deal.id;
        const pct = Math.round((score.passed / score.total) * 100);
        const barColor = pct >= 80 ? '#10b981' : pct >= 50 ? '#d97706' : '#ef4444';
        return (
          <div key={deal.id} style={{ marginBottom: 8, background: "#1c1917", border: "1px solid " + (score.highMissing > 0 ? "#7f1d1d" : "#292524"), borderLeft: `3px solid ${barColor}`, borderRadius: 8, overflow: "hidden" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 14px", cursor: "pointer" }} onClick={() => setExpandedId(isExpanded ? null : deal.id)}>
              <span style={{ fontSize: 10, color: "#78716c", width: 10, flexShrink: 0 }}>{isExpanded ? '▼' : '▶'}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#fafaf9", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {deal.name}
                </div>
                <div style={{ fontSize: 10, color: "#78716c", display: "flex", gap: 6, marginTop: 2 }}>
                  <span>{deal.meta?.county || '—'}</span>
                  <span>·</span>
                  <span style={{ textTransform: "uppercase", letterSpacing: "0.06em" }}>{deal.status.replace(/-/g, ' ')}</span>
                  {score.highMissing > 0 && (
                    <>
                      <span>·</span>
                      <span style={{ color: "#ef4444", fontWeight: 700 }}>{score.highMissing} critical gap{score.highMissing === 1 ? '' : 's'}</span>
                    </>
                  )}
                </div>
              </div>
              <div style={{ width: 130, flexShrink: 0 }}>
                <div style={{ height: 5, background: "#0c0a09", borderRadius: 3, overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${pct}%`, background: barColor, transition: "width 0.2s" }} />
                </div>
                <div style={{ fontSize: 10, color: "#78716c", marginTop: 3, textAlign: "right", fontFamily: "'DM Mono', monospace" }}>
                  {score.passed}/{score.total} · {pct}%
                </div>
              </div>
              <button onClick={e => { e.stopPropagation(); onSelect(deal.id); }} style={{ ...btnGhost, fontSize: 10, padding: "4px 10px", whiteSpace: "nowrap" }}>
                Open →
              </button>
            </div>

            {isExpanded && (
              <div style={{ padding: "10px 16px 14px 36px", borderTop: "1px solid #292524", background: "#0c0a09" }}>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: "6px 16px" }}>
                  {score.checks.map(c => {
                    const mute = c.passed;
                    const dot = c.passed ? '✓' : (c.severity === 'high' ? '✗' : '○');
                    const dotColor = c.passed ? '#10b981' : (c.severity === 'high' ? '#ef4444' : '#78716c');
                    return (
                      <div key={c.key} style={{ display: "flex", alignItems: "baseline", gap: 8, fontSize: 11 }}>
                        <span style={{ fontSize: 13, color: dotColor, width: 12, flexShrink: 0, fontWeight: 700 }}>{dot}</span>
                        <span style={{ color: mute ? "#78716c" : (c.severity === 'high' ? "#fca5a5" : "#a8a29e"), textDecoration: mute ? 'line-through' : 'none' }}>
                          {c.label}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function DealCard({ deal, onClick, onDelete, onToggleFlag }) {
  const sc = STATUS_COLORS[deal.status] || "#78716c";
  const m = deal.meta || {};
  const dl = deadlineInfo(m.deadline || deal.deadline);
  const flagged = m.flagged;
  const isClosed = ["closed", "recovered", "dead"].includes(deal.status);
  return (
    <div onClick={onClick} style={{ background: "#1c1917", border: dl.overdue ? "1px solid #7f1d1d" : flagged ? "1px solid #78350f" : "1px solid #292524", borderRadius: 10, padding: 18, paddingTop: 40, cursor: "pointer", borderLeft: `3px solid ${sc}`, position: "relative" }}>
      <div style={{ position: "absolute", top: 10, left: 18, right: 70, display: "flex", gap: 6, alignItems: "center" }}>
        <StatusBadge status={deal.status} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
          {flagged && <span style={{ fontSize: 14, marginTop: 1 }} title="Flagged for review">⚑</span>}
          <div>
            <div style={{ fontSize: 15, fontWeight: 700 }}>{deal.name}</div>
            <div style={{ fontSize: 11, color: "#a8a29e", marginTop: 2 }}>{deal.address}</div>
          </div>
        </div>
      </div>
      {isClosed ? (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 12 }}>
          <MiniStat label={deal.actual_net != null ? "Net Profit" : "Est. Net"} value={fmt(computeDealNet(deal))} />
          <MiniStat label="Closed Date" value={(deal.closed_at || deal.updated_at) ? new Date(deal.closed_at || deal.updated_at).toLocaleDateString() : "—"} />
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 12 }}>
          <MiniStat label="List Price" value={fmt(m.listPrice)} />
          <MiniStat label="Lien Payoff" value={fmt(m.lienPayoff)} />
        </div>
      )}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 12, alignItems: "center" }}>
        {dl.label && <span style={{ fontSize: 9, fontWeight: 700, padding: "3px 8px", borderRadius: 4, background: dl.overdue ? "#7f1d1d" : dl.soon ? "#78350f" : "#1c1917", color: dl.overdue ? "#fca5a5" : dl.soon ? "#fbbf24" : "#a8a29e", border: `1px solid ${dl.overdue ? "#b91c1c" : dl.soon ? "#d97706" : "#44403c"}`, letterSpacing: "0.06em", textTransform: "uppercase" }}>{dl.label}</span>}
        {(m.lead_source || deal.lead_source) && <span style={{ fontSize: 9, fontWeight: 600, padding: "3px 8px", borderRadius: 4, background: "#1c1917", color: "#a8a29e", border: "1px solid #44403c", letterSpacing: "0.06em", textTransform: "uppercase" }}>{m.lead_source || deal.lead_source}</span>}
        {m.bonus_due && <span style={{ fontSize: 9, fontWeight: 700, padding: "3px 8px", borderRadius: 4, background: "#064e3b", color: "#6ee7b7", border: "1px solid #10b981", letterSpacing: "0.06em", textTransform: "uppercase" }} title="Bonus due on this deal">$ Bonus Due</span>}
        {(deal.assigned_to || m.assigned_to) && <span style={{ fontSize: 9, fontWeight: 700, padding: "3px 8px", borderRadius: 4, background: personColor(deal.assigned_to || m.assigned_to), color: "#fafaf9", letterSpacing: "0.04em" }}>{deal.assigned_to || m.assigned_to}</span>}
      </div>
      <div style={{ position: "absolute", top: 8, right: 8, display: "flex", gap: 4 }}>
        <button onClick={e => { e.stopPropagation(); onToggleFlag(); }} style={{ ...btnGhost, fontSize: 12, padding: "2px 8px", opacity: flagged ? 1 : 0.4, color: flagged ? "#f59e0b" : "#78716c" }} title={flagged ? "Remove flag" : "Flag for review"}>⚑</button>
        <button onClick={e => { e.stopPropagation(); onDelete(); }} style={{ ...btnGhost, fontSize: 12, padding: "2px 8px", opacity: 0.4 }}>×</button>
      </div>
    </div>
  );
}

// MiniDocketPulse — compact "Recent Docket Activity" section for lead cards.
// Shows last 3 non-backfill events, elevates unack'd critical events to top,
// renders a staleness badge, and distinguishes "Monitoring setup in progress"
// (zero events, scraper not built) from "No new activity" (has backfill only).
// See ~/Documents/Claude/refundlocators-pipeline/docs/DCC_LEAD_CARD_DOCKET_SPEC.md.
function MiniDocketPulse({ dealId }) {
  const [recent, setRecent] = useState([]);
  const [hasAny, setHasAny] = useState(false);
  const [lastDetected, setLastDetected] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    // 1) Last 3 non-backfill events for the primary render
    const { data: live } = await sb.from('docket_events')
      .select('id, event_type, event_date, description, acknowledged_at, detected_at, received_at')
      .eq('deal_id', dealId)
      .eq('is_backfill', false)
      .order('event_date', { ascending: false })
      .order('received_at', { ascending: false })
      .limit(3);
    // 2) Whether ANY event exists (distinguish "scraper not built" from "backfill only")
    //    and the most recent detected_at for staleness.
    const { data: latest } = await sb.from('docket_events')
      .select('detected_at, received_at')
      .eq('deal_id', dealId)
      .order('received_at', { ascending: false })
      .limit(1);
    setRecent(live || []);
    setHasAny((latest || []).length > 0);
    setLastDetected(latest?.[0]?.detected_at || latest?.[0]?.received_at || null);
    setLoading(false);
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [dealId]);

  useEffect(() => {
    const ch = sb.channel('mini-docket-' + dealId)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'docket_events', filter: `deal_id=eq.${dealId}` }, load)
      .subscribe();
    return () => { sb.removeChannel(ch); };
    // eslint-disable-next-line
  }, [dealId]);

  if (loading) return null;

  // Zero rows ever → scraper not built yet for this county. Neutral messaging.
  if (!hasAny) {
    return (
      <div style={{ marginTop: 12, padding: "7px 10px", background: "#0c0a09", border: "1px dashed #292524", borderRadius: 6 }}>
        <div style={{ fontSize: 9, fontWeight: 700, color: "#57534e", letterSpacing: "0.1em", textTransform: "uppercase" }}>Docket</div>
        <div style={{ fontSize: 11, color: "#57534e", marginTop: 2 }}>Monitoring setup in progress</div>
      </div>
    );
  }

  // Staleness label — derived from max(detected_at). Lead card shows at-a-glance
  // age so stale scrapers are visible without drilling in.
  const hrs = lastDetected ? Math.max(0, Math.floor((Date.now() - new Date(lastDetected).getTime()) / 3_600_000)) : null;
  let stale = null;
  if (hrs != null) {
    if (hrs >= 48) stale = { text: `Last check ${Math.floor(hrs / 24)}d ago`, color: '#f59e0b' };
    else if (hrs >= 24) stale = { text: `Last check ${hrs}h ago`, color: '#f59e0b' };
    else if (hrs >= 6) stale = { text: `Updated ${hrs}h ago`, color: '#78716c' };
    else if (hrs >= 1) stale = { text: `Updated ${hrs}h ago`, color: '#57534e' };
    else stale = { text: 'Updated just now', color: '#57534e' };
  }

  // History exists but no new non-backfill events → "waiting for next real event"
  if (recent.length === 0) {
    return (
      <div style={{ marginTop: 12, padding: "7px 10px", background: "#0c0a09", border: "1px solid #292524", borderRadius: 6 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
          <div style={{ fontSize: 9, fontWeight: 700, color: "#78716c", letterSpacing: "0.1em", textTransform: "uppercase" }}>Recent Docket</div>
          {stale && <div style={{ fontSize: 9, color: stale.color }}>{stale.text}</div>}
        </div>
        <div style={{ fontSize: 11, color: "#78716c", marginTop: 2 }}>No new activity · history indexed</div>
      </div>
    );
  }

  // Sort: unack'd critical first (regardless of date), then by event_date desc.
  const sorted = [...recent].sort((a, b) => {
    const ac = isCriticalEvent(a.event_type) && !a.acknowledged_at ? 1 : 0;
    const bc = isCriticalEvent(b.event_type) && !b.acknowledged_at ? 1 : 0;
    if (ac !== bc) return bc - ac;
    return (b.event_date || '').localeCompare(a.event_date || '');
  });

  return (
    <div style={{ marginTop: 12, padding: "8px 10px", background: "#0c0a09", border: "1px solid #292524", borderRadius: 6 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, marginBottom: 4 }}>
        <div style={{ fontSize: 9, fontWeight: 700, color: "#78716c", letterSpacing: "0.1em", textTransform: "uppercase" }}>Recent Docket</div>
        {stale && <div style={{ fontSize: 9, color: stale.color }}>{stale.text}</div>}
      </div>
      {sorted.map(e => {
        const meta = eventMeta(e.event_type);
        const crit = isCriticalEvent(e.event_type) && !e.acknowledged_at;
        return (
          <div key={e.id} style={{
            display: "flex",
            alignItems: "baseline",
            gap: 6,
            padding: "2px 0",
            opacity: e.acknowledged_at ? 0.55 : 1,
          }}>
            <span style={{ fontSize: crit ? 11 : 9, color: crit ? meta.color : "#57534e", flexShrink: 0, width: 14, textAlign: "center" }}>
              {crit ? meta.icon : '•'}
            </span>
            <span style={{ fontSize: 10, color: "#78716c", fontFamily: "'DM Mono', monospace", flexShrink: 0 }}>
              {e.event_date ? new Date(e.event_date + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '—'}
            </span>
            <span style={{
              fontSize: 11,
              color: crit ? "#fafaf9" : "#a8a29e",
              fontWeight: crit ? 500 : 400,
              flex: 1,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }} title={e.description}>
              {e.description}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function SurplusCard({ deal, onClick, onDelete, onToggleFlag }) {
  const sc = STATUS_COLORS[deal.status] || "#78716c";
  const m = deal.meta || {};
  const dl = deadlineInfo(m.deadline || deal.deadline);
  const filedDays = daysSince(m.filed_at || deal.filed_at);
  const flagged = m.flagged;
  const isClosed = ["closed", "recovered", "dead"].includes(deal.status);
  return (
    <div onClick={onClick} style={{ background: "#1c1917", border: dl.overdue ? "1px solid #7f1d1d" : flagged ? "1px solid #78350f" : "1px solid #292524", borderRadius: 10, padding: 18, paddingTop: 40, cursor: "pointer", borderLeft: `3px solid ${sc}`, position: "relative" }}>
      <div style={{ position: "absolute", top: 10, left: 18, right: 70, display: "flex", gap: 6, alignItems: "center" }}>
        <StatusBadge status={deal.status} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
          {flagged && <span style={{ fontSize: 14, marginTop: 1 }} title="Flagged for review">⚑</span>}
          <div>
            <div style={{ fontSize: 15, fontWeight: 700 }}>{deal.name}</div>
            <div style={{ fontSize: 11, color: "#a8a29e", marginTop: 2 }}>{deal.address}</div>
          </div>
        </div>
      </div>
      {isClosed ? (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 12 }}>
          <MiniStat label={deal.actual_net != null ? (deal.status === "recovered" ? "Our Fee" : "Net Profit") : (deal.status === "recovered" ? "Est. Fee" : "Est. Net")} value={fmt(computeDealNet(deal))} />
          <MiniStat label="Closed Date" value={(deal.closed_at || deal.updated_at) ? new Date(deal.closed_at || deal.updated_at).toLocaleDateString() : "—"} />
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 12 }}>
          {m.estimatedSurplus > 0 && <MiniStat label="Est. Surplus" value={fmt(m.estimatedSurplus)} />}
          {m.attorney && <MiniStat label="Attorney" value={m.attorney} />}
          {m.feePct > 0 && <MiniStat label="Fee %" value={m.feePct + "%"} />}
          {m.county && <MiniStat label="County" value={m.county} />}
          {filedDays != null && <MiniStat label="Days Since Filed" value={filedDays + "d"} />}
        </div>
      )}
      {!isClosed && <MiniDocketPulse dealId={deal.id} />}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 12, alignItems: "center" }}>
        {dl.label && <span style={{ fontSize: 9, fontWeight: 700, padding: "3px 8px", borderRadius: 4, background: dl.overdue ? "#7f1d1d" : dl.soon ? "#78350f" : "#1c1917", color: dl.overdue ? "#fca5a5" : dl.soon ? "#fbbf24" : "#a8a29e", border: `1px solid ${dl.overdue ? "#b91c1c" : dl.soon ? "#d97706" : "#44403c"}`, letterSpacing: "0.06em", textTransform: "uppercase" }}>{dl.label}</span>}
        {(m.lead_source || deal.lead_source) && <span style={{ fontSize: 9, fontWeight: 600, padding: "3px 8px", borderRadius: 4, background: "#1c1917", color: "#a8a29e", border: "1px solid #44403c", letterSpacing: "0.06em", textTransform: "uppercase" }}>{m.lead_source || deal.lead_source}</span>}
        {m.bonus_due && <span style={{ fontSize: 9, fontWeight: 700, padding: "3px 8px", borderRadius: 4, background: "#064e3b", color: "#6ee7b7", border: "1px solid #10b981", letterSpacing: "0.06em", textTransform: "uppercase" }} title="Bonus due on this deal">$ Bonus Due</span>}
        {(deal.assigned_to || m.assigned_to) && <span style={{ fontSize: 9, fontWeight: 700, padding: "3px 8px", borderRadius: 4, background: personColor(deal.assigned_to || m.assigned_to), color: "#fafaf9", letterSpacing: "0.04em" }}>{deal.assigned_to || m.assigned_to}</span>}
      </div>
      <div style={{ position: "absolute", top: 8, right: 8, display: "flex", gap: 4 }}>
        <button onClick={e => { e.stopPropagation(); onToggleFlag(); }} style={{ ...btnGhost, fontSize: 12, padding: "2px 8px", opacity: flagged ? 1 : 0.4, color: flagged ? "#f59e0b" : "#78716c" }} title={flagged ? "Remove flag" : "Flag for review"}>⚑</button>
        <button onClick={e => { e.stopPropagation(); onDelete(); }} style={{ ...btnGhost, fontSize: 12, padding: "2px 8px", opacity: 0.4 }}>×</button>
      </div>
    </div>
  );
}

function StatusBadge({ status }) {
  const c = STATUS_COLORS[status] || "#78716c";
  return <span style={{ padding: "3px 10px", borderRadius: 5, fontSize: 9, fontWeight: 700, background: `${c}18`, color: c, letterSpacing: "0.06em", textTransform: "uppercase", whiteSpace: "nowrap" }}>{status.replace(/-/g, " ")}</span>;
}

function MiniStat({ label, value }) {
  return (
    <div>
      <div style={{ fontSize: 9, fontWeight: 600, color: "#78716c", letterSpacing: "0.1em", textTransform: "uppercase" }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 600, fontFamily: "'DM Mono', monospace", marginTop: 2 }}>{value}</div>
    </div>
  );
}

// ─── New Deal Modal ──────────────────────────────────────────────────
function NewDealModal({ onAdd, onClose, teamMembers }) {
  const [type, setType] = useState("flip");
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [leadSource, setLeadSource] = useState("");
  const [deadline, setDeadline] = useState("");
  const [filedAt, setFiledAt] = useState("");
  const [assignedTo, setAssignedTo] = useState("");

  const create = () => {
    if (!name) return;
    const id = type + "-" + uid();
    const meta = type === "flip"
      ? { contractPrice: 0, reinstatement: 0, lienPayoff: 0, listPrice: 0, flatFee: 0, buyerAgentPct: 3, closingMiscPct: 1, concessions: [], assigned_to: assignedTo || "" }
      : { estimatedSurplus: 0, feePct: 22, attorney: "", courtCase: "", county: "", assigned_to: assignedTo || "" };
    const deal = { id, type, name, address, status: type === "flip" ? "lead" : "new-lead", created: new Date().toISOString().slice(0, 10), meta, assigned_to: assignedTo || null };
    if (leadSource) deal.meta.lead_source = leadSource;
    if (deadline) deal.meta.deadline = deadline;
    if (type === "surplus" && filedAt) deal.meta.filed_at = filedAt;
    onAdd(deal);
  };

  const LEAD_SOURCES = ["MLS", "Direct Mail", "Tax Sale List", "Auction", "Referral", "Cold Call", "Online Lead", "Drive-by", "Castle", "Other"];

  return (
    <Modal onClose={onClose} title="Add New Deal">
      <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
        <TabBtn active={type === "flip"} onClick={() => setType("flip")}>🏠 Flip / RE Deal</TabBtn>
        <TabBtn active={type === "surplus"} onClick={() => setType("surplus")}>💰 Surplus Fund</TabBtn>
      </div>
      <Field label="Deal Name"><input value={name} onChange={e => setName(e.target.value)} style={inputStyle} placeholder={type === "flip" ? "Property address or nickname" : "Client name"} /></Field>
      <Field label="Location / County" style={{ marginTop: 12 }}><input value={address} onChange={e => setAddress(e.target.value)} style={inputStyle} placeholder={type === "flip" ? "City, State" : "County, State"} /></Field>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 12 }}>
        <Field label="Lead Source">
          <select value={leadSource} onChange={e => setLeadSource(e.target.value)} style={{ ...inputStyle, padding: "8px 10px" }}>
            <option value="">—</option>
            {LEAD_SOURCES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </Field>
        <Field label={type === "surplus" ? "Deadline (optional)" : "Closing / Target Date"}>
          <input type="date" value={deadline} onChange={e => setDeadline(e.target.value)} style={inputStyle} />
        </Field>
      </div>
      {type === "surplus" && (
        <Field label="Filed Date (claim filed)" style={{ marginTop: 12 }}>
          <input type="date" value={filedAt} onChange={e => setFiledAt(e.target.value)} style={inputStyle} />
        </Field>
      )}
      <Field label="Assigned To" style={{ marginTop: 12 }}>
        <select value={assignedTo} onChange={e => setAssignedTo(e.target.value)} style={{ ...inputStyle, padding: "8px 10px" }}>
          <option value="">Unassigned</option>
          {(teamMembers || []).map(m => <option key={m} value={m}>{m}</option>)}
        </select>
      </Field>
      <div style={{ display: "flex", gap: 10, marginTop: 20, justifyContent: "flex-end" }}>
        <button onClick={onClose} style={btnGhost}>Cancel</button>
        <button onClick={create} style={btnPrimary}>Create Deal</button>
      </div>
    </Modal>
  );
}

function Modal({ onClose, title, children, wide }) {
  // Lock body scroll while modal is open
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);
  return (
    <div className="modal-backdrop" onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div className="modal-inner" onClick={e => e.stopPropagation()} style={{ background: "#1c1917", border: "1px solid #44403c", borderRadius: 12, padding: 24, width: "100%", maxWidth: wide ? 720 : 480, maxHeight: "90vh", overflowY: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18, position: "sticky", top: -24, background: "#1c1917", zIndex: 1, paddingTop: 4, paddingBottom: 10 }}>
          <div style={{ fontSize: 16, fontWeight: 700 }}>{title}</div>
          <button onClick={onClose} style={{ ...btnGhost, fontSize: 18, padding: "6px 12px", minWidth: 40, minHeight: 36 }} aria-label="Close">×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ─── Deal Detail ─────────────────────────────────────────────────────
function DealDetail({ deal, userName, userId, teamMembers, onUpdateDeal, isAdmin, initialTab }) {
  const [tab, setTab] = useState(initialTab || "overview");
  const [unreadCounts, setUnreadCounts] = useState({ docket: 0, comms: 0 });

  // Compute unread counts per tab based on this user's last_seen_at per tab.
  // Docket = non-backfill events received after last docket view.
  // Comms  = inbound SMS + inbound calls + inbound emails after last comms view.
  const loadUnreadCounts = React.useCallback(async () => {
    if (!userId || !deal?.id) return;
    const { data: views } = await sb.from('user_deal_views')
      .select('tab, last_seen_at')
      .eq('deal_id', deal.id);
    const viewMap = Object.fromEntries((views || []).map(v => [v.tab, v.last_seen_at]));
    const docketSince = viewMap.docket || '1970-01-01T00:00:00Z';
    const commsSince  = viewMap.comms  || '1970-01-01T00:00:00Z';
    const [docket, msgs, calls, emails] = await Promise.all([
      sb.from('docket_events').select('id', { count: 'exact', head: true })
        .eq('deal_id', deal.id).eq('is_backfill', false).gt('received_at', docketSince),
      sb.from('messages_outbound').select('id', { count: 'exact', head: true })
        .eq('deal_id', deal.id).eq('direction', 'inbound').gt('created_at', commsSince),
      sb.from('call_logs').select('id', { count: 'exact', head: true })
        .eq('deal_id', deal.id).gt('started_at', commsSince),
      sb.from('emails').select('id', { count: 'exact', head: true })
        .eq('deal_id', deal.id).eq('direction', 'inbound').gt('created_at', commsSince),
    ]);
    setUnreadCounts({
      docket: docket.count || 0,
      comms: (msgs.count || 0) + (calls.count || 0) + (emails.count || 0),
    });
  }, [userId, deal?.id]);

  useEffect(() => {
    loadUnreadCounts();
    const iv = setInterval(loadUnreadCounts, 60000);
    return () => clearInterval(iv);
  }, [loadUnreadCounts]);

  // Upsert last_seen_at for the initial tab on mount so the badge clears
  // the moment Nathan opens the deal on that tab.
  useEffect(() => {
    if (!userId || !deal?.id || !tab) return;
    sb.from('user_deal_views').upsert({
      user_id: userId, deal_id: deal.id, tab, last_seen_at: new Date().toISOString(),
    }, { onConflict: 'user_id,deal_id,tab' }).then(() => setTimeout(loadUnreadCounts, 300));
    // eslint-disable-next-line
  }, [userId, deal?.id, tab]);

  const switchTab = (t) => {
    setTab(t);
    window.location.hash = `#/deal/${deal.id}/${t}`;
    // The mount-effect above will also handle upsert + refresh on tab state
    // change, so no duplicate logic needed here.
  };
  const [expenses, setExpenses] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [vendors, setVendors] = useState([]);
  const [notes, setNotes] = useState([]);
  const [activity, setActivity] = useState([]);
  const [documents, setDocuments] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [showPostUpdate, setShowPostUpdate] = useState(false);
  const [showSendIntro, setShowSendIntro] = useState(false);
  const [showOverflow, setShowOverflow] = useState(false);

  const loadAll = async () => {
    setLoaded(false);
    const [e, t, v, n, a, d] = await Promise.all([
      sb.from('expenses').select('*').eq('deal_id', deal.id).order('date', { ascending: false }),
      sb.from('tasks').select('*').eq('deal_id', deal.id).order('done').order('created_at'),
      sb.from('vendors').select('*').eq('deal_id', deal.id).order('created_at'),
      sb.from('deal_notes').select('*, profiles:author_id(name)').eq('deal_id', deal.id).order('updated_at', { ascending: false }),
      sb.from('activity').select('*, profiles(name)').eq('deal_id', deal.id).order('created_at', { ascending: false }).limit(60),
      sb.from('documents').select('*').eq('deal_id', deal.id).order('created_at', { ascending: false }),
    ]);
    setExpenses(e.data || []);
    setTasks(t.data || []);
    setVendors(v.data || []);
    setNotes(n.data || []);
    setActivity(a.data || []);
    setDocuments(d.data || []);
    setLoaded(true);
  };

  useEffect(() => { loadAll(); }, [deal.id]);

  // realtime per-deal subscription
  useEffect(() => {
    const ch = sb.channel('deal-' + deal.id)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'expenses', filter: `deal_id=eq.${deal.id}` }, loadAll)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks', filter: `deal_id=eq.${deal.id}` }, loadAll)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'vendors', filter: `deal_id=eq.${deal.id}` }, loadAll)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'deal_notes', filter: `deal_id=eq.${deal.id}` }, loadAll)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'activity', filter: `deal_id=eq.${deal.id}` }, loadAll)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'documents', filter: `deal_id=eq.${deal.id}` }, loadAll)
      .subscribe();
    return () => { sb.removeChannel(ch); };
  }, [deal.id]);

  // logAct writes an activity row. `visibility` controls who sees it:
  //   ['team']                         = internal audit only (DCC). Default.
  //   ['team', 'client', 'attorney']   = case milestone — shows in both portals.
  //   ['team', 'client']               = client-only milestone.
  //   ['team', 'attorney']             = attorney-only milestone.
  // Always include 'team' so Nathan + VAs see it in DCC's audit log.
  const logAct = async (msg, visibility = ['team']) => {
    await sb.from('activity').insert({ deal_id: deal.id, user_id: userId, action: msg, visibility });
  };

  const totalExpenses = expenses.reduce((s, x) => s + (parseFloat(x.amount) || 0), 0);

  const isFlip = deal.type === "flip";
  const m = deal.meta || {};
  const strategy = m.strategy || "flip"; // 'flip' | 'wholesale'
  let netProfit = 0;
  let salePrice = 0;
  let closingDollars = 0;
  if (isFlip) {
    salePrice = strategy === "wholesale" ? (m.wholesalePrice || 0) : (m.listPrice || 0);
    const closingPct = ((m.buyerAgentPct || 0) + (m.closingMiscPct || 0)) / 100;
    closingDollars = strategy === "wholesale" ? 0 : salePrice * closingPct + (m.flatFee || 0);
    netProfit = salePrice - (m.contractPrice || 0) - closingDollars - totalExpenses;
  }
  let projectedFee = 0;
  if (!isFlip) projectedFee = ((m.estimatedSurplus || 0) * (m.feePct || 0)) / 100;

  const tasksDone = tasks.filter(t => t.done).length;
  const tasksHigh = tasks.filter(t => !t.done && t.priority === "high").length;

  if (!loaded) return <div style={{ textAlign: "center", padding: 60, color: "#78716c" }}>Loading deal data...</div>;

  // Tab bar consolidation — Stage 1 (2026-04-23):
  //   • Activity + SMS + Messages folded into a single "Comms" tab (render below)
  //   • Expenses hidden on surplus deals (only attorney fee, already in FS)
  // Stage 2 (2026-04-23): notes → files (merged w/ documents), vendors → contacts.
  // Old tabs remain as components; they're just not wired into the tab bar.
  const isWholesale = deal.type === "wholesale";
  const tabs = isAdmin
    ? (isFlip
        ? ["overview", "comms", "docket", "contacts", "investor", "partner", "expenses", "tasks", "files"]
        : isWholesale
          ? ["overview", "comms", "docket", "contacts", "partner", "expenses", "tasks", "files"]
          : ["overview", "comms", "docket", "contacts", "tasks", "files"])
    : ["overview", "comms", "docket", "contacts", "tasks", "files"];

  return (
    <div>
      <div style={{ display: "flex", gap: 10, marginBottom: 16, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ fontSize: 11, color: "#78716c" }}>Status:</span>
        <select value={deal.status} onChange={e => {
          const prev = deal.status;
          const next = e.target.value;
          const patch = { status: next };
          const isClosedStatus = (s) => ["closed", "recovered"].includes(s);
          if (isClosedStatus(next) && !deal.closed_at) patch.closed_at = new Date().toISOString();
          if (!isClosedStatus(next) && isClosedStatus(prev)) patch.closed_at = null;
          onUpdateDeal(patch);
          // Status changes are a case milestone — clients AND attorneys see this.
          // Store the simplified "Case moved to X" form so it renders universally
          // and reads like plain English in the portal timelines.
          logAct(`Case moved to ${next.replace(/-/g," ")}`, ['team', 'client', 'attorney']);
        }} style={{ ...selectStyle, fontSize: 11 }}>
          {(DEAL_STATUSES[deal.type] || []).map(s => <option key={s} value={s}>{s.replace(/-/g, " ").toUpperCase()}</option>)}
        </select>
        <span style={{ fontSize: 11, color: "#78716c", marginLeft: 8 }}>Assigned to:</span>
        <select value={deal.assigned_to || deal.meta?.assigned_to || ""} onChange={e => {
          const val = e.target.value || null;
          const m = deal.meta || {};
          onUpdateDeal({ assigned_to: val, meta: { ...m, assigned_to: val || "" } });
          logAct(`Assigned to ${val || "nobody"}`);
        }} style={{ ...selectStyle, fontSize: 11 }}>
          <option value="">Unassigned</option>
          {teamMembers.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
        {/* Flag + Bonus Due moved into the ⋯ overflow menu — infrequent admin actions */}
        {(deal.meta?.flagged || deal.meta?.bonus_due) && (
          <div style={{ display: "inline-flex", gap: 6 }}>
            {deal.meta?.flagged && <span style={{ fontSize: 11, color: "#f59e0b", padding: "3px 8px", border: "1px solid #78350f", borderRadius: 4, fontWeight: 700, letterSpacing: "0.06em" }}>⚑ FLAGGED</span>}
            {deal.meta?.bonus_due && <span style={{ fontSize: 11, color: "#10b981", padding: "3px 8px", border: "1px solid #064e3b", borderRadius: 4, fontWeight: 700, letterSpacing: "0.06em" }}>$ BONUS DUE</span>}
          </div>
        )}
        {isAdmin && (
          <>
            <a href={`portal.html?preview=${deal.id}`} target="_blank" rel="noreferrer" title="Open this deal in the client portal preview" style={{ background: "transparent", border: "1px solid #44403c", color: "#a8a29e", padding: "4px 12px", borderRadius: 6, fontSize: 12, fontWeight: 700, textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 6 }}>
              👤 Client view
            </a>
            <a href={`attorney-portal.html#/case/${deal.id}`} target="_blank" rel="noreferrer" title="Open this deal in the counsel portal preview" style={{ background: "transparent", border: "1px solid #44403c", color: "#a8a29e", padding: "4px 12px", borderRadius: 6, fontSize: 12, fontWeight: 700, textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 6 }}>
              ⚖ Counsel view
            </a>
            <button onClick={() => setShowPostUpdate(true)} title="Post a case update to the client and/or attorney timeline" style={{ background: "#d97706", color: "#0c0a09", border: "none", padding: "4px 12px", borderRadius: 6, fontSize: 12, fontWeight: 700, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6 }}>
              📢 Post Update
            </button>
            <SendPersonalizedLinkButton deal={deal} />
            {/* Send Intro Text button moved into the Comms tab (see 📝 Send Intro button) */}
            {/* Overflow menu — infrequent admin actions (Flag, Bonus Due) */}
            <div style={{ position: "relative" }}>
              <button
                onClick={() => setShowOverflow(v => !v)}
                title="More actions"
                style={{ background: "transparent", border: "1px solid #44403c", color: "#a8a29e", padding: "4px 10px", borderRadius: 6, fontSize: 14, fontWeight: 700, cursor: "pointer", lineHeight: 1 }}
              >⋯</button>
              {showOverflow && (
                <>
                  <div onClick={() => setShowOverflow(false)} style={{ position: "fixed", inset: 0, zIndex: 40 }} />
                  <div style={{ position: "absolute", top: "calc(100% + 4px)", right: 0, background: "#1c1917", border: "1px solid #292524", borderRadius: 8, padding: 6, minWidth: 200, zIndex: 50, boxShadow: "0 4px 20px rgba(0,0,0,0.5)" }}>
                    <button
                      onClick={() => {
                        const m = deal.meta || {};
                        onUpdateDeal({ meta: { ...m, flagged: !m.flagged } });
                        setShowOverflow(false);
                      }}
                      style={{ display: "block", width: "100%", textAlign: "left", background: "transparent", border: "none", color: deal.meta?.flagged ? "#f59e0b" : "#d6d3d1", padding: "8px 12px", fontSize: 12, fontWeight: 600, cursor: "pointer", borderRadius: 4, fontFamily: "inherit" }}
                      onMouseEnter={e => e.currentTarget.style.background = "#292524"}
                      onMouseLeave={e => e.currentTarget.style.background = "transparent"}
                    >
                      ⚑ {deal.meta?.flagged ? "Unflag" : "Flag for review"}
                    </button>
                    <button
                      onClick={() => {
                        const m = deal.meta || {};
                        const next = !m.bonus_due;
                        onUpdateDeal({ meta: { ...m, bonus_due: next } });
                        logAct(next ? "Bonus marked due" : "Bonus cleared");
                        setShowOverflow(false);
                      }}
                      style={{ display: "block", width: "100%", textAlign: "left", background: "transparent", border: "none", color: deal.meta?.bonus_due ? "#10b981" : "#d6d3d1", padding: "8px 12px", fontSize: 12, fontWeight: 600, cursor: "pointer", borderRadius: 4, fontFamily: "inherit" }}
                      onMouseEnter={e => e.currentTarget.style.background = "#292524"}
                      onMouseLeave={e => e.currentTarget.style.background = "transparent"}
                    >
                      $ {deal.meta?.bonus_due ? "Clear bonus due" : "Mark bonus due"}
                    </button>
                  </div>
                </>
              )}
            </div>
          </>
        )}
      </div>

      {isAdmin ? (
        <div className={isFlip ? "metric-grid-4" : "metric-grid-3"} style={{ display: "grid", gridTemplateColumns: isFlip ? "repeat(4, 1fr)" : "repeat(3, 1fr)", gap: 12, marginBottom: 20 }}>
          {isFlip ? (<>
            <Metric label="Contract Price" value={fmt(m.contractPrice)} sub="What we pay" color="#f59e0b" />
            <Metric label="Cash Deployed" value={fmt(totalExpenses)} sub="Expenses to date" color="#a8a29e" />
            <Metric label={strategy === "wholesale" ? "Wholesale Price" : "List Price"} value={fmt(salePrice)} sub={strategy === "wholesale" ? "Assignment exit" : (deal.status === "listing" ? "Active listing" : "Target")} color="#3b82f6" />
            <Metric label="Projected Net" value={fmt(netProfit)} sub={strategy === "wholesale" ? "As wholesale" : (netProfit >= 60000 ? "Above $60K target" : netProfit >= 0 ? "Positive" : "Negative")} color={netProfit >= 60000 ? "#10b981" : netProfit >= 0 ? "#f59e0b" : "#ef4444"} big />
          </>) : (<>
            <Metric label="Est. Surplus" value={m.estimatedSurplus > 0 ? fmt(m.estimatedSurplus) : "TBD"} sub={m.county ? m.county + " County" : "—"} color="#3b82f6" />
            <Metric label="Our Fee" value={projectedFee > 0 ? fmt(projectedFee) : "TBD"} sub={`${m.feePct || 0}% contingency`} color="#10b981" />
            <Metric label="Attorney" value={m.attorney || "Not assigned"} sub={m.courtCase || "No case #"} color="#8b5cf6" />
          </>)}
        </div>
      ) : (
        <div className="metric-grid-3" style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: 20 }}>
          <Metric label="Type" value={deal.type === "flip" ? "Real Estate Flip" : "Surplus Recovery"} sub={deal.status.replace(/-/g, ' ')} color="#3b82f6" />
          <Metric label="County" value={m.county || "—"} sub={m.courtCase || (deal.address || '')} color="#8b5cf6" />
          <Metric label="Attorney" value={m.attorney || "Not assigned"} sub={m.filed_at || deal.filed_at ? `Filed ${daysSince(m.filed_at || deal.filed_at)}d ago` : "Not yet filed"} color="#f59e0b" />
        </div>
      )}

      <div className="detail-tabs" style={{ display: "flex", gap: 2, marginBottom: 20, borderBottom: "1px solid #292524", overflowX: "auto" }}>
        {tabs.map(id => (
          <button key={id} onClick={() => switchTab(id)} style={{
            background: "transparent", border: "none", color: tab === id ? "#fafaf9" : "#78716c",
            padding: "10px 16px", fontSize: 13, fontWeight: tab === id ? 700 : 500,
            borderBottom: tab === id ? "2px solid #d97706" : "2px solid transparent", marginBottom: -1, whiteSpace: "nowrap",
          }}>
            {id === "comms" ? "💬 Comms" : id === "files" ? "📁 Files" : id === "investor" ? "💵 Investor" : id === "partner" ? "🤝 JV Partner" : id.charAt(0).toUpperCase() + id.slice(1)}{id === "tasks" && tasksHigh > 0 ? " ●" : ""}
            {/* Unread-since-last-seen badge for Comms + Docket — resets when the tab is opened */}
            {((id === "comms" && unreadCounts.comms > 0) || (id === "docket" && unreadCounts.docket > 0)) && (
              <span style={{ marginLeft: 6, display: "inline-block", background: "#ef4444", color: "#fff", borderRadius: 10, padding: "1px 7px", fontSize: 10, fontWeight: 700, lineHeight: 1.3, verticalAlign: "middle" }}>
                {id === "comms" ? unreadCounts.comms : unreadCounts.docket}
              </span>
            )}
          </button>
        ))}
      </div>

      {tab === "overview" && (isFlip
        ? <FlipOverview deal={deal} expenses={expenses} totalExpenses={totalExpenses} netProfit={netProfit} strategy={strategy} salePrice={salePrice} closingDollars={closingDollars} tasksDone={tasksDone} tasksTotal={tasks.length} onUpdateDeal={onUpdateDeal} isAdmin={isAdmin} userId={userId} onJumpToTab={setTab} />
        : <SurplusOverview deal={deal} totalExpenses={totalExpenses} projectedFee={projectedFee} tasksDone={tasksDone} tasksTotal={tasks.length} onUpdateDeal={onUpdateDeal} logAct={logAct} isAdmin={isAdmin} userId={userId} onJumpToTab={setTab} />)}
      {/* Comms = SMS/iMessage + in-app messages + unified timeline. Stacked */}
      {/* sections for now; Stage 3 merges into a single threaded GHL-style view. */}
      {tab === "comms" && (
        <ErrorBoundary label="comms">
          <div>
            <OutreachDraftPanelForDeal dealId={deal.id} deal={deal} />
            <OutboundMessages dealId={deal.id} vendors={vendors} deal={deal} />
            <div style={{ marginTop: 20 }}>
              <MessagesTab dealId={deal.id} deal={deal} userId={userId} userName={userName} userRole={isAdmin ? 'admin' : 'va'} />
            </div>
            <div style={{ marginTop: 20 }}>
              <CallRecordings dealId={deal.id} />
            </div>
            <div style={{ marginTop: 20 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: "#78716c", letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 10 }}>📜 Full activity log</div>
              <Activity items={activity} dealId={deal.id} reload={loadAll} />
            </div>
          </div>
        </ErrorBoundary>
      )}
      {tab === "docket" && <DocketTab dealId={deal.id} />}
      {tab === "contacts" && (
        <div>
          <ContactsTab dealId={deal.id} userId={userId} isAdmin={isAdmin} />
          {isFlip && (
            <div style={{ marginTop: 24 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: "#78716c", letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 10 }}>🏠 Homeowner intake</div>
              <HomeownerIntakeCard deal={deal} userId={userId} />
              <HomeownerIntakeResponses deal={deal} />
            </div>
          )}
          <div style={{ marginTop: 24 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: "#78716c", letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 10 }}>🔧 Vendors on this deal</div>
            <Vendors items={vendors} dealId={deal.id} logAct={logAct} reload={loadAll} />
          </div>
        </div>
      )}
      {tab === "investor" && isFlip && isAdmin && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <InvestorDetailsEditor deal={deal} onUpdateDeal={onUpdateDeal} />
          <InvestorOffersCard deal={deal} userId={userId} />
          <InvestorPortalCard deal={deal} userId={userId} />
        </div>
      )}
      {tab === "partner" && (isFlip || isWholesale) && isAdmin && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <PartnerDetailsEditor deal={deal} onUpdateDeal={onUpdateDeal} />
          <PartnerMilestonesCard deal={deal} onUpdateDeal={onUpdateDeal} userName={userName} />
          <PartnerPortalCard deal={deal} userId={userId} />
        </div>
      )}
      {tab === "expenses" && <Expenses items={expenses} dealId={deal.id} userId={userId} logAct={logAct} reload={loadAll} />}
      {tab === "tasks" && <Tasks items={tasks} dealId={deal.id} userId={userId} teamMembers={teamMembers} logAct={logAct} reload={loadAll} deal={deal} />}
      {tab === "files" && (
        <div>
          <Documents items={documents} dealId={deal.id} deal={deal} userId={userId} logAct={logAct} reload={loadAll} />
          <div style={{ marginTop: 24 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: "#78716c", letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 10 }}>📝 Notes on this deal</div>
            <Notes items={notes} dealId={deal.id} userId={userId} userName={userName} reload={loadAll} />
          </div>
        </div>
      )}

      {showPostUpdate && (
        <PostUpdateModal
          dealName={deal.name}
          onClose={() => setShowPostUpdate(false)}
          onPost={async (text, visibility) => {
            await logAct(text, visibility);
            setShowPostUpdate(false);
            await loadAll();
          }}
        />
      )}
      {showSendIntro && (
        <SendIntroTextModal
          deal={deal}
          onClose={() => setShowSendIntro(false)}
          onSent={async () => { await loadAll(); }}
        />
      )}
    </div>
  );
}

// ─── Post Case Update (admin-composed message visible in client/attorney portal) ──
// Writes directly to `activity` with explicit visibility so the message
// shows up on the client or attorney timeline alongside automatic status
// changes. Internal bonus/assignment/doc events stay team-only by default.
function PostUpdateModal({ dealName, onClose, onPost }) {
  const [text, setText] = useState('');
  const [toClient, setToClient] = useState(true);
  const [toAttorney, setToAttorney] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const submit = async () => {
    const msg = text.trim();
    if (!msg) { setErr('Write a short update first.'); return; }
    if (!toClient && !toAttorney) { setErr('Pick at least one audience (client or attorney) — otherwise just leave a team-only note in the Notes tab instead.'); return; }
    setBusy(true); setErr(null);
    const visibility = ['team'];
    if (toClient)   visibility.push('client');
    if (toAttorney) visibility.push('attorney');
    await onPost(msg, visibility);
    setBusy(false);
  };

  return (
    <Modal onClose={onClose} title={`Post case update — ${dealName}`} wide>
      <p style={{ fontSize: 13, color: "#a8a29e", marginTop: 0, marginBottom: 16, lineHeight: 1.55 }}>
        This posts one line to the Case Timeline that the selected audience sees in their portal.
        Use it for meaningful progress only — "Attorney filed objection response today" or
        "Hearing date confirmed for Tuesday" — not internal admin notes.
      </p>
      <Field label="Update">
        <textarea
          value={text}
          onChange={e => setText(e.target.value)}
          rows={4}
          autoFocus
          placeholder="Example: Attorney filed the surplus claim today. Expect a hearing date within 6–12 weeks."
          style={{ ...inputStyle, fontFamily: "inherit", resize: "vertical" }}
        />
      </Field>
      <div style={{ marginTop: 14, display: "flex", gap: 20, flexWrap: "wrap" }}>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer" }}>
          <input type="checkbox" checked={toClient} onChange={e => setToClient(e.target.checked)} />
          👤 Visible to client
        </label>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer" }}>
          <input type="checkbox" checked={toAttorney} onChange={e => setToAttorney(e.target.checked)} />
          ⚖ Visible to attorney
        </label>
      </div>
      {err && (
        <div style={{ padding: "8px 12px", borderRadius: 6, marginTop: 14, fontSize: 12, background: "#7f1d1d", color: "#fecaca" }}>{err}</div>
      )}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 20 }}>
        <button onClick={onClose} disabled={busy} style={btnGhost}>Cancel</button>
        <button onClick={submit} disabled={busy || !text.trim()} style={btnPrimary}>
          {busy ? 'Posting…' : '📢 Post update'}
        </button>
      </div>
    </Modal>
  );
}

// ─── Flip Overview ───────────────────────────────────────────────────
function FlipOverview({ deal, expenses, totalExpenses, netProfit, strategy, salePrice, closingDollars, tasksDone, tasksTotal, onUpdateDeal, isAdmin, userId, onJumpToTab }) {
  const m = deal.meta || {};
  const updateMeta = (patch) => onUpdateDeal({ meta: { ...m, ...patch } });
  const setStrategy = (s) => updateMeta({ strategy: s });
  const byCat = {};
  expenses.forEach(e => { const cat = e.category || "Other"; byCat[cat] = (byCat[cat] || 0) + (parseFloat(e.amount) || 0); });
  const cats = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  const maxCat = cats[0]?.[1] || 1;

  return (
    <div>
      <CaseIntelligence dealId={deal.id} deal={deal} onJumpToTab={onJumpToTab} />
      <QuickNotes dealId={deal.id} userId={userId} onJumpToTab={onJumpToTab} />
    <div className="overview-grid" style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 20 }}>
      <div>
        {isAdmin && <Card title="Live P&L Waterfall">
          <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
            {["flip", "wholesale"].map(s => (
              <button key={s} onClick={() => setStrategy(s)} style={{
                background: strategy === s ? "#d97706" : "transparent",
                color: strategy === s ? "#0c0a09" : "#a8a29e",
                border: `1px solid ${strategy === s ? "#d97706" : "#44403c"}`,
                padding: "5px 12px", borderRadius: 6, fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase",
              }}>{s === "flip" ? "Flip / Retail" : "Wholesale"}</button>
            ))}
          </div>
          <WaterfallLine label={strategy === "wholesale" ? "Wholesale Price" : "List / Sale Price"} value={salePrice} positive bold />
          <WaterfallLine label="Contract Price (our purchase)" value={-(m.contractPrice || 0)} />
          {strategy === "flip" && <WaterfallLine label={`Closing costs (${m.flatFee || 0} flat + ${m.buyerAgentPct || 0}% buyer + ${m.closingMiscPct || 0}% misc)`} value={-closingDollars} />}
          <WaterfallLine label="Cash deployed (all expenses)" value={-totalExpenses} />
          <div style={{ height: 1, background: "#292524", margin: "10px 0" }} />
          <WaterfallLine label="NET PROFIT" value={netProfit} bold huge />
          {strategy === "wholesale" && <div style={{ fontSize: 11, color: "#78716c", marginTop: 10, fontStyle: "italic" }}>Wholesale view skips retail closing costs — assumes assignment or double-close.</div>}
        </Card>}
        <Card title="Timing & Source" style={{ marginTop: 16 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
            <Field label="Closing / Target Date"><input type="date" value={m.deadline || deal.deadline || ""} onChange={e => updateMeta({ deadline: e.target.value || null })} style={inputStyle} /></Field>
            <Field label="Lead Source">
              <select value={m.lead_source || deal.lead_source || ""} onChange={e => updateMeta({ lead_source: e.target.value || null })} style={{ ...inputStyle, padding: "8px 10px" }}>
                <option value="">—</option>
                {["MLS","Direct Mail","Tax Sale List","Auction","Referral","Cold Call","Online Lead","Drive-by","Castle","Other"].map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </Field>
            {deal.status === "closed" && (
              <Field label="Actual Net Profit"><input type="number" value={deal.actual_net || ""} onChange={e => onUpdateDeal({ actual_net: e.target.value ? parseFloat(e.target.value) : null, closed_at: deal.closed_at || new Date().toISOString() })} style={inputStyle} placeholder="Final P&L" /></Field>
            )}
          </div>
        </Card>
        {isAdmin && <Card title="Deal Parameters" style={{ marginTop: 16 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
            <Field label="Contract Price"><input type="number" value={m.contractPrice || ""} onChange={e => updateMeta({ contractPrice: parseFloat(e.target.value) || 0 })} style={inputStyle} /></Field>
            <Field label="List Price (retail)"><input type="number" value={m.listPrice || ""} onChange={e => updateMeta({ listPrice: parseFloat(e.target.value) || 0 })} style={inputStyle} /></Field>
            <Field label="Wholesale Price"><input type="number" value={m.wholesalePrice || ""} onChange={e => updateMeta({ wholesalePrice: parseFloat(e.target.value) || 0 })} style={inputStyle} /></Field>
            <Field label="Lien Payoff (seller)"><input type="number" value={m.lienPayoff || ""} onChange={e => updateMeta({ lienPayoff: parseFloat(e.target.value) || 0 })} style={inputStyle} /></Field>
            <Field label="Flat Fee"><input type="number" value={m.flatFee || ""} onChange={e => updateMeta({ flatFee: parseFloat(e.target.value) || 0 })} style={inputStyle} /></Field>
            <Field label="Buyer Agent %"><input type="number" step="0.5" value={m.buyerAgentPct || ""} onChange={e => updateMeta({ buyerAgentPct: parseFloat(e.target.value) || 0 })} style={inputStyle} /></Field>
            <Field label="Misc Closing %"><input type="number" step="0.5" value={m.closingMiscPct || ""} onChange={e => updateMeta({ closingMiscPct: parseFloat(e.target.value) || 0 })} style={inputStyle} /></Field>
          </div>
        </Card>}
      </div>
      <div>
        {(m.intake_type === 'preforeclosure' || m.courtCase || m.county) && (
          <Card title="Foreclosure Context">
            <div style={{ fontSize: 11, color: "#78716c", marginBottom: 10, lineHeight: 1.5 }}>
              Flip deal from a preforeclosure lead. Fill in case + county to unlock docket monitoring and on-demand court pulls.
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <Field label="Court Case #"><input value={m.courtCase || ""} onChange={e => updateMeta({ courtCase: e.target.value })} style={inputStyle} placeholder="e.g. CV 2022 08 1416" /></Field>
              <Field label="County"><input value={m.county || ""} onChange={e => updateMeta({ county: e.target.value })} style={inputStyle} placeholder="e.g. Butler" /></Field>
            </div>
            <CourtPullButton dealId={deal.id} caseNumber={m.courtCase} county={m.county} userId={userId} />
          </Card>
        )}
        {/* Investor-facing details, Homeowner Intake, and Investor Portal moved:
             • Investor stuff → new Investor tab
             • Homeowner intake → Contacts tab (lives with the homeowner contact)
             • Progress card removed — Tasks tab is the home for task tracking */}
        <Card title="Spend by Category" style={{ marginTop: 16 }}>
          {cats.length === 0 && <div style={{ fontSize: 12, color: "#78716c" }}>No expenses yet.</div>}
          {cats.map(([cat, amt]) => (
            <div key={cat} style={{ marginBottom: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
                <span style={{ color: "#a8a29e" }}>{cat}</span>
                <span style={{ fontFamily: "'DM Mono', monospace", fontWeight: 600 }}>{fmt(amt)}</span>
              </div>
              <div style={{ height: 4, background: "#0c0a09", borderRadius: 2, overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${(amt / maxCat) * 100}%`, background: "#d97706", borderRadius: 2 }} />
              </div>
            </div>
          ))}
        </Card>
      </div>
    </div>
    </div>
  );
}

// ─── Surplus Overview ────────────────────────────────────────────────
// ─── Client Portal card (surplus deals) ─────────────────────────────
const portalUrl = () => {
  const base = window.location.href.split('?')[0].split('#')[0].replace(/[^/]*$/, '');
  return base + 'portal.html';
};
const attorneyPortalUrl = () => {
  const base = window.location.href.split('?')[0].split('#')[0].replace(/[^/]*$/, '');
  return base + 'attorney-portal.html';
};

function AttorneyAssignmentCard({ deal, logAct }) {
  const [assignments, setAssignments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const load = async () => {
    setLoading(true);
    const { data } = await sb.from('attorney_assignments').select('*').eq('deal_id', deal.id).order('created_at', { ascending: true });
    setAssignments(data || []);
    setLoading(false);
  };

  useEffect(() => { load(); }, [deal.id]);

  const invite = async () => {
    if (!email) return;
    setBusy(true); setMsg(null);
    try {
      const addr = email.trim().toLowerCase();
      const { error: insErr } = await sb.from('attorney_assignments').insert({ deal_id: deal.id, email: addr, enabled: true });
      if (insErr && !String(insErr.message).includes('duplicate')) throw insErr;
      const { error: otpErr } = await sb.auth.signInWithOtp({ email: addr, options: { emailRedirectTo: attorneyPortalUrl() } });
      if (otpErr) throw otpErr;
      if (logAct) await logAct(`Attorney invited to counsel portal: ${addr}`);
      setMsg({ type: 'success', text: `Magic link sent to ${addr}` });
      setEmail("");
      await load();
    } catch (e) {
      setMsg({ type: 'error', text: e.message });
    } finally {
      setBusy(false);
    }
  };

  const resend = async (row) => {
    if (!row.email) {
      setMsg({ type: 'error', text: "This attorney has already signed in. Share the portal URL directly." });
      return;
    }
    setBusy(true); setMsg(null);
    try {
      const { error } = await sb.auth.signInWithOtp({ email: row.email, options: { emailRedirectTo: attorneyPortalUrl() } });
      if (error) throw error;
      if (logAct) await logAct(`Counsel portal link resent: ${row.email}`);
      setMsg({ type: 'success', text: `Magic link resent to ${row.email}` });
    } catch (e) {
      setMsg({ type: 'error', text: e.message });
    } finally {
      setBusy(false);
    }
  };

  const toggleEnabled = async (row) => {
    setBusy(true); setMsg(null);
    await sb.from('attorney_assignments').update({ enabled: !row.enabled }).eq('id', row.id);
    if (logAct) await logAct(`Counsel portal ${!row.enabled ? 'enabled' : 'disabled'} for ${row.email || 'attorney'}`);
    await load();
    setBusy(false);
  };

  const remove = async (row) => {
    if (!window.confirm(`Remove counsel portal access for ${row.email || 'this attorney'}?`)) return;
    setBusy(true); setMsg(null);
    await sb.from('attorney_assignments').delete().eq('id', row.id);
    if (logAct) await logAct(`Counsel portal access removed for ${row.email || 'attorney'}`);
    await load();
    setBusy(false);
  };

  const copyUrl = () => {
    navigator.clipboard.writeText(attorneyPortalUrl());
    setMsg({ type: 'success', text: 'Counsel portal URL copied.' });
  };

  // Per-attorney invite link: ?email=&invite=1 pre-fills + auto-sends OTP.
  const inviteLinkFor = (address) => {
    if (!address) return attorneyPortalUrl();
    return attorneyPortalUrl() + '?email=' + encodeURIComponent(address) + '&invite=1';
  };

  const copyInviteLink = async (row) => {
    if (!row.email) {
      setMsg({ type: 'error', text: "This attorney has already signed in — share the bare portal URL instead." });
      return;
    }
    const link = inviteLinkFor(row.email);
    try {
      await navigator.clipboard.writeText(link);
      setMsg({ type: 'success', text: `Invite link copied — paste into email/SMS for ${row.email}` });
      if (logAct) logAct(`Counsel portal invite link copied for ${row.email}`);
    } catch (e) {
      setMsg({ type: 'error', text: 'Clipboard blocked. Link: ' + link });
    }
  };

  if (loading) return (<Card title="Counsel Portal" style={{ marginTop: 16 }}><div style={{ fontSize: 12, color: "#78716c" }}>Checking…</div></Card>);

  const titleSuffix = assignments.length > 0 ? ` · ${assignments.length} attorney${assignments.length === 1 ? '' : 's'}` : '';

  return (
    <Card title={"Counsel Portal" + titleSuffix} style={{ marginTop: 16 }}>
      {assignments.length === 0 && (
        <div style={{ fontSize: 12, color: "#a8a29e", marginBottom: 12, lineHeight: 1.5 }}>
          Invite an attorney to a scoped view of just this case. They can see status, timeline, documents, and case notes, and can post updates or upload filings. They will never see financials, other cases, or anything internal.
        </div>
      )}

      {assignments.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 16 }}>
          {assignments.map(row => {
            const statusColor = !row.enabled ? "#78716c" : (row.user_id ? "#10b981" : "#f59e0b");
            const statusText = !row.enabled ? "Disabled" : (row.user_id ? "Active" : "Invite pending");
            return (
              <div key={row.id} style={{ padding: "10px 12px", background: "#0c0a09", border: "1px solid #292524", borderRadius: 6 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
                  <span style={{ width: 7, height: 7, borderRadius: "50%", background: statusColor, display: "inline-block", flexShrink: 0 }}></span>
                  <span style={{ fontWeight: 700, color: statusColor }}>{statusText}</span>
                  <span style={{ color: "#78716c" }}>·</span>
                  <span style={{ color: "#d6d3d1", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.email || 'Attorney'}</span>
                  {row.last_seen_at && <span style={{ marginLeft: "auto", fontSize: 10, color: "#78716c" }}>seen {daysSince(row.last_seen_at)}d ago</span>}
                </div>
                <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
                  {row.enabled && row.email && (
                    <>
                      <button onClick={() => copyInviteLink(row)} disabled={busy} title="Copy a one-tap invite link for email/SMS. Attorney clicks → portal auto-sends magic-link email." style={{ ...btnGhost, fontSize: 11, padding: "4px 10px", borderColor: "#92400e", color: "#fbbf24" }}>📋 Copy invite link</button>
                      <button onClick={() => resend(row)} disabled={busy} title="Email the magic-link sign-in email to this attorney right now." style={{ ...btnGhost, fontSize: 11, padding: "4px 10px" }}>📧 Email now</button>
                    </>
                  )}
                  <button onClick={() => toggleEnabled(row)} disabled={busy} style={{ ...btnGhost, fontSize: 11, padding: "4px 10px" }}>{row.enabled ? 'Disable' : 'Enable'}</button>
                  <button onClick={() => remove(row)} disabled={busy} style={{ ...btnGhost, fontSize: 11, padding: "4px 10px", color: "#ef4444" }}>Remove</button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div style={{ fontSize: 11, color: "#78716c", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 700 }}>
        {assignments.length === 0 ? 'Invite attorney' : 'Add another attorney'}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="counsel@firm.com" style={{ ...inputStyle, flex: 1 }} onKeyDown={e => { if (e.key === 'Enter' && email) invite(); }} />
        <button onClick={invite} disabled={busy || !email} style={btnPrimary}>{busy ? 'Sending…' : 'Invite'}</button>
      </div>

      {assignments.length > 0 && (
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <button onClick={copyUrl} style={{ ...btnGhost, fontSize: 12 }}>Copy counsel portal URL</button>
        </div>
      )}

      {msg && (
        <div style={{ marginTop: 12, padding: "8px 12px", borderRadius: 6, background: msg.type === 'success' ? "#064e3b" : "#7f1d1d", color: msg.type === 'success' ? "#6ee7b7" : "#fca5a5", fontSize: 12 }}>
          {msg.text}
        </div>
      )}
    </Card>
  );
}

function ClientPortalCard({ deal, logAct }) {
  const [accessList, setAccessList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const load = async () => {
    setLoading(true);
    const { data } = await sb.from('client_access').select('*').eq('deal_id', deal.id).order('created_at', { ascending: true });
    setAccessList(data || []);
    setLoading(false);
  };

  useEffect(() => { load(); }, [deal.id]);

  const invite = async () => {
    if (!email) return;
    setBusy(true); setMsg(null);
    try {
      const addr = email.trim().toLowerCase();
      const { error: insErr } = await sb.from('client_access').insert({ deal_id: deal.id, email: addr, enabled: true });
      if (insErr && !String(insErr.message).includes('duplicate')) throw insErr;
      const { error: otpErr } = await sb.auth.signInWithOtp({ email: addr, options: { emailRedirectTo: portalUrl() } });
      if (otpErr) throw otpErr;
      if (logAct) await logAct(`Client portal invited: ${addr}`);
      setMsg({ type: 'success', text: `Magic link sent to ${addr}` });
      setEmail("");
      await load();
    } catch (e) {
      setMsg({ type: 'error', text: e.message });
    } finally {
      setBusy(false);
    }
  };

  const resend = async (row) => {
    if (!row.email) {
      setMsg({ type: 'error', text: "This claimant has already signed in. Share the portal URL directly." });
      return;
    }
    setBusy(true); setMsg(null);
    try {
      const { error } = await sb.auth.signInWithOtp({ email: row.email, options: { emailRedirectTo: portalUrl() } });
      if (error) throw error;
      if (logAct) await logAct(`Client portal link resent: ${row.email}`);
      setMsg({ type: 'success', text: `Magic link resent to ${row.email}` });
    } catch (e) {
      setMsg({ type: 'error', text: e.message });
    } finally {
      setBusy(false);
    }
  };

  const toggleEnabled = async (row) => {
    setBusy(true); setMsg(null);
    await sb.from('client_access').update({ enabled: !row.enabled }).eq('id', row.id);
    if (logAct) await logAct(`Client portal ${!row.enabled ? 'enabled' : 'disabled'} for ${row.email || 'claimant'}`);
    await load();
    setBusy(false);
  };

  const remove = async (row) => {
    if (!window.confirm(`Remove portal access for ${row.email || 'this claimant'}?`)) return;
    setBusy(true); setMsg(null);
    await sb.from('client_access').delete().eq('id', row.id);
    if (logAct) await logAct(`Client portal access removed for ${row.email || 'claimant'}`);
    await load();
    setBusy(false);
  };

  const copyUrl = () => {
    navigator.clipboard.writeText(portalUrl());
    setMsg({ type: 'success', text: 'Portal URL copied.' });
  };

  // Per-claimant invite link: ?email=&invite=1 pre-fills the portal sign-in
  // and auto-fires the magic-link send on page load. Client experience is
  // one tap from Nathan's SMS → "Check your email" → magic link.
  const inviteLinkFor = (address) => {
    if (!address) return portalUrl();
    return portalUrl() + '?email=' + encodeURIComponent(address) + '&invite=1';
  };

  const copyInviteLink = async (row) => {
    if (!row.email) {
      setMsg({ type: 'error', text: "This claimant has already signed in — share the bare portal URL instead." });
      return;
    }
    const link = inviteLinkFor(row.email);
    try {
      await navigator.clipboard.writeText(link);
      setMsg({ type: 'success', text: `Invite link copied — paste into iMessage/SMS for ${row.email}` });
      if (logAct) logAct(`Client portal invite link copied for ${row.email}`);
    } catch (e) {
      setMsg({ type: 'error', text: 'Clipboard blocked. Link: ' + link });
    }
  };

  if (loading) return (<Card title="Client Portal" style={{ marginTop: 16 }}><div style={{ fontSize: 12, color: "#78716c" }}>Checking…</div></Card>);

  const titleSuffix = accessList.length > 1 ? ` · ${accessList.length} claimants` : '';

  return (
    <Card title={"Client Portal" + titleSuffix} style={{ marginTop: 16 }}>
      {accessList.length === 0 && (
        <div style={{ fontSize: 12, color: "#a8a29e", marginBottom: 12, lineHeight: 1.5 }}>
          Invite one or more claimants to a read-only portal where they can see case status, attorney info, timeline, and documents. They'll never see internal expenses, notes, or other deals. For joint heirs or co-owners, invite each one separately.
        </div>
      )}

      {accessList.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 16 }}>
          {accessList.map(row => {
            const label = row.email || (row.user_id ? (row.last_seen_at ? `Active · last seen ${daysSince(row.last_seen_at)}d ago` : 'Active · not yet signed in') : 'Unknown');
            const statusColor = !row.enabled ? "#78716c" : (row.user_id ? "#10b981" : "#f59e0b");
            const statusText = !row.enabled ? "Disabled" : (row.user_id ? "Active" : "Invite pending");
            return (
              <div key={row.id} style={{ padding: "10px 12px", background: "#0c0a09", border: "1px solid #292524", borderRadius: 6 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
                      <span style={{ width: 7, height: 7, borderRadius: "50%", background: statusColor, display: "inline-block", flexShrink: 0 }}></span>
                      <span style={{ fontWeight: 700, color: statusColor }}>{statusText}</span>
                      <span style={{ color: "#78716c" }}>·</span>
                      <span style={{ color: "#d6d3d1", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.email || 'Client'}</span>
                    </div>
                  </div>
                </div>
                <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
                  {row.enabled && row.email && (
                    <>
                      <button onClick={() => copyInviteLink(row)} disabled={busy} title="Copy a one-tap invite link for iMessage/SMS. Client taps it → portal auto-sends them the magic-link email." style={{ ...btnGhost, fontSize: 11, padding: "4px 10px", borderColor: "#92400e", color: "#fbbf24" }}>📋 Copy invite link</button>
                      <button onClick={() => resend(row)} disabled={busy} title="Email the magic-link sign-in email to this claimant right now." style={{ ...btnGhost, fontSize: 11, padding: "4px 10px" }}>📧 Email now</button>
                    </>
                  )}
                  <button onClick={() => toggleEnabled(row)} disabled={busy} style={{ ...btnGhost, fontSize: 11, padding: "4px 10px" }}>{row.enabled ? 'Disable' : 'Enable'}</button>
                  <button onClick={() => remove(row)} disabled={busy} style={{ ...btnGhost, fontSize: 11, padding: "4px 10px", color: "#ef4444" }}>Remove</button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div style={{ fontSize: 11, color: "#78716c", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 700 }}>
        {accessList.length === 0 ? 'Invite client' : 'Add another claimant'}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="client@email.com" style={{ ...inputStyle, flex: 1 }} onKeyDown={e => { if (e.key === 'Enter' && email) invite(); }} />
        <button onClick={invite} disabled={busy || !email} style={btnPrimary}>{busy ? 'Sending…' : 'Invite'}</button>
      </div>

      {accessList.length > 0 && (
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <button onClick={copyUrl} style={{ ...btnGhost, fontSize: 12 }}>Copy portal URL</button>
        </div>
      )}

      {msg && (
        <div style={{ marginTop: 12, padding: "8px 12px", borderRadius: 6, background: msg.type === 'success' ? "#064e3b" : "#7f1d1d", color: msg.type === 'success' ? "#6ee7b7" : "#fca5a5", fontSize: 12 }}>
          {msg.text}
        </div>
      )}
    </Card>
  );
}

// ─── Welcome Video Card (DCC side) ──────────────────
// ─── Investor Portal cards (flip deals) ──────────────────────────────
// Two cards: InvestorPortalCard manages token-based share links;
// InvestorDetailsEditor fills out the buyer-facing deal fields that
// investor-portal.html reads from meta.investor jsonb.
// ─── Investor offers card — per-deal inbox + respond loop ───────────
function InvestorOffersCard({ deal, userId }) {
  const [offers, setOffers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [respondingId, setRespondingId] = useState(null);
  const [respondForm, setRespondForm] = useState({ mode: null, note: '' });

  const load = async () => {
    const { data } = await sb.from('investor_offers')
      .select('*, access:access_id(investor_name, investor_email, investor_phone)')
      .eq('deal_id', deal.id)
      .order('submitted_at', { ascending: false });
    setOffers(data || []);
    setLoading(false);
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [deal.id]);

  useEffect(() => {
    const ch = sb.channel('offers-' + deal.id)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'investor_offers', filter: `deal_id=eq.${deal.id}` }, load)
      .subscribe();
    return () => { sb.removeChannel(ch); };
    // eslint-disable-next-line
  }, [deal.id]);

  const respond = async (offer, newStatus) => {
    const payload = {
      status: newStatus,
      responded_at: new Date().toISOString(),
      responded_by: userId,
      response_note: respondForm.note.trim() || null,
    };
    await sb.from('investor_offers').update(payload).eq('id', offer.id);
    setRespondingId(null);
    setRespondForm({ mode: null, note: '' });
    load();
  };

  const pending = offers.filter(o => ['new', 'pof-requested', 'pof-confirmed'].includes(o.status));
  const history = offers.filter(o => !['new', 'pof-requested', 'pof-confirmed'].includes(o.status));
  const fmtMoney = v => v != null ? '$' + Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 }) : '—';

  const statusStyle = (s) => {
    if (s === 'accepted') return { bg: '#064e3b22', color: '#6ee7b7', border: '#065f46' };
    if (s === 'declined' || s === 'expired' || s === 'withdrawn') return { bg: '#7f1d1d22', color: '#fca5a5', border: '#7f1d1d' };
    if (s === 'countered') return { bg: '#78350f22', color: '#fbbf24', border: '#92400e' };
    return { bg: '#1e3a5f22', color: '#93c5fd', border: '#1e3a5f' };
  };

  if (offers.length === 0 && !loading) return null; // don't render empty state; offers card appears only when there's something

  return (
    <Card title="Investor Offers" style={{ marginTop: 16 }} action={
      <div style={{ fontSize: 10, color: "#78716c" }}>
        {pending.length > 0 ? `${pending.length} awaiting response` : `${offers.length} total`}
      </div>
    }>
      {pending.length > 0 && (
        <div style={{ marginBottom: history.length > 0 ? 16 : 0 }}>
          {pending.map(o => {
            const s = statusStyle(o.status);
            const isResponding = respondingId === o.id;
            return (
              <div key={o.id} style={{ marginBottom: 10, padding: "12px 14px", background: "#0c0a09", border: "1px solid #d97706", borderLeft: "4px solid #fbbf24", borderRadius: 8 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "flex-start", marginBottom: 8 }}>
                  <div style={{ flex: 1, minWidth: 220 }}>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
                      <div style={{ fontSize: 20, fontWeight: 700, fontFamily: "'DM Mono', monospace", color: "#fbbf24" }}>{fmtMoney(o.offer_price)}</div>
                      <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 7px", borderRadius: 3, background: s.bg, color: s.color, border: "1px solid " + s.border, letterSpacing: "0.08em", textTransform: "uppercase" }}>{o.status.replace(/-/g, ' ')}</span>
                      {o.financing_type && <span style={{ fontSize: 10, padding: "2px 7px", borderRadius: 3, background: "#1c1917", color: "#a8a29e", border: "1px solid #44403c", letterSpacing: "0.04em", textTransform: "uppercase" }}>{o.financing_type}</span>}
                    </div>
                    <div style={{ fontSize: 12, color: "#d6d3d1", marginTop: 4 }}>
                      {o.investor_name || o.access?.investor_name || 'Unnamed investor'}
                    </div>
                    <div style={{ fontSize: 11, color: "#78716c", marginTop: 6, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 6 }}>
                      {o.emd_amount  && <div>EMD: <b style={{ color: "#d6d3d1" }}>{fmtMoney(o.emd_amount)}</b></div>}
                      {o.closing_days && <div>Close: <b style={{ color: "#d6d3d1" }}>{o.closing_days}d</b></div>}
                      {o.title_company && <div>Title: <b style={{ color: "#d6d3d1" }}>{o.title_company}</b></div>}
                    </div>
                    {o.contingencies && <div style={{ fontSize: 11, color: "#a8a29e", marginTop: 6 }}><b>Contingencies:</b> {o.contingencies}</div>}
                    {o.notes && <div style={{ fontSize: 11, color: "#a8a29e", marginTop: 4 }}><b>Note:</b> {o.notes}</div>}
                    <div style={{ fontSize: 10, color: "#57534e", marginTop: 6, display: "flex", gap: 10, flexWrap: "wrap" }}>
                      <span>{new Date(o.submitted_at).toLocaleString()}</span>
                      {o.investor_phone && <a href={`tel:${o.investor_phone}`} style={{ color: "#fbbf24" }}>📞 {o.investor_phone}</a>}
                      {o.investor_email && <a href={`mailto:${o.investor_email}`} style={{ color: "#fbbf24" }}>✉ {o.investor_email}</a>}
                    </div>
                  </div>
                </div>

                {isResponding ? (
                  <div style={{ paddingTop: 10, borderTop: "1px solid #292524" }}>
                    <div style={{ fontSize: 10, fontWeight: 700, color: "#78716c", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 6 }}>
                      {respondForm.mode === 'accepted' ? 'Accept this offer' : respondForm.mode === 'countered' ? 'Counter — note to investor' : respondForm.mode === 'declined' ? 'Decline — optional note' : 'Request proof of funds'}
                    </div>
                    <textarea value={respondForm.note} onChange={e => setRespondForm({ ...respondForm, note: e.target.value })} rows={2} placeholder="Optional note shown to investor on portal" style={{ ...inputStyle, resize: "vertical", minHeight: 50, fontFamily: "inherit" }} />
                    <div style={{ display: "flex", gap: 6, marginTop: 8, justifyContent: "flex-end" }}>
                      <button onClick={() => { setRespondingId(null); setRespondForm({ mode: null, note: '' }); }} style={{ ...btnGhost, fontSize: 11 }}>Cancel</button>
                      <button onClick={() => respond(o, respondForm.mode)} style={{ ...btnPrimary, fontSize: 11 }}>Confirm {respondForm.mode}</button>
                    </div>
                  </div>
                ) : (
                  <div style={{ display: "flex", gap: 6, paddingTop: 8, borderTop: "1px solid #292524", flexWrap: "wrap" }}>
                    <button onClick={() => { setRespondingId(o.id); setRespondForm({ mode: 'accepted', note: '' }); }} style={{ ...btnGhost, fontSize: 11, color: "#6ee7b7", borderColor: "#065f46" }}>✓ Accept</button>
                    <button onClick={() => { setRespondingId(o.id); setRespondForm({ mode: 'countered', note: '' }); }} style={{ ...btnGhost, fontSize: 11, color: "#fbbf24", borderColor: "#92400e" }}>↺ Counter</button>
                    <button onClick={() => { setRespondingId(o.id); setRespondForm({ mode: 'pof-requested', note: 'Please send proof of funds so we can proceed.' }); }} style={{ ...btnGhost, fontSize: 11, color: "#93c5fd" }}>Request POF</button>
                    <button onClick={() => { setRespondingId(o.id); setRespondForm({ mode: 'declined', note: '' }); }} style={{ ...btnGhost, fontSize: 11, color: "#fca5a5", borderColor: "#7f1d1d" }}>✗ Decline</button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {history.length > 0 && (
        <div style={{ opacity: 0.7 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: "#78716c", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 8 }}>History</div>
          {history.map(o => {
            const s = statusStyle(o.status);
            return (
              <div key={o.id} style={{ padding: "8px 12px", marginBottom: 6, background: "#0c0a09", border: "1px solid #292524", borderRadius: 6, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <div style={{ flex: 1, minWidth: 180 }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                    <span style={{ fontSize: 14, fontWeight: 700, fontFamily: "'DM Mono', monospace", color: "#d6d3d1" }}>{fmtMoney(o.offer_price)}</span>
                    <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 7px", borderRadius: 3, background: s.bg, color: s.color, border: "1px solid " + s.border, letterSpacing: "0.06em", textTransform: "uppercase" }}>{o.status.replace(/-/g, ' ')}</span>
                    <span style={{ fontSize: 11, color: "#a8a29e" }}>{o.investor_name || o.access?.investor_name || '—'}</span>
                  </div>
                  {o.response_note && <div style={{ fontSize: 11, color: "#78716c", marginTop: 2, fontStyle: "italic" }}>"{o.response_note}"</div>}
                </div>
                <div style={{ fontSize: 10, color: "#57534e", flexShrink: 0 }}>
                  {o.responded_at ? new Date(o.responded_at).toLocaleDateString() : new Date(o.submitted_at).toLocaleDateString()}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

// Cross-deal inbox for walkthrough requests. Opens from the nav button.
function WalkthroughRequestsModal({ onClose, userId, onJumpToDeal }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('pending');

  const load = async () => {
    let q = sb.from('walkthrough_requests').select('*, deals(name, address)').order('created_at', { ascending: false }).limit(50);
    if (filter !== 'all') q = q.eq('status', filter);
    const { data } = await q;
    setRows(data || []);
    setLoading(false);
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [filter]);

  useEffect(() => {
    const ch = sb.channel('wt-modal')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'walkthrough_requests' }, load)
      .subscribe();
    return () => { sb.removeChannel(ch); };
    // eslint-disable-next-line
  }, [filter]);

  const mark = async (wr, status) => {
    await sb.from('walkthrough_requests')
      .update({ status, handled_at: new Date().toISOString(), handled_by: userId })
      .eq('id', wr.id);
    load();
  };

  return (
    <Modal onClose={onClose} title="🏠 Walkthrough Requests" wide>
      <div style={{ display: "flex", gap: 4, alignItems: "center", marginBottom: 16, flexWrap: "wrap", background: "#1c1917", borderRadius: 8, padding: 3, border: "1px solid #292524", width: "fit-content" }}>
        {['pending', 'contacted', 'scheduled', 'completed', 'dismissed', 'all'].map(s => (
          <button key={s} onClick={() => setFilter(s)} style={{
            padding: "5px 12px", borderRadius: 6,
            border: "1px solid " + (filter === s ? "#44403c" : "transparent"),
            background: filter === s ? "#292524" : "transparent",
            color: filter === s ? "#fafaf9" : "#78716c",
            fontSize: 12, fontWeight: filter === s ? 700 : 500,
            cursor: "pointer", fontFamily: "inherit", textTransform: "uppercase", letterSpacing: "0.06em",
          }}>{s}</button>
        ))}
      </div>

      {loading && <div style={{ padding: 20, textAlign: "center", color: "#78716c", fontSize: 12 }}>Loading…</div>}

      {!loading && rows.length === 0 && (
        <div style={{ padding: 40, textAlign: "center", color: "#78716c", border: "1px dashed #292524", borderRadius: 10 }}>
          {filter === 'pending' ? 'No pending walkthrough requests. You\'re clear.' : `No ${filter} requests.`}
        </div>
      )}

      {!loading && rows.map(w => {
        const d = w.deals;
        const addr = d?.address || d?.meta?.propertyAddress || w.deal_id;
        return (
          <div key={w.id} style={{ marginBottom: 10, padding: "12px 16px", background: "#1c1917", border: "1px solid " + (w.status === 'pending' ? "#d97706" : "#292524"), borderLeft: "3px solid " + (w.status === 'pending' ? "#fbbf24" : "#44403c"), borderRadius: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
              <div style={{ flex: 1, minWidth: 240 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: "#fafaf9" }}>
                  {w.investor_name || 'Unnamed investor'} · {d?.name || 'Unknown deal'}
                </div>
                <div style={{ fontSize: 11, color: "#a8a29e", marginTop: 2 }}>{addr}</div>
                {w.preferred_time && <div style={{ fontSize: 12, color: "#d6d3d1", marginTop: 6 }}>⏰ <b>Prefers:</b> {w.preferred_time}</div>}
                {w.investor_note && <div style={{ fontSize: 12, color: "#d6d3d1", marginTop: 4, lineHeight: 1.5 }}>📝 {w.investor_note}</div>}
                <div style={{ display: "flex", gap: 12, marginTop: 6, flexWrap: "wrap" }}>
                  {w.investor_phone && <a href={`tel:${w.investor_phone}`} style={{ color: "#fbbf24", fontSize: 12 }}>📞 {w.investor_phone}</a>}
                  {w.investor_email && <a href={`mailto:${w.investor_email}`} style={{ color: "#fbbf24", fontSize: 12 }}>✉ {w.investor_email}</a>}
                </div>
                <div style={{ fontSize: 10, color: "#57534e", marginTop: 6 }}>
                  {new Date(w.created_at).toLocaleString()}
                  {w.handled_at && <> · Handled {new Date(w.handled_at).toLocaleString()}</>}
                </div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-end", flexShrink: 0 }}>
                <button onClick={() => onJumpToDeal(w.deal_id)} style={{ ...btnGhost, fontSize: 11, padding: "4px 10px" }}>Open deal →</button>
                {w.status === 'pending' && (
                  <div style={{ display: "flex", gap: 4, flexWrap: "wrap", justifyContent: "flex-end" }}>
                    <button onClick={() => mark(w, 'contacted')} style={{ ...btnGhost, fontSize: 10, padding: "3px 8px", color: "#93c5fd" }}>Contacted</button>
                    <button onClick={() => mark(w, 'scheduled')} style={{ ...btnGhost, fontSize: 10, padding: "3px 8px", color: "#6ee7b7" }}>Scheduled</button>
                    <button onClick={() => mark(w, 'dismissed')} style={{ ...btnGhost, fontSize: 10, padding: "3px 8px", color: "#a8a29e" }}>Dismiss</button>
                  </div>
                )}
                {w.status !== 'pending' && (
                  <span style={{ fontSize: 10, fontWeight: 700, padding: "3px 8px", borderRadius: 3, background: "#1c1917", color: "#a8a29e", border: "1px solid #44403c", letterSpacing: "0.08em", textTransform: "uppercase" }}>{w.status}</span>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </Modal>
  );
}

// ─── Homeowner Intake card ──────────────────────────────────────────
// Generates a token link to send the homeowner so they can fill out the
// property questionnaire. Their submission auto-populates meta.investor.
function HomeownerIntakeCard({ deal, userId }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', phone: '' });
  const [copiedId, setCopiedId] = useState(null);

  const base = window.location.href.split('?')[0].split('#')[0].replace(/[^/]*$/, '');
  const buildLink = (token) => base + 'homeowner-intake.html?t=' + token;

  const load = async () => {
    const { data } = await sb.from('homeowner_intake_access')
      .select('*').eq('deal_id', deal.id).order('invited_at', { ascending: false });
    setRows(data || []);
    setLoading(false);
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [deal.id]);
  useEffect(() => {
    const ch = sb.channel('homeowner-intake-' + deal.id)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'homeowner_intake_access', filter: `deal_id=eq.${deal.id}` }, load)
      .subscribe();
    return () => { sb.removeChannel(ch); };
    // eslint-disable-next-line
  }, [deal.id]);

  const add = async () => {
    if (!form.name.trim() && !form.phone.trim()) { alert('Give the homeowner a name or phone so you know who this link is for.'); return; }
    setAdding(true);
    const { error } = await sb.from('homeowner_intake_access').insert({
      deal_id: deal.id,
      homeowner_name: form.name.trim() || null,
      homeowner_email: form.email.trim() || null,
      homeowner_phone: form.phone.trim() || null,
      invited_by: userId,
    });
    setAdding(false);
    if (error) { alert('Could not add: ' + error.message); return; }
    setForm({ name: '', email: '', phone: '' });
    load();
  };

  const revoke = async (row) => {
    if (!confirm(`Revoke ${row.homeowner_name || 'this link'}?`)) return;
    await sb.from('homeowner_intake_access').update({ enabled: false, revoked_at: new Date().toISOString() }).eq('id', row.id);
    load();
  };

  const copy = async (row) => {
    const link = buildLink(row.token);
    try { await navigator.clipboard.writeText(link); setCopiedId(row.id); setTimeout(() => setCopiedId(null), 2000); }
    catch { window.prompt('Copy this link:', link); }
  };

  return (
    <Card title="Homeowner Intake" style={{ marginTop: 16 }}>
      <div style={{ fontSize: 11, color: "#78716c", marginBottom: 12, lineHeight: 1.55 }}>
        Send the homeowner a link to fill out their own property survey (situation, mortgage, condition, mechanicals, access). Their answers auto-populate the investor-facing details — you don't re-type anything. SMS hits your phone the moment they submit.
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 8, marginBottom: 10 }}>
        <Field label="Homeowner name"><input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} style={inputStyle} placeholder="First and last" /></Field>
        <Field label="Phone"><input value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} style={inputStyle} placeholder="(513) 555-0100" /></Field>
        <Field label="Email"><input value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} style={inputStyle} placeholder="optional" /></Field>
      </div>
      <button onClick={add} disabled={adding} style={btnPrimary}>{adding ? 'Generating…' : '+ Generate intake link'}</button>

      <div style={{ marginTop: 16 }}>
        {loading ? null : rows.length === 0 ? null : rows.map(r => {
          const link = buildLink(r.token);
          const dead = !r.enabled || r.revoked_at;
          return (
            <div key={r.id} style={{ padding: "10px 12px", marginBottom: 8, background: "#0c0a09", border: "1px solid " + (r.completed_at ? "#065f46" : dead ? "#292524" : "#44403c"), borderLeft: "3px solid " + (r.completed_at ? "#10b981" : dead ? "#44403c" : "#d97706"), borderRadius: 6, opacity: dead && !r.completed_at ? 0.55 : 1 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <div style={{ flex: 1, minWidth: 180 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "#fafaf9" }}>
                    {r.homeowner_name || r.homeowner_phone || r.homeowner_email || 'Unnamed'}
                    {r.completed_at && <span style={{ marginLeft: 6, fontSize: 9, fontWeight: 700, padding: "2px 7px", borderRadius: 3, background: "#064e3b", color: "#6ee7b7", letterSpacing: "0.06em", textTransform: "uppercase" }}>✓ Completed</span>}
                  </div>
                  <div style={{ fontSize: 10, color: "#78716c", marginTop: 2 }}>
                    {[r.homeowner_email, r.homeowner_phone].filter(Boolean).join(' · ')}
                  </div>
                  <div style={{ fontSize: 10, color: "#57534e", marginTop: 2 }}>
                    Invited {new Date(r.invited_at).toLocaleDateString()}
                    {r.completed_at && <> · Completed {new Date(r.completed_at).toLocaleDateString()} · {r.submission_count} submission{r.submission_count === 1 ? '' : 's'}</>}
                    {r.last_viewed_at && !r.completed_at && <> · viewed {new Date(r.last_viewed_at).toLocaleDateString()}</>}
                    {dead && <span style={{ color: "#ef4444", marginLeft: 6 }}>· Revoked</span>}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                  {!dead && <button onClick={() => copy(r)} style={{ ...btnGhost, fontSize: 11, padding: "4px 10px", color: copiedId === r.id ? "#6ee7b7" : "#fbbf24" }}>{copiedId === r.id ? '✓ Copied' : '📋 Copy link'}</button>}
                  {!dead && <button onClick={() => revoke(r)} style={{ ...btnGhost, fontSize: 11, padding: "4px 10px", color: "#fca5a5" }}>Revoke</button>}
                </div>
              </div>
              {!dead && (
                <div style={{ fontSize: 10, color: "#57534e", marginTop: 6, fontFamily: "'DM Mono', monospace", wordBreak: "break-all" }}>{link}</div>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// Readable view of everything the homeowner submitted on the intake form.
// Data lives in deal.meta.investor.homeowner_said (set by submit_homeowner_intake
// RPC). Renders nothing until the homeowner has actually submitted — no blank
// card on deals where intake was never sent.
function HomeownerIntakeResponses({ deal }) {
  const said = deal?.meta?.investor?.homeowner_said;
  const submittedAt = deal?.meta?.investor?.homeowner_submitted_at;
  if (!said || typeof said !== 'object' || Object.keys(said).length === 0) return null;

  const HUMAN_LABELS = {
    situation: 'Their situation',
    situationDetails: 'Situation details',
    timeline: 'Timeline / urgency',
    mortgageLender: 'Mortgage lender',
    mortgageBalance: 'Approx. mortgage balance',
    monthlyPayment: 'Monthly payment',
    monthsBehind: 'Months behind',
    otherLiens: 'Other liens',
    beds: 'Bedrooms',
    baths: 'Bathrooms',
    sqft: 'Square feet',
    yearBuilt: 'Year built',
    lotSize: 'Lot size',
    occupancy: 'Who lives there',
    accessNotes: 'How to access the property',
    roof: 'Roof',
    hvac: 'HVAC',
    waterHeater: 'Water heater',
    electrical: 'Electrical',
    plumbing: 'Plumbing',
    windows: 'Windows',
    exterior: 'Exterior',
    basement: 'Basement',
    foundation: 'Foundation',
    knownIssues: 'Known issues',
    additionalNotes: 'Additional notes',
    contactPreference: 'Prefers contact by',
    bestTimeToCall: 'Best time to call',
  };

  const toLabel = (key) => HUMAN_LABELS[key] || key.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase());
  const formatValue = (v) => {
    if (v == null || v === '') return <span style={{ color: "#57534e", fontStyle: "italic" }}>—</span>;
    if (typeof v === 'object') return <pre style={{ margin: 0, fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#d6d3d1", whiteSpace: "pre-wrap" }}>{JSON.stringify(v, null, 2)}</pre>;
    const s = String(v);
    return <span style={{ color: "#fafaf9", whiteSpace: "pre-wrap" }}>{s}</span>;
  };

  // Group entries for readable rendering: narrative first, then property stats,
  // then condition/mechanicals, then catch-all. Unknown keys fall into 'other'.
  const narrative = ['situation', 'situationDetails', 'timeline', 'additionalNotes'];
  const mortgage = ['mortgageLender', 'mortgageBalance', 'monthlyPayment', 'monthsBehind', 'otherLiens'];
  const property = ['beds', 'baths', 'sqft', 'yearBuilt', 'lotSize', 'occupancy', 'accessNotes'];
  const condition = ['roof', 'hvac', 'waterHeater', 'electrical', 'plumbing', 'windows', 'exterior', 'basement', 'foundation', 'knownIssues'];
  const contact = ['contactPreference', 'bestTimeToCall'];

  const pickGroup = (keys) => keys.filter(k => said[k] != null && said[k] !== '').map(k => [k, said[k]]);
  const knownKeys = new Set([...narrative, ...mortgage, ...property, ...condition, ...contact]);
  const otherEntries = Object.entries(said).filter(([k, v]) => !knownKeys.has(k) && v != null && v !== '');

  const groups = [
    { label: '📖 Their story', entries: pickGroup(narrative) },
    { label: '💰 Mortgage + liens', entries: pickGroup(mortgage) },
    { label: '🏠 Property basics', entries: pickGroup(property) },
    { label: '🔧 Condition + mechanicals', entries: pickGroup(condition) },
    { label: '📞 How to reach them', entries: pickGroup(contact) },
    { label: '📎 Other', entries: otherEntries },
  ].filter(g => g.entries.length > 0);

  const totalFields = groups.reduce((s, g) => s + g.entries.length, 0);

  return (
    <Card title="What the homeowner said" style={{ marginTop: 16 }}>
      <div style={{ fontSize: 11, color: "#78716c", marginBottom: 14, lineHeight: 1.55 }}>
        Verbatim from the intake form
        {submittedAt && <> · submitted {new Date(submittedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</>}
        {' '}· {totalFields} field{totalFields === 1 ? '' : 's'} answered
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {groups.map(g => (
          <div key={g.label}>
            <div style={{ fontSize: 10, color: "#d97706", fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 8 }}>{g.label}</div>
            <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "8px 14px", alignItems: "start" }}>
              {g.entries.map(([key, value]) => (
                <React.Fragment key={key}>
                  <div style={{ fontSize: 12, color: "#a8a29e", fontWeight: 600, paddingTop: 2 }}>{toLabel(key)}</div>
                  <div style={{ fontSize: 13, lineHeight: 1.55 }}>{formatValue(value)}</div>
                </React.Fragment>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function InvestorPortalCard({ deal, userId }) {
  const [rows, setRows] = useState([]);
  const [walkthroughs, setWalkthroughs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', phone: '' });
  const [copiedId, setCopiedId] = useState(null);

  const base = window.location.href.split('?')[0].split('#')[0].replace(/[^/]*$/, '');
  const buildLink = (token) => base + 'investor-portal.html?t=' + token;

  const load = async () => {
    const [accessRes, wtRes] = await Promise.all([
      sb.from('investor_deal_access').select('*').eq('deal_id', deal.id).order('invited_at', { ascending: false }),
      sb.from('walkthrough_requests').select('*').eq('deal_id', deal.id).order('created_at', { ascending: false }).limit(20),
    ]);
    setRows(accessRes.data || []);
    setWalkthroughs(wtRes.data || []);
    setLoading(false);
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [deal.id]);

  // Realtime: when an investor submits a walkthrough request, pop it in
  useEffect(() => {
    const ch = sb.channel('walkthroughs-' + deal.id)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'walkthrough_requests', filter: `deal_id=eq.${deal.id}` }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'investor_deal_access', filter: `deal_id=eq.${deal.id}` }, load)
      .subscribe();
    return () => { sb.removeChannel(ch); };
    // eslint-disable-next-line
  }, [deal.id]);

  const markHandled = async (wr, status) => {
    await sb.from('walkthrough_requests')
      .update({ status, handled_at: new Date().toISOString(), handled_by: userId })
      .eq('id', wr.id);
    load();
  };

  const add = async () => {
    if (!form.name.trim() && !form.email.trim() && !form.phone.trim()) {
      alert('Add at least a name, email, or phone so we know who this link is for.');
      return;
    }
    setAdding(true);
    const { error } = await sb.from('investor_deal_access').insert({
      deal_id: deal.id,
      investor_name: form.name.trim() || null,
      investor_email: form.email.trim() || null,
      investor_phone: form.phone.trim() || null,
      invited_by: userId,
    });
    setAdding(false);
    if (error) { alert('Could not add: ' + error.message); return; }
    setForm({ name: '', email: '', phone: '' });
    load();
  };

  const revoke = async (row) => {
    if (!confirm(`Revoke ${row.investor_name || row.investor_email || 'this link'}? They won't be able to view the deal anymore.`)) return;
    await sb.from('investor_deal_access')
      .update({ enabled: false, revoked_at: new Date().toISOString() })
      .eq('id', row.id);
    load();
  };

  const reenable = async (row) => {
    await sb.from('investor_deal_access')
      .update({ enabled: true, revoked_at: null })
      .eq('id', row.id);
    load();
  };

  const copy = async (row) => {
    const link = buildLink(row.token);
    try {
      await navigator.clipboard.writeText(link);
      setCopiedId(row.id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch { window.prompt('Copy this link:', link); }
  };

  const pendingWts = walkthroughs.filter(w => w.status === 'pending');

  return (
    <Card title="Investor Portal" style={{ marginTop: 16 }}>
      {pendingWts.length > 0 && (
        <div style={{ marginBottom: 16, padding: "12px 14px", background: "#78350f22", border: "1px solid #d97706", borderLeft: "4px solid #fbbf24", borderRadius: 6 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: "#fbbf24", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 8 }}>
            🏠 Walkthrough request{pendingWts.length === 1 ? '' : 's'} · {pendingWts.length} pending
          </div>
          {pendingWts.map(w => (
            <div key={w.id} style={{ padding: "8px 0", borderTop: "1px solid #78350f" }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#fafaf9" }}>
                {w.investor_name || 'Unnamed investor'} wants to walk the property
              </div>
              <div style={{ fontSize: 11, color: "#d6d3d1", marginTop: 4, lineHeight: 1.5 }}>
                {w.preferred_time && <div>⏰ <b>When:</b> {w.preferred_time}</div>}
                {w.investor_note && <div>📝 {w.investor_note}</div>}
                {(w.investor_phone || w.investor_email) && (
                  <div style={{ marginTop: 4, display: "flex", gap: 10, flexWrap: "wrap" }}>
                    {w.investor_phone && <a href={`tel:${w.investor_phone}`} style={{ color: "#fbbf24" }}>📞 {w.investor_phone}</a>}
                    {w.investor_email && <a href={`mailto:${w.investor_email}`} style={{ color: "#fbbf24" }}>✉ {w.investor_email}</a>}
                  </div>
                )}
              </div>
              <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
                <button onClick={() => markHandled(w, 'contacted')} style={{ ...btnGhost, fontSize: 10, padding: "3px 8px", color: "#93c5fd" }}>Mark contacted</button>
                <button onClick={() => markHandled(w, 'scheduled')} style={{ ...btnGhost, fontSize: 10, padding: "3px 8px", color: "#6ee7b7" }}>Mark scheduled</button>
                <button onClick={() => markHandled(w, 'completed')} style={{ ...btnGhost, fontSize: 10, padding: "3px 8px", color: "#6ee7b7" }}>Completed</button>
                <button onClick={() => markHandled(w, 'dismissed')} style={{ ...btnGhost, fontSize: 10, padding: "3px 8px", color: "#a8a29e" }}>Dismiss</button>
              </div>
              <div style={{ fontSize: 9, color: "#57534e", marginTop: 4 }}>Requested {new Date(w.created_at).toLocaleString()}</div>
            </div>
          ))}
        </div>
      )}

      <div style={{ fontSize: 11, color: "#78716c", marginBottom: 12, lineHeight: 1.55 }}>
        Generate a share link for a buyer. They click the link — no signup — and see the Investor Details you fill in below (asking price, ARV, rehab, condition, photos, closing). Revoke anytime. Links auto-revoke when this deal is marked closed or dead.
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 8, marginBottom: 10 }}>
        <Field label="Buyer name"><input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} style={inputStyle} placeholder="Who is this?" /></Field>
        <Field label="Email"><input value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} style={inputStyle} placeholder="optional" /></Field>
        <Field label="Phone"><input value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} style={inputStyle} placeholder="optional" /></Field>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button onClick={add} disabled={adding} style={btnPrimary}>
          {adding ? 'Generating…' : '+ Generate share link'}
        </button>
        {rows.some(r => r.enabled && !r.revoked_at) && (
          <button
            onClick={async () => {
              const live = rows.filter(r => r.enabled && !r.revoked_at);
              if (!confirm(`Revoke access for all ${live.length} active investor link${live.length === 1 ? '' : 's'}? This cannot be undone; they'll need new links to view again.`)) return;
              await sb.from('investor_deal_access')
                .update({ enabled: false, revoked_at: new Date().toISOString() })
                .eq('deal_id', deal.id)
                .eq('enabled', true);
              load();
            }}
            style={{ ...btnGhost, color: "#fca5a5", borderColor: "#7f1d1d" }}
          >
            Revoke all active
          </button>
        )}
      </div>

      <div style={{ marginTop: 16 }}>
        {loading ? null : rows.length === 0 ? (
          <div style={{ fontSize: 12, color: "#78716c", fontStyle: "italic", padding: 12 }}>No investor links yet. Fill in the details above + click generate.</div>
        ) : (
          rows.map(r => {
            const link = buildLink(r.token);
            const dead = !r.enabled || r.revoked_at;
            return (
              <div key={r.id} style={{ padding: "10px 12px", marginBottom: 8, background: "#0c0a09", border: "1px solid " + (dead ? "#292524" : "#44403c"), borderRadius: 6, opacity: dead ? 0.55 : 1 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                  <div style={{ flex: 1, minWidth: 180 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "#fafaf9" }}>{r.investor_name || r.investor_email || r.investor_phone || 'Unnamed buyer'}</div>
                    <div style={{ fontSize: 10, color: "#78716c", marginTop: 2 }}>
                      {[r.investor_email, r.investor_phone].filter(Boolean).join(' · ')}
                    </div>
                    <div style={{ fontSize: 10, color: "#57534e", marginTop: 2 }}>
                      Invited {new Date(r.invited_at).toLocaleDateString()}
                      {r.view_count > 0 && <> · {r.view_count} view{r.view_count === 1 ? '' : 's'}</>}
                      {r.last_viewed_at && <> · last seen {new Date(r.last_viewed_at).toLocaleDateString()}</>}
                      {dead && <span style={{ color: "#ef4444", marginLeft: 6 }}>· Revoked</span>}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                    {!dead && <button onClick={() => window.open(link, '_blank')} style={{ ...btnGhost, fontSize: 11, padding: "4px 10px", color: "#93c5fd" }} title="Open the investor portal as the buyer sees it (new tab)">👁 Preview</button>}
                    {!dead && <button onClick={() => copy(r)} style={{ ...btnGhost, fontSize: 11, padding: "4px 10px", color: copiedId === r.id ? "#6ee7b7" : "#fbbf24" }}>{copiedId === r.id ? '✓ Copied' : '📋 Copy link'}</button>}
                    {!dead ? (
                      <button onClick={() => revoke(r)} style={{ ...btnGhost, fontSize: 11, padding: "4px 10px", color: "#fca5a5" }}>Revoke</button>
                    ) : (
                      <button onClick={() => reenable(r)} style={{ ...btnGhost, fontSize: 11, padding: "4px 10px", color: "#6ee7b7" }}>Re-enable</button>
                    )}
                  </div>
                </div>
                {!dead && (
                  <div style={{ fontSize: 10, color: "#57534e", marginTop: 6, fontFamily: "'DM Mono', monospace", wordBreak: "break-all" }}>{link}</div>
                )}
              </div>
            );
          })
        )}
      </div>
    </Card>
  );
}

// Module-scoped field components — MUST live outside PartnerDetailsEditor.
// If you put them inside the parent function each render creates a new
// component identity, React sees a different type, unmounts the input
// DOM node, and the focused input loses focus on every keystroke. Same
// trap that bit InvestorDetailsEditor; see comment near InvNumField.
function PartnerNumField({ label, k, step = 1, ph, p, updatePartner }) {
  return (
    <Field label={label}>
      <input type="number" step={step} value={p[k] ?? ''}
        onChange={e => updatePartner({ [k]: e.target.value === '' ? null : parseFloat(e.target.value) })}
        style={inputStyle} placeholder={ph} />
    </Field>
  );
}
function PartnerTxtField({ label, ph, val, onChange }) {
  return (
    <Field label={label}>
      <input value={val ?? ''} onChange={e => onChange(e.target.value || null)} style={inputStyle} placeholder={ph} />
    </Field>
  );
}
function PartnerDateField({ label, k, p, updatePartner }) {
  return (
    <Field label={label}>
      <input type="date" value={p[k] ?? ''} onChange={e => updatePartner({ [k]: e.target.value || null })} style={inputStyle} />
    </Field>
  );
}

// Milestones definition — one ordered list, used for both DCC editor + JV
// portal display. Single set covers flip + wholesale; users ignore steps
// that don't apply (e.g. inspection isn't always done on a wholesale).
const PARTNER_MILESTONES = [
  { key: 'contract',   label: 'Property under contract',   icon: '📝' },
  { key: 'buyer',      label: 'Buyer found',               icon: '🤝' },
  { key: 'assignment', label: 'Buyer signed assignment',   icon: '✍' },
  { key: 'emd',        label: 'Earnest money received',    icon: '💰' },
  { key: 'inspection', label: 'Inspection complete',       icon: '🔍' },
  { key: 'title',      label: 'Title cleared',             icon: '📋' },
  { key: 'closing',    label: 'Closing scheduled',         icon: '🗓' },
  { key: 'closed',     label: 'Closed',                    icon: '✅' },
];

// Card that lets Nathan check off milestones on a deal. State stored in
// deal.meta.partner.milestones as { [key]: { done, at, by } }. Kevin sees
// the same data rendered as a horizontal step indicator in his portal.
function PartnerMilestonesCard({ deal, onUpdateDeal, userName }) {
  const m = deal.meta || {};
  const p = m.partner || {};
  const milestones = p.milestones || {};

  const toggle = (key) => {
    const cur = milestones[key];
    const isDone = !!cur?.done;
    const next = isDone
      ? { ...milestones, [key]: { done: false } }
      : { ...milestones, [key]: { done: true, at: new Date().toISOString(), by: userName || 'Team' } };
    onUpdateDeal({ meta: { ...m, partner: { ...p, milestones: next } } });
  };

  const completedCount = PARTNER_MILESTONES.filter(s => milestones[s.key]?.done).length;
  const pct = Math.round((completedCount / PARTNER_MILESTONES.length) * 100);

  return (
    <Card title={`Milestones · ${completedCount} / ${PARTNER_MILESTONES.length}`}>
      <div style={{ fontSize: 11, color: '#78716c', marginBottom: 14, lineHeight: 1.55 }}>
        Tick a milestone as it happens. Kevin sees the timeline live in his portal — gives him "what's done, what's next" at a glance.
      </div>

      {/* Progress bar */}
      <div style={{ height: 6, background: '#1c1917', borderRadius: 3, marginBottom: 14, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: 'linear-gradient(to right, #d97706, #fbbf24)', transition: 'width 0.3s' }} />
      </div>

      {/* Step list */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 8 }}>
        {PARTNER_MILESTONES.map(step => {
          const data = milestones[step.key] || {};
          const done = !!data.done;
          return (
            <button
              key={step.key}
              onClick={() => toggle(step.key)}
              style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '10px 12px',
                background: done ? '#064e3b' : '#0c0a09',
                border: '1px solid ' + (done ? '#065f46' : '#292524'),
                borderRadius: 8,
                cursor: 'pointer',
                fontFamily: 'inherit',
                textAlign: 'left',
                transition: 'all 0.12s',
              }}
            >
              <div style={{
                width: 22, height: 22, flexShrink: 0,
                borderRadius: 5,
                border: '2px solid ' + (done ? '#10b981' : '#44403c'),
                background: done ? '#10b981' : 'transparent',
                color: '#0c0a09',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 13, fontWeight: 700,
              }}>{done ? '✓' : ''}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: done ? '#6ee7b7' : '#fafaf9' }}>
                  <span style={{ marginRight: 6 }}>{step.icon}</span>{step.label}
                </div>
                {done && data.at && (
                  <div style={{ fontSize: 10, color: '#86efac', marginTop: 2 }}>
                    {new Date(data.at).toLocaleDateString()}{data.by && ` · ${data.by}`}
                  </div>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </Card>
  );
}

// PartnerDetailsEditor: edits deal.meta.partner — the JV-partner-facing
// fields (deal economics, buyer info, title contacts, partner-tab task
// flagging happens on the Tasks tab). Mirrors InvestorDetailsEditor's
// shape but split into Pricing / Buyer / Title / Property sections.
function PartnerDetailsEditor({ deal, onUpdateDeal }) {
  const m = deal.meta || {};
  const p = m.partner || {};
  const updatePartner = (patch) => onUpdateDeal({ meta: { ...m, partner: { ...p, ...patch } } });
  const updateNested = (key, patch) => updatePartner({ [key]: { ...(p[key] || {}), ...patch } });
  const [sect, setSect] = useState('pricing');

  const sectionBtn = (id, label) => (
    <button key={id} onClick={() => setSect(id)} style={{ background: sect === id ? '#292524' : 'transparent', color: sect === id ? '#fafaf9' : '#78716c', border: '1px solid ' + (sect === id ? '#44403c' : 'transparent'), padding: '5px 12px', borderRadius: 5, fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>{label}</button>
  );

  const buyer = p.buyer || {};
  const title = p.title || {};
  const fp = { p, updatePartner };  // shared prop bag for number + date fields

  return (
    <Card title="JV-Facing Details" style={{ marginTop: 16 }}>
      <div style={{ fontSize: 11, color: "#78716c", marginBottom: 12, lineHeight: 1.55 }}>
        Numbers + contacts the JV partner needs to manage the deal end-to-end. They see this in their portal alongside their profit share.
      </div>
      <div style={{ display: 'flex', gap: 4, marginBottom: 14, background: '#0c0a09', border: '1px solid #292524', borderRadius: 8, padding: 3, flexWrap: 'wrap' }}>
        {sectionBtn('pricing', 'Pricing')}
        {sectionBtn('buyer', 'Buyer')}
        {sectionBtn('title', 'Title')}
        {sectionBtn('property', 'Property')}
      </div>

      {sect === 'pricing' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
          <PartnerNumField {...fp} label="Under contract at ($)" k="contractPrice" step={1000} ph="80000" />
          <PartnerNumField {...fp} label="Asking buyer ($)" k="askingPrice" step={1000} ph="100000" />
          <PartnerNumField {...fp} label="Assignment fee ($)" k="expectedAssignmentFee" step={500} ph="20000" />
          <PartnerNumField {...fp} label="Expected net profit ($)" k="expectedNetProfit" step={500} ph="20000" />
          <PartnerDateField {...fp} label="Target close date" k="expectedCloseDate" />
        </div>
      )}

      {sect === 'buyer' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
          <PartnerTxtField label="Buyer name" val={buyer.name} onChange={v => updateNested('buyer', { name: v })} ph="John Doe" />
          <PartnerTxtField label="Buyer phone" val={buyer.phone} onChange={v => updateNested('buyer', { phone: v })} ph="513-555-0123" />
          <PartnerTxtField label="Buyer email" val={buyer.email} onChange={v => updateNested('buyer', { email: v })} ph="john@…" />
          <PartnerTxtField label="Buyer entity / LLC" val={buyer.entity} onChange={v => updateNested('buyer', { entity: v })} ph="Doe Holdings LLC" />
          <div style={{ gridColumn: '1 / -1' }}>
            <Field label="Buyer notes (visible to JV partner)">
              <textarea value={buyer.notes ?? ''} onChange={e => updateNested('buyer', { notes: e.target.value || null })} style={{ ...inputStyle, minHeight: 60 }} placeholder="How they bought, terms, EMD, anything the partner should know…" />
            </Field>
          </div>
        </div>
      )}

      {sect === 'title' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
          <PartnerTxtField label="Title company" val={title.company} onChange={v => updateNested('title', { company: v })} ph="Ohio Title & Closing" />
          <PartnerTxtField label="Contact name" val={title.contact} onChange={v => updateNested('title', { contact: v })} ph="Jane Closer" />
          <PartnerTxtField label="Phone" val={title.phone} onChange={v => updateNested('title', { phone: v })} ph="513-555-0124" />
          <PartnerTxtField label="Email" val={title.email} onChange={v => updateNested('title', { email: v })} ph="jane@…" />
          <PartnerTxtField label="File #" val={title.fileNumber} onChange={v => updateNested('title', { fileNumber: v })} ph="OT-2026-…" />
        </div>
      )}

      {sect === 'property' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12 }}>
          <PartnerTxtField label="Beds" val={p.beds} onChange={v => updatePartner({ beds: v })} ph="3" />
          <PartnerTxtField label="Baths" val={p.baths} onChange={v => updatePartner({ baths: v })} ph="2" />
          <PartnerTxtField label="Sqft" val={p.sqft} onChange={v => updatePartner({ sqft: v })} ph="1450" />
          <PartnerTxtField label="Year built" val={p.yearBuilt} onChange={v => updatePartner({ yearBuilt: v })} ph="1962" />
          <PartnerTxtField label="Lot" val={p.lotSize} onChange={v => updatePartner({ lotSize: v })} ph="0.18 ac" />
          <PartnerTxtField label="Occupancy" val={p.occupancy} onChange={v => updatePartner({ occupancy: v })} ph="vacant / occupied" />
          <PartnerTxtField label="Condition" val={p.condition} onChange={v => updatePartner({ condition: v })} ph="rough / fair / good" />
        </div>
      )}
    </Card>
  );
}

// PartnerPortalCard: invite/revoke JV partner share links. Same shape as
// InvestorPortalCard but writes to partner_deal_access and uses the
// partner-portal.html target with profit_share_pct + role_description.
function PartnerPortalCard({ deal, userId }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', phone: '', share: '25', role: '' });
  const [copiedId, setCopiedId] = useState(null);

  const base = window.location.href.split('?')[0].split('#')[0].replace(/[^/]*$/, '');
  const buildLink = (token) => base + 'partner-portal.html?t=' + token;

  const load = async () => {
    const { data } = await sb.from('partner_deal_access').select('*').eq('deal_id', deal.id).order('invited_at', { ascending: false });
    setRows(data || []);
    setLoading(false);
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [deal.id]);

  useEffect(() => {
    const ch = sb.channel('partner-access-' + deal.id)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'partner_deal_access', filter: `deal_id=eq.${deal.id}` }, load)
      .subscribe();
    return () => { sb.removeChannel(ch); };
    // eslint-disable-next-line
  }, [deal.id]);

  const add = async () => {
    if (!form.name.trim() && !form.phone.trim() && !form.email.trim()) {
      alert('Add at least a name, phone, or email so we know who this link is for.');
      return;
    }
    const sharePct = parseFloat(form.share);
    if (Number.isNaN(sharePct) || sharePct <= 0 || sharePct > 100) {
      alert('Profit share % must be between 0 and 100.');
      return;
    }
    setAdding(true);
    const { error } = await sb.from('partner_deal_access').insert({
      deal_id: deal.id,
      partner_name: form.name.trim() || null,
      partner_email: form.email.trim() || null,
      partner_phone: form.phone.trim() || null,
      profit_share_pct: sharePct,
      role_description: form.role.trim() || null,
      invited_by: userId,
    });
    setAdding(false);
    if (error) { alert('Could not add: ' + error.message); return; }
    setForm({ name: '', email: '', phone: '', share: '25', role: '' });
    load();
  };

  const revoke = async (row) => {
    if (!confirm(`Revoke ${row.partner_name || row.partner_email || 'this link'}? They won't be able to view the deal anymore.`)) return;
    await sb.from('partner_deal_access').update({ enabled: false, revoked_at: new Date().toISOString() }).eq('id', row.id);
    load();
  };

  const reenable = async (row) => {
    await sb.from('partner_deal_access').update({ enabled: true, revoked_at: null }).eq('id', row.id);
    load();
  };

  const copy = async (row) => {
    const link = buildLink(row.token);
    try {
      await navigator.clipboard.writeText(link);
      setCopiedId(row.id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch { window.prompt('Copy this link:', link); }
  };

  return (
    <Card title="JV Partner Portal" style={{ marginTop: 16 }}>
      <div style={{ fontSize: 11, color: "#78716c", marginBottom: 12, lineHeight: 1.55 }}>
        Generate a share link for a JV partner. They see deal economics, their profit share, buyer + title contacts, the tasks flagged for them (mark <code style={{ background:'#1c1917', padding:'1px 4px', borderRadius: 3 }}>partner_visible</code> on tasks in the Tasks tab), and an activity feed they can post into. No signup. Revoke anytime.
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 8, marginBottom: 10 }}>
        <Field label="Partner name"><input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} style={inputStyle} placeholder="Kevin" /></Field>
        <Field label="Phone"><input value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} style={inputStyle} placeholder="optional" /></Field>
        <Field label="Email"><input value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} style={inputStyle} placeholder="optional" /></Field>
        <Field label="Profit share %"><input type="number" step="1" value={form.share} onChange={e => setForm({ ...form, share: e.target.value })} style={inputStyle} placeholder="25" /></Field>
      </div>
      <div style={{ marginBottom: 10 }}>
        <Field label="Role / responsibilities (shown on their portal)">
          <input value={form.role} onChange={e => setForm({ ...form, role: e.target.value })} style={inputStyle} placeholder="Photos, manage buyer, coordinate title, close, handoff" />
        </Field>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button onClick={add} disabled={adding} style={btnPrimary}>
          {adding ? 'Generating…' : '+ Generate JV link'}
        </button>
        {rows.some(r => r.enabled && !r.revoked_at) && (
          <button
            onClick={async () => {
              const live = rows.filter(r => r.enabled && !r.revoked_at);
              if (!confirm(`Revoke access for all ${live.length} active JV link${live.length === 1 ? '' : 's'}? They'll need new links to view again.`)) return;
              await sb.from('partner_deal_access').update({ enabled: false, revoked_at: new Date().toISOString() }).eq('deal_id', deal.id).eq('enabled', true);
              load();
            }}
            style={{ ...btnGhost, color: "#fca5a5", borderColor: "#7f1d1d" }}
          >
            Revoke all active
          </button>
        )}
      </div>

      <div style={{ marginTop: 16 }}>
        {loading ? null : rows.length === 0 ? (
          <div style={{ fontSize: 12, color: "#78716c", fontStyle: "italic", padding: 12 }}>No JV links yet. Fill in the partner's details + share %, click generate.</div>
        ) : (
          rows.map(r => {
            const link = buildLink(r.token);
            const dead = !r.enabled || r.revoked_at;
            return (
              <div key={r.id} style={{ padding: "10px 12px", marginBottom: 8, background: "#0c0a09", border: "1px solid " + (dead ? "#292524" : "#44403c"), borderRadius: 6, opacity: dead ? 0.55 : 1 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                  <div style={{ flex: 1, minWidth: 180 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "#fafaf9" }}>
                      {r.partner_name || r.partner_email || r.partner_phone || 'Unnamed partner'}
                      {' · '}<span style={{ color: '#fbbf24' }}>{Number(r.profit_share_pct)}%</span>
                    </div>
                    <div style={{ fontSize: 10, color: "#78716c", marginTop: 2 }}>
                      {[r.partner_email, r.partner_phone].filter(Boolean).join(' · ')}
                    </div>
                    {r.role_description && (
                      <div style={{ fontSize: 11, color: "#a8a29e", marginTop: 4, fontStyle: 'italic' }}>{r.role_description}</div>
                    )}
                    <div style={{ fontSize: 10, color: "#57534e", marginTop: 4 }}>
                      Invited {new Date(r.invited_at).toLocaleDateString()}
                      {r.view_count > 0 && <> · {r.view_count} view{r.view_count === 1 ? '' : 's'}</>}
                      {r.last_viewed_at && <> · last seen {new Date(r.last_viewed_at).toLocaleDateString()}</>}
                      {dead && <span style={{ color: "#ef4444", marginLeft: 6 }}>· Revoked</span>}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                    {!dead && <button onClick={() => window.open(link, '_blank')} style={{ ...btnGhost, fontSize: 11, padding: "4px 10px", color: "#93c5fd" }} title="Open the JV portal as Kevin sees it (new tab)">👁 Preview</button>}
                    {!dead && <button onClick={() => copy(r)} style={{ ...btnGhost, fontSize: 11, padding: "4px 10px", color: copiedId === r.id ? "#6ee7b7" : "#fbbf24" }}>{copiedId === r.id ? '✓ Copied' : '📋 Copy link'}</button>}
                    {!dead ? (
                      <button onClick={() => revoke(r)} style={{ ...btnGhost, fontSize: 11, padding: "4px 10px", color: "#fca5a5" }}>Revoke</button>
                    ) : (
                      <button onClick={() => reenable(r)} style={{ ...btnGhost, fontSize: 11, padding: "4px 10px", color: "#6ee7b7" }}>Re-enable</button>
                    )}
                  </div>
                </div>
                {!dead && (
                  <div style={{ fontSize: 10, color: "#57534e", marginTop: 6, fontFamily: "'DM Mono', monospace", wordBreak: "break-all" }}>{link}</div>
                )}
              </div>
            );
          })
        )}
      </div>
    </Card>
  );
}

// Helpers live at module level so React doesn't recreate them on every
// InvestorDetailsEditor render. (Defining them inside the parent function
// made the input lose focus on every keystroke because React sees a new
// component type each render and unmounts/remounts the DOM node.)
function InvNumField({ label, k, step = 1, placeholder, inv, updateInvestor }) {
  return (
    <Field label={label}>
      <input type="number" step={step} value={inv[k] ?? ''} onChange={e => updateInvestor({ [k]: e.target.value === '' ? null : parseFloat(e.target.value) })} style={inputStyle} placeholder={placeholder} />
    </Field>
  );
}
function InvTxtField({ label, k, placeholder, inv, updateInvestor }) {
  return (
    <Field label={label}>
      <input value={inv[k] ?? ''} onChange={e => updateInvestor({ [k]: e.target.value || null })} style={inputStyle} placeholder={placeholder} />
    </Field>
  );
}
function InvDateField({ label, k, inv, updateInvestor }) {
  return (
    <Field label={label}>
      <input type="date" value={inv[k] ?? ''} onChange={e => updateInvestor({ [k]: e.target.value || null })} style={inputStyle} />
    </Field>
  );
}
function InvSelField({ label, k, options, inv, updateInvestor }) {
  return (
    <Field label={label}>
      <select value={inv[k] ?? ''} onChange={e => updateInvestor({ [k]: e.target.value || null })} style={{ ...inputStyle, padding: "8px 10px" }}>
        <option value="">—</option>
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </Field>
  );
}
function InvCondGroup({ label, k, fields = ['age', 'condition'], inv, updateNested }) {
  const data = inv[k] || {};
  return (
    <Field label={label}>
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${fields.length}, 1fr)`, gap: 6 }}>
        {fields.map(f => (
          <input
            key={f}
            value={data[f] ?? ''}
            onChange={e => updateNested(k, { [f]: e.target.value || null })}
            style={{ ...inputStyle, fontSize: 12, padding: "6px 8px" }}
            placeholder={f}
          />
        ))}
      </div>
    </Field>
  );
}

// AI listing copy: calls Claude via generate-listing-copy Edge Function.
// Reads deal meta.investor + analyzed docs, returns a 120-220 word buyer-
// facing description. Nathan reviews + accepts into meta.investor.investorNotes.
function AIListingCopyButton({ deal, onAccept }) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [err, setErr] = useState(null);

  const generate = async () => {
    setLoading(true); setErr(null); setResult(null);
    try {
      const { data: sess } = await sb.auth.getSession();
      const token = sess?.session?.access_token;
      const r = await fetch(SUPABASE_URL + '/functions/v1/generate-listing-copy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + (token || SUPABASE_KEY) },
        body: JSON.stringify({ deal_id: deal.id }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Claude unavailable');
      setResult(j.listing_copy || '');
    } catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  };

  return (
    <div style={{ marginTop: 8 }}>
      <button onClick={generate} disabled={loading} style={{ ...btnGhost, fontSize: 11, color: "#fbbf24", borderColor: "#92400e" }}>
        {loading ? '✨ Writing…' : '✨ Generate with AI'}
      </button>
      {err && <div style={{ fontSize: 11, color: "#fca5a5", marginTop: 6 }}>{err}</div>}
      {result && (
        <div style={{ marginTop: 10, padding: "12px 14px", background: "#0c0a09", border: "1px solid #44403c", borderRadius: 6 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: "#fbbf24", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 6 }}>✨ Claude's draft — review + edit</div>
          <div style={{ fontSize: 13, color: "#d6d3d1", lineHeight: 1.6, whiteSpace: "pre-wrap", marginBottom: 10 }}>{result}</div>
          <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
            <button onClick={() => setResult(null)} style={{ ...btnGhost, fontSize: 11 }}>Dismiss</button>
            <button onClick={() => { onAccept(result); setResult(null); }} style={btnPrimary}>Accept into notes</button>
          </div>
        </div>
      )}
    </div>
  );
}

function InvestorDetailsEditor({ deal, onUpdateDeal }) {
  const m = deal.meta || {};
  const inv = m.investor || {};
  const updateInvestor = (patch) => onUpdateDeal({ meta: { ...m, investor: { ...inv, ...patch } } });
  const updateNested = (key, patch) => updateInvestor({ [key]: { ...(inv[key] || {}), ...patch } });
  const [sect, setSect] = useState('pricing'); // pricing | property | condition | closing | other

  const sectionBtn = (id, label) => (
    <button key={id} onClick={() => setSect(id)} style={{ background: sect === id ? '#292524' : 'transparent', color: sect === id ? '#fafaf9' : '#78716c', border: '1px solid ' + (sect === id ? '#44403c' : 'transparent'), padding: '5px 12px', borderRadius: 5, fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>{label}</button>
  );

  // Shared prop bag so each field call stays tidy
  const fp = { inv, updateInvestor, updateNested };

  return (
    <Card title="Investor-Facing Details" style={{ marginTop: 16 }}>
      <div style={{ display: 'flex', gap: 4, marginBottom: 14, background: '#0c0a09', border: '1px solid #292524', borderRadius: 8, padding: 3, flexWrap: 'wrap' }}>
        {sectionBtn('pricing', 'Pricing')}
        {sectionBtn('property', 'Property')}
        {sectionBtn('condition', 'Condition')}
        {sectionBtn('closing', 'Closing')}
        {sectionBtn('other', 'Other')}
      </div>

      {sect === 'pricing' && (
        <div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginBottom: 14 }}>
            <InvNumField {...fp} label="Asking price" k="askingPrice" step={1000} placeholder="200000" />
            <InvNumField {...fp} label="Starting price" k="startingPrice" step={1000} placeholder="195000" />
            <InvNumField {...fp} label="Buy-it-now" k="buyItNowPrice" step={1000} placeholder="210000" />
            <InvNumField {...fp} label="ARV estimate" k="arvEstimate" step={1000} placeholder="290000" />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginBottom: 14 }}>
            <InvNumField {...fp} label="Rehab (low)" k="rehabCostLow" step={500} placeholder="10000" />
            <InvNumField {...fp} label="Rehab (high)" k="rehabCostHigh" step={500} placeholder="25000" />
            <InvNumField {...fp} label="Rehab (single est.)" k="rehabEstimate" step={500} placeholder="15000" />
            <InvSelField {...fp} label="Rehab scope" k="rehabScope" options={[{value:'turnkey',label:'Turnkey'},{value:'light',label:'Light'},{value:'major',label:'Major'},{value:'full',label:'Full gut'}]} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
            <InvSelField {...fp} label="Deal type" k="dealType" options={[{value:'wholesale',label:'Wholesale'},{value:'wholetail',label:'Wholetail'},{value:'fix-flip',label:'Fix & Flip'},{value:'fixed-price',label:'Fixed-price buy'}]} />
            <InvDateField {...fp} label="Accept offers until" k="acceptOffersUntil" />
          </div>
          <div style={{ fontSize: 10, color: "#57534e", marginTop: 10, lineHeight: 1.5 }}>
            Leave Starting / Buy-it-now blank to just show the Asking price. Rehab low/high render as a range; fallback to single estimate if range is blank. Accept-offers-until puts a countdown on the buyer portal and forces decisions.
          </div>
        </div>
      )}

      {sect === 'property' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
          <InvTxtField {...fp} label="Address (portal)" k="propertyAddress" placeholder={deal.address || '123 Main St'} />
          <InvNumField {...fp} label="Beds" k="beds" placeholder="4" />
          <InvNumField {...fp} label="Baths" k="baths" step={0.5} placeholder="2.5" />
          <InvNumField {...fp} label="Sqft" k="sqft" placeholder="2140" />
          <InvNumField {...fp} label="Year built" k="yearBuilt" placeholder="1998" />
          <InvTxtField {...fp} label="Lot size" k="lotSize" placeholder="0.24 acres" />
          <InvTxtField {...fp} label="Parcel #" k="parcelId" placeholder="M5620-096-000-007" />
          <InvSelField {...fp} label="Occupancy" k="occupancy" options={[{value:'vacant',label:'Vacant'},{value:'owner-occupied',label:'Owner-occupied'},{value:'tenant-occupied',label:'Tenant-occupied'}]} />
          <InvTxtField {...fp} label="Access notes" k="accessNotes" placeholder="Call Nathan 24h ahead" />
        </div>
      )}

      {sect === 'condition' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
          <InvCondGroup {...fp} label="Roof" k="roof" fields={['age','condition','material']} />
          <InvCondGroup {...fp} label="HVAC" k="hvac" fields={['age','condition']} />
          <InvCondGroup {...fp} label="Water heater" k="waterHeater" fields={['age','condition']} />
          <InvCondGroup {...fp} label="Electrical" k="electrical" fields={['updated','condition']} />
          <InvCondGroup {...fp} label="Plumbing" k="plumbing" fields={['updated','condition']} />
          <InvCondGroup {...fp} label="Windows" k="windows" fields={['age','condition']} />
          <InvCondGroup {...fp} label="Exterior" k="exterior" fields={['type','age','condition']} />
          <InvCondGroup {...fp} label="Basement" k="basement" fields={['type','condition']} />
          <InvCondGroup {...fp} label="Foundation" k="foundation" fields={['condition','notes']} />
          <Field label="Known issues" style={{ gridColumn: '1 / -1' }}>
            <textarea value={inv.knownIssues ?? ''} onChange={e => updateInvestor({ knownIssues: e.target.value || null })} style={{ ...inputStyle, minHeight: 70, resize: 'vertical', fontFamily: 'inherit' }} placeholder="Anything the buyer should know: roof leaks, foundation cracks, settlement, mold history, pending permits…" />
          </Field>
        </div>
      )}

      {sect === 'closing' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
          <InvTxtField  {...fp} label="Title company" k="titleCompany" placeholder="Stewart Title Cincinnati" />
          <InvTxtField  {...fp} label="Title contact" k="titleContactName" placeholder="Jen Smith" />
          <InvTxtField  {...fp} label="Title phone" k="titleContactPhone" placeholder="(513) 555-0100" />
          <InvTxtField  {...fp} label="Title email" k="titleContactEmail" placeholder="jen@stewart.com" />
          <InvDateField {...fp} label="Target close" k="targetCloseDate" />
          <InvNumField  {...fp} label="Earnest $" k="earnestMoneyAmount" step={500} placeholder="2500" />
          <InvNumField  {...fp} label="Inspection days" k="inspectionDays" placeholder="7" />
          <InvDateField {...fp} label="Auction date (foreclosure)" k="auctionDate" />
          <InvNumField  {...fp} label="Judgment amount" k="judgmentAmount" step={1000} placeholder="141697" />
          <InvNumField  {...fp} label="Lien payoff" k="lienPayoff" step={500} placeholder="147500" />
          <InvTxtField  {...fp} label="Case number" k="caseNumber" placeholder={m.courtCase || 'CV 2022 08 1416'} />
        </div>
      )}

      {sect === 'other' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 12 }}>
          <InvTxtField {...fp} label="Walkthrough video URL (YouTube / Vimeo / .mp4)" k="videoUrl" placeholder="https://youtu.be/..." />
          <Field label="Cover photo path">
            <input value={inv.coverPhotoPath ?? ''} onChange={e => updateInvestor({ coverPhotoPath: e.target.value || null })} style={inputStyle} placeholder="Set from Documents tab — mark a photo investor-visible + click ★ to pick cover" />
          </Field>

          <Field label="Notes for investors">
            <textarea value={inv.investorNotes ?? ''} onChange={e => updateInvestor({ investorNotes: e.target.value || null })} style={{ ...inputStyle, minHeight: 120, resize: 'vertical', fontFamily: 'inherit' }} placeholder="Why this deal? Story, timeline, any special terms. Shown on the portal under property stats." />
            <AIListingCopyButton deal={deal} onAccept={(copy) => updateInvestor({ investorNotes: copy })} />
          </Field>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12, marginTop: 8 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: "10px 12px", background: "#0c0a09", border: "1px solid " + (inv.verified ? "#065f46" : "#292524"), borderRadius: 6, cursor: 'pointer' }}>
              <input type="checkbox" checked={!!inv.verified} onChange={e => updateInvestor({ verified: e.target.checked })} />
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: inv.verified ? "#6ee7b7" : "#d6d3d1" }}>✓ Verified Deal</div>
                <div style={{ fontSize: 10, color: "#78716c", marginTop: 2 }}>Contract signed + docs in hand. Shows a trust badge on the portal.</div>
              </div>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: "10px 12px", background: "#0c0a09", border: "1px solid " + (inv.address_gated ? "#78350f" : "#292524"), borderRadius: 6, cursor: 'pointer' }}>
              <input type="checkbox" checked={!!inv.address_gated} onChange={e => updateInvestor({ address_gated: e.target.checked })} />
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: inv.address_gated ? "#fbbf24" : "#d6d3d1" }}>📍 Address gating</div>
                <div style={{ fontSize: 10, color: "#78716c", marginTop: 2 }}>Hide the full address until investor clicks "Request full address". Blocks drive-by deal-stealers.</div>
              </div>
            </label>
          </div>
        </div>
      )}

      <div style={{ fontSize: 10, color: "#57534e", marginTop: 12, lineHeight: 1.5 }}>
        All fields save live. What you type here shows up on any active investor link within 1-2 seconds.
      </div>
    </Card>
  );
}

function WelcomeVideoCard({ deal, logAct, onUpdateDeal }) {
  const m = deal.meta || {};
  const wv = m.welcome_video;
  const [uploading, setUploading] = useState(false);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [err, setErr] = useState(null);
  const fileRef = useRef(null);

  useEffect(() => {
    if (!wv?.path) { setPreviewUrl(null); return; }
    (async () => {
      const { data } = await sb.storage.from('deal-docs').createSignedUrl(wv.path, 3600);
      if (data?.signedUrl) setPreviewUrl(data.signedUrl);
    })();
  }, [wv?.path]);

  const upload = async (file) => {
    if (!file) return;
    if (!file.type.startsWith('video/')) { setErr('That file is not a video.'); return; }
    if (file.size > 100 * 1024 * 1024) { setErr('Video must be under 100MB. Trim it shorter or lower quality.'); return; }
    setUploading(true); setErr(null);
    try {
      // Delete old if exists
      if (wv?.path) {
        await sb.storage.from('deal-docs').remove([wv.path]);
      }
      const ext = file.name.split('.').pop().toLowerCase();
      const path = `${deal.id}/welcome-video-${Date.now()}.${ext}`;
      const up = await sb.storage.from('deal-docs').upload(path, file, { contentType: file.type });
      if (up.error) throw up.error;
      await onUpdateDeal({
        meta: {
          ...m,
          welcome_video: {
            path,
            uploaded_at: new Date().toISOString(),
            size: file.size,
            content_type: file.type,
            original_name: file.name,
          }
        }
      });
      if (logAct) await logAct(`Welcome video uploaded`);
    } catch (e) {
      setErr(e.message || 'Upload failed');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const remove = async () => {
    if (!wv?.path) return;
    if (!window.confirm('Remove the welcome video from this deal? It will disappear from the client portal.')) return;
    await sb.storage.from('deal-docs').remove([wv.path]);
    const { welcome_video, ...rest } = m;
    await onUpdateDeal({ meta: rest });
    if (logAct) await logAct(`Welcome video removed`);
  };

  return (
    <Card title="Welcome Video" style={{ marginTop: 16 }}>
      <div style={{ fontSize: 12, color: "#a8a29e", marginBottom: 12, lineHeight: 1.5 }}>
        Record a 60-second video on your phone — just "Hi [client name], I'm Nathan. I saw your case come in. Here's what's next. Call me anytime." Upload it and it appears at the top of their portal as the very first thing they see. This is the single highest-trust moment you can give a client.
      </div>
      {wv?.path && previewUrl && (
        <div style={{ marginBottom: 12, padding: 10, background: "#0c0a09", border: "1px solid #292524", borderRadius: 6 }}>
          <video controls src={previewUrl} style={{ width: "100%", borderRadius: 4, maxHeight: 280, background: "#000" }} preload="metadata" />
          <div style={{ fontSize: 10, color: "#78716c", marginTop: 8 }}>
            Uploaded {new Date(wv.uploaded_at).toLocaleDateString()} · {(wv.size / 1024 / 1024).toFixed(1)}MB · {wv.original_name || 'welcome-video'}
          </div>
        </div>
      )}
      {err && <div style={{ fontSize: 12, color: "#fca5a5", marginBottom: 10 }}>{err}</div>}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <label style={{ ...btnPrimary, cursor: uploading ? "wait" : "pointer", display: "inline-block", opacity: uploading ? 0.5 : 1 }}>
          {uploading ? 'Uploading…' : (wv?.path ? 'Replace video' : '+ Upload video')}
          <input ref={fileRef} type="file" accept="video/*" style={{ display: "none" }} disabled={uploading} onChange={e => upload(e.target.files[0])} />
        </label>
        {wv?.path && <button onClick={remove} disabled={uploading} style={btnGhost}>Remove</button>}
      </div>
      <div style={{ fontSize: 10, color: "#57534e", marginTop: 10, lineHeight: 1.5 }}>
        Supported: any video your phone records (mp4, mov, webm). Max 100MB. Keep it under 90 seconds — it plays better and clients are more likely to watch the whole thing.
      </div>
    </Card>
  );
}

// ─── Case Intelligence ───────────────────────────────────────────────
// Synthesizes every AI-extracted document + recent docket event on this
// deal into a single glanceable "here's what we know" card at the top
// of the deal Overview. Pulls financial facts (judgment amount, appraised
// value, sale price, surplus, min bid) into big-number tiles, lists the
// one-line AI summaries of each analyzed document, and surfaces the last
// 3 non-backfill docket events. Renders nothing until at least one
// document has been analyzed, so new deals don't show an empty shell.
function IntelTile({ label, value, tone = 'neutral', subtle = false }) {
  const toneMap = {
    red:     { border: '#991b1b', color: '#fca5a5' },
    blue:    { border: '#1e40af', color: '#93c5fd' },
    amber:   { border: '#92400e', color: '#fbbf24' },
    green:   { border: '#065f46', color: '#6ee7b7' },
    gold:    { border: '#b45309', color: '#fcd34d' },
    neutral: { border: '#44403c', color: '#d6d3d1' },
  };
  const t = toneMap[tone] || toneMap.neutral;
  return (
    <div style={{ padding: "8px 10px", background: "#0c0a09", border: "1px solid " + t.border, borderRadius: 6, opacity: subtle ? 0.75 : 1 }}>
      <div style={{ fontSize: 9, fontWeight: 700, color: "#78716c", letterSpacing: "0.08em", textTransform: "uppercase" }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 700, color: t.color, marginTop: 2, fontFamily: "'DM Mono', monospace" }}>{value}</div>
    </div>
  );
}

// CourtPullButton — requests an on-demand court docket fetch for a deal.
// Inserts a row into court_pull_requests, then Castle (Mac Mini daemon)
// picks it up, runs the county scraper, uploads PDFs, inserts documents +
// docket_events. Renders latest request status inline so Nathan can see
// what's happening without leaving the deal.
//
// Currently supported counties (Castle side): Butler, Franklin. Others
// accept the request but Castle will mark them failed with "scraper not
// built yet" — that's the signal to build the scraper.
const COURT_PULL_SUPPORTED_COUNTIES = new Set(['Butler', 'Franklin']);

function CourtPullButton({ dealId, caseNumber, county, userId }) {
  const [latest, setLatest] = useState(null);
  const [loading, setLoading] = useState(true);
  const [requesting, setRequesting] = useState(false);
  const [err, setErr] = useState(null);

  const load = async () => {
    const { data } = await sb.from('court_pull_requests')
      .select('*')
      .eq('deal_id', dealId)
      .order('requested_at', { ascending: false })
      .limit(1);
    setLatest((data && data[0]) || null);
    setLoading(false);
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [dealId]);

  useEffect(() => {
    const ch = sb.channel('court-pulls-' + dealId)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'court_pull_requests', filter: `deal_id=eq.${dealId}` }, load)
      .subscribe();
    return () => { sb.removeChannel(ch); };
    // eslint-disable-next-line
  }, [dealId]);

  const trimmedCase = (caseNumber || '').trim();
  const trimmedCounty = (county || '').trim();
  const canRequest = !!trimmedCase && !!trimmedCounty;
  const isPending = latest && ['queued', 'processing'].includes(latest.status);

  const request = async () => {
    if (!canRequest) return;
    setRequesting(true); setErr(null);
    const { error } = await sb.from('court_pull_requests').insert({
      deal_id: dealId,
      case_number: trimmedCase,
      county: trimmedCounty,
      requested_by: userId,
    });
    setRequesting(false);
    if (error) { setErr(error.message); return; }
    await load();
  };

  if (loading) return null;

  const supported = COURT_PULL_SUPPORTED_COUNTIES.has(trimmedCounty);

  // Status pill for the latest request (if any)
  const statusLabel = latest && (() => {
    const ago = Math.round((Date.now() - new Date(latest.requested_at).getTime()) / 60000);
    const agoText = ago < 1 ? 'just now' : ago < 60 ? `${ago}m ago` : `${Math.round(ago/60)}h ago`;
    if (latest.status === 'queued')     return { text: `Queued · ${agoText}`, color: '#78716c', bg: '#1c1917' };
    if (latest.status === 'processing') return { text: `Pulling from ${latest.county}… · ${agoText}`, color: '#93c5fd', bg: '#1e3a5f' };
    if (latest.status === 'done')       return { text: `✓ Last pulled ${agoText} · ${latest.documents_added || 0} docs · ${latest.events_added || 0} events`, color: '#6ee7b7', bg: '#064e3b' };
    if (latest.status === 'failed')     return { text: `Failed · ${latest.error || 'see request log'}`, color: '#fca5a5', bg: '#7f1d1d' };
    if (latest.status === 'cancelled')  return { text: `Cancelled · ${agoText}`, color: '#a8a29e', bg: '#1c1917' };
    return null;
  })();

  return (
    <div style={{ marginTop: 10, padding: "10px 12px", background: "#0c0a09", border: "1px solid #292524", borderRadius: 6 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <button
          onClick={request}
          disabled={!canRequest || isPending || requesting}
          style={{
            ...btnGhost,
            fontSize: 11,
            padding: "5px 12px",
            color: canRequest && !isPending ? "#fbbf24" : "#57534e",
            borderColor: canRequest && !isPending ? "#92400e" : "#292524",
            cursor: canRequest && !isPending ? "pointer" : "not-allowed",
          }}
          title={!trimmedCase ? "Enter a court case number first" : !trimmedCounty ? "Enter a county first" : !supported ? "Scraper for this county isn't built yet — request will queue anyway" : "Ask Castle to pull this case from the court and populate documents + docket events"}
        >
          {requesting ? 'Queuing…' : isPending ? 'Pull in progress…' : '🔍 Pull from court'}
        </button>
        {!canRequest && (
          <span style={{ fontSize: 10, color: "#78716c" }}>
            {!trimmedCase && !trimmedCounty ? 'Fill in Case # and County to enable' : !trimmedCase ? 'Missing Case #' : 'Missing County'}
          </span>
        )}
        {canRequest && !supported && !isPending && (
          <span style={{ fontSize: 10, color: "#d97706" }}>⚠ {trimmedCounty} scraper not built yet — request will queue for build</span>
        )}
        {statusLabel && (
          <span style={{ fontSize: 10, fontWeight: 600, padding: "3px 8px", borderRadius: 3, background: statusLabel.bg, color: statusLabel.color, letterSpacing: "0.04em" }}>
            {statusLabel.text}
          </span>
        )}
      </div>
      {err && <div style={{ fontSize: 10, color: "#fca5a5", marginTop: 6 }}>{err}</div>}
    </div>
  );
}

// Compact notes card for the deal Overview. Shows the 3 most recent
// deal_notes plus an inline quick-add input. Full notes editor still
// lives on the Files tab — this is for scribbling observations while
// you're working the lead.
function QuickNotes({ dealId, userId, userName, onJumpToTab }) {
  const [notes, setNotes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState('');
  const [adding, setAdding] = useState(false);

  const load = async () => {
    const { data } = await sb.from('deal_notes')
      .select('id, title, body, author_id, created_at, updated_at')
      .eq('deal_id', dealId)
      .order('updated_at', { ascending: false })
      .limit(5);
    setNotes(data || []);
    setLoading(false);
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [dealId]);
  useEffect(() => {
    const ch = sb.channel('quicknotes-' + dealId)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'deal_notes', filter: `deal_id=eq.${dealId}` }, load)
      .subscribe();
    return () => { sb.removeChannel(ch); };
    // eslint-disable-next-line
  }, [dealId]);

  const add = async () => {
    const body = draft.trim();
    if (!body || adding) return;
    setAdding(true);
    const { error } = await sb.from('deal_notes').insert({ deal_id: dealId, body, author_id: userId || null });
    setAdding(false);
    if (error) { alert('Could not save note: ' + error.message); return; }
    setDraft('');
    load();
  };

  const fmtWhen = (iso) => {
    const d = new Date(iso);
    const diffMin = Math.round((Date.now() - d.getTime()) / 60000);
    if (diffMin < 1) return 'just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    const hrs = Math.round(diffMin / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.round(hrs / 24);
    return days < 7 ? `${days}d ago` : d.toLocaleDateString();
  };

  return (
    <Card title="📝 Notes" style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <textarea
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') add(); }}
          placeholder="Quick note — observations, reminders, things you want to tell Justin tomorrow…"
          rows={2}
          style={{ ...inputStyle, flex: 1, fontFamily: 'inherit', resize: 'vertical', lineHeight: 1.5 }}
        />
        <button onClick={add} disabled={!draft.trim() || adding}
          style={{
            background: (draft.trim() && !adding) ? '#d97706' : '#292524',
            color: (draft.trim() && !adding) ? '#0c0a09' : '#57534e',
            border: 'none', borderRadius: 6, padding: '0 14px',
            fontSize: 12, fontWeight: 700, cursor: (draft.trim() && !adding) ? 'pointer' : 'default',
            whiteSpace: 'nowrap', fontFamily: 'inherit', flexShrink: 0,
          }}>
          {adding ? 'Saving…' : '+ Note'}
        </button>
      </div>
      {!loading && notes.length === 0 && (
        <div style={{ fontSize: 11, color: '#57534e', fontStyle: 'italic', padding: '8px 0' }}>
          No notes yet. Jot down anything worth remembering about this lead.
        </div>
      )}
      {notes.slice(0, 3).map(n => (
        <div key={n.id} style={{ padding: "8px 0", borderTop: "1px solid #1c1917", fontSize: 13, color: '#d6d3d1', lineHeight: 1.55 }}>
          {n.title && <div style={{ fontSize: 12, fontWeight: 700, color: '#fafaf9', marginBottom: 2 }}>{n.title}</div>}
          <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{n.body}</div>
          <div style={{ fontSize: 10, color: '#57534e', marginTop: 4 }}>{fmtWhen(n.updated_at || n.created_at)}</div>
        </div>
      ))}
      {notes.length > 3 && onJumpToTab && (
        <button onClick={() => onJumpToTab('files')}
          style={{ background: "transparent", border: "none", color: "#d97706", fontSize: 10, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", cursor: "pointer", padding: '8px 0 0', marginTop: 4 }}>
          + {notes.length - 3} older note{notes.length - 3 === 1 ? '' : 's'} in the Files tab →
        </button>
      )}
    </Card>
  );
}

function CaseIntelligence({ dealId, deal, onJumpToTab }) {
  const [docs, setDocs] = useState([]);
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [summary, setSummary] = useState(deal?.meta?.case_intel_summary || null);
  const [summaryBusy, setSummaryBusy] = useState(false);
  const [summaryErr, setSummaryErr] = useState(null);

  const load = async () => {
    const [docsRes, eventsRes] = await Promise.all([
      sb.from('documents')
        .select('id, name, extracted, extracted_at, extraction_status')
        .eq('deal_id', dealId)
        .eq('extraction_status', 'done')
        .order('created_at', { ascending: false }),
      sb.from('docket_events')
        .select('id, event_type, event_date, description, is_backfill, acknowledged_at')
        .eq('deal_id', dealId)
        .order('event_date', { ascending: false })
        .limit(10),
    ]);
    setDocs(docsRes.data || []);
    setEvents(eventsRes.data || []);
    setLoading(false);
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [dealId]);
  // Keep the cached summary in sync when the deal prop refreshes
  useEffect(() => {
    if (deal?.meta?.case_intel_summary) setSummary(deal.meta.case_intel_summary);
  }, [deal?.meta?.case_intel_summary]);

  useEffect(() => {
    const ch = sb.channel('case-intel-' + dealId)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'documents', filter: `deal_id=eq.${dealId}` }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'docket_events', filter: `deal_id=eq.${dealId}` }, load)
      .subscribe();
    return () => { sb.removeChannel(ch); };
    // eslint-disable-next-line
  }, [dealId]);

  // Regenerate the narrative. Hits the generate-case-summary Edge Function,
  // which pulls every signal on this deal and asks Claude for a briefing.
  const refreshSummary = async () => {
    setSummaryBusy(true); setSummaryErr(null);
    try {
      const { data, error } = await sb.functions.invoke('generate-case-summary', { body: { deal_id: dealId } });
      if (error) {
        let msg = error.message;
        try { const b = await error.context?.json?.(); msg = b?.error || msg; } catch {}
        throw new Error(msg);
      }
      if (data?.text) setSummary({ text: data.text, generated_at: data.generated_at });
      else throw new Error(data?.error || 'No summary returned');
    } catch (e) { setSummaryErr(e.message); }
    setSummaryBusy(false);
  };

  if (loading) return null;
  // Render even on fresh leads (no docs/events) so the Refresh button is
  // reachable — the AI summary can still draft a useful brief from the
  // deal meta + contacts + recent messages alone.

  // Aggregate extracted fields across all docs — take the first non-null value.
  // Docs are sorted newest-first so recent wins, but judgment/appraised rarely
  // change so stability is fine.
  const aggregate = (keys) => {
    const list = Array.isArray(keys) ? keys : [keys];
    for (const doc of docs) {
      for (const k of list) {
        const v = doc.extracted?.fields?.[k];
        if (v != null && v !== '' && !Number.isNaN(v)) return v;
      }
    }
    return null;
  };

  const judgment     = aggregate('judgment_amount');
  const appraised    = aggregate('appraised_value');
  const salePrice    = aggregate('sale_price');
  const minBid       = aggregate('minimum_bid');
  const surplus      = aggregate(['surplus_amount', 'surplus_amount_estimated']);
  const caseNumber   = aggregate('case_number') || deal.meta?.courtCase;
  const county       = aggregate('county') || deal.meta?.county;
  const plaintiff    = aggregate(['plaintiff_name', 'firm_name']);
  const defendant    = aggregate(['defendant_name', 'client_name']);
  const propertyAddr = aggregate('property_address') || deal.address;
  const judge        = aggregate('judge_name');

  // Derived: Ohio statute sets minimum bid at 2/3 of appraised value
  const derivedMinBid = !minBid && appraised ? Math.round((appraised * 2) / 3) : null;
  // Derived: projected surplus if we know sale price + judgment
  const derivedSurplus = !surplus && salePrice && judgment ? Math.max(0, salePrice - judgment) : null;
  // Equity for flip/wholesale (what the current homeowner stands to lose OR
  // what a buyer could capture): appraised - judgment - liens. Surplus deals
  // don't show this — they show Surplus instead.
  const isFlipLike = deal.type === 'flip' || deal.type === 'wholesale';
  const lienPayoff = Number(deal.meta?.lienPayoff) || 0;
  const derivedEquity = isFlipLike && appraised && judgment
    ? Math.max(0, appraised - judgment - lienPayoff)
    : null;

  const fmtMoney = v => {
    if (v == null) return '—';
    const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[^0-9.-]/g, ''));
    if (Number.isNaN(n)) return String(v);
    return '$' + n.toLocaleString('en-US', { minimumFractionDigits: n % 1 === 0 ? 0 : 2, maximumFractionDigits: 2 });
  };

  const liveEvents = events.filter(e => !e.is_backfill).slice(0, 3);

  return (
    <Card style={{ marginBottom: 16, borderLeft: '3px solid #fbbf24' }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 12, gap: 10, flexWrap: "wrap" }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: "#fbbf24", letterSpacing: "0.12em", textTransform: "uppercase" }}>📊 Case Intelligence</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 10, color: "#78716c" }}>
            {docs.length > 0 && <>from {docs.length} analyzed doc{docs.length === 1 ? '' : 's'}</>}
            {liveEvents.length > 0 && <> · {liveEvents.length} recent court event{liveEvents.length === 1 ? '' : 's'}</>}
          </div>
          <button onClick={refreshSummary} disabled={summaryBusy}
            title="Re-generate the AI summary from every signal on this deal"
            style={{ background: summaryBusy ? "#292524" : "#78350f", color: summaryBusy ? "#78716c" : "#fbbf24", border: "1px solid " + (summaryBusy ? "#44403c" : "#92400e"), borderRadius: 6, padding: "3px 10px", fontSize: 10, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", cursor: summaryBusy ? "wait" : "pointer", fontFamily: "inherit" }}>
            {summaryBusy ? '⏳ Summarizing…' : (summary ? '🔄 Refresh summary' : '✨ Generate summary')}
          </button>
        </div>
      </div>

      {/* AI-generated narrative summary — pulls everything on the deal
          (docs + events + contacts + messages + activity + notes + tasks)
          and drafts Nathan's case briefing. Cached on deals.meta until
          someone clicks Refresh. */}
      {summary?.text && (() => {
        const freshness = summary.generated_at ? (() => {
          const mins = Math.round((Date.now() - new Date(summary.generated_at).getTime()) / 60000);
          if (mins < 1) return 'just now';
          if (mins < 60) return `${mins}m ago`;
          const hrs = Math.round(mins / 60);
          if (hrs < 24) return `${hrs}h ago`;
          return `${Math.round(hrs / 24)}d ago`;
        })() : null;
        // Very lightweight markdown: **bold** → <strong>, lines starting with - → bullets
        const renderBlock = (block, idx) => {
          const lines = block.split('\n').filter(Boolean);
          if (lines.every(l => l.trim().startsWith('-'))) {
            return (
              <ul key={idx} style={{ margin: '0 0 10px 0', paddingLeft: 18, color: '#d6d3d1', fontSize: 13, lineHeight: 1.6 }}>
                {lines.map((l, i) => <li key={i} dangerouslySetInnerHTML={{ __html: l.replace(/^-\s*/, '').replace(/\*\*(.+?)\*\*/g, '<strong style="color:#fafaf9;">$1</strong>') }} />)}
              </ul>
            );
          }
          return <p key={idx} style={{ margin: '0 0 10px 0', color: '#d6d3d1', fontSize: 13, lineHeight: 1.6 }} dangerouslySetInnerHTML={{ __html: block.replace(/\*\*(.+?)\*\*/g, '<strong style="color:#fafaf9;">$1</strong>') }} />;
        };
        return (
          <div style={{ background: "#0f0d0c", border: "1px solid #292524", borderLeft: "2px solid #fbbf24", borderRadius: 6, padding: "12px 14px", marginBottom: 14 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
              <span style={{ fontSize: 9, fontWeight: 700, color: '#fbbf24', letterSpacing: '0.1em', textTransform: 'uppercase' }}>🤖 AI Summary</span>
              {freshness && <span style={{ fontSize: 10, color: '#57534e' }}>· generated {freshness}</span>}
            </div>
            {summary.text.split('\n\n').map(renderBlock)}
          </div>
        );
      })()}
      {!summary?.text && !summaryBusy && (
        <div style={{ background: "#0f0d0c", border: "1px dashed #292524", borderRadius: 6, padding: "14px", marginBottom: 14, textAlign: "center", fontSize: 12, color: "#78716c" }}>
          No AI summary yet. Click <b style={{ color: "#fbbf24" }}>Generate summary</b> above to draft one from every signal on this deal.
        </div>
      )}
      {summaryErr && <div style={{ fontSize: 11, color: "#ef4444", marginBottom: 10 }}>⚠ {summaryErr}</div>}

      {(plaintiff || defendant) && (
        <div style={{ fontSize: 14, fontWeight: 600, color: "#fafaf9", marginBottom: 4 }}>
          {plaintiff || '—'} <span style={{ color: "#78716c", fontWeight: 400 }}>v.</span> {defendant || '—'}
        </div>
      )}
      {propertyAddr && <div style={{ fontSize: 12, color: "#a8a29e", marginBottom: 4 }}>{propertyAddr}</div>}
      {(caseNumber || county || judge) && (
        <div style={{ fontSize: 10, color: "#78716c", marginBottom: 14, display: "flex", gap: 8, flexWrap: "wrap" }}>
          {caseNumber && <span>Case {caseNumber}</span>}
          {county && <>{caseNumber && <span>·</span>}<span>{county} County</span></>}
          {judge && <><span>·</span><span>Judge {judge}</span></>}
        </div>
      )}

      {(judgment || appraised || minBid || derivedMinBid || salePrice || surplus || derivedSurplus || derivedEquity) && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10, marginBottom: 14 }}>
          {judgment  != null && <IntelTile label="Judgment" value={fmtMoney(judgment)} tone="red" />}
          {appraised != null && <IntelTile label="Appraised" value={fmtMoney(appraised)} tone="blue" />}
          {minBid    != null && <IntelTile label="Min Bid" value={fmtMoney(minBid)} tone="amber" />}
          {!minBid && derivedMinBid != null && <IntelTile label="Min Bid (2/3)" value={fmtMoney(derivedMinBid)} tone="amber" subtle />}
          {salePrice != null && <IntelTile label="Sale Price" value={fmtMoney(salePrice)} tone="green" />}
          {/* Flip / wholesale: show Equity (appraised − judgment − liens).
              Surplus deals: show Surplus (extracted or derived from sale − judgment). */}
          {isFlipLike
            ? (derivedEquity != null && <IntelTile label={"Equity" + (lienPayoff > 0 ? "" : " (pre-liens)")} value={fmtMoney(derivedEquity)} tone="gold" subtle={lienPayoff === 0} />)
            : (<>
                {surplus != null && <IntelTile label="Surplus" value={fmtMoney(surplus)} tone="gold" />}
                {!surplus && derivedSurplus != null && <IntelTile label="Projected Surplus" value={fmtMoney(derivedSurplus)} tone="gold" subtle />}
              </>)
          }
        </div>
      )}

      {docs.length > 0 && (() => {
        // Doc type distribution so Nathan sees the shape of the file at a glance
        const typeCounts = docs.reduce((acc, d) => {
          const t = d.extracted?.document_type || 'other';
          acc[t] = (acc[t] || 0) + 1;
          return acc;
        }, {});
        const typeList = Object.entries(typeCounts).sort((a, b) => b[1] - a[1]);
        // Only show the 3 most recent doc summaries so the card stays scannable.
        // Everything else lives in the Documents tab one tab-click away.
        const topDocs = docs.slice(0, 3);
        const moreCount = docs.length - topDocs.length;
        return (
          <div style={{ borderTop: "1px solid #292524", paddingTop: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8, gap: 10, flexWrap: "wrap" }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: "#78716c", letterSpacing: "0.1em", textTransform: "uppercase" }}>
                Document summary · {docs.length} analyzed
              </div>
              {onJumpToTab && (
                <button onClick={() => onJumpToTab('files')} style={{ background: "transparent", border: "none", color: "#d97706", fontSize: 10, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", cursor: "pointer", padding: 0 }}>
                  View all in Files tab →
                </button>
              )}
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
              {typeList.map(([t, n]) => (
                <span key={t} style={{ fontSize: 10, padding: "2px 8px", borderRadius: 3, background: "#1c1917", color: "#a8a29e", border: "1px solid #292524", letterSpacing: "0.03em" }}>
                  {t.replace(/_/g, ' ')} · {n}
                </span>
              ))}
            </div>
            {topDocs.map(d => (
              <div key={d.id} style={{ display: "flex", gap: 8, fontSize: 12, color: "#a8a29e", marginBottom: 6, lineHeight: 1.5 }}>
                <span style={{ color: "#d97706", flexShrink: 0 }}>•</span>
                <span><span style={{ color: "#d6d3d1", fontWeight: 500 }}>{d.name}</span> — {d.extracted?.summary || 'no summary'}</span>
              </div>
            ))}
            {moreCount > 0 && (
              <div style={{ fontSize: 11, color: "#57534e", marginTop: 4, fontStyle: "italic" }}>
                + {moreCount} more document{moreCount === 1 ? '' : 's'} — open the Documents tab to see each with extracted fields
              </div>
            )}
          </div>
        );
      })()}

      {events.filter(e => !e.is_backfill).length > 0 && (
        <div style={{ borderTop: "1px solid #292524", paddingTop: 10, marginTop: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8, gap: 10, flexWrap: "wrap" }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: "#78716c", letterSpacing: "0.1em", textTransform: "uppercase" }}>
              Recent court activity · {events.filter(e => !e.is_backfill).length} event{events.filter(e => !e.is_backfill).length === 1 ? '' : 's'}
            </div>
            {onJumpToTab && (
              <button onClick={() => onJumpToTab('docket')} style={{ background: "transparent", border: "none", color: "#d97706", fontSize: 10, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", cursor: "pointer", padding: 0 }}>
                View full timeline →
              </button>
            )}
          </div>
          {liveEvents.map(e => {
            const meta = eventMeta(e.event_type);
            return (
              <div key={e.id} style={{ display: "flex", gap: 8, fontSize: 12, color: "#a8a29e", marginBottom: 4, alignItems: "baseline" }}>
                <span style={{ fontSize: 14, flexShrink: 0 }}>{meta.icon}</span>
                <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: "#78716c", flexShrink: 0 }}>
                  {e.event_date ? new Date(e.event_date + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '—'}
                </span>
                <span>{e.description}</span>
              </div>
            );
          })}
          {events.filter(e => !e.is_backfill).length > 3 && (
            <div style={{ fontSize: 11, color: "#57534e", marginTop: 4, fontStyle: "italic" }}>
              + {events.filter(e => !e.is_backfill).length - 3} more event{events.filter(e => !e.is_backfill).length - 3 === 1 ? '' : 's'} in the Docket tab
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function SurplusOverview({ deal, totalExpenses, projectedFee, tasksDone, tasksTotal, onUpdateDeal, logAct, isAdmin, userId, onJumpToTab }) {
  const m = deal.meta || {};
  const updateMeta = (patch) => onUpdateDeal({ meta: { ...m, ...patch } });
  return (
    <div>
      <CaseIntelligence dealId={deal.id} deal={deal} onJumpToTab={onJumpToTab} />
      <QuickNotes dealId={deal.id} userId={userId} onJumpToTab={onJumpToTab} />
    <div className="overview-grid" style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 20 }}>
      <div>
        <Card title="Case Details">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            {isAdmin && <Field label="Estimated Surplus"><input type="number" value={m.estimatedSurplus || ""} onChange={e => updateMeta({ estimatedSurplus: parseFloat(e.target.value) || 0 })} style={inputStyle} /></Field>}
            {isAdmin && <Field label="Fee %"><input type="number" step="0.5" value={m.feePct || ""} onChange={e => updateMeta({ feePct: parseFloat(e.target.value) || 0 })} style={inputStyle} /></Field>}
            <Field label="Attorney"><input value={m.attorney || ""} onChange={e => updateMeta({ attorney: e.target.value })} style={inputStyle} /></Field>
            {isAdmin && <Field label="Attorney Fee"><input type="number" value={m.attorneyFee || ""} onChange={e => updateMeta({ attorneyFee: parseFloat(e.target.value) || 0 })} style={inputStyle} placeholder="$" /></Field>}
            <Field label="Court Case #"><input value={m.courtCase || ""} onChange={e => updateMeta({ courtCase: e.target.value })} style={inputStyle} /></Field>
            <Field label="County"><input value={m.county || ""} onChange={e => updateMeta({ county: e.target.value })} style={inputStyle} /></Field>
          </div>
          <CourtPullButton dealId={deal.id} caseNumber={m.courtCase} county={m.county} userId={userId} />
        </Card>
        {isAdmin && <Card title="Financial Summary" style={{ marginTop: 16 }}>
          <WaterfallLine label="Estimated Surplus" value={m.estimatedSurplus || 0} positive bold />
          <WaterfallLine label={`Our fee (${m.feePct || 0}%)`} value={projectedFee} positive />
          {(m.attorneyFee || 0) > 0 && <WaterfallLine label={`Attorney fee${m.attorney ? ` (${m.attorney})` : ""}`} value={-(m.attorneyFee || 0)} />}
          {totalExpenses > 0 && <WaterfallLine label="Expenses to date" value={-totalExpenses} />}
          <div style={{ height: 1, background: "#292524", margin: "10px 0" }} />
          <WaterfallLine label="NET TO US" value={projectedFee - (m.attorneyFee || 0) - totalExpenses} bold huge />
        </Card>}
        <Card title="Timing & Source" style={{ marginTop: 16 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="Filed Date"><input type="date" value={m.filed_at || deal.filed_at || ""} onChange={e => updateMeta({ filed_at: e.target.value || null })} style={inputStyle} /></Field>
            <Field label="Deadline (statutory)"><input type="date" value={m.deadline || deal.deadline || ""} onChange={e => updateMeta({ deadline: e.target.value || null })} style={inputStyle} /></Field>
            <Field label="Lead Source">
              <select value={m.lead_source || deal.lead_source || ""} onChange={e => updateMeta({ lead_source: e.target.value || null })} style={{ ...inputStyle, padding: "8px 10px" }}>
                <option value="">—</option>
                {["MLS","Direct Mail","Tax Sale List","Auction","Referral","Cold Call","Online Lead","Drive-by","Castle","Other"].map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </Field>
            {deal.status === "recovered" && (
              <Field label="Actual Fee Received"><input type="number" value={deal.actual_net || ""} onChange={e => onUpdateDeal({ actual_net: e.target.value ? parseFloat(e.target.value) : null, closed_at: deal.closed_at || new Date().toISOString() })} style={inputStyle} placeholder="Final fee $" /></Field>
            )}
          </div>
          {(m.filed_at || deal.filed_at) && <div style={{ fontSize: 11, color: "#a8a29e", marginTop: 10 }}>Filed {daysSince(m.filed_at || deal.filed_at)} days ago{(m.deadline || deal.deadline) && ` · ${deadlineInfo(m.deadline || deal.deadline).label || 'on track'}`}</div>}
        </Card>
        <ClientPortalCard deal={deal} logAct={logAct} />
        <AttorneyAssignmentCard deal={deal} logAct={logAct} />
        <WelcomeVideoCard deal={deal} logAct={logAct} onUpdateDeal={onUpdateDeal} />
      </div>
      <div>
        {/* Progress card removed — Tasks tab is the home for task tracking */}
        <Card title="Pipeline Stage">
          {DEAL_STATUSES.surplus.filter(s => s !== "dead").map(s => {
            const active = s === deal.status;
            const done = DEAL_STATUSES.surplus.indexOf(s) < DEAL_STATUSES.surplus.indexOf(deal.status);
            return (
              <div key={s} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderBottom: "1px solid #1c1917" }}>
                <div style={{ width: 20, height: 20, borderRadius: "50%", border: `2px solid ${active ? "#d97706" : done ? "#10b981" : "#44403c"}`, background: done ? "#10b981" : active ? "#d97706" : "transparent", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, color: done || active ? "#0c0a09" : "#44403c", fontWeight: 700 }}>{done ? "✓" : ""}</div>
                <span style={{ fontSize: 12, color: active ? "#fafaf9" : done ? "#a8a29e" : "#57534e", fontWeight: active ? 700 : 400, textTransform: "uppercase", letterSpacing: "0.06em" }}>{s.replace(/-/g, " ")}</span>
              </div>
            );
          })}
        </Card>
      </div>
    </div>
    </div>
  );
}

// ─── Shared primitives ───────────────────────────────────────────────
function WaterfallLine({ label, value, bold, huge, positive }) {
  const neg = value < 0;
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 0" }}>
      <span style={{ fontSize: huge ? 14 : 13, color: bold ? "#fafaf9" : "#a8a29e", fontWeight: bold ? 700 : 400 }}>{label}</span>
      <span style={{ fontFamily: "'DM Mono', monospace", fontSize: huge ? 22 : 14, fontWeight: bold ? 700 : 500, color: huge ? (value >= 60000 ? "#10b981" : value >= 0 ? "#f59e0b" : "#ef4444") : neg ? "#fca5a5" : positive ? "#86efac" : "#fafaf9" }}>
        {neg ? "-" : ""}{fmt(Math.abs(value))}
      </span>
    </div>
  );
}

function ProgressBar({ pct }) {
  return (
    <div style={{ height: 8, background: "#0c0a09", borderRadius: 4, overflow: "hidden", border: "1px solid #292524" }}>
      <div style={{ height: "100%", width: `${pct}%`, background: "linear-gradient(90deg, #d97706, #f59e0b)", transition: "width 0.3s", borderRadius: 4 }} />
    </div>
  );
}

function Metric({ label, value, sub, color, big }) {
  return (
    <div style={{ background: "#1c1917", border: "1px solid #292524", borderRadius: 10, padding: 16, borderLeft: `3px solid ${color}` }}>
      <div style={{ fontSize: 9, fontWeight: 700, color: "#a8a29e", letterSpacing: "0.1em", marginBottom: 8, textTransform: "uppercase" }}>{label}</div>
      <div style={{ fontFamily: "'DM Mono', monospace", fontSize: big ? 26 : 20, fontWeight: 700, letterSpacing: "-0.02em" }}>{value}</div>
      <div style={{ fontSize: 11, color: "#78716c", marginTop: 6 }}>{sub}</div>
    </div>
  );
}

function Card({ title, children, action, style }) {
  return (
    <div style={{ background: "#1c1917", border: "1px solid #292524", borderRadius: 10, padding: 18, ...style }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "#fafaf9", letterSpacing: "0.05em", textTransform: "uppercase" }}>{title}</div>
        {action}
      </div>
      {children}
    </div>
  );
}

function Field({ label, children, style }) {
  return (
    <div style={style}>
      <div style={{ fontSize: 10, fontWeight: 600, color: "#a8a29e", letterSpacing: "0.1em", marginBottom: 4, textTransform: "uppercase" }}>{label}</div>
      {children}
    </div>
  );
}

function TabBtn({ active, onClick, children }) {
  return <button onClick={onClick} style={{ flex: 1, padding: "10px 16px", borderRadius: 8, border: active ? "1px solid #d97706" : "1px solid #44403c", background: active ? "#d9770618" : "transparent", color: active ? "#fafaf9" : "#a8a29e", fontSize: 13, fontWeight: 600 }}>{children}</button>;
}

// ─── Expenses Tab ────────────────────────────────────────────────────
function Expenses({ items, dealId, userId, logAct, reload }) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ payee: "", amount: "", date: "", notes: "", category: "Other" });
  const total = items.reduce((s, x) => s + (parseFloat(x.amount) || 0), 0);

  const add = async () => {
    if (!draft.payee || !draft.amount) return;
    const row = { id: "e" + uid(), deal_id: dealId, payee: draft.payee, amount: parseFloat(draft.amount), date: draft.date || null, notes: draft.notes, category: draft.category, created_by: userId };
    await sb.from('expenses').insert(row);
    await logAct(`Added expense: ${draft.payee} ${fmt(parseFloat(draft.amount))}`);
    setDraft({ payee: "", amount: "", date: "", notes: "", category: "Other" });
    setAdding(false);
    reload();
  };
  const del = async (id) => {
    const it = items.find(i => i.id === id);
    await sb.from('expenses').delete().eq('id', id);
    await logAct(`Deleted expense: ${it?.payee}`);
    reload();
  };

  return (
    <Card title={`Expenses (${items.length} items · ${fmt(total)} total)`} action={<button onClick={() => setAdding(!adding)} style={btnPrimary}>{adding ? "Cancel" : "+ Add"}</button>}>
      {adding && (
        <div className="expense-add-form" style={{ padding: 14, background: "#0c0a09", borderRadius: 8, border: "1px solid #44403c", marginBottom: 14, display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr auto", gap: 8, alignItems: "end" }}>
          <Field label="Payee"><input value={draft.payee} onChange={e => setDraft({ ...draft, payee: e.target.value })} style={inputStyle} placeholder="Vendor" /></Field>
          <Field label="Amount"><input type="number" value={draft.amount} onChange={e => setDraft({ ...draft, amount: e.target.value })} style={inputStyle} placeholder="0" /></Field>
          <Field label="Date"><input type="date" value={draft.date} onChange={e => setDraft({ ...draft, date: e.target.value })} style={inputStyle} /></Field>
          <Field label="Category"><select value={draft.category} onChange={e => setDraft({ ...draft, category: e.target.value })} style={inputStyle}>{EXPENSE_CATEGORIES.map(c => <option key={c}>{c}</option>)}</select></Field>
          <button onClick={add} style={{ ...btnPrimary, padding: "8px 14px" }}>Save</button>
          <Field label="Notes" style={{ gridColumn: "1 / -1" }}><input value={draft.notes} onChange={e => setDraft({ ...draft, notes: e.target.value })} style={inputStyle} placeholder="Details" /></Field>
        </div>
      )}
      <div style={{ maxHeight: 520, overflowY: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead style={{ position: "sticky", top: 0, background: "#1c1917" }}>
            <tr style={{ borderBottom: "1px solid #44403c" }}>
              <th style={th}>Payee</th><th style={{ ...th, textAlign: "right" }}>Amount</th><th style={th}>Date</th><th style={th}>Category</th><th style={th}>Notes</th><th style={th}></th>
            </tr>
          </thead>
          <tbody>
            {items.map(item => (
              <tr key={item.id} style={{ borderBottom: "1px solid #292524" }}>
                <td style={td}>{item.payee}</td>
                <td style={{ ...td, textAlign: "right", fontFamily: "'DM Mono', monospace", fontWeight: 600, color: "#fca5a5" }}>{fmt(item.amount)}</td>
                <td style={{ ...td, color: "#a8a29e", fontFamily: "'DM Mono', monospace", fontSize: 11 }}>{item.date || "—"}</td>
                <td style={td}><span style={{ padding: "2px 8px", background: "#292524", borderRadius: 4, fontSize: 10, fontWeight: 600, color: "#d97706" }}>{item.category}</span></td>
                <td style={{ ...td, color: "#a8a29e", fontSize: 11, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis" }}>{item.notes}</td>
                <td style={td}><button onClick={() => del(item.id)} style={btnGhost}>×</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ─── Tasks Tab ───────────────────────────────────────────────────────
function Tasks({ items, dealId, userId, teamMembers, logAct, reload, deal }) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ label: "", due: "", owner: teamMembers[0] || "", priority: "med" });

  // Show the partner-visible toggle column only when this deal could have a
  // JV partner attached (flip or wholesale). Avoids cluttering the row for
  // surplus / rental / other deals where it'd never apply.
  const isJvCapable = deal && (deal.type === 'flip' || deal.type === 'wholesale');

  const toggle = async (id) => {
    const it = items.find(i => i.id === id);
    await sb.from('tasks').update({ done: !it.done }).eq('id', id);
    await logAct(`${!it.done ? "Completed" : "Reopened"}: ${it.label || it.title}`);
    reload();
  };

  const togglePartner = async (id, current) => {
    await sb.from('tasks').update({ partner_visible: !current }).eq('id', id);
    reload();
  };
  const add = async () => {
    if (!draft.label) return;
    const row = { id: "t" + uid(), deal_id: dealId, label: draft.label, due: draft.due || null, owner: draft.owner, priority: draft.priority, done: false, created_by: userId };
    await sb.from('tasks').insert(row);
    await logAct(`Added task: ${draft.label}`);
    setDraft({ label: "", due: "", owner: teamMembers[0] || "", priority: "med" });
    setAdding(false);
    reload();
  };
  const del = async (id) => {
    const it = items.find(i => i.id === id);
    await sb.from('tasks').delete().eq('id', id);
    await logAct(`Deleted task: ${it?.label}`);
    reload();
  };

  const sorted = [...items].sort((a, b) => { if (a.done !== b.done) return a.done ? 1 : -1; const p = { high: 0, med: 1, low: 2 }; return (p[a.priority] || 1) - (p[b.priority] || 1); });

  return (
    <Card title={`Tasks (${items.filter(t => !t.done).length} open)`} action={<button onClick={() => setAdding(!adding)} style={btnPrimary}>{adding ? "Cancel" : "+ Add"}</button>}>
      {adding && (
        <div style={{ padding: 14, background: "#0c0a09", borderRadius: 8, border: "1px solid #44403c", marginBottom: 14, display: "grid", gridTemplateColumns: "3fr 1fr 1fr 1fr auto", gap: 8, alignItems: "end" }}>
          <Field label="Task"><input value={draft.label} onChange={e => setDraft({ ...draft, label: e.target.value })} style={inputStyle} placeholder="What needs done?" /></Field>
          <Field label="Due"><input type="date" value={draft.due} onChange={e => setDraft({ ...draft, due: e.target.value })} style={inputStyle} /></Field>
          <Field label="Owner"><select value={draft.owner} onChange={e => setDraft({ ...draft, owner: e.target.value })} style={inputStyle}>{teamMembers.map(m => <option key={m}>{m}</option>)}</select></Field>
          <Field label="Priority"><select value={draft.priority} onChange={e => setDraft({ ...draft, priority: e.target.value })} style={inputStyle}><option value="high">High</option><option value="med">Med</option><option value="low">Low</option></select></Field>
          <button onClick={add} style={{ ...btnPrimary, padding: "8px 14px" }}>Save</button>
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {sorted.map(t => (
          <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 12px", background: t.done ? "#0c0a09" : "#1c1917", border: `1px solid ${t.done ? "#1c1917" : "#292524"}`, borderRadius: 8, opacity: t.done ? 0.45 : 1 }}>
            <input type="checkbox" checked={t.done} onChange={() => toggle(t.id)} style={{ width: 18, height: 18, cursor: "pointer", accentColor: "#d97706" }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 500, textDecoration: t.done ? "line-through" : "none" }}>{t.label}</div>
              <div style={{ fontSize: 11, color: "#78716c", marginTop: 2, display: "flex", gap: 10 }}>
                <span>{t.owner}</span>{t.due && <span>· Due {t.due}</span>}
              </div>
            </div>
            <PriorityBadge p={t.priority} />
            {isJvCapable && (
              <button
                onClick={() => togglePartner(t.id, !!t.partner_visible)}
                title={t.partner_visible ? "Visible to JV partner — click to hide" : "Hidden from JV partner — click to expose"}
                style={{
                  ...btnGhost,
                  fontSize: 10,
                  padding: "3px 8px",
                  color: t.partner_visible ? "#fbbf24" : "#57534e",
                  borderColor: t.partner_visible ? "#92400e" : "#292524",
                  background: t.partner_visible ? "#78350f22" : "transparent"
                }}
              >
                🤝 JV
              </button>
            )}
            <button onClick={() => del(t.id)} style={btnGhost}>×</button>
          </div>
        ))}
      </div>
    </Card>
  );
}

function PriorityBadge({ p }) {
  const bg = p === "high" ? "#7f1d1d" : p === "med" ? "#78350f" : "#1c1917";
  const fg = p === "high" ? "#fca5a5" : p === "med" ? "#fbbf24" : "#a8a29e";
  return <span style={{ padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 700, background: bg, color: fg }}>{(p || "med").toUpperCase()}</span>;
}

// ─── Vendors Tab ─────────────────────────────────────────────────────
function Vendors({ items, dealId, logAct, reload }) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ name: "", role: "", phone: "", status: "Active", notes: "" });
  const sc = (s) => ({ "Complete": "#10b981", "Active": "#f59e0b", "Pending": "#3b82f6", "Quoted": "#a78bfa" })[s] || "#a8a29e";

  const add = async () => {
    if (!draft.name) return;
    const row = { id: "v" + uid(), deal_id: dealId, ...draft };
    await sb.from('vendors').insert(row);
    await logAct(`Added vendor: ${draft.name}`);
    setDraft({ name: "", role: "", phone: "", status: "Active", notes: "" });
    setAdding(false);
    reload();
  };
  const del = async (id) => {
    const it = items.find(i => i.id === id);
    await sb.from('vendors').delete().eq('id', id);
    await logAct(`Removed vendor: ${it?.name}`);
    reload();
  };

  return (
    <Card title={`Vendors (${items.length})`} action={<button onClick={() => setAdding(!adding)} style={btnPrimary}>{adding ? "Cancel" : "+ Add"}</button>}>
      {adding && (
        <div style={{ padding: 14, background: "#0c0a09", borderRadius: 8, border: "1px solid #44403c", marginBottom: 14, display: "grid", gridTemplateColumns: "1.5fr 1.5fr 1fr 1fr 2fr auto", gap: 8, alignItems: "end" }}>
          <Field label="Name"><input value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} style={inputStyle} placeholder="Vendor" /></Field>
          <Field label="Role"><input value={draft.role} onChange={e => setDraft({ ...draft, role: e.target.value })} style={inputStyle} placeholder="What they do" /></Field>
          <Field label="Phone"><input value={draft.phone} onChange={e => setDraft({ ...draft, phone: e.target.value })} style={inputStyle} placeholder="555-1234" /></Field>
          <Field label="Status"><select value={draft.status} onChange={e => setDraft({ ...draft, status: e.target.value })} style={inputStyle}><option>Active</option><option>Complete</option><option>Pending</option><option>Quoted</option></select></Field>
          <Field label="Notes"><input value={draft.notes} onChange={e => setDraft({ ...draft, notes: e.target.value })} style={inputStyle} /></Field>
          <button onClick={add} style={{ ...btnPrimary, padding: "8px 14px" }}>Save</button>
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 12 }}>
        {items.map(v => (
          <div key={v.id} style={{ background: "#0c0a09", border: "1px solid #292524", borderRadius: 8, padding: 14 }}>
            <div style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 6 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 700 }}>{v.name}</div>
                <div style={{ fontSize: 11, color: "#a8a29e", marginTop: 2 }}>{v.role}</div>
              </div>
              <span style={{ padding: "2px 8px", borderRadius: 4, fontSize: 9, fontWeight: 700, background: `${sc(v.status)}22`, color: sc(v.status), letterSpacing: "0.05em", flexShrink: 0, alignSelf: "center" }}>{(v.status || "").toUpperCase()}</span>
              <button onClick={() => del(v.id)} style={{ ...btnGhost, flexShrink: 0, padding: "2px 6px", lineHeight: 1, fontSize: 16 }}>×</button>
            </div>
            {v.phone && <div style={{ fontSize: 12, color: "#d97706", fontFamily: "'DM Mono', monospace", marginTop: 6 }}><a href={`tel:${v.phone}`} style={{ color: "inherit", textDecoration: "none" }}>{v.phone}</a></div>}
            {v.notes && <div style={{ fontSize: 11, color: "#a8a29e", marginTop: 8, lineHeight: 1.5 }}>{v.notes}</div>}
          </div>
        ))}
      </div>
    </Card>
  );
}

// ─── Documents Tab ───────────────────────────────────────────────────
// ─── Messages Tab ─────────────────────────────────────────────────
function MessagesTab({ dealId, deal, userId, userName, userRole }) {
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState("");
  const [subject, setSubject] = useState("");
  const [sendToClient, setSendToClient] = useState(true);
  const [sendToAttorney, setSendToAttorney] = useState(false);
  const [hasAttorney, setHasAttorney] = useState(false);
  const [clientEmails, setClientEmails] = useState([]);
  const [attorneyEmails, setAttorneyEmails] = useState([]);
  const [sending, setSending] = useState(false);
  const [showExpanded, setShowExpanded] = useState(false);
  const endRef = useRef(null);

  const load = async () => {
    const { data } = await sb.from('messages').select('*').eq('deal_id', dealId).order('created_at', { ascending: true });
    setMessages(data || []);
    setLoading(false);
    // Mark unread as read
    await sb.rpc('mark_messages_read', { p_deal_id: dealId });
  };

  // Load recipient info to populate audience defaults and email-preview hints
  const loadRecipients = async () => {
    const [caRes, aaRes] = await Promise.all([
      sb.from('client_access').select('email').eq('deal_id', dealId).eq('enabled', true),
      sb.from('attorney_assignments').select('email').eq('deal_id', dealId).eq('enabled', true),
    ]);
    const clients = (caRes.data || []).map(r => r.email).filter(Boolean);
    const attorneys = (aaRes.data || []).map(r => r.email).filter(Boolean);
    setClientEmails(clients);
    setAttorneyEmails(attorneys);
    setHasAttorney(attorneys.length > 0);
  };

  useEffect(() => { load(); loadRecipients(); }, [dealId]);

  // Realtime subscription
  useEffect(() => {
    const ch = sb.channel('msgs-' + dealId)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `deal_id=eq.${dealId}` }, (payload) => {
        setMessages(prev => [...prev, payload.new]);
        // auto-mark read if the incoming message is from external
        if (payload.new.sender_role === 'client' || payload.new.sender_role === 'attorney') {
          sb.rpc('mark_messages_read', { p_deal_id: dealId });
        }
      })
      .subscribe();
    return () => { sb.removeChannel(ch); };
  }, [dealId]);

  useEffect(() => {
    if (endRef.current) endRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages]);

  // Insert a merge field token at cursor in the body textarea
  const bodyRef = useRef(null);
  const insertField = (token) => {
    const el = bodyRef.current;
    if (!el) { setText(prev => prev + token); return; }
    const start = el.selectionStart || 0;
    const end = el.selectionEnd || 0;
    const newText = text.slice(0, start) + token + text.slice(end);
    setText(newText);
    setTimeout(() => {
      el.focus();
      el.selectionStart = el.selectionEnd = start + token.length;
    }, 0);
  };

  const send = async () => {
    const body = text.trim();
    if (!body || sending) return;
    const audience = [];
    if (sendToClient) audience.push('client');
    if (sendToAttorney) audience.push('attorney');
    // Render {{MergeFields}} using this deal's data so both the stored
    // message and the dispatched email show real values instead of tokens.
    const renderedBody = renderMergeFields(body, deal);
    const rawSubject = subject.trim();
    const renderedSubject = rawSubject ? renderMergeFields(rawSubject, deal) : null;
    setSending(true);
    const { error } = await sb.from('messages').insert({
      deal_id: dealId,
      sender_id: userId,
      sender_role: userRole,
      sender_name: userName,
      subject: renderedSubject,
      audience,
      body: renderedBody,
    });
    setSending(false);
    if (error) {
      alert('Could not send: ' + error.message);
      return;
    }
    setText("");
    setSubject("");
    // Collapse the composer back to compact state after send
    setShowExpanded(false);
  };

  const roleLabel = (r) => ({ admin: 'Team', user: 'Team', va: 'Team', client: 'Client', attorney: 'Counsel' })[r] || r;
  const roleColor = (r) => {
    if (r === 'client') return '#3b82f6';
    if (r === 'attorney') return '#8b5cf6';
    return '#d97706'; // team
  };

  return (
    <Card title="Messages" action={
      <div style={{ fontSize: 11, color: "#78716c" }}>{messages.length > 0 ? `${messages.length} messages` : ''}</div>
    }>
      {loading ? (
        <div style={{ fontSize: 12, color: "#78716c", padding: 20, textAlign: "center" }}>Loading…</div>
      ) : messages.length === 0 ? (
        <div style={{ fontSize: 12, color: "#78716c", padding: 24, textAlign: "center", lineHeight: 1.5 }}>
          No messages yet. When this deal's client or attorney sends a message, it'll appear here. You can also start the thread below — anything you send is visible only to them (and any co-claimants on this case), not other clients.
        </div>
      ) : (
        <div style={{ maxHeight: 480, overflowY: "auto", padding: "0 4px", marginBottom: 14 }}>
          {messages.map(m => {
            const isTeam = ['admin', 'user', 'va'].includes(m.sender_role);
            const aud = m.audience || [];
            return (
              <div key={m.id} style={{ marginBottom: 14, display: "flex", flexDirection: "column", alignItems: isTeam ? "flex-end" : "flex-start" }}>
                <div style={{ fontSize: 10, color: "#78716c", marginBottom: 4, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                  <span style={{ color: roleColor(m.sender_role), fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase" }}>{roleLabel(m.sender_role)}</span>
                  <span>·</span>
                  <span>{m.sender_name || 'Unknown'}</span>
                  <span>·</span>
                  <span>{new Date(m.created_at).toLocaleString()}</span>
                  {isTeam && aud.length > 0 && (
                    <>
                      <span>·</span>
                      <span style={{ color: "#6ee7b7" }}>
                        {aud.includes('client') && '👤'}
                        {aud.includes('attorney') && '⚖'}
                      </span>
                    </>
                  )}
                </div>
                <div style={{
                  maxWidth: "85%",
                  padding: "10px 14px",
                  borderRadius: 12,
                  background: isTeam ? "#d97706" : "#1c1917",
                  color: isTeam ? "#0c0a09" : "#fafaf9",
                  fontSize: 14,
                  lineHeight: 1.5,
                  whiteSpace: "pre-wrap",
                  border: isTeam ? "none" : "1px solid #292524",
                }}>
                  {m.subject && (
                    <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase", marginBottom: 6, opacity: 0.85 }}>
                      📧 {m.subject}
                    </div>
                  )}
                  {m.body}
                </div>
              </div>
            );
          })}
          <div ref={endRef} />
        </div>
      )}

      {/* Composer — collapsed by default, expandable for subject + audience controls */}
      <div style={{ background: "#0c0a09", border: "1px solid #292524", borderRadius: 8, padding: 10 }}>
        {showExpanded && (
          <>
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: "#78716c", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 4 }}>
                Subject <span style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0, color: "#57534e" }}>(optional — overrides generic email subject)</span>
              </div>
              <input
                value={subject}
                onChange={e => setSubject(e.target.value)}
                placeholder={userRole === 'admin' || userRole === 'user' || userRole === 'va' ? 'e.g. "Your RefundLocators portal is ready"' : ''}
                style={{ ...inputStyle, fontSize: 13 }}
              />
            </div>

            <div style={{ display: "flex", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: "#78716c", letterSpacing: "0.08em", textTransform: "uppercase", alignSelf: "center", marginRight: 2 }}>
                Email to
              </div>
              <label style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 10px", background: sendToClient ? "#1e3a5f" : "transparent", border: "1px solid " + (sendToClient ? "#3b82f6" : "#292524"), borderRadius: 5, cursor: "pointer", fontSize: 12 }}>
                <input type="checkbox" checked={sendToClient} onChange={e => setSendToClient(e.target.checked)} />
                <span style={{ color: sendToClient ? "#93c5fd" : "#78716c" }}>👤 Client{clientEmails.length > 0 ? ` (${clientEmails.length})` : ' (none linked)'}</span>
              </label>
              <label style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 10px", background: sendToAttorney ? "#312e81" : "transparent", border: "1px solid " + (sendToAttorney ? "#8b5cf6" : "#292524"), borderRadius: 5, cursor: hasAttorney ? "pointer" : "not-allowed", fontSize: 12, opacity: hasAttorney ? 1 : 0.4 }}>
                <input type="checkbox" checked={sendToAttorney} onChange={e => setSendToAttorney(e.target.checked)} disabled={!hasAttorney} />
                <span style={{ color: sendToAttorney ? "#c4b5fd" : "#78716c" }}>⚖ Counsel{attorneyEmails.length > 0 ? ` (${attorneyEmails.length})` : ' (none assigned)'}</span>
              </label>
            </div>

            <div style={{ display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap", alignItems: "center" }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: "#78716c", letterSpacing: "0.08em", textTransform: "uppercase", marginRight: 2 }}>
                Insert field
              </div>
              {[
                { label: 'Client name', token: '{{ClientName}}' },
                { label: 'Case #', token: '{{CaseNumber}}' },
                { label: 'County', token: '{{County}}' },
                { label: 'Address', token: '{{PropertyAddress}}' },
              ].map(f => (
                <button key={f.token} onClick={() => insertField(f.token)} style={{ ...btnGhost, fontSize: 10, padding: "3px 8px" }}>
                  + {f.label}
                </button>
              ))}
              <div style={{ fontSize: 10, color: "#57534e", marginLeft: 4 }}>
                Tokens render on send using this deal's data
              </div>
            </div>
          </>
        )}

        <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
          <textarea
            ref={bodyRef}
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && text.trim()) send(); }}
            placeholder={showExpanded ? "Message body — use {{ClientName}} etc. to insert deal data" : "Quick reply to the client or attorney…"}
            rows={showExpanded ? 5 : 2}
            style={{ ...inputStyle, flex: 1, resize: "vertical", minHeight: showExpanded ? 100 : 48, fontFamily: "inherit", lineHeight: 1.5 }}
          />
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <button onClick={() => setShowExpanded(!showExpanded)} style={{ ...btnGhost, fontSize: 11 }} title={showExpanded ? "Collapse composer" : "Expand — add subject, pick audience, insert fields"}>
              {showExpanded ? '↑' : '✉️'}
            </button>
            <button onClick={send} disabled={!text.trim() || sending || (!sendToClient && !sendToAttorney)} style={btnPrimary}>
              {sending ? 'Sending…' : 'Send'}
            </button>
          </div>
        </div>

        <div style={{ fontSize: 10, color: "#57534e", marginTop: 6, lineHeight: 1.5 }}>
          ⌘/Ctrl+Enter sends · Message shows in both portals regardless of audience (audience only controls who gets the email) · Replies come back into this thread
        </div>
      </div>
    </Card>
  );
}

// Merge-field renderer — replaces {{Token}} with deal data before send
function renderMergeFields(text, deal) {
  if (!text || !deal) return text;
  const m = deal.meta || {};
  const vals = {
    ClientName: (deal.name || '').split(' - ')[0],
    CaseNumber: m.courtCase || '',
    County: m.county || '',
    PropertyAddress: deal.address || '',
    FeePct: m.feePct ? String(m.feePct) + '%' : '',
    AttorneyName: m.attorney || '',
    FiledDate: deal.filed_at || m.filed_at || '',
  };
  let out = text;
  for (const [k, v] of Object.entries(vals)) {
    out = out.replace(new RegExp('\\{\\{\\s*' + k + '\\s*\\}\\}', 'g'), v);
  }
  return out;
}

// ─── Docket Tab ───────────────────────────────────────────────────
// Timeline of court events ingested from Castle's docket scrapers.
// Each event comes with type, date, description, and optionally a
// document link. Team can acknowledge events to clear the badge.
const EVENT_TYPE_META = {
  disbursement_ordered: { label: "Disbursement Ordered", color: "#10b981", icon: "💰", priority: 3, client: true },
  disbursement_paid:    { label: "Disbursement Paid",    color: "#10b981", icon: "✅", priority: 3, client: true },
  hearing_scheduled:    { label: "Hearing Scheduled",    color: "#3b82f6", icon: "📅", priority: 2, client: true },
  hearing_continued:    { label: "Hearing Continued",    color: "#f59e0b", icon: "📅", priority: 2, client: true },
  judgment_entered:     { label: "Judgment Entered",     color: "#10b981", icon: "⚖",  priority: 2, client: true },
  order_entered:        { label: "Order Entered",        color: "#8b5cf6", icon: "📜", priority: 2, client: false },
  motion_filed:         { label: "Motion Filed",         color: "#8b5cf6", icon: "📝", priority: 1, client: false },
  objection_filed:      { label: "Objection Filed",      color: "#ef4444", icon: "⚠",  priority: 3, client: false },
  notice_of_claim:      { label: "Notice of Claim",      color: "#ef4444", icon: "👥", priority: 3, client: false },
  continuance_granted:  { label: "Continuance Granted",  color: "#a8a29e", icon: "⏸",  priority: 1, client: false },
  answer_filed:         { label: "Answer Filed",         color: "#a8a29e", icon: "📝", priority: 1, client: false },
  docket_updated:       { label: "Docket Update",        color: "#78716c", icon: "•",  priority: 0, client: false },
};
const eventMeta = (t) => EVENT_TYPE_META[t] || { label: t, color: "#78716c", icon: "•", priority: 0, client: false };

// Critical events get visual elevation on lead cards and push to top of the
// MiniDocketPulse when unacknowledged. Hardcoded per the Castle spec rather
// than derived from EVENT_TYPE_META.priority because `order_entered` is priority
// 2 but is NOT a critical event (routine court paperwork, common on many dockets).
const CRITICAL_EVENT_TYPES = new Set([
  'disbursement_ordered', 'disbursement_paid',
  'hearing_scheduled', 'hearing_continued',
  'objection_filed', 'notice_of_claim',
  'judgment_entered',
]);
const isCriticalEvent = (t) => CRITICAL_EVENT_TYPES.has(t);

// ─── Castle Apr 25 sprint additions: derived helpers ──────────────
// litigation_stage = lifecycle bucket per docket event
// deadline_metadata = statutory countdown info
// attorney_appearance = attorney+firm extracted from court filings
const LITIGATION_STAGE_META = {
  pre_filing:           { label: "Pre-filing",     color: "#78716c" },
  filed:                { label: "Filed",          color: "#3b82f6" },
  service:              { label: "Service",        color: "#3b82f6" },
  hearing_scheduled:    { label: "Hearing set",    color: "#8b5cf6" },
  hearing_held:         { label: "Hearing held",   color: "#8b5cf6" },
  order_entered:        { label: "Order entered",  color: "#a78bfa" },
  distribution_ordered: { label: "Distrib. ordered", color: "#10b981" },
  distribution_paid:    { label: "Distrib. paid",  color: "#10b981" },
  closed:               { label: "Closed",         color: "#57534e" },
};

// Compute deadline countdown from a docket event with deadline_metadata.
// Castle emits one of: appeal_window_days, response_due_in_days, redemption_period_days.
// Returns null when no statutory window applies.
function eventDeadline(e) {
  const dm = e?.deadline_metadata;
  if (!dm || !e.event_date) return null;
  const days = Number(dm.appeal_window_days) || Number(dm.response_due_in_days) || Number(dm.redemption_period_days);
  if (!days || isNaN(days)) return null;
  const eventDate = new Date(e.event_date);
  if (isNaN(eventDate.getTime())) return null;
  const deadlineDate = new Date(eventDate);
  deadlineDate.setDate(deadlineDate.getDate() + days);
  const now = Date.now();
  const dayMs = 86400000;
  const daysSince = Math.floor((now - eventDate.getTime()) / dayMs);
  const daysRemaining = Math.ceil((deadlineDate.getTime() - now) / dayMs);
  let kind = 'response';
  if (dm.appeal_window_days) kind = 'appeal';
  else if (dm.redemption_period_days) kind = 'redemption';
  return {
    deadlineDate,
    totalDays: days,
    daysSince,
    daysRemaining,
    kind,
    notes: dm.deadline_notes || null,
  };
}

function deadlineColor(daysRemaining) {
  if (daysRemaining < 0) return "#ef4444";       // expired
  if (daysRemaining <= 2) return "#dc2626";      // critical
  if (daysRemaining <= 7) return "#f59e0b";      // approaching
  return "#10b981";                              // comfortable
}

function deadlineLabel(d) {
  if (d.daysRemaining < 0) return `Expired ${Math.abs(d.daysRemaining)}d ago`;
  if (d.daysRemaining === 0) return `Due TODAY`;
  if (d.daysRemaining === 1) return `Due tomorrow`;
  return `Day ${d.daysSince + 1} of ${d.totalDays} · ${d.daysRemaining}d remaining`;
}

function deadlineKindLabel(kind) {
  return kind === 'appeal' ? 'Appeal window' : kind === 'redemption' ? 'Redemption period' : 'Response due';
}

function DocketTab({ dealId }) {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null);

  const load = async () => {
    const { data } = await sb.from('docket_events')
      .select('*')
      .eq('deal_id', dealId)
      .order('event_date', { ascending: false })
      .order('received_at', { ascending: false });
    setEvents(data || []);
    setLoading(false);
  };

  useEffect(() => { load(); }, [dealId]);

  useEffect(() => {
    const ch = sb.channel('docket-' + dealId)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'docket_events', filter: `deal_id=eq.${dealId}` }, load)
      .subscribe();
    return () => { sb.removeChannel(ch); };
  }, [dealId]);

  const acknowledge = async (eventId) => {
    setBusy(eventId);
    await sb.rpc('acknowledge_docket_event', { p_event_id: eventId });
    await load();
    setBusy(null);
  };

  const acknowledgeAll = async () => {
    const unack = events.filter(e => !e.acknowledged_at);
    if (unack.length === 0) return;
    if (!confirm(`Acknowledge all ${unack.length} unacknowledged events?`)) return;
    for (const e of unack) {
      await sb.rpc('acknowledge_docket_event', { p_event_id: e.id });
    }
    await load();
  };

  const unackCount = events.filter(e => !e.acknowledged_at).length;

  return (
    <Card>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, flexWrap: "wrap", gap: 10 }}>
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#a8a29e", letterSpacing: "0.08em", textTransform: "uppercase" }}>Docket Events</div>
          <div style={{ fontSize: 11, color: "#78716c", marginTop: 4 }}>
            {events.length === 0 ? "No events yet" : `${events.length} total event${events.length === 1 ? '' : 's'}`}
            {unackCount > 0 && <> · <span style={{ color: "#f59e0b", fontWeight: 700 }}>{unackCount} unacknowledged</span></>}
          </div>
        </div>
        {unackCount > 0 && (
          <button onClick={acknowledgeAll} style={{ ...btnGhost, fontSize: 11 }}>Acknowledge all</button>
        )}
      </div>

      {loading && <div style={{ fontSize: 12, color: "#78716c" }}>Loading…</div>}

      {!loading && events.length === 0 && (
        <div style={{ fontSize: 13, color: "#78716c", padding: 32, textAlign: "center", fontStyle: "italic", border: "1px dashed #292524", borderRadius: 8 }}>
          No docket events yet. Once Castle's scrapers are watching this case, events will appear here as they happen.
        </div>
      )}

      {!loading && events.length > 0 && (
        <div style={{
          display: "flex",
          flexDirection: "column",
          gap: 10,
          // Fixed-height scroller keeps the Docket tab from blowing out the
          // deal view when Castle has dumped 50-100 entries. Scrolls internally,
          // the rest of the deal page stays put.
          maxHeight: 520,
          overflowY: events.length > 3 ? "auto" : "visible",
          paddingRight: events.length > 3 ? 6 : 0,
          borderTop: events.length > 3 ? "1px solid #292524" : "none",
          borderBottom: events.length > 3 ? "1px solid #292524" : "none",
          paddingTop: events.length > 3 ? 10 : 0,
          paddingBottom: events.length > 3 ? 10 : 0,
          marginTop: events.length > 3 ? -1 : 0,
        }}>
          {events.map(e => {
            const meta = eventMeta(e.event_type);
            const isUnack = !e.acknowledged_at;
            return (
              <div key={e.id} style={{
                padding: "14px 16px",
                background: isUnack ? "#1c1509" : "#0c0a09",
                border: "1px solid " + (isUnack ? meta.color : "#292524"),
                borderLeft: `3px solid ${meta.color}`,
                borderRadius: 8,
                opacity: e.acknowledged_at ? 0.7 : 1,
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
                  <div style={{ flex: 1, minWidth: 220 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <span style={{ fontSize: 16 }}>{meta.icon}</span>
                      <span style={{ fontSize: 10, fontWeight: 700, color: meta.color, letterSpacing: "0.08em", textTransform: "uppercase", padding: "2px 8px", background: meta.color + "22", borderRadius: 3 }}>{meta.label}</span>
                      {e.litigation_stage && (() => {
                        const lm = LITIGATION_STAGE_META[e.litigation_stage] || { label: e.litigation_stage.replace(/_/g, ' '), color: '#78716c' };
                        return <span title="Litigation stage (Castle-classified)" style={{ fontSize: 9, fontWeight: 700, color: lm.color, padding: "2px 7px", background: lm.color + "1a", border: `1px solid ${lm.color}66`, borderRadius: 3, letterSpacing: "0.06em", textTransform: "uppercase" }}>{lm.label}</span>;
                      })()}
                      <span style={{ fontSize: 11, color: "#78716c", fontFamily: "'DM Mono', monospace" }}>{e.event_date}</span>
                      {isUnack && <span style={{ fontSize: 9, fontWeight: 700, color: "#fbbf24", padding: "2px 7px", border: "1px solid #78350f", borderRadius: 3, letterSpacing: "0.06em" }}>NEW</span>}
                    </div>
                    <div style={{ fontSize: 14, color: "#fafaf9", marginTop: 8, lineHeight: 1.5 }}>
                      {e.description}
                    </div>
                    <div style={{ fontSize: 10, color: "#57534e", marginTop: 6, display: "flex", gap: 12, flexWrap: "wrap" }}>
                      {e.court_system && <span>{e.court_system}</span>}
                      {e.case_number && <span>Case {e.case_number}</span>}
                      {e.detected_at && <span>Detected {new Date(e.detected_at).toLocaleString()}</span>}
                    </div>
                    {(() => {
                      const d = eventDeadline(e);
                      if (!d) return null;
                      const c = deadlineColor(d.daysRemaining);
                      return (
                        <div style={{ marginTop: 10, padding: "8px 12px", background: c + "1a", border: `1px solid ${c}66`, borderLeft: `3px solid ${c}`, borderRadius: 5 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                            <span style={{ fontSize: 11, fontWeight: 700, color: c, letterSpacing: "0.04em" }}>⏳ {deadlineLabel(d)}</span>
                            <span style={{ fontSize: 10, color: "#a8a29e" }}>{deadlineKindLabel(d.kind)} · {d.deadlineDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                          </div>
                          {d.notes && <div style={{ fontSize: 10, color: "#78716c", marginTop: 4, fontStyle: "italic" }}>{d.notes}</div>}
                        </div>
                      );
                    })()}
                    {e.attorney_appearance && (
                      <div style={{ marginTop: 10, padding: "8px 12px", background: "#451a0322", border: "1px solid #92400e66", borderLeft: "3px solid #d97706", borderRadius: 5 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 12 }}>
                          <span style={{ fontSize: 14 }}>👨‍⚖️</span>
                          <span style={{ color: "#fbbf24", fontWeight: 700 }}>{e.attorney_appearance.attorney_name || 'Attorney appearance'}</span>
                          {e.attorney_appearance.firm_name && <span style={{ color: "#a8a29e" }}>· {e.attorney_appearance.firm_name}</span>}
                        </div>
                        <div style={{ fontSize: 10, color: "#78716c", marginTop: 4, display: "flex", gap: 10, flexWrap: "wrap" }}>
                          {e.attorney_appearance.role && <span style={{ textTransform: "capitalize" }}>{String(e.attorney_appearance.role).replace(/_/g, ' ')}</span>}
                          {e.attorney_appearance.bar_number && <span>Bar #{e.attorney_appearance.bar_number}</span>}
                        </div>
                      </div>
                    )}
                    {(e.document_url || e.document_ocr_id) && (
                      <div style={{ marginTop: 8, display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center" }}>
                        {e.document_ocr_id && (
                          <button
                            onClick={async () => {
                              const { data: doc } = await sb.from('documents').select('path').eq('id', e.document_ocr_id).single();
                              if (!doc?.path) { alert('PDF not found in storage.'); return; }
                              const { data, error } = await sb.storage.from('deal-docs').createSignedUrl(doc.path, 300);
                              if (error || !data?.signedUrl) { alert("Couldn't open PDF: " + (error?.message || 'unknown')); return; }
                              window.open(data.signedUrl, '_blank');
                            }}
                            style={{ fontSize: 11, color: "#6ee7b7", background: "#064e3b22", border: "1px solid #065f46", borderRadius: 5, padding: "3px 10px", fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>
                            📎 Open attached PDF
                          </button>
                        )}
                        {e.document_url && (
                          <a href={e.document_url} target="_blank" rel="noreferrer" style={{ fontSize: 11, color: "#93c5fd", textDecoration: "none", fontWeight: 600 }}>
                            📄 View on court site →
                          </a>
                        )}
                      </div>
                    )}
                  </div>
                  {isUnack && (
                    <button
                      onClick={() => acknowledge(e.id)}
                      disabled={busy === e.id}
                      style={{ ...btnGhost, fontSize: 11, whiteSpace: "nowrap" }}
                    >
                      {busy === e.id ? '…' : 'Acknowledge'}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

// ─── Docket Overview Modal (cross-deal) ──────────────────────────
// Shows unacknowledged events across ALL deals + a scraper-health panel
// so admin can spot broken counties at a glance.
function DocketOverviewModal({ onClose, onJumpToDeal }) {
  const [tab, setTab] = useState("events");
  const [events, setEvents] = useState([]);
  const [health, setHealth] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    const [eventsRes, healthRes] = await Promise.all([
      sb.from('docket_events')
        .select('*, deals(name, status)')
        .is('acknowledged_at', null)
        .order('event_date', { ascending: false })
        .limit(100),
      sb.from('scraper_health').select('*'),
    ]);
    setEvents(eventsRes.data || []);
    setHealth(healthRes.data || []);
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const ack = async (eventId) => {
    await sb.rpc('acknowledge_docket_event', { p_event_id: eventId });
    await load();
  };

  const statusColor = (h) => {
    if (h.last_status === 'running') return "#3b82f6";
    if (h.failures_24h > 2) return "#ef4444";
    if (h.last_status === 'failed') return "#f59e0b";
    return "#10b981";
  };

  const timeAgo = (iso) => {
    if (!iso) return "never";
    const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return s + "s ago";
    if (s < 3600) return Math.floor(s / 60) + "m ago";
    if (s < 86400) return Math.floor(s / 3600) + "h ago";
    return Math.floor(s / 86400) + "d ago";
  };

  return (
    <Modal onClose={onClose} title="⚖ Docket Center" wide>
      <div style={{ display: "flex", gap: 2, borderBottom: "1px solid #292524", marginBottom: 16 }}>
        <button onClick={() => setTab("events")} style={{
          background: "transparent", border: "none", color: tab === "events" ? "#fafaf9" : "#78716c",
          padding: "8px 14px", fontSize: 13, fontWeight: tab === "events" ? 700 : 500,
          borderBottom: tab === "events" ? "2px solid #d97706" : "2px solid transparent", marginBottom: -1, cursor: "pointer", fontFamily: "inherit",
        }}>
          Unacknowledged {events.length > 0 ? `(${events.length})` : ''}
        </button>
        <button onClick={() => setTab("health")} style={{
          background: "transparent", border: "none", color: tab === "health" ? "#fafaf9" : "#78716c",
          padding: "8px 14px", fontSize: 13, fontWeight: tab === "health" ? 700 : 500,
          borderBottom: tab === "health" ? "2px solid #d97706" : "2px solid transparent", marginBottom: -1, cursor: "pointer", fontFamily: "inherit",
        }}>
          Scraper Health
        </button>
      </div>

      {loading && <div style={{ fontSize: 12, color: "#78716c" }}>Loading…</div>}

      {!loading && tab === "events" && (
        events.length === 0 ? (
          <div style={{ fontSize: 13, color: "#78716c", padding: 32, textAlign: "center", fontStyle: "italic", border: "1px dashed #292524", borderRadius: 8 }}>
            All docket events acknowledged. Great work.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {events.map(e => {
              const meta = eventMeta(e.event_type);
              return (
                <div key={e.id} style={{ padding: "12px 14px", background: "#0c0a09", border: "1px solid #292524", borderLeft: `3px solid ${meta.color}`, borderRadius: 6 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, flexWrap: "wrap" }}>
                    <div style={{ flex: 1, minWidth: 220 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                        <span style={{ fontSize: 14 }}>{meta.icon}</span>
                        <span style={{ fontSize: 10, fontWeight: 700, color: meta.color, letterSpacing: "0.08em", textTransform: "uppercase", padding: "2px 7px", background: meta.color + "22", borderRadius: 3 }}>{meta.label}</span>
                        <span style={{ fontSize: 11, color: "#78716c" }}>{e.event_date}</span>
                      </div>
                      <div style={{ fontSize: 13, color: "#fafaf9", marginTop: 6, lineHeight: 1.4 }}>{e.description}</div>
                      <div style={{ fontSize: 11, color: "#78716c", marginTop: 6 }}>
                        <button onClick={() => onJumpToDeal(e.deal_id)} style={{ background: "transparent", border: "none", color: "#93c5fd", fontSize: 11, cursor: "pointer", padding: 0, fontWeight: 600, fontFamily: "inherit" }}>
                          {e.deals?.name || e.deal_id} →
                        </button>
                        {e.county && <span> · {e.county}</span>}
                        {e.case_number && <span> · Case {e.case_number}</span>}
                      </div>
                    </div>
                    <button onClick={() => ack(e.id)} style={{ ...btnGhost, fontSize: 11, whiteSpace: "nowrap" }}>Acknowledge</button>
                  </div>
                </div>
              );
            })}
          </div>
        )
      )}

      {!loading && tab === "health" && (
        health.length === 0 ? (
          <div style={{ fontSize: 13, color: "#78716c", padding: 32, textAlign: "center", fontStyle: "italic", border: "1px dashed #292524", borderRadius: 8 }}>
            No scraper runs recorded yet. Castle will start writing here once the first monitor run completes.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {health.map(h => {
              const color = statusColor(h);
              return (
                <div key={h.county} style={{ padding: "12px 14px", background: "#0c0a09", border: "1px solid #292524", borderLeft: `3px solid ${color}`, borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
                  <div style={{ flex: 1, minWidth: 180 }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: "#fafaf9" }}>{h.county}</div>
                    <div style={{ fontSize: 11, color: "#78716c", marginTop: 4, display: "flex", gap: 14, flexWrap: "wrap" }}>
                      <span>Last run: {timeAgo(h.last_run_started)}</span>
                      <span>Last success: {timeAgo(h.last_success_at)}</span>
                      <span>Events 24h: <b style={{ color: "#fafaf9" }}>{h.events_24h || 0}</b></span>
                      <span>Events 7d: <b style={{ color: "#fafaf9" }}>{h.events_7d || 0}</b></span>
                      {h.failures_24h > 0 && <span style={{ color: "#ef4444", fontWeight: 700 }}>{h.failures_24h} failures in 24h</span>}
                    </div>
                  </div>
                  <span style={{ fontSize: 10, fontWeight: 700, padding: "4px 10px", borderRadius: 4, background: color + "22", color, letterSpacing: "0.06em", textTransform: "uppercase" }}>
                    {h.last_status}
                  </span>
                </div>
              );
            })}
          </div>
        )
      )}
    </Modal>
  );
}

function Documents({ items, dealId, deal, userId, logAct, reload }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [extracting, setExtracting] = useState({});
  const [expanded, setExpanded] = useState({});
  const [showLibraryPicker, setShowLibraryPicker] = useState(false);
  const [pickerMode, setPickerMode] = useState('attach'); // 'attach' | 'pin'
  const [pins, setPins] = useState([]);
  const [envelopes, setEnvelopes] = useState([]);
  const [showDocuSign, setShowDocuSign] = useState(false);
  const fileRef = useRef(null);

  // Drag-drop upload state. dragDepth tracks nested dragenter/dragleave so
  // child elements firing dragleave don't prematurely turn off the overlay.
  const [dragOver, setDragOver] = useState(false);
  const dragDepth = useRef(0);
  const [batchProgress, setBatchProgress] = useState(null); // { done, total, current }

  // Files-tab filtering UX: a gallery strip for photos+videos at the top,
  // chip-based source filter on the doc list below. Casey-Jennings-scale
  // deals (90+ docs, 70+ photos) are unscannable as one flat list.
  const [chip, setChip] = useState('all');                 // all | kevin | court | contracts | mine
  const [galleryExpanded, setGalleryExpanded] = useState(false);
  const [galleryThumbs, setGalleryThumbs] = useState({});  // doc.id → signed URL
  const [thumbsLoading, setThumbsLoading] = useState(false);

  // Lightbox state — click a thumb opens an in-page fullscreen viewer with
  // prev/next nav. lightboxIdx is the index into mediaItems, or null when
  // closed. Avoids opening a new tab per photo.
  const [lightboxIdx, setLightboxIdx] = useState(null);

  // Filing-date extractor. Every document Nathan uploads is a snapshot of
  // something that already happened at the courthouse. We pull the court-
  // action date from Claude Vision's extracted fields (falling through a
  // priority list matched to real field names in production) so the card
  // reflects "when it was filed" instead of "when it landed in DCC".
  // Future-looking fields (expiration, maturity, interest_start) are
  // explicitly skipped — they're not the court-action date.
  const FILING_DATE_FIELDS = [
    'filing_date', 'filed_date', 'filed_at',
    'order_date', 'order_of_sale_date', 'order_of_sale_issued_date',
    'confirmation_date',
    'sale_date', 'scheduled_sale_date', 'auction_scheduled_date',
    'effective_date',
    'entered_date',
    'signed_date', 'affidavit_date', 'date_signed',
    'recording_date', 'mortgage_recording_date', 'mortgage_recorded_date',
    'issue_date', 'issued_date',
    'service_date', 'summons_date', 'notice_publication_date',
    'mailing_date', 'delivery_date',
    'date',
  ];
  const parseFlex = (v) => {
    if (!v || typeof v !== 'string') return null;
    if (/^\d{4}-\d{2}-\d{2}/.test(v)) {
      const d = new Date(v + (v.length === 10 ? 'T00:00:00' : ''));
      return isNaN(d) ? null : d;
    }
    const mdy = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (mdy) {
      const d = new Date(`${mdy[3]}-${mdy[1].padStart(2,'0')}-${mdy[2].padStart(2,'0')}T00:00:00`);
      return isNaN(d) ? null : d;
    }
    const d = new Date(v);
    return isNaN(d) ? null : d;
  };
  const bestFilingDate = (fields) => {
    if (!fields || typeof fields !== 'object') return null;
    for (const key of FILING_DATE_FIELDS) {
      const d = parseFlex(fields[key]);
      if (d) return d;
    }
    // Last-resort: any _date field that's not in the blacklist
    const blacklist = /expiration|maturity|interest_start|interest_accrual|publication_dates$/i;
    for (const [k, v] of Object.entries(fields)) {
      if (!/_date$|^date$/i.test(k)) continue;
      if (blacklist.test(k)) continue;
      const d = parseFlex(v);
      if (d) return d;
    }
    return null;
  };

  // Sort documents by filing date (newest court action first), falling
  // back to upload date for docs where extraction hasn't run yet.
  const sortedItems = React.useMemo(() => {
    return [...items].sort((a, b) => {
      const ad = bestFilingDate(a.extracted?.fields) || new Date(a.created_at);
      const bd = bestFilingDate(b.extracted?.fields) || new Date(b.created_at);
      return bd.getTime() - ad.getTime();
    });
  }, [items]);

  const loadEnvelopes = async () => {
    const { data } = await sb.from('docusign_envelopes')
      .select('*, library_documents(title)')
      .eq('deal_id', dealId)
      .order('created_at', { ascending: false });
    setEnvelopes(data || []);
  };
  useEffect(() => { loadEnvelopes(); }, [dealId]);

  // Realtime — envelope status updates from webhook appear live
  useEffect(() => {
    const ch = sb.channel('ds-envelopes-' + dealId)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'docusign_envelopes', filter: `deal_id=eq.${dealId}` }, loadEnvelopes)
      .subscribe();
    return () => { sb.removeChannel(ch); };
  }, [dealId]);

  const loadPins = async () => {
    const { data } = await sb.from('deal_library_pins')
      .select('id, pinned_for, label, pinned_at, library_document_id, library_documents(id, title, path, size, mime_type, kind, external_url)')
      .eq('deal_id', dealId)
      .order('pinned_at', { ascending: false });
    setPins(data || []);
  };
  useEffect(() => { loadPins(); }, [dealId]);

  const openPinnedDoc = async (pin) => {
    const doc = pin.library_documents;
    if (!doc) return;
    if (doc.kind === 'link' && doc.external_url) { window.open(doc.external_url, '_blank'); return; }
    if (!doc.path) return;
    const { data, error } = await sb.storage.from('library').createSignedUrl(doc.path, 300);
    if (error || !data?.signedUrl) { alert("Couldn't open pinned doc: " + (error?.message || 'unknown')); return; }
    window.open(data.signedUrl, '_blank');
  };

  const unpin = async (pin) => {
    if (!confirm(`Unpin "${pin.label || pin.library_documents?.title || 'this doc'}" from this deal? The library file stays; only the deal-level pin is removed.`)) return;
    const { error } = await sb.from('deal_library_pins').delete().eq('id', pin.id);
    if (error) { alert(error.message); return; }
    if (logAct) await logAct(`📌 Unpinned library doc: ${pin.library_documents?.title || pin.label || '?'}`);
    await loadPins();
  };

  // HEIC → JPEG conversion. Same pattern as the JV portal — Mac/iPhone
   //   photos default to HEIC, but most browsers + email previews can't
   //   render them. We convert client-side via heic2any (loaded from CDN
   //   on demand) before upload. Falls back to uploading the original if
   //   conversion fails for any reason.
  const HEIC_LIB_URL = 'https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js';
  const ensureHeicLib = async () => {
    if (window.heic2any) return true;
    return new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = HEIC_LIB_URL;
      s.onload = () => resolve(!!window.heic2any);
      s.onerror = () => resolve(false);
      document.head.appendChild(s);
    });
  };
  const isHeic = (f) => /heic|heif/i.test(f?.type || '') || /\.(heic|heif)$/i.test(f?.name || '');
  const maybeConvertHeic = async (file) => {
    if (!isHeic(file)) return file;
    const ok = await ensureHeicLib();
    if (!ok) return file;
    try {
      const blob = await window.heic2any({ blob: file, toType: 'image/jpeg', quality: 0.9 });
      const jpegBlob = Array.isArray(blob) ? blob[0] : blob;
      const newName = file.name.replace(/\.(heic|heif)$/i, '.jpg');
      return new File([jpegBlob], newName, { type: 'image/jpeg', lastModified: file.lastModified });
    } catch (e) {
      console.warn('HEIC convert failed for', file.name, '— uploading original:', e);
      return file;
    }
  };

  // Upload one file end-to-end: storage → documents row → activity log → extract.
  const uploadOne = async (rawFile) => {
    const file = await maybeConvertHeic(rawFile);
    const path = `${dealId}/${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g,'_')}`;
    const up = await sb.storage.from('deal-docs').upload(path, file);
    if (up.error) throw new Error(up.error.message);
    const { data: inserted, error } = await sb.from('documents').insert({ deal_id: dealId, name: file.name, path, size: file.size, uploaded_by: userId, extraction_status: 'pending' }).select().single();
    if (error) throw new Error(error.message);
    await logAct(`Uploaded document: ${file.name}`);
    if (inserted) extract(inserted, true);  // fire-and-forget Vision extract
    return inserted;
  };

  // Upload many files sequentially (so we don't blow up storage quotas
  // on a 50-photo batch). Surfaces progress via batchProgress state.
  const uploadMany = async (rawFiles) => {
    const list = Array.from(rawFiles || []).filter(Boolean);
    if (!list.length) return;
    setBusy(true); setErr("");
    setBatchProgress({ done: 0, total: list.length, current: list[0]?.name || '' });
    let firstErr = null;
    for (let i = 0; i < list.length; i++) {
      setBatchProgress({ done: i, total: list.length, current: list[i].name });
      try {
        await uploadOne(list[i]);
      } catch (ex) {
        firstErr = firstErr || (list[i].name + ': ' + (ex.message || ex));
      }
    }
    setBatchProgress(null);
    setBusy(false);
    if (firstErr) setErr(firstErr);
    if (fileRef.current) fileRef.current.value = "";
    await reload();
  };

  // Single-file shim for the existing onChange (kept for the Upload File button).
  const upload = async (file) => uploadMany(file ? [file] : []);

  // Drag-drop handlers. The dragDepth ref handles nested elements firing
  // dragleave; without it the overlay flickers off when you cross a child boundary.
  const onDragEnter = (e) => {
    if (!Array.from(e.dataTransfer?.types || []).includes('Files')) return;
    e.preventDefault();
    dragDepth.current += 1;
    setDragOver(true);
  };
  const onDragOver = (e) => {
    if (!Array.from(e.dataTransfer?.types || []).includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };
  const onDragLeave = (e) => {
    e.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragOver(false);
  };
  const onDrop = (e) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDragOver(false);
    const dropped = e.dataTransfer?.files;
    if (dropped && dropped.length) uploadMany(dropped);
  };

  const openDoc = async (doc) => {
    const { data, error } = await sb.storage.from('deal-docs').createSignedUrl(doc.path, 300);
    if (error) { alert(error.message); return; }
    window.open(data.signedUrl, '_blank');
  };

  const removeDoc = async (doc) => {
    if (!confirm(`Delete "${doc.name}"? This cannot be undone.`)) return;
    await sb.storage.from('deal-docs').remove([doc.path]);
    await sb.from('documents').delete().eq('id', doc.id);
    await logAct(`Removed document: ${doc.name}`);
    await reload();
  };

  const extract = async (doc, silent = false) => {
    setExtracting(prev => ({ ...prev, [doc.id]: true }));
    try {
      const { data, error } = await sb.functions.invoke('extract-document', { body: { documentId: doc.id } });
      if (error) {
        if (!silent) alert('Extraction failed: ' + (error.message || 'unknown'));
      } else if (!silent && data?.extracted) {
        setExpanded(prev => ({ ...prev, [doc.id]: true }));
      }
    } catch (e) {
      if (!silent) alert('Extraction error: ' + e.message);
    } finally {
      setExtracting(prev => ({ ...prev, [doc.id]: false }));
      await reload();
    }
  };

  const fmtSize = (b) => b < 1024 ? `${b} B` : b < 1024*1024 ? `${(b/1024).toFixed(1)} KB` : `${(b/1024/1024).toFixed(1)} MB`;

  const DOC_TYPE_META = {
    // Surplus-specific
    engagement_agreement:      { label: 'Engagement Agreement', color: '#065f46', bg: '#064e3b', text: '#6ee7b7' },
    surplus_distribution_order:{ label: 'Distribution Order',   color: '#065f46', bg: '#064e3b', text: '#34d399' },
    sheriff_sale_confirmation:  { label: 'Sale Confirmation',    color: '#065f46', bg: '#064e3b', text: '#6ee7b7' },
    notice_of_default:         { label: 'Notice of Default',     color: '#92400e', bg: '#78350f', text: '#fcd34d' },
    proof_of_claim:            { label: 'Proof of Claim',        color: '#1e3a5f', bg: '#1e3a5f', text: '#93c5fd' },
    distribution_check:        { label: 'Distribution Check',    color: '#065f46', bg: '#14532d', text: '#86efac' },
    // General legal
    death_certificate:         { label: 'Death Certificate',     color: '#4c1d95', bg: '#3b0764', text: '#c4b5fd' },
    id_document:               { label: 'ID / License',          color: '#374151', bg: '#1f2937', text: '#d1d5db' },
    deed:                      { label: 'Deed',                  color: '#78350f', bg: '#451a03', text: '#fde68a' },
    power_of_attorney:         { label: 'Power of Attorney',     color: '#4c1d95', bg: '#3b0764', text: '#c4b5fd' },
    probate_document:          { label: 'Probate Document',      color: '#4c1d95', bg: '#3b0764', text: '#c4b5fd' },
    bank_statement:            { label: 'Bank Statement',        color: '#374151', bg: '#1f2937', text: '#d1d5db' },
    correspondence:            { label: 'Correspondence',        color: '#374151', bg: '#1f2937', text: '#9ca3af' },
    court_filing:              { label: 'Court Filing',          color: '#1e3a5f', bg: '#1e3a5f', text: '#93c5fd' },
    other:                     { label: 'Other',                 color: '#292524', bg: '#1c1917', text: '#a8a29e' },
  };
  const getTypeMeta = (t) => DOC_TYPE_META[t] || { label: (t||'').replace(/_/g,' ').replace(/\b\w/g,c=>c.toUpperCase()), bg: '#292524', text: '#a8a29e' };

  // Fields that represent dollar amounts — formatted with $
  const MONEY_FIELDS = new Set(['surplus_amount','surplus_amount_estimated','sale_price','minimum_bid',
    'judgment_amount','amount_claimed','claimant_share','consideration','ending_balance','amount']);
  const PCT_FIELDS = new Set(['fee_percentage']);
  // Fields shown as highlighted "key numbers" at the top of the extraction panel
  const KEY_FIELDS = ['surplus_amount','surplus_amount_estimated','judgment_amount','sale_price',
    'fee_percentage','amount_claimed','claimant_share','amount'];

  const fmtFieldValue = (key, v) => {
    if (v === null || v === undefined) return <span style={{ color: "#57534e", fontStyle: "italic" }}>—</span>;
    if (typeof v === 'boolean') return v ? 'Yes' : 'No';
    if (typeof v === 'number') {
      if (MONEY_FIELDS.has(key)) return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      if (PCT_FIELDS.has(key)) return `${v}%`;
      return v.toLocaleString();
    }
    return String(v);
  };

  // Source classification — used by the chip filter. Precedence is
  // explicit so a doc only counts in one category: Kevin > Court > Contracts > Mine > Other.
  const isImage = (d) => /\.(jpg|jpeg|png|webp|heic|heif|gif)$/i.test(d?.name || '');
  const isVideo = (d) => /\.(mp4|mov|m4v|webm|avi|mkv)$/i.test(d?.name || '');
  const isMedia = (d) => isImage(d) || isVideo(d);
  const docSource = (d) => {
    if (d.uploaded_by_partner_access_id) return 'kevin';
    const t = d.extracted?.document_type;
    if (t === 'court_filing') return 'court';
    if (t === 'engagement_agreement' || t === 'deed' || t === 'power_of_attorney' || t === 'probate_document') return 'contracts';
    if (d.uploaded_by && userId && d.uploaded_by === userId) return 'mine';
    return 'other';
  };

  // Split into media (gallery strip) vs documents (filterable list).
  const mediaItems    = sortedItems.filter(isMedia);
  const documentItems = sortedItems.filter(d => !isMedia(d));

  // Per-source counts (only for documents, not media — gallery is shown separately).
  const sourceCounts = documentItems.reduce((acc, d) => {
    const s = docSource(d);
    acc[s] = (acc[s] || 0) + 1;
    acc.all = (acc.all || 0) + 1;
    return acc;
  }, { all: 0, kevin: 0, court: 0, contracts: 0, mine: 0, other: 0 });

  // Filtered doc list per chip selection.
  const filteredDocs = chip === 'all' ? documentItems : documentItems.filter(d => docSource(d) === chip);

  // Lazy-load thumbnails for the gallery strip. Use a worker pool with
  // concurrency 8; same pattern as the JV portal so 70-photo galleries
  // don't sequentially round-trip and freeze the UI.
  useEffect(() => {
    if (!mediaItems.length) return;
    let cancelled = false;
    setThumbsLoading(true);
    (async () => {
      const queue = mediaItems.filter(m => isImage(m) && !galleryThumbs[m.id]).map(m => m);
      if (!queue.length) { setThumbsLoading(false); return; }
      const CONCURRENCY = 8;
      const worker = async () => {
        while (!cancelled && queue.length) {
          const m = queue.shift();
          if (!m) break;
          const { data } = await sb.storage.from('deal-docs').createSignedUrl(m.path, 3600);
          if (cancelled) return;
          if (data?.signedUrl) {
            setGalleryThumbs(prev => ({ ...prev, [m.id]: data.signedUrl }));
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
      if (!cancelled) setThumbsLoading(false);
    })();
    return () => { cancelled = true; };
  }, [mediaItems.length]);

  const COLLAPSED_GALLERY_COUNT = 8;
  const visibleMedia = galleryExpanded ? mediaItems : mediaItems.slice(0, COLLAPSED_GALLERY_COUNT);

  // Lightbox keyboard navigation. Bound to document so arrow keys work
  // even when no specific element has focus.
  useEffect(() => {
    if (lightboxIdx === null) return;
    const onKey = (e) => {
      if (e.key === 'Escape') { setLightboxIdx(null); }
      else if (e.key === 'ArrowRight') { setLightboxIdx(i => i === null ? null : Math.min(mediaItems.length - 1, i + 1)); }
      else if (e.key === 'ArrowLeft')  { setLightboxIdx(i => i === null ? null : Math.max(0, i - 1)); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [lightboxIdx, mediaItems.length]);

  // When lightbox opens to a thumb that hasn't been loaded yet (user expanded
  // gallery and clicked one beyond the lazy-load batch), fetch its signed URL.
  useEffect(() => {
    if (lightboxIdx === null) return;
    const m = mediaItems[lightboxIdx];
    if (!m || galleryThumbs[m.id]) return;
    let cancelled = false;
    (async () => {
      const { data } = await sb.storage.from('deal-docs').createSignedUrl(m.path, 3600);
      if (cancelled) return;
      if (data?.signedUrl) setGalleryThumbs(prev => ({ ...prev, [m.id]: data.signedUrl }));
    })();
    return () => { cancelled = true; };
  }, [lightboxIdx]);

  // Chip definitions — order matters for the chip bar layout.
  const chips = [
    { id: 'all',       label: 'All',         color: '#fafaf9' },
    { id: 'kevin',     label: '🤝 Kevin',     color: '#fbbf24' },
    { id: 'court',     label: '📋 Court',     color: '#93c5fd' },
    { id: 'contracts', label: '📑 Contracts', color: '#6ee7b7' },
    { id: 'mine',      label: '👤 Mine',      color: '#d8b560' },
    { id: 'other',     label: '· Other',      color: '#a8a29e' },
  ].filter(c => c.id === 'all' || sourceCounts[c.id] > 0);

  return (
    <div
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      style={{ position: "relative" }}
    >
      {/* Lightbox: click a thumb opens this inline fullscreen viewer.
           Arrow keys ← → navigate, Esc closes, click backdrop closes too.
           Videos render with native <video controls>; images get max-fit. */}
      {lightboxIdx !== null && mediaItems[lightboxIdx] && (() => {
        const cur = mediaItems[lightboxIdx];
        const url = galleryThumbs[cur.id];
        const video = isVideo(cur);
        const canPrev = lightboxIdx > 0;
        const canNext = lightboxIdx < mediaItems.length - 1;
        const isJvCover = !video && deal?.meta?.partner?.coverPhotoPath === cur.path;
        const setAsJvCover = async () => {
          // Toggle: if already cover, unset. If not, set + auto-flag partner_visible
          // (you wouldn't pick a cover photo Kevin can't see).
          const newCover = isJvCover ? null : cur.path;
          const newPartnerMeta = { ...(deal.meta?.partner || {}), coverPhotoPath: newCover };
          await sb.from('deals').update({ meta: { ...(deal.meta || {}), partner: newPartnerMeta } }).eq('id', deal.id);
          if (!isJvCover && !cur.partner_visible) {
            await sb.from('documents').update({ partner_visible: true }).eq('id', cur.id);
          }
          await reload();
        };
        return (
          <div
            onClick={() => setLightboxIdx(null)}
            style={{
              position: "fixed", inset: 0, zIndex: 1000,
              background: "rgba(0,0,0,0.92)",
              display: "flex", alignItems: "center", justifyContent: "center",
              padding: 20,
            }}
          >
            {/* Top bar: filename + counter + actions */}
            <div onClick={e => e.stopPropagation()} style={{ position: "absolute", top: 0, left: 0, right: 0, padding: "16px 24px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, color: "#fafaf9", background: "linear-gradient(to bottom, rgba(0,0,0,0.7), transparent)", pointerEvents: "none" }}>
              <div style={{ pointerEvents: "auto" }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{cur.name}</div>
                <div style={{ fontSize: 11, color: "#a8a29e", marginTop: 2 }}>
                  {lightboxIdx + 1} of {mediaItems.length}
                  {docSource(cur) === 'kevin' && <span style={{ color: "#fbbf24", marginLeft: 8 }}>🤝 Kevin</span>}
                  {isJvCover && <span style={{ color: "#6ee7b7", marginLeft: 8 }}>★ JV cover</span>}
                  {' · '}{fmtSize(cur.size || 0)}
                  {' · '}{new Date(cur.created_at).toLocaleDateString()}
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, pointerEvents: "auto" }}>
                {!video && (deal.type === 'flip' || deal.type === 'wholesale') && (
                  <button
                    onClick={setAsJvCover}
                    title={isJvCover ? "Currently the JV portal hero photo — click to unset" : "Make this the JV portal hero photo Kevin sees"}
                    style={{
                      background: isJvCover ? "rgba(110,231,183,0.15)" : "rgba(0,0,0,0.5)",
                      color: isJvCover ? "#6ee7b7" : "#fbbf24",
                      border: "1px solid " + (isJvCover ? "#065f46" : "#92400e"),
                      borderRadius: 6, padding: "6px 12px", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit"
                    }}
                  >{isJvCover ? '✓ JV cover' : '★ Set as JV cover'}</button>
                )}
                <button
                  onClick={() => setLightboxIdx(null)}
                  style={{ background: "rgba(0,0,0,0.5)", color: "#fafaf9", border: "1px solid #44403c", borderRadius: 6, padding: "6px 12px", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}
                  title="Close (Esc)"
                >× Close</button>
              </div>
            </div>

            {/* Prev arrow */}
            {canPrev && (
              <button
                onClick={e => { e.stopPropagation(); setLightboxIdx(lightboxIdx - 1); }}
                style={{ position: "absolute", left: 20, top: "50%", transform: "translateY(-50%)", background: "rgba(0,0,0,0.5)", color: "#fafaf9", border: "1px solid #44403c", borderRadius: "50%", width: 50, height: 50, fontSize: 22, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "inherit" }}
                title="Previous (←)"
              >‹</button>
            )}
            {/* Next arrow */}
            {canNext && (
              <button
                onClick={e => { e.stopPropagation(); setLightboxIdx(lightboxIdx + 1); }}
                style={{ position: "absolute", right: 20, top: "50%", transform: "translateY(-50%)", background: "rgba(0,0,0,0.5)", color: "#fafaf9", border: "1px solid #44403c", borderRadius: "50%", width: 50, height: 50, fontSize: 22, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "inherit" }}
                title="Next (→)"
              >›</button>
            )}

            {/* Main media */}
            <div onClick={e => e.stopPropagation()} style={{ maxWidth: "90vw", maxHeight: "85vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
              {!url ? (
                <div style={{ color: "#a8a29e", fontSize: 14 }}>Loading…</div>
              ) : video ? (
                <video src={url} controls autoPlay playsInline style={{ maxWidth: "90vw", maxHeight: "85vh", borderRadius: 6, background: "#000" }} />
              ) : (
                <img src={url} alt={cur.name} style={{ maxWidth: "90vw", maxHeight: "85vh", borderRadius: 6, objectFit: "contain" }} />
              )}
            </div>

            {/* Bottom hint */}
            <div onClick={e => e.stopPropagation()} style={{ position: "absolute", bottom: 16, left: 0, right: 0, textAlign: "center", color: "#78716c", fontSize: 11, pointerEvents: "none" }}>
              ← → to navigate · Esc to close
            </div>
          </div>
        );
      })()}

      {dragOver && (
        <div style={{
          position: "absolute", inset: 0, zIndex: 20,
          background: "rgba(120, 53, 15, 0.18)",
          border: "3px dashed #d97706",
          borderRadius: 12,
          display: "flex", alignItems: "center", justifyContent: "center",
          pointerEvents: "none",
        }}>
          <div style={{ background: "#1c1917", padding: "16px 24px", borderRadius: 10, border: "1px solid #d97706", boxShadow: "0 8px 24px rgba(0,0,0,0.4)" }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: "#fbbf24", marginBottom: 4 }}>📥 Drop to upload</div>
            <div style={{ fontSize: 12, color: "#a8a29e" }}>Photos, videos, PDFs — multi-select OK · HEIC auto-converts</div>
          </div>
        </div>
      )}
      {batchProgress && (
        <div style={{ marginBottom: 10, padding: "10px 14px", background: "#0c0a09", border: "1px solid #92400e", borderRadius: 8, display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ fontSize: 12, color: "#fbbf24", fontWeight: 600 }}>
            Uploading {batchProgress.done + 1} / {batchProgress.total}
          </div>
          <div style={{ flex: 1, fontSize: 11, color: "#a8a29e", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {batchProgress.current}
          </div>
          <div style={{ width: 120, height: 4, background: "#292524", borderRadius: 2, overflow: "hidden" }}>
            <div style={{ width: `${(batchProgress.done / batchProgress.total) * 100}%`, height: "100%", background: "#d97706", transition: "width 0.2s" }} />
          </div>
        </div>
      )}
      <Card title={`Documents (${items.length}${pins.length > 0 ? ' · ' + pins.length + ' pinned' : ''})`} action={
      <div style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>
        <button onClick={() => setShowDocuSign(true)} title="Send a library template via DocuSign for e-signature (email + optional SMS)" style={{ ...btnGhost, fontSize: 11, color: "#d97706", borderColor: "#78350f" }}>
          📝 Send for signature
        </button>
        <button onClick={() => { setPickerMode('pin'); setShowLibraryPicker(true); }} title="Expose a library doc on this deal's client or attorney portal without copying" style={{ ...btnGhost, fontSize: 11 }}>
          📌 Pin from library
        </button>
        <button onClick={() => { setPickerMode('attach'); setShowLibraryPicker(true); }} title="Clone a library file into this deal's documents" style={{ ...btnGhost, fontSize: 11 }}>
          📚 From library
        </button>
        <label style={{ ...btnPrimary, cursor: "pointer", display: "inline-block", opacity: busy ? 0.5 : 1 }} title="Or drag-and-drop files anywhere onto this Files area">
          {busy ? "Uploading..." : "+ Upload Files"}
          <input ref={fileRef} type="file" multiple style={{ display: "none" }} disabled={busy} onChange={e => uploadMany(e.target.files)} />
        </label>
      </div>
    }>
      {showLibraryPicker && (
        <LibraryPickerForDeal
          deal={deal}
          dealId={dealId}
          userId={userId}
          logAct={logAct}
          mode={pickerMode}
          onClose={() => setShowLibraryPicker(false)}
          onAttached={async () => { await reload(); setShowLibraryPicker(false); }}
          onPinned={async () => { await loadPins(); setShowLibraryPicker(false); }}
        />
      )}

      {showDocuSign && (
        <DocuSignSendModal
          deal={deal}
          dealId={dealId}
          onClose={() => setShowDocuSign(false)}
          onSent={async () => { await loadEnvelopes(); setShowDocuSign(false); }}
        />
      )}

      {/* Active envelope status cards — realtime */}
      {envelopes.length > 0 && (
        <div style={{ marginBottom: 14, padding: "10px 12px", background: "#0c0a09", border: "1px solid #292524", borderLeft: "3px solid #d97706", borderRadius: 6 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: "#d97706", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 8 }}>
            📝 DocuSign envelopes ({envelopes.length})
          </div>
          {envelopes.map(env => {
            const statusColor = env.status === 'completed' ? "#10b981"
              : env.status === 'declined' || env.status === 'voided' || env.status === 'failed' ? "#ef4444"
              : env.status === 'signed' ? "#10b981"
              : env.status === 'delivered' ? "#3b82f6"
              : env.status === 'sent' || env.status === 'sending' ? "#f59e0b"
              : "#78716c";
            const statusLabel = env.status === 'sending' ? 'Queuing…'
              : env.status === 'sent' ? 'Waiting for signature'
              : env.status === 'delivered' ? 'Opened by signer'
              : env.status === 'signed' ? 'Signed'
              : env.status === 'completed' ? 'Completed · filed to docs'
              : env.status === 'declined' ? 'Declined by signer'
              : env.status === 'voided' ? 'Voided'
              : env.status === 'failed' ? 'Send failed'
              : env.status;
            return (
              <div key={env.id} style={{ padding: "8px 0", borderBottom: "1px solid #1c1917" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 14 }}>📝</span>
                  <div style={{ flex: 1, minWidth: 180 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: "#fafaf9" }}>
                      {env.library_documents?.title || 'Document'}
                    </div>
                    <div style={{ fontSize: 10, color: "#78716c", marginTop: 2 }}>
                      {env.recipient_name} · {env.recipient_email}{env.send_sms ? ' · + SMS' : ''}
                      {env.sent_at && <> · sent {new Date(env.sent_at).toLocaleString()}</>}
                    </div>
                  </div>
                  <span style={{ fontSize: 10, fontWeight: 700, padding: "3px 8px", borderRadius: 3, background: statusColor + '22', color: statusColor, letterSpacing: "0.06em", textTransform: "uppercase", whiteSpace: "nowrap" }}>
                    {statusLabel}
                  </span>
                </div>
                {env.ds_error && (
                  <div style={{ fontSize: 10, color: "#fca5a5", marginTop: 4, fontFamily: "'DM Mono', monospace" }}>{env.ds_error}</div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Pinned library docs — visible on client/attorney portals per pin audience */}
      {pins.length > 0 && (
        <div style={{ marginBottom: 14, padding: "10px 12px", background: "#0c0a09", border: "1px dashed #44403c", borderRadius: 8 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: "#d97706", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 8 }}>
            📌 Pinned from library · visible on {pins.some(p => (p.pinned_for || []).includes('client')) ? 'client' : ''}{pins.some(p => (p.pinned_for || []).includes('client')) && pins.some(p => (p.pinned_for || []).includes('attorney')) ? ' + ' : ''}{pins.some(p => (p.pinned_for || []).includes('attorney')) ? 'attorney' : ''} portal{pins.length === 1 ? '' : 's'}
          </div>
          {pins.map(pin => {
            const d = pin.library_documents;
            if (!d) return null;
            const aud = (pin.pinned_for || []);
            return (
              <div key={pin.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderBottom: "1px solid #1c1917" }}>
                <span style={{ fontSize: 14 }}>{d.kind === 'template' ? '📝' : d.kind === 'video' ? '🎥' : d.kind === 'image' ? '🖼' : d.kind === 'link' ? '🔗' : '📄'}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: "#fafaf9", cursor: "pointer", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} onClick={() => openPinnedDoc(pin)}>
                    {pin.label || d.title}
                  </div>
                  <div style={{ fontSize: 10, color: "#78716c", marginTop: 1, display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {aud.includes('client') && <span style={{ color: "#6ee7b7" }}>👤 client</span>}
                    {aud.includes('attorney') && <span style={{ color: "#c4b5fd" }}>⚖ attorney</span>}
                    <span>pinned {new Date(pin.pinned_at).toLocaleDateString()}</span>
                  </div>
                </div>
                <button onClick={() => openPinnedDoc(pin)} style={{ ...btnGhost, fontSize: 10, padding: "3px 8px" }}>Open</button>
                <button onClick={() => unpin(pin)} style={{ ...btnGhost, fontSize: 10, padding: "3px 8px", color: "#ef4444" }}>Unpin</button>
              </div>
            );
          })}
        </div>
      )}

      {err && <div style={{ fontSize: 12, color: "#fca5a5", marginBottom: 10 }}>{err}</div>}
      {items.length === 0 && <div style={{ fontSize: 12, color: "#78716c", padding: 20, textAlign: "center" }}>No documents yet. Upload engagement agreements, distribution orders, sale confirmations, NODs, proof of claim, death certificates, IDs, deeds, or any court filing. Claude Vision reads each file and extracts key fields — surplus amounts, case numbers, dates, fee percentages — automatically.</div>}

      {/* Gallery strip: photos + videos at the top, expandable. */}
      {mediaItems.length > 0 && (
        <div style={{ marginBottom: 18, padding: "12px 14px", background: "#0c0a09", border: "1px solid #292524", borderRadius: 8 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10, gap: 8, flexWrap: "wrap" }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: "#78716c", letterSpacing: "0.12em", textTransform: "uppercase" }}>
              📷 Photos &amp; Videos · {mediaItems.length}
              {thumbsLoading && <span style={{ color: "#57534e", marginLeft: 8, fontWeight: 500, textTransform: "none", letterSpacing: 0 }}>loading…</span>}
            </div>
            {mediaItems.length > COLLAPSED_GALLERY_COUNT && (
              <button onClick={() => setGalleryExpanded(v => !v)} style={{ ...btnGhost, fontSize: 11, padding: "3px 10px" }}>
                {galleryExpanded ? `Collapse (showing ${mediaItems.length})` : `Show all ${mediaItems.length} →`}
              </button>
            )}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: 8 }}>
            {visibleMedia.map((m, idx) => {
              const url = galleryThumbs[m.id];
              const video = isVideo(m);
              return (
                <div key={m.id}
                  onClick={() => setLightboxIdx(idx)}
                  title={m.name}
                  style={{
                    aspectRatio: '4/3',
                    background: url ? `#000 center/cover no-repeat url(${url})` : "#1c1917",
                    borderRadius: 6,
                    border: "1px solid #292524",
                    cursor: "pointer",
                    position: "relative",
                    transition: "transform .12s",
                  }}
                  onMouseEnter={e => e.currentTarget.style.transform = 'scale(1.02)'}
                  onMouseLeave={e => e.currentTarget.style.transform = 'scale(1)'}
                >
                  {video && (
                    <>
                      <div style={{ position: "absolute", top: 4, left: 4, fontSize: 9, fontWeight: 700, color: "#fff", background: "rgba(0,0,0,0.7)", padding: "2px 6px", borderRadius: 3, letterSpacing: "0.05em" }}>VIDEO</div>
                      <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 28, textShadow: "0 2px 8px rgba(0,0,0,0.6)", pointerEvents: "none" }}>▶</div>
                    </>
                  )}
                  {!url && !video && (
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "#57534e", fontSize: 18 }}>📷</div>
                  )}
                  {/* Source pill on each thumb */}
                  {(() => {
                    const src = docSource(m);
                    if (src === 'kevin') return <div style={{ position: "absolute", bottom: 4, right: 4, fontSize: 9, fontWeight: 700, color: "#fbbf24", background: "rgba(0,0,0,0.7)", padding: "1px 5px", borderRadius: 3 }}>🤝 Kevin</div>;
                    return null;
                  })()}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Filter chips — show only when there are 6+ docs to avoid noise on small deals. */}
      {documentItems.length >= 6 && chips.length > 1 && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 14 }}>
          {chips.map(c => {
            const active = chip === c.id;
            const count = sourceCounts[c.id] || 0;
            return (
              <button
                key={c.id}
                onClick={() => setChip(c.id)}
                style={{
                  background: active ? c.color + '22' : 'transparent',
                  color: active ? c.color : '#a8a29e',
                  border: '1px solid ' + (active ? c.color + '88' : '#292524'),
                  padding: '5px 11px',
                  borderRadius: 999,
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                  transition: 'all 0.12s',
                }}
              >
                {c.label} · {count}
              </button>
            );
          })}
        </div>
      )}

      {/* No-results-for-this-chip empty state */}
      {documentItems.length > 0 && filteredDocs.length === 0 && (
        <div style={{ fontSize: 12, color: "#78716c", fontStyle: "italic", padding: 16, textAlign: "center" }}>
          No documents in this category. <button onClick={() => setChip('all')} style={{ ...btnGhost, fontSize: 11, padding: "2px 8px", marginLeft: 6 }}>Show all</button>
        </div>
      )}

      {filteredDocs.map(doc => {
        const status = doc.extraction_status;
        const isExtracting = extracting[doc.id] || status === 'processing';
        // Default to expanded so the AI analysis is visible without a click.
        // User can still collapse by clicking "Hide fields".
        const isExpanded = expanded[doc.id] !== false;
        const extractedFields = doc.extracted?.fields || {};
        const hasFields = Object.keys(extractedFields).length > 0;
        const filingDate = bestFilingDate(extractedFields);
        const uploadedDate = new Date(doc.created_at);
        return (
          <div key={doc.id} style={{ padding: "12px 0", borderBottom: "1px solid #292524" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, cursor: "pointer", color: "#d97706", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} onClick={() => openDoc(doc)}>{doc.name}</div>
                  {status === 'done' && doc.extracted?.document_type && (() => {
                    const m = getTypeMeta(doc.extracted.document_type);
                    return <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 7px", borderRadius: 3, background: m.bg, color: m.text, letterSpacing: "0.06em", textTransform: "uppercase", whiteSpace: "nowrap" }}>{m.label}</span>;
                  })()}
                  {status === 'processing' && (
                    <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 7px", borderRadius: 3, background: "#1e3a5f", color: "#93c5fd", letterSpacing: "0.06em", textTransform: "uppercase" }}>Analyzing…</span>
                  )}
                  {status === 'failed' && (
                    <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 7px", borderRadius: 3, background: "#7f1d1d", color: "#fca5a5", letterSpacing: "0.06em", textTransform: "uppercase" }} title={doc.extraction_error}>Extract failed</span>
                  )}
                  {status === 'skipped' && (
                    <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 7px", borderRadius: 3, background: "#292524", color: "#a8a29e", letterSpacing: "0.06em", textTransform: "uppercase" }} title={doc.extraction_error}>No OCR</span>
                  )}
                </div>
                <div style={{ fontSize: 10, color: "#78716c", marginTop: 2 }}>
                  {fmtSize(doc.size || 0)}
                  {filingDate ? (
                    <>
                      {' · '}<span style={{ color: '#fbbf24', fontWeight: 600 }}>Filed {filingDate.toLocaleDateString()}</span>
                      <span style={{ color: '#44403c' }}> · uploaded {uploadedDate.toLocaleDateString()}</span>
                    </>
                  ) : (
                    <>
                      {' · '}<span>Uploaded {uploadedDate.toLocaleDateString()}</span>
                      {status === 'done' && <span style={{ color: '#44403c' }}> · no filing date extracted</span>}
                    </>
                  )}
                  {doc.extracted?.summary && ` · ${doc.extracted.summary}`}
                </div>
              </div>
              <div style={{ display: "flex", gap: 6, flexShrink: 0, alignItems: "center" }}>
                {/* Investor visibility toggle + cover-photo picker. Flip deals only benefit from these,
                    but we show on all deal types so any shared content can route through the investor portal. */}
                <label style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 10, color: doc.investor_visible ? "#fbbf24" : "#57534e", cursor: "pointer", padding: "4px 8px", border: "1px solid " + (doc.investor_visible ? "#92400e" : "#292524"), borderRadius: 4, background: doc.investor_visible ? "#78350f22" : "transparent" }} title="Show this document on the Investor Portal">
                  <input type="checkbox" checked={!!doc.investor_visible} onChange={async (e) => {
                    await sb.from('documents').update({ investor_visible: e.target.checked }).eq('id', doc.id);
                    await reload();
                  }} style={{ margin: 0 }} />
                  👤 Investor
                </label>
                {doc.investor_visible && /\.(jpg|jpeg|png|webp|heic|gif)$/i.test(doc.name) && (
                  <button
                    onClick={async () => {
                      const isCover = (deal.meta?.investor?.coverPhotoPath === doc.path);
                      const newInv = { ...(deal.meta?.investor || {}), coverPhotoPath: isCover ? null : doc.path };
                      await sb.from('deals').update({ meta: { ...(deal.meta || {}), investor: newInv } }).eq('id', deal.id);
                      await reload();
                    }}
                    title={deal.meta?.investor?.coverPhotoPath === doc.path ? "Cover photo — click to unset" : "Set as cover photo"}
                    style={{ ...btnGhost, fontSize: 12, padding: "3px 8px", color: deal.meta?.investor?.coverPhotoPath === doc.path ? "#fbbf24" : "#57534e", borderColor: deal.meta?.investor?.coverPhotoPath === doc.path ? "#92400e" : "#292524" }}
                  >★</button>
                )}
                {/* JV partner visibility toggle — separate from investor (different audience). Shows on flip + wholesale deals where a JV partner could be attached. */}
                {(deal.type === 'flip' || deal.type === 'wholesale') && (
                  <label style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 10, color: doc.partner_visible ? "#fbbf24" : "#57534e", cursor: "pointer", padding: "4px 8px", border: "1px solid " + (doc.partner_visible ? "#92400e" : "#292524"), borderRadius: 4, background: doc.partner_visible ? "#78350f22" : "transparent" }} title="Show this document on the JV Partner Portal">
                    <input type="checkbox" checked={!!doc.partner_visible} onChange={async (e) => {
                      await sb.from('documents').update({ partner_visible: e.target.checked }).eq('id', doc.id);
                      await reload();
                    }} style={{ margin: 0 }} />
                    🤝 JV
                  </label>
                )}
                {doc.partner_visible && /\.(jpg|jpeg|png|webp|heic|gif)$/i.test(doc.name) && (
                  <button
                    onClick={async () => {
                      const isCover = (deal.meta?.partner?.coverPhotoPath === doc.path);
                      const newP = { ...(deal.meta?.partner || {}), coverPhotoPath: isCover ? null : doc.path };
                      await sb.from('deals').update({ meta: { ...(deal.meta || {}), partner: newP } }).eq('id', deal.id);
                      await reload();
                    }}
                    title={deal.meta?.partner?.coverPhotoPath === doc.path ? "JV cover photo — click to unset" : "Set as JV cover photo"}
                    style={{ ...btnGhost, fontSize: 12, padding: "3px 8px", color: deal.meta?.partner?.coverPhotoPath === doc.path ? "#6ee7b7" : "#57534e", borderColor: deal.meta?.partner?.coverPhotoPath === doc.path ? "#065f46" : "#292524" }}
                  >★JV</button>
                )}
                {status === 'done' && hasFields && (
                  <button onClick={() => setExpanded(prev => ({ ...prev, [doc.id]: !isExpanded }))} style={{ ...btnGhost, fontSize: 11, padding: "4px 10px" }}>{isExpanded ? 'Hide fields' : 'Show fields'}</button>
                )}
                {(!status || status === 'failed' || status === 'pending') && (
                  <button onClick={() => extract(doc)} disabled={isExtracting} style={{ ...btnGhost, fontSize: 11, padding: "4px 10px", color: "#d97706" }}>
                    {isExtracting ? 'Analyzing…' : status === 'failed' ? 'Retry' : 'Extract'}
                  </button>
                )}
                <button onClick={() => openDoc(doc)} style={{ ...btnGhost, fontSize: 11, padding: "4px 10px" }}>Open</button>
                <button onClick={() => removeDoc(doc)} style={{ ...btnGhost, fontSize: 11, padding: "4px 10px", color: "#fca5a5", borderColor: "#7f1d1d" }}>Delete</button>
              </div>
            </div>
            {isExpanded && status === 'done' && (() => {
              const keyHighlights = KEY_FIELDS.filter(k => extractedFields[k] != null);
              const otherFields = Object.entries(extractedFields).filter(([k, v]) => v != null && !KEY_FIELDS.includes(k));
              const conf = doc.extracted?.confidence;
              const confColor = conf === 'high' ? '#34d399' : conf === 'medium' ? '#fcd34d' : '#fca5a5';
              return (
                <div style={{ marginTop: 10, padding: 12, background: "#0c0a09", border: "1px solid #292524", borderRadius: 6 }}>
                  {keyHighlights.length > 0 && (
                    <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 12, padding: "10px 12px", background: "#0f172a", borderRadius: 5, border: "1px solid #1e3a5f" }}>
                      {keyHighlights.map(k => (
                        <div key={k}>
                          <div style={{ fontSize: 9, fontWeight: 700, color: "#64748b", letterSpacing: "0.08em", textTransform: "uppercase" }}>{k.replace(/_/g, ' ')}</div>
                          <div style={{ fontSize: 16, fontWeight: 700, color: "#fbbf24", marginTop: 1 }}>{fmtFieldValue(k, extractedFields[k])}</div>
                        </div>
                      ))}
                    </div>
                  )}
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 8 }}>
                    {otherFields.map(([key, value]) => (
                      <div key={key}>
                        <div style={{ fontSize: 9, fontWeight: 700, color: "#78716c", letterSpacing: "0.08em", textTransform: "uppercase" }}>{key.replace(/_/g, ' ')}</div>
                        <div style={{ fontSize: 12, color: "#d6d3d1", marginTop: 2, wordBreak: "break-word" }}>{fmtFieldValue(key, value)}</div>
                      </div>
                    ))}
                  </div>
                  {doc.extracted?.notes && (
                    <div style={{ marginTop: 10, padding: "8px 10px", background: "#1c1917", borderRadius: 4, fontSize: 11, color: "#a8a29e", fontStyle: "italic" }}>
                      Note: {doc.extracted.notes}
                    </div>
                  )}
                  <div style={{ fontSize: 10, color: "#57534e", marginTop: 8, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span>Extracted by Claude Vision · {doc.extracted_at ? new Date(doc.extracted_at).toLocaleString() : ''}</span>
                    {conf && <span style={{ fontWeight: 700, color: confColor }}>{conf} confidence</span>}
                  </div>
                </div>
              );
            })()}
            {status === 'failed' && doc.extraction_error && (
              <div style={{ marginTop: 8, padding: "6px 10px", background: "#0c0a09", border: "1px solid #7f1d1d", borderRadius: 4, fontSize: 11, color: "#fca5a5" }}>
                {doc.extraction_error}
              </div>
            )}
          </div>
        );
      })}
    </Card>
    </div>
  );
}

// ─── Notes Tab (multi-note per deal) ─────────────────────────────────
function Notes({ items, dealId, userId, userName, reload }) {
  // `editing` is one of: null (list only), 'new' (creating), or a row id (editing existing).
  const [editing, setEditing] = useState(null);
  const [title, setTitle]     = useState('');
  const [body, setBody]       = useState('');
  const [busy, setBusy]       = useState(false);
  const [err, setErr]         = useState(null);

  const startNew = () => { setEditing('new'); setTitle(''); setBody(''); setErr(null); };
  const startEdit = (note) => { setEditing(note.id); setTitle(note.title || ''); setBody(note.body || ''); setErr(null); };
  const cancel = () => { setEditing(null); setTitle(''); setBody(''); setErr(null); };

  const saveNote = async () => {
    const hasContent = (title && title.trim()) || (body && body.trim());
    if (!hasContent) return;
    setBusy(true); setErr(null);
    if (editing === 'new') {
      const { error } = await sb.from('deal_notes').insert({
        deal_id: dealId,
        title: (title && title.trim()) || null,
        body: body || '',
        author_id: userId,
      });
      if (error) { setErr(error.message); setBusy(false); return; }
    } else {
      const { error } = await sb.from('deal_notes').update({
        title: (title && title.trim()) || null,
        body: body || '',
      }).eq('id', editing);
      if (error) { setErr(error.message); setBusy(false); return; }
    }
    setBusy(false);
    cancel();
    await reload();
  };

  const deleteNote = async (note) => {
    const label = note.title || (note.body ? note.body.split('\n')[0].slice(0, 40) : 'untitled');
    if (!window.confirm(`Delete note "${label}"? This can't be undone.`)) return;
    const { error } = await sb.from('deal_notes').delete().eq('id', note.id);
    if (error) { setErr(error.message); return; }
    await reload();
  };

  const relativeTime = (ts) => {
    if (!ts) return '—';
    const diff = Date.now() - new Date(ts).getTime();
    const mins = Math.floor(diff / (1000 * 60));
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    const days = Math.floor(hrs / 24);
    if (days === 1) return 'yesterday';
    if (days < 7) return days + 'd ago';
    if (days < 30) return Math.floor(days / 7) + 'w ago';
    return new Date(ts).toLocaleDateString();
  };

  const isEditing = editing !== null;

  return (
    <div>
      {err && (
        <div style={{ padding: "8px 12px", borderRadius: 6, marginBottom: 12, fontSize: 12, background: "#7f1d1d", color: "#fecaca" }}>{err}</div>
      )}

      {!isEditing && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, flexWrap: "wrap", gap: 8 }}>
          <div style={{ fontSize: 12, color: "#78716c" }}>
            {items.length === 0 ? "No notes yet" : items.length === 1 ? "1 note" : items.length + " notes"} · shared with the team
          </div>
          <button onClick={startNew} style={btnPrimary}>+ New note</button>
        </div>
      )}

      {isEditing && (
        <div style={{ marginBottom: 16, padding: 16, background: "#0c0a09", border: "1px solid #44403c", borderRadius: 8 }}>
          <Field label="Title (optional)">
            <input value={title} onChange={e => setTitle(e.target.value)}
              placeholder="e.g. Call with attorney 4/20, Strategy update, TODO list"
              style={inputStyle} autoFocus={editing === 'new'} />
          </Field>
          <Field label="Note" style={{ marginTop: 12 }}>
            <textarea value={body} onChange={e => setBody(e.target.value)} rows={12}
              style={{ ...inputStyle, fontFamily: "'DM Mono', monospace", lineHeight: 1.6, resize: "vertical", fontSize: 13 }}
              placeholder="Markdown-ish. Shared with all team members." />
          </Field>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
            <button onClick={cancel} disabled={busy} style={btnGhost}>Cancel</button>
            <button onClick={saveNote} disabled={busy || (!title.trim() && !body.trim())} style={btnPrimary}>
              {busy ? 'Saving…' : (editing === 'new' ? 'Save new note' : 'Save changes')}
            </button>
          </div>
        </div>
      )}

      {items.length === 0 && !isEditing && (
        <div style={{ fontSize: 13, color: "#78716c", padding: 40, textAlign: "center", fontStyle: "italic", border: "1px dashed #292524", borderRadius: 8 }}>
          No notes on this deal yet. Click <b>+ New note</b> above to add the first one — one note per topic, as many as you want.
        </div>
      )}

      {items.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {items.map(n => (
            <div key={n.id} style={{ padding: "14px 16px", background: "#0c0a09", border: "1px solid #292524", borderRadius: 8 }}>
              <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  {n.title && <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 6 }}>{n.title}</div>}
                  <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontFamily: "'DM Mono', monospace", fontSize: 12, color: "#d6d3d1", lineHeight: 1.55 }}>{n.body}</pre>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4, flexShrink: 0 }}>
                  <button onClick={() => startEdit(n)} style={{ ...btnGhost, fontSize: 10, padding: "3px 10px" }}>Edit</button>
                  <button onClick={() => deleteNote(n)} style={{ ...btnGhost, fontSize: 10, padding: "3px 10px", color: "#ef4444", borderColor: "#7f1d1d" }}>Delete</button>
                </div>
              </div>
              <div style={{ fontSize: 10, color: "#57534e", marginTop: 10, display: "flex", gap: 8, fontFamily: "'DM Mono', monospace", flexWrap: "wrap" }}>
                <span>{n.profiles?.name || "—"}</span>
                <span>·</span>
                <span>{relativeTime(n.updated_at)}</span>
                {n.updated_at !== n.created_at && <span style={{ opacity: 0.7 }}>(edited)</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Activity Tab ────────────────────────────────────────────────────
const personColor = (name) => {
  if (!name) return "#292524";
  const palette = ["#7c2d12", "#1e3a8a", "#065f46", "#5b21b6", "#9f1239", "#78350f", "#164e63", "#3f6212"];
  let h = 0; for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return palette[h % palette.length];
};
// Log Activity form — types structured entries that write to `activity` via
// log_deal_activity RPC. Picks verb (Called/Texted/Emailed/Note/...),
// captures outcome + body + optional next-follow-up date. Follow-up date
// creates a task automatically. tg_bump_last_contacted picks up contact
// verbs so staleness sorting on the pipeline stays accurate.
function LogActivityForm({ dealId, onLogged }) {
  const [type, setType] = useState('call');
  const [outcome, setOutcome] = useState('');
  const [body, setBody] = useState('');
  const [followupDate, setFollowupDate] = useState('');
  const [followupNote, setFollowupNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const OUTCOME_OPTIONS = {
    call:    ['connected', 'voicemail', 'no answer', 'callback requested', 'not interested', 'wrong number'],
    text:    ['sent', 'replied', 'no reply'],
    sms:     ['sent', 'replied', 'no reply'],
    email:   ['sent', 'opened', 'replied', 'bounced'],
    note:    [],
    meeting: ['completed', 'scheduled', 'no-show'],
  };

  const submit = async () => {
    if (!body.trim() && type === 'note') { alert('Add a note body'); return; }
    setSubmitting(true);
    try {
      const { error } = await sb.rpc('log_deal_activity', {
        p_deal_id: dealId,
        p_type: type,
        p_outcome: outcome || null,
        p_body: body.trim() || null,
        p_next_followup_date: followupDate || null,
        p_next_followup_note: followupNote.trim() || null,
      });
      if (error) throw error;
      setType('call'); setOutcome(''); setBody(''); setFollowupDate(''); setFollowupNote('');
      setExpanded(false);
      onLogged && onLogged();
    } catch (e) { alert('Could not save: ' + e.message); }
    finally { setSubmitting(false); }
  };

  if (!expanded) {
    return (
      <div style={{ marginBottom: 14, padding: "10px 14px", background: "#1c1917", border: "1px solid #292524", borderRadius: 8, display: "flex", alignItems: "center", gap: 10 }}>
        <button onClick={() => { setType('call'); setExpanded(true); }} style={{ ...btnGhost, fontSize: 11, color: "#93c5fd" }}>📞 Log call</button>
        <button onClick={() => { setType('text'); setExpanded(true); }} style={{ ...btnGhost, fontSize: 11, color: "#6ee7b7" }}>💬 Log text</button>
        <button onClick={() => { setType('email'); setExpanded(true); }} style={{ ...btnGhost, fontSize: 11, color: "#fbbf24" }}>✉ Log email</button>
        <button onClick={() => { setType('note'); setExpanded(true); }} style={{ ...btnGhost, fontSize: 11, color: "#c4b5fd" }}>📝 Log note</button>
        <button onClick={() => { setType('meeting'); setExpanded(true); }} style={{ ...btnGhost, fontSize: 11 }}>🤝 Log meeting</button>
      </div>
    );
  }

  return (
    <div style={{ marginBottom: 14, padding: 14, background: "#1c1917", border: "1px solid #44403c", borderRadius: 8 }}>
      <div style={{ display: "flex", gap: 8, marginBottom: 10, alignItems: "center", flexWrap: "wrap" }}>
        <select value={type} onChange={e => { setType(e.target.value); setOutcome(''); }} style={{ ...inputStyle, fontSize: 12, padding: "5px 10px", width: 'auto' }}>
          <option value="call">📞 Call</option>
          <option value="text">💬 Text</option>
          <option value="email">✉ Email</option>
          <option value="note">📝 Note</option>
          <option value="meeting">🤝 Meeting</option>
        </select>
        {OUTCOME_OPTIONS[type]?.length > 0 && (
          <select value={outcome} onChange={e => setOutcome(e.target.value)} style={{ ...inputStyle, fontSize: 12, padding: "5px 10px", width: 'auto' }}>
            <option value="">Outcome…</option>
            {OUTCOME_OPTIONS[type].map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        )}
      </div>
      <textarea value={body} onChange={e => setBody(e.target.value)} rows={3}
        placeholder={type === 'note' ? "What did you note?" : "Summary of the conversation / what was said / any commitments"}
        style={{ ...inputStyle, width: "100%", resize: "vertical", minHeight: 60, fontFamily: "inherit", marginBottom: 10 }} />
      <div style={{ display: "grid", gridTemplateColumns: "200px 1fr", gap: 10, marginBottom: 10 }}>
        <div>
          <div style={{ fontSize: 10, fontWeight: 700, color: "#78716c", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 4 }}>Follow up on</div>
          <input type="date" value={followupDate} onChange={e => setFollowupDate(e.target.value)} style={{ ...inputStyle, fontSize: 12 }} />
        </div>
        {followupDate && (
          <div>
            <div style={{ fontSize: 10, fontWeight: 700, color: "#78716c", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 4 }}>Follow-up note</div>
            <input value={followupNote} onChange={e => setFollowupNote(e.target.value)} style={inputStyle} placeholder="What to do when following up" />
          </div>
        )}
      </div>
      {followupDate && (
        <div style={{ fontSize: 11, color: "#fbbf24", marginBottom: 10, padding: "6px 10px", background: "#78350f22", borderRadius: 4 }}>
          → Will auto-create a task due {new Date(followupDate + 'T00:00:00').toLocaleDateString()}
        </div>
      )}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button onClick={() => setExpanded(false)} style={btnGhost}>Cancel</button>
        <button onClick={submit} disabled={submitting} style={btnPrimary}>{submitting ? 'Saving…' : 'Log'}</button>
      </div>
    </div>
  );
}

// Unified Timeline — merges activity, docket events, messages, SMS,
// walkthroughs + offers into one chronological feed with filter chips.
// Replaces the old read-only Activity tab. Log Activity form at the top.
// ─── Call Recordings ────────────────────────────────────────────────────────
function CallRecordings({ dealId }) {
  const [calls, setCalls]       = useState([]);
  const [loading, setLoading]   = useState(true);
  const [expanded, setExpanded] = useState({}); // id → bool (transcript open)

  const load = async () => {
    setLoading(true);
    const { data } = await sb.from('call_recordings')
      .select('*')
      .eq('deal_id', dealId)
      .order('called_at', { ascending: false })
      .limit(50);
    setCalls(data || []);
    setLoading(false);
  };

  useEffect(() => { load(); }, [dealId]);

  const fmt = secs => {
    if (!secs) return '—';
    const m = Math.floor(secs / 60), s = secs % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  };
  const fmtDate = ts => new Date(ts).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  if (loading) return null;
  if (calls.length === 0) return null; // hide section entirely until there are calls

  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: '#78716c', letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 12 }}>
        📞 Call Recordings
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {calls.map(c => {
          const isOpen = expanded[c.id];
          const isIn   = c.direction === 'inbound';
          return (
            <div key={c.id} style={{ background: '#0f0d0c', border: '1px solid #1c1917', borderRadius: 10, overflow: 'hidden' }}>
              {/* Header row */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px' }}>
                <div style={{ width: 32, height: 32, borderRadius: '50%', background: isIn ? '#1c3a1c' : '#1c1a00', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15, flexShrink: 0 }}>
                  {isIn ? '📲' : '📞'}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#fafaf9' }}>
                    {isIn ? c.from_number : c.to_number}
                    <span style={{ fontSize: 11, fontWeight: 400, color: '#57534e', marginLeft: 8 }}>
                      {isIn ? 'inbound' : 'outbound'} · {fmt(c.duration_seconds)}
                    </span>
                  </div>
                  <div style={{ fontSize: 11, color: '#44403c', marginTop: 1 }}>{fmtDate(c.called_at)}</div>
                </div>
                {/* AI summary pill */}
                {c.ai_summary && (
                  <div style={{ fontSize: 11, color: '#a8a29e', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 1 }}>
                    {c.ai_summary}
                  </div>
                )}
                {/* Expand button */}
                {(c.transcript || c.ai_summary || c.recording_url) && (
                  <button onClick={() => setExpanded(e => ({ ...e, [c.id]: !e[c.id] }))}
                    style={{ background: 'transparent', border: '1px solid #292524', color: '#78716c', borderRadius: 6, padding: '4px 10px', fontSize: 11, cursor: 'pointer', flexShrink: 0 }}>
                    {isOpen ? 'Less ▲' : 'More ▼'}
                  </button>
                )}
              </div>

              {/* Expanded: audio player + AI summary + transcript */}
              {isOpen && (
                <div style={{ borderTop: '1px solid #1c1917', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {/* Audio player */}
                  {c.recording_url && (
                    <audio controls src={c.recording_url}
                      style={{ width: '100%', height: 36, accentColor: '#d97706' }} />
                  )}

                  {/* AI summary + action items */}
                  {c.ai_summary && (
                    <div style={{ background: '#1c1917', borderRadius: 8, padding: '10px 12px' }}>
                      <div style={{ fontSize: 10, fontWeight: 700, color: '#d97706', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>AI Summary</div>
                      <div style={{ fontSize: 13, color: '#e7e5e4', lineHeight: 1.6 }}>{c.ai_summary}</div>
                      {c.ai_action_items && (
                        <div style={{ marginTop: 10 }}>
                          <div style={{ fontSize: 10, fontWeight: 700, color: '#78716c', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>Action Items</div>
                          {c.ai_action_items.split('\n').filter(Boolean).map((item, i) => (
                            <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 4 }}>
                              <span style={{ color: '#d97706', flexShrink: 0 }}>→</span>
                              <span style={{ fontSize: 12, color: '#a8a29e', lineHeight: 1.5 }}>{item}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Full transcript */}
                  {c.transcript && (
                    <div>
                      <div style={{ fontSize: 10, fontWeight: 700, color: '#57534e', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>Transcript</div>
                      <div style={{ fontSize: 12, color: '#78716c', lineHeight: 1.7, whiteSpace: 'pre-wrap', maxHeight: 260, overflowY: 'auto', fontFamily: "'DM Mono', monospace" }}>
                        {c.transcript}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Activity({ items, dealId, reload }) {
  const [filter, setFilter] = useState('all'); // all | actions | court | messages | system
  const [extra, setExtra] = useState({ docket: [], messages: [], sms: [], walkthroughs: [], offers: [] });
  const [loading, setLoading] = useState(true);

  const loadExtra = async () => {
    if (!dealId) { setLoading(false); return; }
    const [dk, msgs, sms, wt, offers] = await Promise.all([
      sb.from('docket_events').select('id, event_type, event_date, description, is_backfill, acknowledged_at, created_at:received_at').eq('deal_id', dealId).order('received_at', { ascending: false }).limit(200),
      sb.from('messages').select('id, sender_role, sender_name, body, subject, audience, created_at').eq('deal_id', dealId).order('created_at', { ascending: false }).limit(100),
      sb.from('messages_outbound').select('id, direction, body, to_number, from_number, status, created_at').eq('deal_id', dealId).order('created_at', { ascending: false }).limit(100),
      sb.from('walkthrough_requests').select('id, investor_name, preferred_time, investor_note, status, created_at').eq('deal_id', dealId).order('created_at', { ascending: false }).limit(50),
      sb.from('investor_offers').select('id, investor_name, offer_price, financing_type, status, submitted_at').eq('deal_id', dealId).order('submitted_at', { ascending: false }).limit(50),
    ]);
    setExtra({ docket: dk.data || [], messages: msgs.data || [], sms: sms.data || [], walkthroughs: wt.data || [], offers: offers.data || [] });
    setLoading(false);
  };

  useEffect(() => { loadExtra(); /* eslint-disable-next-line */ }, [dealId]);

  useEffect(() => {
    if (!dealId) return;
    const ch = sb.channel('timeline-' + dealId)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'docket_events', filter: `deal_id=eq.${dealId}` }, loadExtra)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'messages', filter: `deal_id=eq.${dealId}` }, loadExtra)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'messages_outbound', filter: `deal_id=eq.${dealId}` }, loadExtra)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'walkthrough_requests', filter: `deal_id=eq.${dealId}` }, loadExtra)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'investor_offers', filter: `deal_id=eq.${dealId}` }, loadExtra)
      .subscribe();
    return () => { sb.removeChannel(ch); };
    // eslint-disable-next-line
  }, [dealId]);

  // Merge everything into a single sorted feed with a normalized shape
  const merged = [
    ...(items || []).map(a => ({
      kind: 'activity',
      bucket: ['call','text','sms','email','meeting','note'].includes(a.activity_type) ? 'actions'
             : a.activity_type === 'system' || /created|status|stage|flagged|deleted/i.test(a.action || '') ? 'system'
             : 'actions',
      id: a.id, ts: a.created_at,
      who: a.profiles?.name || 'System',
      icon: ({ call: '📞', text: '💬', sms: '💬', email: '✉', note: '📝', meeting: '🤝' })[a.activity_type] || '•',
      title: a.action,
      sub: a.outcome ? 'Outcome: ' + a.outcome : null,
      body: a.body,
      followup: a.next_followup_date,
    })),
    ...extra.docket.map(e => ({
      kind: 'docket',
      bucket: 'court',
      id: 'dk-' + e.id, ts: e.created_at,
      who: 'Court',
      icon: (EVENT_TYPE_META[e.event_type]?.icon) || '⚖',
      title: (EVENT_TYPE_META[e.event_type]?.label || e.event_type) + (e.event_date ? ` · ${new Date(e.event_date + 'T00:00:00').toLocaleDateString()}` : ''),
      sub: e.is_backfill ? 'backfill' : null,
      body: e.description,
    })),
    ...extra.messages.map(m => ({
      kind: 'message',
      bucket: 'messages',
      id: 'msg-' + m.id, ts: m.created_at,
      who: m.sender_name || m.sender_role || 'Unknown',
      icon: m.sender_role === 'client' ? '👤' : m.sender_role === 'attorney' ? '⚖' : '💬',
      title: (m.sender_role === 'client' ? 'Client' : m.sender_role === 'attorney' ? 'Counsel' : 'Team') + ' message' + (m.subject ? ` — ${m.subject}` : ''),
      body: m.body,
    })),
    ...extra.sms.map(s => ({
      kind: 'sms',
      bucket: 'messages',
      id: 'sms-' + s.id, ts: s.created_at,
      who: s.direction === 'inbound' ? 'Inbound SMS' : 'Outbound SMS',
      icon: s.direction === 'inbound' ? '📲' : '📤',
      title: (s.direction === 'inbound' ? 'Inbound' : 'Outbound') + ' SMS' + (s.status && s.status !== 'sent' ? ` · ${s.status}` : ''),
      body: s.body,
      sub: s.direction === 'inbound' ? `From ${s.to_number || '?'}` : `To ${s.to_number || '?'}`,
    })),
    ...extra.walkthroughs.map(w => ({
      kind: 'walkthrough',
      bucket: 'system',
      id: 'wt-' + w.id, ts: w.created_at,
      who: w.investor_name || 'Investor',
      icon: '🏠',
      title: `Walkthrough request · ${w.status}`,
      sub: w.preferred_time ? `Prefers: ${w.preferred_time}` : null,
      body: w.investor_note,
    })),
    ...extra.offers.map(o => ({
      kind: 'offer',
      bucket: 'system',
      id: 'of-' + o.id, ts: o.submitted_at,
      who: o.investor_name || 'Investor',
      icon: '💰',
      title: `Offer ${o.status} · $${Number(o.offer_price).toLocaleString('en-US', { maximumFractionDigits: 0 })}`,
      sub: o.financing_type ? o.financing_type.toUpperCase() : null,
    })),
  ].filter(x => x.ts).sort((a, b) => new Date(b.ts) - new Date(a.ts));

  const filtered = filter === 'all' ? merged : merged.filter(m => m.bucket === filter);

  const counts = {
    all: merged.length,
    actions: merged.filter(m => m.bucket === 'actions').length,
    court: merged.filter(m => m.bucket === 'court').length,
    messages: merged.filter(m => m.bucket === 'messages').length,
    system: merged.filter(m => m.bucket === 'system').length,
  };

  const chip = (id, label) => (
    <button key={id} onClick={() => setFilter(id)} style={{
      fontSize: 11, padding: '5px 12px', borderRadius: 5,
      background: filter === id ? '#292524' : 'transparent',
      color: filter === id ? '#fafaf9' : '#78716c',
      border: '1px solid ' + (filter === id ? '#44403c' : 'transparent'),
      fontWeight: filter === id ? 700 : 500, cursor: 'pointer',
    }}>{label} · {counts[id]}</button>
  );

  return (
    <Card title="Timeline" action={
      <div style={{ fontSize: 11, color: "#78716c" }}>{merged.length} entr{merged.length === 1 ? 'y' : 'ies'}</div>
    }>
      {dealId && <LogActivityForm dealId={dealId} onLogged={() => { reload && reload(); loadExtra(); }} />}

      <div style={{ display: 'flex', gap: 4, marginBottom: 14, background: '#0c0a09', border: '1px solid #292524', borderRadius: 8, padding: 3, width: 'fit-content', flexWrap: 'wrap' }}>
        {chip('all', 'All')}
        {chip('actions', '📞 Actions')}
        {chip('court', '⚖ Court')}
        {chip('messages', '💬 Messages')}
        {chip('system', '⚙ System')}
      </div>

      {loading && <div style={{ padding: 20, textAlign: 'center', color: '#78716c', fontSize: 12 }}>Loading timeline…</div>}

      {!loading && filtered.length === 0 && (
        <div style={{ padding: 30, textAlign: 'center', color: '#78716c', border: '1px dashed #292524', borderRadius: 8, fontSize: 13, fontStyle: 'italic' }}>
          {filter === 'all' ? 'No timeline entries yet. Log a call, note, or wait for events to land.' : `Nothing in the ${filter} bucket yet.`}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {filtered.map(m => {
          const bucketColor = {
            actions: '#3b82f6',
            court: '#8b5cf6',
            messages: '#d97706',
            system: '#78716c',
          }[m.bucket] || '#44403c';
          return (
            <div key={m.kind + '-' + m.id} style={{ padding: "10px 12px", background: "#0c0a09", border: "1px solid #292524", borderLeft: "3px solid " + bucketColor, borderRadius: 6, display: "flex", gap: 10, alignItems: "flex-start" }}>
              <span style={{ fontSize: 14, flexShrink: 0, width: 20, textAlign: 'center' }}>{m.icon}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 10, fontWeight: 700, padding: "1px 6px", background: personColor(m.who), color: "#fafaf9", borderRadius: 3, letterSpacing: "0.04em" }}>{m.who}</span>
                  <span style={{ fontSize: 13, color: "#fafaf9", fontWeight: 500 }}>{m.title}</span>
                </div>
                {m.sub && <div style={{ fontSize: 11, color: "#a8a29e", marginTop: 2 }}>{m.sub}</div>}
                {m.body && <div style={{ fontSize: 12, color: "#d6d3d1", marginTop: 4, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{m.body}</div>}
                {m.followup && <div style={{ fontSize: 11, color: "#fbbf24", marginTop: 4 }}>🔔 Follow up on {new Date(m.followup + 'T00:00:00').toLocaleDateString()}</div>}
              </div>
              <span style={{ fontSize: 10, color: "#57534e", fontFamily: "'DM Mono', monospace", whiteSpace: "nowrap", flexShrink: 0 }}>
                {new Date(m.ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                {' '}
                {new Date(m.ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
              </span>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// ─── SMS Thread ──────────────────────────────────────────────────────
// Normalize any phone number to E.164 for consistent comparison
function normalizePhone(p) {
  if (!p) return '';
  const d = String(p).replace(/\D/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  return p;
}

function OutboundMessages({ dealId, vendors, deal }) {
  // Hoisted to the top: groupThreads useMemo below references this. Was
  // declared mid-function which caused a TDZ ReferenceError ('Cannot access
  // Ce before initialization') the first time a deal had messages with a
  // :group: thread_key. Putting it here removes the order-of-evaluation trap.
  const NATHAN_BRIDGE_NUMBER = '+15135162306';

  const [msgs, setMsgs]               = useState([]);
  const [calls, setCalls]             = useState([]);
  const [emails, setEmails]           = useState([]);
  const [dealNotes, setDealNotes]     = useState([]);
  const [phoneNumbers, setPhoneNumbers] = useState([]);
  const [fromNumber, setFromNumber]   = useState('');
  const [body, setBody]               = useState('');
  const [sending, setSending]         = useState(false);
  const [sendErr, setSendErr]         = useState(null);
  const [activeContact, setActiveContact] = useState(null);
  const [newMode, setNewMode]         = useState(false);
  const [newPhone, setNewPhone]       = useState('');
  const [extraContacts, setExtraContacts] = useState([]);
  const [dcContacts, setDcContacts]   = useState([]);
  const [unmatched, setUnmatched]     = useState([]);
  const [hiddenThreads, setHiddenThreads] = useState(new Set());
  const [channelFilter, setChannelFilter] = useState('all'); // 'all' | 'sms' | 'calls' | 'notes'
  const [groupMode, setGroupMode] = useState(false);
  const [groupSelected, setGroupSelected] = useState(new Set());
  const [groupBody, setGroupBody] = useState('');
  const [groupSending, setGroupSending] = useState(false);
  const [groupErr, setGroupErr] = useState(null);
  const [emailMode, setEmailMode] = useState(false);
  const [emailForm, setEmailForm] = useState({ to: '', cc: '', subject: '', body: '', contact_id: null });
  const [emailSending, setEmailSending] = useState(false);
  const [emailErr, setEmailErr] = useState(null);
  const [showIntroModal, setShowIntroModal] = useState(false);
  const [rvmMode, setRvmMode] = useState(false);
  const [rvmPhone, setRvmPhone] = useState('');
  const [rvmAudioUrl, setRvmAudioUrl] = useState('');
  const [rvmTemplate, setRvmTemplate] = useState('intro');
  const [rvmSending, setRvmSending] = useState(false);
  const [rvmResult, setRvmResult] = useState(null);
  const [mediaUrl, setMediaUrl] = useState('');
  const [showMediaInput, setShowMediaInput] = useState(false);
  const threadRef = useRef(null);

  const RVM_TEMPLATES = {
    intro:    { label: 'Intro — surplus funds', url: '' },
    followup: { label: 'Follow-up day 3',       url: '' },
    final:    { label: 'Final touch day 7',      url: '' },
  };

  const dropRvm = async () => {
    if (!rvmPhone.trim() || rvmSending) return;
    setRvmSending(true); setRvmResult(null);
    try {
      const { data, error } = await sb.functions.invoke('drop-rvm', {
        body: {
          to: rvmPhone.trim(),
          audio_url: rvmAudioUrl.trim() || RVM_TEMPLATES[rvmTemplate]?.url,
          deal_id: dealId,
          contact_id: activeContact?.contact_id,
          template: RVM_TEMPLATES[rvmTemplate]?.label,
        }
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.details || data.error);
      setRvmResult({ type: 'success', text: 'Voicemail dropped successfully.' });
    } catch (e) {
      setRvmResult({ type: 'error', text: 'Failed: ' + (e.message || 'unknown') });
    }
    setRvmSending(false);
  };

  // Virtual "Everyone" contact — shows every message / call / note on the
  // deal, merged chronologically. Solves the "I want one thread with
  // everyone I'm talking to about this case" view.
  const EVERYONE_CONTACT = React.useMemo(() => ({
    _everyone: true,
    name: 'Everyone on this case',
    role: 'All contacts',
    phone: '',
  }), []);

  // ── Participant colors for group threads ──────────────────────────────────
  const PARTICIPANT_COLORS = ['#d97706','#3b82f6','#22c55e','#a855f7','#ef4444','#06b6d4','#f59e0b'];
  const participantColor = (nameOrPhone) => {
    if (!nameOrPhone) return PARTICIPANT_COLORS[0];
    let h = 0;
    for (let i = 0; i < nameOrPhone.length; i++) h = (h * 31 + nameOrPhone.charCodeAt(i)) >>> 0;
    return PARTICIPANT_COLORS[h % PARTICIPANT_COLORS.length];
  };

  // ── Unified contact list ──────────────────────────────────────────────────
  const contacts = React.useMemo(() => {
    const seen = new Set();
    const list = [];
    const add = (c) => {
      const key = normalizePhone(c.phone);
      if (!key || seen.has(key)) return;
      seen.add(key);
      list.push(c);
    };
    if (deal?.meta?.homeownerPhone)
      add({ name: deal.meta.homeownerName || 'Homeowner', role: 'Homeowner', phone: deal.meta.homeownerPhone, _homeowner: true });
    (vendors || []).filter(v => v.phone).forEach(v => add({ name: v.name, role: v.role || 'Vendor', phone: v.phone }));
    dcContacts.filter(c => c.phone).forEach(c => add({ name: c.name, role: c.kind || 'Contact', phone: c.phone, contact_id: c.id }));
    extraContacts.forEach(add);
    return list;
  }, [deal, vendors, dcContacts, extraContacts]);

  // ── Load messages + calls + notes for this deal ──────────────────────────
  const load = async () => {
    // Only fetch messages explicitly assigned to this deal.
    // Cross-deal phone matching was removed: it amplified group-chat leaks
    // by showing any message whose to_number matched a contact, regardless
    // of which deal it was routed to.
    const [msgsRes, callsRes, emailsRes, notesRes] = await Promise.all([
      sb.from('messages_outbound')
        .select('*').eq('deal_id', dealId)
        .order('created_at', { ascending: true }).limit(200),
      sb.from('call_logs')
        .select('*').eq('deal_id', dealId)
        .order('started_at', { ascending: true }).limit(200),
      sb.from('emails')
        .select('*').eq('deal_id', dealId)
        .order('created_at', { ascending: true }).limit(100),
      sb.from('deal_notes')
        .select('id, title, body, author_id, created_at, updated_at')
        .eq('deal_id', dealId)
        .order('created_at', { ascending: true }).limit(100),
    ]);
    setMsgs(msgsRes.data || []);
    setCalls(callsRes.data || []);
    setEmails(emailsRes.data || []);
    setDealNotes(notesRes.data || []);
  };

  // ── Load contacts from contact_deals ─────────────────────────────────────
  const loadDealContacts = async () => {
    const { data } = await sb.from('contact_deals')
      .select('contacts(id, name, phone, email, kind)')
      .eq('deal_id', dealId);
    if (data) setDcContacts(data.map(r => r.contacts).filter(Boolean));
  };

  // ── Load unmatched inbound for this deal ─────────────────────────────────
  const loadUnmatched = async () => {
    const phones = contacts.map(c => normalizePhone(c.phone)).filter(Boolean);
    if (!phones.length) return;
    const { data } = await sb.from('messages_outbound_unmatched')
      .select('*').in('to_number', phones)
      .is('resolved_at', null).eq('dismissed', false);
    setUnmatched(data || []);
  };

  useEffect(() => {
    loadDealContacts();
    load();
    sb.from('phone_numbers').select('*').eq('active', true).order('created_at').then(({ data }) => {
      const nums = data || [];
      setPhoneNumbers(nums);
      if (nums.length > 0 && !fromNumber) setFromNumber(nums[0].number);
    });
    const ch = sb.channel(`comms-${dealId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'messages_outbound', filter: `deal_id=eq.${dealId}` }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'call_logs',         filter: `deal_id=eq.${dealId}` }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'emails',            filter: `deal_id=eq.${dealId}` }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'deal_notes',        filter: `deal_id=eq.${dealId}` }, load)
      .subscribe();
    const poll = setInterval(load, 6000);
    return () => { sb.removeChannel(ch); clearInterval(poll); };
  }, [dealId]);

  useEffect(() => { loadUnmatched(); }, [contacts.length]);

  // Default to the Everyone view so Nathan sees the merged thread on open.
  useEffect(() => {
    if (!activeContact) setActiveContact(EVERYONE_CONTACT);
  }, []);

  useEffect(() => {
    if (threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight;
  }, [msgs, activeContact]);

  // Keyboard-safe composer on iOS. Track the visualViewport — when the
  // keyboard opens, iOS shrinks vv.height; we translate the comms container
  // up by the difference so the composer docks to the keyboard instead of
  // being hidden behind it. Only runs on mobile; on desktop the listener
  // is a no-op because vv.height ≈ window.innerHeight.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      const keyboardOffset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      document.documentElement.style.setProperty('--keyboard-offset', keyboardOffset + 'px');
      // Scroll thread to bottom when keyboard opens so the latest message
      // doesn't get buried above the newly-docked composer.
      if (keyboardOffset > 0 && threadRef.current) {
        threadRef.current.scrollTop = threadRef.current.scrollHeight;
      }
    };
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    update();
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
      document.documentElement.style.removeProperty('--keyboard-offset');
    };
  }, []);

  // ── Group threads derived from loaded messages ────────────────────────────
  // A group thread is any message whose thread_key contains ':group:'
  const groupThreads = React.useMemo(() => {
    const seen = new Map(); // threadKey → { key, participantPhones: Set }
    msgs.forEach(m => {
      if (!m.thread_key?.includes(':group:')) return;
      if (!seen.has(m.thread_key)) seen.set(m.thread_key, { key: m.thread_key, phones: new Set() });
      const entry = seen.get(m.thread_key);
      if (m.from_number && m.from_number !== NATHAN_BRIDGE_NUMBER) entry.phones.add(normalizePhone(m.from_number));
      if (m.to_number   && m.to_number   !== NATHAN_BRIDGE_NUMBER) entry.phones.add(normalizePhone(m.to_number));
    });
    return [...seen.values()].map(g => {
      // Label: match phones to contact names
      const names = [...g.phones]
        .map(p => contacts.find(c => normalizePhone(c.phone) === p)?.name?.split(' ')[0] || p)
        .filter(Boolean);
      return { _group: true, thread_key: g.key, phone: g.key, name: names.join(' + ') || 'Group', role: 'Group', phones: [...g.phones] };
    });
  }, [msgs, contacts]);

  // ── Thread messages for active contact ───────────────────────────────────
  // (NATHAN_BRIDGE_NUMBER is hoisted to the top of this component now —
  // see top of OutboundMessages — to avoid TDZ on groupThreads useMemo.)
  const threadMsgs = React.useMemo(() => {
    if (!activeContact) return msgs;
    // Everyone view — all messages on this deal, no filtering
    if (activeContact._everyone) return msgs;
    if (activeContact._group) {
      return msgs.filter(m => m.thread_key === activeContact.thread_key);
    }
    const phone = normalizePhone(activeContact.phone);
    const cid   = activeContact.contact_id;
    return msgs.filter(m => {
      if (m.thread_key && cid && m.thread_key === `${dealId}:contact:${cid}`) return true;
      if (m.thread_key && m.thread_key === `${dealId}:phone:${phone}`) return true;
      return normalizePhone(m.to_number) === phone || normalizePhone(m.from_number) === phone;
    });
  }, [msgs, activeContact, dealId]);

  // Merge messages + calls + notes for the active contact into one sorted
  // stream. Calls are filtered to the contact's phone (or contact_id match).
  // Notes are deal-wide — they appear on every contact tab because they're
  // context about the whole case, not one conversation.
  const threadItems = React.useMemo(() => {
    const items = [];
    // Messages
    threadMsgs.forEach(m => items.push({ _kind: 'message', _ts: m.created_at, ...m }));
    // Calls — Everyone view shows all, otherwise just for the active contact
    if (activeContact?._everyone) {
      calls.forEach(c => items.push({ _kind: 'call', _ts: c.started_at || c.created_at, ...c }));
    } else if (activeContact && !activeContact._group) {
      const phone = normalizePhone(activeContact.phone);
      const cid   = activeContact.contact_id;
      calls.forEach(c => {
        const matchesContact = cid && c.contact_id === cid;
        const matchesPhone   = normalizePhone(c.from_number) === phone || normalizePhone(c.to_number) === phone;
        if (matchesContact || matchesPhone) {
          items.push({ _kind: 'call', _ts: c.started_at || c.created_at, ...c });
        }
      });
    }
    // Emails — Everyone shows all, otherwise filter by contact match
    if (activeContact?._everyone) {
      emails.forEach(e => items.push({ _kind: 'email', _ts: e.created_at, ...e }));
    } else if (activeContact && !activeContact._group) {
      const cid = activeContact.contact_id;
      const contactEmail = activeContact.email || dcContacts.find(c => c.id === cid)?.email;
      emails.forEach(e => {
        const matchesContact = cid && e.contact_id === cid;
        const matchesEmail   = contactEmail && (e.to_emails?.includes(contactEmail) || e.cc_emails?.includes(contactEmail) || e.from_email?.includes(contactEmail));
        if (matchesContact || matchesEmail) {
          items.push({ _kind: 'email', _ts: e.created_at, ...e });
        }
      });
    }
    // Notes — deal-wide, surface in every thread
    dealNotes.forEach(n => items.push({ _kind: 'note', _ts: n.created_at, ...n }));

    // Channel filter
    const filtered = items.filter(i => {
      if (channelFilter === 'all')    return true;
      if (channelFilter === 'sms')    return i._kind === 'message';
      if (channelFilter === 'calls')  return i._kind === 'call';
      if (channelFilter === 'email')  return i._kind === 'email';
      if (channelFilter === 'notes')  return i._kind === 'note';
      return true;
    });

    return filtered.sort((a, b) => new Date(a._ts).getTime() - new Date(b._ts).getTime());
  }, [threadMsgs, calls, emails, dealNotes, activeContact, channelFilter, dcContacts]);

  const days = threadItems.reduce((acc, m) => {
    const day = new Date(m._ts).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
    if (!acc.length || acc[acc.length - 1].day !== day) acc.push({ day, items: [] });
    acc[acc.length - 1].items.push(m);
    return acc;
  }, []);

  // Counts for the channel chips (across this contact's thread)
  const chipCounts = React.useMemo(() => ({
    sms: threadMsgs.length,
    calls: activeContact?._everyone
      ? calls.length
      : (activeContact && !activeContact._group)
        ? calls.filter(c => {
            const phone = normalizePhone(activeContact.phone);
            const cid   = activeContact.contact_id;
            return (cid && c.contact_id === cid)
                || normalizePhone(c.from_number) === phone
                || normalizePhone(c.to_number) === phone;
          }).length
        : 0,
    email: activeContact?._everyone
      ? emails.length
      : (activeContact && !activeContact._group)
        ? emails.filter(e => {
            const cid = activeContact.contact_id;
            const em  = dcContacts.find(c => c.id === cid)?.email;
            return (cid && e.contact_id === cid)
                || (em && (e.to_emails?.includes(em) || e.cc_emails?.includes(em) || e.from_email?.includes(em)));
          }).length
        : 0,
    notes: dealNotes.length,
  }), [threadMsgs, calls, emails, dealNotes, activeContact, dcContacts]);

  // ── Group compose ─────────────────────────────────────────────────────────
  const toggleGroupMember = (phone) => {
    setGroupSelected(prev => {
      const next = new Set(prev);
      if (next.has(phone)) next.delete(phone); else next.add(phone);
      return next;
    });
  };

  // ── Email send ────────────────────────────────────────────────────────────
  // Templates keyed off the meta shortcuts Nathan most often needs.
  const emailTemplates = {
    payoff: {
      label: 'Payoff + reinstatement request',
      subject: (d) => `Payoff & reinstatement request — ${d?.meta?.homeownerName || d?.name || 'client'} — Case ${d?.meta?.courtCase || ''}`,
      body: (d) => {
        const m = d?.meta || {};
        const name = m.homeownerName || (d?.name || '').split(' - ')[0] || 'my client';
        const county = m.county ? `${m.county} County` : 'the county';
        const caseNum = m.courtCase || '[case number]';
        const propertyAddress = d?.address || m.propertyAddress || '[property address]';
        return `Counsel,\n\nI represent ${name} on the above-referenced matter in ${county} (Case ${caseNum}, ${propertyAddress}). Please send me the following at your earliest convenience:\n\n  1. Current payoff figure, good through 30 days, with per-diem interest.\n  2. Reinstatement figure, good through 30 days, itemized (principal, interest, late fees, costs, escrow advances, attorney fees).\n  3. Any additional fees or costs that would be due at payoff or reinstatement, and whether either figure is currently accruing.\n\nPlease cc my client on this thread so they're in the loop. Happy to provide the signed engagement letter on request.\n\nAppreciate it,`;
      }
    },
    intro: {
      label: 'Intro to attorney',
      subject: (d) => `New representation — ${d?.meta?.homeownerName || d?.name || ''} — Case ${d?.meta?.courtCase || ''}`,
      body: (d) => {
        const m = d?.meta || {};
        const name = m.homeownerName || (d?.name || '').split(' - ')[0] || 'my client';
        const caseNum = m.courtCase || '[case number]';
        return `Counsel,\n\nI'm writing to let you know that ${name} has retained RefundLocators in connection with the above matter (Case ${caseNum}). Engagement letter attached / available on request.\n\nI'd like to open a line of communication for payoff, reinstatement, and any surplus-fund questions as the case progresses. Please cc my client on any reply so they stay in the loop.\n\nThanks,`;
      }
    },
    blank: { label: 'Blank email', subject: () => '', body: () => '' },
  };

  const loadEmailTemplate = (key) => {
    const t = emailTemplates[key];
    if (!t) return;
    // Attorney contact for To, client email for Cc
    const attorneyContact = dcContacts.find(c => c.kind === 'attorney' && c.email) || {};
    const m = deal?.meta || {};
    const clientEmail = m.homeownerEmail || '';
    setEmailForm({
      to: attorneyContact.email || '',
      cc: clientEmail || '',
      subject: t.subject(deal),
      body: t.body(deal),
      contact_id: attorneyContact.id || null,
    });
  };

  const sendEmail = async () => {
    const toList = emailForm.to.split(/[,;]/).map(s => s.trim()).filter(Boolean);
    const ccList = emailForm.cc.split(/[,;]/).map(s => s.trim()).filter(Boolean);
    if (toList.length === 0 || !emailForm.subject.trim() || !emailForm.body.trim() || emailSending) return;
    setEmailSending(true); setEmailErr(null);
    try {
      const { error } = await sb.functions.invoke('send-email', {
        body: {
          to: toList, cc: ccList.length ? ccList : undefined,
          subject: emailForm.subject.trim(),
          body: emailForm.body.trim(),
          deal_id: dealId, contact_id: emailForm.contact_id || undefined,
        }
      });
      if (error) {
        let msg = error.message;
        try { const b = await error.context?.json?.(); msg = b?.error || msg; } catch {}
        throw new Error(msg);
      }
      setEmailMode(false);
      setEmailForm({ to: '', cc: '', subject: '', body: '', contact_id: null });
      await load();
    } catch (e) { setEmailErr(e.message); }
    setEmailSending(false);
  };

  const sendGroup = async () => {
    const selectedContacts = contacts.filter(c => groupSelected.has(c.phone));
    if (selectedContacts.length < 2 || !groupBody.trim() || groupSending) return;
    setGroupSending(true); setGroupErr(null);
    const groupId = crypto.randomUUID();
    const groupLabel = selectedContacts.map(c => c.name.split(' ')[0]).join(' + ');

    try {
      // Register the group so it appears in groupThreads derivation on reload
      await sb.from('message_groups').insert({
        id: groupId,
        deal_id: dealId,
        label: groupLabel,
        participants: selectedContacts.map(c => ({ contact_id: c.contact_id || null, phone: c.phone, name: c.name })),
        channel: 'sms',
      });
      // Fan out: one send-sms call per recipient. Each goes to their
      // individual thread AND gets stamped with group_id so future UI
      // can render them as a group.
      for (const c of selectedContacts) {
        const { error } = await sb.functions.invoke('send-sms', {
          body: {
            to:          c.phone,
            body:        groupBody.trim(),
            deal_id:     dealId,
            from_number: fromNumber || undefined,
            contact_id:  c.contact_id || undefined,
          }
        });
        if (error) {
          let msg = error.message;
          try { const b = await error.context?.json?.(); msg = b?.error || b?.message || msg; } catch {}
          throw new Error(`${c.name}: ${msg}`);
        }
      }
      setGroupBody(''); setGroupSelected(new Set()); setGroupMode(false);
      await load();
    } catch (e) {
      setGroupErr(e.message);
    }
    setGroupSending(false);
  };

  // ── Send ─────────────────────────────────────────────────────────────────
  const activeTo = activeContact?.phone || '';
  const canSend = activeContact && !sending && (body.trim() || mediaUrl.trim());

  const send = async () => {
    if (!activeTo.trim() || !canSend || sending) return;
    setSending(true); setSendErr(null);
    const capturedMedia = mediaUrl.trim() || undefined;
    const optimistic = { id: 'opt-' + Date.now(), to_number: activeTo.trim(), from_number: fromNumber || '…', body: body.trim(), media_url: capturedMedia, status: 'queued', created_at: new Date().toISOString() };
    setMsgs(prev => [...prev, optimistic]);
    setBody('');
    setMediaUrl('');
    setShowMediaInput(false);
    try {
      const { data, error } = await sb.functions.invoke('send-sms', {
        body: {
          to:          activeTo.trim(),
          body:        optimistic.body,
          deal_id:     dealId,
          from_number: fromNumber || undefined,
          contact_id:  activeContact?.contact_id || undefined,
          media_url:   capturedMedia || undefined,
        }
      });
      if (error) {
        let msg = error.message;
        try { const b = await error.context?.json?.(); msg = b?.error || b?.message || JSON.stringify(b) || msg; } catch {}
        throw new Error(msg);
      }
      if (data?.status === 'failed') throw new Error(data.error_message || 'Twilio error');
    } catch (e) { setSendErr(e.message); }
    setSending(false); load();
  };

  const handleKeyDown = e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') send(); };

  const startNew = () => {
    const phone = newPhone.trim();
    if (!phone) return;
    const already = contacts.find(c => normalizePhone(c.phone) === normalizePhone(phone));
    if (already) { setActiveContact(already); }
    else {
      const c = { name: phone, phone, _custom: true };
      setExtraContacts(prev => [...prev, c]);
      setActiveContact(c);
    }
    setNewMode(false); setNewPhone('');
  };

  // ── Hide thread ───────────────────────────────────────────────────────────
  const hideThread = async (c) => {
    const key = c.contact_id ? `${dealId}:contact:${c.contact_id}` : `${dealId}:phone:${normalizePhone(c.phone)}`;
    await sb.from('thread_hidden').upsert({ deal_id: dealId, thread_key: key });
    setHiddenThreads(prev => new Set([...prev, normalizePhone(c.phone)]));
    if (activeContact?.phone === c.phone) setActiveContact(contacts.find(x => x.phone !== c.phone) || null);
  };

  // ── Resolve unmatched ─────────────────────────────────────────────────────
  const dismissUnmatched = async (id) => {
    await sb.from('messages_outbound_unmatched').update({ dismissed: true }).eq('id', id);
    setUnmatched(prev => prev.filter(u => u.id !== id));
  };

  const visibleContacts = contacts.filter(c => !hiddenThreads.has(normalizePhone(c.phone)));
  const msgCount = c => msgs.filter(m => normalizePhone(m.to_number) === normalizePhone(c.phone) || normalizePhone(m.from_number) === normalizePhone(c.phone)).length;

  const bubbleBg = s => s === 'failed' ? '#2d0a0a' : s === 'queued' ? '#292524' : '#92400e';
  const statusIcon = s => s === 'sent' ? '✓' : s === 'failed' ? '✗' : '···';
  const statusColor = s => s === 'sent' ? '#22c55e' : s === 'failed' ? '#ef4444' : '#78716c';

  return (
    <div className="comms-container" style={{ display: 'flex', flexDirection: 'column', height: 600, background: '#0c0a09', border: '1px solid #292524', borderRadius: 10, overflow: 'hidden' }}>

      {/* Unmatched-contact banner */}
      {unmatched.length > 0 && (
        <div style={{ background: '#1c0a00', borderBottom: '1px solid #78350f', padding: '8px 14px', flexShrink: 0 }}>
          {unmatched.map(u => (
            <div key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: unmatched.length > 1 ? 6 : 0 }}>
              <span style={{ fontSize: 14 }}>⚠️</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <span style={{ fontSize: 12, color: '#fbbf24', fontWeight: 600 }}>Unknown contact texted this case · </span>
                <span style={{ fontSize: 11, color: '#a8a29e', fontFamily: "'DM Mono', monospace" }}>{u.from_number}</span>
                {u.body && <span style={{ fontSize: 11, color: '#78716c' }}> — "{u.body.slice(0, 60)}{u.body.length > 60 ? '…' : ''}"</span>}
              </div>
              <button onClick={() => dismissUnmatched(u.id)}
                style={{ background: 'transparent', border: '1px solid #44403c', color: '#78716c', borderRadius: 5, padding: '3px 8px', fontSize: 11, cursor: 'pointer', flexShrink: 0 }}>
                Dismiss
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Conversation tabs */}
      <div className="conversation-tabs" style={{ display: 'flex', alignItems: 'stretch', borderBottom: '1px solid #1c1917', background: '#0f0d0c', overflowX: 'auto', flexShrink: 0, scrollbarWidth: 'none' }}>
        {/* Everyone tab — first, shows every message/call/note on the deal */}
        {(() => {
          const active = activeContact?._everyone;
          const total  = msgs.length + calls.length + dealNotes.length;
          return (
            <button key="_everyone" onClick={() => { setActiveContact(EVERYONE_CONTACT); setNewMode(false); setGroupMode(false); }}
              style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', padding: '8px 14px', background: active ? 'rgba(217, 119, 6, 0.08)' : 'transparent', border: 'none', borderBottom: active ? '2px solid #d97706' : '2px solid transparent', borderRight: '1px solid #1c1917', cursor: 'pointer', flexShrink: 0, minWidth: 110, gap: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5, width: '100%' }}>
                <span style={{ fontSize: 11, marginRight: 1 }}>👨‍👩‍👧</span>
                <span style={{ fontSize: 12, fontWeight: active ? 700 : 600, color: active ? '#fafaf9' : '#d6d3d1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>Everyone</span>
                {total > 0 && <span style={{ fontSize: 9, background: '#292524', color: '#a8a29e', borderRadius: 8, padding: '1px 5px', flexShrink: 0 }}>{total}</span>}
              </div>
              <span style={{ fontSize: 9, color: active ? '#d97706' : '#57534e', textTransform: 'uppercase', letterSpacing: '0.06em' }}>All on this case</span>
            </button>
          );
        })()}
        {visibleContacts.map(c => {
          const active = activeContact?.phone === c.phone;
          const count  = msgCount(c);
          const color  = participantColor(c.name);
          return (
            <button key={c.phone} onClick={() => { setActiveContact(c); setNewMode(false); }}
              style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', padding: '8px 14px', background: 'transparent', border: 'none', borderBottom: active ? `2px solid ${color}` : '2px solid transparent', borderRight: '1px solid #1c1917', cursor: 'pointer', flexShrink: 0, minWidth: 90, maxWidth: 140, gap: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5, width: '100%' }}>
                <span style={{ fontSize: 12, fontWeight: active ? 700 : 500, color: active ? '#fafaf9' : '#78716c', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                  {c.name.split(' ')[0]}
                </span>
                {count > 0 && <span style={{ fontSize: 9, background: '#292524', color: '#a8a29e', borderRadius: 8, padding: '1px 5px', flexShrink: 0 }}>{count}</span>}
              </div>
              <span style={{ fontSize: 9, color: active ? color : '#44403c', textTransform: 'uppercase', letterSpacing: '0.06em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' }}>
                {c._custom ? c.phone : (c.role || 'Contact')}
              </span>
            </button>
          );
        })}
        {/* Group thread tabs — one per apple group chat routed to this deal */}
        {groupThreads.map(g => {
          const active = activeContact?.thread_key === g.thread_key;
          const count  = msgs.filter(m => m.thread_key === g.thread_key).length;
          return (
            <button key={g.thread_key} onClick={() => { setActiveContact(g); setNewMode(false); }}
              style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', padding: '8px 14px', background: 'transparent', border: 'none', borderBottom: active ? '2px solid #22c55e' : '2px solid transparent', borderRight: '1px solid #1c1917', cursor: 'pointer', flexShrink: 0, minWidth: 100, maxWidth: 160, gap: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5, width: '100%' }}>
                <span style={{ fontSize: 11, marginRight: 1 }}>👥</span>
                <span style={{ fontSize: 12, fontWeight: active ? 700 : 500, color: active ? '#fafaf9' : '#78716c', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                  {g.name}
                </span>
                {count > 0 && <span style={{ fontSize: 9, background: '#292524', color: '#a8a29e', borderRadius: 8, padding: '1px 5px', flexShrink: 0 }}>{count}</span>}
              </div>
              <span style={{ fontSize: 9, color: active ? '#22c55e' : '#44403c', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Group · iMessage</span>
            </button>
          );
        })}
        <button onClick={() => { setNewMode(true); setActiveContact(null); setGroupMode(false); }}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '8px 12px', background: 'transparent', border: 'none', borderBottom: newMode ? '2px solid #d97706' : '2px solid transparent', cursor: 'pointer', flexShrink: 0, color: newMode ? '#d97706' : '#44403c', fontSize: 18, fontWeight: 300 }}>
          ＋
        </button>
        <button onClick={() => { setGroupMode(true); setNewMode(false); setEmailMode(false); }}
          title="Send a message to two or more contacts at once"
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4, padding: '8px 12px', background: 'transparent', border: 'none', borderBottom: groupMode ? '2px solid #22c55e' : '2px solid transparent', cursor: 'pointer', flexShrink: 0, color: groupMode ? '#22c55e' : '#57534e', fontSize: 11, fontWeight: 600 }}>
          👥 Group
        </button>
        <button onClick={() => { setEmailMode(true); setGroupMode(false); setNewMode(false); setRvmMode(false); if (!emailForm.subject) loadEmailTemplate('payoff'); }}
          title="Compose an email (from nathan@refundlocators.com, replies route to your Gmail)"
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4, padding: '8px 12px', background: 'transparent', border: 'none', borderBottom: emailMode ? '2px solid #3b82f6' : '2px solid transparent', cursor: 'pointer', flexShrink: 0, color: emailMode ? '#3b82f6' : '#57534e', fontSize: 11, fontWeight: 600 }}>
          📧 Email
        </button>
        <button onClick={() => { setRvmMode(true); setEmailMode(false); setGroupMode(false); setNewMode(false); if (activeContact?.phone) setRvmPhone(activeContact.phone); }}
          title="Drop a ringless voicemail to this contact"
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4, padding: '8px 12px', background: 'transparent', border: 'none', borderBottom: rvmMode ? '2px solid #f97316' : '2px solid transparent', cursor: 'pointer', flexShrink: 0, color: rvmMode ? '#f97316' : '#57534e', fontSize: 11, fontWeight: 600 }}>
          📣 Drop VM
        </button>
        {deal.meta?.homeownerPhone && (
          <button onClick={() => setShowIntroModal(true)}
            title="Send a pre-filled intro text to the homeowner"
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4, padding: '8px 12px', background: 'transparent', border: 'none', borderBottom: '2px solid transparent', cursor: 'pointer', flexShrink: 0, color: '#6ee7b7', fontSize: 11, fontWeight: 600 }}>
            📝 Send Intro
          </button>
        )}
        {visibleContacts.length === 0 && groupThreads.length === 0 && !newMode && (
          <span style={{ fontSize: 11, color: '#44403c', alignSelf: 'center', padding: '0 14px', whiteSpace: 'nowrap' }}>No contacts with phone numbers — add vendors or click ＋</span>
        )}
      </div>

      {/* Email compose panel */}
      {emailMode && (
        <div style={{ padding: 14, borderBottom: '1px solid #1c1917', background: '#141210', flexShrink: 0, maxHeight: '60%', overflowY: 'auto' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#3b82f6', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
              📧 Compose email · from nathan@refundlocators.com
            </div>
            <div style={{ display: 'flex', gap: 4 }}>
              {Object.entries(emailTemplates).map(([key, t]) => (
                <button key={key} onClick={() => loadEmailTemplate(key)}
                  style={{ background: 'transparent', border: '1px solid #292524', color: '#a8a29e', padding: '3px 9px', fontSize: 10, fontWeight: 600, borderRadius: 4, cursor: 'pointer', fontFamily: 'inherit' }}>
                  {t.label}
                </button>
              ))}
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '60px 1fr', gap: '6px 10px', alignItems: 'center', marginBottom: 8 }}>
            <label style={{ fontSize: 11, color: '#78716c', textAlign: 'right' }}>To:</label>
            <input value={emailForm.to} onChange={e => setEmailForm(f => ({ ...f, to: e.target.value }))}
              placeholder="attorney@lawfirm.com" list="deal-contact-emails"
              style={{ background: '#1c1917', border: '1px solid #292524', color: '#fafaf9', borderRadius: 5, padding: '6px 10px', fontSize: 12, fontFamily: 'inherit' }} />
            <label style={{ fontSize: 11, color: '#78716c', textAlign: 'right' }}>Cc:</label>
            <input value={emailForm.cc} onChange={e => setEmailForm(f => ({ ...f, cc: e.target.value }))}
              placeholder="client@email.com (comma-separated for multiple)" list="deal-contact-emails"
              style={{ background: '#1c1917', border: '1px solid #292524', color: '#fafaf9', borderRadius: 5, padding: '6px 10px', fontSize: 12, fontFamily: 'inherit' }} />
            <label style={{ fontSize: 11, color: '#78716c', textAlign: 'right' }}>Subject:</label>
            <input value={emailForm.subject} onChange={e => setEmailForm(f => ({ ...f, subject: e.target.value }))}
              placeholder="Subject line"
              style={{ background: '#1c1917', border: '1px solid #292524', color: '#fafaf9', borderRadius: 5, padding: '6px 10px', fontSize: 12, fontFamily: 'inherit', fontWeight: 600 }} />
          </div>
          <datalist id="deal-contact-emails">
            {dcContacts.filter(c => c.email).map(c => <option key={c.id} value={c.email}>{c.name}</option>)}
            {deal?.meta?.homeownerEmail && <option value={deal.meta.homeownerEmail}>{deal.meta.homeownerName || 'Homeowner'}</option>}
          </datalist>
          <textarea value={emailForm.body} onChange={e => setEmailForm(f => ({ ...f, body: e.target.value }))}
            placeholder="Message…" rows={10}
            style={{ width: '100%', background: '#1c1917', border: '1px solid #292524', color: '#fafaf9', borderRadius: 8, padding: '10px 14px', fontSize: 13, fontFamily: 'inherit', resize: 'vertical', outline: 'none', lineHeight: 1.55, boxSizing: 'border-box' }} />
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 10, gap: 8 }}>
            <div style={{ fontSize: 10, color: '#57534e' }}>
              Reply-To: nathan@fundlocators.com · Bcc: nathan@fundlocators.com (so your Gmail has a copy)
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button onClick={() => { setEmailMode(false); setEmailErr(null); }}
                style={{ background: 'transparent', border: '1px solid #44403c', color: '#78716c', borderRadius: 6, padding: '6px 12px', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }}>Cancel</button>
              <button onClick={sendEmail}
                disabled={emailSending || !emailForm.to.trim() || !emailForm.subject.trim() || !emailForm.body.trim()}
                style={{ background: (emailForm.to.trim() && emailForm.subject.trim() && emailForm.body.trim() && !emailSending) ? '#3b82f6' : '#292524', border: 'none', color: '#fafaf9', borderRadius: 6, padding: '6px 16px', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>
                {emailSending ? 'Sending…' : '📧 Send email'}
              </button>
            </div>
          </div>
          {emailErr && <div style={{ fontSize: 11, color: '#ef4444', marginTop: 6 }}>⚠ {emailErr}</div>}
        </div>
      )}

      {showIntroModal && (
        <SendIntroTextModal deal={deal} onClose={() => setShowIntroModal(false)} onSent={load} />
      )}

      {/* RVM compose panel */}
      {rvmMode && (
        <div style={{ padding: 14, borderBottom: '1px solid #1c1917', background: '#141210', flexShrink: 0 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#f97316', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 10 }}>
            📣 Drop Ringless Voicemail
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '80px 1fr', gap: '8px 10px', alignItems: 'center', marginBottom: 10 }}>
            <label style={{ fontSize: 11, color: '#78716c', textAlign: 'right' }}>To:</label>
            <input value={rvmPhone} onChange={e => setRvmPhone(e.target.value)}
              placeholder="+1 (555) 000-0000"
              style={{ background: '#1c1917', border: '1px solid #292524', color: '#fafaf9', borderRadius: 5, padding: '6px 10px', fontSize: 12, fontFamily: "'DM Mono', monospace", outline: 'none' }} />
            <label style={{ fontSize: 11, color: '#78716c', textAlign: 'right' }}>Template:</label>
            <select value={rvmTemplate} onChange={e => setRvmTemplate(e.target.value)}
              style={{ background: '#1c1917', border: '1px solid #292524', color: '#fafaf9', borderRadius: 5, padding: '6px 10px', fontSize: 12, fontFamily: 'inherit', outline: 'none' }}>
              {Object.entries(RVM_TEMPLATES).map(([key, t]) => (
                <option key={key} value={key}>{t.label}</option>
              ))}
            </select>
            <label style={{ fontSize: 11, color: '#78716c', textAlign: 'right' }}>Audio URL:</label>
            <input value={rvmAudioUrl} onChange={e => setRvmAudioUrl(e.target.value)}
              placeholder="Override audio URL (optional)"
              style={{ background: '#1c1917', border: '1px solid #292524', color: '#fafaf9', borderRadius: 5, padding: '6px 10px', fontSize: 12, fontFamily: 'inherit', outline: 'none' }} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
            <button onClick={() => { setRvmMode(false); setRvmResult(null); setRvmAudioUrl(''); }}
              style={{ background: 'transparent', border: '1px solid #44403c', color: '#78716c', borderRadius: 6, padding: '6px 12px', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }}>Cancel</button>
            <button onClick={dropRvm} disabled={rvmSending || !rvmPhone.trim()}
              style={{ background: (!rvmSending && rvmPhone.trim()) ? '#f97316' : '#292524', border: 'none', color: '#fafaf9', borderRadius: 6, padding: '6px 16px', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>
              {rvmSending ? 'Dropping…' : '📣 Drop VM'}
            </button>
          </div>
          {rvmResult && (
            <div style={{ marginTop: 10, padding: '8px 10px', borderRadius: 6, fontSize: 12, background: rvmResult.type === 'success' ? '#064e3b' : '#7f1d1d', color: rvmResult.type === 'success' ? '#6ee7b7' : '#fca5a5' }}>
              {rvmResult.text}
            </div>
          )}
        </div>
      )}

      {/* Group compose panel */}
      {groupMode && (
        <div style={{ padding: 14, borderBottom: '1px solid #1c1917', background: '#141210', flexShrink: 0 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#22c55e', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 10 }}>
            👥 New group message · pick 2 or more contacts
          </div>
          {contacts.length === 0 ? (
            <div style={{ fontSize: 12, color: '#78716c', fontStyle: 'italic' }}>No contacts with phone numbers on this deal yet. Add them on the Contacts tab first.</div>
          ) : (
            <>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
                {contacts.map(c => {
                  const sel = groupSelected.has(c.phone);
                  return (
                    <button key={c.phone} onClick={() => toggleGroupMember(c.phone)}
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: 6,
                        padding: '5px 11px', fontSize: 12, fontWeight: 600,
                        background: sel ? '#22c55e' : 'transparent',
                        color: sel ? '#0c0a09' : '#d6d3d1',
                        border: `1px solid ${sel ? '#22c55e' : '#292524'}`,
                        borderRadius: 999, cursor: 'pointer', fontFamily: 'inherit',
                        transition: 'all 0.12s',
                      }}>
                      {sel ? '✓' : '○'} {c.name.split(' ')[0]}
                      <span style={{ fontSize: 10, opacity: 0.7 }}>· {c.role || 'Contact'}</span>
                    </button>
                  );
                })}
              </div>
              <textarea
                value={groupBody}
                onChange={e => setGroupBody(e.target.value)}
                placeholder={
                  groupSelected.size >= 2
                    ? `Message ${[...groupSelected].map(p => contacts.find(c => c.phone === p)?.name?.split(' ')[0]).filter(Boolean).join(' + ')}…`
                    : 'Pick 2 or more contacts above first…'
                }
                rows={3}
                disabled={groupSelected.size < 2}
                style={{ width: '100%', background: '#1c1917', border: '1px solid #292524', borderRadius: 8, color: '#fafaf9', padding: '8px 12px', fontSize: 13, fontFamily: 'inherit', resize: 'vertical', outline: 'none', lineHeight: 1.5, boxSizing: 'border-box', opacity: groupSelected.size < 2 ? 0.4 : 1 }}
              />
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8, gap: 8 }}>
                <div style={{ fontSize: 10, color: '#57534e' }}>
                  Each recipient gets the message individually (or one iMessage group if all are blue). Replies land in each contact's own thread; see "Everyone" for the merged view.
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button onClick={() => { setGroupMode(false); setGroupSelected(new Set()); setGroupBody(''); setGroupErr(null); }}
                    style={{ background: 'transparent', border: '1px solid #44403c', color: '#78716c', borderRadius: 6, padding: '6px 12px', fontSize: 12, cursor: 'pointer' }}>Cancel</button>
                  <button onClick={sendGroup}
                    disabled={groupSelected.size < 2 || !groupBody.trim() || groupSending}
                    style={{ background: (groupSelected.size >= 2 && groupBody.trim() && !groupSending) ? '#22c55e' : '#292524', border: 'none', color: '#fafaf9', borderRadius: 6, padding: '6px 14px', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
                    {groupSending ? 'Sending…' : `Send to ${groupSelected.size || 0}`}
                  </button>
                </div>
              </div>
              {groupErr && <div style={{ fontSize: 11, color: '#ef4444', marginTop: 6 }}>⚠ {groupErr}</div>}
            </>
          )}
        </div>
      )}

      {/* New conversation input */}
      {newMode && (
        <div style={{ padding: '8px 12px', borderBottom: '1px solid #1c1917', background: '#141210', display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
          <input autoFocus value={newPhone} onChange={e => setNewPhone(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && startNew()} placeholder="+1 (555) 000-0000"
            style={{ flex: 1, background: '#1c1917', border: '1px solid #44403c', borderRadius: 6, color: '#fafaf9', padding: '6px 10px', fontSize: 13, fontFamily: "'DM Mono', monospace", outline: 'none' }} />
          <button onClick={startNew} disabled={!newPhone.trim()}
            style={{ background: newPhone.trim() ? '#d97706' : '#292524', border: 'none', color: '#fafaf9', borderRadius: 6, padding: '6px 14px', fontSize: 12, fontWeight: 700, cursor: newPhone.trim() ? 'pointer' : 'default' }}>Start</button>
          <button onClick={() => { setNewMode(false); if (visibleContacts.length > 0) setActiveContact(visibleContacts[0]); }}
            style={{ background: 'transparent', border: '1px solid #44403c', color: '#78716c', borderRadius: 6, padding: '6px 10px', fontSize: 12, cursor: 'pointer' }}>Cancel</button>
        </div>
      )}

      {/* Thread header */}
      {activeContact && (
        <div className="thread-header" style={{ padding: '8px 14px', borderBottom: '1px solid #1c1917', background: '#141210', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 30, height: 30, borderRadius: '50%', background: activeContact._everyone ? '#d97706' : participantColor(activeContact.name), display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, flexShrink: 0, color: '#fff', fontWeight: 700 }}>
            {activeContact._everyone ? '👨‍👩‍👧' : (activeContact.name || '?')[0].toUpperCase()}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#fafaf9' }}>{activeContact.name}</div>
            <div style={{ fontSize: 10, color: '#57534e', fontFamily: "'DM Mono', monospace" }}>
              {activeContact._everyone
                ? `${contacts.length} contact${contacts.length === 1 ? '' : 's'} · pick a tab to reply individually`
                : <><a href={`tel:${activeContact.phone}`} style={{ color: 'inherit', textDecoration: 'none' }}>{activeContact.phone}</a>{activeContact.role ? ` · ${activeContact.role}` : ''}</>
              }
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            <div className="thread-header-from" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
              <span style={{ fontSize: 9, color: '#57534e', textTransform: 'uppercase', letterSpacing: '0.08em' }}>From</span>
              {phoneNumbers.length === 0
                ? <span style={{ fontSize: 11, color: '#44403c', fontFamily: "'DM Mono', monospace" }}>No numbers configured</span>
                : <select value={fromNumber} onChange={e => setFromNumber(e.target.value)}
                    style={{ background: '#1c1917', border: '1px solid #44403c', color: '#d97706', borderRadius: 6, padding: '3px 8px', fontSize: 12, fontFamily: "'DM Mono', monospace", cursor: 'pointer', outline: 'none' }}>
                    {phoneNumbers.map(p => <option key={p.id} value={p.number}>{p.label} · {p.number}</option>)}
                  </select>
              }
            </div>
            <button title="Hide thread" onClick={() => hideThread(activeContact)}
              style={{ background: 'transparent', border: '1px solid #292524', color: '#44403c', borderRadius: 5, padding: '4px 7px', fontSize: 12, cursor: 'pointer' }}>
              ✕
            </button>
          </div>
        </div>
      )}

      {/* Channel filter chips */}
      {activeContact && (
        <div className="channel-chips" style={{ display: 'flex', gap: 6, padding: '8px 14px', borderBottom: '1px solid #1c1917', background: '#0f0d0c', flexShrink: 0, overflowX: 'auto', scrollbarWidth: 'none' }}>
          {[
            { key: 'all',   label: 'All',            icon: '☰',  count: chipCounts.sms + chipCounts.calls + chipCounts.email + chipCounts.notes },
            { key: 'sms',   label: 'Messages',       icon: '💬', count: chipCounts.sms },
            { key: 'calls', label: 'Calls',          icon: '📞', count: chipCounts.calls },
            { key: 'email', label: 'Email',          icon: '📧', count: chipCounts.email },
            { key: 'notes', label: 'Internal notes', icon: '🔒', count: chipCounts.notes },
          ].map(chip => {
            const active = channelFilter === chip.key;
            return (
              <button key={chip.key} onClick={() => setChannelFilter(chip.key)}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 5,
                  padding: '3px 10px', fontSize: 11, fontWeight: 600,
                  background: active ? '#d97706' : 'transparent',
                  color: active ? '#0c0a09' : '#78716c',
                  border: `1px solid ${active ? '#d97706' : '#292524'}`,
                  borderRadius: 999, cursor: 'pointer', fontFamily: 'inherit',
                  whiteSpace: 'nowrap', transition: 'all 0.12s',
                }}>
                <span>{chip.icon}</span> {chip.label}
                {chip.count > 0 && <span style={{ fontSize: 10, opacity: 0.85, fontFamily: "'DM Mono', monospace" }}>{chip.count}</span>}
              </button>
            );
          })}
        </div>
      )}

      {/* Thread */}
      <div ref={threadRef} style={{ flex: 1, overflowY: 'auto', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 0 }}>
        {!activeContact && !newMode && (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: '#44403c', fontSize: 13, gap: 6, paddingTop: 60 }}>
            <div style={{ fontSize: 32 }}>💬</div>
            <div>Select a contact above or tap ＋ to start a new conversation</div>
          </div>
        )}
        {activeContact && threadItems.length === 0 && (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: '#44403c', fontSize: 13, gap: 6, paddingTop: 60 }}>
            <div style={{ fontSize: 32 }}>💬</div>
            <div>No conversation with {activeContact.name.split(' ')[0]} yet</div>
            <div style={{ fontSize: 11 }}>Type below to start, or wait for a call to land here</div>
          </div>
        )}
        {days.map(({ day, items }) => (
          <div key={day}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '14px 0 10px' }}>
              <div style={{ flex: 1, height: 1, background: '#1c1917' }} />
              <span style={{ fontSize: 10, color: '#44403c', fontFamily: "'DM Mono', monospace", whiteSpace: 'nowrap' }}>{day}</span>
              <div style={{ flex: 1, height: 1, background: '#1c1917' }} />
            </div>
            {items.map((m, i) => {
              const time = new Date(m._ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

              // ─── Call bubble ──────────────────────────────────────────
              if (m._kind === 'call') {
                const isInbound = m.direction === 'inbound';
                const isMissed  = ['missed', 'no-answer', 'busy'].includes(m.status);
                const durText   = m.duration_seconds > 0
                  ? `${Math.floor(m.duration_seconds / 60)}m ${m.duration_seconds % 60}s`
                  : m.status;
                const label     = isMissed ? (isInbound ? '📵 Missed call' : '📵 Call unanswered')
                                           : (isInbound ? '📞 Inbound call' : '📞 Outbound call');
                const color     = isMissed ? '#a83232' : '#22c55e';
                return (
                  <div key={'c-' + m.id} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginBottom: 12 }}>
                    <div style={{ maxWidth: '85%', background: '#1c1917', border: `1px solid ${color}33`, borderLeft: `3px solid ${color}`, borderRadius: 8, padding: '10px 14px', width: '100%' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: m.recording_url ? 8 : 0 }}>
                        <div>
                          <span style={{ fontSize: 12, fontWeight: 700, color, letterSpacing: '0.04em' }}>{label}</span>
                          <span style={{ fontSize: 11, color: '#78716c', marginLeft: 8 }}>· {durText}</span>
                          {m.auto_sms_sent && <span style={{ fontSize: 10, color: '#6ee7b7', marginLeft: 8 }}>· auto-SMS sent</span>}
                        </div>
                        <span style={{ fontSize: 10, color: '#57534e', fontFamily: "'DM Mono', monospace" }}>{time}</span>
                      </div>
                      {m.recording_url && (
                        <audio controls src={m.recording_url} style={{ width: '100%', height: 32 }}>
                          Your browser does not support audio playback.
                        </audio>
                      )}
                    </div>
                  </div>
                );
              }

              // ─── Email bubble ────────────────────────────────────────
              if (m._kind === 'email') {
                const isInbound = m.direction === 'inbound';
                const toLabel   = (m.to_emails || []).join(', ');
                const ccLabel   = (m.cc_emails || []).filter(e => e && !e.includes('fundlocators.com')).join(', ');
                return (
                  <div key={'e-' + m.id} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginBottom: 12 }}>
                    <div style={{ maxWidth: '90%', background: '#1c1917', border: '1px solid #1e3a8a33', borderLeft: '3px solid #3b82f6', borderRadius: 8, padding: '10px 14px', width: '100%' }}>
                      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
                        <div>
                          <span style={{ fontSize: 11, fontWeight: 700, color: '#3b82f6', letterSpacing: '0.04em' }}>📧 {isInbound ? 'EMAIL RECEIVED' : 'EMAIL SENT'}</span>
                          {m.status === 'failed' && <span style={{ fontSize: 10, fontWeight: 700, color: '#ef4444', marginLeft: 8 }}>· FAILED</span>}
                        </div>
                        <span style={{ fontSize: 10, color: '#57534e', fontFamily: "'DM Mono', monospace" }}>{time}</span>
                      </div>
                      <div style={{ fontSize: 13, fontWeight: 700, color: '#fafaf9', marginBottom: 4, lineHeight: 1.4 }}>{m.subject || '(no subject)'}</div>
                      <div style={{ fontSize: 11, color: '#a8a29e', marginBottom: 8, lineHeight: 1.5, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                        <span><span style={{ color: '#57534e' }}>to</span> {toLabel}</span>
                        {ccLabel && <span><span style={{ color: '#57534e' }}>cc</span> {ccLabel}</span>}
                      </div>
                      <details style={{ fontSize: 13, color: '#d6d3d1' }}>
                        <summary style={{ cursor: 'pointer', fontSize: 12, color: '#78716c', marginBottom: 6 }}>
                          {(m.body_text || '').split('\n')[0].slice(0, 120)}{(m.body_text || '').length > 120 ? '…' : ''} — click to expand
                        </summary>
                        <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.55, marginTop: 8, paddingTop: 8, borderTop: '1px solid #292524' }}>{m.body_text}</div>
                      </details>
                      {m.error_message && <div style={{ fontSize: 11, color: '#ef4444', marginTop: 6 }}>⚠ {m.error_message}</div>}
                    </div>
                  </div>
                );
              }

              // ─── Internal note bubble ────────────────────────────────
              if (m._kind === 'note') {
                return (
                  <div key={'n-' + m.id} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginBottom: 10 }}>
                    <div style={{ maxWidth: '85%', background: 'rgba(251, 191, 36, 0.05)', border: '1px dashed #78350f', borderRadius: 8, padding: '8px 12px', width: '100%' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: m.body ? 4 : 0 }}>
                        <span style={{ fontSize: 10, fontWeight: 700, color: '#fbbf24', letterSpacing: '0.08em', textTransform: 'uppercase' }}>🔒 Internal note</span>
                        {m.title && <span style={{ fontSize: 12, fontWeight: 600, color: '#fafaf9' }}>· {m.title}</span>}
                        <span style={{ fontSize: 10, color: '#78716c', marginLeft: 'auto', fontFamily: "'DM Mono', monospace" }}>{time}</span>
                      </div>
                      {m.body && (
                        <div style={{ fontSize: 12, color: '#d6d3d1', lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{m.body}</div>
                      )}
                    </div>
                  </div>
                );
              }

              // ─── Message bubble (existing behavior) ──────────────────
              const isInbound = m.direction === 'inbound';
              const showMeta  = i === items.length - 1 || items[i+1]?.direction !== m.direction || items[i+1]?.from_number !== m.from_number;

              // Detect tapback reactions — bridge normalises them to "👍 reacted to: '…'"
              const reactionMatch = m.body?.match(/^([\u{1F600}-\u{1F9FF}‼️❓][\uFE0F]?) reacted to: "(.*)"$/u);
              const isReaction = !!reactionMatch;
              const reactionEmoji = reactionMatch?.[1] || '';
              const reactionQuote = reactionMatch?.[2] || '';

              // Resolve sender name for inbound messages
              const senderContact = isInbound
                ? contacts.find(c => normalizePhone(c.phone) === normalizePhone(m.from_number) || normalizePhone(c.phone) === normalizePhone(m.to_number))
                : null;
              const senderName  = senderContact?.name || m.from_number || 'Unknown';
              const senderColor = participantColor(senderName);

              if (isReaction) {
                // Render as a compact reaction pill — no full bubble
                return (
                  <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 5, justifyContent: isInbound ? 'flex-start' : 'flex-end', marginBottom: 4 }}>
                    <span style={{ fontSize: 18, lineHeight: 1 }}>{reactionEmoji}</span>
                    <span style={{ fontSize: 11, color: '#57534e' }}>
                      {isInbound ? <span style={{ color: senderColor, fontWeight: 600 }}>{senderName.split(' ')[0]}</span> : 'You'}
                      {' '}· <span style={{ fontStyle: 'italic' }}>{reactionQuote.length > 40 ? reactionQuote.slice(0, 37) + '…' : reactionQuote}</span>
                      {' '}· <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10 }}>{time}</span>
                    </span>
                  </div>
                );
              }

              const mediaIsVideo = m.media_url && /\.(mp4|mov|webm|m4v)(\?|$)/i.test(m.media_url);
              const mediaIsImage = m.media_url && /\.(jpg|jpeg|png|gif|webp|heic)(\?|$)/i.test(m.media_url);

              return (
                <div key={m.id} style={{ display: 'flex', flexDirection: 'column', alignItems: isInbound ? 'flex-start' : 'flex-end', marginBottom: showMeta ? 10 : 2 }}>
                  <div style={{ maxWidth: '78%', background: isInbound ? '#1c1917' : bubbleBg(m.status), borderRadius: isInbound ? '16px 16px 16px 4px' : '16px 16px 4px 16px', padding: '9px 13px', border: isInbound ? `1px solid ${senderColor}33` : 'none' }}>
                    {m.body ? <div style={{ fontSize: 14, color: '#fafaf9', lineHeight: 1.55, wordBreak: 'break-word' }}>{m.body}</div> : null}
                    {mediaIsVideo && (
                      <video controls src={m.media_url} style={{ maxWidth: 220, maxHeight: 220, borderRadius: 10, marginTop: m.body ? 6 : 0, display: 'block' }} />
                    )}
                    {mediaIsImage && (
                      <img src={m.media_url} style={{ maxWidth: 220, maxHeight: 220, borderRadius: 10, cursor: 'pointer', marginTop: m.body ? 6 : 0, display: 'block' }} onClick={() => window.open(m.media_url, '_blank')} alt="media" />
                    )}
                    {m.media_url && !mediaIsVideo && !mediaIsImage && (
                      <a href={m.media_url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 13, color: '#60a5fa', marginTop: m.body ? 4 : 0, display: 'block' }}>📎 View attachment</a>
                    )}
                  </div>
                  {showMeta && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 3, paddingLeft: isInbound ? 2 : 0, paddingRight: isInbound ? 0 : 2 }}>
                      {isInbound
                        ? <>
                            <span style={{ fontSize: 10, fontWeight: 600, color: senderColor }}>{senderName.split(' ')[0]}</span>
                            <span style={{ fontSize: 10, color: '#44403c', fontFamily: "'DM Mono', monospace" }}>{time}</span>
                          </>
                        : <>
                            {activeContact?._everyone && (() => {
                              // In Everyone view, show who outbound went to
                              const recipient = contacts.find(c => normalizePhone(c.phone) === normalizePhone(m.to_number));
                              const recipientName = recipient?.name?.split(' ')[0] || m.to_number;
                              const recipientColor = participantColor(recipient?.name || m.to_number);
                              return <span style={{ fontSize: 10, color: '#78716c' }}>to <span style={{ color: recipientColor, fontWeight: 600 }}>{recipientName}</span></span>;
                            })()}
                            <span style={{ fontSize: 10, color: '#57534e' }}>{time}</span>
                            <span style={{ fontSize: 11, fontWeight: 700, color: statusColor(m.status) }}>{statusIcon(m.status)}</span>
                          </>
                      }
                    </div>
                  )}
                  {m.error_message && (
                    <div style={{ fontSize: 11, color: '#ef4444', marginTop: 2, paddingRight: 2 }}>⚠ {m.error_message}</div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>

      {/* Compose */}
      {activeContact?._everyone ? (
        <div style={{ borderTop: '1px solid #1c1917', background: '#141210', padding: '12px 14px', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
          <span style={{ fontSize: 12, color: '#78716c' }}>Reading a merged view. Click any contact tab to reply, or</span>
          <button onClick={() => { setGroupMode(true); setActiveContact(null); }}
            style={{ background: '#22c55e', color: '#0c0a09', border: 'none', borderRadius: 6, padding: '6px 14px', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>
            👥 Send group message
          </button>
        </div>
      ) : (activeContact || newMode) && (
        <div className="composer" style={{ borderTop: '1px solid #1c1917', background: '#141210', padding: '8px 10px', flexShrink: 0 }}>
          {showMediaInput && (
            <div style={{ marginBottom: 6 }}>
              <input
                value={mediaUrl}
                onChange={e => setMediaUrl(e.target.value)}
                placeholder="Paste image / video URL (https://…)"
                style={{ width: '100%', background: '#1c1917', border: '1px solid #44403c', borderRadius: 8, color: '#fafaf9', padding: '7px 12px', fontSize: 12, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' }}
              />
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
            <button
              onClick={() => setShowMediaInput(v => !v)}
              title="Attach image or video URL"
              style={{ width: 34, height: 34, borderRadius: '50%', background: (showMediaInput || mediaUrl) ? '#78350f' : '#1c1917', border: `1px solid ${(showMediaInput || mediaUrl) ? '#d97706' : '#292524'}`, color: (showMediaInput || mediaUrl) ? '#fbbf24' : '#57534e', fontSize: 16, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transition: 'all 0.15s' }}>
              📎
            </button>
            <textarea value={body} onChange={e => setBody(e.target.value)} onKeyDown={handleKeyDown}
              placeholder={activeContact ? `Message ${activeContact.name.split(' ')[0]}…` : 'Enter a number above first'}
              disabled={!activeContact} rows={2}
              style={{ flex: 1, background: '#1c1917', border: '1px solid #292524', borderRadius: 18, color: '#fafaf9', padding: '8px 14px', fontSize: 13, fontFamily: 'inherit', resize: 'none', outline: 'none', lineHeight: 1.5, opacity: activeContact ? 1 : 0.4 }} />
            <button onClick={send} disabled={!canSend}
              style={{ width: 34, height: 34, borderRadius: '50%', background: canSend ? '#d97706' : '#292524', border: 'none', color: '#fafaf9', fontSize: 17, cursor: canSend ? 'pointer' : 'default', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transition: 'background 0.15s' }}>
              ↑
            </button>
          </div>
          {sendErr && <div style={{ fontSize: 11, color: '#ef4444', marginTop: 5, paddingLeft: 4 }}>⚠ {sendErr}</div>}
          <div style={{ fontSize: 10, color: '#44403c', marginTop: 4, paddingLeft: 4 }}>
            {mediaUrl ? '📎 media attached · ' : ''}⌘↵ to send
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Full Activity Log Modal ─────────────────────────────────────────
// ─── Leads Modal (admin + VA) ──────────────────────────
function LeadsModal({ onClose, userName, onConverted }) {
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('new');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [expandedDupId, setExpandedDupId] = useState(null);

  const load = async () => {
    setLoading(true);
    let q = sb.from('leads').select('*').order('created_at', { ascending: false });
    if (filter !== 'all') q = q.eq('status', filter);
    const { data } = await q;
    setLeads(data || []);
    setLoading(false);
  };

  useEffect(() => { load(); }, [filter]);

  const updateStatus = async (lead, newStatus) => {
    setBusy(true); setMsg(null);
    const patch = { status: newStatus };
    if (newStatus === 'contacted' && !lead.contacted_at) patch.contacted_at = new Date().toISOString();
    const { error } = await sb.from('leads').update(patch).eq('id', lead.id);
    if (error) setMsg({ type: 'error', text: error.message });
    else setMsg({ type: 'success', text: `Lead moved to ${newStatus}` });
    await load();
    setBusy(false);
  };

  const dismissDuplicates = async (lead) => {
    setBusy(true); setMsg(null);
    const { error } = await sb.rpc('dismiss_lead_duplicates', { p_lead_id: lead.id, p_note: null });
    if (error) setMsg({ type: 'error', text: error.message });
    else setMsg({ type: 'success', text: 'Duplicate warning dismissed' });
    await load();
    setBusy(false);
  };

  const rescanDuplicates = async (lead) => {
    setBusy(true); setMsg(null);
    const { data, error } = await sb.rpc('rescan_lead_duplicates', { p_lead_id: lead.id });
    if (error) setMsg({ type: 'error', text: error.message });
    else {
      const n = Array.isArray(data) ? data.length : 0;
      setMsg({ type: 'success', text: n === 0 ? 'Rescanned — no duplicates found' : `Rescanned — ${n} match${n === 1 ? '' : 'es'}` });
    }
    await load();
    setBusy(false);
  };

  const linkToExistingDeal = async (lead, dealId, dealName) => {
    if (!window.confirm(`Link this lead to existing deal "${dealName}" (${dealId})? Lead will move to 'signed'.`)) return;
    setBusy(true); setMsg(null);
    const { error } = await sb.from('leads').update({ status: 'signed', converted_to_deal_id: dealId }).eq('id', lead.id);
    if (error) setMsg({ type: 'error', text: error.message });
    else {
      setMsg({ type: 'success', text: `Linked to ${dealId}` });
      onConverted?.();
    }
    await load();
    setBusy(false);
  };

  const convertToDeal = async (lead) => {
    // Pre-check for existing deal matches — warn before creating a new one
    const dealDups = (lead.metadata?.duplicates || []).filter(d => d.kind === 'deal');
    const unresolvedDeals = lead.metadata?.duplicates_dismissed_at ? [] : dealDups;
    if (unresolvedDeals.length > 0) {
      const top = unresolvedDeals[0];
      const ok = window.confirm(
        `⚠ Existing deal detected: "${top.name}" (${top.id})\n\n` +
        `Match score ${top.score}/100 — reasons: ${(top.reasons || []).join(', ')}\n\n` +
        `Creating a new deal will create a duplicate. Click OK to create anyway, or Cancel and use "Link to existing" in the duplicates panel.`
      );
      if (!ok) return;
    } else {
      // Route by lead.lead_type:
      //   surplus        -> surplus deal (former homeowner, funds at court)
      //   preforeclosure -> flip deal   (current homeowner, distressed property)
      //   other          -> surplus deal + note so Nathan triages manually
      const leadType = lead.lead_type || 'surplus';
      const isFlip = leadType === 'preforeclosure';
      const trackLabel = isFlip ? 'flip/wholesale' : leadType === 'other' ? 'surplus (other — review)' : 'surplus';
      if (!window.confirm(`Create a new ${trackLabel} deal for "${lead.name}"? Lead status will change to 'signed'.`)) return;
    }
    setBusy(true); setMsg(null);
    try {
      const leadType = lead.lead_type || 'surplus';
      const isFlip = leadType === 'preforeclosure';
      const idPrefix = isFlip ? 'flip' : 'sf';
      const slug = lead.name.toLowerCase().split(' ').join('-').replace(/[^a-z0-9-]/g, '').slice(0, 30);
      const id = `${idPrefix}-${slug}-${Date.now().toString(36)}`;
      const dealType = isFlip ? 'flip' : 'surplus';
      const dealStatus = isFlip ? 'lead' : 'new-lead';
      const baseMeta = {
        county: lead.county || '',
        courtCase: lead.case_number || '',
        homeownerPhone: lead.phone || '',
        homeownerEmail: lead.email,
        homeownerName: lead.name,
        from_lead_id: lead.id,
        intake_type: leadType,
        intake_notes: lead.notes || '',
      };
      const meta = isFlip
        ? {
            ...baseMeta,
            contractPrice: 0,
            reinstatement: 0,
            lienPayoff: 0,
            listPrice: 0,
            flatFee: 0,
            buyerAgentPct: 3,
            closingMiscPct: 1,
            concessions: [],
          }
        : {
            ...baseMeta,
            feePct: 25,
            estimatedSurplus: 0,
            attorney: '',
          };
      const { error: dealErr } = await sb.from('deals').insert({
        id,
        type: dealType,
        status: dealStatus,
        name: lead.name,
        address: lead.address || '',
        lead_source: lead.source || 'refundlocators-web',
        meta,
      });
      if (dealErr) throw dealErr;
      await sb.from('leads').update({ status: 'signed', converted_to_deal_id: id }).eq('id', lead.id);
      setMsg({ type: 'success', text: `Created ${dealType} deal ${id}` });
      await load();
      onConverted?.();
    } catch (e) {
      setMsg({ type: 'error', text: e.message });
    } finally {
      setBusy(false);
    }
  };

  const statusCounts = {};
  leads.forEach(l => { statusCounts[l.status] = (statusCounts[l.status] || 0) + 1; });

  return (
    <Modal onClose={onClose} title="Leads — Intake Pipeline" wide>
      <div style={{ display: "flex", gap: 4, alignItems: "center", marginBottom: 16, flexWrap: "wrap" }}>
        {['new', 'contacted', 'qualified', 'signed', 'rejected', 'duplicate', 'spam', 'all'].map(s => (
          <button key={s} onClick={() => setFilter(s)} style={{
            padding: "5px 12px",
            borderRadius: 6,
            border: "1px solid " + (filter === s ? "#44403c" : "transparent"),
            background: filter === s ? "#292524" : "transparent",
            color: filter === s ? "#fafaf9" : "#78716c",
            fontSize: 12,
            fontWeight: filter === s ? 700 : 500,
            cursor: "pointer",
            fontFamily: "inherit",
          }}>
            {s.charAt(0).toUpperCase() + s.slice(1)}
          </button>
        ))}
      </div>

      {loading && <div style={{ fontSize: 12, color: "#78716c" }}>Loading…</div>}

      {!loading && leads.length === 0 && (
        <div style={{ fontSize: 13, color: "#78716c", padding: 32, textAlign: "center", fontStyle: "italic", border: "1px dashed #292524", borderRadius: 8 }}>
          No {filter === 'all' ? '' : filter + ' '}leads yet. When someone fills out the form at <code style={{ background: "#0c0a09", padding: "2px 6px", borderRadius: 3, fontSize: 11 }}>/lead-intake.html</code>, they show up here.
        </div>
      )}

      {!loading && leads.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {leads.map(l => {
            const dups = l.metadata?.duplicates || [];
            const dupCount = l.metadata?.duplicate_count || 0;
            const dismissed = !!l.metadata?.duplicates_dismissed_at;
            const hasUnresolvedDups = dupCount > 0 && !dismissed && l.status !== 'duplicate';
            const topScore = dups.reduce((m, d) => Math.max(m, d.score || 0), 0);
            const isExpanded = expandedDupId === l.id;
            return (
            <div key={l.id} style={{
              padding: "14px 16px",
              background: "#0c0a09",
              border: hasUnresolvedDups ? "1px solid #78350f" : "1px solid #292524",
              borderRadius: 8,
            }}>
              {hasUnresolvedDups && (
                <div style={{ marginBottom: 10, padding: "8px 10px", background: "#1f1408", border: "1px solid #78350f", borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                  <div style={{ fontSize: 11, color: "#fbbf24", fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}>
                    <span>⚠</span>
                    <span>{dupCount} possible duplicate{dupCount === 1 ? '' : 's'} detected {topScore > 0 && <span style={{ fontWeight: 400, color: "#d6a85a" }}>· top match {topScore}/100</span>}</span>
                  </div>
                  <div style={{ display: "flex", gap: 6 }}>
                    <button onClick={() => setExpandedDupId(isExpanded ? null : l.id)} style={{ ...btnGhost, fontSize: 10, padding: "3px 10px", color: "#fbbf24", borderColor: "#78350f" }}>
                      {isExpanded ? 'Hide' : 'Review'}
                    </button>
                    <button onClick={() => dismissDuplicates(l)} disabled={busy} style={{ ...btnGhost, fontSize: 10, padding: "3px 10px", color: "#78716c" }}>Dismiss</button>
                  </div>
                </div>
              )}
              {dismissed && dupCount > 0 && (
                <div style={{ marginBottom: 10, padding: "6px 10px", background: "#0c0a09", border: "1px dashed #292524", borderRadius: 6, fontSize: 10, color: "#57534e", display: "flex", justifyContent: "space-between", gap: 8 }}>
                  <span>Duplicate warning dismissed ({dupCount} match{dupCount === 1 ? '' : 'es'})</span>
                  <button onClick={() => rescanDuplicates(l)} disabled={busy} style={{ background: "transparent", border: "none", color: "#78716c", fontSize: 10, cursor: "pointer", textDecoration: "underline", padding: 0 }}>Re-scan</button>
                </div>
              )}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
                <div style={{ flex: 1, minWidth: 200 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: "#fafaf9" }}>
                    {l.name}
                    <span style={{ marginLeft: 8, fontSize: 9, fontWeight: 700, padding: "2px 7px", borderRadius: 3, background: statusBg(l.status), color: statusFg(l.status), letterSpacing: "0.06em", textTransform: "uppercase" }}>{l.status}</span>
                    {l.lead_type && l.lead_type !== 'surplus' && (
                      <span style={{ marginLeft: 6, fontSize: 9, fontWeight: 700, padding: "2px 7px", borderRadius: 3, background: l.lead_type === 'preforeclosure' ? "#78350f" : "#1c1917", color: l.lead_type === 'preforeclosure' ? "#fbbf24" : "#a8a29e", border: "1px solid " + (l.lead_type === 'preforeclosure' ? "#d97706" : "#44403c"), letterSpacing: "0.06em", textTransform: "uppercase" }}>
                        {l.lead_type === 'preforeclosure' ? '🏠 Preforeclosure' : '? Other'}
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: "#a8a29e", marginTop: 4, lineHeight: 1.5 }}>
                    {l.email}{l.phone && <> · <a href={`tel:${l.phone}`} style={{ color: 'inherit', textDecoration: 'none' }}>{l.phone}</a></>}<br/>
                    {l.address && <>{l.address}<br/></>}
                    {l.county && <>{l.county} County</>}{l.case_number && ` · Case ${l.case_number}`}
                  </div>
                  <div style={{ fontSize: 10, color: "#57534e", marginTop: 6 }}>
                    {new Date(l.created_at).toLocaleString()} · from {l.source}{l.converted_to_deal_id && ` · → deal ${l.converted_to_deal_id}`}
                  </div>
                </div>
              </div>
              {isExpanded && dups.length > 0 && (
                <div style={{ marginTop: 10, padding: "10px 12px", background: "#000", border: "1px solid #292524", borderRadius: 6 }}>
                  <div style={{ fontSize: 10, color: "#78716c", fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 8 }}>Possible matches</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {dups.map((d, idx) => {
                      const scoreColor = d.score >= 90 ? "#ef4444" : d.score >= 70 ? "#f59e0b" : "#fbbf24";
                      return (
                        <div key={idx} style={{ padding: "8px 10px", background: "#0c0a09", border: "1px solid #292524", borderRadius: 5, display: "flex", alignItems: "flex-start", gap: 10, flexWrap: "wrap" }}>
                          <div style={{ flex: 1, minWidth: 180 }}>
                            <div style={{ fontSize: 12, color: "#fafaf9", fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}>
                              <span style={{ fontSize: 10, padding: "2px 6px", borderRadius: 3, background: d.kind === 'deal' ? "#4c1d95" : "#1e3a5f", color: d.kind === 'deal' ? "#c4b5fd" : "#93c5fd", fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase" }}>{d.kind}</span>
                              <span>{d.name}</span>
                              <span style={{ fontSize: 10, padding: "1px 6px", borderRadius: 3, background: "#292524", color: scoreColor, fontWeight: 700 }}>{d.score}</span>
                            </div>
                            <div style={{ fontSize: 11, color: "#a8a29e", marginTop: 3, lineHeight: 1.5 }}>
                              {d.kind === 'deal' ? <>ID: <code style={{ color: "#d6d3d1" }}>{d.id}</code></> : <>{d.email}{d.phone && <> · <a href={`tel:${d.phone}`} style={{ color: 'inherit', textDecoration: 'none' }}>{d.phone}</a></>}</>}
                              {d.address && <><br/>{d.address}</>}
                              {d.case_number && <> · Case {d.case_number}</>}
                              {d.county && <> · {d.county} Co.</>}
                              {d.status && <> · <span style={{ color: statusFg(d.status) }}>{d.status}</span></>}
                            </div>
                            <div style={{ marginTop: 4, display: "flex", gap: 4, flexWrap: "wrap" }}>
                              {(d.reasons || []).map(r => (
                                <span key={r} style={{ fontSize: 9, padding: "1px 6px", borderRadius: 3, background: "#292524", color: "#d6a85a", fontWeight: 600 }}>{r.replace(/_/g, ' ')}</span>
                              ))}
                            </div>
                          </div>
                          {d.kind === 'deal' && !l.converted_to_deal_id && (
                            <button onClick={() => linkToExistingDeal(l, d.id, d.name)} disabled={busy} style={{ ...btnPrimary, fontSize: 10, padding: "4px 10px", whiteSpace: "nowrap" }}>Link to this deal</button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  <div style={{ marginTop: 10, display: "flex", gap: 6, justifyContent: "flex-end" }}>
                    {l.status !== 'duplicate' && <button onClick={() => updateStatus(l, 'duplicate')} disabled={busy} style={{ ...btnGhost, fontSize: 10, padding: "3px 10px", color: "#c4b5fd" }}>Mark this lead as duplicate</button>}
                    <button onClick={() => rescanDuplicates(l)} disabled={busy} style={{ ...btnGhost, fontSize: 10, padding: "3px 10px" }}>Re-scan</button>
                  </div>
                </div>
              )}
              {!l.converted_to_deal_id && l.status !== 'rejected' && l.status !== 'spam' && l.status !== 'duplicate' && (
                <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
                  {l.status !== 'contacted' && <button onClick={() => updateStatus(l, 'contacted')} disabled={busy} style={{ ...btnGhost, fontSize: 11 }}>Mark contacted</button>}
                  {l.status !== 'qualified' && <button onClick={() => updateStatus(l, 'qualified')} disabled={busy} style={{ ...btnGhost, fontSize: 11 }}>Qualified</button>}
                  <button onClick={() => convertToDeal(l)} disabled={busy} style={{ ...btnPrimary, fontSize: 11, padding: "5px 12px" }}>Convert to deal</button>
                  <button onClick={() => updateStatus(l, 'rejected')} disabled={busy} style={{ ...btnGhost, fontSize: 11, color: "#f59e0b" }}>Reject</button>
                  <button onClick={() => updateStatus(l, 'spam')} disabled={busy} style={{ ...btnGhost, fontSize: 11, color: "#ef4444" }}>Spam</button>
                </div>
              )}
            </div>
          );})}
        </div>
      )}

      {msg && (
        <div style={{ marginTop: 14, padding: "10px 12px", borderRadius: 6, background: msg.type === 'success' ? "#064e3b" : "#7f1d1d", color: msg.type === 'success' ? "#6ee7b7" : "#fca5a5", fontSize: 12 }}>
          {msg.text}
        </div>
      )}

      <div style={{ marginTop: 16, padding: "10px 12px", background: "#0c0a09", borderRadius: 6, fontSize: 11, color: "#78716c", lineHeight: 1.5 }}>
        Public intake form: <code style={{ color: "#d6d3d1" }}>{window.location.origin + window.location.pathname.replace(/[^/]*$/, '') + 'lead-intake.html'}</code>
      </div>
    </Modal>
  );
}
const statusBg = (s) => ({ new: '#78350f', contacted: '#1e3a5f', qualified: '#4c1d95', signed: '#064e3b', rejected: '#292524', spam: '#7f1d1d', duplicate: '#3b2105' })[s] || '#292524';
const statusFg = (s) => ({ new: '#fbbf24', contacted: '#93c5fd', qualified: '#c4b5fd', signed: '#6ee7b7', rejected: '#a8a29e', spam: '#fca5a5', duplicate: '#d6a85a' })[s] || '#d6d3d1';

// ─── Global Search Modal (⌘K) ─────────────────────────
function SearchModal({ deals, onClose, onSelect }) {
  const [q, setQ] = useState("");
  const inputRef = useRef(null);

  useEffect(() => {
    if (inputRef.current) inputRef.current.focus();
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const query = q.trim().toLowerCase();
  const results = query.length === 0 ? [] : deals.filter(d => {
    const m = d.meta || {};
    const hay = [
      d.name, d.address, d.status,
      m.attorney, m.county, m.courtCase, m.phone, m.email,
      d.lead_source || m.lead_source,
    ].filter(Boolean).map(s => String(s).toLowerCase()).join(' ');
    return hay.includes(query);
  }).slice(0, 30);

  const matchSpan = (text) => {
    if (!query || !text) return text;
    const idx = String(text).toLowerCase().indexOf(query);
    if (idx === -1) return text;
    return <>
      {String(text).slice(0, idx)}
      <span style={{ background: "#fef3c7", color: "#78350f", padding: "0 2px", borderRadius: 2 }}>{String(text).slice(idx, idx + query.length)}</span>
      {String(text).slice(idx + query.length)}
    </>;
  };

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 200, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "80px 20px 20px" }}>
      <div className="search-modal-inner" onClick={e => e.stopPropagation()} style={{ background: "#1c1917", border: "1px solid #44403c", borderRadius: 12, width: "100%", maxWidth: 640, maxHeight: "70vh", overflow: "hidden", boxShadow: "0 20px 60px rgba(0,0,0,0.5)", display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 18px", borderBottom: "1px solid #292524" }}>
          <span style={{ fontSize: 16 }}>🔍</span>
          <input
            ref={inputRef}
            value={q}
            onChange={e => setQ(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && results.length > 0) onSelect(results[0].id); }}
            placeholder="Search deals…"
            style={{ flex: 1, background: "transparent", border: "none", outline: "none", color: "#fafaf9", fontSize: 16, fontFamily: "inherit" }}
          />
          <button onClick={onClose} style={{ background: "transparent", border: "none", color: "#78716c", fontSize: 20, cursor: "pointer", padding: "4px 8px", minHeight: 32 }} aria-label="Close">×</button>
        </div>
        <div style={{ maxHeight: "60vh", overflowY: "auto" }}>
          {query.length === 0 ? (
            <div style={{ padding: 32, textAlign: "center", color: "#78716c", fontSize: 13 }}>
              Start typing to search across every deal.
              <div style={{ marginTop: 12, fontSize: 11 }}>
                Tip: you can search by name, address, attorney name, county, case number, or lead source.
              </div>
            </div>
          ) : results.length === 0 ? (
            <div style={{ padding: 32, textAlign: "center", color: "#78716c", fontSize: 13 }}>
              No matches for <b style={{ color: "#a8a29e" }}>{q}</b>
            </div>
          ) : (
            results.map((d, i) => {
              const m = d.meta || {};
              const typeIcon = d.type === 'flip' ? '🏠' : '💰';
              return (
                <div key={d.id} onClick={() => onSelect(d.id)} style={{
                  display: "flex", alignItems: "center", gap: 12,
                  padding: "12px 18px",
                  borderBottom: "1px solid #1c1917",
                  cursor: "pointer",
                  background: i === 0 ? "#0c0a09" : "transparent",
                }}
                  onMouseEnter={e => e.currentTarget.style.background = "#0c0a09"}
                  onMouseLeave={e => { if (i !== 0) e.currentTarget.style.background = "transparent"; }}
                >
                  <span style={{ fontSize: 18 }}>{typeIcon}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: "#fafaf9" }}>{matchSpan(d.name)}</div>
                    <div style={{ fontSize: 11, color: "#a8a29e", marginTop: 2 }}>
                      {matchSpan(d.address || '—')}
                      {m.county && <> · {matchSpan(m.county)}</>}
                      {m.attorney && <> · {matchSpan(m.attorney)}</>}
                      {m.courtCase && <> · {matchSpan(m.courtCase)}</>}
                    </div>
                  </div>
                  <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 7px", borderRadius: 3, background: "#292524", color: "#a8a29e", letterSpacing: "0.06em", textTransform: "uppercase", whiteSpace: "nowrap" }}>{d.status.replace(/-/g, ' ')}</span>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Team Management Modal (admin only) ─────────────
// ─── Account Settings (Phase 1.5) ────────────────────────────────────
// Each user manages their own profile here: avatar photo, display name,
// phone, password. Display name + avatar drive how they appear in Team
// Chat (and anywhere else profile names are shown).
function AccountSettingsModal({ onClose, userId, userEmail }) {
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [savingProfile, setSavingProfile] = useState(false);
  const [savingPassword, setSavingPassword] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [avatarUrl, setAvatarUrl] = useState(null);
  const [displayName, setDisplayName] = useState('');
  const [phone, setPhone] = useState('');
  const [pw1, setPw1] = useState('');
  const [pw2, setPw2] = useState('');
  const [msg, setMsg] = useState(null);
  const fileRef = useRef(null);

  useEffect(() => {
    (async () => {
      const { data } = await sb.from('profiles').select('*').eq('id', userId).single();
      if (data) {
        setProfile(data);
        setDisplayName(data.display_name || data.name || '');
        setPhone(data.phone || '');
        if (data.avatar_path) {
          const { data: urlData } = sb.storage.from('avatars').getPublicUrl(data.avatar_path);
          setAvatarUrl(urlData?.publicUrl || null);
        }
      }
      setLoading(false);
    })();
  }, [userId]);

  const saveProfile = async () => {
    setSavingProfile(true); setMsg(null);
    const { error } = await sb.from('profiles').update({
      display_name: displayName.trim() || null,
      phone: phone.trim() || null,
    }).eq('id', userId);
    setSavingProfile(false);
    if (error) { setMsg({ kind: 'err', text: error.message }); return; }
    setMsg({ kind: 'ok', text: 'Profile saved.' });
    setTimeout(() => setMsg(null), 3000);
  };

  const onAvatarPick = () => fileRef.current && fileRef.current.click();

  const onAvatarFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setMsg({ kind: 'err', text: 'Please pick an image file.' });
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setMsg({ kind: 'err', text: 'Image too large (max 10 MB).' });
      return;
    }
    setUploadingAvatar(true); setMsg(null);
    try {
      // HEIC → JPEG conversion (iPhone exports). Reuses pattern from JV portal.
      let upload = file;
      if (/heic|heif/i.test(file.type) || /\.(heic|heif)$/i.test(file.name)) {
        if (!window.heic2any) {
          await new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = 'https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js';
            s.onload = resolve; s.onerror = reject;
            document.head.appendChild(s);
          });
        }
        const blob = await window.heic2any({ blob: file, toType: 'image/jpeg', quality: 0.9 });
        upload = new File([Array.isArray(blob) ? blob[0] : blob], file.name.replace(/\.(heic|heif)$/i, '.jpg'), { type: 'image/jpeg' });
      }
      const ext = (upload.name.split('.').pop() || 'jpg').toLowerCase();
      const path = `${userId}/${Date.now()}.${ext}`;
      const { error: upErr } = await sb.storage.from('avatars').upload(path, upload, { upsert: false, cacheControl: '3600' });
      if (upErr) throw upErr;
      // Update profile to point at new path
      await sb.from('profiles').update({ avatar_path: path }).eq('id', userId);
      const { data: urlData } = sb.storage.from('avatars').getPublicUrl(path);
      setAvatarUrl(urlData?.publicUrl + '?t=' + Date.now());
      setProfile(prev => ({ ...prev, avatar_path: path }));
      setMsg({ kind: 'ok', text: 'Avatar updated.' });
      setTimeout(() => setMsg(null), 3000);
    } catch (ex) {
      setMsg({ kind: 'err', text: 'Avatar upload failed: ' + (ex.message || ex) });
    } finally {
      setUploadingAvatar(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const removeAvatar = async () => {
    if (!profile?.avatar_path) return;
    if (!confirm('Remove your avatar photo?')) return;
    await sb.storage.from('avatars').remove([profile.avatar_path]);
    await sb.from('profiles').update({ avatar_path: null }).eq('id', userId);
    setAvatarUrl(null);
    setProfile(prev => ({ ...prev, avatar_path: null }));
    setMsg({ kind: 'ok', text: 'Avatar removed.' });
    setTimeout(() => setMsg(null), 3000);
  };

  const setPassword = async () => {
    if (pw1.length < 8) { setMsg({ kind: 'err', text: 'Password must be at least 8 characters.' }); return; }
    if (pw1 !== pw2)    { setMsg({ kind: 'err', text: 'Passwords don\'t match.' }); return; }
    setSavingPassword(true); setMsg(null);
    const { error } = await sb.auth.updateUser({ password: pw1 });
    setSavingPassword(false);
    if (error) { setMsg({ kind: 'err', text: error.message }); return; }
    setPw1(''); setPw2('');
    setMsg({ kind: 'ok', text: 'Password set. You can now sign in with email + password (magic link still works too).' });
    setTimeout(() => setMsg(null), 5000);
  };

  if (loading) return <Modal onClose={onClose} title="Account Settings"><div style={{ padding: 30, textAlign: 'center', color: '#78716c' }}>Loading…</div></Modal>;

  const initial = (displayName || profile?.name || userEmail || '?').charAt(0).toUpperCase();

  return (
    <Modal onClose={onClose} title="Account Settings">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 24, paddingTop: 4 }}>

        {/* Avatar */}
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#78716c', letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 12 }}>Profile photo</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <div style={{
              width: 72, height: 72, borderRadius: '50%',
              background: avatarUrl ? `center/cover no-repeat url(${avatarUrl})` : '#d97706',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: '#fff', fontSize: 28, fontWeight: 700,
              flexShrink: 0,
            }}>{!avatarUrl && initial}</div>
            <div style={{ flex: 1 }}>
              <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={onAvatarFile} />
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button onClick={onAvatarPick} disabled={uploadingAvatar} style={btnPrimary}>
                  {uploadingAvatar ? 'Uploading…' : (avatarUrl ? 'Change photo' : 'Upload photo')}
                </button>
                {avatarUrl && <button onClick={removeAvatar} style={{ ...btnGhost, color: '#fca5a5' }}>Remove</button>}
              </div>
              <div style={{ fontSize: 11, color: '#78716c', marginTop: 6 }}>
                Shows in Team Chat + everywhere your name appears. iPhone HEICs auto-convert. Max 10 MB.
              </div>
            </div>
          </div>
        </div>

        {/* Profile fields */}
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#78716c', letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 12 }}>Identity</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
            <Field label="Display name (shown to teammates)">
              <input value={displayName} onChange={e => setDisplayName(e.target.value)} style={inputStyle} placeholder="Nathan" />
            </Field>
            <Field label="Email">
              <input value={userEmail || ''} disabled style={{ ...inputStyle, opacity: 0.6, cursor: 'not-allowed' }} />
            </Field>
            <Field label="Phone (for SMS)">
              <input value={phone} onChange={e => setPhone(e.target.value)} style={inputStyle} placeholder="513-555-0100" />
            </Field>
          </div>
          <button onClick={saveProfile} disabled={savingProfile} style={{ ...btnPrimary, marginTop: 12 }}>
            {savingProfile ? 'Saving…' : 'Save profile'}
          </button>
        </div>

        {/* Password */}
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#78716c', letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 4 }}>Password (optional)</div>
          <div style={{ fontSize: 11, color: '#78716c', marginBottom: 12, lineHeight: 1.55 }}>
            Set a password to skip the magic-link email step on future sign-ins. Magic link still works either way.
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
            <Field label="New password">
              <input type="password" value={pw1} onChange={e => setPw1(e.target.value)} style={inputStyle} placeholder="At least 8 characters" autoComplete="new-password" />
            </Field>
            <Field label="Confirm password">
              <input type="password" value={pw2} onChange={e => setPw2(e.target.value)} style={inputStyle} placeholder="Repeat" autoComplete="new-password" />
            </Field>
          </div>
          <button onClick={setPassword} disabled={savingPassword || !pw1 || !pw2} style={{ ...btnPrimary, marginTop: 12 }}>
            {savingPassword ? 'Saving…' : 'Set password'}
          </button>
        </div>

        {msg && (
          <div style={{ padding: '10px 14px', borderRadius: 8, fontSize: 13, fontWeight: 500,
            background: msg.kind === 'err' ? '#7f1d1d22' : '#064e3b22',
            color: msg.kind === 'err' ? '#fca5a5' : '#6ee7b7',
            border: '1px solid ' + (msg.kind === 'err' ? '#7f1d1d' : '#065f46') }}>
            {msg.text}
          </div>
        )}

      </div>
    </Modal>
  );
}

function TeamModal({ onClose, currentUserId }) {
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("va");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [editingName, setEditingName] = useState(null);
  const [editNameVal, setEditNameVal] = useState('');

  const load = async () => {
    setLoading(true);
    const { data, error } = await sb.rpc('admin_get_team_users');
    if (error) {
      setMsg({ type: 'error', text: 'Could not load team: ' + error.message });
      setMembers([]);
    } else {
      setMembers(data || []);
    }
    setLoading(false);
  };

  const sinceLabel = (ts) => {
    if (!ts) return 'Never signed in';
    const ms = Date.now() - new Date(ts).getTime();
    const m = Math.round(ms / 60000);
    if (m < 1) return 'Just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.round(h / 24);
    if (d < 30) return `${d}d ago`;
    const mo = Math.round(d / 30);
    return `${mo}mo ago`;
  };

  const resendMagicLink = async (email) => {
    if (!email) return;
    setBusy(true); setMsg(null);
    try {
      const appUrl = window.location.href.split('?')[0].split('#')[0].replace(/[^/]*$/, '');
      const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: appUrl } });
      if (error) throw error;
      setMsg({ type: 'success', text: `Magic link re-sent to ${email}.` });
    } catch (e) {
      setMsg({ type: 'error', text: e.message });
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => { load(); }, []);

  const updateRole = async (id, role) => {
    setBusy(true); setMsg(null);
    const { error } = await sb.from('profiles').update({ role }).eq('id', id);
    if (error) setMsg({ type: 'error', text: error.message });
    else setMsg({ type: 'success', text: `Role updated.` });
    await load();
    setBusy(false);
  };

  const saveName = async (id) => {
    const trimmed = editNameVal.trim();
    if (!trimmed) return;
    setBusy(true); setMsg(null);
    const { error } = await sb.from('profiles').update({ name: trimmed }).eq('id', id);
    if (error) setMsg({ type: 'error', text: error.message });
    else { setMsg({ type: 'success', text: `Name updated to "${trimmed}".` }); setEditingName(null); }
    await load();
    setBusy(false);
  };

  const invite = async () => {
    if (!inviteEmail) return;
    setBusy(true); setMsg(null);
    try {
      const addr = inviteEmail.trim().toLowerCase();
      const appUrl = window.location.href.split('?')[0].split('#')[0].replace(/[^/]*$/, '');
      const { error } = await sb.auth.signInWithOtp({ email: addr, options: { emailRedirectTo: appUrl } });
      if (error) throw error;
      setMsg({ type: 'success', text: `Magic link sent to ${addr}. When they sign in, their profile will appear below — set their role to "${inviteRole}" then.` });
      setInviteEmail("");
    } catch (e) {
      setMsg({ type: 'error', text: e.message });
    } finally {
      setBusy(false);
    }
  };

  const roleLabel = (r) => {
    return ({
      admin: 'Admin',
      user: 'Admin (legacy)',
      va: 'Virtual Assistant',
      attorney: 'Attorney',
      client: 'Client',
    })[r] || r;
  };
  const roleDesc = (r) => ({
    admin: 'Full access to everything.',
    user: 'Full access (same as Admin). Promote to "admin" to make it explicit.',
    va: 'Can manage deals, tasks, vendors, clients, documents. Cannot see financial data (expenses, fees, profit).',
    attorney: 'Scoped read-only access to cases they\'re assigned to. Cannot see other deals or financials.',
    client: 'Portal-only access to their own case. Cannot access DCC.',
  })[r] || '';

  return (
    <Modal onClose={onClose} title="Team Management" wide>
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: "#78716c", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 10 }}>Invite new team member</div>
        <div style={{ fontSize: 12, color: "#a8a29e", marginBottom: 10, lineHeight: 1.5 }}>
          Sends a sign-in link via email. When the person signs in, a new profile appears below — you then set their role. New profiles default to "Admin" (full access) so promote or demote immediately.
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input type="email" value={inviteEmail} onChange={e => setInviteEmail(e.target.value)} placeholder="teammate@refundlocators.com" style={{ ...inputStyle, flex: 1, minWidth: 220 }} onKeyDown={e => { if (e.key === 'Enter' && inviteEmail) invite(); }} />
          <select value={inviteRole} onChange={e => setInviteRole(e.target.value)} style={{ ...selectStyle, minWidth: 140 }}>
            <option value="va">Virtual Assistant</option>
            <option value="admin">Admin</option>
            <option value="attorney">Attorney</option>
          </select>
          <button onClick={invite} disabled={busy || !inviteEmail} style={btnPrimary}>{busy ? 'Sending…' : 'Send magic link'}</button>
        </div>
      </div>

      <div style={{ fontSize: 11, fontWeight: 700, color: "#78716c", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 10 }}>Current members ({members.length})</div>

      {loading && <div style={{ fontSize: 12, color: "#78716c" }}>Loading…</div>}

      {!loading && members.length === 0 && <div style={{ fontSize: 12, color: "#78716c", fontStyle: "italic" }}>No team members yet.</div>}

      {!loading && members.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {members.map(m => (
            <div key={m.id} style={{ padding: "14px 16px", background: "#0c0a09", border: "1px solid #292524", borderRadius: 8 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
                <div style={{ flex: 1, minWidth: 200 }}>
                  {editingName === m.id ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                      <input
                        autoFocus
                        value={editNameVal}
                        onChange={e => setEditNameVal(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') saveName(m.id); if (e.key === 'Escape') setEditingName(null); }}
                        style={{ background: '#1c1917', border: '1px solid #d97706', borderRadius: 5, color: '#fafaf9', padding: '4px 8px', fontSize: 13, fontFamily: 'inherit', outline: 'none', flex: 1 }}
                      />
                      <button onClick={() => saveName(m.id)} disabled={busy || !editNameVal.trim()}
                        style={{ background: '#d97706', border: 'none', color: '#0c0a09', borderRadius: 5, padding: '4px 10px', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>Save</button>
                      <button onClick={() => setEditingName(null)}
                        style={{ background: 'transparent', border: '1px solid #44403c', color: '#78716c', borderRadius: 5, padding: '4px 8px', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }}>Cancel</button>
                    </div>
                  ) : (
                    <div style={{ fontSize: 14, fontWeight: 700, color: "#fafaf9", display: 'flex', alignItems: 'center', gap: 6 }}>
                      {m.name}
                      {m.id === currentUserId && <span style={{ fontSize: 10, color: "#10b981" }}>(you)</span>}
                      <button
                        onClick={() => { setEditingName(m.id); setEditNameVal(m.name || ''); }}
                        title="Edit name"
                        style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: '0 2px', fontSize: 13, lineHeight: 1, color: '#57534e', opacity: 0.7 }}>
                        ✏️
                      </button>
                    </div>
                  )}
                  <div style={{ fontSize: 11, color: "#a8a29e", marginTop: 6, lineHeight: 1.4 }}>{roleDesc(m.role)}</div>
                  <div style={{ fontSize: 11, color: "#78716c", marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                    {m.email && <span style={{ fontFamily: 'monospace' }}>{m.email}</span>}
                    {m.email && <span style={{ color: '#44403c' }}>·</span>}
                    <span title={m.last_sign_in_at ? new Date(m.last_sign_in_at).toLocaleString() : 'Never signed in'}>
                      {sinceLabel(m.last_sign_in_at)}
                    </span>
                    <span style={{ color: '#44403c' }}>·</span>
                    {m.has_password ? (
                      <span style={{ color: '#10b981', fontWeight: 600 }} title="Password is set — can sign in directly with email + password">✅ password set</span>
                    ) : m.last_sign_in_at ? (
                      <span style={{ color: '#fbbf24', fontWeight: 600 }} title="No password — sign in via magic link only">📧 magic-link only</span>
                    ) : (
                      <span style={{ color: '#a8a29e', fontWeight: 600 }} title="Invited but has not signed in yet">⏳ never signed in</span>
                    )}
                    {!m.email_confirmed_at && (
                      <span style={{ color: '#fca5a5', fontWeight: 600 }} title="Email address has not been confirmed">⚠ unconfirmed</span>
                    )}
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: 'wrap' }}>
                  {m.email && m.id !== currentUserId && (
                    <button
                      onClick={() => resendMagicLink(m.email)}
                      disabled={busy}
                      title={`Send a fresh magic link to ${m.email}`}
                      style={{ ...btnGhost, fontSize: 11, padding: '6px 10px', whiteSpace: 'nowrap' }}
                    >
                      📧 Resend link
                    </button>
                  )}
                  <select
                    value={m.role || 'user'}
                    onChange={e => updateRole(m.id, e.target.value)}
                    disabled={busy || m.id === currentUserId}
                    style={{ ...selectStyle, fontSize: 12, minWidth: 140 }}
                    title={m.id === currentUserId ? "You can't change your own role" : undefined}
                  >
                    <option value="admin">Admin</option>
                    <option value="user">Admin (legacy)</option>
                    <option value="va">Virtual Assistant</option>
                    <option value="attorney">Attorney</option>
                    <option value="client">Client</option>
                  </select>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {msg && (
        <div style={{ marginTop: 14, padding: "10px 12px", borderRadius: 6, background: msg.type === 'success' ? "#064e3b" : "#7f1d1d", color: msg.type === 'success' ? "#6ee7b7" : "#fca5a5", fontSize: 12 }}>
          {msg.text}
        </div>
      )}
    </Modal>
  );
}

function ActivityLogModal({ onClose, onJumpToDeal }) {
  const [items, setItems] = useState([]);
  const [filter, setFilter] = useState("all");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const { data } = await sb.from('activity').select('*, profiles(name), deals(name)').order('created_at', { ascending: false }).limit(500);
      setItems(data || []);
      setLoading(false);
    })();
  }, []);

  const people = Array.from(new Set(items.map(i => i.profiles?.name || "Unknown"))).sort();
  const filtered = filter === "all" ? items : items.filter(i => (i.profiles?.name || "Unknown") === filter);

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: "#1c1917", border: "1px solid #292524", borderRadius: 12, width: "100%", maxWidth: 820, maxHeight: "85vh", display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "18px 22px", borderBottom: "1px solid #292524", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16 }}>
          <div>
            <div style={{ fontSize: 11, color: "#d97706", fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase" }}>Team Log</div>
            <div style={{ fontSize: 18, fontWeight: 700, marginTop: 2 }}>All Activity</div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <select value={filter} onChange={e => setFilter(e.target.value)} style={{ background: "#0c0a09", border: "1px solid #44403c", color: "#fafaf9", padding: "6px 10px", borderRadius: 6, fontSize: 12 }}>
              <option value="all">All team members ({items.length})</option>
              {people.map(p => <option key={p} value={p}>{p} ({items.filter(i => (i.profiles?.name || "Unknown") === p).length})</option>)}
            </select>
            <button onClick={onClose} style={{ background: "transparent", border: "1px solid #44403c", color: "#a8a29e", padding: "6px 12px", borderRadius: 6, fontSize: 12, fontWeight: 600 }}>Close</button>
          </div>
        </div>
        <div style={{ overflowY: "auto", padding: "10px 22px 22px" }}>
          {loading ? (
            <div style={{ textAlign: "center", color: "#78716c", padding: 40 }}>Loading…</div>
          ) : filtered.length === 0 ? (
            <div style={{ textAlign: "center", color: "#78716c", padding: 40 }}>No activity yet.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {filtered.map(a => {
                const who = a.profiles?.name || "Unknown";
                return (
                  <div key={a.id} onClick={() => a.deal_id && onJumpToDeal(a.deal_id)} style={{ padding: "10px 12px", background: "#0c0a09", border: "1px solid #292524", borderRadius: 6, display: "flex", gap: 12, alignItems: "center", cursor: a.deal_id ? "pointer" : "default" }}>
                    <span style={{ padding: "2px 8px", background: personColor(who), color: "#fafaf9", borderRadius: 4, fontSize: 10, fontWeight: 700, minWidth: 70, textAlign: "center" }}>{who}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13 }}>{a.action}</div>
                      {a.deals?.name && <div style={{ fontSize: 11, color: "#78716c", marginTop: 2 }}>on {a.deals.name} →</div>}
                    </div>
                    <span style={{ fontSize: 10, color: "#78716c", fontFamily: "'DM Mono', monospace", whiteSpace: "nowrap" }}>{new Date(a.created_at).toLocaleString()}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Contacts / CRM (Phase 2) ────────────────────────────────────────
// Family/case-side kinds first (what you're tagging on a deal), then
// business-side kinds (attorneys, title co., investors, etc.), then Other.
// When kind === 'other', contacts.kind_other holds a free-text label that
// replaces the generic "Other" pill in all display surfaces.
const CONTACT_KINDS = [
  { key: 'homeowner',       label: 'Homeowner',  icon: '🏠' },
  { key: 'spouse',          label: 'Spouse',     icon: '💑' },
  { key: 'child',           label: 'Child',      icon: '🧒' },
  { key: 'sibling',         label: 'Sibling',    icon: '👫' },
  { key: 'family',          label: 'Family',     icon: '👨‍👩‍👧' },
  { key: 'neighbor',        label: 'Neighbor',   icon: '🏘' },
  { key: 'attorney',        label: 'Attorney',   icon: '⚖' },
  { key: 'title_company',   label: 'Title Co.',  icon: '🏢' },
  { key: 'investor',        label: 'Investor',   icon: '💵' },
  { key: 'referral_source', label: 'Referral',   icon: '🤝' },
  { key: 'partner',         label: 'Partner',    icon: '🧭' },
  { key: 'vendor',          label: 'Vendor',     icon: '🔧' },
  { key: 'other',           label: 'Other',      icon: '👤' },
];
// Helpers accept either a kind string or a full contact object. When given
// a contact with kind='other' and a kind_other label, kindLabel returns
// that custom text instead of the generic "Other".
const kindMeta = (contactOrKind) => {
  const kind = typeof contactOrKind === 'string' ? contactOrKind : contactOrKind?.kind;
  return CONTACT_KINDS.find(x => x.key === kind) || CONTACT_KINDS[CONTACT_KINDS.length - 1];
};
const kindLabel = (contactOrKind) => {
  const meta = kindMeta(contactOrKind);
  if (meta.key === 'other' && typeof contactOrKind === 'object' && contactOrKind?.kind_other) {
    return contactOrKind.kind_other;
  }
  return meta.label;
};
const kindIcon  = (contactOrKind) => kindMeta(contactOrKind).icon;

// Partner Attorney directory — surfaces attorneys Castle has discovered on
// monitored dockets that aren't yet in `contacts`. Renders inside ContactsModal
// when filter is 'all' or 'attorney'. One-click promotion to contacts row +
// auto-link to the deals where Castle saw them. Per CLAUDE.md: contacts →
// attorney_assignments sync via trigger, so promoting also gives the attorney
// portal access to those deals.
function AttorneyDirectoryFromDockets({ contacts, onPromoted, userId }) {
  const [discovered, setDiscovered] = useState(null);
  const [busy, setBusy] = useState(null);
  const [msg, setMsg] = useState(null);

  const load = async () => {
    // Pull every docket event Castle has tagged with attorney_appearance.
    const { data: events } = await sb.from('docket_events')
      .select('deal_id, event_date, attorney_appearance')
      .not('attorney_appearance', 'is', null);
    if (!events) { setDiscovered([]); return; }

    // Group by canonicalized attorney name + firm
    const byKey = new Map();
    for (const e of events) {
      const ap = e.attorney_appearance || {};
      const name = (ap.attorney_name || '').trim();
      if (!name) continue;
      const firm = (ap.firm_name || '').trim();
      const key = (name + '|' + firm).toLowerCase();
      const cur = byKey.get(key) || { attorney_name: name, firm_name: firm, role: ap.role, bar_number: ap.bar_number, count: 0, deal_ids: new Set(), latest_event_date: null };
      cur.count++;
      if (e.deal_id) cur.deal_ids.add(e.deal_id);
      if (!cur.latest_event_date || e.event_date > cur.latest_event_date) cur.latest_event_date = e.event_date;
      byKey.set(key, cur);
    }

    // Filter out attorneys already in contacts (case-insensitive name match).
    const existingNames = new Set((contacts || [])
      .filter(c => c.kind === 'attorney')
      .map(c => (c.name || '').trim().toLowerCase()));

    const list = [...byKey.values()]
      .filter(a => !existingNames.has(a.attorney_name.toLowerCase()))
      .map(a => ({ ...a, deal_ids: [...a.deal_ids] }))
      .sort((a, b) => b.count - a.count);

    setDiscovered(list);
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [contacts]);

  const promote = async (a) => {
    if (busy) return;
    setBusy(a.attorney_name); setMsg(null);
    try {
      // 1. Create the contact
      const notes = `Discovered via docket. Seen ${a.count} time${a.count === 1 ? '' : 's'} on ${a.deal_ids.length} deal${a.deal_ids.length === 1 ? '' : 's'}. Latest: ${a.latest_event_date}.${a.bar_number ? ` Bar #${a.bar_number}.` : ''}${a.role ? ` Role: ${String(a.role).replace(/_/g, ' ')}.` : ''}`;
      const { data: contact, error: cErr } = await sb.from('contacts').insert({
        name: a.attorney_name,
        company: a.firm_name || null,
        kind: 'attorney',
        notes,
        tags: ['from-docket'],
        owner_id: userId,
      }).select().single();
      if (cErr) throw cErr;
      // 2. Link to each deal Castle saw them on. attorney_assignments auto-syncs via trigger.
      if (contact && a.deal_ids.length > 0) {
        const links = a.deal_ids.map(deal_id => ({
          contact_id: contact.id,
          deal_id,
          relationship: a.role ? String(a.role).replace(/_/g, ' ') : 'attorney',
        }));
        await sb.from('contact_deals').insert(links);
      }
      setMsg({ type: 'success', text: `Added ${a.attorney_name} to Contacts + linked to ${a.deal_ids.length} deal${a.deal_ids.length === 1 ? '' : 's'}` });
      if (onPromoted) onPromoted();
    } catch (e) {
      setMsg({ type: 'error', text: e.message });
    } finally {
      setBusy(null);
    }
  };

  if (discovered === null) return null;
  if (discovered.length === 0) return null;

  return (
    <div style={{ marginBottom: 16, padding: '14px 16px', background: '#1c1917', border: '1px solid #92400e', borderLeft: '3px solid #d97706', borderRadius: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#fbbf24', letterSpacing: '0.12em', textTransform: 'uppercase' }}>
            👨‍⚖️ Attorneys discovered on dockets · {discovered.length} new
          </div>
          <div style={{ fontSize: 11, color: '#a8a29e', marginTop: 4, lineHeight: 1.5 }}>
            Castle saw these attorneys filing on cases you're monitoring. Add any of them to Contacts to start tracking — promotes to <code style={{ color: '#fbbf24' }}>kind=attorney</code> + auto-links to the deals where they appeared.
          </div>
        </div>
      </div>
      {msg && (
        <div style={{ padding: '6px 10px', borderRadius: 5, marginBottom: 10, fontSize: 12, background: msg.type === 'success' ? '#14532d' : '#7f1d1d', color: msg.type === 'success' ? '#bbf7d0' : '#fecaca' }}>{msg.text}</div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {discovered.map(a => (
          <div key={a.attorney_name + '|' + a.firm_name} style={{ padding: '10px 12px', background: '#0c0a09', border: '1px solid #292524', borderRadius: 6, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 200 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#fafaf9' }}>
                {a.attorney_name}
                {a.firm_name && <span style={{ color: '#78716c', fontWeight: 500 }}> · {a.firm_name}</span>}
              </div>
              <div style={{ fontSize: 11, color: '#a8a29e', marginTop: 3, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                {a.role && <span style={{ textTransform: 'capitalize' }}>{String(a.role).replace(/_/g, ' ')}</span>}
                {a.bar_number && <span>Bar #{a.bar_number}</span>}
                <span style={{ color: '#78716c' }}>· seen {a.count}× on {a.deal_ids.length} deal{a.deal_ids.length === 1 ? '' : 's'}</span>
                <span style={{ color: '#78716c', fontFamily: "'DM Mono', monospace" }}>· latest {a.latest_event_date}</span>
              </div>
            </div>
            <button
              onClick={() => promote(a)}
              disabled={busy !== null}
              style={{ ...btnGhost, fontSize: 11, padding: '6px 12px', borderColor: '#92400e', color: '#fbbf24', cursor: busy ? 'wait' : 'pointer', whiteSpace: 'nowrap' }}>
              {busy === a.attorney_name ? '⏳ Adding…' : '+ Add to Contacts'}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function ContactsModal({ onClose, isAdmin, userId, deals, onJumpToDeal }) {
  const [contacts, setContacts]   = useState([]);
  const [loading, setLoading]     = useState(true);
  const [searchQ, setSearchQ]     = useState('');
  const [kindFilter, setKindFilter] = useState('all');
  const [mode, setMode]           = useState('list');   // 'list' | 'edit'
  const [editing, setEditing]     = useState(null);
  const [busy, setBusy]           = useState(false);
  const [msg, setMsg]             = useState(null);

  const load = async () => {
    setLoading(true);
    const { data } = await sb.from('contacts').select('*').order('name');
    setContacts(data || []);
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  // Realtime so parallel admin edits sync
  useEffect(() => {
    const ch = sb.channel('contacts-modal-ch')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'contacts' }, load)
      .subscribe();
    return () => { sb.removeChannel(ch); };
  }, []);

  const filtered = contacts.filter(c => {
    if (kindFilter !== 'all' && c.kind !== kindFilter) return false;
    if (!searchQ) return true;
    const q = searchQ.toLowerCase();
    return (c.name || '').toLowerCase().includes(q)
        || (c.company || '').toLowerCase().includes(q)
        || (c.email || '').toLowerCase().includes(q)
        || (c.phone || '').toLowerCase().includes(q)
        || (c.tags || []).some(t => (t || '').toLowerCase().includes(q));
  });

  const openNew = () => {
    setEditing({ id: null, name: '', company: '', email: '', phone: '', kind: 'other', tags: [], notes: '', financial_notes: '' });
    setMode('edit');
  };
  const openEdit = (c) => {
    setEditing({ ...c, tags: c.tags || [] });
    setMode('edit');
  };

  const saveContact = async (c) => {
    setBusy(true); setMsg(null);
    const patch = {
      name: c.name, company: c.company || null, email: c.email || null, phone: c.phone || null,
      kind: c.kind || 'other',
      kind_other: c.kind === 'other' ? ((c.kind_other || '').trim() || null) : null,
      tags: c.tags || [], notes: c.notes || null,
    };
    if (isAdmin) patch.financial_notes = c.financial_notes || null;
    if (c.id) {
      const { error } = await sb.from('contacts').update(patch).eq('id', c.id);
      if (error) setMsg({ type: 'error', text: error.message });
      else setMsg({ type: 'success', text: 'Saved' });
    } else {
      patch.owner_id = userId;
      const { data, error } = await sb.from('contacts').insert(patch).select().single();
      if (error) setMsg({ type: 'error', text: error.message });
      else { setEditing({ ...data, tags: data.tags || [] }); setMsg({ type: 'success', text: 'Contact created — now link them to deals below' }); }
    }
    await load();
    setBusy(false);
  };

  const deleteContact = async (c) => {
    if (!window.confirm(`Delete ${c.name}? This also removes all deal links.`)) return;
    setBusy(true); setMsg(null);
    const { error } = await sb.from('contacts').delete().eq('id', c.id);
    if (error) setMsg({ type: 'error', text: error.message });
    else { setMsg({ type: 'success', text: 'Deleted' }); setMode('list'); setEditing(null); }
    await load();
    setBusy(false);
  };

  return (
    <Modal onClose={onClose} title={mode === 'edit' ? (editing?.id ? 'Edit Contact' : 'New Contact') : 'Contacts · CRM'} wide>
      {msg && (
        <div style={{ padding: "8px 12px", borderRadius: 6, marginBottom: 14, fontSize: 12,
          background: msg.type === 'error' ? "#7f1d1d" : "#14532d",
          color: msg.type === 'error' ? "#fecaca" : "#bbf7d0" }}>{msg.text}</div>
      )}

      {mode === 'list' && (
        <>
          <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap", alignItems: "center" }}>
            <input value={searchQ} onChange={e => setSearchQ(e.target.value)}
              placeholder="Search name, company, email, tag…"
              style={{ ...inputStyle, maxWidth: 320, flex: 1, minWidth: 200 }} />
            <select value={kindFilter} onChange={e => setKindFilter(e.target.value)}
              style={{ ...selectStyle, minWidth: 150 }}>
              <option value="all">All types ({contacts.length})</option>
              {CONTACT_KINDS.map(k => {
                const n = contacts.filter(c => c.kind === k.key).length;
                return <option key={k.key} value={k.key}>{k.icon} {k.label} ({n})</option>;
              })}
            </select>
            <button onClick={openNew} style={{ ...btnPrimary, marginLeft: "auto" }}>+ New Contact</button>
          </div>

          {(kindFilter === 'all' || kindFilter === 'attorney') && (
            <AttorneyDirectoryFromDockets contacts={contacts} userId={userId} onPromoted={load} />
          )}

          {loading && <div style={{ fontSize: 12, color: "#78716c" }}>Loading…</div>}
          {!loading && filtered.length === 0 && (
            <div style={{ fontSize: 13, color: "#78716c", padding: 32, textAlign: "center", fontStyle: "italic", border: "1px dashed #292524", borderRadius: 8 }}>
              {contacts.length === 0
                ? "No contacts yet. Click + New Contact to add your first one — partner attorneys, title companies, investors, referral sources, anyone you'd otherwise track in a spreadsheet."
                : "No contacts match those filters."}
            </div>
          )}
          {!loading && filtered.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {filtered.map(c => (
                <div key={c.id} onClick={() => openEdit(c)} style={{
                  padding: "12px 14px", background: "#0c0a09", border: "1px solid #292524",
                  borderRadius: 8, cursor: "pointer", display: "flex", alignItems: "center", gap: 12,
                }}>
                  <div style={{ fontSize: 20, opacity: 0.8 }}>{kindIcon(c)}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 700 }}>
                      {c.name}
                      {c.company && <span style={{ color: "#78716c", fontWeight: 500 }}> · {c.company}</span>}
                    </div>
                    <div style={{ fontSize: 11, color: "#a8a29e", marginTop: 2 }}>
                      {c.email || '—'}{c.phone && <> · <a href={`tel:${c.phone}`} style={{ color: 'inherit', textDecoration: 'none' }}>{c.phone}</a></>}
                    </div>
                    {(c.tags || []).length > 0 && (
                      <div style={{ fontSize: 10, color: "#78716c", marginTop: 4, display: "flex", gap: 6, flexWrap: "wrap" }}>
                        {c.tags.map(t => <span key={t} style={{ padding: "1px 7px", border: "1px solid #292524", borderRadius: 3 }}>{t}</span>)}
                      </div>
                    )}
                  </div>
                  <span style={{ fontSize: 10, color: "#57534e", textTransform: "uppercase", letterSpacing: "0.06em" }}>{kindLabel(c)}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {mode === 'edit' && editing && (
        <ContactEditor
          contact={editing}
          isAdmin={isAdmin}
          userId={userId}
          deals={deals}
          busy={busy}
          onJumpToDeal={onJumpToDeal}
          onChange={(patch) => setEditing(prev => ({ ...prev, ...patch }))}
          onSave={(updated) => saveContact(updated)}
          onDelete={() => deleteContact(editing)}
          onBack={() => { setMode('list'); setEditing(null); setMsg(null); }}
        />
      )}
    </Modal>
  );
}

function ContactEditor({ contact, isAdmin, userId, deals, busy, onChange, onSave, onDelete, onBack, onJumpToDeal }) {
  const [tagsInput, setTagsInput] = useState((contact.tags || []).join(', '));
  const [links, setLinks]         = useState([]);
  const [linkLoading, setLinkLoading] = useState(false);
  const [linkPicker, setLinkPicker]   = useState('');
  const [relPicker, setRelPicker]     = useState('');

  const loadLinks = async () => {
    if (!contact.id) { setLinks([]); return; }
    setLinkLoading(true);
    const { data } = await sb.from('contact_deals')
      .select('id, relationship, deal_id, created_at, deals(id, name, type, status)')
      .eq('contact_id', contact.id)
      .order('created_at', { ascending: false });
    setLinks(data || []);
    setLinkLoading(false);
  };

  useEffect(() => { loadLinks(); }, [contact.id]);

  const addLink = async () => {
    if (!linkPicker || !contact.id) return;
    await sb.from('contact_deals').insert({
      contact_id: contact.id, deal_id: linkPicker,
      relationship: relPicker || null, created_by: userId,
    });
    setLinkPicker(''); setRelPicker('');
    await loadLinks();
  };

  const removeLink = async (id) => {
    if (!window.confirm("Unlink this deal from this contact?")) return;
    await sb.from('contact_deals').delete().eq('id', id);
    await loadLinks();
  };

  const handleSave = () => {
    const finalTags = tagsInput.split(',').map(s => s.trim()).filter(Boolean);
    const finalKindOther = contact.kind === 'other'
      ? ((contact.kind_other || '').trim() || null)
      : null;
    onSave({ ...contact, tags: finalTags, kind_other: finalKindOther });
  };

  const unlinkedDeals = (deals || []).filter(d => !links.some(l => l.deal_id === d.id));

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
        <button onClick={onBack} style={{ ...btnGhost, fontSize: 11 }}>← Back</button>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          {contact.id && <button onClick={onDelete} disabled={busy} style={{ ...btnGhost, color: "#ef4444", borderColor: "#7f1d1d", fontSize: 11 }}>Delete</button>}
          <button onClick={handleSave} disabled={busy || !contact.name} style={btnPrimary}>{busy ? 'Saving…' : (contact.id ? 'Save' : 'Create contact')}</button>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Field label="Name *"><input value={contact.name || ''} onChange={e => onChange({ name: e.target.value })} style={inputStyle} placeholder="Full name" /></Field>
        <Field label="Company"><input value={contact.company || ''} onChange={e => onChange({ company: e.target.value })} style={inputStyle} /></Field>
        <Field label="Email"><input type="email" value={contact.email || ''} onChange={e => onChange({ email: e.target.value })} style={inputStyle} /></Field>
        <Field label="Phone"><input value={contact.phone || ''} onChange={e => onChange({ phone: e.target.value })} style={inputStyle} /></Field>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 12, marginTop: 12 }}>
        <Field label="Type">
          <select value={contact.kind || 'other'} onChange={e => onChange({ kind: e.target.value, ...(e.target.value !== 'other' ? { kind_other: null } : {}) })} style={{ ...inputStyle, padding: "8px 10px" }}>
            {CONTACT_KINDS.map(k => <option key={k.key} value={k.key}>{k.icon} {k.label}</option>)}
          </select>
        </Field>
        <Field label="Tags (comma-separated)">
          <input value={tagsInput} onChange={e => setTagsInput(e.target.value)}
            placeholder="e.g. ohio, franklin-county, defender-referral"
            style={inputStyle} />
        </Field>
      </div>

      {contact.kind === 'other' && (
        <Field label="Describe type *" style={{ marginTop: 12 }}>
          <input value={contact.kind_other || ''} onChange={e => onChange({ kind_other: e.target.value })}
            placeholder="e.g. Church friend, probate administrator, court clerk…"
            style={inputStyle} />
        </Field>
      )}

      <Field label="Notes" style={{ marginTop: 12 }}>
        <textarea value={contact.notes || ''} onChange={e => onChange({ notes: e.target.value })}
          rows={4} placeholder="How we met, strengths, anything the team should know…"
          style={{ ...inputStyle, fontFamily: "inherit", resize: "vertical" }} />
      </Field>

      {isAdmin && (
        <Field label="💰 Financial notes (admin-only — commercial terms, splits, referral fees)" style={{ marginTop: 12 }}>
          <textarea value={contact.financial_notes || ''} onChange={e => onChange({ financial_notes: e.target.value })}
            rows={3} placeholder="e.g. 70/30 on flips, $2k/referral, paid Q1 2026…"
            style={{ ...inputStyle, fontFamily: "inherit", resize: "vertical", borderColor: "#78350f", background: "#1f1408" }} />
        </Field>
      )}

      {contact.id && (
        <div style={{ marginTop: 20, paddingTop: 20, borderTop: "1px solid #292524" }}>
          <div style={{ fontSize: 11, color: "#78716c", fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 10 }}>
            Linked deals ({links.length})
          </div>

          {linkLoading ? (
            <div style={{ fontSize: 12, color: "#78716c" }}>Loading links…</div>
          ) : links.length === 0 ? (
            <div style={{ fontSize: 12, color: "#78716c", fontStyle: "italic", marginBottom: 10 }}>
              Not linked to any deal yet.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 14 }}>
              {links.map(l => (
                <div key={l.id} style={{ padding: "8px 12px", background: "#0c0a09", border: "1px solid #292524", borderRadius: 6, display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{ flex: 1, minWidth: 0, cursor: onJumpToDeal ? "pointer" : "default" }} onClick={() => onJumpToDeal && onJumpToDeal(l.deal_id)}>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>
                      {l.deals?.name || l.deal_id}
                      {onJumpToDeal && <span style={{ marginLeft: 6, fontSize: 10, color: "#78716c" }}>→</span>}
                    </div>
                    <div style={{ fontSize: 10, color: "#78716c" }}>
                      {l.deals?.type} · {(l.deals?.status || '').replace(/-/g, ' ')}
                      {l.relationship && <> · {l.relationship}</>}
                    </div>
                  </div>
                  <button onClick={() => removeLink(l.id)} style={{ ...btnGhost, fontSize: 10, padding: "3px 10px" }}>Unlink</button>
                </div>
              ))}
            </div>
          )}

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
            <Field label="Link to deal" style={{ flex: 1, minWidth: 220 }}>
              <select value={linkPicker} onChange={e => setLinkPicker(e.target.value)} style={{ ...inputStyle, padding: "8px 10px" }}>
                <option value="">— pick a deal —</option>
                {unlinkedDeals.map(d => <option key={d.id} value={d.id}>{d.name} ({d.id})</option>)}
              </select>
            </Field>
            <Field label="Relationship (optional)" style={{ flex: 1, minWidth: 180 }}>
              <input value={relPicker} onChange={e => setRelPicker(e.target.value)} placeholder="e.g. attorney of record" style={inputStyle} />
            </Field>
            <button onClick={addLink} disabled={!linkPicker} style={btnPrimary}>+ Link</button>
          </div>
        </div>
      )}

      {!contact.id && (
        <div style={{ marginTop: 18, padding: 12, background: "#0c0a09", border: "1px dashed #292524", borderRadius: 6, fontSize: 11, color: "#78716c" }}>
          Save this contact first, then you can link them to one or more deals below.
        </div>
      )}
    </div>
  );
}

function ContactsTab({ dealId, userId, isAdmin }) {
  const [links, setLinks]             = useState([]);
  const [loading, setLoading]         = useState(true);
  const [allContacts, setAllContacts] = useState([]);
  const [showAdd, setShowAdd]         = useState(false);
  const [pick, setPick]               = useState('');
  const [rel, setRel]                 = useState('');
  const [showQuickNew, setShowQuickNew] = useState(false);
  const [quickNew, setQuickNew]       = useState({ name: '', company: '', email: '', phone: '', kind: 'other', kind_other: '', notes: '' });
  const [busy, setBusy]               = useState(false);
  const [err, setErr]                 = useState(null);
  const [editingLinkId, setEditingLinkId] = useState(null);
  const [editDraft, setEditDraft]     = useState(null);

  const load = async () => {
    setLoading(true);
    const [linksRes, contactsRes] = await Promise.all([
      sb.from('contact_deals')
        .select('id, relationship, deal_id, contact_id, created_at, contacts(id, name, company, email, phone, kind, kind_other, tags)')
        .eq('deal_id', dealId)
        .order('created_at', { ascending: false }),
      sb.from('contacts').select('id, name, company, kind, kind_other, email').order('name'),
    ]);
    setLinks(linksRes.data || []);
    setAllContacts(contactsRes.data || []);
    setLoading(false);
  };

  useEffect(() => { load(); }, [dealId]);

  useEffect(() => {
    const ch = sb.channel('contacts-tab-' + dealId)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'contact_deals', filter: `deal_id=eq.${dealId}` }, load)
      .subscribe();
    return () => { sb.removeChannel(ch); };
  }, [dealId]);

  const addExisting = async () => {
    if (!pick) return;
    setBusy(true); setErr(null);
    const { error } = await sb.from('contact_deals').insert({ contact_id: pick, deal_id: dealId, relationship: rel || null, created_by: userId });
    if (error) setErr(error.message);
    setPick(''); setRel(''); setShowAdd(false);
    await load();
    setBusy(false);
  };

  const unlink = async (id) => {
    if (!window.confirm("Unlink this contact from this deal?")) return;
    await sb.from('contact_deals').delete().eq('id', id);
    await load();
  };

  const createAndLink = async () => {
    if (!quickNew.name) return;
    if (quickNew.kind === 'other' && !(quickNew.kind_other || '').trim()) {
      setErr('Describe the "Other" type before saving.'); return;
    }
    setBusy(true); setErr(null);
    const { data: c, error } = await sb.from('contacts').insert({
      name: quickNew.name, company: quickNew.company || null, email: quickNew.email || null,
      phone: quickNew.phone || null, kind: quickNew.kind || 'other',
      kind_other: quickNew.kind === 'other' ? (quickNew.kind_other || '').trim() || null : null,
      notes: quickNew.notes || null,
      owner_id: userId,
    }).select().single();
    if (error) { setErr(error.message); setBusy(false); return; }
    const linkErr = (await sb.from('contact_deals').insert({ contact_id: c.id, deal_id: dealId, relationship: rel || null, created_by: userId })).error;
    if (linkErr) setErr(linkErr.message);
    setQuickNew({ name: '', company: '', email: '', phone: '', kind: 'other', kind_other: '', notes: '' });
    setShowQuickNew(false); setRel('');
    await load();
    setBusy(false);
  };

  const startEdit = (link) => {
    const c = link.contacts || {};
    setEditDraft({
      name: c.name || '', company: c.company || '', email: c.email || '',
      phone: c.phone || '', kind: c.kind || 'other', kind_other: c.kind_other || '',
      relationship: link.relationship || '',
    });
    setEditingLinkId(link.id);
    setErr(null);
  };
  const cancelEdit = () => { setEditingLinkId(null); setEditDraft(null); setErr(null); };
  const saveEdit = async (link) => {
    if (!editDraft || busy) return;
    if (!editDraft.name.trim()) { setErr('Name required'); return; }
    if (editDraft.kind === 'other' && !editDraft.kind_other.trim()) {
      setErr('Describe the "Other" type before saving.'); return;
    }
    setBusy(true); setErr(null);
    const contactPatch = {
      name: editDraft.name.trim(),
      company: editDraft.company.trim() || null,
      email: editDraft.email.trim() || null,
      phone: editDraft.phone.trim() || null,
      kind: editDraft.kind,
      kind_other: editDraft.kind === 'other' ? editDraft.kind_other.trim() || null : null,
    };
    const { error: cErr } = await sb.from('contacts').update(contactPatch).eq('id', link.contact_id);
    if (cErr) { setErr(cErr.message); setBusy(false); return; }
    const { error: lErr } = await sb.from('contact_deals').update({ relationship: editDraft.relationship.trim() || null }).eq('id', link.id);
    if (lErr) { setErr(lErr.message); setBusy(false); return; }
    await load();
    setEditingLinkId(null); setEditDraft(null);
    setBusy(false);
  };

  const linkedIds = new Set(links.map(l => l.contact_id));
  const unlinkedContacts = allContacts.filter(c => !linkedIds.has(c.id));

  return (
    <div>
      {err && (
        <div style={{ padding: "8px 12px", borderRadius: 6, marginBottom: 14, fontSize: 12, background: "#7f1d1d", color: "#fecaca" }}>{err}</div>
      )}
      {loading ? (
        <div style={{ fontSize: 12, color: "#78716c", padding: 20 }}>Loading contacts…</div>
      ) : (
        <>
          {links.length === 0 ? (
            <div style={{ fontSize: 13, color: "#78716c", padding: 32, textAlign: "center", fontStyle: "italic", border: "1px dashed #292524", borderRadius: 8, marginBottom: 16 }}>
              No contacts linked to this deal yet. Link the attorney, title company, referral source, or anyone else tied to this case.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 16 }}>
              {links.map(l => {
                if (editingLinkId === l.id && editDraft) {
                  return (
                    <div key={l.id} style={{ padding: 14, background: "#0c0a09", border: "1px solid #44403c", borderRadius: 8 }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: "#d97706", letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 10 }}>Editing contact</div>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                        <Field label="Name *"><input value={editDraft.name} onChange={e => setEditDraft(d => ({ ...d, name: e.target.value }))} style={inputStyle} /></Field>
                        <Field label="Company"><input value={editDraft.company} onChange={e => setEditDraft(d => ({ ...d, company: e.target.value }))} style={inputStyle} /></Field>
                        <Field label="Email"><input type="email" value={editDraft.email} onChange={e => setEditDraft(d => ({ ...d, email: e.target.value }))} style={inputStyle} /></Field>
                        <Field label="Phone"><input value={editDraft.phone} onChange={e => setEditDraft(d => ({ ...d, phone: e.target.value }))} style={inputStyle} /></Field>
                        <Field label="Type">
                          <select value={editDraft.kind} onChange={e => setEditDraft(d => ({ ...d, kind: e.target.value, ...(e.target.value !== 'other' ? { kind_other: '' } : {}) }))} style={{ ...inputStyle, padding: "8px 10px" }}>
                            {CONTACT_KINDS.map(k => <option key={k.key} value={k.key}>{k.icon} {k.label}</option>)}
                          </select>
                        </Field>
                        <Field label="Relationship on this deal"><input value={editDraft.relationship} onChange={e => setEditDraft(d => ({ ...d, relationship: e.target.value }))} placeholder="e.g. son of homeowner, attorney of record" style={inputStyle} /></Field>
                      </div>
                      {editDraft.kind === 'other' && (
                        <Field label="Describe type *" style={{ marginTop: 10 }}>
                          <input value={editDraft.kind_other} onChange={e => setEditDraft(d => ({ ...d, kind_other: e.target.value }))}
                            placeholder="e.g. Church friend, probate administrator, court clerk…"
                            style={inputStyle} />
                        </Field>
                      )}
                      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
                        <button onClick={cancelEdit} disabled={busy} style={btnGhost}>Cancel</button>
                        <button onClick={() => saveEdit(l)} disabled={busy || !editDraft.name.trim()} style={btnPrimary}>{busy ? 'Saving…' : 'Save'}</button>
                      </div>
                    </div>
                  );
                }
                return (
                  <div key={l.id} style={{ padding: "12px 14px", background: "#0c0a09", border: "1px solid #292524", borderRadius: 8, display: "flex", alignItems: "center", gap: 12 }}>
                    <div style={{ fontSize: 20, opacity: 0.8 }}>{kindIcon(l.contacts)}</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 700 }}>
                        {l.contacts?.name}
                        {l.contacts?.company && <span style={{ color: "#78716c", fontWeight: 500 }}> · {l.contacts.company}</span>}
                      </div>
                      <div style={{ fontSize: 11, color: "#a8a29e", marginTop: 2 }}>
                        {l.contacts?.email || '—'}{l.contacts?.phone && <> · <a href={`tel:${l.contacts.phone}`} style={{ color: 'inherit', textDecoration: 'none' }}>{l.contacts.phone}</a></>}
                        {l.relationship && <> · {l.relationship}</>}
                      </div>
                    </div>
                    <span style={{ fontSize: 10, color: "#57534e", textTransform: "uppercase", letterSpacing: "0.06em" }}>{kindLabel(l.contacts)}</span>
                    <button onClick={() => startEdit(l)} style={{ ...btnGhost, fontSize: 10, padding: "3px 10px" }}>Edit</button>
                    <button onClick={() => unlink(l.id)} style={{ ...btnGhost, fontSize: 10, padding: "3px 10px" }}>Unlink</button>
                  </div>
                );
              })}
            </div>
          )}

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button onClick={() => { setShowAdd(!showAdd); setShowQuickNew(false); }} style={btnPrimary}>
              {showAdd ? 'Cancel' : '+ Link existing contact'}
            </button>
            <button onClick={() => { setShowQuickNew(!showQuickNew); setShowAdd(false); }} style={btnGhost}>
              {showQuickNew ? 'Cancel' : '+ New contact'}
            </button>
          </div>

          {showAdd && (
            <div style={{ marginTop: 12, padding: 16, background: "#0c0a09", border: "1px solid #292524", borderRadius: 8 }}>
              {unlinkedContacts.length === 0 ? (
                <div style={{ fontSize: 12, color: "#78716c", fontStyle: "italic" }}>No unlinked contacts exist. Use "+ New contact" instead.</div>
              ) : (
                <>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                    <Field label="Contact">
                      <select value={pick} onChange={e => setPick(e.target.value)} style={{ ...inputStyle, padding: "8px 10px" }}>
                        <option value="">— pick a contact —</option>
                        {unlinkedContacts.map(c => <option key={c.id} value={c.id}>{c.name}{c.company ? ` · ${c.company}` : ''}</option>)}
                      </select>
                    </Field>
                    <Field label="Relationship (optional)">
                      <input value={rel} onChange={e => setRel(e.target.value)} placeholder="e.g. attorney of record" style={inputStyle} />
                    </Field>
                  </div>
                  <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
                    <button onClick={addExisting} disabled={!pick || busy} style={btnPrimary}>Link contact</button>
                  </div>
                </>
              )}
            </div>
          )}

          {showQuickNew && (
            <div style={{ marginTop: 12, padding: 16, background: "#0c0a09", border: "1px solid #292524", borderRadius: 8 }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <Field label="Name *"><input value={quickNew.name} onChange={e => setQuickNew(q => ({ ...q, name: e.target.value }))} style={inputStyle} /></Field>
                <Field label="Company"><input value={quickNew.company} onChange={e => setQuickNew(q => ({ ...q, company: e.target.value }))} style={inputStyle} /></Field>
                <Field label="Email"><input type="email" value={quickNew.email} onChange={e => setQuickNew(q => ({ ...q, email: e.target.value }))} style={inputStyle} /></Field>
                <Field label="Phone"><input value={quickNew.phone} onChange={e => setQuickNew(q => ({ ...q, phone: e.target.value }))} style={inputStyle} /></Field>
                <Field label="Type">
                  <select value={quickNew.kind} onChange={e => setQuickNew(q => ({ ...q, kind: e.target.value, ...(e.target.value !== 'other' ? { kind_other: '' } : {}) }))} style={{ ...inputStyle, padding: "8px 10px" }}>
                    {CONTACT_KINDS.map(k => <option key={k.key} value={k.key}>{k.icon} {k.label}</option>)}
                  </select>
                </Field>
                <Field label="Relationship on this deal"><input value={rel} onChange={e => setRel(e.target.value)} placeholder="e.g. attorney of record" style={inputStyle} /></Field>
              </div>
              {quickNew.kind === 'other' && (
                <Field label="Describe type *" style={{ marginTop: 12 }}>
                  <input value={quickNew.kind_other} onChange={e => setQuickNew(q => ({ ...q, kind_other: e.target.value }))}
                    placeholder="e.g. Church friend, probate administrator, court clerk…"
                    style={inputStyle} />
                </Field>
              )}
              <Field label="Notes" style={{ marginTop: 12 }}>
                <textarea value={quickNew.notes} onChange={e => setQuickNew(q => ({ ...q, notes: e.target.value }))} rows={2} style={{ ...inputStyle, fontFamily: "inherit", resize: "vertical" }} />
              </Field>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
                <button onClick={createAndLink} disabled={!quickNew.name || busy} style={btnPrimary}>Create + link</button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─── Library Modal — Phase 3 PR 1 ─────────────────────────
// Company-wide document library: templates, SOPs, brand, legal, marketing, training, financial.
// Separate system from per-deal `documents` — lives in `library_documents` + `library` bucket.
// Three-pane layout on desktop, stacked on mobile. Admin + VA access (VA blocked from admin_only folders).
function LibraryModal({ onClose, isAdmin, userId }) {
  const [folders, setFolders] = useState([]);
  const [docs, setDocs] = useState([]);
  const [selectedFolderId, setSelectedFolderId] = useState(null);
  const [selectedDoc, setSelectedDoc] = useState(null);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [msg, setMsg] = useState(null);
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [newFolderAdminOnly, setNewFolderAdminOnly] = useState(false);
  const fileInputRef = useRef(null);

  const loadAll = async () => {
    setLoading(true);
    const [foldersRes, docsRes] = await Promise.all([
      sb.from('library_folders').select('*').order('sort_order', { ascending: true }).order('name', { ascending: true }),
      sb.from('library_documents').select('*').order('is_pinned', { ascending: false }).order('created_at', { ascending: false }),
    ]);
    setFolders(foldersRes.data || []);
    setDocs(docsRes.data || []);
    setLoading(false);
    // Default-select first folder if nothing is selected
    if (!selectedFolderId && (foldersRes.data || []).length > 0) {
      setSelectedFolderId(foldersRes.data[0].id);
    }
  };

  useEffect(() => { loadAll(); }, []);

  // Realtime so the other admin sees live updates
  useEffect(() => {
    const ch = sb.channel('library-ch')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'library_folders' }, loadAll)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'library_documents' }, loadAll)
      .subscribe();
    return () => { sb.removeChannel(ch); };
  }, []);

  const upload = async (file, visibility) => {
    if (!file || !selectedFolderId) {
      setMsg({ type: 'error', text: 'Pick a folder first, then upload.' });
      return;
    }
    setUploading(true); setMsg(null);
    try {
      const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      const id = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
      const path = `${selectedFolderId}/${id}-${safe}`;
      const up = await sb.storage.from('library').upload(path, file, { contentType: file.type });
      if (up.error) throw up.error;
      const { data: inserted, error } = await sb.from('library_documents').insert({
        folder_id: selectedFolderId,
        title: file.name,
        path,
        size: file.size,
        mime_type: file.type,
        kind: file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : 'file',
        visibility: visibility || 'team',
        owner_id: userId,
      }).select().single();
      if (error) throw error;
      setMsg({ type: 'success', text: `Uploaded ${file.name}` });
      setSelectedDoc(inserted);
    } catch (e) {
      setMsg({ type: 'error', text: e.message || 'Upload failed' });
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const createFolder = async () => {
    const name = (newFolderName || '').trim();
    if (!name) return;
    const visibility = newFolderAdminOnly ? 'admin_only' : 'team';
    const { error } = await sb.from('library_folders').insert({
      name, visibility,
      sort_order: 1000 + (folders.length),
      created_by: userId,
    });
    if (error) { setMsg({ type: 'error', text: error.message }); return; }
    setNewFolderName("");
    setNewFolderAdminOnly(false);
    setShowNewFolder(false);
  };

  const deleteDoc = async (doc) => {
    if (!window.confirm(`Delete "${doc.title}"? This cannot be undone.`)) return;
    // Delete file from storage first (row delete will happen regardless)
    if (doc.path) await sb.storage.from('library').remove([doc.path]);
    const { error } = await sb.from('library_documents').delete().eq('id', doc.id);
    if (error) { setMsg({ type: 'error', text: error.message }); return; }
    setSelectedDoc(null);
  };

  const openDoc = async (doc) => {
    if (doc.kind === 'link' && doc.external_url) { window.open(doc.external_url, '_blank'); return; }
    if (!doc.path) return;
    const { data, error } = await sb.storage.from('library').createSignedUrl(doc.path, 600);
    if (error || !data?.signedUrl) { alert("Couldn't open that file. Call Nathan (513) 516-2306."); return; }
    window.open(data.signedUrl, '_blank');
  };

  // Filter docs shown: selected folder + search match
  const q = search.trim().toLowerCase();
  const docsInFolder = docs.filter(d => {
    if (q) {
      const hay = [d.title, d.description, (d.tags || []).join(' '), d.mime_type].filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
      return true; // global search ignores folder
    }
    return d.folder_id === selectedFolderId;
  });

  const selectedFolder = folders.find(f => f.id === selectedFolderId);
  const fmtSize = (b) => !b ? '' : b < 1024 ? `${b} B` : b < 1024 * 1024 ? `${(b / 1024).toFixed(0)} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`;

  const kindIcon = (d) => d.kind === 'template' ? '📝' : d.kind === 'video' ? '🎥' : d.kind === 'image' ? '🖼' : d.kind === 'link' ? '🔗' : '📄';

  return (
    <Modal onClose={onClose} title="📚 Library — Company-wide documents" wide>
      {/* Top bar: search + actions */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 14, flexWrap: "wrap" }}>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder={q ? `Searching all folders…` : `Search in "${selectedFolder?.name || 'library'}"…`}
          style={{ ...inputStyle, flex: 1, minWidth: 200, background: "#1c1917" }}
        />
        {isAdmin && <button onClick={() => setShowNewFolder(!showNewFolder)} style={{ ...btnGhost, fontSize: 11 }}>+ Folder</button>}
        <button onClick={() => fileInputRef.current?.click()} disabled={!selectedFolderId || uploading} style={{ ...btnPrimary, fontSize: 11 }}>
          {uploading ? 'Uploading…' : '⬆ Upload'}
        </button>
        <input ref={fileInputRef} type="file" style={{ display: 'none' }} onChange={e => upload(e.target.files[0], selectedFolder?.visibility)} />
      </div>

      {showNewFolder && isAdmin && (
        <div style={{ padding: 12, background: "#1c1917", border: "1px solid #44403c", borderRadius: 8, marginBottom: 12, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input
            value={newFolderName}
            onChange={e => setNewFolderName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && newFolderName.trim()) createFolder(); }}
            placeholder="Folder name (e.g. 08 — Vendor contracts)"
            style={{ ...inputStyle, flex: 1, minWidth: 180 }}
            autoFocus
          />
          <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "#a8a29e", cursor: "pointer" }}>
            <input type="checkbox" checked={newFolderAdminOnly} onChange={e => setNewFolderAdminOnly(e.target.checked)} />
            🔒 Admin only
          </label>
          <button onClick={createFolder} disabled={!newFolderName.trim()} style={{ ...btnPrimary, fontSize: 11 }}>Create</button>
          <button onClick={() => { setShowNewFolder(false); setNewFolderName(""); }} style={{ ...btnGhost, fontSize: 11 }}>Cancel</button>
        </div>
      )}

      {msg && (
        <div style={{ marginBottom: 12, padding: "8px 12px", borderRadius: 6, background: msg.type === 'success' ? "#064e3b" : "#7f1d1d", color: msg.type === 'success' ? "#6ee7b7" : "#fca5a5", fontSize: 12 }}>
          {msg.text}
        </div>
      )}

      {loading ? (
        <div style={{ fontSize: 13, color: "#78716c", padding: 24, textAlign: "center" }}>Loading library…</div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(180px, 220px) 1fr minmax(240px, 300px)", gap: 12, minHeight: 420 }} className="library-panes">
          {/* LEFT — folder tree */}
          <div style={{ background: "#0c0a09", border: "1px solid #292524", borderRadius: 8, padding: 8, overflowY: "auto", maxHeight: 520 }}>
            {folders.length === 0 && <div style={{ fontSize: 12, color: "#78716c", padding: 12 }}>No folders yet.</div>}
            {folders.map(f => {
              const isSel = f.id === selectedFolderId;
              const count = docs.filter(d => d.folder_id === f.id).length;
              return (
                <button
                  key={f.id}
                  onClick={() => { setSelectedFolderId(f.id); setSearch(""); setSelectedDoc(null); }}
                  style={{
                    display: "block", width: "100%", textAlign: "left",
                    padding: "8px 10px", marginBottom: 2,
                    background: isSel ? "#292524" : "transparent",
                    border: "1px solid " + (isSel ? "#44403c" : "transparent"),
                    color: isSel ? "#fafaf9" : "#a8a29e",
                    borderRadius: 5, cursor: "pointer", fontSize: 12, fontFamily: "inherit",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span>{f.icon || '📂'}</span>
                    <span style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{f.name}</span>
                    {f.visibility === 'admin_only' && <span style={{ fontSize: 9, color: "#f59e0b" }}>🔒</span>}
                    {count > 0 && <span style={{ fontSize: 10, color: "#57534e", fontWeight: 600 }}>{count}</span>}
                  </div>
                </button>
              );
            })}
          </div>

          {/* MIDDLE — file list */}
          <div style={{ background: "#0c0a09", border: "1px solid #292524", borderRadius: 8, padding: 8, overflowY: "auto", maxHeight: 520 }}>
            {docsInFolder.length === 0 ? (
              <div style={{ fontSize: 12, color: "#78716c", padding: 24, textAlign: "center", fontStyle: "italic" }}>
                {q ? `No matches for "${q}"` : "Empty folder. Click ⬆ Upload to add a file."}
              </div>
            ) : (
              docsInFolder.map(d => {
                const isSel = selectedDoc?.id === d.id;
                return (
                  <div
                    key={d.id}
                    onClick={() => setSelectedDoc(d)}
                    onDoubleClick={() => openDoc(d)}
                    style={{
                      padding: "10px 12px", marginBottom: 4, borderRadius: 5, cursor: "pointer",
                      background: isSel ? "#292524" : "transparent",
                      border: "1px solid " + (isSel ? "#44403c" : "transparent"),
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: 18, flexShrink: 0 }}>{kindIcon(d)}</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: "#fafaf9", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          {d.is_pinned && '📌 '}{d.title}
                        </div>
                        <div style={{ fontSize: 10, color: "#78716c", marginTop: 2 }}>
                          {d.kind !== 'file' && <span style={{ marginRight: 8, fontWeight: 700, color: "#d97706", textTransform: "uppercase", letterSpacing: "0.06em" }}>{d.kind}</span>}
                          {d.size ? `${fmtSize(d.size)} · ` : ''}
                          {new Date(d.created_at).toLocaleDateString()}
                          {d.visibility === 'admin_only' && <span style={{ marginLeft: 8, color: "#f59e0b" }}>🔒 admin only</span>}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* RIGHT — preview / metadata */}
          <div style={{ background: "#0c0a09", border: "1px solid #292524", borderRadius: 8, padding: 12, overflowY: "auto", maxHeight: 520 }}>
            {!selectedDoc ? (
              <div style={{ fontSize: 12, color: "#78716c", padding: 24, textAlign: "center", fontStyle: "italic" }}>
                Click a document to preview it here.
              </div>
            ) : (
              <>
                <div style={{ fontSize: 14, fontWeight: 700, color: "#fafaf9", marginBottom: 6, wordBreak: "break-word" }}>
                  {kindIcon(selectedDoc)} {selectedDoc.title}
                </div>
                <div style={{ fontSize: 10, color: "#78716c", marginBottom: 12 }}>
                  {selectedDoc.kind !== 'file' && <div><b>Kind:</b> {selectedDoc.kind}</div>}
                  {selectedDoc.size && <div><b>Size:</b> {fmtSize(selectedDoc.size)}</div>}
                  {selectedDoc.mime_type && <div><b>Type:</b> {selectedDoc.mime_type}</div>}
                  <div><b>Added:</b> {new Date(selectedDoc.created_at).toLocaleString()}</div>
                  {selectedDoc.visibility && <div><b>Visibility:</b> {selectedDoc.visibility.replace('_', ' ')}</div>}
                </div>
                {selectedDoc.description && <div style={{ fontSize: 12, color: "#d6d3d1", marginBottom: 12, lineHeight: 1.5 }}>{selectedDoc.description}</div>}
                {(selectedDoc.tags || []).length > 0 && (
                  <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 12 }}>
                    {selectedDoc.tags.map(t => (
                      <span key={t} style={{ fontSize: 10, padding: "2px 7px", background: "#292524", color: "#d6a85a", borderRadius: 3, fontWeight: 600 }}>{t}</span>
                    ))}
                  </div>
                )}
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <button onClick={() => openDoc(selectedDoc)} style={{ ...btnPrimary, fontSize: 11 }}>
                    {selectedDoc.kind === 'link' ? '🔗 Open link' : '↗ Open / download'}
                  </button>
                  {isAdmin && (
                    <button onClick={() => deleteDoc(selectedDoc)} style={{ ...btnGhost, fontSize: 11, color: "#ef4444" }}>
                      Delete
                    </button>
                  )}
                </div>
                <div style={{ marginTop: 16, padding: "8px 10px", background: "#1c1917", borderRadius: 5, fontSize: 10, color: "#57534e", lineHeight: 1.5 }}>
                  PR 2 adds: "Use on a deal" button — clones a template into a specific deal with pre-filled fields. PR 3 wires DocuSign. PR 4 pins docs to client/attorney portals.
                </div>
              </>
            )}
          </div>
        </div>
      )}

      <div style={{ marginTop: 14, padding: "8px 12px", background: "#0c0a09", borderRadius: 6, fontSize: 11, color: "#78716c", lineHeight: 1.5 }}>
        {folders.length} folder{folders.length === 1 ? '' : 's'} · {docs.length} document{docs.length === 1 ? '' : 's'}
        {' · '}Team + admin access · Admin-only folders marked 🔒
      </div>
    </Modal>
  );
}

// ─── Library Picker for a specific deal (PR 2) ────────────
// Lets admin/VA pick a file from the library and attach it to the current deal.
// If the library doc has template_fields, shows an editable merge-values form
// pre-filled from deal data. On submit, clones the file from `library` bucket
// to `deal-docs` bucket and inserts a `documents` row with from_library_id +
// library_merge_values for provenance.
//
// Resolve dot-paths like "deal.meta.courtCase" against the deal object.
function resolveDealPath(deal, path) {
  if (!path || typeof path !== 'string') return '';
  const parts = path.split('.');
  let cur = { deal };
  for (const p of parts) {
    if (cur == null) return '';
    cur = cur[p];
  }
  return cur == null ? '' : String(cur);
}

function LibraryPickerForDeal({ deal, dealId, userId, logAct, mode = 'attach', onClose, onAttached, onPinned }) {
  const [folders, setFolders] = useState([]);
  const [docs, setDocs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [selectedFolderId, setSelectedFolderId] = useState(null);
  const [selectedDoc, setSelectedDoc] = useState(null);
  const [mergeValues, setMergeValues] = useState({});
  const [attaching, setAttaching] = useState(false);
  const [msg, setMsg] = useState(null);
  // Pin-mode state
  const [pinForClient, setPinForClient] = useState(true);
  const [pinForAttorney, setPinForAttorney] = useState(true);
  const [pinLabel, setPinLabel] = useState("");

  useEffect(() => {
    (async () => {
      const [fRes, dRes] = await Promise.all([
        sb.from('library_folders').select('id, name, icon, visibility, sort_order').order('sort_order', { ascending: true }),
        sb.from('library_documents').select('id, folder_id, title, path, size, mime_type, kind, external_url, template_fields, visibility').order('created_at', { ascending: false }),
      ]);
      setFolders(fRes.data || []);
      setDocs(dRes.data || []);
      setLoading(false);
    })();
  }, []);

  // When a doc is selected, pre-populate merge values from deal data
  useEffect(() => {
    if (!selectedDoc) return;
    const tf = selectedDoc.template_fields || {};
    const pre = {};
    for (const [placeholder, path] of Object.entries(tf)) {
      pre[placeholder] = resolveDealPath(deal, path);
    }
    setMergeValues(pre);
  }, [selectedDoc]);

  const q = search.trim().toLowerCase();
  const visibleDocs = docs.filter(d => {
    if (q) {
      const hay = [d.title, d.mime_type, d.kind].filter(Boolean).join(' ').toLowerCase();
      return hay.includes(q);
    }
    if (selectedFolderId) return d.folder_id === selectedFolderId;
    return true;
  });

  const attach = async () => {
    if (!selectedDoc) return;
    setAttaching(true); setMsg(null);
    try {
      // 1. Download from library bucket
      const signed = await sb.storage.from('library').createSignedUrl(selectedDoc.path, 120);
      if (signed.error || !signed.data?.signedUrl) throw new Error(signed.error?.message || 'Could not access library file');
      const res = await fetch(signed.data.signedUrl);
      if (!res.ok) throw new Error('Library file fetch failed: ' + res.status);
      const blob = await res.blob();
      // 2. Upload to deal-docs bucket
      const safeName = (selectedDoc.title || 'document').replace(/[^a-zA-Z0-9._-]/g, '_');
      const path = `${dealId}/library-${selectedDoc.id.slice(0, 8)}-${Date.now()}-${safeName}`;
      const up = await sb.storage.from('deal-docs').upload(path, blob, { contentType: selectedDoc.mime_type || 'application/octet-stream' });
      if (up.error) throw up.error;
      // 3. Create documents row with provenance
      const hasMergeValues = Object.keys(mergeValues).length > 0;
      const { error: insErr } = await sb.from('documents').insert({
        deal_id: dealId,
        name: selectedDoc.title,
        path,
        size: selectedDoc.size || blob.size,
        uploaded_by: userId,
        extraction_status: 'pending',
        from_library_id: selectedDoc.id,
        library_merge_values: hasMergeValues ? mergeValues : null,
      });
      if (insErr) throw insErr;
      // 4. Activity row (internal team-only — the file itself is what matters)
      if (logAct) await logAct(`📎 Attached from library: ${selectedDoc.title}`);
      setMsg({ type: 'success', text: `Attached "${selectedDoc.title}" to this deal.` });
      setTimeout(() => { onAttached?.(); }, 600);
    } catch (e) {
      setMsg({ type: 'error', text: e.message || 'Attach failed' });
    } finally {
      setAttaching(false);
    }
  };

  const pin = async () => {
    if (!selectedDoc) return;
    const audience = [
      ...(pinForClient   ? ['client']   : []),
      ...(pinForAttorney ? ['attorney'] : []),
    ];
    if (audience.length === 0) {
      setMsg({ type: 'error', text: 'Pick at least one audience — client and/or attorney.' });
      return;
    }
    setAttaching(true); setMsg(null);
    try {
      const { error } = await sb.from('deal_library_pins').insert({
        deal_id: dealId,
        library_document_id: selectedDoc.id,
        pinned_for: audience,
        label: pinLabel.trim() || null,
        pinned_by: userId,
      });
      if (error) {
        if (String(error.message).toLowerCase().includes('duplicate')) {
          throw new Error('This doc is already pinned to this deal. Unpin it first to change the audience.');
        }
        throw error;
      }
      if (logAct) await logAct(`📌 Pinned library doc "${selectedDoc.title}" · ${audience.join(' + ')}`);
      setMsg({ type: 'success', text: `Pinned "${selectedDoc.title}" · visible to ${audience.join(' + ')} on this deal.` });
      setTimeout(() => { onPinned?.(); }, 600);
    } catch (e) {
      setMsg({ type: 'error', text: e.message || 'Pin failed' });
    } finally {
      setAttaching(false);
    }
  };

  const fmtSize = (b) => !b ? '' : b < 1024 ? `${b} B` : b < 1024 * 1024 ? `${(b / 1024).toFixed(0)} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`;
  const kindIcon = (d) => d.kind === 'template' ? '📝' : d.kind === 'video' ? '🎥' : d.kind === 'image' ? '🖼' : d.kind === 'link' ? '🔗' : '📄';
  const mergeFieldKeys = selectedDoc && selectedDoc.template_fields ? Object.keys(selectedDoc.template_fields) : [];

  return (
    <Modal onClose={onClose} title={`${mode === 'pin' ? '📌 Pin from library' : '📚 Attach from library'} → ${(deal.name || '').split(' - ')[0]}`} wide>
      {loading ? (
        <div style={{ fontSize: 13, color: "#78716c", padding: 24, textAlign: "center" }}>Loading library…</div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(180px, 220px) 1fr", gap: 12, minHeight: 380 }} className="library-panes">
          {/* LEFT — folder tree */}
          <div style={{ background: "#0c0a09", border: "1px solid #292524", borderRadius: 8, padding: 8, overflowY: "auto", maxHeight: 500 }}>
            <button
              onClick={() => { setSelectedFolderId(null); setSearch(""); }}
              style={{
                display: "block", width: "100%", textAlign: "left",
                padding: "8px 10px", marginBottom: 2,
                background: selectedFolderId === null ? "#292524" : "transparent",
                border: "1px solid " + (selectedFolderId === null ? "#44403c" : "transparent"),
                color: selectedFolderId === null ? "#fafaf9" : "#a8a29e",
                borderRadius: 5, cursor: "pointer", fontSize: 12, fontFamily: "inherit",
              }}
            >
              <span style={{ marginRight: 6 }}>📁</span>All files ({docs.length})
            </button>
            {folders.map(f => {
              const isSel = f.id === selectedFolderId;
              const count = docs.filter(d => d.folder_id === f.id).length;
              return (
                <button
                  key={f.id}
                  onClick={() => { setSelectedFolderId(f.id); setSearch(""); }}
                  style={{
                    display: "block", width: "100%", textAlign: "left",
                    padding: "8px 10px", marginBottom: 2,
                    background: isSel ? "#292524" : "transparent",
                    border: "1px solid " + (isSel ? "#44403c" : "transparent"),
                    color: isSel ? "#fafaf9" : "#a8a29e",
                    borderRadius: 5, cursor: "pointer", fontSize: 12, fontFamily: "inherit",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span>{f.icon || '📂'}</span>
                    <span style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{f.name}</span>
                    {count > 0 && <span style={{ fontSize: 10, color: "#57534e", fontWeight: 600 }}>{count}</span>}
                  </div>
                </button>
              );
            })}
          </div>

          {/* RIGHT — file list + selected-doc detail */}
          <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search all library files…"
              style={{ ...inputStyle, background: "#1c1917" }}
            />

            {/* file list */}
            <div style={{ background: "#0c0a09", border: "1px solid #292524", borderRadius: 8, padding: 8, overflowY: "auto", maxHeight: 240 }}>
              {visibleDocs.length === 0 ? (
                <div style={{ fontSize: 12, color: "#78716c", padding: 16, textAlign: "center", fontStyle: "italic" }}>
                  {q ? `No matches for "${q}"` : "No files in this folder. Upload to the library first."}
                </div>
              ) : (
                visibleDocs.map(d => {
                  const isSel = selectedDoc?.id === d.id;
                  return (
                    <div
                      key={d.id}
                      onClick={() => setSelectedDoc(d)}
                      style={{
                        padding: "8px 10px", marginBottom: 3, borderRadius: 5, cursor: "pointer",
                        background: isSel ? "#292524" : "transparent",
                        border: "1px solid " + (isSel ? "#44403c" : "transparent"),
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ fontSize: 16, flexShrink: 0 }}>{kindIcon(d)}</span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 12, fontWeight: 600, color: "#fafaf9", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{d.title}</div>
                          <div style={{ fontSize: 10, color: "#78716c", marginTop: 1 }}>
                            {d.kind === 'template' && <span style={{ color: "#d97706", fontWeight: 700, marginRight: 6, letterSpacing: "0.04em" }}>TEMPLATE</span>}
                            {d.size ? fmtSize(d.size) : ''}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            {/* selected-doc detail — attach mode OR pin mode */}
            {selectedDoc ? (
              <div style={{ background: "#0c0a09", border: "1px solid #44403c", borderRadius: 8, padding: 12 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: "#fafaf9", marginBottom: 10 }}>
                  {kindIcon(selectedDoc)} {selectedDoc.title}
                </div>

                {mode === 'attach' && (
                  <>
                    {mergeFieldKeys.length > 0 ? (
                      <>
                        <div style={{ fontSize: 10, color: "#d97706", fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 8 }}>
                          Merge fields · pre-filled from deal
                        </div>
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 8, marginBottom: 12 }}>
                          {mergeFieldKeys.map(key => (
                            <div key={key}>
                              <div style={{ fontSize: 10, color: "#a8a29e", fontWeight: 600, marginBottom: 3 }}>{key}</div>
                              <input
                                value={mergeValues[key] || ''}
                                onChange={e => setMergeValues(v => ({ ...v, [key]: e.target.value }))}
                                style={{ ...inputStyle, fontSize: 12, padding: "6px 8px" }}
                                placeholder="—"
                              />
                            </div>
                          ))}
                        </div>
                        <div style={{ fontSize: 11, color: "#78716c", marginBottom: 12, lineHeight: 1.5, padding: "8px 10px", background: "#1c1917", borderRadius: 5 }}>
                          Values are saved to this deal's document record. PR 3 will use them for automatic DocuSign field-filling. For now, download the file and fill in manually as needed.
                        </div>
                      </>
                    ) : (
                      <div style={{ fontSize: 11, color: "#78716c", marginBottom: 12, lineHeight: 1.5 }}>
                        No merge fields defined for this document — it will attach as-is.
                      </div>
                    )}

                    <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                      <button onClick={onClose} style={{ ...btnGhost, fontSize: 11 }}>Cancel</button>
                      <button onClick={attach} disabled={attaching} style={{ ...btnPrimary, fontSize: 11 }}>
                        {attaching ? 'Attaching…' : '📎 Attach to this deal'}
                      </button>
                    </div>
                  </>
                )}

                {mode === 'pin' && (
                  <>
                    <div style={{ fontSize: 10, color: "#d97706", fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 8 }}>
                      Pin audience — who sees this on the portals?
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
                      <label style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "8px 10px", background: pinForClient ? "#064e3b" : "#1c1917", border: "1px solid " + (pinForClient ? "#10b981" : "#292524"), borderRadius: 5, cursor: "pointer" }}>
                        <input type="checkbox" checked={pinForClient} onChange={e => setPinForClient(e.target.checked)} style={{ marginTop: 2 }} />
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 12, fontWeight: 600, color: pinForClient ? "#6ee7b7" : "#a8a29e" }}>👤 Client portal</div>
                          <div style={{ fontSize: 10, color: "#78716c", marginTop: 2 }}>Homeowner sees this in their Documents section. Good for welcome packets, FAQs, post-sign guidance.</div>
                        </div>
                      </label>
                      <label style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "8px 10px", background: pinForAttorney ? "#312e81" : "#1c1917", border: "1px solid " + (pinForAttorney ? "#8b5cf6" : "#292524"), borderRadius: 5, cursor: "pointer" }}>
                        <input type="checkbox" checked={pinForAttorney} onChange={e => setPinForAttorney(e.target.checked)} style={{ marginTop: 2 }} />
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 12, fontWeight: 600, color: pinForAttorney ? "#c4b5fd" : "#a8a29e" }}>⚖ Attorney portal</div>
                          <div style={{ fontSize: 10, color: "#78716c", marginTop: 2 }}>Retained attorney sees this on their case view. Good for Ohio surplus reference sheets, form templates.</div>
                        </div>
                      </label>
                    </div>

                    <div style={{ marginBottom: 12 }}>
                      <div style={{ fontSize: 10, color: "#a8a29e", fontWeight: 600, marginBottom: 3 }}>Display label (optional)</div>
                      <input
                        value={pinLabel}
                        onChange={e => setPinLabel(e.target.value)}
                        style={{ ...inputStyle, fontSize: 12, padding: "6px 8px" }}
                        placeholder={selectedDoc.title}
                      />
                      <div style={{ fontSize: 10, color: "#57534e", marginTop: 3 }}>Leave blank to use the library title verbatim.</div>
                    </div>

                    <div style={{ fontSize: 11, color: "#78716c", marginBottom: 12, lineHeight: 1.5, padding: "8px 10px", background: "#1c1917", borderRadius: 5 }}>
                      Pinning doesn't copy the file — it just exposes it on this deal's chosen portal(s) with a signed URL. When the library doc updates, the pinned version updates automatically. Unpin anytime from the deal's Documents tab.
                    </div>

                    <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                      <button onClick={onClose} style={{ ...btnGhost, fontSize: 11 }}>Cancel</button>
                      <button onClick={pin} disabled={attaching || (!pinForClient && !pinForAttorney)} style={{ ...btnPrimary, fontSize: 11 }}>
                        {attaching ? 'Pinning…' : '📌 Pin to this deal'}
                      </button>
                    </div>
                  </>
                )}

                {msg && (
                  <div style={{ marginTop: 10, padding: "6px 10px", borderRadius: 5, background: msg.type === 'success' ? "#064e3b" : "#7f1d1d", color: msg.type === 'success' ? "#6ee7b7" : "#fca5a5", fontSize: 11 }}>
                    {msg.text}
                  </div>
                )}
              </div>
            ) : (
              <div style={{ background: "#0c0a09", border: "1px dashed #292524", borderRadius: 8, padding: 24, textAlign: "center", fontSize: 12, color: "#78716c", fontStyle: "italic" }}>
                Pick a file from the list above to {mode === 'pin' ? 'pin' : 'attach'} to <b style={{ color: "#a8a29e" }}>{(deal.name || '').split(' - ')[0]}</b>.
              </div>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

// ─── DocuSign Send Modal (PR 3) ─────────────────────────
// Sends a library template via DocuSign with deal-merged fields. Recipient
// defaults pull from client_access (portal email + SMS phone) falling back
// to deal.meta. Edge Function `docusign-send-envelope` handles the JWT Grant
// + API call. Status card back on the deal auto-updates via realtime when
// the webhook receives DocuSign Connect events.
function DocuSignSendModal({ deal, dealId, onClose, onSent }) {
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedDoc, setSelectedDoc] = useState(null);
  const [mergeOverrides, setMergeOverrides] = useState({});
  const [recipientEmail, setRecipientEmail] = useState('');
  const [recipientName, setRecipientName] = useState('');
  const [recipientPhone, setRecipientPhone] = useState('');
  const [sendSms, setSendSms] = useState(false);
  const [emailSubject, setEmailSubject] = useState('');
  const [sending, setSending] = useState(false);
  const [msg, setMsg] = useState(null);

  // Load ONLY library docs that have a DocuSign template_id wired up
  useEffect(() => {
    (async () => {
      const { data } = await sb.from('library_documents')
        .select('id, title, kind, template_fields, docusign_template_id, description')
        .not('docusign_template_id', 'is', null)
        .order('created_at', { ascending: false });
      setTemplates(data || []);
      setLoading(false);
    })();
  }, []);

  // Pre-fill recipient defaults once (from client_access or deal.meta)
  useEffect(() => {
    (async () => {
      const clientName = (deal.name || '').split(' - ')[0];
      setRecipientName(clientName);
      // try client_access for the canonical contact email + notification phone
      const { data: ca } = await sb.from('client_access')
        .select('email, prefs')
        .eq('deal_id', dealId)
        .eq('enabled', true)
        .maybeSingle();
      if (ca?.email) setRecipientEmail(ca.email);
      else if (deal.meta?.email) setRecipientEmail(deal.meta.email);
      if (ca?.prefs?.notify_phone) setRecipientPhone(ca.prefs.notify_phone);
      else if (deal.meta?.phone) setRecipientPhone(deal.meta.phone);
    })();
  }, [dealId]);

  // When template is picked, compute merge defaults from deal data
  useEffect(() => {
    if (!selectedDoc) { setMergeOverrides({}); return; }
    const fields = selectedDoc.template_fields || {};
    const initial = {};
    for (const [k, path] of Object.entries(fields)) {
      initial[k] = resolveDealPath(deal, path);
    }
    setMergeOverrides(initial);
    setEmailSubject(`Please sign: ${selectedDoc.title}`);
  }, [selectedDoc]);

  const send = async () => {
    if (!selectedDoc || !recipientEmail || !recipientName) {
      setMsg({ type: 'error', text: 'Pick a template, confirm recipient email + name.' });
      return;
    }
    if (sendSms && !recipientPhone) {
      setMsg({ type: 'error', text: 'SMS is on — enter a phone number or turn off SMS.' });
      return;
    }
    setSending(true); setMsg(null);
    try {
      const { data, error } = await sb.functions.invoke('docusign-send-envelope', {
        body: {
          deal_id: dealId,
          library_document_id: selectedDoc.id,
          recipient_email: recipientEmail.trim(),
          recipient_name: recipientName.trim(),
          recipient_phone: recipientPhone.trim() || null,
          send_sms: sendSms,
          email_subject_override: emailSubject.trim() || null,
          merge_overrides: mergeOverrides,
        },
      });
      if (error) throw error;
      if (data?.error) {
        // Edge function returned structured error
        if (data.error === 'docusign_not_configured') {
          setMsg({ type: 'error', text: '⚠ DocuSign not configured yet — see setup instructions. (Admin: add DOCUSIGN_* secrets to the Edge Function.)' });
        } else if (data.error === 'not_a_docusign_template') {
          setMsg({ type: 'error', text: 'This template has no docusign_template_id set. SQL-update the library row with the DocuSign template UUID first.' });
        } else {
          setMsg({ type: 'error', text: data.message || JSON.stringify(data) });
        }
        setSending(false);
        return;
      }
      setMsg({ type: 'success', text: `Envelope sent. DocuSign ID: ${data.envelope_id}` });
      setTimeout(() => { onSent?.(); }, 800);
    } catch (e) {
      setMsg({ type: 'error', text: e.message || 'Send failed' });
    } finally {
      setSending(false);
    }
  };

  const mergeFieldKeys = selectedDoc ? Object.keys(selectedDoc.template_fields || {}) : [];
  const clientName = (deal.name || '').split(' - ')[0];

  return (
    <Modal onClose={onClose} title={`📝 Send for signature → ${clientName}`} wide>
      {loading ? (
        <div style={{ fontSize: 13, color: "#78716c", padding: 24, textAlign: "center" }}>Loading templates…</div>
      ) : templates.length === 0 ? (
        <div style={{ padding: 18, background: "#1c1917", border: "1px dashed #44403c", borderRadius: 8, color: "#a8a29e", fontSize: 13, lineHeight: 1.6 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#fafaf9", marginBottom: 8 }}>No DocuSign-ready templates yet.</div>
          <p style={{ margin: "6px 0" }}>To send something for signature, the library doc needs <code style={{ background: "#0c0a09", padding: "2px 6px", borderRadius: 3 }}>docusign_template_id</code> set to a real DocuSign template UUID.</p>
          <p style={{ margin: "6px 0" }}>Workflow:</p>
          <ol style={{ margin: "6px 0", paddingLeft: 20 }}>
            <li>Create the template in DocuSign admin (add merge-field text tabs named <code style={{ background: "#0c0a09", padding: "1px 5px", borderRadius: 3 }}>ClientName</code>, <code style={{ background: "#0c0a09", padding: "1px 5px", borderRadius: 3 }}>CaseNumber</code>, etc.)</li>
            <li>Copy the DocuSign template ID</li>
            <li>Upload the same source PDF to DCC Library → mark it as <code style={{ background: "#0c0a09", padding: "1px 5px", borderRadius: 3 }}>kind='template'</code></li>
            <li>SQL-update: <code style={{ background: "#0c0a09", padding: "1px 5px", borderRadius: 3 }}>update library_documents set docusign_template_id = '...' where id = '...'</code></li>
            <li>Refresh this modal — the template will appear</li>
          </ol>
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(200px, 280px) 1fr", gap: 14 }} className="library-panes">
          {/* LEFT — template picker */}
          <div style={{ background: "#0c0a09", border: "1px solid #292524", borderRadius: 8, padding: 8, maxHeight: 520, overflowY: "auto" }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: "#78716c", letterSpacing: "0.08em", textTransform: "uppercase", padding: "4px 8px 8px" }}>
              DocuSign-ready templates
            </div>
            {templates.map(t => {
              const isSel = selectedDoc?.id === t.id;
              const fieldCount = Object.keys(t.template_fields || {}).length;
              return (
                <button key={t.id} onClick={() => setSelectedDoc(t)} style={{
                  display: "block", width: "100%", textAlign: "left",
                  padding: "10px 12px", marginBottom: 3, borderRadius: 5, cursor: "pointer",
                  background: isSel ? "#292524" : "transparent",
                  border: "1px solid " + (isSel ? "#44403c" : "transparent"),
                  color: isSel ? "#fafaf9" : "#a8a29e",
                  fontSize: 12, fontFamily: "inherit",
                }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 16 }}>📝</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t.title}</div>
                      <div style={{ fontSize: 10, color: "#78716c", marginTop: 2 }}>
                        {fieldCount > 0 ? `${fieldCount} merge field${fieldCount === 1 ? '' : 's'}` : 'no merge fields'}
                      </div>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>

          {/* RIGHT — send form */}
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {!selectedDoc ? (
              <div style={{ background: "#0c0a09", border: "1px dashed #292524", borderRadius: 8, padding: 32, textAlign: "center", fontSize: 12, color: "#78716c", fontStyle: "italic" }}>
                Pick a template on the left to configure the send.
              </div>
            ) : (
              <>
                {/* Recipient */}
                <div style={{ background: "#0c0a09", border: "1px solid #44403c", borderRadius: 8, padding: 12 }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: "#d97706", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 8 }}>
                    Recipient
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
                    <div>
                      <div style={{ fontSize: 10, color: "#a8a29e", fontWeight: 600, marginBottom: 3 }}>Name</div>
                      <input value={recipientName} onChange={e => setRecipientName(e.target.value)} style={{ ...inputStyle, fontSize: 13 }} />
                    </div>
                    <div>
                      <div style={{ fontSize: 10, color: "#a8a29e", fontWeight: 600, marginBottom: 3 }}>Email</div>
                      <input type="email" value={recipientEmail} onChange={e => setRecipientEmail(e.target.value)} style={{ ...inputStyle, fontSize: 13 }} />
                    </div>
                  </div>
                  <label style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", background: sendSms ? "#064e3b" : "#1c1917", border: "1px solid " + (sendSms ? "#10b981" : "#292524"), borderRadius: 5, cursor: "pointer", marginBottom: sendSms ? 8 : 0 }}>
                    <input type="checkbox" checked={sendSms} onChange={e => setSendSms(e.target.checked)} />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: sendSms ? "#6ee7b7" : "#a8a29e" }}>📱 Also send via SMS (Business DocuSign)</div>
                      <div style={{ fontSize: 10, color: "#78716c", marginTop: 2 }}>Signer gets a text with a one-tap signing link. Requires phone + template configured for SMS delivery in DocuSign.</div>
                    </div>
                  </label>
                  {sendSms && (
                    <div>
                      <div style={{ fontSize: 10, color: "#a8a29e", fontWeight: 600, marginBottom: 3 }}>Phone (US; +1 assumed)</div>
                      <input type="tel" value={recipientPhone} onChange={e => setRecipientPhone(e.target.value)} placeholder="(614) 555-1234" style={{ ...inputStyle, fontSize: 13 }} />
                    </div>
                  )}
                </div>

                {/* Merge fields */}
                {mergeFieldKeys.length > 0 && (
                  <div style={{ background: "#0c0a09", border: "1px solid #44403c", borderRadius: 8, padding: 12 }}>
                    <div style={{ fontSize: 10, fontWeight: 700, color: "#d97706", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 8 }}>
                      Merge fields · pre-filled from this deal
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 8 }}>
                      {mergeFieldKeys.map(key => (
                        <div key={key}>
                          <div style={{ fontSize: 10, color: "#a8a29e", fontWeight: 600, marginBottom: 3 }}>{key}</div>
                          <input value={mergeOverrides[key] || ''} onChange={e => setMergeOverrides(v => ({ ...v, [key]: e.target.value }))} style={{ ...inputStyle, fontSize: 12, padding: "6px 8px" }} placeholder="—" />
                        </div>
                      ))}
                    </div>
                    <div style={{ fontSize: 10, color: "#57534e", marginTop: 8 }}>
                      These map to DocuSign template "text tabs" by label. Double-check the tab labels match your DocuSign template exactly.
                    </div>
                  </div>
                )}

                {/* Email subject */}
                <div style={{ background: "#0c0a09", border: "1px solid #44403c", borderRadius: 8, padding: 12 }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: "#d97706", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 8 }}>
                    Email subject
                  </div>
                  <input value={emailSubject} onChange={e => setEmailSubject(e.target.value)} style={{ ...inputStyle, fontSize: 13 }} />
                </div>

                {msg && (
                  <div style={{ padding: "8px 12px", borderRadius: 6, background: msg.type === 'success' ? "#064e3b" : "#7f1d1d", color: msg.type === 'success' ? "#6ee7b7" : "#fca5a5", fontSize: 12 }}>
                    {msg.text}
                  </div>
                )}

                <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                  <button onClick={onClose} style={{ ...btnGhost, fontSize: 12 }}>Cancel</button>
                  <button onClick={send} disabled={sending} style={{ ...btnPrimary, fontSize: 12 }}>
                    {sending ? 'Sending to DocuSign…' : '📝 Send for signature'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

// ── Lauren DCC — internal AI assistant ──────────────────────────
const LAUREN_INTERNAL_URL = 'https://rcfaashkfpurkvtmsmeb.supabase.co/functions/v1/lauren-internal';

// Global event so callers outside this component can open Lauren's chat
// (e.g. the mobile More sheet, which can't reach internal state directly).
// Dispatch `window.dispatchEvent(new Event('dcc:open-lauren'))` to pop it.
function LaurenDCC() {
  const [open, setOpen] = React.useState(false);
  useEffect(() => {
    const handler = () => setOpen(true);
    window.addEventListener('dcc:open-lauren', handler);
    return () => window.removeEventListener('dcc:open-lauren', handler);
  }, []);
  const [msgs, setMsgs] = React.useState([]);
  const [input, setInput] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const sessionRef = React.useRef(localStorage.getItem('lauren_dcc_session') || null);
  const historyRef = React.useRef([]); // API message history
  const msgsEl = React.useRef(null);
  const inputEl = React.useRef(null);

  React.useEffect(() => {
    if (open && msgs.length === 0) {
      setMsgs([{ r: 'l', t: "What do you need?" }]);
    }
    if (open) setTimeout(() => inputEl.current?.focus(), 80);
  }, [open]);

  React.useEffect(() => {
    if (msgsEl.current) msgsEl.current.scrollTop = msgsEl.current.scrollHeight;
  }, [msgs, busy]);

  async function send() {
    if (busy || !input.trim()) return;
    const text = input.trim();
    setInput('');
    setMsgs(m => [...m, { r: 'u', t: text }]);
    historyRef.current = [...historyRef.current, { role: 'user', content: text }];
    setBusy(true);
    try {
      const res = await fetch(LAUREN_INTERNAL_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: historyRef.current, session_id: sessionRef.current })
      });
      const data = await res.json();
      if (data.session_id) {
        sessionRef.current = data.session_id;
        localStorage.setItem('lauren_dcc_session', data.session_id);
      }
      const reply = data.reply || 'Something went wrong.';
      historyRef.current = [...historyRef.current, { role: 'assistant', content: reply }];
      setMsgs(m => [...m, { r: 'l', t: reply }]);
    } catch {
      setMsgs(m => [...m, { r: 'l', t: 'Connection error — try again.' }]);
    }
    setBusy(false);
    setTimeout(() => inputEl.current?.focus(), 50);
  }

  const btnStyle = {
    position: 'fixed', bottom: 24, right: 24, zIndex: 9000,
    background: '#d97706', color: '#1c0a00', border: 'none',
    borderRadius: 24, padding: '0 18px', height: 44,
    display: 'flex', alignItems: 'center', gap: 8,
    fontSize: 13, fontWeight: 700, cursor: 'pointer',
    boxShadow: '0 4px 20px rgba(217,119,6,.45)', fontFamily: 'inherit',
    transition: 'transform .1s'
  };

  return React.createElement(React.Fragment, null,
    React.createElement('button', {
      onClick: () => setOpen(o => !o),
      style: btnStyle,
      className: 'lauren-fab',
      title: 'Chat with Lauren'
    },
      React.createElement('svg', { width: 16, height: 16, fill: 'none', viewBox: '0 0 20 20' },
        React.createElement('path', { d: 'M18 10c0 4.418-3.582 8-8 8a7.96 7.96 0 0 1-3.93-1.03L2 18l1.03-4.07A7.96 7.96 0 0 1 2 10C2 5.582 5.582 2 10 2s8 3.582 8 8Z', stroke: 'currentColor', strokeWidth: 1.8, strokeLinejoin: 'round' })
      ),
      'Lauren'
    ),
    open && React.createElement('div', {
      className: 'lauren-panel',
      style: {
        position: 'fixed', bottom: 80, right: 24, zIndex: 9001,
        width: 380, height: 520,
        background: '#1c1917', border: '1px solid #44403c',
        borderRadius: 16, boxShadow: '0 16px 48px rgba(0,0,0,.65)',
        display: 'flex', flexDirection: 'column', overflow: 'hidden'
      }
    },
      // Header
      React.createElement('div', {
        style: { display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', background: '#0c0a09', borderBottom: '1px solid #292524', flexShrink: 0 }
      },
        React.createElement('div', { style: { width: 8, height: 8, borderRadius: '50%', background: '#4ade80', flexShrink: 0 } }),
        React.createElement('div', null,
          React.createElement('div', { style: { fontSize: 13, fontWeight: 700, color: '#fafaf9' } }, 'Lauren'),
          React.createElement('div', { style: { fontSize: 10, color: '#78716c' } }, 'Internal · FundLocators')
        ),
        React.createElement('button', {
          onClick: () => setOpen(false),
          'aria-label': 'Close chat',
          style: { marginLeft: 'auto', background: '#292524', border: '1px solid #44403c', color: '#fafaf9', fontSize: 20, lineHeight: 1, cursor: 'pointer', borderRadius: 8, width: 36, height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontFamily: 'inherit', fontWeight: 400 }
        }, '×')
      ),
      // Messages
      React.createElement('div', {
        ref: msgsEl,
        style: { flex: 1, overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }
      },
        ...msgs.map((msg, i) => React.createElement('div', {
          key: i,
          style: {
            alignSelf: msg.r === 'u' ? 'flex-end' : 'flex-start',
            maxWidth: '84%', padding: '9px 13px',
            background: msg.r === 'u' ? '#d97706' : '#292524',
            color: msg.r === 'u' ? '#1c0a00' : '#fafaf9',
            borderRadius: 12,
            borderBottomRightRadius: msg.r === 'u' ? 3 : 12,
            borderBottomLeftRadius: msg.r === 'l' ? 3 : 12,
            fontSize: 13, lineHeight: 1.55,
            whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            fontWeight: msg.r === 'u' ? 500 : 400
          }
        }, msg.t)),
        busy && React.createElement('div', {
          style: { alignSelf: 'flex-start', background: '#292524', borderRadius: 12, borderBottomLeftRadius: 3, padding: '10px 14px', display: 'flex', gap: 5 }
        },
          ...[0,1,2].map(i => React.createElement('div', {
            key: i,
            style: { width: 7, height: 7, borderRadius: '50%', background: '#78716c', animation: `dotPulse 1.2s ease-in-out ${i*0.2}s infinite` }
          }))
        )
      ),
      // Input row
      React.createElement('div', {
        style: { display: 'flex', gap: 8, padding: '10px 12px', borderTop: '1px solid #292524', background: '#1c1917', flexShrink: 0 }
      },
        React.createElement('textarea', {
          ref: inputEl,
          value: input,
          onChange: e => setInput(e.target.value),
          onKeyDown: e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } },
          placeholder: 'Ask Lauren anything…',
          rows: 1,
          style: { flex: 1, background: '#292524', border: '1px solid #44403c', borderRadius: 8, padding: '8px 12px', color: '#fafaf9', fontSize: 13, fontFamily: 'inherit', resize: 'none', outline: 'none', minHeight: 38 }
        }),
        React.createElement('button', {
          onClick: send, disabled: busy,
          style: { minWidth: 38, height: 38, background: busy ? '#44403c' : '#d97706', color: busy ? '#78716c' : '#1c0a00', border: 'none', borderRadius: 8, cursor: busy ? 'not-allowed' : 'pointer', fontSize: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }
        }, '↑')
      )
    )
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(
  React.createElement(React.Fragment, null,
    React.createElement(Root),
    React.createElement(LaurenDCC)
  )
);
