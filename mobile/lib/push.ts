/**
 * Push notification registration for the DCC mobile app.
 *
 * Phase 1 uses the Expo Push Service: we get a token of the form
 * `ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]`, save it to
 * `profiles.expo_push_token`, and the server-side `send-push-notification`
 * Edge Function POSTs to https://exp.host/--/api/v2/push/send to deliver.
 *
 * Phase 2 (EAS dev build) can switch to direct APNs by configuring
 * Notifications.setNotificationCategoryAsync + APNs credentials in
 * Apple Developer + EAS push credentials. Same token column, just a
 * different format on iOS.
 *
 * Expo Go quirk: as of SDK 54, push tokens are still issued for Expo Go
 * but Apple will not deliver to Expo Go in TestFlight — tokens must be
 * re-registered in the dev build for delivery to work end-to-end.
 * That's fine for development; we re-register on every app launch
 * anyway because tokens can rotate.
 */

import * as Device from 'expo-device'
import * as Notifications from 'expo-notifications'
import { Platform } from 'react-native'
import Constants from 'expo-constants'
import { supabase } from './supabase'

// How push notifications behave when received while the app is open.
// Both alert + sound + badge so the user actually notices a new SMS.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
})

export type RegisterResult =
  | { ok: true; token: string }
  | { ok: false; reason: 'not_device' | 'permission_denied' | 'no_project' | 'error'; message: string }

/**
 * Request notification permission, fetch the Expo push token, and persist
 * it to the caller's profiles row. Idempotent — safe to call on every
 * app launch.
 */
export async function registerForPushAsync(): Promise<RegisterResult> {
  if (!Device.isDevice) {
    return {
      ok: false,
      reason: 'not_device',
      message: 'Push notifications only work on a physical device, not the simulator.',
    }
  }

  // Ask permission if we don't already have it
  const { status: existing } = await Notifications.getPermissionsAsync()
  let finalStatus = existing
  if (existing !== 'granted') {
    const { status } = await Notifications.requestPermissionsAsync()
    finalStatus = status
  }
  if (finalStatus !== 'granted') {
    return {
      ok: false,
      reason: 'permission_denied',
      message:
        'Notifications permission denied. You can enable it later in Settings → DCC → Notifications.',
    }
  }

  // Android notification channel — required for any Android push to show.
  // No-op on iOS but harmless.
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'Default',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#d97706',
    })
  }

  // Fetch the Expo push token. Project ID comes from app.json's "extra.eas.projectId"
  // (set by EAS init). In Expo Go without an EAS link, this falls back to legacy
  // tokens that still work for the Expo Push Service.
  const projectId =
    Constants?.expoConfig?.extra?.eas?.projectId ??
    (Constants as { easConfig?: { projectId?: string } }).easConfig?.projectId
  let token: string
  try {
    const tokenObj = projectId
      ? await Notifications.getExpoPushTokenAsync({ projectId })
      : await Notifications.getExpoPushTokenAsync()
    token = tokenObj.data
  } catch (e) {
    return {
      ok: false,
      reason: 'error',
      message: e instanceof Error ? e.message : 'Failed to fetch push token',
    }
  }

  // Persist to profiles. We use the auth.uid via session — RLS already
  // restricts updates to the user's own row.
  const { data: sessionData } = await supabase.auth.getSession()
  const userId = sessionData.session?.user?.id
  if (!userId) {
    return {
      ok: false,
      reason: 'error',
      message: 'Not signed in — cannot save push token.',
    }
  }

  const { error } = await supabase
    .from('profiles')
    .update({ expo_push_token: token })
    .eq('id', userId)
  if (error) {
    return {
      ok: false,
      reason: 'error',
      message: error.message,
    }
  }

  return { ok: true, token }
}

/**
 * Tap-handler for incoming notifications — wires the "tap a notification
 * → open the right screen" UX. The notification's `data` field carries
 * intent ("open thread", "open deal", etc.) which the server side sets
 * when firing the push.
 *
 * Also handles the cold-start case: if the app was launched FROM a
 * notification tap (vs. tapped while running), we call `onTap` with the
 * launching notification's data once on subscribe. Without this, cold
 * launches drop you on the default tab instead of the deal/thread.
 */
export function subscribeToNotificationTaps(
  onTap: (data: Record<string, unknown>) => void,
): () => void {
  let unmounted = false
  // Cold-start: was the app launched by tapping a notification?
  Notifications.getLastNotificationResponseAsync().then((resp) => {
    if (unmounted || !resp) return
    const data = resp.notification.request.content.data ?? {}
    onTap(data as Record<string, unknown>)
  })
  // Warm taps: subscription
  const sub = Notifications.addNotificationResponseReceivedListener((resp) => {
    const data = resp.notification.request.content.data ?? {}
    onTap(data as Record<string, unknown>)
  })
  return () => {
    unmounted = true
    sub.remove()
  }
}
