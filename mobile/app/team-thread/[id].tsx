/**
 * Team chat thread — message history + composer for one team_threads row.
 *
 * Realtime: subscribes to `team_messages` inserts on this thread so new
 * messages appear without polling. Pairs nicely with push notifications
 * (PR #139) — push pings you when the app is backgrounded; realtime
 * keeps things fresh when the app is open.
 *
 * Send: writes directly to `team_messages` from the client (no Edge
 * Function needed). RLS verifies sender_id = auth.uid() and that the
 * user is admin/va. sender_kind comes from the user's profile role.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { Stack, useLocalSearchParams } from 'expo-router'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../lib/auth'

type Thread = {
  id: string
  title: string
  thread_type: string
  lauren_enabled: boolean
}

type Msg = {
  id: string
  thread_id: string
  sender_id: string | null
  sender_kind: string
  body: string
  created_at: string
  deleted_at: string | null
}

type Profile = {
  id: string
  name: string | null
  display_name: string | null
}

export default function TeamThreadScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const { session } = useAuth()
  const userId = session?.user?.id ?? null
  const listRef = useRef<FlatList<Msg>>(null)

  const [thread, setThread] = useState<Thread | null>(null)
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [authors, setAuthors] = useState<Map<string, Profile>>(new Map())
  const [myKind, setMyKind] = useState<'admin' | 'va'>('admin')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)

  // ── Initial load ───────────────────────────────────────────────────
  const load = useCallback(async () => {
    if (!id) return
    setError(null)
    const [thRes, msgRes, meRes] = await Promise.all([
      supabase
        .from('team_threads')
        .select('id, title, thread_type, lauren_enabled')
        .eq('id', id)
        .maybeSingle(),
      supabase
        .from('team_messages')
        .select(
          'id, thread_id, sender_id, sender_kind, body, created_at, deleted_at',
        )
        .eq('thread_id', id)
        .is('deleted_at', null)
        .order('created_at', { ascending: true })
        .limit(500),
      userId
        ? supabase
            .from('profiles')
            .select('id, role')
            .eq('id', userId)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    ])
    if (thRes.error) {
      setError(thRes.error.message)
      setLoading(false)
      return
    }
    if (msgRes.error) {
      setError(msgRes.error.message)
      setLoading(false)
      return
    }
    setThread((thRes.data as Thread | null) ?? null)
    const newMsgs = (msgRes.data ?? []) as Msg[]
    setMsgs(newMsgs)
    setMyKind(
      (meRes.data as { role?: string } | null)?.role === 'va' ? 'va' : 'admin',
    )

    // Hydrate author profiles (for nice names in the bubbles)
    const ids = Array.from(
      new Set(newMsgs.map((m) => m.sender_id).filter((x): x is string => !!x)),
    )
    if (ids.length > 0) {
      const { data: profs } = await supabase
        .from('profiles')
        .select('id, name, display_name')
        .in('id', ids)
      const map = new Map<string, Profile>()
      for (const p of profs ?? []) {
        map.set(p.id as string, {
          id: p.id as string,
          name: (p.name as string) ?? null,
          display_name: (p.display_name as string) ?? null,
        })
      }
      setAuthors(map)
    }

    setLoading(false)
    // Scroll to bottom after first render
    setTimeout(() => listRef.current?.scrollToEnd({ animated: false }), 0)
  }, [id, userId])

  useEffect(() => {
    load()
  }, [load])

  // ── Realtime: new messages on this thread ──────────────────────────
  useEffect(() => {
    if (!id) return
    const channel = supabase
      .channel(`team-thread-${id}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'team_messages',
          filter: `thread_id=eq.${id}`,
        },
        (payload) => {
          const m = payload.new as Msg
          if (m.deleted_at) return
          setMsgs((prev) => {
            if (prev.some((x) => x.id === m.id)) return prev
            return [...prev, m]
          })
          // Hydrate author lazily if we don't have them yet
          if (m.sender_id && !authors.has(m.sender_id)) {
            supabase
              .from('profiles')
              .select('id, name, display_name')
              .eq('id', m.sender_id)
              .maybeSingle()
              .then(({ data }) => {
                if (data) {
                  setAuthors((prev) => {
                    const next = new Map(prev)
                    next.set(data.id as string, {
                      id: data.id as string,
                      name: (data.name as string) ?? null,
                      display_name: (data.display_name as string) ?? null,
                    })
                    return next
                  })
                }
              })
          }
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
  }, [id, authors])

  const send = async () => {
    const body = draft.trim()
    if (!body || sending || !userId || !id) return
    setSending(true)
    try {
      const { error: err } = await supabase.from('team_messages').insert({
        thread_id: id,
        sender_id: userId,
        sender_kind: myKind,
        body,
      })
      if (err) throw err
      setDraft('')
      // The realtime sub will append it for us, but reload as a safety net
      // in case the subscription is slow
      setTimeout(() => load(), 200)
    } catch (e) {
      Alert.alert(
        'Send failed',
        e instanceof Error ? e.message : 'Unknown error',
      )
    } finally {
      setSending(false)
    }
  }

  const title = useMemo(() => {
    if (!thread) return id ?? 'Thread'
    return (thread.thread_type === 'channel' ? '# ' : '') + thread.title
  }, [thread, id])

  return (
    <SafeAreaView style={styles.container} edges={['left', 'right']}>
      <Stack.Screen
        options={{
          title,
          headerStyle: { backgroundColor: '#0c0a09' },
          headerTintColor: '#fafaf9',
        }}
      />

      {loading ? (
        <View style={styles.loading}>
          <ActivityIndicator color="#d97706" />
        </View>
      ) : error ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>⚠ {error}</Text>
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
            onContentSizeChange={() =>
              listRef.current?.scrollToEnd({ animated: false })
            }
            ListEmptyComponent={
              <View style={styles.empty}>
                <Text style={styles.emptyText}>
                  No messages yet. Be the first.
                </Text>
              </View>
            }
            renderItem={({ item }) => {
              const mine = item.sender_id && item.sender_id === userId
              const isLauren = item.sender_kind === 'lauren'
              const authorName = item.sender_id
                ? authors.get(item.sender_id)?.display_name ||
                  authors.get(item.sender_id)?.name ||
                  'team'
                : isLauren
                  ? 'Lauren'
                  : 'system'
              return (
                <View style={{ marginBottom: 8 }}>
                  {!mine && (
                    <Text style={styles.authorLabel}>
                      {authorName}
                      {isLauren ? ' 🤖' : ''}
                    </Text>
                  )}
                  <View
                    style={[
                      styles.bubble,
                      mine
                        ? styles.bubbleOut
                        : isLauren
                          ? styles.bubbleLauren
                          : styles.bubbleIn,
                    ]}
                  >
                    <Text
                      style={
                        mine
                          ? styles.bubbleTextOut
                          : isLauren
                            ? styles.bubbleTextLauren
                            : styles.bubbleTextIn
                      }
                    >
                      {item.body}
                    </Text>
                    <Text style={styles.bubbleMeta}>
                      {formatRelative(item.created_at)}
                    </Text>
                  </View>
                </View>
              )
            }}
          />

          <View style={styles.composer}>
            <TextInput
              style={styles.composerInput}
              value={draft}
              onChangeText={setDraft}
              placeholder="Message the team…"
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
              <Text style={styles.sendBtnText}>
                {sending ? '…' : 'Send'}
              </Text>
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
  loading: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  errorBox: {
    margin: 14,
    padding: 14,
    backgroundColor: '#7f1d1d',
    borderRadius: 10,
  },
  errorText: { color: '#fca5a5', fontSize: 14 },
  list: { padding: 14, paddingBottom: 4 },
  empty: { padding: 40, alignItems: 'center' },
  emptyText: { color: '#78716c', fontSize: 14, textAlign: 'center' },
  authorLabel: {
    color: '#78716c',
    fontSize: 11,
    marginLeft: 4,
    marginBottom: 2,
    fontWeight: '600',
  },
  bubble: {
    maxWidth: '80%',
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  bubbleOut: {
    alignSelf: 'flex-end',
    backgroundColor: '#d97706',
  },
  bubbleIn: {
    alignSelf: 'flex-start',
    backgroundColor: '#1c1917',
    borderColor: '#292524',
    borderWidth: 1,
  },
  bubbleLauren: {
    alignSelf: 'flex-start',
    backgroundColor: '#1c1917',
    borderColor: '#7c3aed',
    borderWidth: 1,
  },
  bubbleTextOut: { color: '#0c0a09', fontSize: 15, lineHeight: 20 },
  bubbleTextIn: { color: '#fafaf9', fontSize: 15, lineHeight: 20 },
  bubbleTextLauren: { color: '#fafaf9', fontSize: 15, lineHeight: 20 },
  bubbleMeta: {
    color: '#78716c',
    fontSize: 10,
    marginTop: 4,
    opacity: 0.85,
  },
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
