/**
 * Forecast — upcoming 14 days of key dates across all deals.
 *
 * Pulls three streams and merges them chronologically:
 *   - deals.meta.saleDate  (sheriff sale dates ≥ today)
 *   - docket_events.event_date (court events with a future date)
 *   - tasks.due_date (open tasks with a due date)
 *
 * Tap a row → opens the relevant Deal Detail. Useful before a morning
 * standup or before driving to a closing.
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
import { Stack, useRouter } from 'expo-router'
import { supabase } from '../lib/supabase'

type Item = {
  kind: 'sale' | 'docket' | 'task'
  id: string
  dealId: string | null
  dealName: string | null
  title: string
  date: string
  detail?: string | null
}

const HORIZON_DAYS = 14

export default function ForecastScreen() {
  const router = useRouter()
  const [items, setItems] = useState<Item[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError(null)
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const horizon = new Date(today)
    horizon.setDate(horizon.getDate() + HORIZON_DAYS)
    const todayIso = today.toISOString().slice(0, 10)
    const horizonIso = horizon.toISOString().slice(0, 10)

    const [dockRes, taskRes, dealsRes] = await Promise.all([
      supabase
        .from('docket_events')
        .select(
          'id, deal_id, event_type, event_date, description, litigation_stage',
        )
        .gte('event_date', todayIso)
        .lte('event_date', horizonIso)
        .order('event_date', { ascending: true })
        .limit(50),
      supabase
        .from('tasks')
        .select('id, deal_id, title, due_date')
        .eq('done', false)
        .gte('due_date', todayIso)
        .lte('due_date', horizonIso)
        .order('due_date', { ascending: true })
        .limit(50),
      // Pull all deals with a meta.saleDate. Filtering jsonb date ranges
      // is awkward in PostgREST, so pull a wider window then filter in JS.
      supabase
        .from('deals')
        .select('id, name, status, meta')
        .order('updated_at', { ascending: false })
        .limit(200),
    ])

    const firstErr = dockRes.error || taskRes.error || dealsRes.error
    if (firstErr) {
      setError(firstErr.message)
      setLoading(false)
      setRefreshing(false)
      return
    }

    const dealNameById = new Map<string, string>()
    for (const d of (dealsRes.data ?? []) as Array<{
      id: string
      name: string | null
    }>) {
      dealNameById.set(d.id, d.name ?? d.id)
    }

    const out: Item[] = []
    for (const row of (dockRes.data ?? []) as Array<{
      id: string
      deal_id: string | null
      event_type: string | null
      event_date: string | null
      description: string | null
      litigation_stage: string | null
    }>) {
      if (!row.event_date) continue
      out.push({
        kind: 'docket',
        id: `dock-${row.id}`,
        dealId: row.deal_id,
        dealName: row.deal_id ? dealNameById.get(row.deal_id) ?? null : null,
        title: row.event_type ?? '(docket event)',
        date: row.event_date,
        detail: row.description ?? row.litigation_stage,
      })
    }
    for (const row of (taskRes.data ?? []) as Array<{
      id: number
      deal_id: string | null
      title: string | null
      due_date: string | null
    }>) {
      if (!row.due_date) continue
      out.push({
        kind: 'task',
        id: `task-${row.id}`,
        dealId: row.deal_id,
        dealName: row.deal_id ? dealNameById.get(row.deal_id) ?? null : null,
        title: row.title ?? '(task)',
        date: row.due_date,
      })
    }
    // Sales from meta — filter to the horizon window in JS
    for (const d of (dealsRes.data ?? []) as Array<{
      id: string
      name: string | null
      meta: Record<string, unknown> | null
    }>) {
      const sale = (d.meta?.saleDate as string | undefined) ?? null
      if (!sale) continue
      if (sale < todayIso || sale > horizonIso) continue
      out.push({
        kind: 'sale',
        id: `sale-${d.id}`,
        dealId: d.id,
        dealName: d.name ?? d.id,
        title: 'Sheriff sale',
        date: sale,
      })
    }
    out.sort((a, b) => a.date.localeCompare(b.date))
    setItems(out)
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

  // Group items into "Today", "Tomorrow", "This week", "Next week"
  const groups = groupByDate(items)

  return (
    <SafeAreaView style={styles.container} edges={['left', 'right']}>
      <Stack.Screen
        options={{
          title: 'Forecast · next 14 days',
          headerStyle: { backgroundColor: '#0c0a09' },
          headerTintColor: '#fafaf9',
          headerBackTitle: 'Back',
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
        <FlatList
          data={groups}
          keyExtractor={(g) => g.label}
          contentContainerStyle={{ padding: 14 }}
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
                Nothing on the calendar for the next 14 days. Good time to
                catch up on Notes.
              </Text>
            </View>
          }
          renderItem={({ item }) => (
            <View style={{ marginBottom: 16 }}>
              <Text style={styles.groupLabel}>{item.label}</Text>
              {item.items.map((row) => (
                <TouchableOpacity
                  key={row.id}
                  style={styles.row}
                  activeOpacity={row.dealId ? 0.6 : 1}
                  disabled={!row.dealId}
                  onPress={() =>
                    row.dealId && router.push(`/deal/${row.dealId}`)
                  }
                >
                  <View style={styles.kindCol}>
                    <Text style={styles.kindIcon}>{iconFor(row.kind)}</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.rowTitle} numberOfLines={1}>
                      {row.title}
                    </Text>
                    <Text style={styles.rowSub} numberOfLines={1}>
                      {row.dealName ?? row.dealId ?? '(no deal)'}
                    </Text>
                    {row.detail && (
                      <Text style={styles.rowDetail} numberOfLines={2}>
                        {row.detail}
                      </Text>
                    )}
                  </View>
                </TouchableOpacity>
              ))}
            </View>
          )}
        />
      )}
    </SafeAreaView>
  )
}

function iconFor(kind: Item['kind']): string {
  switch (kind) {
    case 'sale':
      return '🏛'
    case 'docket':
      return '⚖'
    case 'task':
      return '✓'
  }
}

function groupByDate(items: Item[]): Array<{ label: string; items: Item[] }> {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const todayIso = today.toISOString().slice(0, 10)
  const tomorrow = new Date(today)
  tomorrow.setDate(tomorrow.getDate() + 1)
  const tomorrowIso = tomorrow.toISOString().slice(0, 10)

  const groups: Record<string, Item[]> = {}
  for (const it of items) {
    const dt = new Date(it.date)
    let key: string
    if (it.date === todayIso) key = 'Today'
    else if (it.date === tomorrowIso) key = 'Tomorrow'
    else {
      const dayLabel = dt.toLocaleDateString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
      })
      key = dayLabel
    }
    if (!groups[key]) groups[key] = []
    groups[key].push(it)
  }
  return Object.entries(groups).map(([label, items]) => ({ label, items }))
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
  empty: { padding: 40, alignItems: 'center' },
  emptyText: { color: '#78716c', fontSize: 14, textAlign: 'center' },
  groupLabel: {
    color: '#d97706',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginBottom: 8,
  },
  row: {
    flexDirection: 'row',
    backgroundColor: '#1c1917',
    borderRadius: 10,
    borderColor: '#292524',
    borderWidth: 1,
    padding: 12,
    marginBottom: 8,
    alignItems: 'flex-start',
  },
  kindCol: { width: 32, alignItems: 'center', paddingTop: 2 },
  kindIcon: { fontSize: 18 },
  rowTitle: { color: '#fafaf9', fontSize: 14, fontWeight: '600' },
  rowSub: { color: '#a8a29e', fontSize: 12, marginTop: 2 },
  rowDetail: { color: '#78716c', fontSize: 12, marginTop: 4, lineHeight: 16 },
})
