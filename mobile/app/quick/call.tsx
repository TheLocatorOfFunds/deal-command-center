/**
 * Quick action: call.
 *
 * Two ways to start the call:
 *   1. Type a number directly into the phone field
 *   2. Search by name — typeahead hits `contacts.name` and lets you tap
 *      a match to dial. Faster than digging through deals when you just
 *      need to ring a known partner attorney.
 *
 * Either path routes through the existing Twilio bridge (placeCall),
 * so the destination sees the FundLocators business number as caller
 * ID, not your personal cell.
 */

import { useEffect, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Stack, useRouter } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { supabase } from '../../lib/supabase'
import { placeCall, saveUserCellPhone } from '../../lib/dial'
import { placeCallIn } from '../../lib/voice'

type ContactHit = {
  id: string
  name: string | null
  company: string | null
  phone: string | null
  do_not_call: boolean | null
  kind: string | null
}

export default function QuickCallScreen() {
  const router = useRouter()
  const [phone, setPhone] = useState('')
  const [name, setName] = useState('')
  const [hits, setHits] = useState<ContactHit[]>([])
  const [searching, setSearching] = useState(false)
  const [busy, setBusy] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Typeahead against contacts.name / company
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    const term = name.trim()
    if (term.length < 2) {
      setHits([])
      return
    }
    debounceRef.current = setTimeout(async () => {
      setSearching(true)
      const safe = term.replace(/[,()]/g, ' ')
      const { data } = await supabase
        .from('contacts')
        .select('id, name, company, phone, do_not_call, kind')
        .or(`name.ilike.%${safe}%,company.ilike.%${safe}%`)
        .not('phone', 'is', null)
        .limit(10)
      setHits((data ?? []) as ContactHit[])
      setSearching(false)
    }, 250)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [name])

  const callTarget = async (target: string, label?: string) => {
    if (!target.trim() || busy) return
    setBusy(true)
    try {
      // Try the SDK path first. If Voice SDK is initialized it returns a
      // Call object — navigate to the in-call screen immediately.
      const sdkResult = await placeCallIn(target)
      if (sdkResult.ok && sdkResult.call) {
        const sid = sdkResult.call.getSid?.() ?? ''
        router.push({ pathname: '/call/[sid]', params: { sid } })
        return
      }

      // SDK not initialized — fall back to the legacy bridge-callback flow.
      const result = await placeCall(target)
      if (result.ok) {
        Alert.alert(
          'Calling…',
          `${result.message}${label ? `\n\nReaching: ${label}` : ''}`,
          [{ text: 'OK', onPress: () => router.back() }],
        )
        return
      }
      if (result.error === 'cell_phone_required') {
        Alert.prompt(
          'Set your cell phone',
          'We need your cell to bridge calls through Twilio.',
          [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Save & call',
              onPress: async (entered?: string) => {
                if (!entered) return
                const saved = await saveUserCellPhone(entered)
                if (!saved.ok) {
                  Alert.alert('Could not save', saved.message ?? '')
                  return
                }
                const retry = await placeCall(target)
                if (retry.ok) {
                  Alert.alert('Calling…', retry.message, [
                    { text: 'OK', onPress: () => router.back() },
                  ])
                } else {
                  Alert.alert('Call failed', retry.message)
                }
              },
            },
          ],
          'plain-text',
          '',
          'phone-pad',
        )
        return
      }
      if (result.error === 'recipient_on_dnd') {
        Alert.alert('Do not call', result.message)
        return
      }
      Alert.alert('Call failed', result.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <SafeAreaView style={styles.container} edges={['left', 'right']}>
      <Stack.Screen
        options={{
          title: 'Call',
          headerStyle: { backgroundColor: '#0c0a09' },
          headerTintColor: '#fafaf9',
          headerBackTitle: 'Back',
        }}
      />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.body}>
          <Text style={styles.label}>Search contacts</Text>
          <TextInput
            style={styles.input}
            value={name}
            onChangeText={setName}
            placeholder="Name or company"
            placeholderTextColor="#78716c"
            autoFocus
            autoCapitalize="words"
            editable={!busy}
          />
          {searching && (
            <View style={styles.searchingRow}>
              <ActivityIndicator color="#d97706" />
              <Text style={styles.searchingText}>Searching…</Text>
            </View>
          )}
          {hits.length > 0 && (
            <FlatList
              data={hits}
              keyExtractor={(h) => h.id}
              keyboardShouldPersistTaps="handled"
              style={{ marginTop: 6, maxHeight: 240 }}
              renderItem={({ item }) => {
                const callable = !!item.phone && !item.do_not_call
                return (
                  <TouchableOpacity
                    style={styles.hit}
                    activeOpacity={callable ? 0.6 : 1}
                    disabled={!callable}
                    onPress={() =>
                      callable &&
                      callTarget(
                        item.phone!,
                        item.name ?? item.company ?? 'contact',
                      )
                    }
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={styles.hitTitle}>
                        {item.name ?? '(no name)'}
                      </Text>
                      <Text style={styles.hitSub} numberOfLines={1}>
                        {[item.company, item.kind, item.phone]
                          .filter(Boolean)
                          .join(' · ')}
                      </Text>
                    </View>
                    {callable ? (
                      <Ionicons name="call" size={20} color="#d97706" />
                    ) : (
                      <Text style={styles.dndText}>DND</Text>
                    )}
                  </TouchableOpacity>
                )
              }}
            />
          )}

          <View style={styles.divider}>
            <View style={styles.dividerLine} />
            <Text style={styles.dividerText}>or dial directly</Text>
            <View style={styles.dividerLine} />
          </View>

          <Text style={styles.label}>Phone number</Text>
          <TextInput
            style={styles.input}
            value={phone}
            onChangeText={setPhone}
            placeholder="(513) 555-0100"
            placeholderTextColor="#78716c"
            keyboardType="phone-pad"
            editable={!busy}
          />
          <TouchableOpacity
            style={[
              styles.button,
              (!phone.trim() || busy) && styles.buttonDisabled,
            ]}
            onPress={() => callTarget(phone)}
            disabled={!phone.trim() || busy}
          >
            <Text style={styles.buttonText}>
              {busy ? 'Calling…' : 'Place call'}
            </Text>
          </TouchableOpacity>
          <Text style={styles.hint}>
            Your cell rings from the FundLocators Twilio number. Answer to
            connect; the destination sees the business number as caller ID.
          </Text>
        </View>
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
    paddingVertical: 14,
    fontSize: 18,
  },
  searchingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 4,
    paddingHorizontal: 4,
  },
  searchingText: { color: '#78716c', fontSize: 12 },
  hit: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1c1917',
    borderRadius: 10,
    borderColor: '#292524',
    borderWidth: 1,
    padding: 12,
    marginBottom: 6,
  },
  hitTitle: { color: '#fafaf9', fontSize: 14, fontWeight: '600' },
  hitSub: { color: '#78716c', fontSize: 12, marginTop: 2 },
  dndText: {
    color: '#7f1d1d',
    fontSize: 11,
    fontWeight: '700',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderColor: '#7f1d1d',
    borderWidth: 1,
    borderRadius: 4,
  },
  divider: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginVertical: 16,
  },
  dividerLine: { flex: 1, height: 1, backgroundColor: '#292524' },
  dividerText: {
    color: '#57534e',
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  button: {
    backgroundColor: '#d97706',
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
    marginTop: 8,
  },
  buttonDisabled: { backgroundColor: '#292524' },
  buttonText: { color: '#0c0a09', fontWeight: '700', fontSize: 15 },
  hint: { color: '#78716c', fontSize: 13, lineHeight: 18, marginTop: 8 },
})
