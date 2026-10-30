import { describe, expect, it } from "vitest"
import { chunkLines } from "../src/chunk.js"

// One token per whitespace-separated word, like a crude word-piece count
const words = (line: string) => line.split(/\s+/).filter(Boolean).length

// n lines of `size` words each, numbered so chunks are easy to read
const lines = (n: number, size = 1) =>
  Array.from({ length: n }, (_, i) => Array.from({ length: size }, () => `l${i + 1}`).join(" ")).join("\n")

describe("chunkLines", () => {
  it("keeps a short file in one chunk", () => {
    expect(chunkLines("a b\nc", words)).toEqual([{ chunk: 0, startLine: 1, endLine: 2, text: "a b\nc" }])
  })

  it("doesn't count the newline at the end of the file as another line", () => {
    expect(chunkLines("a b\nc\n", words)).toEqual([{ chunk: 0, startLine: 1, endLine: 2, text: "a b\nc" }])
  })

  it("gives an empty file one empty chunk", () => {
    expect(chunkLines("", words)).toEqual([{ chunk: 0, startLine: 1, endLine: 1, text: "" }])
  })

  it("fills chunks up to the budget, minus the two special tokens", () => {
    // 10 tokens a chunk: 8 one-word lines fit, no overlap
    const chunks = chunkLines(lines(20), words, { maxTokens: 10, overlapTokens: 0 })

    expect(chunks.map((c) => [c.startLine, c.endLine])).toEqual([
      [1, 8],
      [9, 16],
      [17, 20]
    ])
    expect(chunks.map((c) => c.chunk)).toEqual([0, 1, 2])
  })

  it("repeats the last lines that fit in the overlap at the start of the next chunk", () => {
    const chunks = chunkLines(lines(20), words, { maxTokens: 10, overlapTokens: 2 })

    expect(chunks.map((c) => [c.startLine, c.endLine])).toEqual([
      [1, 8],
      [7, 14],
      [13, 20]
    ])
  })

  it("covers every line, in order", () => {
    const text = lines(200, 3)
    const chunks = chunkLines(text, words, { maxTokens: 40, overlapTokens: 6 })

    expect(chunks[0].startLine).toBe(1)
    expect(chunks.at(-1)!.endLine).toBe(200)
    for (const [a, b] of chunks.slice(1).map((c, i) => [chunks[i], c])) {
      expect(b.startLine).toBeGreaterThan(a.startLine)
      expect(b.startLine).toBeLessThanOrEqual(a.endLine + 1)
    }
    for (const c of chunks) {
      expect(c.text).toBe(text.split("\n").slice(c.startLine - 1, c.endLine).join("\n"))
      expect(words(c.text)).toBeLessThanOrEqual(38)
    }
  })

  it("puts a line longer than a whole chunk in a chunk of its own", () => {
    const long = Array.from({ length: 50 }, (_, i) => `w${i}`).join(" ")
    const chunks = chunkLines(`a\n${long}\nb`, words, { maxTokens: 10, overlapTokens: 0 })

    expect(chunks.map((c) => [c.startLine, c.endLine])).toEqual([
      [1, 1],
      [2, 2],
      [3, 3]
    ])
  })

  it("caps the overlap at half a chunk", () => {
    const chunks = chunkLines(lines(10), words, { maxTokens: 5, overlapTokens: 100 })

    // 3 lines a chunk, so at most 1 line of overlap
    expect(chunks.map((c) => [c.startLine, c.endLine])).toEqual([
      [1, 3],
      [3, 5],
      [5, 7],
      [7, 9],
      [9, 10]
    ])
  })
})
