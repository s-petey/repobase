import { TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/react"
import { colors } from "../theme/index.js"

interface ConfirmDialogProps {
  message: string
  onConfirm: () => void
  onCancel: () => void
  title?: string
  color?: string
  hints?: string
}

export const ConfirmDialog = ({
  message,
  onConfirm,
  onCancel,
  title = "! Confirm Delete",
  color = colors.status.error.default,
  hints = "[Enter] Confirm  [Esc] Cancel",
}: ConfirmDialogProps) => {
  useKeyboard((key) => {
    if (key.name === "escape") {
      onCancel()
      return
    }
    
    if (key.name === "return" || key.name === "enter") {
      onConfirm()
      return
    }
  })

  return (
    <box
      style={{
        position: "absolute",
        top: "30%",
        left: "10%",
        width: "80%",
        backgroundColor: colors.bg.elevated,
        borderStyle: "double",
        borderColor: color,
        border: true,
        flexDirection: "column",
        padding: 1,
      }}
    >
      <text
        content={title}
        style={{
          fg: color,
          attributes: TextAttributes.BOLD,
          marginBottom: 1,
        }}
      />
      <text
        content={message}
        style={{
          fg: colors.text.primary,
          marginBottom: 2,
        }}
      />
      <text
        content={hints}
        style={{
          fg: colors.text.tertiary,
          marginTop: 1,
        }}
      />
    </box>
  )
}
