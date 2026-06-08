/**
 * Quick action: create a new task on a deal.
 *
 * Two entry points:
 *   1. FAB → New task — user searches for the deal first
 *   2. Deal Detail → Tasks "+ Add" — deal is preselected via params
 *
 * Inputs: title (required), optional due_date. Writes to `tasks` with
 * done=false. After insert, returns to wherever you came from.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Stack, useLocalSearchParams, useRouter } from 'expo-router'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../lib/auth'

type DealHit = {
  id: string
  name: string | null
  address: string | null
  status: string | null
}

export default function QuickNewTaskScreen() {
  const router = useRouter()
  const { session } = useAuth()
  const params = useLocalSearchParams<{
    deal_id?: string
    deal_name?: string
  }>()
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<DealHit[]>([])
  const [searching, setSearching] = useState(false)
  const [selected, setSelected] = useState<DealHit | null>(
    params.deal_id
      ? {
          id: params.deal_id,
          name: params.deal_name ?? params.deal_id,
          address: null,
          status: null,
        }
      : null,
  )
  const [title, setTitle] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [busy, setBusy] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (selected) return
    if (debounceRef.current) clearTimeout(debounceRef.current)
    const term = query.trim()
    if (term.length < 2) {
      setHits([])
      return
    }
    debounceRef.current = setTimeout(async () => {
      setSearching(true)
      const { data } = await supabase.rpc('search_deals_mobile', {
        p_query: term,
      })
      setHits(((data ?? []) as DealHit[]).slice(0, 8))
      setSearching(false)
    }, 250)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [query, selected])

  const save = useCallback(async () => {
    if (!selected || !title.trim() || busy) return
    setBusy(true)
    try {
      const userId = session?.user?.id
      const payload: {
        deal_id: string
        title: string
        done: boolean
        due_date?: string | null
        assigned_to?: string | null
      } = {
        deal_id: selected.id,
        title: title.trim(),
        done: false,
      }
      // Light date parsing — accepts YYYY-MM-DD or MM/DD/YYYY
      const d = dueDate.trim()
      if (d) {
        const iso = parseLooseDate(d)
        if (iso) payload.due_date = iso
      }
      if (userId) payload.assigned_to = userId
      const { error } = await supabase.from('tasks').insert(payload)
      if (error) throw error
      Alert.alert(
        'Saved',
        `Task added to ${selected.name ?? selected.id}.`,
        [{ text: 'OK', onPress: () => router.back() }],
      )
    } catch (e) {
      Alert.alert(
        'Could not save',
        e instanceof Error ? e.message : 'Unknown error',
      )
    } finally {
      setBusy(false)
    }
  }, [busy, dueDate, router, selected, session, title])

  return (
    <SafeAreaView style={styles.container} edges={['left', 'right']}>
      <Stack.Screen
        options={{
          title: 'Task',
          headerStyle: { backgroundColor: '#0c0a09' },
          headerTintColor: '#fafaf9',
          headerBackTitle: 'Back',
        }}
      />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        {!selected ? (
          <Pressable onPress={Keyboard.dismiss} style={styles.body} accessible={false}>
            <Text style={styles.label}>Find the deal</Text>
            <TextInput
              style={styles.input}
              value={query}
              onChangeText={setQuery}
              placeholder="Name, address, or deal id"
              placeholderTextColor="#78716c"
              autoFocus
              autoCapitalize="none"
              autoCorrect={false}
            />
            {searching && (
              <View style={styles.searchingRow}>
                <ActivityIndicator color="#d97706" />
                <Text style={styles.searchingText}>Searching…</Text>
              </View>
            )}
            <FlatList
              data={hits}
              keyExtractor={(h) => h.id}
              style={{ marginTop: 6 }}
              keyboardShouldPersistTaps="handled"
              ListEmptyComponent={
                !searching && query.trim().length >= 2 ? (
                  <Text style={styles.emptyText}>
                    No deals match "{query.trim()}".
                  </Text>
                ) : null
              }
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={styles.hit}
                  activeOpacity={0.6}
                  onPress={() => setSelected(item)}
                >
                  <Text style={styles.hitTitle}>{item.name ?? item.id}</Text>
                  <Text style={styles.hitSub} numberOfLines={1}>
                    {[item.address, item.status].filter(Boolean).join(' · ') ||
                      item.id}
                  </Text>
                </TouchableOpacity>
              )}
            />
          </Pressable>
        ) : (
          <Pressable onPress={Keyboard.dismiss} style={styles.body} accessible={false}>
            <Text style={styles.label}>Deal</Text>
            <TouchableOpacity
              style={styles.selectedPill}
              onPress={() => setSelected(null)}
            >
              <View style={{ flex: 1 }}>
                <Text style={styles.selectedTitle}>
                  {selected.name ?? selected.id}
                </Text>
                <Text style={styles.selectedSub}>
                  {selected.address ?? selected.id}
                </Text>
              </View>
              <Text style={styles.changeLink}>Change</Text>
            </TouchableOpacity>

            <Text style={styles.label}>Task</Text>
            <TextInput
              style={styles.input}
              value={title}
              onChangeText={setTitle}
              placeholder="Follow up with attorney"
              placeholderTextColor="#78716c"
              multiline
              autoFocus
              editable={!busy}
            />

            <Text style={styles.label}>Due (optional)</Text>
            <TextInput
              style={styles.input}
              value={dueDate}
              onChangeText={setDueDate}
              placeholder="YYYY-MM-DD or MM/DD/YYYY"
              placeholderTextColor="#78716c"
              autoCapitalize="none"
              editable={!busy}
            />

            <TouchableOpacity
              style={[
                styles.button,
                (!title.trim() || busy) && styles.buttonDisabled,
              ]}
              onPress={save}
              disabled={!title.trim() || busy}
            >
              <Text style={styles.buttonText}>
                {busy ? 'Saving…' : 'Save task'}
              </Text>
            </TouchableOpacity>
          </Pressable>
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  )
}

function parseLooseDate(s: string): string | null {
  // Already ISO?
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s
  // MM/DD/YYYY
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (m) {
    const [, mm, dd, yyyy] = m
    return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`
  }
  return null
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0c0a09' },
  body: { flex: 1, padding: 20, gap: 8 },
  label: {
    color: '#a8a29e',
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginTop: 8,
  },
  input: {
    backgroundColor: '#1c1917',
    borderColor: '#292524',
    borderWidth: 1,
    color: '#fafaf9',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    minHeight: 48,
  },
  searchingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 6,
    paddingHorizontal: 4,
  },
  searchingText: { color: '#78716c', fontSize: 12 },
  emptyText: { color: '#78716c', fontSize: 13, padding: 20, textAlign: 'center' },
  hit: {
    backgroundColor: '#1c1917',
    borderRadius: 10,
    borderColor: '#292524',
    borderWidth: 1,
    padding: 12,
    marginBottom: 8,
  },
  hitTitle: { color: '#fafaf9', fontSize: 14, fontWeight: '600' },
  hitSub: { color: '#78716c', fontSize: 12, marginTop: 2 },
  selectedPill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1c1917',
    borderRadius: 10,
    borderColor: '#d97706',
    borderWidth: 1,
    padding: 12,
  },
  selectedTitle: { color: '#fafaf9', fontSize: 14, fontWeight: '600' },
  selectedSub: { color: '#78716c', fontSize: 12, marginTop: 2 },
  changeLink: {
    color: '#d97706',
    fontSize: 13,
    fontWeight: '600',
    marginLeft: 10,
  },
  button: {
    backgroundColor: '#d97706',
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
    marginTop: 16,
  },
  buttonDisabled: { backgroundColor: '#292524' },
  buttonText: { color: '#0c0a09', fontWeight: '700', fontSize: 15 },
})
