/**
 * Inbox tab — default landing screen. Unified SMS thread list across all
 * deals. Communication-led pattern (matches Close, LeadConnector,
 * Twilio Frontline) — the first thing Justin sees when he opens the app
 * is "who's been talking to us."
 *
 * Data: `messages_outbound` is misnamed — it stores BOTH outbound and
 * inbound messages (direction column). Threads are grouped by
 * `thread_key` which is either `{deal_id}:contact:{contact_id}` (for
 * known contacts) or `{deal_id}:phone:{phone}` (for unknown phones on a
 * known deal).
 *
 * We pull the most recent 200 messages and group client-side. Good
 * enough for the team's volume; if it ever gets noisy we'll add a
 * Postgres view that does the distinct-on at the DB level.
 *
 * v1.1 will add: unread badge, per-thread "mark all read", swipe
 * gestures. For now the simplest thing that proves the pattern.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../lib/auth'

type Msg = {
  id: string
  deal_id: string | null
  contact_id: string | null
  thread_key: string | null
  direction: string | null
  to_number: string | null
  from_number: string | null
  body: string | null
  channel: string | null
  status: string | null
  created_at: string | null
  read_by_team_at: string | null
}

type Thread = {
  threadKey: string
  dealId: string | null
  contactId: string | null
  contactName: string | null
  contactCompany: string | null
  phone: string | null
  lastMessage: string
  lastDirection: string
  lastAt: string
  unread: boolean
  channel: string
}

export default function InboxScreen() {
  const { session, signOut } = useAuth()
  const router = useRouter()
  const [threads, setThreads] = useState<Thread[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError(null)
    // Pull last 200 messages; group client-side. Faster than a window
    // function for our volume and avoids a server-side view we'd have
    // to migrate.
    const { data, error: err } = await supabase
      .from('messages_outbound')
      .select(
        'id, deal_id, contact_id, thread_key, direction, to_number, from_number, body, channel, status, created_at, read_by_team_at',
      )
      .not('thread_key', 'is', null)
      .order('created_at', { ascending: false })
      .limit(200)

    if (err) {
      setError(err.message)
      setThreads([])
      setLoading(false)
      setRefreshing(false)
      return
    }

    const msgs = (data ?? []) as Msg[]

    // Group by thread_key — first message wins (it's the most recent
    // because the query is ordered desc).
    const seen = new Set<string>()
    const grouped: Msg[] = []
    for (const m of msgs) {
      if (!m.thread_key || seen.has(m.thread_key)) continue
      seen.add(m.thread_key)
      grouped.push(m)
    }

    // Hydrate contact info for threads that have a contact_id
    const contactIds = grouped
      .map((g) => g.contact_id)
      .filter((id): id is string => !!id)
    const contactMap = new Map<
      string,
      { name: string | null; company: string | null; phone: string | null }
    >()
    if (contactIds.length > 0) {
      const { data: contacts } = await supabase
        .from('contacts')
        .select('id, name, company, phone')
        .in('id', contactIds)
      for (const c of contacts ?? []) {
        contactMap.set(c.id as string, {
          name: c.name as string | null,
          company: c.company as string | null,
          phone: c.phone as string | null,
        })
      }
    }

    const out: Thread[] = grouped.map((m) => {
      const c = m.contact_id ? contactMap.get(m.contact_id) : null
      // The "other party" phone is `to_number` if outbound, `from_number` if inbound.
      const otherPhone =
        m.direction === 'inbound' ? m.from_number : m.to_number
      return {
        threadKey: m.thread_key as string,
        dealId: m.deal_id,
        contactId: m.contact_id,
        contactName: c?.name ?? null,
        contactCompany: c?.company ?? null,
        phone: otherPhone ?? c?.phone ?? null,
        lastMessage: m.body?.trim() || '(no body)',
        lastDirection: m.direction ?? 'unknown',
        lastAt: m.created_at ?? '',
        // Unread if inbound and no read_by_team_at. Outbound is always "read."
        unread: m.direction === 'inbound' && !m.read_by_team_at,
        channel: m.channel ?? 'sms',
      }
    })

    setThreads(out)
    setLoading(false)
    setRefreshing(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // Realtime — when a new SMS lands in messages_outbound (inbound OR
  // outbound from another team member's phone), reload the inbox so
  // the thread floats to the top. Throttled to one reload per inserts
  // burst to avoid hammering the DB.
  useEffect(() => {
    let pending = false
    const channel = supabase
      .channel('inbox-messages-outbound')
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'messages_outbound',
        },
        () => {
          if (pending) return
          pending = true
          setTimeout(() => {
            pending = false
            load()
          }, 800)
        },
      )
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
  }, [load])

  const onRefresh = () => {
    setRefreshing(true)
    load()
  }

  const unreadCount = useMemo(
    () => threads.filter((t) => t.unread).length,
    [threads],
  )

  return (
    <SafeAreaView style={styles.container} edges={['left', 'right', 'top']}>
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle}>Inbox</Text>
          <Text style={styles.headerSubtitle}>
            {loading
              ? '…'
              : unreadCount > 0
                ? `${unreadCount} unread · signed in as ${session?.user?.email}`
                : `Signed in as ${session?.user?.email}`}
          </Text>
        </View>
        <TouchableOpacity onPress={signOut} style={styles.signOut}>
          <Text style={styles.signOutText}>Sign out</Text>
        </TouchableOpacity>
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
        <FlatList
          data={threads}
          keyExtractor={(t) => t.threadKey}
          contentContainerStyle={{ padding: 14, paddingTop: 4 }}
          refreshControl={
            <RefreshControl
              tintColor="#d97706"
              refreshing={refreshing}
              onRefresh={onRefresh}
            />
          }
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyText}>
                No conversations yet. Drop a number a text from the web app and
                it'll show up here.
              </Text>
            </View>
          }
          renderItem={({ item }) => (
            <TouchableOpacity
              style={[styles.row, item.unread && styles.rowUnread]}
              activeOpacity={0.6}
              onPress={() =>
                router.push({
                  pathname: '/thread/[key]',
                  params: { key: item.threadKey },
                })
              }
            >
              <View style={styles.rowHeader}>
                <Text style={styles.rowTitle} numberOfLines={1}>
                  {item.contactName || item.phone || '(unknown)'}
                </Text>
                <Text style={styles.rowTime}>{formatRelative(item.lastAt)}</Text>
              </View>
              <Text style={styles.rowSub} numberOfLines={1}>
                {item.contactCompany ||
                  (item.dealId ? `Deal · ${item.dealId}` : 'No deal linked')}
              </Text>
              <Text
                style={[
                  styles.rowMessage,
                  item.unread && styles.rowMessageUnread,
                ]}
                numberOfLines={2}
              >
                {item.lastDirection === 'outbound' ? '→ ' : '← '}
                {item.lastMessage}
              </Text>
              {item.unread && <View style={styles.unreadDot} />}
            </TouchableOpacity>
          )}
        />
      )}
    </SafeAreaView>
  )
}

function formatRelative(iso: string): string {
  if (!iso) return ''
  const then = new Date(iso).getTime()
  const now = Date.now()
  const sec = Math.max(0, Math.floor((now - then) / 1000))
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h`
  const day = Math.floor(hr / 24)
  if (day < 7) return `${day}d`
  return new Date(iso).toLocaleDateString()
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0c0a09' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 14,
    paddingBottom: 10,
    borderBottomColor: '#1c1917',
    borderBottomWidth: 1,
  },
  headerTitle: { color: '#fafaf9', fontSize: 22, fontWeight: '700' },
  headerSubtitle: { color: '#78716c', fontSize: 12, marginTop: 2 },
  signOut: {
    backgroundColor: '#1c1917',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },
  signOutText: { color: '#a8a29e', fontSize: 12, fontWeight: '600' },
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
  empty: { padding: 40, alignItems: 'center' },
  emptyText: { color: '#78716c', fontSize: 14, textAlign: 'center' },
  row: {
    backgroundColor: '#1c1917',
    borderRadius: 10,
    borderColor: '#292524',
    borderWidth: 1,
    padding: 14,
    marginBottom: 10,
    position: 'relative',
  },
  rowUnread: { borderColor: '#d97706' },
  rowHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 2,
  },
  rowTitle: {
    color: '#fafaf9',
    fontSize: 15,
    fontWeight: '600',
    flex: 1,
    paddingRight: 8,
  },
  rowTime: { color: '#78716c', fontSize: 11, fontWeight: '500' },
  rowSub: { color: '#78716c', fontSize: 12, marginBottom: 6 },
  rowMessage: { color: '#a8a29e', fontSize: 13, lineHeight: 18 },
  rowMessageUnread: { color: '#d6d3d1', fontWeight: '500' },
  unreadDot: {
    position: 'absolute',
    top: 14,
    right: 12,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#d97706',
  },
})
