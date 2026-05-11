/**
 * Today screen — first real DCC view on mobile.
 *
 * Read-only on purpose. Queries the same `deals` table the web app does,
 * filtered to active surplus and flip cases assigned to or owned by the
 * signed-in user. Lets us validate auth + Supabase wiring before adding
 * any write operations.
 *
 * v2 will add: AutomationsQueue, Attention strip, push-notification badge.
 * Held back for now until Justin + Nathan finalize the v1 scope.
 */

import { useCallback, useEffect, useState } from 'react'
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

type DealRow = {
  id: string
  type: string | null
  status: string | null
  name: string | null
  address: string | null
  updated_at: string | null
}

export default function TodayScreen() {
  const { session, signOut } = useAuth()
  const router = useRouter()
  const [deals, setDeals] = useState<DealRow[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError(null)
    const { data, error: err } = await supabase
      .from('deals')
      .select('id, type, status, name, address, updated_at')
      .order('updated_at', { ascending: false })
      .limit(25)
    if (err) {
      setError(err.message)
      setDeals([])
    } else {
      setDeals((data ?? []) as DealRow[])
    }
    setLoading(false)
    setRefreshing(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const onRefresh = () => {
    setRefreshing(true)
    load()
  }

  return (
    <SafeAreaView style={styles.container} edges={['left', 'right']}>
      <View style={styles.header}>
        <View>
          <Text style={styles.headerTitle}>📌 Today</Text>
          <Text style={styles.headerSubtitle}>
            Signed in as {session?.user?.email}
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
          data={deals}
          keyExtractor={(d) => d.id}
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
              <Text style={styles.emptyText}>No recent deals. Pull to refresh.</Text>
            </View>
          }
          renderItem={({ item }) => (
            <TouchableOpacity
              style={styles.card}
              activeOpacity={0.6}
              onPress={() => router.push(`/deal/${item.id}`)}
            >
              <Text style={styles.cardTitle} numberOfLines={1}>
                {item.name ?? item.id}
              </Text>
              <Text style={styles.cardSub} numberOfLines={1}>
                {[item.address, item.type, item.status]
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
              <Text style={styles.cardHint}>Tap to open →</Text>
            </TouchableOpacity>
          )}
        />
      )}
    </SafeAreaView>
  )
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
  emptyText: { color: '#78716c', fontSize: 14 },
  card: {
    backgroundColor: '#1c1917',
    borderRadius: 10,
    borderColor: '#292524',
    borderWidth: 1,
    padding: 14,
    marginBottom: 10,
  },
  cardTitle: { color: '#fafaf9', fontSize: 15, fontWeight: '600', marginBottom: 4 },
  cardSub: { color: '#78716c', fontSize: 12 },
  cardHint: { color: '#d97706', fontSize: 11, marginTop: 8, fontWeight: '600' },
})
