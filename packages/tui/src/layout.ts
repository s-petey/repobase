const NARROW_WIDTH = 80

export const isNarrow = (width: number) => width < NARROW_WIDTH

export const fit = (text: string, width: number) =>
  text.length <= width ? text.padEnd(width) : `${text.slice(0, Math.max(0, width - 1))}…`
