import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const documents = [
  "README.md", "SECURITY.md", "CONTRIBUTING.md", "AGENTS.md", "CHANGELOG.md",
  "docs/constitution.md", "docs/life.md", "docs/provenance.md",
  "docs/plugins.md",
  "docs/security.md", "docs/upstream-analysis.md", "docs/vision.md", "docs/zh-CN.md",
  "docs/validation.md",
];

test("all local Markdown links resolve inside the release tree", async () => {
  for (const document of documents) {
    const source = await readFile(document, "utf8");
    const links = [...source.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map((match) => match[1]);
    for (const link of links) {
      if (/^(?:https?:|mailto:)/.test(link)) continue;
      const path = decodeURIComponent(link.split("#", 1)[0]);
      if (!path) continue;
      await assert.doesNotReject(access(resolve(dirname(document), path)), `${document}: missing ${link}`);
    }
  }
});
