const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 24 || (major === 24 && minor < 8)) {
  console.error("Browser E2E requires Node >=24.8.0. The CLI runtime requirement is unchanged.");
  process.exit(1);
}
