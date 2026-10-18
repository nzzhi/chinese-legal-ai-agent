import { z } from 'zod'
import { normativeSourceUnits } from '../legalRule/normativeRule.js'
import { normalizedRuleText } from '../legalRule/conditionalAnalysis.js'
import type { VerifiedLegalSource } from '../verification/sourceVerificationSchema.js'
import type { PreliminaryResult } from './preliminaryWorkflow.js'
import { authorityArticleSchema, authorityHash } from '../authority/authoritySchema.js'
import { splitAuthorityArticles, type AuthorityCorpus } from '../authority/authorityCorpus.js'
import { preliminaryCoverage } from './preliminaryCoverage.js'

export const preliminaryDocumentContextSchema = z.strictObject({
  documentId: z.string().min(1), documentContentHash: z.string().regex(/^[a-f0-9]{64}$/),
  articles: z.array(authorityArticleSchema).max(16),
})
export type PreliminaryDocumentContext = z.infer<typeof preliminaryDocumentContextSchema>

export const applicationCheckSchema = z.strictObject({
  quote: z.string().trim().min(1).max(20_000),
  assessment: z.enum(['BASED_ON_STATEMENT', 'UNRESOLVED', 'NOT_APPLICABLE']),
  factIds: z.array(z.string().min(1)).max(100).refine(v => new Set(v).size === v.length),
  reason: z.string().trim().min(8).max(2000),
})
export const preliminaryQualitySchema = z.strictObject({
  version: z.literal(1), scope: z.literal('LOCAL_SOURCE_BOUNDARY_CHECKS'),
  status: z.enum(['CHECKED', 'REVIEW_REQUIRED', 'BLOCKED']),
  legalCorrectness: z.literal('NOT_INDEPENDENTLY_VERIFIED'),
  issues: z.array(z.strictObject({ code: z.string(), severity: z.enum(['ERROR', 'WARNING']), message: z.string(),
    sourceId: z.string().optional(), findingIndex: z.number().int().nonnegative().optional() })).max(1024),
})
export type PreliminaryQuality = z.infer<typeof preliminaryQualitySchema>
type Source = Pick<VerifiedLegalSource, 'providerSourceId' | 'content' | 'authority'>
const conditional = /仅|只有|限于|按照|依照|具有下列|下列情形|经[^，。]{1,30}同意|自[^，。；\n]{1,80}(?:时|之日|之日起)(?:成立|生效|失效)|的[，,]|除[^。]{0,120}外|但是|但[，,]|仍(?:应|须|需|由)|继续承担|始终承担|前款|本款/u
const continuation = /^(?:但|但是|除|前款|本款|上述)|相应[^。]{0,80}仍|仍(?:应|须|需|由)|继续承担|始终承担/u
const qualified = /若|如|前提|在.{0,50}(?:条件|情形|情况下)|按(?:照)?(?:你|您|用户)?(?:的)?陈述|根据.{0,12}陈述|待核实|尚需|仍需/u
const negativeApplication = /不适用|不符合|不属于|不能(?:依据|据此|要求|直接)|不可依据|尚不具备|暂不|无法据此|不足以|不当然/u
const norm = /应当|不得|不能|可以|有权|承担|无效|有效|适用/u
const scope = /(?<!参照)适用本(?:法|条例|规定|解释)|本(?:法|条例|规定|解释)(?:适用于|所称)|另有规定的[，,]从其规定|由[^。]{0,60}制定管理办法/u
const commencement = /本(?:法|条例|规定|解释)自\s*\d{4}年.{1,12}施行/u
const temporalScope = /本(?:法|条例|规定|解释)施行后/u
const scopeException = /另有规定|从其规定|制定管理办法/u

/** Keep the same source/complete-unit checks for the article and its verified document context. */
export function preliminaryCheckTexts(source: Source, contexts?: PreliminaryDocumentContext[]) {
  return [source.content, ...contexts?.find(c => c.documentId === source.authority?.document.id
    && c.documentContentHash === source.authority?.document.contentHash)?.articles.map(a => a.text) ?? []]
}

/** ponytail: explicit task wording only; the model must still separate legal analysis from case facts. */
export function preliminaryLegalResearchTopics(value: string) {
  const topics = /法条|法规|法源|法律(?:效力|适用|解释|条文|规定)|现行效力|施行(?:时间|日期)|生效(?:时间|日期)|适用范围|举证责任|证明责任|诉讼时效|管辖|程序要求|旧法|过渡规则/gu
  return /核实|核验|核对|核查|查明|查询|检索|查阅|确认|复核|审查|研究/u.test(value) ? [...new Set(value.match(topics) ?? [])] : []
}
export const isPreliminaryLegalResearchTask = (value: string) => preliminaryLegalResearchTopics(value).length > 0

/** A local wording guard, not a complete legal-semantic classifier. */
export const hasPreliminaryLegalAssertion = (s: string) => s.split(/[，,。；;\n]|但是|然而|但/u).some(part =>
  /有权|应当|必须|(?:可以|可)(?:要求|主张|请求)|应(?:支付|返还|赔偿)|构成|无效/u.test(part)
    && !/不能|不可|不应|不得|暂不|尚不|不足以|待核实|尚需核实|无法确认/u.test(part))

/** The normal verifier already checked the full snapshot/body, not just the selected article. */
export function preliminaryDocumentContexts(sources: readonly Source[], corpus: AuthorityCorpus): PreliminaryDocumentContext[] {
  return [...new Map(sources.filter(s => s.authority).map(s => [s.authority!.document.id, s.authority!.document])).values()].map(metadata => {
    const document = corpus.getDocument(metadata.id)
    if (!document || document.contentHash !== metadata.contentHash || document.snapshotHash !== metadata.snapshotHash
      || authorityHash(document.bodyText) !== metadata.contentHash) throw new Error('Preliminary document context differs from verified snapshot')
    // ponytail: introductory/closing ten articles plus commencement; unmatched scope stays a system gap.
    const articles = splitAuthorityArticles(document.id, document.bodyText)
    const context = articles.filter((a, i) => (i < 10 || i >= articles.length - 10) && scope.test(a.text) || commencement.test(a.text))
    if (context.length > 16) throw new Error('Preliminary document context exceeds article limit')
    return preliminaryDocumentContextSchema.parse({ documentId: document.id, documentContentHash: document.contentHash, articles: context })
  })
}

function asserted(text: string, pattern: RegExp) {
  return [...text.matchAll(pattern)].some(m => !/(?:不能|不应|不可|不得|不要|切勿|并非|不意味着|不代表|不等于)[^，,。；;\n]{0,15}$/u
    .test(text.slice(Math.max(0, m.index! - 30), m.index)))
}

/** Source-derived reading notes only: no rule graph, applicability model, or extra request. */
export function preliminaryBoundaries(content: string) {
  return normativeSourceUnits(content).filter(u => conditional.test(u.text) || norm.test(u.text)).map(u => ({
    quote: u.text.trim(), kind: /仍(?:应|须|需|由)|继续承担|始终承担|前款|本款/u.test(u.text) ? 'LIMITATION'
      : /除[^。]{0,120}外|但是|但[，,]/u.test(u.text) ? 'EXCEPTION' : conditional.test(u.text) ? 'PRECONDITION' : 'NORMATIVE_STATEMENT',
  }))
}

/** Bind only complete source units (optionally without an article heading), including multi-sentence checks. */
function boundUnits(content: string, quote: string) {
  if (!content.includes(quote)) return []
  const start = content.indexOf(quote), end = start + quote.length
  if (content.indexOf(quote, start + 1) >= 0) return []
  const units = normativeSourceUnits(content).filter(u => u.start < end && u.end > start)
  return normalizedRuleText(units.map(u => u.text).join('')) === normalizedRuleText(quote) ? units : []
}

/** Display the actual complete article, never a model-selected header or truncated list. */
export function preliminaryCitationText(source: Source, quote: string) {
  return source.authority ? source.content : quote
}

/** ponytail: bounded textual checks catch explicit omissions/contradictions; implicit conflicts still need legal review.
 * CHECKED means these checks ran; it never certifies legal correctness. */
export function assessPreliminaryQuality(input: Pick<PreliminaryResult, 'analysis' | 'case'> & Partial<Pick<PreliminaryResult, 'documentContexts' | 'plan' | 'retrievals'>>, sources: readonly Source[]): PreliminaryQuality {
  const issues: PreliminaryQuality['issues'] = [], byId = new Map(sources.map(s => [s.providerSourceId, s]))
  const facts = new Set(input.case.facts.concat(input.case.disputedFacts).map(f => f.id))
  const add = (code: string, severity: 'ERROR' | 'WARNING', message: string, sourceId?: string, findingIndex?: number) => {
    if (!issues.some(i => i.code === code && i.sourceId === sourceId && i.findingIndex === findingIndex)) {
      issues.push({ code, severity, message, ...(sourceId ? { sourceId } : {}), ...(findingIndex !== undefined ? { findingIndex } : {}) })
    }
  }
  const globalProse = [input.analysis.summary, ...input.analysis.nextSteps, ...input.analysis.risks ?? [], ...input.analysis.uncertainties,
    ...input.analysis.legalLimitations ?? []].join('\n')
  if ([...input.analysis.nextSteps, ...input.analysis.uncertainties].some(isPreliminaryLegalResearchTask)) {
    add('LEGAL_RESEARCH_DELEGATED', 'WARNING', '法律检索、效力及法律适用核验属于系统职责，不得列为用户补充任务。')
  }
  const allProse = [globalProse, ...input.analysis.findings.flatMap(f => [f.conclusion, f.reasoning,
    ...f.citations.flatMap(c => [c.relevance ?? '', ...c.checks?.map(a => a.reason) ?? []])])].join('\n')
  const coverage = input.plan && input.retrievals ? preliminaryCoverage({ plan: input.plan, retrievals: input.retrievals }) : []
  const gaps = coverage.filter(c => c.status === 'INSUFFICIENT')
  const coveredIds = new Set(coverage.flatMap(c => c.sourceIds))
  const mentionsGap = (s: string) => gaps.some(g => {
    const topic = input.plan!.searches[Number(g.questionId.split('-').at(-1)) - 1]
    return g.missingKeywords.some(k => s.includes(k)) && topic.keywords.filter(k => s.includes(k)).length >= 2
  })
  if (gaps.length) {
    add('INSUFFICIENT_TOPIC_AUTHORITY', 'WARNING', `核心争点尚缺可对应的有效规范：${gaps.map(g => g.query).join('；')}。通用条文或公开参考不能替代，相关结论暂不确认。`)
  }
  // Global prose has no structured topic binding. Keep supported findings, withhold unbound certainty.
  if (input.plan && input.retrievals && (gaps.length || !coveredIds.size)
    && [input.analysis.summary, ...input.analysis.nextSteps, ...input.analysis.risks ?? []].some(hasPreliminaryLegalAssertion)) {
    add('UNSUPPORTED_TOPIC_CONCLUSION', 'WARNING', '摘要或行动建议包含未能绑定充分争点依据的肯定法律判断，用户报告须隐藏相应判断并显示限制。')
  }
  input.analysis.findings.forEach((finding, findingIndex) => {
    if (input.plan && input.retrievals && hasPreliminaryLegalAssertion(`${finding.conclusion}\n${finding.reasoning}`) && (mentionsGap(`${finding.conclusion}\n${finding.reasoning}`)
      || !finding.citations.some(c => coveredIds.has(c.sourceId)))) {
      add('UNSUPPORTED_TOPIC_CONCLUSION', 'WARNING', '本项肯定法律判断缺少覆盖相应争点的有效规范；用户报告须保留缺口并暂不展示该判断，原始分析留存审计。', undefined, findingIndex)
    }
    if (!finding.citations.length) add('UNSOURCED_FINDING', 'WARNING', '本项没有可对应的核验来源，不能据此确认法律适用。', undefined, findingIndex)
    const prose = [globalProse, finding.conclusion, finding.reasoning, ...finding.citations.map(c => c.relevance ?? ''),
      ...finding.citations.flatMap(c => c.checks?.map(a => a.reason) ?? [])].join('\n')
    if (/必定胜诉|一定胜诉|保证胜诉/u.test(prose)) add('UNSUPPORTED_CERTAINTY', 'ERROR', '初步分析不能保证胜诉。', undefined, findingIndex)
    for (const c of finding.citations) {
      const source = byId.get(c.sourceId)
      if (!source) { add('UNKNOWN_CITATION', 'ERROR', '引用来源不在本次核验结果中。', c.sourceId, findingIndex); continue }
      if (!source.content.includes(c.quote)) { add('INEXACT_CITATION', 'ERROR', '引文与核验原文不一致。', c.sourceId, findingIndex); continue }
      if (!source.authority) { add('REFERENCE_ONLY', 'WARNING', '公开参考不能代替已确认效力的法律规范。', c.sourceId, findingIndex); continue }
      const document = source.authority.document
      const context = input.documentContexts?.find(d => d.documentId === document.id && d.documentContentHash === document.contentHash)
      const texts = preliminaryCheckTexts(source, input.documentContexts)
      const checks = c.checks ?? []
      const bindings = checks.map(a => texts.map(text => ({ text, units: boundUnits(text, a.quote) })).find(b => b.units.length))
      const scopeArticles = context?.articles.filter(a => scope.test(a.text) && !temporalScope.test(a.text)) ?? []
      if (scopeArticles.some(a => !checks.some((check, index) => bindings[index]?.text === a.text
        && (check.assessment === 'BASED_ON_STATEMENT' || check.assessment === 'NOT_APPLICABLE' && scopeException.test(a.text))
        && check.factIds.length))) {
        add('DOCUMENT_SCOPE_TO_VERIFY', 'WARNING', `系统尚未完成适用范围对应分析：${scopeArticles.map(a => a.text).join(' ')} 未记录分析不等于用户未提供相关事实；该依据暂作附条件分析。`, c.sourceId, findingIndex)
      } else if (!scopeArticles.length && document.documentType === 'ADMINISTRATIVE_REGULATION') {
        add('DOCUMENT_SCOPE_NOT_CHECKED', 'WARNING', '尚未取得该法规总则中的适用范围，不能默认适用于本案；须先核对地域、对象及事项限制。', c.sourceId, findingIndex)
      }
      // Use stated transaction/event dates, never the consultation clock or an unrelated identity date.
      const datedFacts = input.case.facts.concat(input.case.disputedFacts)
        .filter(f => f.category !== 'PARTY' && (finding.factIds.includes(f.id)
          || /订立|签订|签约|购买|支付|转账|缴纳|交付|租期|到期|届满|交房|返还|退还|停业|扣留|扣减/u.test(f.content)))
        .flatMap(f => [...f.content.matchAll(/(\d{4})[年/-](\d{1,2})[月/-](\d{1,2})(?:日)?/gu)]
          .map(m => `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`))
        .filter(d => { const value = new Date(d + 'T00:00:00.000Z'); return Number.isFinite(value.getTime()) && value.toISOString().slice(0, 10) === d })
      if (!document.effectiveAt || !datedFacts.length || datedFacts.some(d => d < document.effectiveAt!)) {
        add('TEMPORAL_APPLICATION_TO_VERIFY', 'WARNING', `施行时间待核实：该版本${document.effectiveAt ? `自${document.effectiveAt}施行` : '施行日期未确认'}；须核对与本项争议有关的订约、履行及争议行为日期，必要时核对旧法及过渡规则。咨询日期不能代替案件事实日期，也不能据此默认溯及适用。`, c.sourceId, findingIndex)
      }
      if (asserted(prose, /(?:不受|无需核对|不用核对|无须核对)[^。；\n]{0,16}(?:适用范围|施行时间|生效时间)|(?:施行前|生效前)[^。；\n]{0,20}(?:一律|当然|直接)适用/gu)) {
        add('IGNORED_DOCUMENT_APPLICATION_LIMIT', 'ERROR', '分析明确忽略法规的适用范围或施行时间限制。', c.sourceId, findingIndex)
      }
      const units = normativeSourceUnits(source.content), boundaries = preliminaryBoundaries(source.content)
      const offset = source.content.indexOf(c.quote), end = offset + c.quote.length
      const selected = units.map((u, index) => ({ ...u, index })).filter(u => u.start < end && u.end > offset)
      const last = selected.at(-1)?.index ?? -1, next = units[last + 1]
      const relevant = [...selected, ...(next && continuation.test(next.text.trim()) ? [next] : [])]
        .filter(u => boundaries.some(b => b.quote === u.text.trim()))
      if (new Set(checks.map(a => a.quote)).size !== checks.length) {
        add('CONFLICTING_APPLICATION_CHECK', 'ERROR', '同一条适用边界不得重复给出判断。', c.sourceId, findingIndex)
      }
      for (const [index, a] of checks.entries()) {
        const binding = bindings[index]
        if (!binding || !binding.units.some(u => preliminaryBoundaries(binding.text).some(b => b.quote === u.text.trim())
          || scope.test(u.text) || commencement.test(u.text))
          || a.factIds.some(id => !facts.has(id) || !finding.factIds.includes(id))
          || a.assessment === 'BASED_ON_STATEMENT' && !a.factIds.length) {
          add('UNBOUND_APPLICATION_CHECK', 'ERROR', '适用边界说明必须对应本条原文及本项实际案件陈述。', c.sourceId, findingIndex)
        }
        if (binding && binding.text !== source.content && finding.status === 'INFERENCE'
          && !negativeApplication.test(finding.conclusion)
          && (a.assessment === 'NOT_APPLICABLE' && !scopeException.test(a.quote)
            || a.assessment === 'UNRESOLVED' && !qualified.test(finding.conclusion))) {
          add('UNRESOLVED_DOCUMENT_PREMISE', 'ERROR', '同源范围或时间前提不满足或尚未明确，不能直接作肯定适用。', c.sourceId, findingIndex)
        }
      }
      // An ambiguous very short quote cannot select a safe branch. Show the whole article and flag review.
      const ambiguous = source.content.indexOf(c.quote, offset + 1) >= 0
      if (ambiguous || normalizedRuleText(c.quote).length < 8 || /[：:]\s*$/u.test(c.quote)) {
        add('UNINFORMATIVE_EXCERPT', 'WARNING', '原选引文过短或仅为引导语，正文已展示完整条文；具体关联仍需核对。', c.sourceId, findingIndex)
      }
      for (const u of relevant) {
        const quote = u.text.trim(), matching = checks.filter((_, index) => bindings[index]?.text === source.content
          && bindings[index]!.units.some(b => b.start === u.start && b.end === u.end))
        const note = matching[0]
        if (matching.length > 1) add('CONFLICTING_APPLICATION_CHECK', 'ERROR', '同一规范句被重叠或冲突的适用说明覆盖。', c.sourceId, findingIndex)
        const covered = normalizedRuleText(c.quote).includes(normalizedRuleText(quote))
        if (!ambiguous && !covered && !note) {
          add('OMITTED_SOURCE_BOUNDARY', 'ERROR', '引文遗漏相连的适用前提、例外或责任限制，且分析未对该原文说明。', c.sourceId, findingIndex)
        } else if (!note) {
          add('APPLICATION_NOT_ASSESSED', 'WARNING', '条文的适用边界尚未逐项对应本案；完整原文保留供核对。', c.sourceId, findingIndex)
        } else if (note.assessment === 'NOT_APPLICABLE' && finding.status === 'INFERENCE'
          && preliminaryBoundaries(quote)[0]?.kind !== 'EXCEPTION' && !negativeApplication.test(finding.conclusion)) {
          // No ALL/ANY inference here: an independent alternative path must not become a new hard gate.
          const otherPath = preliminaryBoundaries(quote)[0]?.kind === 'PRECONDITION'
            && relevant.some(other => other !== u && checks.some((a, index) => bindings[index]?.text === source.content
              && bindings[index]!.units.some(b => b.start === other.start) && a.assessment === 'BASED_ON_STATEMENT'))
          add('INAPPLICABLE_PREMISE', otherPath ? 'WARNING' : 'ERROR',
            '有适用前提不符合本案；结论只能依赖另行说明适用的路径，不能将该前提当成成立。', c.sourceId, findingIndex)
        } else if (note.assessment === 'UNRESOLVED') {
          add('UNRESOLVED_PREMISE', finding.status === 'INFERENCE' && !qualified.test(finding.conclusion) ? 'ERROR' : 'WARNING',
            '关键适用前提尚未核实，结论须保留该条件，不能当作已经成立。', c.sourceId, findingIndex)
        }
      }
      const unconditional = prose.split(/[。；\n]/u).some(s => /无论|不论|一律|任何情况下/u.test(s)
        && /应当|必须|有权|无需|不必|免除|不承担|可以要求|均应|无效|有效|成立/u.test(s)
        && !/(?:不能|不应|不得|不可|不要|切勿).{0,20}(?:无论|不论|一律|任何情况下)/u.test(s))
      if (relevant.length && unconditional && !/无论|不论|一律|任何情况下/u.test(source.content)) {
        add('UNSUPPORTED_SCOPE_EXPANSION', 'ERROR', '分析把有适用条件的条文扩大为无条件规则。', c.sourceId, findingIndex)
      }
      // A newly added alternative may be a synonym or an unsupported extension. Do not certify it either way.
      for (const alternative of prose.matchAll(/(?:是|系|属于|为)([^，,。；;\n]{1,80}(?:或者|或)[^，,。；;\n]{1,40})/gu)) {
        const branches = alternative[1].split(/或者|或/u).map(s => s.trim()).filter(Boolean)
        if (branches.some(b => source.content.includes(b)) && branches.some(b => !source.content.includes(b))) {
          add('UNVERIFIED_ALTERNATIVE', 'WARNING', '分析加入了未见于本条原文的并列情形，不能仅凭该条确认相同法律效果。', c.sourceId, findingIndex)
        }
      }
    }
  })
  const variationSources = sources.filter(s => s.authority && /申请展期|协商一致.{0,12}变更合同|合同变更的内容/u.test(s.content))
  for (const [findingIndex, finding] of input.analysis.findings.entries()) {
    if (/展期|(?:期限|还款时间|履行时间)[^。；\n]{0,40}变更|变更[^。；\n]{0,40}(?:期限|还款时间|履行时间)/u.test(`${finding.conclusion}\n${finding.reasoning}`)
      && variationSources.length && !finding.citations.some(c => variationSources.some(s => s.providerSourceId === c.sourceId))) {
      add('UNASSESSED_VARIATION_REASONING', 'WARNING', '期限变化的判断尚未对应已取得的变更或展期规范；须分别核对适用时点、双方合意与变更内容，仅凭原履行期限义务不足以确认变更结果。', variationSources[0].providerSourceId, findingIndex)
    }
  }
  // Read every delivered section and supplied limitation, including when the model omitted its citation.
  for (const source of sources.filter(s => s.authority)) {
    for (const match of source.content.matchAll(/([^\s，,。；;\n]{1,12})(?:仍应|仍须|仍需|仍由|继续承担|始终承担)[^。；\n]{0,100}(?:举证责任|证明责任)/gu)) {
      const subject = match[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      if (asserted(allProse, new RegExp(`${subject}(?:完全|一律|均)?(?:不再|无需|不必|不需|免于)[^。；\\n]{0,25}(?:举证|证明)`, 'gu'))
        || asserted(allProse, /(?:全部|所有)(?:的)?(?:举证|证明)责任.{0,12}(?:转移|转由)|承担全部(?:举证|证明)责任/gu)) {
        add('CONTRADICTED_BURDEN_LIMIT', 'ERROR', '分析免除或全部转移了原文仍保留的举证责任。', source.providerSourceId)
      } else if (!input.analysis.findings.some(f => f.citations.some(c => c.sourceId === source.providerSourceId))
        && /举证|证明责任|提供[^。；\n]{0,12}证据/u.test(allProse)) {
        add('UNASSESSED_BURDEN_REASONING', 'WARNING', '涉及分阶段举证的表述尚未逐项对应触发前提、抗辩证据及继续举证义务，不能把不同抗辩作同等处理；未上传材料也不代表现实中没有证据。', source.providerSourceId)
      }
    }
  }
  return preliminaryQualitySchema.parse({ version: 1, scope: 'LOCAL_SOURCE_BOUNDARY_CHECKS',
    status: issues.some(i => i.severity === 'ERROR') ? 'BLOCKED' : issues.length ? 'REVIEW_REQUIRED' : 'CHECKED',
    legalCorrectness: 'NOT_INDEPENDENTLY_VERIFIED', issues })
}

export class PreliminaryQualityError extends Error {
  readonly statusCode = 422
  constructor(readonly quality: PreliminaryQuality) {
    super(`初步报告质量校验未通过：${quality.issues.find(i => i.severity === 'ERROR')?.message ?? '需复核适用边界'}；未发布新报告，原报告保留。`)
  }
}
