/**
 * Sign in via Supabase email OTP. Two-step flow that avoids the
 * deep-link mess entirely:
 *
 *   1. User enters email → we call `signInWithOtp` to email them a
 *      magic link AND a 6-digit code (both come in the same email,
 *      Supabase's default template).
 *   2. User types the 6-digit code into the app → we call
 *      `verifyOtp({ type: 'email', token })` and the session is set
 *      directly. No redirect, no browser bounce, no allowlist.
 *
 * The link in the email still works in TestFlight + production builds
 * via the `dcc://` scheme. In Expo Go dev, the code path is the
 * reliable one because Expo Go's `exp://...` URL needs to be in the
 * Supabase redirect allowlist for deep-linking to work, and that URL
 * changes every time you switch Wi-Fi networks.
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
import { supabase } from '../../lib/supabase'

type Step = 'email' | 'code'

export default function SignInScreen() {
  const [step, setStep] = useState<Step>('email')
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const sendCode = async () => {
    const target = email.trim().toLowerCase()
    if (!target || busy) return
    setBusy(true)
    setError(null)
    try {
      const { error: err } = await supabase.auth.signInWithOtp({
        email: target,
        options: {
          shouldCreateUser: true,
        },
      })
      if (err) throw err
      setStep('code')
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Unknown error')
    } finally {
      setBusy(false)
    }
  }

  const verifyCode = async () => {
    const token = code.trim()
    if (token.length < 6 || busy) return
    setBusy(true)
    setError(null)
    try {
      const { error: err } = await supabase.auth.verifyOtp({
        email: email.trim().toLowerCase(),
        token,
        type: 'email',
      })
      if (err) throw err
      // Auth state change picked up by AuthProvider → ProtectedRouter
      // redirects to (tabs). No further work here.
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Invalid or expired code')
    } finally {
      setBusy(false)
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.inner}>
        <Text style={styles.title}>Deal Command Center</Text>
        <Text style={styles.subtitle}>
          {step === 'email'
            ? 'Sign in with your work email'
            : `Enter the 6-digit code we sent to ${email}`}
        </Text>

        {step === 'email' ? (
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
              onSubmitEditing={sendCode}
              editable={!busy}
            />
            <TouchableOpacity
              style={[
                styles.button,
                (!email.trim() || busy) && styles.buttonDisabled,
              ]}
              onPress={sendCode}
              disabled={!email.trim() || busy}
            >
              <Text style={styles.buttonText}>
                {busy ? 'Sending…' : 'Send code'}
              </Text>
            </TouchableOpacity>
            {error && <Text style={styles.error}>⚠ {error}</Text>}
          </>
        ) : (
          <>
            <TextInput
              style={[styles.input, styles.codeInput]}
              placeholder="123456"
              placeholderTextColor="#78716c"
              value={code}
              onChangeText={(v) => setCode(v.replace(/\D/g, '').slice(0, 6))}
              keyboardType="number-pad"
              autoComplete="one-time-code"
              textContentType="oneTimeCode"
              returnKeyType="go"
              onSubmitEditing={verifyCode}
              editable={!busy}
              maxLength={6}
              autoFocus
            />
            <TouchableOpacity
              style={[
                styles.button,
                (code.length < 6 || busy) && styles.buttonDisabled,
              ]}
              onPress={verifyCode}
              disabled={code.length < 6 || busy}
            >
              <Text style={styles.buttonText}>
                {busy ? 'Verifying…' : 'Verify'}
              </Text>
            </TouchableOpacity>
            {error && <Text style={styles.error}>⚠ {error}</Text>}
            <TouchableOpacity
              style={styles.linkButton}
              onPress={() => {
                setStep('email')
                setCode('')
                setError(null)
              }}
              disabled={busy}
            >
              <Text style={styles.linkText}>Use a different email</Text>
            </TouchableOpacity>
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
  codeInput: {
    fontSize: 28,
    letterSpacing: 8,
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
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
  linkButton: { marginTop: 18, alignItems: 'center' },
  linkText: { color: '#a8a29e', fontSize: 13, textDecorationLine: 'underline' },
})
