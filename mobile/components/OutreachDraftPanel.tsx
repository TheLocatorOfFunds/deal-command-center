/**
 * OutreachDraftPanel — mobile mirror of src/app.jsx's OutreachDraftPanel.
 *
 * Renders the current pending/queued outreach_queue row for a deal: the
 * AI-drafted SMS body, From/To routing, a coach-note input that triggers
 * a regenerate, Edit/Send/Skip actions, and the two thumbs-up/down
 * AgentFeedbackWidgets (text_draft + research_grade) shipped 2026-05-13.
 *
 * The Phase 1 scope gate (A-tier + verified surplus + not 30dts) lives
 * server-side via the auto-cancel rules in src/app.jsx — this panel just
 * renders whatever queue row exists; if Phase 1 wouldn't allow auto-fire,
 * there won't be a row to render.
 *
 * Renders null when there's no relevant queue row. Designed to drop into
 * a vertical scroll container; uses View, not ScrollView, internally.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { supabase } from '../lib/supabase'

const SUPABASE_URL = 'https://rcfaashkfpurkvtmsmeb.supabase.co'
const SUPABASE_KEY = 'sb_publishable_BjBJSBQC2iJXQodut3y3Ag_8aKyPmwv'

// ─── Types matching outreach_queue + deals ───────────────────────────────────

type DealLite = {
  id: string
  name?: string | null
  address?: string | null
  lead_tier?: string | null
  is_30dts?: boolean | null
  meta?: Record<string, any> | null
}

type QueueItem = {
  id: string
  deal_id: string
  contact_phone: string | null
  cadence_day: number | null
  status: string | null
  draft_body: string | null
  agent_reasoning: string | null
  scheduled_for: string | null
  updated_at: string | null
}

// ─── AgentFeedbackWidget (mobile) ────────────────────────────────────────────
// Compact thumbs +/- row. Thumbs-down expands a reason + suggestion form;
// thumbs-up fires immediately. Writes to public.agent_feedback (migration
// 20260513000000). Mobile mirror of src/app.jsx's AgentFeedbackWidget.

type FeedbackKind = 'text_draft' | 'research_grade'

type FeedbackContext = Record<string, any> | null

function AgentFeedbackWidget(props: {
  kind: FeedbackKind
  label: string
  dealId: string
  outreachQueueId: string | null
  context: FeedbackContext
  suggestionPrompt?: string
}) {
  const { kind, label, dealId, outreachQueueId, context, suggestionPrompt } = props
  const [signal, setSignal] = useState<'up' | 'down' | null>(null)
  const [submittedAt, setSubmittedAt] = useState<Date | null>(null)
  const [reason, setReason] = useState('')
  const [suggestion, setSuggestion] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(nextSignal: 'up' | 'down') {
    if (submitting || submittedAt) return
    if (nextSignal === 'down' && signal !== 'down') {
      // First tap on thumbs-down — just expand the reason form, don't submit yet
      setSignal('down')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const { data: authData } = await supabase.auth.getUser()
      const payload = {
        kind,
        deal_id: dealId,
        outreach_queue_id: outreachQueueId,
        user_id: authData?.user?.id ?? null,
        signal: nextSignal,
        reason: reason.trim() || null,
        suggested_correction: suggestion.trim() || null,
        context,
      }
      const { error: insErr } = await supabase.from('agent_feedback').insert(payload)
      if (insErr) throw new Error(insErr.message)
      setSignal(nextSignal)
      setSubmittedAt(new Date())
    } catch (e: any) {
      setError(e?.message ?? 'unknown error')
    } finally {
      setSubmitting(false)
    }
  }

  if (submittedAt) {
    return (
      <View style={s.fbConfirmRow}>
        <Text style={s.fbConfirmEmoji}>{signal === 'up' ? '👍' : '👎'}</Text>
        <Text style={s.fbConfirmText}>{label} feedback logged · thanks</Text>
      </View>
    )
  }

  return (
    <View style={s.fbContainer}>
      <View style={s.fbRow}>
        <Text style={s.fbLabel}>{label}</Text>
        <Pressable
          onPress={() => submit('up')}
          disabled={submitting}
          style={({ pressed }) => [
            s.fbBtn,
            signal === 'up' && s.fbBtnUpActive,
            pressed && { opacity: 0.6 },
          ]}
        >
          <Text style={s.fbBtnEmoji}>👍</Text>
        </Pressable>
        <Pressable
          onPress={() => submit('down')}
          disabled={submitting}
          style={({ pressed }) => [
            s.fbBtn,
            signal === 'down' && s.fbBtnDownActive,
            pressed && { opacity: 0.6 },
          ]}
        >
          <Text style={s.fbBtnEmoji}>👎</Text>
        </Pressable>
        {error && <Text style={s.fbError}>⚠ {error}</Text>}
      </View>
      {signal === 'down' && (
        <View style={s.fbExpandedForm}>
          <TextInput
            value={reason}
            onChangeText={setReason}
            placeholder="What's wrong with it?"
            placeholderTextColor="#78716c"
            style={s.fbInput}
            returnKeyType="next"
          />
          <TextInput
            value={suggestion}
            onChangeText={setSuggestion}
            placeholder={
              suggestionPrompt ||
              'What should it have been? (optional)'
            }
            placeholderTextColor="#78716c"
            style={s.fbInput}
            returnKeyType="done"
          />
          <View style={s.fbActionRow}>
            <Pressable
              onPress={() => submit('down')}
              disabled={submitting || !reason.trim()}
              style={({ pressed }) => [
                s.fbLogBtn,
                !reason.trim() && s.fbLogBtnDisabled,
                pressed && { opacity: 0.7 },
              ]}
            >
              <Text
                style={[
                  s.fbLogBtnText,
                  !reason.trim() && s.fbLogBtnTextDisabled,
                ]}
              >
                {submitting ? 'Saving…' : 'Log feedback'}
              </Text>
            </Pressable>
            <Pressable
              onPress={() => {
                setSignal(null)
                setReason('')
                setSuggestion('')
              }}
              style={({ pressed }) => [
                s.fbCancelBtn,
                pressed && { opacity: 0.7 },
              ]}
            >
              <Text style={s.fbCancelText}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      )}
    </View>
  )
}

// ─── Main panel ──────────────────────────────────────────────────────────────

export function OutreachDraftPanel({
  dealId,
  deal,
  onSent,
}: {
  dealId: string
  deal: DealLite | null
  onSent?: () => void
}) {
  const [item, setItem] = useState<QueueItem | null>(null)
  const [coachNote, setCoachNote] = useState('')
  const [editMode, setEditMode] = useState(false)
  const [editBody, setEditBody] = useState('')
  const [isGen, setIsGen] = useState(false)
  const [isSend, setIsSend] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sentInfo, setSentInfo] = useState<{ at: Date } | null>(null)
  const firedRef = useRef<Set<string>>(new Set())

  // Load the latest non-sent queue row for this deal
  const load = useCallback(async () => {
    if (!dealId) return
    const { data } = await supabase
      .from('outreach_queue')
      .select(
        'id, deal_id, contact_phone, cadence_day, status, draft_body, agent_reasoning, scheduled_for, updated_at',
      )
      .eq('deal_id', dealId)
      .in('status', ['queued', 'generating', 'pending'])
      .order('cadence_day', { ascending: true })
      .limit(1)
      .maybeSingle()
    setItem((data as QueueItem | null) ?? null)
  }, [dealId])

  useEffect(() => {
    load()
    const ch = supabase
      .channel(`outreach_queue:${dealId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'outreach_queue', filter: `deal_id=eq.${dealId}` },
        () => load(),
      )
      .subscribe()
    // Polling fallback (matches web pattern at 3s)
    const iv = setInterval(load, 3000)
    return () => {
      supabase.removeChannel(ch)
      clearInterval(iv)
    }
  }, [dealId, load])

  // Auto-fire generate when a queued item appears
  useEffect(() => {
    if (!item || item.status !== 'queued') return
    if (firedRef.current.has(item.id)) return
    firedRef.current.add(item.id)
    void callGenerate(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.id, item?.status])

  async function callGenerate(note: string | null) {
    if (!item) return
    setIsGen(true)
    setError(null)
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession()
      const token = session?.access_token
      const r = await fetch(`${SUPABASE_URL}/functions/v1/generate-outreach`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${token ?? SUPABASE_KEY}`,
        },
        body: JSON.stringify({ queue_id: item.id, coach_note: note || undefined }),
      })
      const j = await r.json()
      if (!r.ok) throw new Error(j?.error || 'Generation failed')
    } catch (e: any) {
      setError(e?.message ?? 'unknown error')
    } finally {
      setIsGen(false)
    }
  }

  async function handleSend(bodyOverride?: string) {
    if (!item) return
    setIsSend(true)
    setError(null)
    try {
      const bodyToSend = bodyOverride ?? (editMode ? editBody : item.draft_body) ?? ''
      const toPhone = item.contact_phone ?? (deal?.meta?.homeownerPhone as string) ?? ''
      const {
        data: { session },
      } = await supabase.auth.getSession()
      const token = session?.access_token
      const r = await fetch(`${SUPABASE_URL}/functions/v1/send-sms`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${token ?? SUPABASE_KEY}`,
        },
        body: JSON.stringify({
          to: toPhone,
          body: bodyToSend,
          deal_id: item.deal_id,
        }),
      })
      const j = await r.json()
      if (!r.ok) throw new Error(j?.error || 'Send failed')
      const { data: authData } = await supabase.auth.getUser()
      await supabase
        .from('outreach_queue')
        .update({
          status: 'sent',
          sent_at: new Date().toISOString(),
          message_id: j?.id ?? null,
          approved_by: authData?.user?.id ?? null,
          draft_body: bodyToSend,
        })
        .eq('id', item.id)
      setSentInfo({ at: new Date() })
      setEditMode(false)
      onSent?.()
    } catch (e: any) {
      setError(e?.message ?? 'unknown error')
    } finally {
      setIsSend(false)
    }
  }

  async function handleSkip() {
    if (!item) return
    Alert.alert('Skip this draft?', 'Marks the queue row skipped — no SMS sent.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Skip',
        style: 'destructive',
        onPress: async () => {
          await supabase
            .from('outreach_queue')
            .update({ status: 'skipped', skipped_reason: 'manual_skip' })
            .eq('id', item.id)
        },
      },
    ])
  }

  async function handleSaveDraft() {
    if (!item || !editBody.trim()) return
    await supabase
      .from('outreach_queue')
      .update({ draft_body: editBody, status: 'pending' })
      .eq('id', item.id)
    setEditMode(false)
  }

  // Nothing to render
  if (!item && !sentInfo) return null

  // Sent confirmation
  if (sentInfo) {
    return (
      <View style={s.sentBox}>
        <Text style={s.sentEmoji}>✅</Text>
        <View style={{ flex: 1 }}>
          <Text style={s.sentTitle}>
            Text sent at{' '}
            {sentInfo.at.toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </Text>
        </View>
      </View>
    )
  }

  // Hydrate edit body lazily
  if (editMode && !editBody && item?.draft_body) {
    setEditBody(item.draft_body)
  }

  const isLoading = item?.status === 'queued' || item?.status === 'generating' || isGen
  const cadenceLabel = item?.cadence_day === 0
    ? 'Day 0 · Intro'
    : `Day ${item?.cadence_day ?? '?'} · Follow-up`
  const currentBody = editMode ? editBody : item?.draft_body ?? ''
  const charCount = currentBody.length
  const firstName = (((deal?.meta?.homeownerName as string) ?? deal?.name ?? '')
    .split(' - ')[0]
    .split(' ')[0]) || 'them'

  return (
    <View style={s.panel}>
      <View style={s.headerRow}>
        <Text style={s.headerLabel}>🤖 AI DRAFT · {cadenceLabel}</Text>
      </View>

      <View style={s.bodyBlock}>
        {isLoading ? (
          <View style={s.loadingRow}>
            <ActivityIndicator color="#d8b560" />
            <Text style={s.loadingText}>Claude is drafting for {firstName}…</Text>
          </View>
        ) : editMode ? (
          <TextInput
            value={editBody}
            onChangeText={setEditBody}
            multiline
            style={s.editTextArea}
            autoFocus
          />
        ) : (
          <Text style={s.draftBody}>{item?.draft_body || '—'}</Text>
        )}

        {!isLoading && item?.agent_reasoning && !editMode && (
          <Text style={s.reasoning}>Why Claude wrote this: {item.agent_reasoning}</Text>
        )}

        {!isLoading && (
          <Text
            style={[
              s.charCount,
              charCount > 160 && s.charCountOver,
            ]}
          >
            {charCount} chars{charCount > 160 ? ' · will split at punctuation' : ' · fits in 1 text'}
          </Text>
        )}
      </View>

      {!isLoading && (
        <View style={s.coachRow}>
          <TextInput
            value={coachNote}
            onChangeText={setCoachNote}
            placeholder='Coach: "shorter", "friendlier"…'
            placeholderTextColor="#78716c"
            style={s.coachInput}
            returnKeyType="send"
            onSubmitEditing={() => {
              if (coachNote.trim()) {
                void callGenerate(coachNote)
                setCoachNote('')
              }
            }}
          />
          <Pressable
            onPress={() => {
              if (coachNote.trim()) {
                void callGenerate(coachNote)
                setCoachNote('')
              }
            }}
            disabled={!coachNote.trim() || isGen}
            style={({ pressed }) => [
              s.regenBtn,
              (!coachNote.trim() || isGen) && s.regenBtnDisabled,
              pressed && { opacity: 0.7 },
            ]}
          >
            <Text
              style={[
                s.regenBtnText,
                (!coachNote.trim() || isGen) && s.regenBtnTextDisabled,
              ]}
            >
              ↺ Regenerate
            </Text>
          </Pressable>
        </View>
      )}

      {error && <Text style={s.errorText}>⚠ {error}</Text>}

      {!isLoading && (
        <View style={s.actionRow}>
          {editMode ? (
            <>
              <Pressable
                onPress={() => setEditMode(false)}
                style={({ pressed }) => [s.ghostBtn, pressed && { opacity: 0.7 }]}
              >
                <Text style={s.ghostBtnText}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={handleSaveDraft}
                disabled={!editBody.trim()}
                style={({ pressed }) => [
                  s.outlineBtn,
                  !editBody.trim() && s.outlineBtnDisabled,
                  pressed && { opacity: 0.7 },
                ]}
              >
                <Text style={s.outlineBtnText}>💾 Save</Text>
              </Pressable>
              <Pressable
                onPress={() => handleSend(editBody)}
                disabled={isSend || !editBody.trim()}
                style={({ pressed }) => [
                  s.goldBtn,
                  (isSend || !editBody.trim()) && s.goldBtnDisabled,
                  pressed && { opacity: 0.7 },
                ]}
              >
                <Text style={s.goldBtnText}>{isSend ? 'Sending…' : '✓ Send'}</Text>
              </Pressable>
            </>
          ) : (
            <>
              <Pressable
                onPress={handleSkip}
                style={({ pressed }) => [s.ghostBtn, pressed && { opacity: 0.7 }]}
              >
                <Text style={s.ghostBtnText}>Skip</Text>
              </Pressable>
              <Pressable
                onPress={() => {
                  setEditBody(item?.draft_body ?? '')
                  setEditMode(true)
                }}
                style={({ pressed }) => [s.outlineBtn, pressed && { opacity: 0.7 }]}
              >
                <Text style={s.outlineBtnText}>✏ Edit</Text>
              </Pressable>
              <Pressable
                onPress={() => handleSend()}
                disabled={isSend || !item?.draft_body}
                style={({ pressed }) => [
                  s.goldBtn,
                  (isSend || !item?.draft_body) && s.goldBtnDisabled,
                  pressed && { opacity: 0.7 },
                ]}
              >
                <Text style={s.goldBtnText}>
                  {isSend ? 'Sending…' : `✓ Send to ${firstName}`}
                </Text>
              </Pressable>
            </>
          )}
        </View>
      )}

      {/* Training-loop feedback (text_draft + research_grade) */}
      {!isLoading && item?.draft_body && (
        <View style={s.feedbackBlock}>
          <AgentFeedbackWidget
            kind="text_draft"
            label="Rate this draft"
            dealId={dealId}
            outreachQueueId={item.id}
            context={{
              draft_body: item.draft_body,
              cadence_day: item.cadence_day,
              lead_tier: deal?.lead_tier ?? null,
              meta_snapshot: {
                county: deal?.meta?.county ?? null,
                walkerVerified: deal?.meta?.walkerVerified ?? null,
                salePrice: deal?.meta?.salePrice ?? null,
                estimatedSurplus: deal?.meta?.estimatedSurplus ?? null,
                grade: deal?.meta?.grade ?? null,
              },
              agent_reasoning: item.agent_reasoning ?? null,
              source: 'mobile',
            }}
            suggestionPrompt="What should the text have said? (optional)"
          />
          <AgentFeedbackWidget
            kind="research_grade"
            label={`Is "${deal?.lead_tier ?? 'unscored'}" the right grade?`}
            dealId={dealId}
            outreachQueueId={null}
            context={{
              lead_tier: deal?.lead_tier ?? null,
              is_30dts: deal?.is_30dts ?? null,
              meta_snapshot: {
                county: deal?.meta?.county ?? null,
                walkerVerified: deal?.meta?.walkerVerified ?? null,
                isPostAuction: deal?.meta?.isPostAuction ?? null,
                salePrice: deal?.meta?.salePrice ?? null,
                estimatedSurplus: deal?.meta?.estimatedSurplus ?? null,
                grade: deal?.meta?.grade ?? null,
                gradeScore: deal?.meta?.gradeScore ?? null,
                lifecycleStage: deal?.meta?.lifecycleStage ?? null,
                deceased: deal?.meta?.deceased ?? null,
              },
              source: 'mobile',
            }}
            suggestionPrompt='What should it be? e.g. "B — plaintiff deceased"'
          />
        </View>
      )}
    </View>
  )
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  panel: {
    backgroundColor: '#1c1917',
    borderWidth: 1,
    borderColor: '#d8b560',
    borderLeftWidth: 4,
    borderLeftColor: '#d8b560',
    borderRadius: 8,
    marginBottom: 14,
    overflow: 'hidden',
  },
  headerRow: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#292524',
  },
  headerLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#d8b560',
    letterSpacing: 1,
  },
  bodyBlock: {
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  loadingText: {
    color: '#78716c',
    fontSize: 13,
    fontStyle: 'italic',
    marginLeft: 8,
  },
  draftBody: {
    color: '#e7e5e4',
    fontSize: 15,
    lineHeight: 21,
  },
  editTextArea: {
    backgroundColor: '#0c0a09',
    borderWidth: 1,
    borderColor: '#d8b560',
    borderRadius: 6,
    color: '#e7e5e4',
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
    minHeight: 90,
    textAlignVertical: 'top',
  },
  reasoning: {
    marginTop: 8,
    fontSize: 11,
    color: '#57534e',
    fontStyle: 'italic',
  },
  charCount: {
    marginTop: 6,
    fontSize: 10,
    color: '#57534e',
    textAlign: 'right',
  },
  charCountOver: {
    color: '#fbbf24',
  },
  coachRow: {
    paddingHorizontal: 14,
    paddingBottom: 10,
    flexDirection: 'row',
    gap: 8,
  },
  coachInput: {
    flex: 1,
    backgroundColor: '#0c0a09',
    borderWidth: 1,
    borderColor: '#44403c',
    borderRadius: 6,
    color: '#e7e5e4',
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 13,
  },
  regenBtn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#292524',
    borderWidth: 1,
    borderColor: '#44403c',
    borderRadius: 6,
    justifyContent: 'center',
  },
  regenBtnDisabled: {
    backgroundColor: '#1c1917',
  },
  regenBtnText: {
    color: '#e7e5e4',
    fontSize: 12,
    fontWeight: '600',
  },
  regenBtnTextDisabled: {
    color: '#57534e',
  },
  errorText: {
    paddingHorizontal: 14,
    paddingBottom: 8,
    color: '#fca5a5',
    fontSize: 12,
  },
  actionRow: {
    paddingHorizontal: 14,
    paddingBottom: 12,
    flexDirection: 'row',
    gap: 8,
    flexWrap: 'wrap',
  },
  ghostBtn: {
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 6,
    backgroundColor: 'transparent',
  },
  ghostBtnText: {
    color: '#78716c',
    fontSize: 13,
    fontWeight: '600',
  },
  outlineBtn: {
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderWidth: 1,
    borderColor: '#44403c',
    borderRadius: 6,
    backgroundColor: 'transparent',
  },
  outlineBtnDisabled: {
    borderColor: '#292524',
  },
  outlineBtnText: {
    color: '#e7e5e4',
    fontSize: 13,
    fontWeight: '600',
  },
  goldBtn: {
    flex: 1,
    paddingHorizontal: 14,
    paddingVertical: 9,
    backgroundColor: '#d8b560',
    borderRadius: 6,
    alignItems: 'center',
  },
  goldBtnDisabled: {
    backgroundColor: '#44403c',
  },
  goldBtnText: {
    color: '#0c0a09',
    fontSize: 13,
    fontWeight: '700',
  },
  sentBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: '#0a1f14',
    borderWidth: 1,
    borderColor: '#10b981',
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
    marginBottom: 14,
  },
  sentEmoji: {
    fontSize: 18,
  },
  sentTitle: {
    color: '#6ee7b7',
    fontSize: 13,
    fontWeight: '600',
  },
  feedbackBlock: {
    backgroundColor: '#161412',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#292524',
  },
  // Feedback widget styles
  fbContainer: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#292524',
  },
  fbRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  },
  fbLabel: {
    color: '#78716c',
    fontSize: 11,
    fontWeight: '600',
    flexShrink: 1,
  },
  fbBtn: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    backgroundColor: '#1c1917',
    borderWidth: 1,
    borderColor: '#44403c',
    borderRadius: 5,
  },
  fbBtnUpActive: {
    backgroundColor: '#064e3b',
    borderColor: '#10b981',
  },
  fbBtnDownActive: {
    backgroundColor: '#7f1d1d',
    borderColor: '#dc2626',
  },
  fbBtnEmoji: {
    fontSize: 13,
  },
  fbError: {
    color: '#fca5a5',
    fontSize: 10,
    flexShrink: 1,
  },
  fbExpandedForm: {
    marginTop: 8,
    gap: 6,
  },
  fbInput: {
    backgroundColor: '#0c0a09',
    borderWidth: 1,
    borderColor: '#44403c',
    borderRadius: 5,
    color: '#e7e5e4',
    paddingHorizontal: 9,
    paddingVertical: 7,
    fontSize: 12,
  },
  fbActionRow: {
    flexDirection: 'row',
    gap: 6,
    marginTop: 2,
  },
  fbLogBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: '#7f1d1d',
    borderWidth: 1,
    borderColor: '#dc2626',
    borderRadius: 5,
  },
  fbLogBtnDisabled: {
    backgroundColor: '#1c1917',
    borderColor: '#44403c',
  },
  fbLogBtnText: {
    color: '#fca5a5',
    fontSize: 12,
    fontWeight: '600',
  },
  fbLogBtnTextDisabled: {
    color: '#57534e',
  },
  fbCancelBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: '#44403c',
    borderRadius: 5,
  },
  fbCancelText: {
    color: '#78716c',
    fontSize: 12,
  },
  fbConfirmRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#292524',
  },
  fbConfirmEmoji: {
    fontSize: 12,
  },
  fbConfirmText: {
    color: '#78716c',
    fontSize: 11,
  },
})
