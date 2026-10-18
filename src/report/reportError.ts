export class ReportError extends Error {
  constructor(public readonly stage: 'MODEL' | 'DOCX' | 'PDF' | 'USER_JSON' | 'MARKDOWN' | 'HTML', message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ReportError'
  }
}
