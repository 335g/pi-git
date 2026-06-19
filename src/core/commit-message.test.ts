/**
 * Tests for commit-message utilities.
 *
 * Run: node --import tsx --test src/core/commit-message.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateFallbackMessage } from "./commit-message.js";

describe("generateFallbackMessage", () => {
  it("returns English message by default", () => {
    const message = generateFallbackMessage(["src/auth/login.ts"]);
    assert.equal(message, "chore: update login.ts");
  });

  it("returns Japanese message when lang is ja", () => {
    const message = generateFallbackMessage(["src/auth/login.ts"], "ja");
    assert.equal(message, "chore: login.tsを更新");
  });

  it("returns English plural message by default", () => {
    const message = generateFallbackMessage(["a.ts", "b.ts"]);
    assert.equal(message, "chore: update 2 files");
  });

  it("returns Japanese plural message when lang is ja", () => {
    const message = generateFallbackMessage(["a.ts", "b.ts"], "ja");
    assert.equal(message, "chore: 2ファイルを更新");
  });
});
