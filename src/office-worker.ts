import { parentPort, workerData } from "node:worker_threads"
import { type ExtractInput, extractAttachmentText } from "./attachments"

const job = workerData as ExtractInput

const run = async (): Promise<void> => {
  try {
    const result = await extractAttachmentText({ ...job, fromWorker: true, signal: undefined })
    parentPort?.postMessage({ ok: true, result })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    parentPort?.postMessage({ ok: false, error: message })
  }
}

void run()
