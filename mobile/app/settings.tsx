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
import Constants from 'expo-constants'
import * as Application from 'expo-application'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { registerForPushAsync } from '../lib/push'
import { KEYBOARD_DONE_ID, KeyboardDoneBar } from '../components/KeyboardDoneBar'

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
  const [nameDraft, setNameDraft] = useState('')
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
      setNameDraft(
        (data.display_name as string) || (data.name as string) || '',
      )
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

  const pingSelf = async () => {
    if (!userId) return
    try {
      const { data: sessionData } = await supabase.auth.getSession()
      const token = sessionData.session?.access_token
      if (!token) throw new Error('Not signed in')
      // send-push-notification is verify_jwt=false (DB triggers call it)
      // so anon-key auth is fine. Self-targeted ping for verification.
      const res = await fetch(
        'https://rcfaashkfpurkvtmsmeb.supabase.co/functions/v1/send-push-notification',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            // Anon key is fine for this; the function doesn't gate on JWT
          },
          body: JSON.stringify({
            user_id: userId,
            title: 'DCC push test',
            body: 'If you see this banner, push is wired end-to-end.',
            data: { type: 'self_test' },
          }),
        },
      )
      const payload = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(payload.error || `HTTP ${res.status}`)
      }
      if (payload.delivered === 0) {
        Alert.alert(
          'Sent — but no token',
          'The function ran but your push token is null. Tap "Enable notifications" above first.',
        )
      } else {
        Alert.alert(
          'Test push sent',
          'You should see a banner within a few seconds. If nothing appears, check iOS Settings → DCC → Notifications.',
        )
      }
    } catch (e) {
      Alert.alert(
        'Test failed',
        e instanceof Error ? e.message : 'Unknown error',
      )
    }
  }

  const saveName = async () => {
    if (!userId || saving) return
    const trimmed = nameDraft.trim()
    if (!trimmed) return
    setSaving(true)
    try {
      const { error: err } = await supabase
        .from('profiles')
        .update({ display_name: trimmed })
        .eq('id', userId)
      if (err) throw err
      setProfile((p) => (p ? { ...p, display_name: trimmed } : p))
      Alert.alert('Saved', 'Display name updated.')
    } catch (e) {
      Alert.alert(
        'Could not save',
        e instanceof Error ? e.message : 'Unknown error',
      )
    } finally {
      setSaving(false)
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
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
        >
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
                <Text style={styles.fieldLabel}>Display name</Text>
                <View style={styles.inlineInputRow}>
                  <TextInput
                    style={[styles.input, { flex: 1, marginBottom: 0 }]}
                    value={nameDraft}
                    onChangeText={setNameDraft}
                    placeholder="Justin"
                    placeholderTextColor="#78716c"
                    editable={!saving}
                  />
                  {(profile?.display_name ?? profile?.name ?? '') !==
                    nameDraft.trim() &&
                    !!nameDraft.trim() && (
                      <TouchableOpacity
                        onPress={saveName}
                        style={styles.inlineSave}
                        disabled={saving}
                      >
                        <Text style={styles.inlineSaveText}>Save</Text>
                      </TouchableOpacity>
                    )}
                </View>
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
                  inputAccessoryViewID={
                    Platform.OS === 'ios' ? KEYBOARD_DONE_ID : undefined
                  }
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
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <TouchableOpacity
                    style={[
                      styles.saveBtn,
                      { flex: 1 },
                      registering && styles.saveBtnDisabled,
                    ]}
                    onPress={reRegisterPush}
                    disabled={registering}
                  >
                    <Text style={styles.saveBtnText}>
                      {registering
                        ? 'Registering…'
                        : profile?.expo_push_token
                          ? 'Re-register'
                          : 'Enable notifications'}
                    </Text>
                  </TouchableOpacity>
                  {profile?.expo_push_token && (
                    <TouchableOpacity
                      style={[styles.saveBtn, { flex: 1, backgroundColor: '#1c1917', borderColor: '#d97706', borderWidth: 1 }]}
                      onPress={pingSelf}
                    >
                      <Text
                        style={[styles.saveBtnText, { color: '#d97706' }]}
                      >
                        Test push
                      </Text>
                    </TouchableOpacity>
                  )}
                </View>
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

              {/* Build identity — pulled from `expo-application` at runtime
                  so it ALWAYS reflects the actual installed binary, not the
                  stale "buildNumber": "1" hardcoded in app.json.

                  Why expo-application instead of expo-constants:
                  - Constants.nativeBuildVersion was deprecated in
                    expo-constants 17+ and returns `undefined` in SDK 54.
                    On 2026-05-24 Justin saw "(build 1)" because the code
                    fell through to Constants.expoConfig.ios.buildNumber,
                    which is the stale "1" in app.json. EAS auto-bumps the
                    binary's CFBundleVersion but DOESN'T touch app.json.
                  - Application.nativeBuildVersion reads CFBundleVersion
                    directly from the device binary, so it returns the
                    actual number EAS baked in (8, 9, 10…).

                  On Expo Go / dev client both may be null — fall back to
                  Constants.expoConfig.ios.buildNumber so we at least show
                  something instead of "?". */}
              <Text style={styles.versionText}>
                {`DCC mobile · v${
                  Application.nativeApplicationVersion ??
                  Constants.expoConfig?.version ??
                  '?'
                } (build ${
                  Application.nativeBuildVersion ??
                  Constants.expoConfig?.ios?.buildNumber ??
                  '?'
                })`}
              </Text>
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
      <KeyboardDoneBar />
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
  inlineInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 4,
    marginBottom: 12,
  },
  inlineSave: {
    backgroundColor: '#d97706',
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 10,
  },
  inlineSaveText: { color: '#0c0a09', fontWeight: '700' },
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
