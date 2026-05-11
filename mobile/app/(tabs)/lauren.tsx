/**
 * Lauren tab — internal AI chat surface.
 *
 * Wires into the `lauren-internal` Edge Function (Castle's hardened
 * version with read-only tools: search_deals, list_deals, get_deal,
 * get_deal_documents, get_docket_events, get_deal_notes, get_tasks,
 * summarize_portfolio). Same code path the web app uses.
 *
 * v1 design choice: stateless. Each tab session keeps the conversation
 * in component memory; clearing or signing out resets the chat. The
 * lauren-internal function persists to `lauren_sessions` via its
 * session_id parameter, so we round-trip that so multiple sends in a
 * row share the same logical session.
 *
 * Persisting Lauren chats in `team_messages` (as lauren_dm threads) is
 * a v2 follow-up — gives cross-device history and matches the web app's
 * Ask Lauren panel. Until then, mobile Lauren is opinionated as
 * ephemeral: ask, get answer, move on.
 */

import { useCallback, useRef, useState } from 'react'
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
import { supabase } from '../../lib/supabase'

type Msg = {
  id: string
  role: 'user' | 'assistant'
  content: string
}

const LAUREN_URL =
  'https://rcfaashkfpurkvtmsmeb.supabase.co/functions/v1/lauren-internal'

export default function LaurenScreen() {
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const listRef = useRef<FlatList<Msg>>(null)

  const send = useCallback(async () => {
    const body = draft.trim()
    if (!body || sending) return

    // Optimistically append the user's message
    const userMsg: Msg = {
      id: `u-${Date.now()}`,
      role: 'user',
      content: body,
    }
    setMsgs((prev) => [...prev, userMsg])
    setDraft('')
    setSending(true)
    setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 50)

    try {
      const { data: sessionData } = await supabase.auth.getSession()
      const token = sessionData.session?.access_token
      if (!token) throw new Error('Not signed in')

      // Build the message history for Anthropic — strip our placeholder
      // ids, just role + content.
      const wireMessages = [...msgs, userMsg].map((m) => ({
        role: m.role,
        content: m.content,
      }))

      const res = await fetch(LAUREN_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messages: wireMessages,
          session_id: sessionId,
        }),
      })
      const payload = (await res.json().catch(() => ({}))) as {
        reply?: string
        session_id?: string
        error?: string
      }
      if (!res.ok) {
        throw new Error(payload.error || `HTTP ${res.status}`)
      }
      const reply = (payload.reply ?? '').trim()
      if (!reply) {
        throw new Error('Empty response from Lauren')
      }
      if (payload.session_id) setSessionId(payload.session_id)

      setMsgs((prev) => [
        ...prev,
        {
          id: `a-${Date.now()}`,
          role: 'assistant',
          content: reply,
        },
      ])
      setTimeout(
        () => listRef.current?.scrollToEnd({ animated: true }),
        50,
      )
    } catch (e) {
      Alert.alert(
        'Lauren error',
        e instanceof Error ? e.message : 'Unknown error',
      )
      // Roll back the user's message so they can retry
      setMsgs((prev) => prev.filter((m) => m.id !== userMsg.id))
      setDraft(body)
    } finally {
      setSending(false)
    }
  }, [draft, msgs, sending, sessionId])

  const reset = () => {
    setMsgs([])
    setSessionId(null)
    setDraft('')
  }

  return (
    <SafeAreaView style={styles.container} edges={['left', 'right', 'top']}>
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle}>Lauren</Text>
          <Text style={styles.headerSubtitle}>
            Case AI · ask about deals, docket, contacts
          </Text>
        </View>
        {msgs.length > 0 && (
          <TouchableOpacity onPress={reset} style={styles.clearBtn}>
            <Text style={styles.clearBtnText}>New chat</Text>
          </TouchableOpacity>
        )}
      </View>

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
              <Text style={styles.emptyTitle}>Ask Lauren anything</Text>
              <Text style={styles.emptyHint}>
                {`Try:\n• "What's the status of sf-creech?"\n• "Which deals are filed but not yet served?"\n• "Summarize my surplus pipeline"`}
              </Text>
            </View>
          }
          renderItem={({ item }) => {
            const mine = item.role === 'user'
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
                  {item.content}
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
    </SafeAreaView>
  )
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
  thinking: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 10,
  },
  thinkingText: { color: '#a8a29e', fontSize: 13, fontStyle: 'italic' },
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
