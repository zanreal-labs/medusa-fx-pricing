// typescript-eslint loads the TypeScript JS API, which TypeScript 7 does not
// ship. Give it the TS 6 compatibility package instead of the root TypeScript 7;
// the project itself still builds and typechecks with TypeScript 7.
const needsTs6 = (name) => name.startsWith("@typescript-eslint/") || name === "ts-api-utils" || name === "@medusajs/eslint-plugin"

module.exports = {
  hooks: {
    readPackage(pkg) {
      if (needsTs6(pkg.name) && pkg.peerDependencies?.typescript) {
        delete pkg.peerDependencies.typescript
        pkg.dependencies = {
          ...pkg.dependencies,
          typescript: "npm:@typescript/typescript6@^6.0.2",
        }
      }
      return pkg
    },
  },
}
