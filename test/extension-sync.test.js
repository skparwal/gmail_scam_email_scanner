import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("extension/lib copies match their sources (run npm run build:ext)", () => {
  for (const [src, copy] of [["public/rules.js", "extension/lib/rules.js"], ["personas.js", "extension/lib/personas.js"]]) {
    assert.equal(fs.readFileSync(copy, "utf8"), fs.readFileSync(src, "utf8"), copy);
  }
});
