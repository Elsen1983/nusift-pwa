import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const root = process.cwd();
const outputRoot = join(root, ".output", "server");
const workflowRoot = join(root, "node_modules", "@workflow");

if (!existsSync(outputRoot) || !existsSync(workflowRoot)) {
  console.error("workflow-bundle-import-fix: build output or @workflow modules are missing.");
  process.exit(1);
}

const files = [];
const visit = (directory) => {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    const stat = statSync(path);
    if (stat.isDirectory()) visit(path);
    else if (stat.isFile() && /\.(?:js|mjs|cjs)$/.test(name)) files.push(path);
  }
};
visit(outputRoot);

const isWithin = (parent, child) => {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
};

let rewrittenFiles = 0;
let rewrittenImports = 0;
const misplacedWorkflowImport = /(["'])((?:\.\.\/)+@workflow\/([^"']+))\1/g;

for (const path of files) {
  const source = readFileSync(path, "utf8");
  const updated = source.replace(
    misplacedWorkflowImport,
    (match, quote, _specifier, packagePath) => {
      const target = resolve(workflowRoot, packagePath);
      if (!isWithin(workflowRoot, target) || !existsSync(target)) {
        throw new Error(`Cannot safely resolve generated Workflow import: ${match}`);
      }

      let specifier = relative(dirname(path), target).replace(/\\/g, "/");
      if (!specifier.startsWith(".")) specifier = `./${specifier}`;
      rewrittenImports += 1;
      return `${quote}${specifier}${quote}`;
    },
  );

  if (updated !== source) {
    writeFileSync(path, updated);
    rewrittenFiles += 1;
  }
}

console.log(
  `workflow-bundle-import-fix: rewrote ${rewrittenImports} imports in ${rewrittenFiles} files`,
);
