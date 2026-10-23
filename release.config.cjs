/**
 * semantic-release configuration.
 *
 * Versioning follows Conventional Commits:
 *   fix:              -> patch
 *   feat:             -> minor
 *   breaking (*!:)    -> minor while < 1.0.0
 *   chore/ci/docs/... -> no release
 *
 * Publishing uses npm trusted publishing (OIDC), so no npm token is stored;
 * provenance is generated automatically. The package must be configured as a
 * trusted publisher on npmjs.com (repository OniVe/opencode-mail-exchange,
 * workflow release.yml) before the first CI release.
 */
module.exports = {
  branches: ["main"],
  plugins: [
    [
      "@semantic-release/commit-analyzer",
      {
        releaseRules: [
          // Pre-1.0 policy: a breaking change bumps the minor version.
          { breaking: true, release: "minor" },
        ],
      },
    ],
    "@semantic-release/release-notes-generator",
    "@semantic-release/npm",
    "@semantic-release/github",
  ],
}
