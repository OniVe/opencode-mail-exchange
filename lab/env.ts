/** Lab helper: read a required value from the environment, never hardcode it. */
export function env(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}
