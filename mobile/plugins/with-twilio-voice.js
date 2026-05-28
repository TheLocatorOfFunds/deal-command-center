/**
 * Expo config plugin for Twilio Voice React Native SDK on iOS.
 *
 * Injects:
 *   - VoIP background mode (so PushKit can wake the app on incoming
 *     calls even when the app is suspended or killed)
 *   - Microphone usage description (audio for the call)
 *   - CallKit + PushKit framework links (handled implicitly by the
 *     SDK's pod when the Podfile picks it up — no manual link needed)
 *   - "voip" background mode in the UIBackgroundModes Info.plist key
 *
 * Does NOT touch entitlements — aps-environment in app.json covers
 * standard APNs. PushKit VoIP token delivery requires a VoIP Services
 * certificate registered on the App ID in the Apple Developer portal
 * and uploaded to Twilio's console (not an app.json entitlement).
 *
 * Reference:
 *   https://docs.expo.dev/config-plugins/development-and-debugging/
 *   https://www.twilio.com/docs/voice/sdks/react-native/v2-getting-started
 */

const { withInfoPlist } = require('@expo/config-plugins')

function withTwilioVoice(config) {
  return withInfoPlist(config, (cfg) => {
    const modes = new Set(cfg.modResults.UIBackgroundModes || [])
    // PushKit incoming calls wake the app via VoIP background mode
    modes.add('voip')
    // Audio background mode lets the call audio survive lock screen
    modes.add('audio')
    cfg.modResults.UIBackgroundModes = Array.from(modes)

    // Twilio Voice SDK reads this on first incoming call
    if (!cfg.modResults.NSMicrophoneUsageDescription) {
      cfg.modResults.NSMicrophoneUsageDescription =
        'DCC needs microphone access to make and receive Twilio calls.'
    }

    return cfg
  })
}

module.exports = withTwilioVoice
