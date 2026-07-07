import { KeyEvent, parseKeypress } from "@opentui/core";
import { TestRenderer } from "@opentui/core/testing";

export function pressEscape(renderer: TestRenderer) {
  const parsed = parseKeypress("\x1B", { useKittyKeyboard: false });
  if (parsed) {
    renderer.keyInput.emit("keypress", new KeyEvent(parsed));
  }
}
