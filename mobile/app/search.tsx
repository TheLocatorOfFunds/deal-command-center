/**
 * Global search — type a few characters, search across deals, notes,
 * contacts, vendors, recent messages, team chat.
 *
 * Backed by the `global_search(q, max_per_kind)` RPC from migration
 * 20260516120100_global_search_pg_trgm. See docs/MOBILE_GLOBAL_SEARCH.md.
 *
 * Debounced 250ms. Groups results by kind. Tap → deep-link to the
 * relevant route.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter, useNavigation } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { supabase } from '../lib/supabase'

type SearchKind = 'deal' | 'note' | 'contact' | 'vendor' | 'message' | 'team_msg'

type Hit = {
  kind: SearchKind
  id: string
  deal_id: string | null
  title: string
  snippet: string | null
  rank: number | null
}

const KIND_ORDER: SearchKind[] = ['deal', 'note', 'contact', 'vendor', 'message', 'team_msg']

const KIND_LABEL: Record<SearchKind, string> = {
  deal: 'Deals',
  note: 'Notes',
  contact: 'Contacts',
  vendor: 'Vendors',
  message: 'Messages (last 30d)',
  team_msg: 'Team chat',
}

const KIND_ICON: Record<SearchKind, React.ComponentProps<typeof Ionicons>['name']> = {
  deal: 'briefcase',
  note: 'document-text',
  contact: 'person',
  vendor: 'construct',
  message: 'chatbubble-ellipses',
  team_msg: 'people',
}

const DEBOUNCE_MS = 250

export default function SearchScreen() {
  const router = useRouter()
  const navigation = useNavigation()
  const [query, setQuery] = useState('')
  const [activeTerm, setActiveTerm] = useState('')
  const [hits, setHits] = useState<Hit[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    navigation.setOptions({ title: 'Search' })
  }, [navigation])

  // Debounce query → activeTerm
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      setActiveTerm(query.trim())
    }, DEBOUNCE_MS)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [query])

  // Run the RPC on every activeTerm change
  useEffect(() => {
    if (activeTerm.length < 2) {
      setHits([])
      setError(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    supabase
      .rpc('global_search', { q: activeTerm, max_per_kind: 5 })
      .then(({ data, error: err }) => {
        if (cancelled) return
        if (err) {
          if (/function .* does not exist/i.test(err.message)) {
            // Migration hasn't been applied yet — gracefully show nothing
            setHits([])
          } else {
            setError(err.message)
            setHits([])
          }
        } else {
          setHits((data ?? []) as Hit[])
        }
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [activeTerm])

  const grouped = useMemo(() => {
    const map: Record<SearchKind, Hit[]> = {
      deal: [],
      note: [],
      contact: [],
      vendor: [],
      message: [],
      team_msg: [],
    }
    for (const h of hits) {
      if (map[h.kind]) map[h.kind].push(h)
    }
    return map
  }, [hits])

  const onHitPress = useCallback(
    (h: Hit) => {
      switch (h.kind) {
        case 'deal':
          router.push(`/deal/${h.id}` as any)
          break
        case 'note':
        case 'vendor':
        case 'message':
          if (h.deal_id) router.push(`/deal/${h.deal_id}` as any)
          break
        case 'team_msg':
          router.push('/(tabs)/team' as any)
          break
        case 'contact':
          // No standalone contact route yet — open first linked deal or do nothing
          // (future: /contact/[id])
          break
      }
    },
    [router],
  )

  // Build flat data for FlatList: alternating section headers + rows
  type FlatItem =
    | { type: 'header'; kind: SearchKind; count: number }
    | { type: 'hit'; hit: Hit }

  const flatData: FlatItem[] = useMemo(() => {
    const out: FlatItem[] = []
    for (const k of KIND_ORDER) {
      const rows = grouped[k]
      if (rows.length === 0) continue
      out.push({ type: 'header', kind: k, count: rows.length })
      for (const h of rows) out.push({ type: 'hit', hit: h })
    }
    return out
  }, [grouped])

  return (
    <SafeAreaView style={styles.container} edges={['left', 'right', 'bottom']}>
      <View style={styles.searchRow}>
        <Ionicons name="search" size={18} color="#a8a29e" style={{ marginRight: 8 }} />
        <TextInput
          style={styles.searchInput}
          placeholder="Search deals, notes, contacts, messages…"
          placeholderTextColor="#78716c"
          value={query}
          onChangeText={setQuery}
          autoFocus
          autoCapitalize="none"
          autoCorrect={false}
          clearButtonMode="while-editing"
          returnKeyType="search"
        />
        {loading && <ActivityIndicator color="#d97706" style={{ marginLeft: 8 }} />}
      </View>

      {error ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>⚠ {error}</Text>
        </View>
      ) : null}

      {activeTerm.length < 2 ? (
        <View style={styles.hintWrap}>
          <Text style={styles.hint}>
            Type at least 2 characters to search across deals, notes, contacts, vendors, recent SMS, and team chat.
          </Text>
        </View>
      ) : flatData.length === 0 && !loading ? (
        <View style={styles.hintWrap}>
          <Text style={styles.hint}>No results for "{activeTerm}".</Text>
        </View>
      ) : (
        <FlatList
          data={flatData}
          keyExtractor={(it, i) =>
            it.type === 'header' ? `h-${it.kind}` : `r-${it.hit.kind}-${it.hit.id}-${i}`
          }
          contentContainerStyle={{ padding: 12 }}
          renderItem={({ item }) => {
            if (item.type === 'header') {
              return (
                <Text style={styles.sectionHeader}>
                  {KIND_LABEL[item.kind]} ({item.count})
                </Text>
              )
            }
            const h = item.hit
            return (
              <TouchableOpacity
                style={styles.row}
                onPress={() => onHitPress(h)}
                activeOpacity={0.6}
              >
                <View style={styles.iconWrap}>
                  <Ionicons name={KIND_ICON[h.kind]} size={18} color="#d97706" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.title} numberOfLines={1}>
                    {h.title}
                  </Text>
                  {h.snippet ? (
                    <Text style={styles.snippet} numberOfLines={2}>
                      {h.snippet}
                    </Text>
                  ) : null}
                </View>
                <Ionicons name="chevron-forward" size={18} color="#57534e" />
              </TouchableOpacity>
            )
          }}
        />
      )}
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0c0a09' },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1c1917',
    margin: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    borderColor: '#292524',
    borderWidth: 1,
  },
  searchInput: {
    flex: 1,
    color: '#fafaf9',
    fontSize: 16,
    padding: 0,
  },
  errorBox: { margin: 14, padding: 14, backgroundColor: '#7f1d1d', borderRadius: 10 },
  errorText: { color: '#fca5a5', fontSize: 14 },
  hintWrap: { padding: 28, alignItems: 'center' },
  hint: { color: '#78716c', fontSize: 13, textAlign: 'center', lineHeight: 19 },
  sectionHeader: {
    color: '#d97706',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    marginTop: 16,
    marginBottom: 8,
    paddingHorizontal: 4,
  },
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
  iconWrap: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: '#0c0a09',
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { color: '#fafaf9', fontSize: 14, fontWeight: '600' },
  snippet: { color: '#a8a29e', fontSize: 12, marginTop: 2, lineHeight: 17 },
})
