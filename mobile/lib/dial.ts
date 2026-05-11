/**
 * Outbound call helper for the mobile app.
 *
 * Hits the `mobile-place-call` Edge Function, which uses Twilio to ring
 * the signed-in user's cell and bridge them to the destination — so the
 * destination sees the Twilio business number, not the user's personal
 * cell.
 *
 * Returns a discriminated result instead of throwing — keeps the UI
 * code's error handling flat.
 */

import { supabase } from './supabase'

const FUNCTION_URL =
  'https://rcfaashkfpurkvtmsmeb.supabase.co/functions/v1/mobile-place-call'

export type PlaceCallResult =
  | { ok: true; message: string; callSid: string }
  | { ok: false; error: 'cell_phone_required'; message: string }
  | { ok: false; error: 'recipient_on_dnd'; message: string }
  | { ok: false; error: 'auth'; message: string }
  | { ok: false; error: 'twilio' | 'unknown'; message: string }

export async function placeCall(
  toNumber: string,
  opts?: { dealId?: string; contactId?: string },
): Promise<PlaceCallResult> {
  const { data: sessionData } = await supabase.auth.getSession()
  const token = sessionData.session?.access_token
  if (!token) {
    return {
      ok: false,
      error: 'auth',
      message: 'Not signed in.',
    }
  }

  let res: Response
  try {
    res = await fetch(FUNCTION_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        to_number: toNumber,
        deal_id: opts?.dealId ?? null,
        contact_id: opts?.contactId ?? null,
      }),
    })
  } catch (e) {
    return {
      ok: false,
      error: 'unknown',
      message: e instanceof Error ? e.message : 'Network error',
    }
  }

  let body: Record<string, unknown> = {}
  try {
    body = await res.json()
  } catch {
    // empty
  }

  if (res.ok && body.ok) {
    return {
      ok: true,
      message: String(
        body.message ?? 'Your phone will ring shortly. Answer to connect.',
      ),
      callSid: String(body.call_sid ?? ''),
    }
  }

  // Error path
  const errKey = String(body.error ?? '')
  const message = String(
    body.message ??
      body.details ??
      `Call failed (HTTP ${res.status}).`,
  )

  if (errKey === 'cell_phone_required') {
    return { ok: false, error: 'cell_phone_required', message }
  }
  if (errKey === 'recipient_on_dnd') {
    return { ok: false, error: 'recipient_on_dnd', message }
  }
  if (errKey === 'twilio_error') {
    return { ok: false, error: 'twilio', message }
  }
  if (res.status === 401) {
    return { ok: false, error: 'auth', message }
  }
  return { ok: false, error: 'unknown', message }
}

/**
 * Save the signed-in user's cell phone to profiles.phone — called by the
 * UI when placeCall returns `cell_phone_required` and the user has just
 * typed in their cell.
 */
export async function saveUserCellPhone(phone: string): Promise<{
  ok: boolean
  message?: string
}> {
  const { data: sessionData } = await supabase.auth.getSession()
  const userId = sessionData.session?.user?.id
  if (!userId) return { ok: false, message: 'Not signed in.' }

  const trimmed = phone.replace(/[^\d+]/g, '')
  // Light client-side sanity check; Edge Function will normalize again
  const digits = trimmed.replace(/^\+/, '')
  if (digits.length < 10) {
    return { ok: false, message: 'Phone number looks too short.' }
  }

  const { error } = await supabase
    .from('profiles')
    .update({ phone: trimmed })
    .eq('id', userId)
  if (error) return { ok: false, message: error.message }
  return { ok: true }
}
