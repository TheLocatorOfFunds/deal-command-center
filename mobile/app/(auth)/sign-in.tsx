/**
 * Sign in via Supabase magic link. Same OTP flow as the web app's
 * signInWithOtp — Supabase emails the user a link, they tap it, the deep
 * link comes back to us via the `dcc://` scheme (configured in app.json),
 * Supabase finishes the session.
 */

import { useState } from 'react'
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
} from 'react-native'
import * as Linking from 'expo-linking'
import { supabase } from '../../lib/supabase'

export default function SignInScreen() {
  const [email, setEmail] = useState('')
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const send = async () => {
    const target = email.trim().toLowerCase()
    if (!target || sending) return
    setSending(true)
    setError(null)
    try {
      const { error: err } = await supabase.auth.signInWithOtp({
        email: target,
        options: {
          emailRedirectTo: Linking.createURL('/'),
          shouldCreateUser: true,
        },
      })
      if (err) throw err
      setSent(true)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Unknown error'
      setError(msg)
    } finally {
      setSending(false)
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.inner}>
        <Text style={styles.title}>Deal Command Center</Text>
        <Text style={styles.subtitle}>Sign in with your work email</Text>

        {sent ? (
          <View style={styles.sentBox}>
            <Text style={styles.sentTitle}>📬 Check your email</Text>
            <Text style={styles.sentBody}>
              We sent a magic-link to {email}. Tap the link on this device
              to sign in.
            </Text>
            <TouchableOpacity
              style={styles.linkButton}
              onPress={() => {
                setSent(false)
                setEmail('')
              }}
            >
              <Text style={styles.linkText}>Use a different email</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <>
            <TextInput
              style={styles.input}
              placeholder="you@fundlocators.com"
              placeholderTextColor="#78716c"
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              autoComplete="email"
              keyboardType="email-address"
              returnKeyType="send"
              onSubmitEditing={send}
              editable={!sending}
            />
            <TouchableOpacity
              style={[
                styles.button,
                (!email.trim() || sending) && styles.buttonDisabled,
              ]}
              onPress={send}
              disabled={!email.trim() || sending}
            >
              <Text style={styles.buttonText}>
                {sending ? 'Sending…' : 'Send magic link'}
              </Text>
            </TouchableOpacity>
            {error && <Text style={styles.error}>⚠ {error}</Text>}
          </>
        )}
      </View>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0c0a09' },
  inner: { flex: 1, justifyContent: 'center', padding: 24 },
  title: {
    fontSize: 28,
    fontWeight: '800',
    color: '#fafaf9',
    marginBottom: 6,
    letterSpacing: -0.5,
  },
  subtitle: { fontSize: 14, color: '#a8a29e', marginBottom: 32 },
  input: {
    backgroundColor: '#1c1917',
    borderColor: '#292524',
    borderWidth: 1,
    color: '#fafaf9',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 14,
    fontSize: 16,
    marginBottom: 14,
  },
  button: {
    backgroundColor: '#d97706',
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
  },
  buttonDisabled: { backgroundColor: '#292524' },
  buttonText: { color: '#0c0a09', fontWeight: '700', fontSize: 15 },
  error: { color: '#ef4444', marginTop: 12, fontSize: 13 },
  sentBox: {
    backgroundColor: '#064e3b',
    padding: 18,
    borderRadius: 10,
    borderColor: '#10b98144',
    borderWidth: 1,
  },
  sentTitle: { color: '#6ee7b7', fontSize: 16, fontWeight: '700', marginBottom: 6 },
  sentBody: { color: '#a7f3d0', lineHeight: 20, fontSize: 14 },
  linkButton: { marginTop: 14 },
  linkText: { color: '#6ee7b7', fontSize: 13, textDecorationLine: 'underline' },
})
