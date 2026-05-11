/**
 * The center "⊕ Quick" button rendered as the 3rd tab bar item.
 *
 * Doesn't navigate to a route — tapping opens a slide-up sheet with
 * three actions (Call, Text, Note). Each action navigates to a small
 * dedicated form screen under /quick/.
 *
 * The placeholder file at app/(tabs)/quick.tsx exists only because
 * expo-router requires a route file for every Tabs.Screen — the
 * actual route is never rendered (href: null on the screen).
 */

import { useState } from 'react'
import {
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native'
import { useRouter } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'

export function QuickFabButton() {
  const [open, setOpen] = useState(false)
  const router = useRouter()

  const go = (
    path:
      | '/quick/call'
      | '/quick/sms'
      | '/quick/note'
      | '/quick/new-deal'
      | '/quick/new-task',
  ) => {
    setOpen(false)
    // Tiny delay lets the modal close animation finish before pushing
    // the next screen, otherwise iOS sometimes loses the back gesture.
    setTimeout(() => router.push(path), 150)
  }

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Quick actions"
        onPress={() => setOpen(true)}
        style={({ pressed }) => [
          styles.fabContainer,
          pressed && { opacity: 0.85 },
        ]}
      >
        <View style={styles.fabCircle}>
          <Ionicons name="add" size={28} color="#0c0a09" />
        </View>
      </Pressable>

      <Modal
        visible={open}
        animationType="slide"
        transparent
        onRequestClose={() => setOpen(false)}
      >
        <Pressable
          style={styles.backdrop}
          onPress={() => setOpen(false)}
        >
          {/* swallow taps on the sheet itself */}
          <Pressable
            onPress={() => {}}
            style={[
              styles.sheet,
              Platform.OS === 'ios' && { paddingBottom: 32 },
            ]}
          >
            <View style={styles.handle} />
            <Text style={styles.sheetTitle}>Quick actions</Text>

            <Action
              icon="call"
              label="Call a number"
              detail="Bridges through the FundLocators Twilio number"
              onPress={() => go('/quick/call')}
            />
            <Action
              icon="chatbubble-ellipses"
              label="Text a number"
              detail="Outbound SMS via Twilio, optionally pinned to a deal"
              onPress={() => go('/quick/sms')}
            />
            <Action
              icon="document-text"
              label="Note on a deal"
              detail="Drop a quick note — typeahead search to find the deal"
              onPress={() => go('/quick/note')}
            />
            <Action
              icon="checkmark-circle"
              label="New task"
              detail="Drop a to-do on a deal — title, optional due date"
              onPress={() => go('/quick/new-task')}
            />
            <Action
              icon="add-circle"
              label="New deal"
              detail="Capture a new lead — type, name, address"
              onPress={() => go('/quick/new-deal')}
            />

            <TouchableOpacity
              onPress={() => setOpen(false)}
              style={styles.cancel}
            >
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  )
}

function Action(props: {
  icon: React.ComponentProps<typeof Ionicons>['name']
  label: string
  detail: string
  onPress: () => void
}) {
  return (
    <TouchableOpacity
      style={styles.action}
      onPress={props.onPress}
      activeOpacity={0.7}
    >
      <View style={styles.actionIconWrap}>
        <Ionicons name={props.icon} size={22} color="#d97706" />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.actionLabel}>{props.label}</Text>
        <Text style={styles.actionDetail}>{props.detail}</Text>
      </View>
      <Ionicons name="chevron-forward" size={20} color="#57534e" />
    </TouchableOpacity>
  )
}

const styles = StyleSheet.create({
  // The fab visually sits above the tab bar — slight upward translate
  // and a circular orange chip make it the affordance.
  fabContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fabCircle: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: '#d97706',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: -16,
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: '#000000bb',
  },
  sheet: {
    backgroundColor: '#1c1917',
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingTop: 12,
    paddingHorizontal: 16,
    paddingBottom: 18,
  },
  handle: {
    alignSelf: 'center',
    width: 38,
    height: 5,
    borderRadius: 999,
    backgroundColor: '#292524',
    marginBottom: 14,
  },
  sheetTitle: {
    color: '#fafaf9',
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 10,
  },
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    borderBottomColor: '#292524',
    borderBottomWidth: 1,
    gap: 14,
  },
  actionIconWrap: {
    width: 38,
    height: 38,
    borderRadius: 10,
    backgroundColor: '#0c0a09',
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionLabel: { color: '#fafaf9', fontSize: 15, fontWeight: '600' },
  actionDetail: { color: '#a8a29e', fontSize: 12, marginTop: 2 },
  cancel: {
    marginTop: 18,
    paddingVertical: 12,
    alignItems: 'center',
    backgroundColor: '#0c0a09',
    borderRadius: 12,
  },
  cancelText: { color: '#fafaf9', fontSize: 14, fontWeight: '600' },
})
