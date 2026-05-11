/**
 * Deals tab — recent deals + search.
 *
 * Analytical anchor of the app — Inbox is comms-first, Deals is "what
 * cases do we have, drill in for context." Two modes:
 *   1. Idle (empty search) — last 25 deals by updated_at
 *   2. Searching — full-table ILIKE on name / address / id, debounced 250ms
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
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

const SEARCH_DEBOUNCE_MS = 250

export default function DealsScreen() {
  const { session, signOut } = useAuth()
  const router = useRouter()
  const [deals, setDeals] = useState<DealRow[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Search state — `query` is what the user is typing (re-renders every
  // keystroke), `activeTerm` is the debounced version that actually
  // triggers a query.
  const [query, setQuery] = useState('')
  const [activeTerm, setActiveTerm] = useState('')
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      setActiveTerm(query.trim())
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [query])

  const isSearching = activeTerm.length > 0

  const load = useCallback(async () => {
    setError(null)
    let req = supabase
      .from('deals')
      .select('id, type, status, name, address, updated_at')
      .order('updated_at', { ascending: false })

    if (isSearching) {
      // ILIKE with wildcards — case-insensitive substring match on the
      // three fields Justin would actually search for. Escapes any
      // commas / parens the user types so they don't break the or()
      // grammar.
      const safe = activeTerm.replace(/[,()]/g, ' ')
      req = req
        .or(
          [
            `name.ilike.%${safe}%`,
            `address.ilike.%${safe}%`,
            `id.ilike.%${safe}%`,
          ].join(','),
        )
        .limit(50)
    } else {
      req = req.limit(25)
    }

    const { data, error: err } = await req
    if (err) {
      setError(err.message)
      setDeals([])
    } else {
      setDeals((data ?? []) as DealRow[])
    }
    setLoading(false)
    setRefreshing(false)
  }, [activeTerm, isSearching])

  useEffect(() => {
    load()
  }, [load])

  const onRefresh = () => {
    setRefreshing(true)
    load()
  }

  const emptyMessage = useMemo(() => {
    if (isSearching) {
      return `No deals match "${activeTerm}".`
    }
    return 'No recent deals. Pull to refresh.'
  }, [isSearching, activeTerm])

  return (
    <SafeAreaView style={styles.container} edges={['left', 'right']}>
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle}>Deals</Text>
          <Text style={styles.headerSubtitle}>
            Signed in as {session?.user?.email}
          </Text>
        </View>
        <TouchableOpacity onPress={signOut} style={styles.signOut}>
          <Text style={styles.signOutText}>Sign out</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.searchRow}>
        <TextInput
          style={styles.search}
          placeholder="Search deals — name, address, or id"
          placeholderTextColor="#78716c"
          value={query}
          onChangeText={setQuery}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          clearButtonMode="while-editing"
        />
        {isSearching && (
          <Text style={styles.searchCount}>
            {deals.length} {deals.length === 1 ? 'match' : 'matches'}
          </Text>
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
          keyboardShouldPersistTaps="handled"
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyText}>{emptyMessage}</Text>
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
  searchRow: {
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 4,
  },
  search: {
    backgroundColor: '#1c1917',
    borderColor: '#292524',
    borderWidth: 1,
    color: '#fafaf9',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
  },
  searchCount: {
    color: '#78716c',
    fontSize: 11,
    marginTop: 6,
    paddingHorizontal: 4,
  },
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
