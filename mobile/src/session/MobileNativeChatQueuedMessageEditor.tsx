import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { Check, X } from 'lucide-react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { mobileNativeChatInputStyles } from './mobile-native-chat-input-styles'
import type { MobileQueuedMessageInlineEditor } from './use-mobile-structured-queued-edit'

const BUTTON_SIZE = 28
const ICON_SIZE = 16
// 28pt square + 8 each side = the 44pt platform touch floor, kept inside the row's padding.
const BUTTON_HIT_SLOP = (44 - BUTTON_SIZE) / 2
const LINE_HEIGHT = 20
const FIELD_PADDING_VERTICAL = 7
const FIELD_BORDER = 1

/** The editor that replaces a queued card's row: the composer's text field, with an X and a
 *  checkmark beside it, so it needs no line of its own for Cancel and Save. */
export function MobileNativeChatQueuedMessageEditor({
  editor,
  attribution
}: {
  editor: MobileQueuedMessageInlineEditor
  /** The card's "From <name>" line, kept above the text. */
  attribution: string | null
}): React.JSX.Element {
  const input = useRef<TextInput>(null)
  const [focused, setFocused] = useState(false)
  useEffect(() => {
    input.current?.focus()
  }, [])
  const saveDisabled = editor.saving || !editor.canSave
  // Saving keeps the light fill behind the spinner; only an unsavable edit dims the checkmark.
  const saveOff = !editor.canSave && !editor.saving
  return (
    <View style={styles.editor} testID="queued-card-editor">
      {attribution ? (
        <Text style={styles.attribution} numberOfLines={1}>
          {attribution}
        </Text>
      ) : null}
      <View style={styles.line}>
        <TextInput
          ref={input}
          accessibilityLabel="Edit queued message"
          value={editor.text}
          editable={!editor.saving}
          multiline
          selectionColor={colors.accentBlue}
          textAlignVertical="top"
          style={[
            mobileNativeChatInputStyles.freeInput,
            styles.field,
            focused && !editor.saving && styles.fieldFocused,
            editor.saving && styles.disabled
          ]}
          onChangeText={editor.change}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
        />
        <View style={styles.buttons}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Cancel editing"
            accessibilityState={{ disabled: editor.saving }}
            disabled={editor.saving}
            hitSlop={BUTTON_HIT_SLOP}
            style={({ pressed }) => [
              styles.button,
              styles.buttonRaised,
              pressed && styles.cancelPressed,
              editor.saving && styles.disabled
            ]}
            onPress={editor.cancel}
          >
            <X size={ICON_SIZE} color={colors.textSecondary} strokeWidth={2} />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Save edited message"
            accessibilityState={{ disabled: saveDisabled, busy: editor.saving }}
            disabled={saveDisabled}
            hitSlop={BUTTON_HIT_SLOP}
            style={({ pressed }) => [
              styles.button,
              saveOff ? styles.buttonRaised : styles.save,
              pressed && styles.savePressed
            ]}
            onPress={() => void editor.save()}
          >
            {editor.saving ? (
              <ActivityIndicator size="small" color={colors.bgBase} />
            ) : (
              <Check
                size={ICON_SIZE}
                color={saveOff ? colors.textMuted : colors.bgBase}
                strokeWidth={2.6}
              />
            )}
          </Pressable>
        </View>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  // No row fill: the field's own fill marks the edit, as the composer's field does in its bar.
  editor: {
    paddingVertical: spacing.sm,
    paddingLeft: spacing.md,
    paddingRight: spacing.sm,
    gap: spacing.xs
  },
  attribution: {
    color: colors.textMuted,
    fontSize: typography.metaSize,
    lineHeight: typography.metaSize + spacing.xs
  },
  // Bottom-aligned: the buttons stay beside the cursor's last line as the field grows.
  line: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 6
  },
  // One line, then four before it scrolls; a constant border width so focus never shifts the text.
  field: {
    minHeight: LINE_HEIGHT + 2 * (FIELD_PADDING_VERTICAL + FIELD_BORDER),
    maxHeight: 4 * LINE_HEIGHT + 2 * (FIELD_PADDING_VERTICAL + FIELD_BORDER),
    lineHeight: LINE_HEIGHT,
    paddingTop: FIELD_PADDING_VERTICAL,
    paddingBottom: FIELD_PADDING_VERTICAL,
    paddingHorizontal: 10,
    borderWidth: FIELD_BORDER,
    borderColor: colors.borderSubtle
  },
  fieldFocused: {
    borderColor: colors.accentBlue
  },
  // Centred on a one-line field: (36 - 28) / 2 above its bottom edge.
  buttons: {
    flexDirection: 'row',
    gap: spacing.xs,
    marginBottom: spacing.xs
  },
  button: {
    width: BUTTON_SIZE,
    height: BUTTON_SIZE,
    borderRadius: radii.input,
    alignItems: 'center',
    justifyContent: 'center'
  },
  buttonRaised: {
    backgroundColor: colors.bgRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle
  },
  cancelPressed: {
    backgroundColor: colors.bgPanel
  },
  // The composer's Send and the old Save pill's light fill.
  save: {
    backgroundColor: colors.textPrimary
  },
  savePressed: {
    backgroundColor: colors.textSecondary
  },
  disabled: { opacity: 0.5 }
})
