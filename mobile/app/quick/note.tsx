/**
 * Quick action: drop a note on a deal.
 *
 * Two steps:
 *   1. Search for the deal (typeahead, same query shape as the Deals tab)
 *   2. Type the note body → writes to `deal_notes` (author_id = auth.uid,
 *      title null, body = entered text). Returns to wherever you came
 *      from on success.
 *
 * Deal selection is deliberately minimal — no full deal pick-list. If
 * the user already has the deal open they should use the Notes section
 * on Deal Detail (when we build it); this is the "I'm driving and need
 * to capture something fast" flow.
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

type DealHit = {
  id: string
  name: string | null
  address: string | null
  status: string | null
}

export default function QuickNoteScreen() {
  const router = useRouter()
  // If we arrived from a Deal Detail's "+ Add" button, we already know
  // which deal — skip the search step entirely.
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
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Debounced search — same shape as the Deals tab.
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
      const safe = term.replace(/[,()]/g, ' ')
      const { data } = await supabase
        .from('deals')
        .select('id, name, address, status')
        .or(
          [
            `name.ilike.%${safe}%`,
            `address.ilike.%${safe}%`,
            `id.ilike.%${safe}%`,
          ].join(','),
        )
        .limit(8)
      setHits((data ?? []) as DealHit[])
      setSearching(false)
    }, 250)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [query, selected])

  const save = useCallback(async () => {
    const target = body.trim()
    if (!selected || !target || busy) return
    setBusy(true)
    try {
      const { data: sessionData } = await supabase.auth.getSession()
      const userId = sessionData.session?.user?.id
      if (!userId) throw new Error('Not signed in')
      const { error } = await supabase.from('deal_notes').insert({
        deal_id: selected.id,
        author_id: userId,
        body: target,
      })
      if (error) throw error
      Alert.alert(
        'Saved',
        `Note added to ${selected.name ?? selected.id}.`,
        [{ text: 'OK', onPress: () => router.back() }],
      )
    } catch (e) {
      Alert.alert(
        'Save failed',
        e instanceof Error ? e.message : 'Unknown error',
      )
    } finally {
      setBusy(false)
    }
  }, [body, busy, router, selected])

  return (
    <SafeAreaView style={styles.container} edges={['left', 'right']}>
      <Stack.Screen
        options={{
          title: 'Note',
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
          <Pressable
            onPress={Keyboard.dismiss}
            style={styles.body}
            accessible={false}
          >
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
          <Pressable
            onPress={Keyboard.dismiss}
            style={styles.body}
            accessible={false}
          >
            <Text style={styles.label}>Deal</Text>
            <TouchableOpacity
              style={styles.selectedPill}
              onPress={() => {
                setSelected(null)
                setBody('')
              }}
            >
              <View style={{ flex: 1 }}>
                <Text style={styles.selectedTitle}>
                  {selected.name ?? selected.id}
                </Text>
                <Text style={styles.selectedSub} numberOfLines={1}>
                  {selected.address ?? selected.id}
                </Text>
              </View>
              <Text style={styles.changeLink}>Change</Text>
            </TouchableOpacity>

            <Text style={styles.label}>Note</Text>
            <TextInput
              style={styles.noteInput}
              value={body}
              onChangeText={setBody}
              placeholder="What did you want to remember?"
              placeholderTextColor="#78716c"
              multiline
              autoFocus
              textAlignVertical="top"
              editable={!busy}
            />

            <TouchableOpacity
              style={[
                styles.button,
                (!body.trim() || busy) && styles.buttonDisabled,
              ]}
              onPress={save}
              disabled={!body.trim() || busy}
            >
              <Text style={styles.buttonText}>
                {busy ? 'Saving…' : 'Save note'}
              </Text>
            </TouchableOpacity>
          </Pressable>
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  )
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
  changeLink: { color: '#d97706', fontSize: 13, fontWeight: '600', marginLeft: 10 },
  noteInput: {
    backgroundColor: '#1c1917',
    borderColor: '#292524',
    borderWidth: 1,
    color: '#fafaf9',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    minHeight: 140,
    maxHeight: 280,
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
