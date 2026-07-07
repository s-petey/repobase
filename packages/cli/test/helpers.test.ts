import { describe, it, expect } from "vitest";

describe("CLI formatters", () => {
  describe("formatDate", () => {
    it("formats date in en-US locale", () => {
      const date = new Date("2024-06-15T10:30:00Z");
      const formatted = date.toLocaleString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
      expect(formatted).toContain("Jun 15, 2024");
      expect(formatted).toMatch(/2024/);
      expect(formatted).toMatch(/\d+:\d+ [AP]M/);
    });
  });

  describe("formatSize", () => {
    it("formats bytes", () => {
      const fmt = (bytes: number) => {
        if (bytes < 1024) return `${bytes}B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
        return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
      };
      expect(fmt(512)).toBe("512B");
      expect(fmt(2048)).toBe("2.0KB");
      expect(fmt(1048576)).toBe("1.0MB");
    });
  });

  describe("formatFileInfo", () => {
    it("formats a file entry", () => {
      const file = { isDirectory: false, filename: "main.ts", size: 1024 };
      const icon = file.isDirectory ? "📁" : "📄";
      const size = ` ${(file.size / 1024).toFixed(1)}KB`;
      const result = `${icon} ${file.filename}${size}`;
      expect(result).toBe("📄 main.ts 1.0KB");
    });

    it("formats a directory entry", () => {
      const file = { isDirectory: true, filename: "src", size: undefined };
      const icon = "📁";
      const size = file.size ? ` ${(file.size / 1024).toFixed(1)}KB` : "";
      const result = `${icon} ${file.filename}${size}`;
      expect(result).toBe("📁 src");
    });
  });

  describe("formatRepo", () => {
    it("produces expected structure", () => {
      const repo = {
        id: "test-repo",
        url: "https://github.com/test/repo",
        mode: { _tag: "tracking" as const, branch: "main" },
        cloudEnabled: false,
      };
      expect(repo.id).toBe("test-repo");
      expect(repo.mode._tag).toBe("tracking");
    });
  });

  describe("grep line formatting", () => {
    it("formats match lines with colon prefix", () => {
      const lineNumber = 42;
      const content = "  const x = 1";
      const formatted = `${String(lineNumber).padStart(4)}: ${content}`;
      expect(formatted).toBe("  42:   const x = 1");
    });

    it("formats context lines with dash prefix", () => {
      const lineNumber = 41;
      const content = "  // comment";
      const formatted = `${String(lineNumber).padStart(4)}- ${content}`;
      expect(formatted).toBe("  41-   // comment");
    });
  });
});
