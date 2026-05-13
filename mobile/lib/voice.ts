/**
 * Twilio Voice SDK wrapper for DCC mobile.
 *
 * Replaces the bridge-callback flow in `dial.ts` with a true in-app
 * voice connection. The user's phone doesn't ring first — the app
 * dials directly over a Twilio VoIP connection, and CallKit shows the
 * native call UI on iOS.
 *
 * Lifecycle:
 *   1. On app launch (in app/_layout.tsx), call `initVoice()` to:
 *      - Fetch a Voice access token from the `twilio-token` Edge Function
 *      - Initialize a Voice instance with that token
 *      - Register the device with Twilio's PushKit so inbound calls
 *        ring via the native iOS CallKit UI even when the app is killed
 *   2. Token auto-refreshes ~3 min before expiry (12-hour token)
 *   3. For outbound: call `placeCallIn(toNumber, {dealId, contactId})` —
 *      returns a Call object. CallKit shows the calling UI automatically.
 *   4. For inbound: the SDK fires a 'callInvite' event, we accept via
 *      `callInvite.accept()` which CallKit-completes the call.
 *
 * Falls back to legacy bridge-callback flow (`dial.ts`) if Voice SDK
 * fails to initialize — important during V1 rollout while we monitor
 * reliability.
 */

import { Platform } from 'react-native'
import { Voice, type Call, type CallInvite } from '@twilio/voice-react-native-sdk'
import { supabase } from './supabase'

const TOKEN_URL =
  'https://rcfaashkfpurkvtmsmeb.supabase.co/functions/v1/twilio-token'

let voice: Voice | null = null
let tokenRefreshTimer: ReturnType<typeof setTimeout> | null = null
let cachedToken: string | null = null

/**
 * Fetch a fresh Voice access token from the `twilio-token` Edge Function.
 * Caches the token in memory for outbound calls; the SDK manages its own
 * registration token lifecycle for inbound.
 */
async function fetchToken(): Promise<string | null> {
  const { data: sessionData } = await supabase.auth.getSession()
  const authToken = sessionData.session?.access_token
  if (!authToken) return null

  try {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${authToken}`,
        'Content-Type': 'application/json',
      },
    })
    if (!res.ok) return null
    const body = (await res.json()) as { token?: string }
    return body.token ?? null
  } catch {
    return null
  }
}

/**
 * Initialize the Voice SDK on app launch. Idempotent — safe to call
 * multiple times.
 *
 * Returns `false` if init fails (no auth, no Twilio config, network
 * error). Caller should fall back to the legacy `dial.ts` flow.
 */
export async function initVoice(): Promise<boolean> {
  if (Platform.OS !== 'ios') return false // iOS-only for V1
  if (voice) return true

  const token = await fetchToken()
  if (!token) return false
  cachedToken = token

  try {
    voice = new Voice()
    // Register the device with Twilio so PushKit pushes deliver inbound
    // call invites to this device. SDK manages the PushKit token internally.
    await voice.register(token)
  } catch (e) {
    console.warn('[voice] init failed', e)
    voice = null
    return false
  }

  // Refresh ~3 min before 12-hour token expires
  scheduleTokenRefresh(12 * 60 * 60 * 1000 - 3 * 60 * 1000)

  // Wire incoming-call handling: the SDK fires 'callInvite' when Twilio
  // pushes a VoIP notification. Accepting via callInvite.accept() hands
  // off to CallKit, which is already showing the native incoming-call UI.
  voice.on(Voice.Event.CallInvite, async (callInvite: CallInvite) => {
    // The CallKit prompt is shown automatically by the SDK using the
    // PushKit payload. When the user taps Accept, the SDK fires
    // `acceptCallInvite` on the callInvite object behind the scenes.
    // Our job is just to log + populate the in-call screen with deal context.
    console.log('[voice] callInvite from', await callInvite.getFrom())
    // The in-call screen reads custom params (dealId, contactId) off the
    // callInvite — populated by twilio-voice Edge Function TwiML.
  })

  return true
}

/** Clean up when signing out. */
export async function teardownVoice(): Promise<void> {
  if (tokenRefreshTimer) {
    clearTimeout(tokenRefreshTimer)
    tokenRefreshTimer = null
  }
  if (voice && cachedToken) {
    try {
      await voice.unregister(cachedToken)
    } catch {
      // best effort
    }
  }
  voice = null
  cachedToken = null
}

function scheduleTokenRefresh(ms: number) {
  if (tokenRefreshTimer) clearTimeout(tokenRefreshTimer)
  tokenRefreshTimer = setTimeout(async () => {
    if (!voice) return
    const fresh = await fetchToken()
    if (fresh) {
      cachedToken = fresh
      try {
        await voice.register(fresh)
      } catch (e) {
        console.warn('[voice] token refresh re-register failed', e)
      }
    }
    scheduleTokenRefresh(12 * 60 * 60 * 1000 - 3 * 60 * 1000)
  }, ms)
}

export type PlaceCallInResult =
  | { ok: true; call: Call }
  | { ok: false; reason: 'not_initialized' | 'no_token' | 'error'; message: string }

/**
 * Place an outbound call directly via the Voice SDK. CallKit shows the
 * standard outgoing-call UI; the call is recorded in `call_logs` via
 * Twilio webhooks.
 *
 * Custom params (`dealId`, `contactId`) flow to `twilio-voice-outbound`
 * Edge Function, which writes them to call_logs alongside the Twilio
 * call SID.
 */
export async function placeCallIn(
  toNumber: string,
  params?: { dealId?: string; contactId?: string },
): Promise<PlaceCallInResult> {
  if (!voice || !cachedToken) {
    return {
      ok: false,
      reason: 'not_initialized',
      message: 'Voice SDK not initialized. Falling back to legacy dialer.',
    }
  }
  try {
    const call = await voice.connect(cachedToken, {
      params: {
        To: toNumber,
        dealId: params?.dealId ?? '',
        contactId: params?.contactId ?? '',
      },
    })
    return { ok: true, call }
  } catch (e) {
    return {
      ok: false,
      reason: 'error',
      message: e instanceof Error ? e.message : 'Voice SDK connect failed',
    }
  }
}

export function getVoice(): Voice | null {
  return voice
}
