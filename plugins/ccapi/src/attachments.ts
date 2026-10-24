import type { DocumentBlock, ImageBlock } from './api.ts'

export type Attachment = { n: number; block: ImageBlock | DocumentBlock }

export class AttachmentList {
  readonly items: Attachment[] = []

  add(block: ImageBlock | DocumentBlock): number {
    const n = this.items.length + 1
    this.items.push({ n, block })
    return n
  }

  // view_attachments answers with an array of Anthropic content blocks: the only tool
  // result shape whose images reach the model (spike finding 4b).
  toToolResult(ids?: readonly number[]): Array<Record<string, unknown>> {
    const chosen = ids && ids.length > 0 ? this.items.filter(a => ids.includes(a.n)) : this.items
    if (chosen.length === 0) return [{ type: 'text', text: 'No attachments match.' }]
    return chosen.flatMap(a => [{ type: 'text', text: `attachment #${a.n}:` }, { ...a.block }])
  }
}
