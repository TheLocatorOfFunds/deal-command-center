/**
 * Notification center — list of all notifications, most recent first.
 *
 * Drives off the `notifications` table via the `useNotificationFeed`
 * hook. Tap a row → mark read + deep-link to the right screen.
 *
 * "Mark all read" button in the header clears every unread for the
 * signed-in user (server-side via RPC, badge updates via realtime).
 *
 * Build 7 ships this as a v1 — flat list, no date grouping yet. See
 * docs/MOBILE_NOTIFICATION_SYSTEM.md for the Build 8+ enhancements.
 */

import { useCallback, useEffect } from 'react'
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
import { useRouter, useNavigation } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useAuth } from '../lib/auth'
import {
  type NotificationRow,
  useNotificationFeed,
  markAllRead,
  markRead,
} from '../lib/notifications'

const KIND_ICON: Record<string, React.ComponentProps<typeof Ionicons>['name']> = {
  inbound_sms: 'chatbubble-ellipses',
  docket_event: 'document-text',
  team_message: 'people',
  deal_status_change: 'briefcase',
  missed_call: 'call',
  system_alert: 'warning',
}

export default function NotificationsScreen() {
  const router = useRouter()
  const navigation = useNavigation()
  const { session } = useAuth()
  const userId = session?.user?.id
  const { rows, loading, error, refresh } = useNotificationFeed(userId, 50)

  // Header "Mark all read" + back-friendly title
  useEffect(() => {
    navigation.setOptions({
      title: 'Notifications',
      headerRight: () =>
        rows.some((r) => !r.read_at) ? (
          <TouchableOpacity
            onPress={() => markAllRead().then(refresh)}
            style={{ paddingHorizontal: 14, paddingVertical: 8 }}
            accessibilityLabel="Mark all read"
          >
            <Text style={{ color: '#d97706', fontWeight: '600', fontSize: 14 }}>
              Mark all read
            </Text>
          </TouchableOpacity>
        ) : null,
    })
  }, [navigation, rows, refresh])

  const onRowPress = useCallback(
    async (row: NotificationRow) => {
      if (!row.read_at) {
        // Optimistic — fire and forget; realtime will reconcile
        markRead(row.id)
      }
      const data = row.data ?? {}
      const type = (data as { type?: string }).type
      const target = (data as { target?: string }).target

      // Route by type (matches existing push-tap handler convention)
      if (type === 'sms') {
        const threadKey = (data as { thread_key?: string }).thread_key
        if (threadKey) {
          router.push({ pathname: '/thread/[key]', params: { key: threadKey } })
          return
        }
      }
      if (type === 'team') {
        const threadId = (data as { thread_id?: string }).thread_id
        if (threadId) {
          router.push(`/team-thread/${threadId}` as any)
          return
        }
        router.push('/(tabs)/team' as any)
        return
      }
      // Fallback by target string
      if (target?.startsWith('deal/') && row.deal_id) {
        router.push(`/deal/${row.deal_id}` as any)
        return
      }
      if (row.deal_id) {
        router.push(`/deal/${row.deal_id}` as any)
      }
    },
    [router],
  )

  return (
    <SafeAreaView style={styles.container} edges={['left', 'right', 'bottom']}>
      {loading && rows.length === 0 ? (
        <View style={styles.loading}>
          <ActivityIndicator color="#d97706" />
        </View>
      ) : error ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>⚠ {error}</Text>
          <TouchableOpacity onPress={refresh} style={styles.retry}>
            <Text style={styles.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => r.id}
          contentContainerStyle={{ padding: 12, paddingTop: 4 }}
          refreshControl={
            <RefreshControl tintColor="#d97706" refreshing={loading} onRefresh={refresh} />
          }
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyText}>No notifications yet.</Text>
              <Text style={styles.emptyHint}>
                When someone texts you, sends a team message, or a court event hits a deal, it shows up here.
              </Text>
            </View>
          }
          renderItem={({ item }) => (
            <TouchableOpacity
              activeOpacity={0.6}
              onPress={() => onRowPress(item)}
              style={[styles.row, !item.read_at && styles.rowUnread]}
            >
              <View style={[styles.iconWrap, !item.read_at && styles.iconWrapUnread]}>
                <Ionicons
                  name={KIND_ICON[item.kind] ?? 'notifications'}
                  size={18}
                  color={!item.read_at ? '#d97706' : '#a8a29e'}
                />
                {!item.read_at && <View style={styles.unreadDot} />}
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.title} numberOfLines={1}>
                  {item.title}
                </Text>
                {item.body ? (
                  <Text style={styles.body} numberOfLines={2}>
                    {item.body}
                  </Text>
                ) : null}
                <Text style={styles.timeText}>{relativeTime(item.created_at)}</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color="#57534e" />
            </TouchableOpacity>
          )}
        />
      )}
    </SafeAreaView>
  )
}

function relativeTime(iso: string): string {
  try {
    const then = new Date(iso).getTime()
    const now = Date.now()
    const diff = Math.max(0, now - then) / 1000
    if (diff < 60) return 'just now'
    if (diff < 3600) return `${Math.floor(diff / 60)}m`
    if (diff < 86400) return `${Math.floor(diff / 3600)}h`
    if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d`
    return new Date(iso).toLocaleDateString()
  } catch {
    return ''
  }
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0c0a09' },
  loading: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  errorBox: { margin: 14, padding: 14, backgroundColor: '#7f1d1d', borderRadius: 10 },
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
  emptyText: { color: '#a8a29e', fontSize: 15, fontWeight: '600', marginBottom: 8 },
  emptyHint: { color: '#78716c', fontSize: 12, textAlign: 'center', lineHeight: 18 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 12,
    backgroundColor: '#1c1917',
    borderRadius: 10,
    borderColor: '#292524',
    borderWidth: 1,
    marginBottom: 8,
    gap: 12,
  },
  rowUnread: {
    borderColor: '#d97706',
    backgroundColor: '#1f1a13',
  },
  iconWrap: {
    width: 38,
    height: 38,
    borderRadius: 10,
    backgroundColor: '#0c0a09',
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  iconWrapUnread: { backgroundColor: '#3b2c0e' },
  unreadDot: {
    position: 'absolute',
    top: -2,
    right: -2,
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#d97706',
    borderColor: '#0c0a09',
    borderWidth: 2,
  },
  title: { color: '#fafaf9', fontSize: 14, fontWeight: '600' },
  body: { color: '#a8a29e', fontSize: 12, marginTop: 2, lineHeight: 17 },
  timeText: { color: '#78716c', fontSize: 11, marginTop: 4 },
})
