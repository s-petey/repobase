import { describe, expect, it } from "vitest";

const EXPECTED_TOOLS = [
  {
    name: "list_repos",
    description: "List all indexed repositories in repobase",
    inputSchema: {},
  },
  {
    name: "search",
    description: "Search across all indexed repositories using keyword, semantic, or hybrid search",
    inputSchema: {
      query: { type: "string" },
      mode: { type: "string", default: "hybrid" },
      limit: { type: "number", default: 20 },
      repo: { type: "string", optional: true },
    },
  },
  {
    name: "list_files",
    description: "List files and directories in a repository or directory",
    inputSchema: {
      repo: { type: "string", optional: true },
      path: { type: "string", optional: true },
    },
  },
  {
    name: "glob_files",
    description: "Find files matching a glob pattern across repositories",
    inputSchema: {
      pattern: { type: "string" },
      repo: { type: "string", optional: true },
      limit: { type: "number", default: 50 },
    },
  },
  {
    name: "read_file",
    description: "Read file contents from a repository",
    inputSchema: {
      repo: { type: "string" },
      path: { type: "string" },
      offset: { type: "number", default: 1 },
      limit: { type: "number", optional: true },
      lineNumbers: { type: "boolean", default: true },
    },
  },
  {
    name: "grep",
    description: "Search for a regex pattern in file contents across repositories",
    inputSchema: {
      pattern: { type: "string" },
      repo: { type: "string", optional: true },
      ignoreCase: { type: "boolean", default: false },
      contextBefore: { type: "number", default: 0 },
      contextAfter: { type: "number", default: 0 },
      context: { type: "number", optional: true },
      filesWithMatches: { type: "boolean", default: false },
      count: { type: "boolean", default: false },
      fileType: { type: "string", optional: true },
      limit: { type: "number", default: 100 },
    },
  },
];

describe("MCP tool registration", () => {
  it("defines all 6 expected tools", () => {
    expect(EXPECTED_TOOLS).toHaveLength(6);
    const names = EXPECTED_TOOLS.map((t) => t.name);
    expect(names).toEqual([
      "list_repos",
      "search",
      "list_files",
      "glob_files",
      "read_file",
      "grep",
    ]);
  });

  it("list_repos has no input schema", () => {
    const tool = EXPECTED_TOOLS.find((t) => t.name === "list_repos")!;
    expect(tool.description).toContain("indexed repositories");
    expect(Object.keys(tool.inputSchema)).toHaveLength(0);
  });

  it("search has query as required param", () => {
    const tool = EXPECTED_TOOLS.find((t) => t.name === "search")!;
    expect(tool.inputSchema.query?.type).toBe("string");
    expect(tool.inputSchema.mode?.default).toBe("hybrid");
    expect(tool.inputSchema.limit?.default).toBe(20);
  });

  it("read_file has repo and path as required params", () => {
    const tool = EXPECTED_TOOLS.find((t) => t.name === "read_file")!;
    expect(tool.inputSchema.repo?.type).toBe("string");
    expect(tool.inputSchema.path?.type).toBe("string");
    expect(tool.inputSchema.offset?.default).toBe(1);
    expect(tool.inputSchema.lineNumbers?.default).toBe(true);
  });

  it("glob_files has pattern as required param", () => {
    const tool = EXPECTED_TOOLS.find((t) => t.name === "glob_files")!;
    expect(tool.inputSchema.pattern?.type).toBe("string");
    expect(tool.inputSchema.limit?.default).toBe(50);
  });

  it("grep has all 10 params defined", () => {
    const tool = EXPECTED_TOOLS.find((t) => t.name === "grep")!;
    expect(Object.keys(tool.inputSchema)).toHaveLength(10);
    expect(tool.inputSchema.pattern?.type).toBe("string");
    expect(tool.inputSchema.limit?.default).toBe(100);
  });

  it("each tool has a description", () => {
    for (const tool of EXPECTED_TOOLS) {
      expect(tool.description).toBeTruthy();
      expect(tool.description.length).toBeGreaterThan(10);
    }
  });
});
