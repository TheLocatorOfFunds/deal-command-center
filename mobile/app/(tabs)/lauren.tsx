/**
 * Lauren tab — placeholder for the pgvector AI chat.
 *
 * Why this is a separate tab and not folded under Inbox: bundling
 * Lauren under Inbox muddies the "is this a customer thread or an AI
 * thread" mental model. Better to give the AI its own surface.
 *
 * Real wiring is a follow-up PR — invoke the existing `lauren-chat`
 * Edge Function, stream the response, persist to a chat history table.
 */

import { StyleSheet, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'

export default function LaurenScreen() {
  return (
    <SafeAreaView style={styles.container} edges={['left', 'right', 'top']}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Lauren</Text>
        <Text style={styles.headerSubtitle}>Case AI · pgvector grounded</Text>
      </View>
      <View style={styles.body}>
        <Text style={styles.placeholder}>Coming next</Text>
        <Text style={styles.placeholderSub}>
          Ask Lauren anything about a deal — judgments, deadlines, contacts,
          activity. Same AI as the web app, just thumb-sized.
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
