import { z } from 'zod'
import { caseSchema, type Case } from '../case/caseSchema.js'
import { assessCaseEvidence, caseEvidenceInputSchema, evidenceStage, isConfirmedLink, type CaseEvidenceAssessment } from '../caseEvidence/caseEvidence.js'
import { deriveCaseContinuation, type CaseContinuation, type GapDecision } from '../caseEvidence/caseContinuation.js'
import { buildReport } from './reportBuilder.js'
import type { ReportBlock, ReportModel } from './reportModel.js'
import type { PrintableReport } from './userCaseReport.js'
import type { UserActionReportModel } from './userActionReportModel.js'
import { validatedConditionalResearch } from './conditionalResearchReport.js'
import { projectUserCaseV2 } from './userCaseAnalysisV2.js'
import { printableUserActionReport } from './userActionRenderer.js'

const p = (text: string): ReportBlock => ({ kind: 'paragraph', text })
const h = (text: string): ReportBlock => ({ kind: 'heading', text })
const unique = (values: string[]) => [...new Set(values)]
const requestFact = (content: string) => /希望|想(?:要|问|了解)|要求|能否|能不能|是否可以/.test(content)
const goalFact = (fact: Case['facts'][number]) => ['OTHER', 'DISPUTE'].includes(fact.category) && requestFact(fact.content)
export const analysisNotice = '以下分析基于你目前提供的信息。尚未核验的材料会特别标注；补充材料后可重新生成报告。'
export type UserGapPriority = 'A' | 'B' | 'C' | 'D'
export function userGapPriority(gap: GapDecision): UserGapPriority {
  if (!gap.factIds.length && !gap.questionIds.length && /法律研究|法律依据/.test(gap.title)) return 'D'
  if (gap.impacts.every(i => i.capability === 'FILING_DRAFT') || /身份|名称|主体|工商/.test(gap.title) && !gap.factIds.length) return 'C'
  return gap.disposition === 'BLOCKING' ? 'A' : 'B'
}
export function prioritizedUserGaps(policy: CaseContinuation) {
  const groups = new Map<string, { priority: UserGapPriority; title: string; titles: string[]; action: string; ids: string[] }>()
  for (const gap of policy.gaps) {
    const priority = userGapPriority(gap)
    if (priority === 'D') continue
    const unknown = gap.nextAction.startsWith('补充说明：')
    const family = !unknown ? undefined : /身份|姓名|名称|主体|工商|账号/.test(gap.title) ? '核对交易主体和对应关系'
      : /日期|时间|期限|何时/.test(gap.title) ? '整理交易与履行时间线'
      : /单价|价格|赠|套餐|次数|履行|退款|退费|返还/.test(gap.title) ? '核对约定、履行和金额计算' : '整理尚不清楚的关键经过'
    const action = family ? `${family}，优先对照付款、确认和沟通原始记录；没有记录的保留待核对。` : gap.nextAction
    const key = `${priority}:${action}`
    const group = groups.get(key) ?? { priority, title:family ?? gap.title, titles: [], action, ids: [] }
    group.titles.push(gap.title); group.ids.push(gap.id); groups.set(key, group)
  }
  return [...groups.values()].sort((a,b) => a.priority.localeCompare(b.priority))
}

const sectionKey = z.enum(['plaintiff', 'representative', 'agent', 'defendant', 'requests', 'reasons', 'evidence', 'court', 'attachments', 'signature'])
// Portfolio-only preparation outline authored for this export; no third-party court HTML is distributed.
function preparationOutline() {
  return { id: 'portfolio-preparation-outline', name: '民事材料准备提纲（项目自拟）', publisher: 'Chinese 项目',
    url: 'https://www.court.gov.cn/', publishedAt: '2026-10-18', importedAt: '2026-10-18', scope: '仅作准备提纲，不是法院官方模板',
    sections: [
      ['plaintiff', '申请人信息'], ['representative', '法定代理情况'], ['agent', '委托情况'], ['defendant', '对方主体信息'],
      ['requests', '拟提出的请求'], ['reasons', '事实经过与待核依据'], ['evidence', '已有材料及来源'],
      ['court', '拟提交机构（待核）'], ['attachments', '附件核对'], ['signature', '签署核对'],
    ].map(([key,title]) => ({key:sectionKey.parse(key),title})) }
}

export interface EvidenceDirectoryEntry { name: string; purpose: string; status: string; need: string; evidenceId: string }
export function evidenceDirectory(caseData: Case, assessment: CaseEvidenceAssessment): EvidenceDirectoryEntry[] {
  const entries = assessment.items.filter(e => e.file?.confirmationStatus !== 'REJECTED').map(item => {
    const links = assessment.links.filter(l => l.evidenceId === item.id && l.status !== 'CANCELLED')
    const confirmed = links.filter(isConfirmedLink)
    const recheck = links.some(l => l.status === 'SUGGESTED')
    return { evidenceId: item.id, name: item.title ?? item.description ?? '已登记材料',
      purpose: confirmed.length ? unique(confirmed.map(l => l.purpose)).join('；') : '尚未确认具体证明目的，请对照原文建立事实关联。',
      status: evidenceStage(item, assessment.items) + (recheck ? '；当前事实关联需重新核对' : ''),
      need: !item.content ? '补充原文和完整上下文，待材料核验。' : recheck ? '重新核对关联事实及引用，待材料核验。'
        : !confirmed.length ? '核对证明目的与事实关联。' : '保留原件、来源和完整上下文；真实性及证明力仍需核验。' }
  })
  // Display the user's holding statements separately; they do not become Evidence or confirmed links.
  for (const fact of caseData.facts) {
    if (!/(?:有|持有|保留).*(?:付款记录|支付记录|转账记录|聊天记录|课程确认|消费记录|闭店通知)/.test(fact.content) || /没有|无相关/.test(fact.content)) continue
    const name = /付款|支付|转账/.test(fact.content) ? '付款记录' : /课程确认/.test(fact.content) ? '课程确认记录'
      : /消费记录/.test(fact.content) ? '已消费记录' : /闭店通知/.test(fact.content) ? '闭店材料' : '聊天记录'
    if (entries.some(e=>e.name.includes(name))) continue
    const related = caseData.facts.filter(f=>f.id!==fact.id && (name==='付款记录' ? f.category==='PAYMENT'
      : name==='课程确认记录' || name==='已消费记录' ? ['SERVICE','CONTRACT'].includes(f.category) : name==='闭店材料' ? /闭店/.test(f.content) : f.category==='COMMUNICATION'))
    entries.push({evidenceId:fact.id,name,purpose:`拟用于核对：${related.map(f=>f.content).join('；') || '约定、履行或沟通经过'}；须先查看原文确认具体证明目的。`,status:'你提到持有，原文尚未导入',need:'通过页面上传或登记原文，再核对完整上下文与事实关联。'})
  }
  return entries
}

export interface ComplaintDraft extends PrintableReport {
  appendix: ReportModel['sections']
  status: 'AVAILABLE' | 'AVAILABLE_WITH_PLACEHOLDERS' | 'NOT_APPROPRIATE'
  missingFields: string[]
  template: ReturnType<typeof preparationOutline>
}
/** Preparation projection only: no change to filingReadiness, Fact certainty or publication gates. */
export function buildComplaintDraft(caseData: Case, assessment: CaseEvidenceAssessment, internal?: ReportModel, now = new Date()): ComplaintDraft {
  const template = preparationOutline(), missingFields: string[] = []
  const facts = caseData.facts.concat(caseData.disputedFacts)
  const labeled = (label: string, pattern: string) => {
    const values = unique(facts.filter(f => f.category === 'PARTY' && f.certainty !== 'UNKNOWN' && f.certainty !== 'DISPUTED')
      .flatMap(f => [...f.content.matchAll(new RegExp(`(?:^|[\\n；;，,])(?:${pattern})[：:]\\s*([^\\n；;，,。]+)`, 'gu'))].map(m => m[1].trim()))
      .filter(v => !/未知|不详|待补|未提供|【|】/.test(v)))
    if (values.length === 1) return values[0]
    missingFields.push(label); return `【待补：${label}】`
  }
  const goals = facts.filter(goalFact).map(f => f.content)
  const appropriate = facts.some(f => f.certainty !== 'UNKNOWN' && ['PAYMENT','CONTRACT','SERVICE','EVENT','TERMINATION'].includes(f.category))
    && (!internal || !/劳动纠纷/.test(internal.subtitle))
  const fields: Record<z.infer<typeof sectionKey>, ReportBlock[]> = {
    plaintiff: [p(`姓名：${labeled('原告姓名','原告姓名|本人姓名')}；性别：${labeled('原告性别','原告性别')}；出生日期：${labeled('原告出生日期','原告出生日期')}；民族：${labeled('原告民族','原告民族')}；工作单位或职业：${labeled('原告工作单位或职业','原告工作单位|原告职业')}；住所：${labeled('原告住所地','原告住所|原告住址')}；联系方式：${labeled('原告联系电话','原告联系电话|本人联系电话')}`)],
    representative: [p('【待核对：是否需要法定代理人/指定代理人；如有，补充姓名、身份及联系方式】')],
    agent: [p('【待核对：是否已委托诉讼代理人；如有，补充姓名、单位及联系方式】')],
    defendant: [p(`名称或姓名：${labeled('被告名称','被告名称|对方名称|经营主体名称|被告姓名|对方姓名')}；住所地：${labeled('被告住所地','被告住所地|对方住所地')}；联系电话：${labeled('被告联系电话','被告联系电话|对方联系电话')}`),
      p(`主体类型：${labeled('被告主体类型','被告主体类型')}；自然人基本信息 / 法人主要负责人：${labeled('被告基本身份或负责人信息','被告基本身份|被告负责人')}；统一社会信用代码（法人/其他组织适用）：${labeled('统一社会信用代码','统一社会信用代码')}`)],
    requests: [p(goals.length ? `拟提出的请求（按你的陈述登记）：${goals.join('；')}` : '【待补：具体诉讼请求】'),
      p(`请求金额：${labeled('具体诉讼请求金额','诉讼请求金额|请求金额')}；【待核对：计算方式、已履行/已返还部分及其他请求】`)],
    reasons: facts.filter(f => !goalFact(f)).map(f => p(`${f.certainty === 'DISPUTED' ? '争议陈述：' : f.certainty === 'UNKNOWN' ? '尚待核对：' : ''}${f.content}`))
      .concat(p('以上为现有陈述整理。法律理由与请求支持范围需结合已核验依据及适用条件进一步核对；未完成部分不补写为确定结论。')),
    evidence: evidenceDirectory(caseData, assessment).flatMap((e,i) => [h(`${i+1}. ${e.name}`),p(`证明目的：${e.purpose}`),p(`当前状态：${e.status}`),p(`还需补：${e.need}`)])
      .concat(p('【待补：证据来源、原件位置；如有证人，补充姓名和住所；如无，核对后注明】')),
    court: [p(`${labeled('提交法院','提交法院|受理法院')}人民法院（提交前核对管辖及法院全称）`)],
    attachments: [p(`本起诉状副本${labeled('起诉状副本份数','起诉状副本份数')}份`),p('附件/材料清单：'),
      ...assessment.items.filter(e=>e.file?.confirmationStatus !== 'REJECTED').map(e=>p(e.title ?? e.description ?? '已登记材料')),
      p('【待补：原告身份证明及后续办理所需材料；不要以本草稿代替立案核对】')],
    signature: [p('【待补：起诉人本人签名】'),p('【待补：签署日期】')],
  }
  missingFields.push('起诉人本人签名', '签署日期')
  if (!goals.length) missingFields.push('具体诉讼请求')
  const status = appropriate ? missingFields.length ? 'AVAILABLE_WITH_PLACEHOLDERS' as const : 'AVAILABLE' as const : 'NOT_APPROPRIATE' as const
  return { title:'民事起诉状准备草稿', subtitle:template.name, generatedAt:now.toISOString(), status, missingFields, template, appendix:[],
    sections: appropriate ? [{title:'准备草稿说明',blocks:[p('当前为准备草稿，不代表已经满足法院立案要求。'),p(`本草稿参考：${template.name}；来源：${template.publisher}；发布日期：${template.publishedAt}`),
      {...p('查看法院公开办事信息（非本提纲来源）'),href:template.url},p('本提纲为项目自行编写，仅组织准备信息，不是官方诉状样式或程序合规结论。'),p(`生成时缺失字段：${missingFields.join('、')}`)]},
      ...template.sections.map(s=>({title:s.title,blocks:fields[s.key]}))] : [{title:'当前不适合输出可用民事起诉草稿',blocks:[p('尚缺基本案件经过，或当前类型需要先核对前置程序；可继续保存材料和准备清单。')]}] }
}

/** User projection only: validators and publication checks remain authoritative. */
export function buildUserAnswerReport(input: unknown, policy = deriveCaseContinuation(input), now = new Date(), action?: UserActionReportModel) {
  const source = z.object({case:caseSchema,caseEvidence:caseEvidenceInputSchema.optional()}).passthrough().parse(input)
  const internal = source.classification !== undefined ? buildReport(input, now) : undefined
  const assessment = internal?.caseEvidenceAssessment ?? assessCaseEvidence({case:source.case,evidence:source.caseEvidence,legalQuestions:[],ruleApplications:[]})
  const conditional = validatedConditionalResearch(input)
  const report = projectUserCaseV2(input, assessment, policy, internal, conditional, buildComplaintDraft(source.case,assessment,internal,now),
    evidenceDirectory(source.case,assessment), prioritizedUserGaps(policy), analysisNotice, now, action?.legalBasisItems?.flatMap(b => b.relatedRuleIds))
  if (!conditional && action?.loanCoreAnalysis) {
    const core = printableUserActionReport(action).sections.find(s => s.title === '为什么：六个核心问题的条件分析')!
    report.sections.push({ ...core, title: '六个核心问题的条件分析（附录）' })
  }
  return report
}
