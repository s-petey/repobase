import type { KeyEvent } from "@opentui/core"

export interface ActionKey {
  readonly names: ReadonlyArray<string>
  readonly shift?: boolean
}

export interface ListAction {
  readonly key: ActionKey
  readonly label: string
  readonly description: string
  readonly scope: "row" | "general"
  readonly available: boolean
  readonly run: () => void
}

export const matchesKey = (actionKey: ActionKey, key: KeyEvent) =>
  actionKey.names.includes(key.name) && (actionKey.shift === undefined || actionKey.shift === key.shift)

const ENTER = "enter"

export const keyLabel = (actionKey: ActionKey) => {
  const name = actionKey.names[0] ?? ""
  if (name === ENTER) return "Enter"
  return actionKey.shift ? name.toUpperCase() : name
}
