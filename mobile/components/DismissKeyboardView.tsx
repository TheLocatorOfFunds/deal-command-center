/**
 * DismissKeyboardView — wrap any screen with this to make a tap on the
 * background dismiss the keyboard.
 *
 * Why this exists: Justin got stuck on the deal-search screen (Build 29,
 * 2026-06-08). iOS phone-pad / number-pad keyboards have no built-in Done
 * key, and on screens where the only background is the ScrollView itself,
 * a default-keyboard input also offers no dismiss path because the bottom
 * nav is hidden behind the keyboard. This component, applied at the screen
 * root, fixes both cases by intercepting taps on the visible background.
 *
 * Use with `accessible={false}` so the Pressable doesn't announce itself
 * to VoiceOver as a button — the dismiss is purely a side effect of any
 * background tap. Children remain interactive.
 *
 * For ScrollViews, pair this with `keyboardShouldPersistTaps="handled"`
 * on the ScrollView so taps INSIDE form children still register (button
 * presses, input focus changes) while background taps still dismiss.
 *
 * For phone-pad / number-pad TextInputs that need an explicit Done key,
 * use `KeyboardDoneBar` (this dir) and set `inputAccessoryViewID` on
 * those inputs. Tap-outside + Done bar = full coverage.
 *
 * Filed under #286.
 */

import { ReactNode } from 'react'
import { Keyboard, Pressable, StyleSheet, View } from 'react-native'

type Props = {
  children: ReactNode
  /** Apply to a styled View instead — useful when the parent already has flex / padding. */
  style?: any
}

export function DismissKeyboardView({ children, style }: Props) {
  return (
    <Pressable
      onPress={Keyboard.dismiss}
      style={[styles.root, style]}
      accessible={false}
    >
      {/*
        We wrap children in a View with pointerEvents='box-none' so taps
        on actual interactive descendants (buttons, inputs, text inside
        them) work normally — the Pressable only catches taps that pass
        through to the background.
      */}
      <View style={styles.inner} pointerEvents="box-none">
        {children}
      </View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  inner: { flex: 1 },
})
