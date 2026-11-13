function collectPackageOccurrences(graph, packageNames) {
  const targets = new Set(packageNames);
  const occurrences = new Map(packageNames.map((name) => [name, []]));

  function visit(node, path) {
    if (!node || typeof node !== "object" || !node.dependencies || typeof node.dependencies !== "object") {return;}
    for (const [name, dependency] of Object.entries(node.dependencies)) {
      const dependencyPath = `${path} > ${name}`;
      if (targets.has(name)) {
        occurrences.get(name).push({
          path: dependencyPath,
          version: typeof dependency?.version === "string" ? dependency.version : undefined,
        });
      }
      visit(dependency, dependencyPath);
    }
  }

  visit(graph, graph?.name ?? "root");
  return occurrences;
}

function formatVersion(version) {
  return version ?? "missing version";
}

export function assertSynchronizedPackageVersions(graph, packageNames) {
  if (packageNames.length === 0) {throw new Error("Pass at least one package name to synchronize");}
  const occurrences = collectPackageOccurrences(graph, packageNames);
  const packages = [];

  for (const name of packageNames) {
    const namedPackages = occurrences.get(name);
    if (namedPackages.length === 0) {throw new Error(`Expected ${name} in the dependency graph, found no occurrences`);}
    packages.push(...namedPackages.map((occurrence) => ({ name, ...occurrence })));
  }

  const versions = [...new Set(packages.map(({ version }) => formatVersion(version)))].sort();
  if (versions.length !== 1) {
    const found = packages.map(({ name, path, version }) => `${name}@${formatVersion(version)} at ${path}`).join(", ");
    throw new Error(`Expected synchronized package versions; found ${versions.join(", ")}: ${found}`);
  }
  if (packages[0].version === undefined) {throw new Error(`Expected synchronized package versions; found missing version`);}
  return packages[0].version;
}
