import { TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/react"
import { useCallback } from "react"
import { colors } from "../theme/index.js"

export interface StatusInfo {
  readonly stage: string
  readonly message: string
  readonly progress: number
  readonly timestamp: string
}

interface StatusModalProps {
  status: StatusInfo | null
  onClose: () => void
}

export const StatusModal = ({ status, onClose }: StatusModalProps) => {
  useKeyboard(
    useCallback(
      (key) => {
        if (key.name === "escape" || key.name === "?") {
          onClose()
        }
      },
      [onClose],
    ),
  )

  const stageColor = status
    ? status.stage === "error"
      ? colors.status.error.default
      : colors.accent.default
    : colors.text.secondary

  return (
    <box
      style={{
        position: "absolute",
        top: "25%",
        left: "15%",
        width: "70%",
        height: 12,
        backgroundColor: colors.bg.elevated,
        borderStyle: "double",
        borderColor: colors.accent.default,
        border: true,
        flexDirection: "column",
        padding: 1,
      }}
    >
      <text
        content="Worker Status"
        style={{
          fg: colors.text.primary,
          attributes: TextAttributes.BOLD,
          marginBottom: 1,
        }}
      />

      {status ? (
        <>
          <box style={{ flexDirection: "row", marginLeft: 2 }}>
            <text
              content="Stage:  "
              style={{ fg: colors.text.secondary, width: 10 }}
            />
            <text
              content={status.stage}
              style={{ fg: stageColor, attributes: TextAttributes.BOLD }}
            />
          </box>
          <box style={{ flexDirection: "row", marginLeft: 2 }}>
            <text
              content="Message:"
              style={{ fg: colors.text.secondary, width: 10 }}
            />
            <text content={status.message} style={{ fg: colors.text.primary }} />
          </box>
          <box style={{ flexDirection: "row", marginLeft: 2 }}>
            <text
              content="Progress:"
              style={{ fg: colors.text.secondary, width: 10 }}
            />
            <text
              content={`${status.progress}%`}
              style={{ fg: stageColor }}
            />
          </box>
          <box style={{ flexDirection: "row", marginLeft: 2 }}>
            <text
              content="Time:    "
              style={{ fg: colors.text.secondary, width: 10 }}
            />
            <text content={status.timestamp} style={{ fg: colors.text.tertiary }} />
          </box>
          <text
            content={`Logs: ~/.repobase/worker-main.log`}
            style={{
              fg: colors.text.tertiary,
              marginTop: 1,
              marginLeft: 2,
            }}
          />
        </>
      ) : (
        <text
          content="No active operation. Press 's' to sync or 'a' to add a repo."
          style={{
            fg: colors.text.tertiary,
            marginLeft: 2,
          }}
        />
      )}

      <text
        content="[?/Esc] Close"
        style={{
          fg: colors.text.tertiary,
          marginTop: 1,
          marginLeft: 2,
        }}
      />
    </box>
  )
}
