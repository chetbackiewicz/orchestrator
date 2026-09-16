const sourceExtensions = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".go",
  ".h",
  ".hpp",
  ".java",
  ".js",
  ".jsx",
  ".kt",
  ".mjs",
  ".php",
  ".py",
  ".rb",
  ".rs",
  ".ts",
  ".tsx",
]);

export function validatePublishablePaths(
  paths: readonly string[],
  testPath: string,
): string[] {
  const normalizedTestPath = normalizePath(testPath);
  const violations: string[] = [];
  let testCount = 0;
  let sourceCount = 0;

  if (
    !isTestPath(normalizedTestPath) ||
    isProtectedPath(normalizedTestPath)
  ) {
    violations.push(`invalid reproduction test path: ${testPath}`);
  }

  for (const rawPath of paths) {
    const path = normalizePath(rawPath);
    if (path === normalizedTestPath) {
      testCount += 1;
      continue;
    }
    if (!isSourcePath(path) || isTestPath(path) || isProtectedPath(path)) {
      violations.push(rawPath);
    } else {
      sourceCount += 1;
    }
  }

  if (testCount !== 1) {
    violations.push(
      testCount === 0
        ? `missing reproduction test: ${testPath}`
        : `multiple reproduction test entries: ${testPath}`,
    );
  }
  if (sourceCount === 0) violations.push("missing verified source change");
  return [...new Set(violations)];
}

export function isTestPath(path: string): boolean {
  const normalized = normalizePath(path);
  return (
    normalized.startsWith("test/") ||
    normalized.startsWith("tests/") ||
    normalized.includes("/__tests__/") ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(normalized)
  );
}

export function isProtectedPath(path: string): boolean {
  const normalized = normalizePath(path);
  return (
    normalized.startsWith(".github/") ||
    normalized.startsWith(".git/") ||
    normalized.startsWith(".incident-orchestrator/") ||
    normalized.startsWith(".env") ||
    normalized === "package.json" ||
    normalized.endsWith("lock.json") ||
    normalized.endsWith("lock.yaml") ||
    normalized.endsWith("lock.yml") ||
    normalized.endsWith(".lock") ||
    /(^|\/)(vitest|jest|eslint|prettier|tsconfig)\.[^/]+$/.test(normalized)
  );
}

function isSourcePath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  return dot >= 0 && sourceExtensions.has(path.slice(dot).toLowerCase());
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\/+/, "");
}
