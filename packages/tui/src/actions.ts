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
  readonly run: () => void
}

export const matchesKey = (actionKey: ActionKey, key: KeyEvent) =>
  actionKey.names.includes(key.name) && (actionKey.shift === undefined || actionKey.shift === key.shift)
