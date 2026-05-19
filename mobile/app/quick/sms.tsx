/**
 * Quick action: send an SMS.
 *
 * Same dual-input pattern as /quick/call:
 *   - Type a number directly into the phone field, OR
 *   - Search contacts by name and tap one to fill the phone
 *
 * Hits the existing `send-sms` Edge Function (same path the web app
 * + the in-thread composer use).
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

const SEND_SMS_URL =
  'https://rcfaashkfpurkvtmsmeb.supabase.co/functions/v1/send-sms'

type ContactHit = {
  id: string
  name: string | null
  company: string | null
  phone: string | null
  do_not_text: boolean | null
}

export default function QuickSmsScreen() {
  const router = useRouter()
  const [search, setSearch] = useState('')
  const [hits, setHits] = useState<ContactHit[]>([])
  const [searching, setSearching] = useState(false)
  const [phone, setPhone] = useState('')
  const [contactId, setContactId] = useState<string | null>(null)
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    const term = search.trim()
    if (term.length < 2) {
      setHits([])
      return
    }
    debounceRef.current = setTimeout(async () => {
      setSearching(true)
      const safe = term.replace(/[,()]/g, ' ')
      const { data } = await supabase
        .from('contacts')
        .select('id, name, company, phone, do_not_text')
        .or(`name.ilike.%${safe}%,company.ilike.%${safe}%`)
        .not('phone', 'is', null)
        .limit(10)
      setHits((data ?? []) as ContactHit[])
      setSearching(false)
    }, 250)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [search])

  const pickContact = (c: ContactHit) => {
    if (!c.phone || c.do_not_text) return
    setPhone(c.phone)
    setContactId(c.id)
    setSearch('')
    setHits([])
  }

  const send = async () => {
    const targetPhone = phone.trim()
    const targetBody = body.trim()
    if (!targetPhone || !targetBody || busy) return
    setBusy(true)
    try {
      const { data: sessionData } = await supabase.auth.getSession()
      const token = sessionData.session?.access_token
      if (!token) throw new Error('Not signed in')
      const res = await fetch(SEND_SMS_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          to: targetPhone,
          body: targetBody,
          contact_id: contactId,
        }),
      })
      const payload = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(
          payload.error
            ? `${payload.error}${payload.details ? ` — ${payload.details}` : ''}`
            : `HTTP ${res.status}`,
        )
      }
      Alert.alert('Sent', `Message sent to ${targetPhone}.`, [
        { text: 'OK', onPress: () => router.back() },
      ])
    } catch (e) {
      Alert.alert(
        'Send failed',
        e instanceof Error ? e.message : 'Unknown error',
      )
    } finally {
      setBusy(false)
    }
  }

  const charCount = body.length
  const segments = charCount === 0 ? 0 : Math.ceil(charCount / 160)

  return (
    <SafeAreaView style={styles.container} edges={['left', 'right']}>
      <Stack.Screen
        options={{
          title: 'Text',
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
            value={search}
            onChangeText={setSearch}
            placeholder="Name or company"
            placeholderTextColor="#78716c"
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
              style={{ marginTop: 4, maxHeight: 180 }}
              renderItem={({ item }) => {
                const ok = !!item.phone && !item.do_not_text
                return (
                  <TouchableOpacity
                    style={styles.hit}
                    activeOpacity={ok ? 0.6 : 1}
                    disabled={!ok}
                    onPress={() => pickContact(item)}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={styles.hitTitle}>
                        {item.name ?? '(no name)'}
                      </Text>
                      <Text style={styles.hitSub} numberOfLines={1}>
                        {[item.company, item.phone]
                          .filter(Boolean)
                          .join(' · ')}
                      </Text>
                    </View>
                    {ok ? (
                      <Ionicons
                        name="chatbubble-ellipses"
                        size={18}
                        color="#d97706"
                      />
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
            <Text style={styles.dividerText}>or type a number</Text>
            <View style={styles.dividerLine} />
          </View>

          <Text style={styles.label}>To</Text>
          <TextInput
            style={styles.phoneInput}
            value={phone}
            onChangeText={(v) => {
              setPhone(v)
              setContactId(null)
            }}
            placeholder="(513) 555-0100"
            placeholderTextColor="#78716c"
            keyboardType="phone-pad"
            editable={!busy}
          />

          <Text style={styles.label}>Message</Text>
          <TextInput
            style={styles.bodyInput}
            value={body}
            onChangeText={setBody}
            placeholder="Type your message…"
            placeholderTextColor="#78716c"
            multiline
            editable={!busy}
            textAlignVertical="top"
          />
          <Text style={styles.charCount}>
            {charCount} chars
            {segments > 1 ? ` · sends as ${segments} texts` : ''}
          </Text>

          <TouchableOpacity
            style={[
              styles.button,
              (!phone.trim() || !body.trim() || busy) && styles.buttonDisabled,
            ]}
            onPress={send}
            disabled={!phone.trim() || !body.trim() || busy}
          >
            <Text style={styles.buttonText}>
              {busy ? 'Sending…' : 'Send'}
            </Text>
          </TouchableOpacity>
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
    paddingVertical: 12,
    fontSize: 15,
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
    padding: 10,
    marginBottom: 6,
  },
  hitTitle: { color: '#fafaf9', fontSize: 13, fontWeight: '600' },
  hitSub: { color: '#78716c', fontSize: 11, marginTop: 2 },
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
    marginVertical: 12,
  },
  dividerLine: { flex: 1, height: 1, backgroundColor: '#292524' },
  dividerText: {
    color: '#57534e',
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  phoneInput: {
    backgroundColor: '#1c1917',
    borderColor: '#292524',
    borderWidth: 1,
    color: '#fafaf9',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 14,
    fontSize: 18,
  },
  bodyInput: {
    backgroundColor: '#1c1917',
    borderColor: '#292524',
    borderWidth: 1,
    color: '#fafaf9',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    minHeight: 120,
    maxHeight: 200,
  },
  charCount: { color: '#78716c', fontSize: 11, paddingHorizontal: 4 },
  button: {
    backgroundColor: '#d97706',
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
    marginTop: 12,
  },
  buttonDisabled: { backgroundColor: '#292524' },
  buttonText: { color: '#0c0a09', fontWeight: '700', fontSize: 15 },
})
