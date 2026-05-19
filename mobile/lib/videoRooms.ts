/**
 * Shared Jitsi video-room config.
 *
 * Each teammate has a fixed `meet.jit.si/...` room. Nathan/Justin can
 * tap to join any of them from mobile, and the same URLs are linked
 * from the web app (`src/app.jsx`) so cross-surface joining "just
 * works."
 *
 * Mobile uses `Linking.openURL` to hand off to the Jitsi Meet iOS app
 * (or Safari if not installed) — no in-app WebView, no SDK. Full
 * Jitsi feature set + no maintenance overhead.
 */

export type VideoRoom = {
  label: string
  url: string
}

export const VIDEO_ROOMS: VideoRoom[] = [
  { label: 'Nathan', url: 'https://meet.jit.si/DCC-Nathan-Room' },
  { label: 'Justin', url: 'https://meet.jit.si/DCC-Justin-Room' },
  { label: 'Eric', url: 'https://meet.jit.si/DCC-Eric-Room' },
  { label: 'Anam', url: 'https://meet.jit.si/DCC-Anam-Room' },
]

const JITSI_URL_RE = /https?:\/\/meet\.jit\.si\/[\w\-./%+]+/gi

export function extractJitsiUrls(text: string | null | undefined): string[] {
  if (!text) return []
  const m = text.match(JITSI_URL_RE)
  return m ? Array.from(new Set(m)) : []
}
