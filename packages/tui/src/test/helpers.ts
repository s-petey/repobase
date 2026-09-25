import type { TestRendererSetup } from "@opentui/core/testing"
import { act } from "react"

/**
 * Run a user interaction inside React's act() and render the resulting frame,
 * so state updates are flushed before assertions (and React doesn't warn).
 */
export const interact = async (setup: TestRendererSetup, fn: () => void | Promise<void>) => {
  await act(async () => {
    await fn()
  })
  // Paint after act() has committed React's updates, so the frame isn't one behind
  await act(async () => {
    await setup.renderOnce()
  })
}

/** Destroy the test renderer inside act(), since it unmounts the React tree. */
export const teardown = async (setup: TestRendererSetup | undefined) => {
  if (!setup) return
  await act(async () => {
    setup.renderer.destroy()
  })
}
