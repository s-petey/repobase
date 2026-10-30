import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/react"
import { isNarrow } from "../layout.js"
import { colors } from "../theme/index.js"

interface HeaderProps {
  version: string
}

export const Header = ({ version }: HeaderProps) => {
  const { width } = useTerminalDimensions()
  const boxed = isNarrow(width)
    ? { paddingLeft: 1, paddingRight: 1 }
    : { padding: 1, borderStyle: "single" as const, borderColor: colors.border.default, border: true }
  return (
    <box
      style={{
        flexDirection: "row",
        justifyContent: "space-between",
        ...boxed,
      }}
    >
      <text
        content="repobase"
        style={{
          fg: colors.accent.default,
          attributes: TextAttributes.BOLD,
        }}
      />
      <text
        content={`v${version}`}
        style={{
          fg: colors.text.secondary,
        }}
      />
    </box>
  )
}
