/**
 * Team tab — placeholder for the Justin/Nathan/Eric internal channel.
 *
 * "If we're in Cincinnati and you want to just shoot them a message in
 * the DCC" — Justin in the May 11 scope meeting. Internal team chat,
 * NOT scoped to a customer deal. Keeps team chatter out of customer
 * threads.
 *
 * Real wiring is a follow-up PR — needs a new `team_messages` table
 * (or repurpose `messages` if we're feeling parsimonious) with simple
 * append-only writes and Postgres realtime subscriptions.
 */

import { StyleSheet, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'

export default function TeamScreen() {
  return (
    <SafeAreaView style={styles.container} edges={['left', 'right', 'top']}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Team</Text>
        <Text style={styles.headerSubtitle}>Internal channel · Justin · Nathan · Eric</Text>
      </View>
      <View style={styles.body}>
        <Text style={styles.placeholder}>Coming next</Text>
        <Text style={styles.placeholderSub}>
          Quick internal chat for the team — no customer scope, no Twilio.
          Phone-only Slack replacement for "hey check this out" messages.
        </Text>
      </View>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0c0a09' },
  header: {
    padding: 14,
    paddingBottom: 10,
    borderBottomColor: '#1c1917',
    borderBottomWidth: 1,
  },
  headerTitle: { color: '#fafaf9', fontSize: 22, fontWeight: '700' },
  headerSubtitle: { color: '#78716c', fontSize: 12, marginTop: 2 },
  body: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  placeholder: {
    color: '#d97706',
    fontSize: 14,
    fontWeight: '600',
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginBottom: 12,
  },
  placeholderSub: {
    color: '#78716c',
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
    maxWidth: 280,
  },
})
