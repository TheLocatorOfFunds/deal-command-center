/**
 * Team tab — internal chat across DMs and channels.
 *
 * Wires into the existing `team_threads` / `team_messages` /
 * `team_thread_participants` tables (Nathan's web app team-chat schema)
 * so messages stay in sync with the web app — same data, same RLS,
 * same realtime publication.
 *
 * Scope:
 *   - Show `channel` and `dm` thread_types (the team chat)
 *   - EXCLUDE `lauren_dm` / `lauren_room` — those land on the Lauren tab
 *   - Sort by most recent message (latest activity first)
 *
 * Tap a row → /team-thread/{thread_id}
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
import { useFocusEffect, useRouter } from 'expo-router'
import { supabase } from '../../lib/supabase'

type Thread = {
  id: string
  title: string
  thread_type: 'channel' | 'dm' | string
  lauren_enabled: boolean
  lastBody: string | null
  lastAt: string | null
}

export default function TeamScreen() {
  const router = useRouter()
  const [threads, setThreads] = useState<Thread[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError(null)
    // Threads visible to the user — RLS does the participant scoping.
    const { data: ts, error: terr } = await supabase
      .from('team_threads')
      .select('id, title, thread_type, lauren_enabled, archived_at, created_at')
      .is('archived_at', null)
      .in('thread_type', ['channel', 'dm'])
      .order('created_at', { ascending: false })
      .limit(50)
    if (terr) {
      setError(terr.message)
      setLoading(false)
      setRefreshing(false)
      return
    }
    const threadIds = (ts ?? []).map((t) => t.id as string)
    let lastByThread = new Map<string, { body: string; created_at: string }>()
    if (threadIds.length > 0) {
      // Pull the most-recent message per thread (single batched query,
      // then group client-side — same trick as the Inbox).
      const { data: msgs } = await supabase
        .from('team_messages')
        .select('thread_id, body, created_at, deleted_at')
        .in('thread_id', threadIds)
        .is('deleted_at', null)
        .order('created_at', { ascending: false })
        .limit(200)
      for (const m of msgs ?? []) {
        const tid = m.thread_id as string
        if (!lastByThread.has(tid)) {
          lastByThread.set(tid, {
            body: (m.body as string) ?? '',
            created_at: (m.created_at as string) ?? '',
          })
        }
      }
    }
    const out: Thread[] = (ts ?? []).map((t) => {
      const last = lastByThread.get(t.id as string)
      return {
        id: t.id as string,
        title: (t.title as string) ?? '(untitled)',
        thread_type: (t.thread_type as string) ?? 'channel',
        lauren_enabled: !!t.lauren_enabled,
        lastBody: last?.body ?? null,
        lastAt: last?.created_at ?? null,
      }
    })
    // Sort: threads with messages first (by most recent), then unmsgd
    // threads by created_at desc.
    out.sort((a, b) => {
      if (a.lastAt && b.lastAt)
        return new Date(b.lastAt).getTime() - new Date(a.lastAt).getTime()
      if (a.lastAt && !b.lastAt) return -1
      if (!a.lastAt && b.lastAt) return 1
      return 0
    })
    setThreads(out)
    setLoading(false)
    setRefreshing(false)
  }, [])

  // Reload on tab focus so new messages from realtime / push show fresh
  useFocusEffect(
    useCallback(() => {
      load()
    }, [load]),
  )

  useEffect(() => {
    load()
  }, [load])

  const onRefresh = () => {
    setRefreshing(true)
    load()
  }

  const empty = useMemo(
    () => !loading && threads.length === 0,
    [loading, threads],
  )

  return (
    <SafeAreaView style={styles.container} edges={['left', 'right', 'top']}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Team</Text>
        <Text style={styles.headerSubtitle}>
          Internal channels + DMs
        </Text>
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
          keyExtractor={(t) => t.id}
          contentContainerStyle={{ padding: 14, paddingTop: 4 }}
          refreshControl={
            <RefreshControl
              tintColor="#d97706"
              refreshing={refreshing}
              onRefresh={onRefresh}
            />
          }
          ListEmptyComponent={
            empty ? (
              <View style={styles.empty}>
                <Text style={styles.emptyText}>
                  No team threads yet. Create one from the web app and it'll
                  show up here.
                </Text>
              </View>
            ) : null
          }
          renderItem={({ item }) => {
            const isChannel = item.thread_type === 'channel'
            return (
              <TouchableOpacity
                style={styles.row}
                activeOpacity={0.6}
                onPress={() => router.push(`/team-thread/${item.id}`)}
              >
                <View style={styles.rowHeader}>
                  <Text style={styles.rowTitle} numberOfLines={1}>
                    {isChannel ? '# ' : ''}
                    {item.title}
                  </Text>
                  {item.lastAt && (
                    <Text style={styles.rowTime}>
                      {formatRelative(item.lastAt)}
                    </Text>
                  )}
                </View>
                <Text style={styles.rowMessage} numberOfLines={2}>
                  {item.lastBody || (
                    <Text style={styles.rowQuiet}>No messages yet</Text>
                  )}
                </Text>
              </TouchableOpacity>
            )
          }}
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
    padding: 14,
    paddingBottom: 10,
    borderBottomColor: '#1c1917',
    borderBottomWidth: 1,
  },
  headerTitle: { color: '#fafaf9', fontSize: 22, fontWeight: '700' },
  headerSubtitle: { color: '#78716c', fontSize: 12, marginTop: 2 },
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
  },
  rowHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  rowTitle: {
    color: '#fafaf9',
    fontSize: 15,
    fontWeight: '600',
    flex: 1,
    paddingRight: 8,
  },
  rowTime: { color: '#78716c', fontSize: 11, fontWeight: '500' },
  rowMessage: { color: '#a8a29e', fontSize: 13, lineHeight: 18 },
  rowQuiet: { color: '#57534e', fontStyle: 'italic' },
})
