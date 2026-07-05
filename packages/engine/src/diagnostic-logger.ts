import { appendFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

const LOG_DIR = join(homedir(), ".repobase")

function ensureDir() {
  try { mkdirSync(LOG_DIR, { recursive: true }) } catch { /* ignore */ }
}

export function logMain(message: string) {
  ensureDir()
  try {
    appendFileSync(
      join(LOG_DIR, "worker-main.log"),
      `${new Date().toISOString()} [MAIN] ${message}\n`,
    )
  } catch { /* ignore */ }
}

export function logWorker(message: string) {
  ensureDir()
  try {
    appendFileSync(
      join(LOG_DIR, "worker-thread.log"),
      `${new Date().toISOString()} [WORKER] ${message}\n`,
    )
  } catch { /* ignore */ }
}
