/**
 * In-call screen.
 *
 * Floats as a modal route on top of the rest of the app — gesture-disabled
 * so swipe-down can't accidentally drop the call. Audio continues even if
 * the user backgrounds the call screen by navigating into a deal: CallKit
 * keeps the call alive at the iOS level, and the call object lives in the
 * voice.ts singleton.
 *
 * Header: deal/contact context pulled from the active Call's custom params
 * (set by twilio-voice / twilio-voice-outbound TwiML).
 * Controls: mute, speaker, hang up — the basics. Earpiece is the default
 * output (matches iOS native call behavior).
 */

import { useEffect, useRef, useState } from 'react'
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
} from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { getVoice } from '../../lib/voice'
import { Call, Voice } from '@twilio/voice-react-native-sdk'

export default function CallScreen() {
  // `name`/`to` are optional outbound hooks: outbound calls don't echo
  // connect() custom params back through getCustomParameters(), so the dialer
  // passes the contact/deal name + dialed number as route params for context.
  const { sid, name: routeName, to: routeTo } = useLocalSearchParams<{
    sid: string
    name?: string
    to?: string
  }>()
  const router = useRouter()

  const [call, setCall] = useState<Call | null>(null)
  const [state, setState] = useState<string>('connecting')
  // Prevents the onDisconnected auto-dismiss from firing a second router.back()
  // when the user tapped End themselves (hangUp already calls router.back()).
  const hangingUpRef = useRef(false)
  const [muted, setMuted] = useState(false)
  const [onSpeaker, setOnSpeaker] = useState(false)
  const [dealName, setDealName] = useState<string | null>(null)
  const [counterparty, setCounterparty] = useState<string | null>(null)
  const [durationSec, setDurationSec] = useState(0)

  // Find the active call from the voice singleton. The sid is the
  // Twilio CallSid passed via route params when we navigated here.
  useEffect(() => {
    const voice = getVoice()
    if (!voice) return
    let cancelled = false
    ;(async () => {
      try {
        const calls = await voice.getCalls()
        const found =
          Array.from(calls.values()).find(
            (c) => (c as Call).getSid?.() === sid,
          ) ?? Array.from(calls.values())[0]
        if (!cancelled) setCall((found as Call) ?? null)
      } catch (e) {
        console.warn('[call screen] failed to resolve call', e)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [sid])

  // Wire call state listeners
  useEffect(() => {
    if (!call) return
    const onConnected = () => setState('connected')
    const onDisconnected = () => {
      setState('ended')
      // Dismiss after a beat so the user sees "Ended" — but only if hangUp()
      // hasn't already called router.back() itself (e.g. user tapped End).
      // Without this guard, hangUp triggers Disconnected which schedules a
      // second back(), causing the deal page to also pop 1.2s later.
      if (!hangingUpRef.current) {
        setTimeout(() => router.back(), 1200)
      }
    }
    const onReconnecting = () => setState('reconnecting')
    const onReconnected = () => setState('connected')
    const onRinging = () => setState('ringing')
    const onConnectFailure = (error: unknown) => {
      console.warn('[call] ConnectFailure', error)
      setState('failed')
      setTimeout(() => router.back(), 2000)
    }

    call.on(Call.Event.Connected, onConnected)
    call.on(Call.Event.Disconnected, onDisconnected)
    call.on(Call.Event.Reconnecting, onReconnecting)
    call.on(Call.Event.Reconnected, onReconnected)
    call.on(Call.Event.Ringing, onRinging)
    call.on(Call.Event.ConnectFailure, onConnectFailure)

    // Pull custom params for the header — all three methods are synchronous.
    // getCustomParameters() returns Record<string, string> - plain object, no .get().
    try {
      const params = call.getCustomParameters()
      setDealName(params?.['dealName'] ?? null)
      const from = call.getFrom()
      const to = call.getTo()
      setCounterparty(from || to || null)
    } catch {}

    return () => {
      call.off(Call.Event.Connected, onConnected)
      call.off(Call.Event.Disconnected, onDisconnected)
      call.off(Call.Event.Reconnecting, onReconnecting)
      call.off(Call.Event.Reconnected, onReconnected)
      call.off(Call.Event.Ringing, onRinging)
      call.off(Call.Event.ConnectFailure, onConnectFailure)
    }
  }, [call, router])

  // Keep speaker state in sync with the SDK's audio device selection.
  // The SDK fires AudioDevicesUpdated whenever the selected device changes
  // (e.g. Bluetooth connected, user picks in CC UI, or toggleSpeaker above).
  useEffect(() => {
    const voice = getVoice()
    if (!voice) return
    const onAudioDevicesUpdated = (
      _audioDevices: unknown[],
      selectedDevice?: { type?: string },
    ) => {
      setOnSpeaker(selectedDevice?.type === 'Speaker')
    }
    voice.on(Voice.Event.AudioDevicesUpdated, onAudioDevicesUpdated)
    return () => {
      voice.off(Voice.Event.AudioDevicesUpdated, onAudioDevicesUpdated)
    }
  }, [])

  // Tick the duration counter once the call connects
  useEffect(() => {
    if (state !== 'connected') return
    const start = Date.now()
    const t = setInterval(
      () => setDurationSec(Math.floor((Date.now() - start) / 1000)),
      1000,
    )
    return () => clearInterval(t)
  }, [state])

  const toggleMute = async () => {
    if (!call) return
    const next = !muted
    try {
      await call.mute(next)
      setMuted(next)
    } catch {}
  }

  const toggleSpeaker = async () => {
    const voice = getVoice()
    if (!voice) return
    const targetType = onSpeaker ? 'Earpiece' : 'Speaker'
    try {
      const { audioDevices } = await voice.getAudioDevices()
      const target = audioDevices.find((d) => d.type === targetType)
      if (target) {
        await target.select()
      }
    } catch {}
  }

  const hangUp = async () => {
    if (!call) {
      router.back()
      return
    }
    // Set the flag BEFORE disconnect() — the Disconnected event can fire
    // synchronously inside that await, and we need the guard in place.
    hangingUpRef.current = true
    try {
      await call.disconnect()
    } catch {}
    router.back()
  }

  const stateLabel: Record<string, string> = {
    connecting: 'Connecting…',
    ringing: 'Ringing…',
    connected: formatDuration(durationSec),
    reconnecting: 'Reconnecting…',
    ended: 'Ended',
    failed: 'Call failed',
  }

  return (
    <View style={styles.container}>
      {/* Top: deal context header */}
      <View style={styles.header}>
        <Text style={styles.dealName} numberOfLines={1}>
          {dealName ?? routeName ?? counterparty ?? 'Unknown caller'}
        </Text>
        <Text style={styles.subline}>
          {(dealName ?? routeName) ? (counterparty ?? routeTo ?? '') : ''}
        </Text>
        <Text style={styles.state}>{stateLabel[state] ?? state}</Text>
      </View>

      {/* Middle: spinner while connecting, error text on failure */}
      <View style={styles.middle}>
        {state === 'connecting' || state === 'ringing' ? (
          <ActivityIndicator color="#c9a24a" size="large" />
        ) : state === 'failed' ? (
          <Text style={styles.failedText}>Call failed</Text>
        ) : null}
      </View>

      {/* Bottom: controls */}
      <View style={styles.controls}>
        <CtrlButton
          label="Mute"
          active={muted}
          onPress={toggleMute}
          disabled={!call}
        />
        <CtrlButton
          label="Speaker"
          active={onSpeaker}
          onPress={toggleSpeaker}
          disabled={!call}
        />
        <TouchableOpacity
          style={[styles.btn, styles.hangup]}
          onPress={hangUp}
        >
          <Text style={styles.hangupLabel}>End</Text>
        </TouchableOpacity>
      </View>
    </View>
  )
}

function CtrlButton({
  label,
  active,
  onPress,
  disabled,
}: {
  label: string
  active: boolean
  onPress: () => void
  disabled?: boolean
}) {
  return (
    <TouchableOpacity
      style={[styles.btn, active && styles.btnActive]}
      onPress={onPress}
      disabled={disabled}
    >
      <Text
        style={[styles.btnLabel, active && styles.btnLabelActive]}
      >
        {label}
      </Text>
    </TouchableOpacity>
  )
}

function formatDuration(secs: number) {
  const m = Math.floor(secs / 60).toString().padStart(2, '0')
  const s = (secs % 60).toString().padStart(2, '0')
  return `${m}:${s}`
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0b1f3a', // FundLocators navy
    paddingTop: 80,
    paddingHorizontal: 24,
    paddingBottom: 60,
  },
  header: { alignItems: 'center', marginBottom: 24 },
  dealName: {
    fontSize: 24,
    fontWeight: '700',
    color: '#fafaf9',
    letterSpacing: -0.4,
  },
  subline: { fontSize: 14, color: '#9aa3b2', marginTop: 4 },
  state: {
    marginTop: 24,
    fontSize: 22,
    fontFamily: 'Georgia',
    fontVariant: ['tabular-nums'],
    color: '#c9a24a',
  },
  middle: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  controls: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
  },
  btn: {
    width: 84,
    height: 84,
    borderRadius: 42,
    backgroundColor: '#1c2a4a',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#2a3a5a',
  },
  btnActive: { backgroundColor: '#c9a24a', borderColor: '#c9a24a' },
  btnLabel: { color: '#fafaf9', fontWeight: '600' },
  btnLabelActive: { color: '#0b1f3a' },
  hangup: { backgroundColor: '#dc2626', borderColor: '#dc2626' },
  hangupLabel: { color: '#fafaf9', fontWeight: '700', fontSize: 16 },
  failedText: { color: '#dc2626', fontSize: 18, fontWeight: '600' },
})
