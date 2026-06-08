/**
 * KeyboardDoneBar — InputAccessoryView with a "Done" button. Place this
 * once per screen, then add `inputAccessoryViewID={KEYBOARD_DONE_ID}` to
 * every TextInput that uses a phone-pad / number-pad / decimal-pad
 * keyboardType (the ones iOS doesn't put a Return/Done key on).
 *
 * iOS only — InputAccessoryView is a no-op on Android, and Android keyboards
 * carry their own dismiss path. Render unconditionally; React Native handles
 * platform gating at the native layer.
 *
 * Default ID is exported so callers can `inputAccessoryViewID={KEYBOARD_DONE_ID}`
 * without redeclaring the string. Pass a custom `id` prop only if you need
 * multiple distinct accessory bars on the same screen.
 *
 * Filed under #286.
 */

import { InputAccessoryView, Keyboard, Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native'

export const KEYBOARD_DONE_ID = 'globalKeyboardDone'

type Props = {
  id?: string
  /** Label override. Defaults to "Done". */
  label?: string
}

export function KeyboardDoneBar({ id = KEYBOARD_DONE_ID, label = 'Done' }: Props) {
  if (Platform.OS !== 'ios') return null
  return (
    <InputAccessoryView nativeID={id}>
      <View style={styles.bar}>
        <TouchableOpacity onPress={Keyboard.dismiss} hitSlop={12}>
          <Text style={styles.btn}>{label}</Text>
        </TouchableOpacity>
      </View>
    </InputAccessoryView>
  )
}

const styles = StyleSheet.create({
  bar: {
    backgroundColor: '#1c1917',
    borderTopColor: '#292524',
    borderTopWidth: 1,
    paddingVertical: 8,
    paddingHorizontal: 14,
    alignItems: 'flex-end',
  },
  btn: {
    color: '#d97706',
    fontSize: 16,
    fontWeight: '600',
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
})
