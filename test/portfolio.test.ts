import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildWorkbenchApp } from '../src/workbench/server.js'
import { createDemoRuntime, demoStatement } from '../src/demo/runtime.js'
import { AuthorityCorpus } from '../src/authority/authorityCorpus.js'
import { assessCaseEvidence } from '../src/caseEvidence/caseEvidence.js'
import { buildComplaintDraft } from '../src/report/userAnswerExperience.js'

test('export demo: create, reject arbitrary input, upload, analyse, five formats and restart', { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'chinese-portfolio-test-'))
  const options = { evidenceRoot: join(root, 'workspace'), runtimeFactory: createDemoRuntime(root), executionMode: 'OFFLINE' as const }
  let app = buildWorkbenchApp(options)
  const post = (url: string, payload: unknown = {}) => app.inject({ method: 'POST', url, payload,
    headers: { 'x-evidence-workspace': '1' } })
  try {
    assert.equal((await app.inject('/health')).json().executionMode, 'OFFLINE')
    assert.equal((await app.inject('/portfolio-demo.js')).statusCode, 200)
    assert.equal((await post('/api/cases', { rawCase: 'NOT THE FIXED DEMO' })).statusCode, 400)
    assert.equal((await post('/api/cases', { rawCase: demoStatement, mode: 'STRICT' })).statusCode, 409)
    const created = await post('/api/cases', { rawCase: demoStatement })
    assert.equal(created.statusCode, 201, created.body)
    const { key } = created.json()
    const bytes = await readFile(new URL('../demo/materials/transfer.txt', import.meta.url))
    const upload = await app.inject({ method: 'POST', url: `/api/cases/${key}/materials`, payload: bytes,
      headers: { 'x-evidence-workspace': '1', 'content-type': 'application/octet-stream', 'x-file-name': 'transfer.txt', 'x-file-mime': 'text/plain' } })
    assert.equal(upload.statusCode, 200, upload.body)
    const materialId = upload.json().evidenceId
    assert.equal((await post(`/api/cases/${key}/materials/${materialId}/parse`)).statusCode, 200)
    assert.equal((await post(`/api/cases/${key}/research`)).statusCode, 202)
    let view: any
    for (let attempt = 0; attempt < 120; attempt++) {
      view = (await app.inject(`/api/cases/${key}?mode=PRELIMINARY`)).json()
      if (view.researchRun?.status !== 'RUNNING') break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.equal(view.researchRun.status, 'SAVED', view.researchRun.error)
    assert.ok(view.preliminaryReport)
    assert.match(JSON.stringify(view.preliminaryReport), /效力|法源/)
    assert.equal(view.evidence.items[0].file.extractionMethod, 'TEXT')
    const version = view.latestReport.reportVersionId
    for (const format of ['json','html','md','docx','pdf']) {
      const result = await app.inject(`/api/cases/${key}/report-versions/${version}?kind=user&format=${format}`)
      assert.equal(result.statusCode, 200, format)
      assert.ok(result.rawPayload.length > 30)
      if (format === 'pdf') assert.equal(result.rawPayload.subarray(0,5).toString(), '%PDF-')
      if (format === 'docx') assert.equal(result.rawPayload.subarray(0,2).toString(), 'PK')
    }
    await app.close()
    app = buildWorkbenchApp(options)
    const restored = (await app.inject(`/api/cases/${key}?mode=PRELIMINARY`)).json()
    assert.equal(restored.latestReport.reportVersionId, version)
    assert.equal(restored.evidence.items[0].content, bytes.toString().trim())
    const corpus = new AuthorityCorpus(join(root, 'authority.sqlite'), { readOnly: true })
    try {
      const hits = corpus.search({ query: '借款人返还借款', topK: 8 })
      assert.ok(hits.length)
      assert.ok(hits.every(hit => hit.document.validityStatus === 'UNKNOWN'))
    } finally { corpus.close() }
  } finally { await app.close(); await rm(root, { recursive: true, force: true }) }
})

test('offline guard rejects external requests', () => {
  assert.throws(() => fetch('https://example.com/'), /OFFLINE/)
})

test('project-authored preparation outline needs no third-party court HTML', () => {
  const caseData = { id: 'synthetic', facts: [{ id: 'one', content: '用户称有借款约定。', category: 'CONTRACT' as const,
    certainty: 'USER_CLAIM' as const, source: 'USER_INPUT' as const }], disputedFacts: [], events: [], unknownFacts: [] }
  const assessment = assessCaseEvidence({ case: caseData, legalQuestions: [], ruleApplications: [] })
  const draft = buildComplaintDraft(caseData, assessment)
  assert.match(draft.template.scope, /不是法院官方模板/)
  assert.equal(draft.template.sections.length, 10)
  assert.match(JSON.stringify(draft.sections), /项目自行编写/)
})
