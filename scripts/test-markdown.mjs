import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const context = { window: {} };
vm.runInNewContext(fs.readFileSync("public/markdown.js", "utf8"), context);

const html = context.window.SuyoMarkdown.render(
  "<script>alert(1)</script> [bad](javascript:alert(1)) [ok](https://example.com)"
);

assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
assert.ok(!html.includes("<script>"));
assert.ok(!html.includes('href="javascript:'));
assert.ok(html.includes('href="https://example.com"'));
console.log("markdown safety check passed");
