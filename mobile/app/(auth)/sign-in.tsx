/**
 * Sign in via Supabase email OTP. Two-step flow:
 *   1. User enters email → we call `signInWithOtp` to email them a
 *      magic link AND a 6-digit code (both come in the same email).
 *   2. User types the 6-digit code into the app → we call
 *      `verifyOtp({ type: 'email', token })` and the session is set.
 *
 * iOS niceties:
 *   - Email field uses textContentType="emailAddress" so iOS Keychain
 *     offers saved emails above the keyboard.
 *   - We also persist the last-used email to AsyncStorage and pre-fill
 *     on mount — second sign-in onwards skips the typing step entirely.
 *   - Code field uses textContentType="oneTimeCode" + autoComplete=
 *     "one-time-code". Paired with the Associated Domains entitlement
 *     for `app.refundlocators.com`, the email's `@domain #123456` line
 *     gets auto-detected by iOS and offered as a one-tap fill above
 *     the keyboard.
 */

import { useEffect, useState } from 'react'
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
} from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { supabase } from '../../lib/supabase'
import { KEYBOARD_DONE_ID, KeyboardDoneBar } from '../../components/KeyboardDoneBar'

type Step = 'email' | 'code'

// AsyncStorage key for the last-used email — pre-fill on next launch.
const LAST_EMAIL_KEY = 'dcc.signin.lastEmail'

export default function SignInScreen() {
  const [step, setStep] = useState<Step>('email')
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Pre-fill the email field with the last value we sent a code to.
  // For the 99% "one human, same email every time" case, this means
  // sign-in is just "tap Send code → tap the autofilled OTP → Verify".
  useEffect(() => {
    AsyncStorage.getItem(LAST_EMAIL_KEY)
      .then((saved) => {
        if (saved) setEmail(saved)
      })
      .catch(() => {})
  }, [])

  const sendCode = async () => {
    const target = email.trim().toLowerCase()
    if (!target || busy) return
    setBusy(true)
    setError(null)
    try {
      const { error: err } = await supabase.auth.signInWithOtp({
        email: target,
        options: { shouldCreateUser: true },
      })
      if (err) throw err
      // Persist for next launch
      AsyncStorage.setItem(LAST_EMAIL_KEY, target).catch(() => {})
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
      <Pressable
        style={styles.inner}
        onPress={Keyboard.dismiss}
        accessible={false}
      >
        <Text style={styles.title}>Deal Command Center</Text>
        <Text style={styles.subtitle}>
          {step === 'email'
            ? 'Sign in with your work email'
            : `Enter the code we sent to ${email}`}
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
              autoCorrect={false}
              autoComplete="email"
              textContentType="emailAddress"
              keyboardType="email-address"
              returnKeyType="send"
              onSubmitEditing={sendCode}
              editable={!busy}
              clearButtonMode="while-editing"
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
              placeholder="••••••"
              placeholderTextColor="#78716c"
              value={code}
              onChangeText={(v) => setCode(v.replace(/\D/g, '').slice(0, 10))}
              keyboardType="number-pad"
              autoComplete="one-time-code"
              textContentType="oneTimeCode"
              returnKeyType="go"
              onSubmitEditing={verifyCode}
              editable={!busy}
              maxLength={10}
              autoFocus
              inputAccessoryViewID={
                Platform.OS === 'ios' ? KEYBOARD_DONE_ID : undefined
              }
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
      </Pressable>
      <KeyboardDoneBar />
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
