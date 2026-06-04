/**
 * Supabase client — mobile edition.
 *
 * Uses the same project URL + publishable key as the web app (src/app.jsx).
 * The publishable key is designed for client-side use; RLS is what
 * protects data. Never embed the service-role key here.
 *
 * Session persistence: AsyncStorage on iOS/Android.
 *
 * If you ever rotate the publishable key on the web side, update it here too.
 */

import 'react-native-url-polyfill/auto'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { createClient } from '@supabase/supabase-js'

// Same values as the constants near the top of src/app.jsx
const SUPABASE_URL = 'https://rcfaashkfpurkvtmsmeb.supabase.co'
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_BjBJSBQC2iJXQodut3y3Ag_8aKyPmwv'

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
})

/**
 * Build a UNIQUE realtime channel topic per subscription instance.
 *
 * Why this exists: supabase-js reuses a RealtimeChannel by topic. Calling
 * supabase.channel('foo') a second time while a channel named 'foo' is still
 * registered hands back the EXISTING (already-subscribed) channel. Chaining
 * .on('postgres_changes', ...) onto an already-subscribed channel throws:
 *   "cannot add `postgres_changes` callbacks for realtime:foo after `subscribe()`."
 * In a release build an uncaught JS throw is escalated by React Native to a
 * fatal SIGABRT - it kills the whole app AND any active call.
 *
 * removeChannel() in an effect-cleanup is async, so a fast remount (e.g.
 * tapping a push notification that re-foregrounds a deal screen) can reach the
 * new .channel() call before the old channel has finished unsubscribing. A
 * per-instance suffix guarantees the new channel never collides with a
 * lingering one, so .on() always runs on a fresh, unsubscribed channel.
 *
 * Safe for us because every channel is postgres_changes (data sync) - we do
 * NOT share presence/broadcast state across clients, where a stable topic
 * would matter. Always pair with removeChannel(ch) in the effect cleanup.
 */
let _chanSeq = 0
export function chanName(base: string): string {
  _chanSeq += 1
  return `${base}:i${_chanSeq}`
}
