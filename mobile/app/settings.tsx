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
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Stack } from 'expo-router'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { registerForPushAsync } from '../lib/push'

type NotificationPrefs = {
  sms: boolean
  calls: boolean
  team: boolean
}

type Profile = {
  id: string
  name: string | null
  display_name: string | null
  role: string | null
  phone: string | null
  expo_push_token: string | null
  notification_prefs: NotificationPrefs | null
}

export default function SettingsScreen() {
  const { session, signOut } = useAuth()
  const userId = session?.user?.id ?? null
  const email = session?.user?.email ?? ''

  const [profile, setProfile] = useState<Profile | null>(null)
  const [phoneDraft, setPhoneDraft] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [registering, setRegistering] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refreshProfile = async () => {
    if (!userId) return
    const { data, error: err } = await supabase
      .from('profiles')
      .select(
        'id, name, display_name, role, phone, expo_push_token, notification_prefs',
      )
      .eq('id', userId)
      .maybeSingle()
    if (err) {
      setError(err.message)
    } else if (data) {
      setProfile(data as Profile)
      setPhoneDraft((data.phone as string) ?? '')
    }
  }

  const togglePref = async (
    key: keyof NotificationPrefs,
    nextValue: boolean,
  ) => {
    if (!userId) return
    const current: NotificationPrefs = profile?.notification_prefs ?? {
      sms: true,
      calls: true,
      team: true,
    }
    const next = { ...current, [key]: nextValue }
    // Optimistic update so the switch animates instantly
    setProfile((p) => (p ? { ...p, notification_prefs: next } : p))
    const { error: err } = await supabase
      .from('profiles')
      .update({ notification_prefs: next })
      .eq('id', userId)
    if (err) {
      Alert.alert('Could not save', err.message)
      await refreshProfile()
    }
  }

  useEffect(() => {
    if (!userId) return
    let mounted = true
    ;(async () => {
      await refreshProfile()
      if (mounted) setLoading(false)
    })()
    return () => {
      mounted = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId])

  const reRegisterPush = async () => {
    if (registering) return
    setRegistering(true)
    try {
      const result = await registerForPushAsync()
      if (result.ok) {
        await refreshProfile()
        Alert.alert(
          'Notifications enabled',
          'Your device is registered. You should now get banners for inbound SMS, team chat, and incoming calls.',
        )
      } else {
        Alert.alert('Could not register', result.message)
      }
    } finally {
      setRegistering(false)
    }
  }

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

              <Text style={styles.sectionLabel}>Notifications</Text>
              <View style={styles.section}>
                <View style={styles.field}>
                  <Text style={styles.fieldLabel}>Status</Text>
                  <Text
                    style={[
                      styles.fieldValue,
                      profile?.expo_push_token
                        ? styles.statusOk
                        : styles.statusWarn,
                    ]}
                  >
                    {profile?.expo_push_token
                      ? '✓ Registered for push'
                      : '⚠ Not registered — tap below to fix'}
                  </Text>
                </View>
                <Text style={styles.hint}>
                  Push notifications fire on inbound SMS, team chat, and
                  incoming calls. Tapping a banner deep-links you to the
                  relevant thread or deal.
                </Text>
                <TouchableOpacity
                  style={[
                    styles.saveBtn,
                    registering && styles.saveBtnDisabled,
                  ]}
                  onPress={reRegisterPush}
                  disabled={registering}
                >
                  <Text style={styles.saveBtnText}>
                    {registering
                      ? 'Registering…'
                      : profile?.expo_push_token
                        ? 'Re-register this device'
                        : 'Enable notifications'}
                  </Text>
                </TouchableOpacity>
              </View>

              <Text style={styles.sectionLabel}>Notify me about</Text>
              <View style={styles.section}>
                <PrefRow
                  label="Inbound SMS"
                  detail="When a homeowner texts the Twilio number"
                  value={profile?.notification_prefs?.sms ?? true}
                  onChange={(v) => togglePref('sms', v)}
                />
                <PrefRow
                  label="Incoming calls"
                  detail="When someone calls the Twilio number"
                  value={profile?.notification_prefs?.calls ?? true}
                  onChange={(v) => togglePref('calls', v)}
                />
                <PrefRow
                  label="Team chat"
                  detail="When a teammate posts in channels or DMs"
                  value={profile?.notification_prefs?.team ?? true}
                  onChange={(v) => togglePref('team', v)}
                  last
                />
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

function PrefRow(props: {
  label: string
  detail: string
  value: boolean
  onChange: (v: boolean) => void
  last?: boolean
}) {
  return (
    <View style={[styles.prefRow, props.last && { borderBottomWidth: 0 }]}>
      <View style={{ flex: 1, paddingRight: 12 }}>
        <Text style={styles.prefLabel}>{props.label}</Text>
        <Text style={styles.prefDetail}>{props.detail}</Text>
      </View>
      <Switch
        value={props.value}
        onValueChange={props.onChange}
        trackColor={{ false: '#292524', true: '#d97706' }}
        thumbColor="#fafaf9"
      />
    </View>
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
  statusOk: { color: '#34d399' },
  statusWarn: { color: '#fbbf24' },
  prefRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomColor: '#292524',
    borderBottomWidth: 1,
  },
  prefLabel: { color: '#fafaf9', fontSize: 14, fontWeight: '600' },
  prefDetail: { color: '#78716c', fontSize: 12, marginTop: 2 },
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
