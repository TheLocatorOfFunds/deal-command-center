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
