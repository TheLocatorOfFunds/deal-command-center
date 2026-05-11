/**
 * Quick action: send an SMS to an arbitrary phone number.
 *
 * Hits the existing `send-sms` Edge Function (same path as the web app
 * + the in-thread composer). For now it's deal-less — no deal_id, no
 * contact_id — so the message lands in messages_outbound as an
 * orphan thread keyed by phone. A future tweak could add a deal-picker
 * here if needed, but the typical use case is one-off "hey just got
 * your message" texts.
 */

import { useState } from 'react'
import {
  Alert,
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
import { supabase } from '../../lib/supabase'

const SEND_SMS_URL =
  'https://rcfaashkfpurkvtmsmeb.supabase.co/functions/v1/send-sms'

export default function QuickSmsScreen() {
  const router = useRouter()
  const [phone, setPhone] = useState('')
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)

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
          <Text style={styles.label}>To</Text>
          <TextInput
            style={styles.phoneInput}
            value={phone}
            onChangeText={setPhone}
            placeholder="(513) 555-0100"
            placeholderTextColor="#78716c"
            keyboardType="phone-pad"
            autoFocus
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
  phoneInput: {
    backgroundColor: '#1c1917',
    borderColor: '#292524',
    borderWidth: 1,
    color: '#fafaf9',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 14,
    fontSize: 20,
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
    maxHeight: 220,
  },
  charCount: { color: '#78716c', fontSize: 11, paddingHorizontal: 4 },
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
