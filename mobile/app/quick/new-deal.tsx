/**
 * Quick action: create a new deal.
 *
 * Minimum-viable inputs: type, name, address. Deal id is auto-generated
 * with a type-aware prefix (sf-{lastname}, flip-{streetnum}, etc.) to
 * match the existing naming convention. After insert, route directly
 * to the new Deal Detail so the user can keep working on it.
 *
 * Web's NewDealModal does more (county, meta fields, claimant array,
 * etc.) — those can be added on the web. This is just the "I'm on the
 * road and need to capture a new lead before I forget" path.
 */

import { useState } from 'react'
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Stack, useRouter } from 'expo-router'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../lib/auth'

const TYPES = ['surplus', 'flip', 'wholesale', 'rental', 'other'] as const
type DealType = (typeof TYPES)[number]

export default function QuickNewDealScreen() {
  const router = useRouter()
  const { session } = useAuth()
  const [type, setType] = useState<DealType>('surplus')
  const [name, setName] = useState('')
  const [address, setAddress] = useState('')
  const [busy, setBusy] = useState(false)

  const generateId = (): string => {
    const slug = name
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .pop()
      ?.replace(/[^a-z0-9]/g, '')
      ?.slice(0, 16) ?? ''
    const rand = Math.random().toString(36).slice(2, 6)
    if (type === 'surplus') return `sf-${slug || rand}`
    if (type === 'flip') {
      const streetNum = address.match(/^\d+/)?.[0]
      return `flip-${streetNum || slug || rand}`
    }
    return `${type}-${slug || rand}`
  }

  const create = async () => {
    if (!name.trim() || busy) return
    setBusy(true)
    try {
      const userId = session?.user?.id
      let dealId = generateId()
      // Probe for uniqueness; if collision, append random suffix
      const { data: existing } = await supabase
        .from('deals')
        .select('id')
        .eq('id', dealId)
        .maybeSingle()
      if (existing?.id) {
        dealId = `${dealId}-${Math.random().toString(36).slice(2, 5)}`
      }
      const { error } = await supabase.from('deals').insert({
        id: dealId,
        type,
        status: 'new-lead',
        name: name.trim(),
        address: address.trim() || null,
        owner_id: userId ?? null,
      })
      if (error) throw error
      router.replace(`/deal/${dealId}`)
    } catch (e) {
      Alert.alert(
        'Could not create',
        e instanceof Error ? e.message : 'Unknown error',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <SafeAreaView style={styles.container} edges={['left', 'right']}>
      <Stack.Screen
        options={{
          title: 'New deal',
          headerStyle: { backgroundColor: '#0c0a09' },
          headerTintColor: '#fafaf9',
          headerBackTitle: 'Back',
        }}
      />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerStyle={styles.body}>
          <Text style={styles.label}>Type</Text>
          <View style={styles.typeRow}>
            {TYPES.map((t) => (
              <TouchableOpacity
                key={t}
                onPress={() => setType(t)}
                style={[
                  styles.typeChip,
                  type === t && styles.typeChipActive,
                ]}
              >
                <Text
                  style={[
                    styles.typeChipText,
                    type === t && styles.typeChipTextActive,
                  ]}
                >
                  {t}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          <Text style={styles.label}>Name</Text>
          <TextInput
            style={styles.input}
            value={name}
            onChangeText={setName}
            placeholder={
              type === 'surplus' ? 'Homeowner name' : 'Property or deal name'
            }
            placeholderTextColor="#78716c"
            autoFocus
            editable={!busy}
          />

          <Text style={styles.label}>Address (optional)</Text>
          <TextInput
            style={styles.input}
            value={address}
            onChangeText={setAddress}
            placeholder="1234 Main St, City, OH"
            placeholderTextColor="#78716c"
            editable={!busy}
          />

          <TouchableOpacity
            style={[
              styles.button,
              (!name.trim() || busy) && styles.buttonDisabled,
            ]}
            onPress={create}
            disabled={!name.trim() || busy}
          >
            <Text style={styles.buttonText}>
              {busy ? 'Creating…' : 'Create deal'}
            </Text>
          </TouchableOpacity>

          <Text style={styles.hint}>
            You can add county, case number, surplus estimate, and other
            details on the web — this is just the fast-capture entry. The
            new deal opens immediately so you can add notes from your phone.
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0c0a09' },
  body: { padding: 20, gap: 8 },
  label: {
    color: '#a8a29e',
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginTop: 8,
  },
  typeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 4 },
  typeChip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: '#1c1917',
    borderColor: '#292524',
    borderWidth: 1,
  },
  typeChipActive: { backgroundColor: '#d97706', borderColor: '#d97706' },
  typeChipText: { color: '#a8a29e', fontSize: 12, fontWeight: '600' },
  typeChipTextActive: { color: '#0c0a09' },
  input: {
    backgroundColor: '#1c1917',
    borderColor: '#292524',
    borderWidth: 1,
    color: '#fafaf9',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
  },
  button: {
    backgroundColor: '#d97706',
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
    marginTop: 18,
  },
  buttonDisabled: { backgroundColor: '#292524' },
  buttonText: { color: '#0c0a09', fontWeight: '700', fontSize: 15 },
  hint: { color: '#78716c', fontSize: 12, lineHeight: 17, marginTop: 14 },
})
