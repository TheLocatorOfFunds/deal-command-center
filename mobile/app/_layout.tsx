/**
 * Root layout — wraps the entire app in AuthProvider, then renders the
 * route group that matches the current auth state. expo-router handles
 * the actual nav stack.
 */

import { useEffect } from 'react'
import { Stack, useRouter, useSegments } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { AuthProvider, useAuth } from '../lib/auth'
import { registerForPushAsync, subscribeToNotificationTaps } from '../lib/push'

function ProtectedRouter() {
  const { session, loading } = useAuth()
  const segments = useSegments()
  const router = useRouter()

  useEffect(() => {
    if (loading) return
    const inAuthGroup = segments[0] === '(auth)'
    if (!session && !inAuthGroup) {
      router.replace('/(auth)/sign-in')
    } else if (session && inAuthGroup) {
      router.replace('/(tabs)')
    }
  }, [session, loading, segments, router])

  // Register for push notifications after sign-in. Idempotent — safe to
  // re-run when the session changes. We silently swallow non-fatal errors
  // (e.g. permission denied) so the app still works.
  useEffect(() => {
    if (loading || !session) return
    registerForPushAsync().catch(() => {
      // Already handled inside; nothing more to do.
    })
  }, [loading, session])

  // Notification-tap routing. Different payloads land you in different
  // places. Set on the server side when firing the push.
  useEffect(() => {
    const unsub = subscribeToNotificationTaps((data) => {
      const type = data.type as string | undefined
      if (type === 'sms' && data.thread_key) {
        router.push({
          pathname: '/thread/[key]',
          params: { key: String(data.thread_key) },
        })
      } else if (type === 'call' && data.deal_id) {
        router.push(`/deal/${String(data.deal_id)}`)
      } else if (type === 'team' && data.thread_id) {
        router.push(`/team-thread/${String(data.thread_id)}`)
      } else if (type === 'team') {
        router.push('/(tabs)/team')
      } else if (type === 'deal' && data.deal_id) {
        router.push(`/deal/${String(data.deal_id)}`)
      }
    })
    return unsub
  }, [router])

  // Stack at root lets deal/[id] push on top of (tabs) with a back button.
  // Each child route configures its own header (or hides it).
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="(auth)/sign-in" options={{ headerShown: false }} />
      <Stack.Screen
        name="deal/[id]"
        options={{
          headerShown: true,
          headerStyle: { backgroundColor: '#0c0a09' },
          headerTintColor: '#fafaf9',
          headerBackTitle: 'Back',
        }}
      />
      <Stack.Screen
        name="thread/[key]"
        options={{
          headerShown: true,
          headerStyle: { backgroundColor: '#0c0a09' },
          headerTintColor: '#fafaf9',
          headerBackTitle: 'Inbox',
        }}
      />
      <Stack.Screen
        name="team-thread/[id]"
        options={{
          headerShown: true,
          headerStyle: { backgroundColor: '#0c0a09' },
          headerTintColor: '#fafaf9',
          headerBackTitle: 'Team',
        }}
      />
      <Stack.Screen
        name="quick/call"
        options={{
          headerShown: true,
          headerStyle: { backgroundColor: '#0c0a09' },
          headerTintColor: '#fafaf9',
        }}
      />
      <Stack.Screen
        name="quick/sms"
        options={{
          headerShown: true,
          headerStyle: { backgroundColor: '#0c0a09' },
          headerTintColor: '#fafaf9',
        }}
      />
      <Stack.Screen
        name="quick/note"
        options={{
          headerShown: true,
          headerStyle: { backgroundColor: '#0c0a09' },
          headerTintColor: '#fafaf9',
        }}
      />
      <Stack.Screen
        name="quick/new-deal"
        options={{
          headerShown: true,
          headerStyle: { backgroundColor: '#0c0a09' },
          headerTintColor: '#fafaf9',
        }}
      />
      <Stack.Screen
        name="quick/new-task"
        options={{
          headerShown: true,
          headerStyle: { backgroundColor: '#0c0a09' },
          headerTintColor: '#fafaf9',
        }}
      />
      <Stack.Screen
        name="settings"
        options={{
          headerShown: true,
          headerStyle: { backgroundColor: '#0c0a09' },
          headerTintColor: '#fafaf9',
        }}
      />
      <Stack.Screen
        name="forecast"
        options={{
          headerShown: true,
          headerStyle: { backgroundColor: '#0c0a09' },
          headerTintColor: '#fafaf9',
        }}
      />
    </Stack>
  )
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <ProtectedRouter />
        <StatusBar style="auto" />
      </AuthProvider>
    </SafeAreaProvider>
  )
}
