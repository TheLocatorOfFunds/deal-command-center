/**
 * Lauren tab — persistent AI chat synced to team_messages.
 *
 * Each user has an ongoing `lauren_dm` thread in team_threads. Messages
 * live in team_messages so the conversation:
 *   - Survives app restarts and reinstalls
 *   - Shows up in Nathan's web "Ask Lauren" panel
 *   - Stays in sync across devices via Supabase realtime
 *
 * Flow on send:
 *   1. Insert the user's message into team_messages (sender_kind='admin').
 *   2. POST the full conversation to the `lauren-internal` Edge Function
 *      (admin-only, has read-only DCC tools).
 *   3. Insert Lauren's reply into team_messages (sender_kind='lauren',
 *      sender_id=null).
 *   4. Realtime subscription picks up both inserts and renders them.
 *
 * "New chat" archives the current thread and creates a fresh one,
 * mirroring the web app's pattern.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useLocalSearchParams } from 'expo-router'
import { supabase, chanName } from '../../lib/supabase'
import { useAuth } from '../../lib/auth'

type Msg = {
  id: string
  thread_id: string
  sender_id: string | null
  sender_kind: string
  body: string
  created_at: string
}

const LAUREN_URL =
  'https://rcfaashkfpurkvtmsmeb.supabase.co/functions/v1/lauren-internal'

export default function LaurenScreen() {
  const { session } = useAuth()
  const userId = session?.user?.id ?? null
  const listRef = useRef<FlatList<Msg>>(null)
  const params = useLocalSearchParams<{ seed?: string }>()

  const [threadId, setThreadId] = useState<string | null>(null)
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // ── Find-or-create the user's lauren_dm thread ─────────────────────
  const ensureThread = useCallback(async (): Promise<string | null> => {
    if (!userId) return null
    const { data: existing, error: findErr } = await supabase
      .from('team_threads')
      .select('id')
      .eq('thread_type', 'lauren_dm')
      .eq('created_by', userId)
      .is('archived_at', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (findErr) {
      setError(findErr.message)
      return null
    }
    if (existing?.id) return existing.id as string

    const { data: created, error: createErr } = await supabase
      .from('team_threads')
      .insert({
        title: '🤖 Ask Lauren',
        thread_type: 'lauren_dm',
        lauren_enabled: true,
        created_by: userId,
      })
      .select('id')
      .single()
    if (createErr || !created) {
      setError(createErr?.message ?? 'Could not create thread')
      return null
    }
    await supabase
      .from('team_thread_participants')
      .upsert(
        { thread_id: created.id, user_id: userId },
        { onConflict: 'thread_id,user_id' },
      )
    return created.id as string
  }, [userId])

  // ── Initial load (resolve thread + pull history) ───────────────────
  const load = useCallback(async () => {
    setError(null)
    const tid = await ensureThread()
    if (!tid) {
      setLoading(false)
      return
    }
    setThreadId(tid)
    const { data: history } = await supabase
      .from('team_messages')
      .select(
        'id, thread_id, sender_id, sender_kind, body, created_at, deleted_at',
      )
      .eq('thread_id', tid)
      .is('deleted_at', null)
      .order('created_at', { ascending: true })
      .limit(500)
    setMsgs((history ?? []) as Msg[])
    setLoading(false)
    setTimeout(() => listRef.current?.scrollToEnd({ animated: false }), 0)
  }, [ensureThread])

  useEffect(() => {
    load()
  }, [load])

  // When the user navigates here with a ?seed= param (e.g. from
  // Deal Detail's "Ask Lauren about this deal"), pre-fill the
  // composer so they can just tap Send (or edit first).
  useEffect(() => {
    if (params.seed && !draft) {
      setDraft(String(params.seed))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.seed])

  // ── Realtime — new messages on this thread ─────────────────────────
  useEffect(() => {
    if (!threadId) return
    const channel = supabase
      .channel(chanName(`lauren-thread-${threadId}`))
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'team_messages',
          filter: `thread_id=eq.${threadId}`,
        },
        (payload) => {
          const m = payload.new as Msg & { deleted_at?: string | null }
          if (m.deleted_at) return
          setMsgs((prev) =>
            prev.some((x) => x.id === m.id) ? prev : [...prev, m],
          )
          setTimeout(
            () => listRef.current?.scrollToEnd({ animated: true }),
            50,
          )
        },
      )
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
  }, [threadId])

  // ── Send: write user msg → ask Lauren → write Lauren msg ────────────
  const send = useCallback(async () => {
    const body = draft.trim()
    if (!body || sending || !threadId || !userId) return
    setSending(true)
    setDraft('')
    try {
      const { error: insertErr } = await supabase.from('team_messages').insert({
        thread_id: threadId,
        sender_id: userId,
        sender_kind: 'admin',
        body,
      })
      if (insertErr) throw insertErr

      const wireMessages = [
        ...msgs.map((m) => ({
          role: m.sender_kind === 'lauren' ? 'assistant' : 'user',
          content: m.body,
        })),
        { role: 'user', content: body },
      ]
      const { data: sessionData } = await supabase.auth.getSession()
      const token = sessionData.session?.access_token
      if (!token) throw new Error('Not signed in')
      const res = await fetch(LAUREN_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ messages: wireMessages }),
      })
      const payload = (await res.json().catch(() => ({}))) as {
        reply?: string
        error?: string
      }
      if (!res.ok) {
        throw new Error(payload.error || `HTTP ${res.status}`)
      }
      const reply = (payload.reply ?? '').trim()
      if (!reply) throw new Error('Empty response from Lauren')

      const { error: replyInsertErr } = await supabase
        .from('team_messages')
        .insert({
          thread_id: threadId,
          sender_id: null,
          sender_kind: 'lauren',
          body: reply,
        })
      if (replyInsertErr) throw replyInsertErr
    } catch (e) {
      Alert.alert(
        'Lauren error',
        e instanceof Error ? e.message : 'Unknown error',
      )
      setDraft(body)
    } finally {
      setSending(false)
    }
  }, [draft, sending, threadId, userId, msgs])

  // ── New chat: archive current thread, create a fresh one ───────────
  const newChat = useCallback(async () => {
    if (!threadId) return
    Alert.alert(
      'Start new chat?',
      'This will archive the current Lauren conversation and start fresh. The history stays accessible from the web app.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'New chat',
          style: 'destructive',
          onPress: async () => {
            await supabase
              .from('team_threads')
              .update({ archived_at: new Date().toISOString() })
              .eq('id', threadId)
            setThreadId(null)
            setMsgs([])
            setLoading(true)
            await load()
          },
        },
      ],
    )
  }, [threadId, load])

  return (
    <SafeAreaView style={styles.container} edges={['left', 'right', 'top']}>
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle}>Lauren</Text>
          <Text style={styles.headerSubtitle}>
            Case AI · synced to your web Ask Lauren
          </Text>
        </View>
        {msgs.length > 0 && (
          <TouchableOpacity onPress={newChat} style={styles.clearBtn}>
            <Text style={styles.clearBtnText}>New chat</Text>
          </TouchableOpacity>
        )}
      </View>

      {loading ? (
        <View style={styles.loading}>
          <ActivityIndicator color="#d97706" />
        </View>
      ) : error ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>⚠ {error}</Text>
          <TouchableOpacity onPress={load} style={styles.retry}>
            <Text style={styles.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={Platform.OS === 'ios' ? 88 : 0}
        >
          <FlatList
            ref={listRef}
            data={msgs}
            keyExtractor={(m) => m.id}
            contentContainerStyle={styles.list}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            onContentSizeChange={() =>
              listRef.current?.scrollToEnd({ animated: false })
            }
            ListEmptyComponent={
              <View style={styles.empty}>
                <Text style={styles.emptyTitle}>Ask Lauren anything</Text>
                <Text style={styles.emptyHint}>
                  {`Try:\n• "What's the status of sf-creech?"\n• "Which deals are filed but not yet served?"\n• "Summarize my surplus pipeline"`}
                </Text>
              </View>
            }
            renderItem={({ item }) => {
              const mine = item.sender_id === userId
              const isLauren = item.sender_kind === 'lauren'
              return (
                <View
                  style={[
                    styles.bubble,
                    mine ? styles.bubbleOut : styles.bubbleIn,
                  ]}
                >
                  <Text
                    style={mine ? styles.bubbleTextOut : styles.bubbleTextIn}
                  >
                    {item.body}
                  </Text>
                  <Text style={styles.bubbleMeta}>
                    {isLauren ? 'Lauren · ' : ''}
                    {formatRelative(item.created_at)}
                  </Text>
                </View>
              )
            }}
            ListFooterComponent={
              sending ? (
                <View style={[styles.bubble, styles.bubbleIn, styles.thinking]}>
                  <ActivityIndicator color="#a8a29e" size="small" />
                  <Text style={styles.thinkingText}>Lauren is thinking…</Text>
                </View>
              ) : null
            }
          />

          {/* Suggested prompts — show only when conversation is empty
              and not currently sending. One-tap to seed common questions. */}
          {msgs.length === 0 && !sending && (
            <View style={styles.suggestRow}>
              {[
                'What deals need attention today?',
                'Summarize my surplus pipeline',
                'Which cases have upcoming hearings?',
              ].map((s) => (
                <TouchableOpacity
                  key={s}
                  style={styles.suggestChip}
                  onPress={() => setDraft(s)}
                >
                  <Text style={styles.suggestText} numberOfLines={1}>
                    {s}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          )}

          <View style={styles.composer}>
            <TextInput
              style={styles.composerInput}
              value={draft}
              onChangeText={setDraft}
              placeholder="Ask Lauren…"
              placeholderTextColor="#78716c"
              multiline
              editable={!sending}
            />
            <TouchableOpacity
              style={[
                styles.sendBtn,
                (!draft.trim() || sending) && styles.sendBtnDisabled,
              ]}
              onPress={send}
              disabled={!draft.trim() || sending}
            >
              <Text style={styles.sendBtnText}>{sending ? '…' : 'Send'}</Text>
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      )}
    </SafeAreaView>
  )
}

function formatRelative(iso: string): string {
  if (!iso) return ''
  const then = new Date(iso).getTime()
  const now = Date.now()
  const sec = Math.max(0, Math.floor((now - then) / 1000))
  if (sec < 60) return 'just now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 7) return `${day}d ago`
  return new Date(iso).toLocaleDateString()
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0c0a09' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    paddingBottom: 10,
    borderBottomColor: '#1c1917',
    borderBottomWidth: 1,
  },
  headerTitle: { color: '#fafaf9', fontSize: 22, fontWeight: '700' },
  headerSubtitle: { color: '#78716c', fontSize: 12, marginTop: 2 },
  clearBtn: {
    backgroundColor: '#1c1917',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },
  clearBtnText: { color: '#a8a29e', fontSize: 12, fontWeight: '600' },
  loading: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  errorBox: {
    margin: 14,
    padding: 14,
    backgroundColor: '#7f1d1d',
    borderRadius: 10,
  },
  errorText: { color: '#fca5a5', fontSize: 14 },
  retry: {
    marginTop: 10,
    backgroundColor: '#0c0a09',
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center',
  },
  retryText: { color: '#fca5a5', fontSize: 14, fontWeight: '600' },
  list: { padding: 14, paddingBottom: 4 },
  empty: { padding: 30, alignItems: 'center' },
  emptyTitle: {
    color: '#d97706',
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 12,
  },
  emptyHint: {
    color: '#78716c',
    fontSize: 14,
    textAlign: 'left',
    lineHeight: 22,
  },
  bubble: {
    maxWidth: '85%',
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 8,
  },
  bubbleOut: {
    alignSelf: 'flex-end',
    backgroundColor: '#d97706',
  },
  bubbleIn: {
    alignSelf: 'flex-start',
    backgroundColor: '#1c1917',
    borderColor: '#7c3aed',
    borderWidth: 1,
  },
  bubbleTextOut: { color: '#0c0a09', fontSize: 15, lineHeight: 21 },
  bubbleTextIn: { color: '#fafaf9', fontSize: 15, lineHeight: 21 },
  bubbleMeta: {
    color: '#78716c',
    fontSize: 10,
    marginTop: 4,
    opacity: 0.85,
  },
  thinking: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 10,
  },
  thinkingText: { color: '#a8a29e', fontSize: 13, fontStyle: 'italic' },
  suggestRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  suggestChip: {
    backgroundColor: '#1c1917',
    borderColor: '#7c3aed44',
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  suggestText: { color: '#d6d3d1', fontSize: 12, fontWeight: '500' },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 10,
    paddingVertical: 8,
    paddingBottom: 12,
    borderTopColor: '#1c1917',
    borderTopWidth: 1,
    backgroundColor: '#0c0a09',
    gap: 8,
  },
  composerInput: {
    flex: 1,
    minHeight: 40,
    maxHeight: 140,
    backgroundColor: '#1c1917',
    borderColor: '#292524',
    borderWidth: 1,
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 10,
    color: '#fafaf9',
    fontSize: 15,
  },
  sendBtn: {
    backgroundColor: '#d97706',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 18,
    justifyContent: 'center',
    alignItems: 'center',
  },
  sendBtnDisabled: { backgroundColor: '#292524' },
  sendBtnText: { color: '#0c0a09', fontWeight: '700', fontSize: 14 },
})
