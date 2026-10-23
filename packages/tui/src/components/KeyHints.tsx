import { colors } from "../theme/index.js"

const HINT_SEPARATOR = "  "

export const KeyHints = ({ text, color = colors.text.secondary }: { text: string; color?: string }) => (
  <box style={{ flexDirection: "row", flexWrap: "wrap", columnGap: 2 }}>
    {text
      .split(HINT_SEPARATOR)
      .filter((hint) => hint !== "")
      .map((hint, index) => (
        <text key={index} content={hint} style={{ fg: color }} />
      ))}
  </box>
)
