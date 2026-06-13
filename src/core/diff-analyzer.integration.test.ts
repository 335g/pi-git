/**
 * Integration tests for diff-hunk pipeline — uses real git repos.
 *
 * Test git apply --cached with partial hunks using a minimal ExtensionAPI mock.
 *
 * Run: node --import tsx --test src/core/diff-analyzer.integration.test.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { execSync } from "node:child_process";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DiffHunkRef } from "../types.js";
import { parseDiffHunks, formatNumberedHunks, validateHunkCoverage } from "./diff-analyzer.js";
import { stageDiffHunks } from "./git.js";

// ── Helpers ──

interface TestRepo {
  root: string;
  cleanup: () => void;
}

function makeTempGitRepo(): TestRepo {
  const repoId = randomBytes(8).toString("hex");
  const root = join(tmpdir(), `pi-git-test-${repoId}`);
  mkdirSync(root, { recursive: true });
  execSync("git init -q", { cwd: root });
  execSync('git config user.email "t@t"', { cwd: root });
  execSync('git config user.name "T"', { cwd: root });

  writeFileSync(join(root, "README.md"), "# Test\n", "utf-8");
  execSync("git add README.md", { cwd: root });
  execSync('git commit -q -m "init"', { cwd: root });

  return {
    root,
    cleanup: () => {
      try { rmSync(root, { recursive: true, force: true }); } catch { /* */ }
    },
  };
}

function writeFile(root: string, path: string, content: string): void {
  const fullPath = join(root, path);
  mkdirSync(join(fullPath, ".."), { recursive: true });
  writeFileSync(fullPath, content, "utf-8");
}

function commitAll(root: string, msg: string): void {
  execSync("git add -A", { cwd: root });
  execSync(`git commit -q -m "${msg}"`, { cwd: root });
}

function getDiff(root: string): string {
  return execSync("git diff", { cwd: root, encoding: "utf-8" });
}

function getStagedFiles(root: string): string[] {
  const out = execSync("git diff --cached --name-only", {
    cwd: root, encoding: "utf-8",
  });
  return out.trim().split("\n").filter(Boolean);
}

/** Create a minimal ExtensionAPI mock that runs real git commands */
function mockPi(root: string): ExtensionAPI {
  return {
    exec: (command: string, args: string[], opts?: { cwd?: string }) => {
      const cwd = opts?.cwd ?? root;
      try {
        const stdout = execSync(
          `${command} ${args.join(" ")}`,
          { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
        );
        return { stdout, stderr: "", code: 0 };
      } catch (e: any) {
        return {
          stdout: e.stdout?.toString() ?? "",
          stderr: e.stderr?.toString() ?? "",
          code: e.status ?? 1,
        };
      }
    },
  } as unknown as ExtensionAPI;
}

// ── Tests ──

describe("real git: parseDiffHunks", () => {
  let repo: TestRepo;

  beforeEach(() => { repo = makeTempGitRepo(); });
  afterEach(() => { repo.cleanup(); });

  it("parses multi-file, multi-hunk diff correctly", () => {
    writeFile(repo.root, "src/a.ts", "export const a = 1;\n");
    writeFile(repo.root, "src/b.ts", "export const b = 2;\n");
    commitAll(repo.root, "baseline");

    writeFile(repo.root, "src/a.ts",
`// Header
export const a = 1;
export const a2 = 2;
`);
    writeFile(repo.root, "src/b.ts", "export const b = 2;\nexport const b2 = 3;\n");

    const diff = getDiff(repo.root);
    const hunks = parseDiffHunks(diff);

    assert.ok(hunks.length >= 2, `Expected ≥2 hunks, got ${hunks.length}`);
    for (const h of hunks) {
      assert.ok(h.globalIndex > 0);
      assert.ok(h.file.length > 0);
      assert.ok(h.content.includes("@@"));
      assert.equal(typeof h.summary, "string");
      assert.equal(h.isAtomic, false);
    }
  });

  it("formatNumberedHunks includes all hunks", () => {
    writeFile(repo.root, "src/x.ts", "export const x = 1;\n");
    commitAll(repo.root, "baseline");
    writeFile(repo.root, "src/x.ts", "export const x = 1;\nexport const y = 2;\n");

    const diff = getDiff(repo.root);
    const hunks = parseDiffHunks(diff);
    const formatted = formatNumberedHunks(hunks);

    for (const h of hunks) {
      assert.ok(formatted.includes(`[H${h.globalIndex}]`));
    }
  });

  it("validateHunkCoverage catches unassigned hunks", () => {
    writeFile(repo.root, "src/a.ts", "export const a = 1;\n");
    writeFile(repo.root, "src/b.ts", "export const b = 2;\n");
    commitAll(repo.root, "baseline");
    writeFile(repo.root, "src/a.ts", "export const a = 1;\nexport const a2 = 2;\n");
    writeFile(repo.root, "src/b.ts", "export const b = 2;\nexport const b2 = 3;\n");

    const hunks = parseDiffHunks(getDiff(repo.root));

    const groups = [
      { hunks: [{ globalIndex: 1, file: hunks[0].file }], message: "feat: a2", confidence: "high" as const },
    ];

    const validated = validateHunkCoverage(groups, hunks.length);
    const catchAll = validated.find((g) => g.confidence === "low");
    assert.ok(catchAll, "Should auto-create catch-all for unassigned hunks");
  });
});

describe("real git: stageDiffHunks", () => {
  let repo: TestRepo;

  beforeEach(() => { repo = makeTempGitRepo(); });
  afterEach(() => { repo.cleanup(); });

  it("stages only selected hunks within a single file", async () => {
    // Create 30-line file with changes at lines 5 and 25 (far enough apart
    // for git to produce 2 separate @@ hunks — default context is 3 lines).
    const lines: string[] = [];
    for (let i = 1; i <= 30; i++) lines.push(`// line${i}`);
    writeFile(repo.root, "src/main.ts", lines.join("\n") + "\n");
    commitAll(repo.root, "baseline");

    lines[4] = "// MODIFIED LINE 5";    // 0-indexed
    lines[24] = "// MODIFIED LINE 25";
    writeFile(repo.root, "src/main.ts", lines.join("\n") + "\n");

    const pi = mockPi(repo.root);
    const diff = getDiff(repo.root);
    const hunks = parseDiffHunks(diff);

    console.log(`Parsed ${hunks.length} hunks:`);
    for (const h of hunks) {
      console.log(`  [H${h.globalIndex}] ${h.file} idx=${h.hunkIndexInFile} header=${h.header}`);
    }

    assert.ok(hunks.length === 2, `Expected 2 hunks, got ${hunks.length}`);

    // Stage only hunk 2 (the later one — tests descending-order safety)
    await stageDiffHunks(pi, hunks, [{ globalIndex: 2, file: hunks[1].file }], repo.root);

    // Verify: main.ts is staged
    const staged = getStagedFiles(repo.root);
    assert.ok(staged.includes("src/main.ts"), "main.ts should be staged");

    // Verify: unstaged diff still contains the OTHER hunk's change
    const unstagedDiff = execSync("git diff", {
      cwd: repo.root, encoding: "utf-8",
    });
    assert.ok(
      unstagedDiff.includes("MODIFIED LINE 5"),
      "Unstaged diff should contain the OTHER hunk (line 5)",
    );
    assert.ok(
      !unstagedDiff.includes("MODIFIED LINE 25"),
      "Unstaged diff should NOT contain the staged hunk (line 25)",
    );
  });

  it("stages full file when all hunks are selected (fast path)", async () => {
    writeFile(repo.root, "src/single.ts", "export const x = 1;\n");
    commitAll(repo.root, "baseline");
    writeFile(repo.root, "src/single.ts", "export const x = 1;\nexport const y = 2;\n");

    const pi = mockPi(repo.root);
    const diff = getDiff(repo.root);
    const hunks = parseDiffHunks(diff);

    assert.equal(hunks.length, 1);

    await stageDiffHunks(pi, hunks, [{ globalIndex: 1, file: hunks[0].file }], repo.root);

    const staged = getStagedFiles(repo.root);
    assert.ok(staged.includes("src/single.ts"));
  });

  it("handles multiple files with mixed full/partial staging", async () => {
    writeFile(repo.root, "src/a.ts", "// a\n");

    const bLines: string[] = [];
    for (let i = 1; i <= 30; i++) bLines.push(`// b line${i}`);
    writeFile(repo.root, "src/b.ts", bLines.join("\n") + "\n");
    commitAll(repo.root, "baseline");

    // a.ts: 1 hunk; b.ts: 2 hunks (far apart)
    writeFile(repo.root, "src/a.ts", "// a\nexport const a2 = 2;\n");
    bLines[2] = "// b MODIFIED LINE 3";
    bLines[19] = "// b MODIFIED LINE 20";
    writeFile(repo.root, "src/b.ts", bLines.join("\n") + "\n");

    const pi = mockPi(repo.root);
    const diff = getDiff(repo.root);
    const hunks = parseDiffHunks(diff);

    console.log(`Multi-file: ${hunks.length} hunks`);
    for (const h of hunks) {
      console.log(`  [H${h.globalIndex}] ${h.file} idx=${h.hunkIndexInFile}`);
    }

    const aHunks = hunks.filter((h) => h.file === "src/a.ts");
    const bHunks = hunks.filter((h) => h.file === "src/b.ts");

    assert.ok(bHunks.length === 2, `Expected 2 hunks for b.ts, got ${bHunks.length}`);

    // Stage: full a.ts + only first hunk of b.ts
    const refs: DiffHunkRef[] = [
      { globalIndex: aHunks[0].globalIndex, file: "src/a.ts" },
      { globalIndex: bHunks[0].globalIndex, file: "src/b.ts" },
    ];

    await stageDiffHunks(pi, hunks, refs, repo.root);

    const staged = getStagedFiles(repo.root);
    assert.ok(staged.includes("src/a.ts"));
    assert.ok(staged.includes("src/b.ts"));

    // b.ts second hunk should remain unstaged
    const unstagedDiff = execSync("git diff", {
      cwd: repo.root, encoding: "utf-8",
    });
    assert.ok(
      unstagedDiff.includes("b.ts"),
      "b.ts should have unstaged changes (second hunk)",
    );
  });
});
