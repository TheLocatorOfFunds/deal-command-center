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
import * as Application from 'expo-application'
import { Voice, type Call, type CallInvite } from '@twilio/voice-react-native-sdk'
import { supabase } from './supabase'

const TOKEN_URL =
  'https://rcfaashkfpurkvtmsmeb.supabase.co/functions/v1/twilio-token'

let voice: Voice | null = null
let tokenRefreshTimer: ReturnType<typeof setTimeout> | null = null
let cachedToken: string | null = null
const _callInviteHandlers: Array<(callInvite: CallInvite) => void> = []

/**
 * Subscribe to incoming call invites. Returns an unsubscribe function.
 * Wire this up in `app/_layout.tsx` to navigate to the in-call screen
 * after the user accepts via CallKit.
 */
export function subscribeToCallInvite(
  handler: (callInvite: CallInvite) => void,
): () => void {
  _callInviteHandlers.push(handler)
  return () => {
    const idx = _callInviteHandlers.indexOf(handler)
    if (idx !== -1) _callInviteHandlers.splice(idx, 1)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Write SDK registration status to Supabase so we can verify from the
 * web app that initVoice() actually succeeded before testing inbound calls.
 *
 * Check voice_sdk_status in Supabase after installing any new build.
 * If the most recent row is 'failed' or missing, the device is NOT
 * registered with Twilio and inbound calls will never arrive — don't
 * waste time testing CallKit until this shows 'registered'.
 */
async function writeVoiceSdkStatus(
  status: 'registered' | 'failed' | 'error',
  errorMessage?: string,
): Promise<void> {
  try {
    const { data: sessionData } = await supabase.auth.getSession()
    const userId = sessionData.session?.user?.id
    if (!userId) return

    let tokenPrefix: string | undefined
    if (status === 'registered' && voice) {
      try {
        const tok = await voice.getDeviceToken()
        tokenPrefix = tok ? tok.substring(0, 12) : undefined
      } catch {}
    }

    await supabase.from('voice_sdk_status').insert({
      user_id: userId,
      device_id: Application.applicationId ?? 'unknown',
      build_number: Application.nativeBuildVersion ?? 'unknown',
      status,
      error_message: errorMessage ?? null,
      token_prefix: tokenPrefix ?? null,
    })
  } catch (e) {
    // Best-effort — never let this crash initVoice
    console.warn('[voice] writeVoiceSdkStatus failed', e)
  }
}

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
 *
 * IMPORTANT — PushKit timing race:
 * Twilio's `voice.register(token)` immediately checks for an iOS PushKit
 * device token. On cold launches that token isn't ready yet — iOS fires
 * `pushRegistry:didUpdatePushCredentials:forType:` asynchronously after
 * APNs completes its handshake (2-30+ seconds). If we call register()
 * before that, the SDK rejects with "Failed to initialize PushKit device
 * token" and `voice` ends up null — meaning Twilio never knows this
 * device exists, inbound CallInvites never arrive, and calls to the
 * 5440 number fall through to the bridge fallback. We diagnosed this
 * by streaming idevicesyslog during a real call on 2026-05-20 (Build 8).
 *
 * Fix: retry register() with exponential backoff. Most cold launches
 * succeed within ~5 seconds; we give it up to ~30 seconds before giving
 * up entirely.
 */
export async function initVoice(): Promise<boolean> {
  if (Platform.OS !== 'ios') return false // iOS-only for V1
  if (voice) return true

  const token = await fetchToken()
  if (!token) return false
  cachedToken = token

  try {
    voice = new Voice()
  } catch (e) {
    console.warn('[voice] new Voice() failed', e)
    voice = null
    return false
  }

  // Initialize PushKit. This creates PKPushRegistry and asks iOS for the
  // VoIP device token. Without this call, deviceTokenData is always nil,
  // voice.register() always fails with "Failed to initialize PushKit device
  // token", and the device is never registered — so Twilio never delivers
  // call invites to this device (foreground or background).
  //
  // Must be called BEFORE register(). The VoIP token arrives asynchronously
  // from iOS (typically 1-10 seconds), so the register() retry loop below
  // polls for it via exponential backoff.
  try {
    await voice.initializePushRegistry()
  } catch (e) {
    console.warn('[voice] initializePushRegistry failed', e)
    voice = null
    return false
  }

  // Wait a beat after setting up PKPushRegistry so iOS has time to fire
  // the pushRegistry:didUpdatePushCredentials: callback with the VoIP token.
  await sleep(1500)

  // Retry register() with backoff. The SDK throws synchronously if its
  // internal deviceToken is still nil — we retry until iOS catches up.
  const delays = [0, 1000, 2000, 3000, 5000, 8000, 10000] // ~29s total budget
  let lastErr: unknown = null
  for (const wait of delays) {
    if (wait > 0) await sleep(wait)
    try {
      await voice.register(token)
      lastErr = null
      break
    } catch (e) {
      lastErr = e
      const msg = e instanceof Error ? e.message : String(e)
      // Only retry on the specific PushKit-not-ready error; other errors
      // (network, bad token) won't fix themselves with more waiting.
      if (!/PushKit device token/i.test(msg)) {
        break
      }
      console.log('[voice] PushKit not ready yet, retrying', { wait, msg })
    }
  }
  if (lastErr) {
    const errMsg = lastErr instanceof Error ? lastErr.message : String(lastErr)
    console.warn('[voice] init failed after retries', lastErr)
    // Write failure to Supabase so we can verify from the web app
    // whether the SDK actually registered. Visible at Settings > Voice Status.
    void writeVoiceSdkStatus('failed', errMsg)
    voice = null
    return false
  }
  console.log('[voice] registered with Twilio (PushKit ready)')

  // Write success to Supabase — ground-truth confirmation the device is
  // registered. Check this FIRST before testing inbound calls on any new build.
  void writeVoiceSdkStatus('registered')

  // Refresh ~3 min before 12-hour token expires
  scheduleTokenRefresh(12 * 60 * 60 * 1000 - 3 * 60 * 1000)

  // Wire incoming-call handling: the SDK fires 'callInvite' when Twilio
  // pushes a VoIP notification. CallKit shows the native incoming-call UI
  // automatically (via TwilioVoiceReactNative+CallKit.m reportNewIncomingCall:).
  // When the user taps Accept in CallKit, the SDK accepts internally and
  // eventually fires Call.Event.Connected. We notify subscribers (e.g.
  // the root layout) so the app can navigate to the in-call screen.
  voice.on(Voice.Event.CallInvite, async (callInvite: CallInvite) => {
    const from = callInvite.getFrom() ?? 'unknown'
    console.log('[voice] callInvite received from', from)

    // Diagnostic write to Supabase — lets us confirm the callInvite event
    // fired without needing to stream device console logs. Remove once
    // inbound calling is verified stable.
    try {
      const { supabase } = await import('./supabase')
      const { data: session } = await supabase.auth.getSession()
      if (session.session) {
        await supabase.from('call_logs')
          .update({ status: 'ringing' })
          .eq('twilio_call_sid', callInvite.getCallSid?.() ?? '')
          .then(() => {}) // fire-and-forget
      }
    } catch {}

    // Notify any subscriber (e.g. root layout) so the app can open the
    // in-call screen after the user accepts via CallKit.
    for (const handler of _callInviteHandlers) {
      try { handler(callInvite) } catch {}
    }
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
      // Same retry pattern as initVoice — see PushKit timing race notes there.
      const delays = [0, 1000, 2000, 5000]
      for (const wait of delays) {
        if (wait > 0) await sleep(wait)
        try {
          await voice.register(fresh)
          break
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          if (!/PushKit device token/i.test(msg)) {
            console.warn('[voice] token refresh re-register failed', e)
            break
          }
        }
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
