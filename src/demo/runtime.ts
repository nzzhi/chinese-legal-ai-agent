import { readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { AuthorityCorpus } from '../authority/authorityCorpus.js'
import { createWorkbenchRuntime, type WorkbenchRuntimeFactory } from '../workbench/researchRuntime.js'
import type { ModelClient } from '../llm/modelClient.js'
import { caseSchema } from '../case/caseSchema.js'
import { WorkspaceError } from '../caseEvidence/workspace.js'

export const demoStatement = 'SIMULATED / DEMO ONLY\n朋友借了我8000元，说好三个月还，有微信转账和聊天记录。现在到期了，多次催款也一直不还。我想要回本金，应该准备什么？'

// Authored substitute, not a captured model response. Only this fixed synthetic scenario is supported.
const model: ModelClient = { async chat(request) {
  const input = JSON.parse(request.messages[1].content)
  if ('rawCase' in input && !('sources' in input)) {
    if (input.rawCase !== demoStatement) throw new WorkspaceError('离线作品集仅支持“填入模拟案情”的固定样例；其他输入需要自行配置真实模型。', 400)
    return { model: 'authored-demo-substitute', finishReason: 'STOP', text: JSON.stringify({
      case: input.currentCase ?? caseSchema.parse({ id: `demo-${randomUUID()}`, events: [], disputedFacts: [],
        facts: [
          { id: 'loan', content: '用户称朋友向其借款8000元。', category: 'CONTRACT', certainty: 'USER_CLAIM', source: 'USER_INPUT' },
          { id: 'term', content: '用户称约定三个月后归还，现在已经到期。', category: 'CONTRACT', certainty: 'USER_CLAIM', source: 'USER_INPUT' },
          { id: 'payment', content: '用户称有微信转账和聊天记录。', category: 'PAYMENT', certainty: 'USER_CLAIM', source: 'USER_INPUT' },
          { id: 'demand', content: '用户称多次催款仍未还。', category: 'COMMUNICATION', certainty: 'USER_CLAIM', source: 'USER_INPUT' },
        ], unknownFacts: [{ question: '具体日期、主体身份及是否有部分还款或延期约定？', importance: 'HIGH' }] }),
      plan: { legalTerms: [{ term: '借款合同', basisQuote: '朋友借了我8000元' }, { term: '返还借款', basisQuote: '我想要回本金' }],
        searches: [{ query: '借款人按照约定期限返还借款', keywords: ['借款人', '期限', '返还借款'], reason: '核对返还借款的规则' },
          { query: '自然人借款合同提供借款成立', keywords: ['自然人', '借款合同', '提供借款'], reason: '核对资金交付与合同成立' }] },
    }) }
  }
  return { model: 'authored-demo-substitute', finishReason: 'STOP', text: JSON.stringify({
    title: '模拟借贷案：材料准备与初步分析',
    summary: '这是固定合成样例的离线流程演示。已整理借款、期限、转账与催款陈述；本副本仅带两条历史法条摘录，未完成现行效力核验，暂不作有充分法源支撑的肯定法律判断。',
    findings: [{ status: 'TO_VERIFY', conclusion: '先核对借款、资金交付和期限的对应关系',
      reasoning: '用户陈述不是已证实事实。应保留完整聊天和转账原件，并核实收款人身份、具体日期、剩余本金及后续延期约定。',
      factIds: input.case.facts.filter((f: { id: string }) => ['loan','term','payment','demand'].includes(f.id)).map((f: { id: string }) => f.id),
      evidenceIds: [], citations: [] }],
    evidenceAnalysis: input.evidence.filter((e: { content?: string }) => e.content).map((e: { id: string; content: string }) => ({
      evidenceId: e.id, label: '已读取的模拟材料', quote: e.content.split('\n').find((l: string) => l.trim()) || e.content,
      factIds: [], meaning: '展示实际上传和读取链路；内容来自合成样例。', limitation: '不证明真实交易、主体身份或欠款余额。',
    })),
    nextSteps: ['按借款约定、交付、催款顺序保存完整原始记录。', '核对自然人身份、到期日期、有无部分还款和后续延期。'],
    uncertainties: ['具体日期、主体身份、剩余本金及后续约定尚未核实。'],
    legalLimitations: ['现行效力与本案适用性尚未完成核验；法条摘录不作为确定法律结论。'],
    risks: ['本演示是人工编写的模型替身，不衡量真实模型的法律质量或速度。'],
  }) }
} }

export function createDemoRuntime(root: string): WorkbenchRuntimeFactory {
  mkdirSync(root, { recursive: true })
  const database = join(root, 'authority.sqlite')
  const corpus = new AuthorityCorpus(database)
  try {
    const body = readFileSync(new URL('../../demo/legal-excerpts.txt', import.meta.url), 'utf8')
    corpus.importDocument({ document: { id: 'portfolio-civil-code-excerpts', title: '中华人民共和国民法典（两条历史摘录，效力未核）',
      sourceId: 'supreme-court-official', documentType: 'STATUTE', issuingAuthority: '全国人民代表大会',
      promulgatedAt: '2020-05-28', effectiveAt: '2021-01-01', validityStatus: 'UNKNOWN',
      officialUrl: 'https://www.court.gov.cn/zixun/xiangqing/233181.html', fetchedAt: '2026-10-18T08:19:09Z' },
      bodyText: body, snapshot: { content: body, format: 'TEXT' } })
  } finally { corpus.close() }
  return (budget, options) => {
    if (options?.mode === 'STRICT') throw new WorkspaceError('固定替身 Demo 仅运行初步分析；STRICT 实现保留，需真实模型及自行核验的法源。', 409)
    const values = { LLM_API_KEY: 'demo-placeholder', LLM_BASE_URL: 'http://127.0.0.1:9',
      LLM_FLASH_MODEL: 'authored-demo-substitute', LLM_PRO_MODEL: 'authored-demo-substitute', LEGAL_AUTHORITY_DB_PATH: database }
    const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]))
    Object.assign(process.env, values)
    try { return createWorkbenchRuntime(budget, { ...options, mode: 'PRELIMINARY', localAuthoritiesOnly: true, modelClient: model }) }
    finally { for (const key of Object.keys(values)) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key] } }
  }
}
