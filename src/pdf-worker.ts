import { parentPort, workerData } from "node:worker_threads"
import { getDocumentProxy } from "unpdf"

interface PdfJob {
  data: Uint8Array
  maxChars: number
  maxPages: number
}

const job = workerData as PdfJob

const run = async (): Promise<void> => {
  let document: Awaited<ReturnType<typeof getDocumentProxy>> | undefined
  try {
    document = await getDocumentProxy(new Uint8Array(job.data), { verbosity: 0 })
    const pageCount = Math.min(document.numPages, job.maxPages)
    const limit = Math.max(job.maxChars * 4, 4096)
    const pages: string[] = []
    let chars = 0
    let capped = false
    for (let index = 1; index <= pageCount; index++) {
      const page = await document.getPage(index)
      const content = await page.getTextContent()
      let text = ""
      let pageFull = false
      for (const item of content.items) {
        const typed = item as { str?: string; hasEOL?: boolean }
        if (typeof typed.str !== "string") continue
        const piece = typed.str + (typed.hasEOL ? "\n" : "")
        const remaining = limit - chars - text.length
        if (piece.length >= remaining) {
          text += piece.slice(0, Math.max(0, remaining))
          capped = true
          pageFull = true
          break
        }
        text += piece
      }
      page.cleanup()
      pages.push(text)
      chars += text.length
      if (pageFull || chars >= limit) break
    }
    const truncated = document.numPages > job.maxPages || capped
    parentPort?.postMessage({ ok: true, text: pages.join("\n\n"), pages: document.numPages, truncated })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    parentPort?.postMessage({ ok: false, error: message })
  } finally {
    try {
      await (document as { _transport?: { destroy?: () => Promise<void> } } | undefined)?._transport?.destroy?.()
    } catch {
      // Best-effort cleanup in the worker.
    }
  }
}

void run()
