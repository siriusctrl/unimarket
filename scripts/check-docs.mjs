import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const markdownFiles = ["README.md", "CONTRIBUTING.md", "AGENTS.md"];

const collectMarkdown = (relativeDir) => {
  const absoluteDir = join(repoRoot, relativeDir);
  for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
    const relativePath = join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      collectMarkdown(relativePath);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      markdownFiles.push(relativePath);
    }
  }
};

collectMarkdown("docs");
collectMarkdown("skills");

const failures = [];
const linkPattern = /\[[^\]]*\]\(([^)]+)\)/g;

for (const relativeFile of markdownFiles.sort()) {
  const absoluteFile = join(repoRoot, relativeFile);
  const source = readFileSync(absoluteFile, "utf8");

  for (const match of source.matchAll(linkPattern)) {
    const rawTarget = match[1].trim().replace(/^<|>$/g, "");
    const targetWithoutFragment = rawTarget.split("#", 1)[0].split("?", 1)[0];
    if (!targetWithoutFragment || /^[a-z][a-z0-9+.-]*:/i.test(targetWithoutFragment)) continue;

    let decodedTarget;
    try {
      decodedTarget = decodeURIComponent(targetWithoutFragment);
    } catch {
      decodedTarget = targetWithoutFragment;
    }

    const resolvedTarget = resolve(dirname(absoluteFile), decodedTarget);
    if (existsSync(resolvedTarget)) continue;

    const line = source.slice(0, match.index).split("\n").length;
    failures.push(`${relativeFile}:${line}: missing local link target ${rawTarget}`);
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`checked ${markdownFiles.length} Markdown files`);
}
