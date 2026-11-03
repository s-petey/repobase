import { describe, expect, it } from "vitest"
import micromatch from "micromatch"
import { globToRegex } from "../src/glob.js"

const PATHS = [
  "README.md",
  "docs/editor.md",
  "src/index.ts",
  "src/a.ts",
  "src/b.ts",
  "src/c.ts",
  "src/editor/menu.ts",
  "src/editor/menu.test.ts",
  "src/editor-extra/menu.ts",
  "crates/editor/src/code_context_menus.rs",
  "crates/editor/Cargo.toml",
  "crates/gpui/src/app.rs",
  "a/x",
  "b/x",
  "c/x",
  ".github/workflows/ci.yml",
  "file (1).txt"
]

const GLOBS = [
  "*.md",
  "*.rs",
  "**/*.rs",
  "src/*.ts",
  "src/**/*.ts",
  "src/**",
  "crates/editor/**",
  "**/editor/**",
  "crates/*/src/**/*.rs",
  "**/*menu*",
  "**/*editor*/**",
  // What the TUI's path filter sends for "editor" and "src/editor"
  "**/*editor*{,/**}",
  "**/*src/editor*{,/**}",
  "{src,crates/*/src}/**/*.{ts,rs}",
  "{a,b}/x",
  "src/[ab].ts",
  "src/[^ab].ts",
  "src/?.ts",
  "./src/*.ts",
  "**/ci.yml",
  "src/**/**/menu.ts",
  "file (1).txt",
  "**"
]

// Filenames, for globs without a `/`, which match the filename as in grep
const filename = (path: string) => path.split("/").at(-1)!

const micromatchMatches = (glob: string, path: string) =>
  micromatch.isMatch(path, glob, { dot: true }) ||
  (!glob.includes("/") && micromatch.isMatch(filename(path), glob, { dot: true }))

describe("globToRegex", () => {
  it.each(GLOBS)("matches the same paths as micromatch for %s", (glob) => {
    const regex = new RegExp(globToRegex(glob))
    const expected = PATHS.filter((p) => micromatchMatches(glob, p))
    expect(PATHS.filter((p) => regex.test(p))).toEqual(expected)
  })

  // micromatch matches the opposite here (src/a.ts and src/b.ts)
  it("negates a class with [!...] as shells do", () => {
    const regex = new RegExp(globToRegex("src/[!ab].ts"))
    expect(PATHS.filter((p) => regex.test(p))).toEqual(["src/c.ts"])
  })

  it("uses no lookarounds, which LanceDB's regex engine rejects", () => {
    for (const glob of GLOBS) expect(globToRegex(glob)).not.toMatch(/\(\?[=!<]/)
  })
})
