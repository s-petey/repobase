import { TextAttributes } from "@opentui/core"
import { colors } from "../theme/index.js"

interface AddRepoModalProps {
  onSubmit: (url: string) => void
  onCancel: () => void
  onInput: (value: string) => void
  value: string
}

// Paste is handled natively by the focused <input> (opentui >= 0.5)
export const AddRepoModal = ({ onSubmit, onCancel, onInput, value }: AddRepoModalProps) => {
  return (
    <box
      style={{
        position: "absolute",
        top: "30%",
        left: "10%",
        width: "80%",
        height: 8,
        backgroundColor: colors.bg.elevated,
        borderStyle: "double",
        borderColor: colors.accent.default,
        border: true,
        flexDirection: "column",
        padding: 1,
      }}
    >
      <text
        content="Add Repository"
        style={{
          fg: colors.accent.default,
          attributes: TextAttributes.BOLD,
          marginBottom: 1,
        }}
      />
      <box
        title="GitHub URL"
        style={{
          border: true,
          borderColor: colors.border.default,
          height: 3,
        }}
      >
        <input
          placeholder="https://github.com/owner/repo"
          onInput={onInput}
          // opentui types <input onSubmit> as both (value: string) and Textarea's
          // (event: SubmitEvent); at runtime an <input> always receives the string value.
          // @ts-expect-error - onSubmit is called with a string value, not a SubmitEvent
          onSubmit={onSubmit}
          focused
          style={{
            focusedBackgroundColor: colors.bg.muted,
          }}
        />
      </box>
      <text
        content="[Enter] Confirm  [Esc] Cancel  (Paste supported)"
        style={{
          fg: colors.text.tertiary,
          marginTop: 1,
        }}
      />
    </box>
  )
}
