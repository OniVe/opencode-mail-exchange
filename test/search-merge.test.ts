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
  test("dedupes by id: live EWS metadata wins, local extras are kept", () => {
    const local = [
      message("a", "2026-10-20T10:00:00Z", {
        subject: "local subject",
        from: "local@example.com",
        isRead: false,
        conversationId: "conv-local",
        to: [],
        cc: [],
        recipientsKnown: false,
        preview: "local preview",
        size: 100,
        attachmentCount: 2,
        attachmentMatch: { id: "att-1", name: "invoice.pdf", snippet: "needle" },
      }),
      message("c", "2026-10-21T10:00:00Z", {
        attachmentMatch: { id: "att-2", name: "notes.docx", snippet: "needle notes" },
      }),
    ]
    const remote = [
      message("a", "2026-10-25T10:00:00Z", {
        subject: "remote subject",
        from: "remote@example.com",
        isRead: true,
        conversationId: "conv-remote",
        to: ["to@example.com"],
        cc: ["cc@example.com"],
        recipientsKnown: true,
        hasAttachments: true,
        preview: "remote preview",
        size: 200,
        attachmentCount: 3,
      }),
      message("b", "2026-10-22T10:00:00Z"),
    ]
    const merged = mergeSearchResults(local, remote, 10)
    expect(merged.map((item) => item.id)).toEqual(["a", "b", "c"])
    expect(merged[0]?.subject).toBe("remote subject")
    expect(merged[0]?.from).toBe("remote@example.com")
    expect(merged[0]?.received).toBe("2026-10-25T10:00:00Z")
    expect(merged[0]?.isRead).toBe(true)
    expect(merged[0]?.conversationId).toBe("conv-remote")
    expect(merged[0]?.to).toEqual(["to@example.com"])
    expect(merged[0]?.cc).toEqual(["cc@example.com"])
    expect(merged[0]?.recipientsKnown).toBe(true)
    expect(merged[0]?.hasAttachments).toBe(true)
    expect(merged[0]?.size).toBe(200)
    expect(merged[0]?.attachmentCount).toBe(3)
    // The cached preview is body-derived and may be longer than the EWS one.
    expect(merged[0]?.preview).toBe("local preview")
    expect(merged[0]?.attachmentMatch).toEqual({ id: "att-1", name: "invoice.pdf", snippet: "needle" })
    expect(merged[2]?.attachmentMatch).toEqual({ id: "att-2", name: "notes.docx", snippet: "needle notes" })
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

  test("treats a negative limit as zero", () => {
    expect(mergeSearchResults([message("a", "2026-10-23T00:00:00Z")], [], -1)).toEqual([])
  })
})
