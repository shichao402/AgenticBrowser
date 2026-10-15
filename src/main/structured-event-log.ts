import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

export class StructuredEventLog {
  private queue = Promise.resolve()

  constructor(readonly filePath: string) {}

  append(record: unknown): Promise<void> {
    const entry = `${JSON.stringify(record)}\n`
    const write = this.queue.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true })
      await appendFile(this.filePath, entry, 'utf8')
    })
    this.queue = write.catch(() => undefined)
    return write
  }

  async flush(): Promise<void> {
    await this.queue
  }
}
