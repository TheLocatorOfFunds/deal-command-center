/**
 * Settings — profile + preferences + sign out.
 *
 * v1 surface is minimal but functional:
 *   - Display name (read-only for now, edited on the web)
 *   - Email (read-only, the auth identity)
 *   - Cell phone — editable. This is the number Twilio rings when you
 *     tap-to-call (the bridge leg). Was buried in a one-time prompt
 *     before; now you can update it any time.
 *   - Sign out (was buried on the Inbox header)
 *
 * Future: notification toggle (per-event), default deal filter, etc.
 */

import { useEffect, useState } from 'react'
import {
  ActivityIndicator,
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
import { Stack } from 'expo-router'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'

type Profile = {
  id: string
  name: string | null
  display_name: string | null
  role: string | null
  phone: string | null
}

export default function SettingsScreen() {
  const { session, signOut } = useAuth()
  const userId = session?.user?.id ?? null
  const email = session?.user?.email ?? ''

  const [profile, setProfile] = useState<Profile | null>(null)
  const [phoneDraft, setPhoneDraft] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!userId) return
    let mounted = true
    ;(async () => {
      const { data, error: err } = await supabase
        .from('profiles')
        .select('id, name, display_name, role, phone')
        .eq('id', userId)
        .maybeSingle()
      if (!mounted) return
      if (err) {
        setError(err.message)
      } else if (data) {
        setProfile(data as Profile)
        setPhoneDraft((data.phone as string) ?? '')
      }
      setLoading(false)
    })()
    return () => {
      mounted = false
    }
  }, [userId])

  const savePhone = async () => {
    if (!userId || saving) return
    const trimmed = phoneDraft.trim()
    setSaving(true)
    try {
      const { error: err } = await supabase
        .from('profiles')
        .update({ phone: trimmed || null })
        .eq('id', userId)
      if (err) throw err
      Alert.alert('Saved', 'Your cell phone has been updated.')
      setProfile((p) => (p ? { ...p, phone: trimmed || null } : p))
    } catch (e) {
      Alert.alert(
        'Could not save',
        e instanceof Error ? e.message : 'Unknown error',
      )
    } finally {
      setSaving(false)
    }
  }

  const phoneDirty = (profile?.phone ?? '') !== phoneDraft.trim()

  return (
    <SafeAreaView style={styles.container} edges={['left', 'right']}>
      <Stack.Screen
        options={{
          title: 'Settings',
          headerStyle: { backgroundColor: '#0c0a09' },
          headerTintColor: '#fafaf9',
          headerBackTitle: 'Back',
        }}
      />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerStyle={styles.scroll}>
          {loading ? (
            <View style={styles.loading}>
              <ActivityIndicator color="#d97706" />
            </View>
          ) : error ? (
            <View style={styles.errorBox}>
              <Text style={styles.errorText}>⚠ {error}</Text>
            </View>
          ) : (
            <>
              <Text style={styles.sectionLabel}>Profile</Text>
              <View style={styles.section}>
                <ReadOnlyField
                  label="Name"
                  value={
                    profile?.display_name || profile?.name || '(not set)'
                  }
                />
                <ReadOnlyField label="Email" value={email} />
                <ReadOnlyField
                  label="Role"
                  value={profile?.role ?? 'user'}
                  last
                />
              </View>

              <Text style={styles.sectionLabel}>
                Cell phone · used to bridge calls
              </Text>
              <View style={styles.section}>
                <TextInput
                  style={styles.input}
                  value={phoneDraft}
                  onChangeText={setPhoneDraft}
                  placeholder="(513) 555-0100"
                  placeholderTextColor="#78716c"
                  keyboardType="phone-pad"
                  editable={!saving}
                />
                <Text style={styles.hint}>
                  When you tap-to-call from a deal, Twilio rings this number.
                  Answer it to connect to the other party. The destination
                  sees the FundLocators business number as caller ID.
                </Text>
                <TouchableOpacity
                  style={[
                    styles.saveBtn,
                    (!phoneDirty || saving) && styles.saveBtnDisabled,
                  ]}
                  onPress={savePhone}
                  disabled={!phoneDirty || saving}
                >
                  <Text style={styles.saveBtnText}>
                    {saving ? 'Saving…' : 'Save cell'}
                  </Text>
                </TouchableOpacity>
              </View>

              <TouchableOpacity
                style={styles.signOutBtn}
                onPress={() =>
                  Alert.alert(
                    'Sign out?',
                    'You will need to enter your code again to sign back in.',
                    [
                      { text: 'Cancel', style: 'cancel' },
                      {
                        text: 'Sign out',
                        style: 'destructive',
                        onPress: signOut,
                      },
                    ],
                  )
                }
              >
                <Text style={styles.signOutText}>Sign out</Text>
              </TouchableOpacity>

              <Text style={styles.versionText}>DCC mobile · 0.1.0</Text>
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  )
}

function ReadOnlyField(props: {
  label: string
  value: string
  last?: boolean
}) {
  return (
    <View style={[styles.field, props.last && { borderBottomWidth: 0 }]}>
      <Text style={styles.fieldLabel}>{props.label}</Text>
      <Text style={styles.fieldValue}>{props.value}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0c0a09' },
  scroll: { padding: 14 },
  loading: { padding: 40, alignItems: 'center' },
  errorBox: {
    margin: 14,
    padding: 14,
    backgroundColor: '#7f1d1d',
    borderRadius: 10,
  },
  errorText: { color: '#fca5a5', fontSize: 14 },
  sectionLabel: {
    color: '#78716c',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginBottom: 8,
    marginTop: 4,
    paddingHorizontal: 4,
  },
  section: {
    backgroundColor: '#1c1917',
    borderRadius: 12,
    borderColor: '#292524',
    borderWidth: 1,
    padding: 14,
    marginBottom: 14,
  },
  field: {
    paddingVertical: 10,
    borderBottomColor: '#292524',
    borderBottomWidth: 1,
  },
  fieldLabel: { color: '#78716c', fontSize: 11, fontWeight: '600' },
  fieldValue: { color: '#fafaf9', fontSize: 15, marginTop: 4 },
  input: {
    backgroundColor: '#0c0a09',
    borderColor: '#292524',
    borderWidth: 1,
    color: '#fafaf9',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 18,
    marginBottom: 8,
  },
  hint: { color: '#78716c', fontSize: 12, lineHeight: 16, marginBottom: 12 },
  saveBtn: {
    backgroundColor: '#d97706',
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
  },
  saveBtnDisabled: { backgroundColor: '#292524' },
  saveBtnText: { color: '#0c0a09', fontWeight: '700', fontSize: 14 },
  signOutBtn: {
    backgroundColor: '#7f1d1d',
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
    marginTop: 8,
  },
  signOutText: { color: '#fafaf9', fontSize: 15, fontWeight: '700' },
  versionText: {
    color: '#57534e',
    fontSize: 12,
    textAlign: 'center',
    marginTop: 18,
  },
})
