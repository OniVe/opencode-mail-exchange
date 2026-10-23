module.exports = {
  extends: ["@commitlint/config-conventional"],
  // The repository was bootstrapped with a plain "Initial commit".
  ignores: [(message) => message.startsWith("Initial commit")],
}
