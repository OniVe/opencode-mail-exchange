import { describe, expect, test } from "bun:test"
import { mergeSearchResults } from "../src/backend"
import type { MessageSummary } from "../src/types"

const message = (id: string, received: string, overrides: Partial<MessageSummary> = {}): MessageSummary => ({
  id,
  subject: `subject-${id}`,
  from: "from@example.com",
  to: [],
  received,
  isRead: false,
  hasAttachments: false,
  preview: "",
  ...overrides,
})

describe("mergeSearchResults", () => {
  test("dedupes by id and keeps the richest fields", () => {
    const local = [message("a", "2026-10-23T10:00:00Z", { to: [], cc: [], recipientsKnown: false, preview: "local" })]
    const remote = [
      message("a", "2026-10-23T10:00:00Z", {
        to: ["to@example.com"],
        cc: ["cc@example.com"],
        recipientsKnown: true,
        hasAttachments: true,
      }),
      message("b", "2026-10-22T10:00:00Z"),
    ]
    const merged = mergeSearchResults(local, remote, 10)
    expect(merged.map((item) => item.id)).toEqual(["a", "b"])
    expect(merged[0]?.to).toEqual(["to@example.com"])
    expect(merged[0]?.cc).toEqual(["cc@example.com"])
    expect(merged[0]?.recipientsKnown).toBe(true)
    expect(merged[0]?.hasAttachments).toBe(true)
    expect(merged[0]?.preview).toBe("local")
  })

  test("sorts newest first and respects the limit", () => {
    const merged = mergeSearchResults(
      [message("old", "2026-10-01T00:00:00Z")],
      [message("new", "2026-10-23T00:00:00Z"), message("middle", "2026-10-15T00:00:00Z")],
      2,
    )
    expect(merged.map((item) => item.id)).toEqual(["new", "middle"])
  })

  test("keeps local-only results when EWS has none", () => {
    expect(mergeSearchResults([message("local", "2026-10-23T00:00:00Z")], [], 10).map((item) => item.id)).toEqual([
      "local",
    ])
  })
})
