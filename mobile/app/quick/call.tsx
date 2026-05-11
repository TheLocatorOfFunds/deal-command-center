/**
 * Quick action: call an arbitrary phone number.
 *
 * Routes the call through the existing Twilio bridge (placeCall helper)
 * so the destination sees the FundLocators business number, not the
 * user's personal cell.
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
import { placeCall, saveUserCellPhone } from '../../lib/dial'

export default function QuickCallScreen() {
  const router = useRouter()
  const [phone, setPhone] = useState('')
  const [busy, setBusy] = useState(false)

  const call = async () => {
    const target = phone.trim()
    if (!target || busy) return
    setBusy(true)
    try {
      const result = await placeCall(target)
      if (result.ok) {
        Alert.alert(
          'Calling…',
          result.message,
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
          <Text style={styles.label}>Phone number</Text>
          <TextInput
            style={styles.input}
            value={phone}
            onChangeText={setPhone}
            placeholder="(513) 555-0100"
            placeholderTextColor="#78716c"
            keyboardType="phone-pad"
            autoFocus
            editable={!busy}
          />
          <Text style={styles.hint}>
            Your cell will ring from the FundLocators Twilio number. Answer it
            to connect to {phone || 'the destination'}. They see the business
            number as caller ID.
          </Text>
          <TouchableOpacity
            style={[
              styles.button,
              (!phone.trim() || busy) && styles.buttonDisabled,
            ]}
            onPress={call}
            disabled={!phone.trim() || busy}
          >
            <Text style={styles.buttonText}>
              {busy ? 'Calling…' : 'Place call'}
            </Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0c0a09' },
  body: { flex: 1, padding: 20, gap: 12 },
  label: { color: '#a8a29e', fontSize: 12, fontWeight: '600', letterSpacing: 1, textTransform: 'uppercase' },
  input: {
    backgroundColor: '#1c1917',
    borderColor: '#292524',
    borderWidth: 1,
    color: '#fafaf9',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 14,
    fontSize: 20,
  },
  hint: { color: '#78716c', fontSize: 13, lineHeight: 18, marginTop: 2 },
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
