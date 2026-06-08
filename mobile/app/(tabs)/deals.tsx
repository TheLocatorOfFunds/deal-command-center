/**
 * Leads tab — sub-tabbed deal browser mirroring the web "🏠 Leads" hub.
 *
 * Chip strip (web parity per LABELS.md §3, mobile parity per §4):
 *   New      → status in (lead, new-lead)
 *   Deals    → everything not in New, Closed, Awaiting, Deleted (default)
 *   Closed   → flip status='closed' or 'recovered'
 *                surplus status='recovered' AND meta.collectedAmount > 0
 *   Awaiting → surplus + status='recovered' + no/zero meta.collectedAmount
 *              (transient — chip only renders when count > 0)
 *   Deleted  → status='dead'
 *
 * Search still works across the entire table (RPC `search_deals_mobile`)
 * and is NOT scoped to the active chip — type-to-find should always
 * reach the deal regardless of which phase you're staring at.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../lib/auth'
import { useDealUnreadCounts } from '../../lib/notifications'
import { DismissKeyboardView } from '../../components/DismissKeyboardView'

type DealRow = {
  id: string
  type: string | null
  status: string | null
  name: string | null
  address: string | null
  updated_at: string | null
  meta?: Record<string, unknown> | null
}

type Phase = 'new' | 'deals' | 'closed' | 'awaiting' | 'deleted'

const SEARCH_DEBOUNCE_MS = 250
const ROW_LIMIT = 100

// Canonical UI labels per LABELS.md §1. Used for the card status pill so
// mobile and web stay in lockstep without a shared JS module (yet).
const STATUS_LABEL: Record<string, string> = {
  lead: 'New',
  'new-lead': 'New',
  'under-contract': 'Under Contract',
  rehab: 'Rehab',
  listing: 'Listing',
  'under-offer': 'Under Offer',
  signed: 'Signed',
  filed: 'Filed',
  probate: 'Probate',
  'awaiting-distribution': 'Awaiting Distribution',
  urgent: 'Urgent',
  closed: 'Closed',
  recovered: 'Closed',
  dead: 'Deleted',
}

function collectedAmountOf(meta: Record<string, unknown> | null | undefined): number {
  if (!meta) return 0
  const v = (meta as { collectedAmount?: unknown }).collectedAmount
  if (v == null) return 0
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function labelForCard(row: DealRow): string {
  if (row.type === 'surplus' && row.status === 'recovered') {
    return collectedAmountOf(row.meta) > 0 ? 'Closed' : 'Awaiting check'
  }
  if (!row.status) return ''
  return STATUS_LABEL[row.status] ?? row.status
}

export default function DealsScreen() {
  const { session } = useAuth()
  const router = useRouter()
  const [deals, setDeals] = useState<DealRow[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [phase, setPhase] = useState<Phase>('deals')
  const [awaitingCount, setAwaitingCount] = useState(0)
  const dealUnread = useDealUnreadCounts(session?.user?.id ?? null)

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

  // Recompute the "Awaiting check" chip count whenever the screen reloads.
  // Cheap (surplus + recovered is a small set) and lets us hide the chip
  // entirely when there's nothing awaiting (per LABELS.md §3 row 4).
  const refreshAwaitingCount = useCallback(async () => {
    const { data } = await supabase
      .from('deals')
      .select('id, meta')
      .eq('type', 'surplus')
      .eq('status', 'recovered')
    const n = (data ?? []).filter(
      (d) => collectedAmountOf((d as DealRow).meta) <= 0,
    ).length
    setAwaitingCount(n)
  }, [])

  const load = useCallback(async () => {
    setError(null)
    if (isSearching) {
      // search_deals_mobile RPC hits name, address, id AND meta jsonb —
      // so "Morrow" or "Clark" or "23 CV 0836" all find the right deal
      // even though those fields live inside meta. Search is intentionally
      // chip-agnostic; we want the user to be able to find any deal.
      const { data, error: err } = await supabase.rpc('search_deals_mobile', {
        p_query: activeTerm,
      })
      if (err) {
        setError(err.message)
        setDeals([])
      } else {
        setDeals((data ?? []) as DealRow[])
      }
    } else {
      let q = supabase
        .from('deals')
        .select('id, type, status, name, address, updated_at, meta')

      if (phase === 'new') {
        q = q.in('status', ['lead', 'new-lead'])
      } else if (phase === 'deals') {
        // Active engaged work — everything NOT in the bookend phases.
        q = q.not(
          'status',
          'in',
          '(lead,new-lead,dead,closed,recovered)',
        )
      } else if (phase === 'closed') {
        // Pull the candidate set; client-side trims surplus 'recovered'
        // without collectedAmount (those go to Awaiting per LABELS.md).
        q = q.in('status', ['closed', 'recovered'])
      } else if (phase === 'awaiting') {
        q = q.eq('type', 'surplus').eq('status', 'recovered')
      } else if (phase === 'deleted') {
        q = q.eq('status', 'dead')
      }

      const { data, error: err } = await q
        .order('updated_at', { ascending: false })
        .limit(ROW_LIMIT)

      if (err) {
        setError(err.message)
        setDeals([])
      } else {
        let rows = (data ?? []) as DealRow[]
        if (phase === 'closed') {
          rows = rows.filter((d) => {
            if (d.type === 'surplus' && d.status === 'recovered') {
              return collectedAmountOf(d.meta) > 0
            }
            // Flip closed/recovered and any other type with closed/recovered
            // are unconditionally Closed.
            return d.status === 'closed' || d.status === 'recovered'
          })
        } else if (phase === 'awaiting') {
          rows = rows.filter((d) => collectedAmountOf(d.meta) <= 0)
        }
        setDeals(rows)
      }
    }
    setLoading(false)
    setRefreshing(false)
  }, [activeTerm, isSearching, phase])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    refreshAwaitingCount()
  }, [refreshAwaitingCount])

  const onRefresh = () => {
    setRefreshing(true)
    load()
    refreshAwaitingCount()
  }

  const emptyMessage = useMemo(() => {
    if (isSearching) return `No deals match "${activeTerm}".`
    if (phase === 'new') return 'No new leads. Pull to refresh.'
    if (phase === 'closed') return 'No closed deals yet.'
    if (phase === 'awaiting') return 'No deals awaiting a check.'
    if (phase === 'deleted') return 'Nothing in the Deleted tab.'
    return 'No active deals. Pull to refresh.'
  }, [isSearching, activeTerm, phase])

  // Build the chip list. Awaiting is transient — only show if there's
  // something there.
  const chips = useMemo(() => {
    const list: { id: Phase; label: string; badge?: number }[] = [
      { id: 'new', label: 'New' },
      { id: 'deals', label: 'Deals' },
      { id: 'closed', label: 'Closed' },
    ]
    if (awaitingCount > 0) {
      list.push({
        id: 'awaiting',
        label: '⏳ Awaiting check',
        badge: awaitingCount,
      })
    }
    list.push({ id: 'deleted', label: 'Deleted' })
    return list
  }, [awaitingCount])

  return (
    <SafeAreaView style={styles.container} edges={['left', 'right', 'top']}>
      <DismissKeyboardView>
        <View style={styles.header}>
          <View style={{ flex: 1 }}>
            <Text style={styles.headerTitle}>Leads</Text>
            <Text style={styles.headerSubtitle}>
              Signed in as {session?.user?.email}
            </Text>
          </View>
          <TouchableOpacity
            onPress={() => router.push('/settings')}
            style={styles.signOut}
            accessibilityLabel="Settings"
          >
            <Ionicons name="settings-outline" size={20} color="#a8a29e" />
          </TouchableOpacity>
        </View>

        {/*
          Chip strip. Mirrors web sidebar #4 sub-tabs (LABELS.md §3).
          Horizontally scrollable so a 5th chip (Awaiting) fits on smaller
          phones without crowding.
        */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chipStrip}
        >
          {chips.map((chip) => {
            const active = phase === chip.id
            return (
              <TouchableOpacity
                key={chip.id}
                onPress={() => setPhase(chip.id)}
                style={[styles.chip, active && styles.chipActive]}
                activeOpacity={0.7}
              >
                <Text
                  style={[
                    styles.chipText,
                    active && styles.chipTextActive,
                  ]}
                >
                  {chip.label}
                  {chip.badge != null && chip.badge > 0
                    ? ` · ${chip.badge}`
                    : ''}
                </Text>
              </TouchableOpacity>
            )
          })}
        </ScrollView>

        <View style={styles.searchRow}>
          <TextInput
            style={styles.search}
            placeholder="Search by name, address, or id"
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
              {' · across all phases'}
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
            keyboardDismissMode="on-drag"
            ListEmptyComponent={
              <View style={styles.empty}>
                <Text style={styles.emptyText}>{emptyMessage}</Text>
              </View>
            }
            renderItem={({ item }) => {
              const unread = dealUnread[item.id] ?? 0
              const statusLabel = labelForCard(item)
              const subParts = [item.address, item.type, statusLabel].filter(
                Boolean,
              )
              return (
                <TouchableOpacity
                  style={[styles.card, unread > 0 && styles.cardUnread]}
                  activeOpacity={0.6}
                  onPress={() => router.push(`/deal/${item.id}`)}
                >
                  <View style={styles.cardTitleRow}>
                    <Text style={styles.cardTitle} numberOfLines={1}>
                      {item.name ?? item.id}
                    </Text>
                    {unread > 0 ? (
                      <View style={styles.unreadBadge}>
                        <Text style={styles.unreadBadgeText}>
                          {unread > 9 ? '9+' : unread}
                        </Text>
                      </View>
                    ) : null}
                  </View>
                  <Text style={styles.cardSub} numberOfLines={1}>
                    {subParts.join(' · ')}
                  </Text>
                  <Text style={styles.cardHint}>Tap to open →</Text>
                </TouchableOpacity>
              )
            }}
          />
        )}
      </DismissKeyboardView>
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
  chipStrip: {
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 4,
    gap: 6,
    flexDirection: 'row',
  },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: '#1c1917',
    borderColor: '#292524',
    borderWidth: 1,
  },
  chipActive: { backgroundColor: '#d97706', borderColor: '#d97706' },
  chipText: { color: '#a8a29e', fontSize: 12, fontWeight: '600' },
  chipTextActive: { color: '#0c0a09' },
  searchRow: {
    paddingHorizontal: 14,
    paddingTop: 10,
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
  cardUnread: {
    borderColor: '#d97706',
    backgroundColor: '#1f1a13',
  },
  cardTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 4,
    gap: 8,
  },
  unreadBadge: {
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: '#d97706',
    paddingHorizontal: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  unreadBadgeText: { color: '#0c0a09', fontSize: 11, fontWeight: '700' },
  cardTitle: { color: '#fafaf9', fontSize: 15, fontWeight: '600', flex: 1 },
  cardSub: { color: '#78716c', fontSize: 12 },
  cardHint: { color: '#d97706', fontSize: 11, marginTop: 8, fontWeight: '600' },
})
