/**
 * Root layout — wraps the entire app in AuthProvider, then renders the
 * route group that matches the current auth state. expo-router handles
 * the actual nav stack.
 */

import { useEffect, useRef, useCallback } from 'react'
import { AppState } from 'react-native'
import { Stack, useRouter, useSegments, useRootNavigationState } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import * as SplashScreen from 'expo-splash-screen'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { AuthProvider, useAuth } from '../lib/auth'
import { registerForPushAsync, subscribeToNotificationTaps } from '../lib/push'
import { initVoice, teardownVoice, subscribeToCallInvite, getVoice } from '../lib/voice'
import { useUnreadCount } from '../lib/notifications'

// Hold the splash screen until we've had ~1s to settle. Without this,
// the splash dismisses the instant the JS bundle finishes, which on a
// fast device flashes by before the user can register it.
SplashScreen.preventAutoHideAsync().catch(() => {
  // Fine if it was already auto-hidden — this is a no-op in that case.
})

function ProtectedRouter() {
  const { session, loading } = useAuth()
  const segments = useSegments()
  const router = useRouter()

  // Navigation-readiness: useRootNavigationState().key is undefined until the
  // root navigator mounts. We gate cold-start navigation on this so a tap that
  // launches the app can't router.push before the tree exists (= crash).
  const navState = useRootNavigationState()
  const navReady = !!navState?.key
  const navReadyRef = useRef(false)
  useEffect(() => {
    navReadyRef.current = navReady
  }, [navReady])

  // Dedup guard: a given call's accept should navigate exactly once, whether
  // the trigger is the foreground callInvite 'accepted' event or the AppState
  // re-entry path (green pill / Dynamic Island). Reset when no call is active.
  const navigatedCallSidRef = useRef<string | null>(null)

  // Holds a notification-tap payload that arrived before the navigator mounted
  // (cold-start tap); flushed once nav is ready. Without it, a cold-start tap
  // calls router.push before the root navigator exists and the app crashes.
  const pendingTapRef = useRef<Record<string, unknown> | null>(null)

  const routeFromTap = useCallback(
    (data: Record<string, unknown>) => {
      try {
        const type = data.type as string | undefined
        if (type === 'sms' && data.thread_key) {
          router.push({ pathname: '/thread/[key]', params: { key: String(data.thread_key) } })
        } else if (type === 'call' && data.deal_id) {
          router.push(`/deal/${String(data.deal_id)}`)
        } else if (type === 'team' && data.thread_id) {
          router.push(`/team-thread/${String(data.thread_id)}`)
        } else if (type === 'team') {
          router.push('/(tabs)/team')
        } else if (type === 'deal' && data.deal_id) {
          router.push(`/deal/${String(data.deal_id)}`)
        }
      } catch (e) {
        console.warn('[layout] notification tap routing failed', e)
      }
    },
    [router],
  )

  // Subscribe to unread notifications for the signed-in user. The hook
  // syncs the iOS app icon badge whenever the count changes. Returns the
  // current count too (unused here — the screens read it themselves).
  useUnreadCount(session?.user?.id ?? null)

  // Hide the splash once auth state has resolved (or after 1.5s, whichever
  // comes later — gives a tiny minimum hold so the splash actually shows).
  useEffect(() => {
    if (loading) return
    const t = setTimeout(() => {
      SplashScreen.hideAsync().catch(() => {})
    }, 1500)
    return () => clearTimeout(t)
  }, [loading])

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

  // Initialize Twilio Voice SDK after sign-in so inbound calls to
  // +1 513 998 5440 ring this device via PushKit/CallKit. If init fails
  // (no network, no Twilio config), the legacy bridge-callback dialer in
  // dial.ts continues to work — see voice.ts.
  useEffect(() => {
    if (loading || !session) return
    initVoice().catch(() => {
      // Already handled inside; voice.ts returns false on failure.
    })
    return () => {
      teardownVoice().catch(() => {})
    }
  }, [loading, session])

  // When the user accepts an inbound call via the native CallKit UI,
  // the SDK fires the callInvite event. Navigate to the deal (if known)
  // first, then open the in-call modal on top so the call controls float
  // over the deal context. When the call ends the modal dismisses and the
  // deal is already waiting underneath.
  useEffect(() => {
    if (loading || !session) return
    const unsub = subscribeToCallInvite((callInvite) => {
      // Navigate only after the user accepts via CallKit — not on invite delivery.
      callInvite.on('accepted', (call: any) => {
        const sid = call?.getSid?.() ?? callInvite.getCallSid?.() ?? ''
        // Dedup: the AppState re-entry path may also fire for this same call.
        // Whichever runs first navigates; the other is a no-op.
        if (!sid || navigatedCallSidRef.current === sid) return
        navigatedCallSidRef.current = sid
        // getCustomParameters() returns Record<string, string> - plain object, no .get().
        const dealId = callInvite.getCustomParameters?.()?.['dealId'] ?? null
        // Push deal first so it sits under the call modal; when the call
        // ends and the modal closes, the user lands directly on the deal.
        if (dealId) router.push(`/deal/${dealId}`)
        router.push({ pathname: '/call/[sid]', params: { sid } })
      })
    })
    return unsub
  }, [loading, session, router])

  // Dynamic Island / green pill tap: when iOS brings the app to the
  // foreground while a call is active, navigate to the in-call screen.
  // Without this, tapping the green pill opens the app but nothing
  // happens because there's no code checking for an active call.
  useEffect(() => {
    if (loading || !session) return
    const subscription = AppState.addEventListener('change', async (nextState) => {
      if (nextState !== 'active') return
      const v = getVoice()
      if (!v) {
        // Voice init failed or is still pending (PushKit token slow on first launch).
        // Retry on every foreground — idempotent because initVoice() has a mutex.
        initVoice().catch(() => {})
        return
      }
      try {
        const calls = await v.getCalls()
        if (calls.size > 0) {
          const call = [...calls.values()][0] as any
          const sid = call?.getSid?.() ?? [...calls.keys()][0] ?? ''
          // Dedup so re-foregrounding mid-call doesn't stack duplicate screens.
          if (sid && navigatedCallSidRef.current !== sid) {
            navigatedCallSidRef.current = sid
            // Open the deal underneath (if the call carries one), then float the
            // call screen on top — hanging up then leaves you on the deal.
            let dealId: string | null = null
            try {
              dealId = call?.getCustomParameters?.()?.['dealId'] || null
            } catch {}
            if (dealId) router.push(`/deal/${dealId}`)
            router.push({ pathname: '/call/[sid]', params: { sid } })
          }
        } else {
          // No active call — reset the guard so the next call navigates.
          navigatedCallSidRef.current = null
        }
      } catch {
        // No active calls or SDK unavailable — nothing to do.
      }
    })
    return () => subscription.remove()
  }, [loading, session, router])

  // Notification-tap routing. Different payloads land you in different places
  // (type set server-side when firing the push). A cold-start tap (app launched
  // FROM the notification) can fire before the navigation tree is mounted —
  // routing then crashes. So if nav isn't ready, stash the payload and flush it
  // once it is (the effect below). Warm taps route immediately.
  useEffect(() => {
    const unsub = subscribeToNotificationTaps((data) => {
      if (!navReadyRef.current) {
        pendingTapRef.current = data
        return
      }
      routeFromTap(data)
    })
    return unsub
  }, [routeFromTap])

  // Flush a notification tap that arrived before the navigator was mounted.
  useEffect(() => {
    if (navReady && pendingTapRef.current) {
      const data = pendingTapRef.current
      pendingTapRef.current = null
      routeFromTap(data)
    }
  }, [navReady, routeFromTap])

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
      <Stack.Screen
        name="notifications"
        options={{
          headerShown: true,
          headerStyle: { backgroundColor: '#0c0a09' },
          headerTintColor: '#fafaf9',
          headerBackTitle: 'Back',
          title: 'Notifications',
        }}
      />
      <Stack.Screen
        name="search"
        options={{
          headerShown: true,
          headerStyle: { backgroundColor: '#0c0a09' },
          headerTintColor: '#fafaf9',
          headerBackTitle: 'Back',
          title: 'Search',
        }}
      />
      <Stack.Screen
        name="call/[sid]"
        options={{
          presentation: 'modal',
          headerShown: false,
          gestureEnabled: false,
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
