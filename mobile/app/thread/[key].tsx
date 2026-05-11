/**
 * Thread view — full message history for one SMS/iMessage thread.
 *
 * Routed via /thread/{thread_key}. Three regions:
 *   1. Header: contact name + linked deal (tappable → Deal Detail)
 *   2. Message list (oldest top → newest bottom, auto-scroll on send)
 *   3. Composer: text input + Send button. Send hits the existing
 *      `send-sms` Edge Function, which handles Twilio + DND + segment
 *      splitting + read-state, same code path as the web app.
 *
 * thread_key formats:
 *   - `{deal_id}:contact:{contact_id}` — known contact on a deal
 *   - `{deal_id}:phone:{e164_number}`  — unknown number on a deal
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
import { Stack, useLocalSearchParams, useRouter } from 'expo-router'
import { supabase } from '../../lib/supabase'

type Msg = {
  id: string
  deal_id: string | null
  contact_id: string | null
  direction: string | null
  from_number: string | null
  to_number: string | null
  body: string | null
  status: string | null
  channel: string | null
  created_at: string | null
}

type ContactRow = {
  id: string
  name: string | null
  company: string | null
  phone: string | null
}

type DealRow = {
  id: string
  name: string | null
  status: string | null
  type: string | null
}

const SEND_SMS_URL =
  'https://rcfaashkfpurkvtmsmeb.supabase.co/functions/v1/send-sms'

function parseThreadKey(key: string): {
  dealId: string | null
  contactId: string | null
  phone: string | null
} {
  const parts = key.split(':')
  if (parts.length < 3) return { dealId: null, contactId: null, phone: null }
  const [dealId, kind, rest] = parts
  if (kind === 'contact') return { dealId, contactId: rest, phone: null }
  if (kind === 'phone') return { dealId, contactId: null, phone: rest }
  return { dealId, contactId: null, phone: null }
}

export default function ThreadScreen() {
  const router = useRouter()
  const { key } = useLocalSearchParams<{ key: string }>()
  const decoded = useMemo(
    () => (key ? decodeURIComponent(key) : ''),
    [key],
  )
  const parts = useMemo(() => parseThreadKey(decoded), [decoded])

  const [msgs, setMsgs] = useState<Msg[]>([])
  const [contact, setContact] = useState<ContactRow | null>(null)
  const [deal, setDeal] = useState<DealRow | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const listRef = useRef<FlatList<Msg>>(null)

  const load = useCallback(async () => {
    if (!decoded) return
    setError(null)
    const [msgRes, contactRes, dealRes] = await Promise.all([
      supabase
        .from('messages_outbound')
        .select(
          'id, deal_id, contact_id, direction, from_number, to_number, body, status, channel, created_at',
        )
        .eq('thread_key', decoded)
        .order('created_at', { ascending: true })
        .limit(500),
      parts.contactId
        ? supabase
            .from('contacts')
            .select('id, name, company, phone')
            .eq('id', parts.contactId)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      parts.dealId
        ? supabase
            .from('deals')
            .select('id, name, status, type')
            .eq('id', parts.dealId)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    ])
    if (msgRes.error) {
      setError(msgRes.error.message)
      setLoading(false)
      return
    }
    setMsgs((msgRes.data ?? []) as Msg[])
    setContact((contactRes.data as ContactRow | null) ?? null)
    setDeal((dealRes.data as DealRow | null) ?? null)
    setLoading(false)
    // Mark inbound messages read (best-effort)
    try {
      await supabase
        .from('messages_outbound')
        .update({ read_by_team_at: new Date().toISOString() })
        .eq('thread_key', decoded)
        .eq('direction', 'inbound')
        .is('read_by_team_at', null)
    } catch {
      // non-fatal
    }
  }, [decoded, parts.contactId, parts.dealId])

  useEffect(() => {
    load()
  }, [load])

  // Realtime: append new messages on this thread as they arrive. Pairs
  // with push notifications — push pings you when backgrounded, this
  // keeps the open thread fresh.
  useEffect(() => {
    if (!decoded) return
    const channel = supabase
      .channel(`sms-thread-${decoded}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'messages_outbound',
          filter: `thread_key=eq.${decoded}`,
        },
        (payload) => {
          const m = payload.new as Msg
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
  }, [decoded])

  // Resolve destination phone: prefer the contact's phone, fall back to
  // the most-recent inbound message's from_number, then the thread_key
  // phone segment.
  const destinationPhone = useMemo(() => {
    if (contact?.phone) return contact.phone
    const lastInbound = [...msgs]
      .reverse()
      .find((m) => m.direction === 'inbound')
    if (lastInbound?.from_number) return lastInbound.from_number
    if (parts.phone) return parts.phone
    return null
  }, [contact, msgs, parts.phone])

  const send = async () => {
    const body = draft.trim()
    if (!body || sending) return
    if (!destinationPhone) {
      Alert.alert('Cannot send', 'No phone number found for this thread.')
      return
    }
    setSending(true)
    try {
      const { data: sessionData } = await supabase.auth.getSession()
      const token = sessionData.session?.access_token
      if (!token) throw new Error('Not signed in')
      const res = await fetch(SEND_SMS_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          to: destinationPhone,
          body,
          deal_id: parts.dealId,
          contact_id: parts.contactId,
        }),
      })
      const payload = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(
          payload.error
            ? `${payload.error}${payload.details ? ` — ${payload.details}` : ''}`
            : `HTTP ${res.status}`,
        )
      }
      setDraft('')
      // Reload to show the new message; in v1.1 we'll add realtime
      await load()
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 50)
    } catch (e) {
      Alert.alert(
        'Send failed',
        e instanceof Error ? e.message : 'Unknown error',
      )
    } finally {
      setSending(false)
    }
  }

  const headerName = contact?.name || destinationPhone || '(unknown)'
  const headerSub =
    contact?.company || (deal?.name ?? deal?.id ?? '')

  return (
    <SafeAreaView style={styles.container} edges={['left', 'right']}>
      <Stack.Screen
        options={{
          title: headerName,
          headerStyle: { backgroundColor: '#0c0a09' },
          headerTintColor: '#fafaf9',
        }}
      />
      {/* Sticky deal context card — tap to drill into deal detail */}
      {deal && (
        <TouchableOpacity
          style={styles.contextCard}
          activeOpacity={0.6}
          onPress={() => router.push(`/deal/${deal.id}`)}
        >
          <View style={{ flex: 1 }}>
            <Text style={styles.contextTitle}>{deal.name ?? deal.id}</Text>
            <Text style={styles.contextSub}>
              {[deal.type, deal.status].filter(Boolean).join(' · ')}
            </Text>
          </View>
          <Text style={styles.contextChev}>›</Text>
        </TouchableOpacity>
      )}

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
                  No messages in this thread yet. Send one below.
                </Text>
              </View>
            }
            renderItem={({ item }) => {
              const outbound = item.direction === 'outbound'
              return (
                <View
                  style={[
                    styles.bubble,
                    outbound ? styles.bubbleOut : styles.bubbleIn,
                  ]}
                >
                  <Text
                    style={outbound ? styles.bubbleTextOut : styles.bubbleTextIn}
                  >
                    {item.body ?? ''}
                  </Text>
                  <Text style={styles.bubbleMeta}>
                    {formatRelative(item.created_at ?? '')}
                    {item.status && item.status !== 'sent' && outbound
                      ? ` · ${item.status}`
                      : ''}
                  </Text>
                </View>
              )
            }}
          />

          <View style={styles.composer}>
            <TextInput
              style={styles.composerInput}
              value={draft}
              onChangeText={setDraft}
              placeholder={
                destinationPhone
                  ? `Reply to ${destinationPhone}`
                  : 'Reply…'
              }
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
  contextCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1c1917',
    borderBottomColor: '#292524',
    borderBottomWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  contextTitle: { color: '#fafaf9', fontSize: 14, fontWeight: '600' },
  contextSub: { color: '#a8a29e', fontSize: 11, marginTop: 2 },
  contextChev: { color: '#78716c', fontSize: 24, marginLeft: 8 },
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
  bubble: {
    maxWidth: '80%',
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginBottom: 8,
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
  bubbleTextOut: { color: '#0c0a09', fontSize: 15, lineHeight: 20 },
  bubbleTextIn: { color: '#fafaf9', fontSize: 15, lineHeight: 20 },
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
