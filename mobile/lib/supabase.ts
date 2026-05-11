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
