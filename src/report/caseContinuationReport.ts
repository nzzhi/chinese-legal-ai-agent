import { caseSchema } from '../case/caseSchema.js'
import { deriveCaseContinuation, type CaseContinuation, type Capability } from '../caseEvidence/caseContinuation.js'
import { disclaimer, type ReportModel } from './reportModel.js'
import type { PrintableReport } from './userCaseReport.js'

const capabilityLabels: Record<Capability, string> = { ANALYSIS: '案件分析', RESEARCH: '法律研究', REPORT: '用户报告',
  FILING_DRAFT: '起诉草稿', EVIDENCE_ASSESSMENT: '材料评估' }
const paragraph = (text: string) => ({ kind: 'paragraph' as const, text })

/** Existing reports already list evidence priorities; avoid printing every gap twice. */
export function continuationSummary(policy: CaseContinuation): ReportModel['sections'][number]['blocks'] {
  const blocked = policy.gaps.filter(g => g.disposition === 'BLOCKING')
  const degrading = policy.gaps.filter(g => g.disposition === 'DEGRADING')
  return [{ kind: 'heading', text: '当前能做什么' },
    paragraph('可继续整理经过、核对材料和生成用户报告；未完成的法律研究不等于整个案件停止。'),
    ...blocked.map(g => paragraph(`${g.title}：${g.reason} 下一步：${g.nextAction}`)),
    { kind: 'heading', text: '尚缺什么、会影响什么' },
    paragraph(degrading.length ? `当前有${degrading.length}项信息、材料或法律依据待补；相关分析与材料评估保留条件，待材料核验。具体补充事项见本报告的材料清单与完整附录。`
      : '当前检查未发现需要降级的事项；不代表真实性鉴定或法院采信。'),
    paragraph(policy.filingDraft.available ? `草稿字段：${policy.filingDraft.fields.map(f => `${f.label}：${f.value}`).join('；')}。占位字段后续补充替换，提交要求另行核对。`
      : '相对方尚不能识别，暂不输出可用起诉草稿字段；用户报告仍可生成。'),
  ]
}

export function continuationSections(policy: CaseContinuation): ReportModel['sections'] {
  // Group identical requests only in the report. Every distinct fact/title and impact survives.
  const grouped = new Map<string, typeof policy.gaps>()
  for (const gap of policy.gaps) {
    const key = JSON.stringify([gap.nextAction, gap.disposition, gap.impacts])
    grouped.set(key, [...(grouped.get(key) ?? []), gap])
  }
  const displayGaps = [...grouped.values()].map(group => ({ ...group[0],
    title: [...new Set(group.map(g => g.title))].join('；'), reason: [...new Set(group.map(g => g.reason))].join('；') }))
  return [{ title: '当前能做什么', blocks: [
    paragraph(policy.researchStatus === 'COMPLETE' ? '已有研究材料，仍需结合事实与材料核对具体适用。'
      : '法律研究尚未完整，仍可整理案件经过、核对材料、生成补充清单和条件性报告。'),
    ...policy.capabilities.map(c => paragraph(`${capabilityLabels[c.capability]}：${c.status === 'BLOCKED' ? '暂不可进行，请先补充对应事项'
      : c.status === 'CONDITIONAL' ? '可以继续，需保留条件与待核对标记' : '可以继续'}`)),
  ] }, { title: '尚缺什么、会影响什么', blocks: displayGaps.length ? displayGaps.flatMap(g => [
    { kind: 'heading' as const, text: g.title }, paragraph(g.reason),
    paragraph(`影响范围：${g.impacts.map(i => capabilityLabels[i.capability]
      + (i.scope === 'DETERMINISTIC_CONCLUSION' ? '中依赖缺失事实的确定性结论' : '')).join('；')}`),
    paragraph(`处理方式：${g.disposition === 'BLOCKING' ? '仅暂停上述能力或结论范围'
      : g.disposition === 'PLACEHOLDER_ALLOWED' ? '可在准备草稿时使用明确待补占位' : '保留条件性分析，待信息或材料核验'}`),
    paragraph(`下一步请补：${g.nextAction}`),
  ]) : [paragraph('当前检查未发现未处理缺口；不代表真实性鉴定或法院采信。')] },
  { title: '草稿中的待补字段', blocks: [paragraph(policy.filingDraft.notice),
    ...(policy.filingDraft.available ? policy.filingDraft.fields.map(f => paragraph(`${f.label}：${f.value}${f.placeholder ? '（占位，后续补充替换）' : '（按现有信息登记，仍须核对）'}`))
      : [paragraph('相对方尚不能识别，暂不输出可使用的起诉草稿字段；本报告与补充事项仍可查看。')]),
  ] }]
}

export interface CaseContinuationReport extends PrintableReport {
  continuation: CaseContinuation
  appendix: ReportModel['sections']
}

/** A facts/gaps report before research is available; no fabricated Rule, classification or conclusion. */
export function buildCaseContinuationReport(input: unknown, now = new Date()): CaseContinuationReport {
  const continuation = deriveCaseContinuation(input)
  const caseData = caseSchema.parse((input as { case: unknown }).case)
  return { title: '当前案件与补充事项', subtitle: '先按当前陈述整理；未研究内容与待核验事项保留边界',
    generatedAt: now.toISOString(), continuation, appendix: [], sections: [
      { title: '当前可以记录和初步梳理的经过', blocks: caseData.facts.concat(caseData.disputedFacts).length
        ? caseData.facts.concat(caseData.disputedFacts).map(f => paragraph(`${f.certainty === 'UNKNOWN' ? '待澄清'
          : f.certainty === 'DISPUTED' ? '有争议的陈述' : '当前陈述（不等于已经证明）'}：${f.content}`))
        : [paragraph('尚未提供可展开的核心事实；可以先按下面的补充清单说明经过。')] },
      { title: '当前依据与判断边界', blocks: [paragraph('本页依据当前案件陈述和材料登记的完整性检查，不生成新的法律结论。'),
        paragraph('已确认材料内容不等于真实性鉴定；未上传原始记录时明确标记待材料核验。'), paragraph(disclaimer)] },
      ...continuationSections(continuation),
    ] }
}
