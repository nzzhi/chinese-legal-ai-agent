import { disputeAnchors, legalRelationshipAnchors } from '../legalQuery/fallbackGrounding.js'

type ConceptGroup = { terms: string[]; weight: number }
type AuthorityIntent = { role: 'PROCEDURE' | 'EVIDENCE' | 'LIMITATION' | 'CONTRACT_VARIATION'; groups: ConceptGroup[] }
const group = (weight: number, ...terms: string[]): ConceptGroup => ({ weight, terms })
const normalize = (text: string) => text.normalize('NFKC').replace(/\s/gu, '').toLowerCase()

/** Small cross-case vocabulary of legal tasks, not article numbers or platform-specific queries.
 * Query expansion is for retrieval only; it never creates a Rule or asserts legal applicability.
 * ponytail: bounded vocabulary for observed tasks; unmatched tasks retain lexical retrieval.
 */
export function authorityIntent(query: string, question?: string): AuthorityIntent | undefined {
  const text = normalize(query + ' ' + (question ?? ''))
  if (/起诉.{0,12}(条件|满足|符合)|起诉需要|起诉能否受理/.test(text)) return { role: 'PROCEDURE', groups: [
    group(3, '起诉'), group(2, '条件', '符合'), group(1, '原告'), group(1, '被告'),
    group(2, '诉讼请求'), group(1, '管辖', '受理'),
  ] }
  if (/电子数据|即时通信|通讯群组|聊天记录|通信记录|电子邮件|手机短信|电子交易记录/.test(text)) {
    const quality = /真实性|完整性|可靠性|原始|原件|载体|证明条件|满足.{0,12}条件|条件.{0,8}(证据|证明|使用)/.test(text)
    return { role: 'EVIDENCE', groups: quality ? [
      group(2, '电子数据'), group(3, '真实性', '完整性', '可靠性'), group(3, '原始载体', '原件', '原始存储介质'),
      group(1, '生成', '存储', '传输', '提取'), group(1, '提供', '保存', '审查', '判断', '确认'),
    ] : [
      group(2, '电子数据'), group(3, '即时通信', '通讯群组', '手机短信', '电子邮件', '通信信息'),
      group(1, '用户注册', '身份认证', '电子交易记录', '通信记录', '登录日志'),
      group(1, '数字化', '电子文件'), group(2, '证据包括', '包括下列'),
    ] }
  }
  if (/(?:转账|汇款|支付凭证).{0,20}(?:证明|证据|举证)|(?:证明|证据|举证).{0,20}(?:转账|汇款|支付凭证)/.test(text)) return { role: 'EVIDENCE', groups: [
    group(2, '原告', '被告', '当事人', '借款人', '出借人'),
    group(4, '举证责任', '证明责任', '提供证据', '证明'),
    group(3, '仅依据', '抗辩', '相应证据', '主张'),
    group(4, '转账凭证', '金融机构', '银行转账', '网上电子汇款'),
  ] }
  if (/(?:合同|约定|期限)/.test(text) && /变更|展期|延期|改期|续期/.test(text)) return { role: 'CONTRACT_VARIATION', groups: [
    group(3, '合同', '约定', '还款期限'), group(4, '变更', '展期', '延期'),
    group(3, '协商一致', '同意', '合意'), group(2, '不明确', '推定', '明确'),
  ] }
  if (/诉讼时效|时效期间/.test(text)) {
    const operation = ['中断', '中止', '届满', '延长'].find(term => text.includes(term))
    return { role: 'LIMITATION', groups: [group(3, '诉讼时效'), ...(operation ? [group(4, operation)] : [
      group(3, '期间', '三年'), group(2, '权利受到损害', '知道', '义务人'), group(2, '计算', '之日起'),
    ])] }
  }
}

export const authorityExpansion = (query: string, question?: string) => [
  ...authorityIntent(query, question)?.groups.flatMap(g => g.terms) ?? [],
  ...retrievalTaskRelevance(query, question).primaryTask === 'LOAN_REPAYMENT'
    ? ['借款期限', '还款期限', '贷款人', '展期', '同意'] : [],
]

export function authorityConceptMatch(text: string, query: string, question?: string) {
  const intent = authorityIntent(query, question), body = normalize(text)
  const groups = intent?.groups.map(g => ({ ...g, matched: g.terms.filter(term => body.includes(term)) })) ?? []
  const total = groups.reduce((sum, g) => sum + g.weight, 0)
  const coverage = groups.reduce((sum, g) => sum + g.weight * Math.min(1, g.matched.length / Math.min(2, g.terms.length)), 0) / Math.max(1, total)
  // A legal subject must occur in the article itself together with another independent concept.
  const sufficient = !!groups[0]?.matched.length && groups.filter(g => g.matched.length).length >= 2
  return { intent, coverage, sufficient, matchedConcepts: groups.flatMap(g => g.matched) }
}

/** Retrieval-only task layers. Evidence in the facts must not replace the query's substantive task.
 * Source verification still recomputes the shared concept match; neither layer asserts applicability.
 * ponytail: extend task layers only when independent probes expose missing coverage.
 */
export function retrievalTaskRelevance(query: string, question?: string) {
  const primary = normalize(query), context = normalize(query + ' ' + (question ?? ''))
  const loan = /借款|借贷|出借/.test(context)
  // Reuse the existing defendant-identification expressions; also cover request-party paraphrases.
  const party = /明确.{0,6}被告|确定.{0,6}被告|起诉谁|起诉对象|被告主体.{0,8}(确定|明确)|谁.{0,6}作为被告|确定.{0,6}诉讼对象|(?:请求对象|当事人).{0,8}(?:确定|明确)|(?:确定|明确).{0,8}(?:请求对象|当事人)/.test(primary)
  const formation = /(?:借款|借贷).{0,8}(?:成立|合意)|(?:成立|合意).{0,8}(?:借款|借贷)/.test(primary)
  const repayment = /(?:借款|借贷).{0,12}(?:返还|偿还|还款)|(?:返还|偿还|还款).{0,12}(?:借款|借贷)/.test(primary)
  const variation = authorityIntent(query)?.role === 'CONTRACT_VARIATION'
  const primaryTask = party ? 'PARTY_IDENTIFICATION' as const : variation ? 'CONTRACT_VARIATION' as const : formation ? 'LOAN_FORMATION' as const
    : repayment ? 'LOAN_REPAYMENT' as const : authorityIntent(query, question)?.role ?? 'LEXICAL' as const
  return { substantiveDomains: loan ? ['LOAN'] : [], evidence: /电子数据|微信|转账记录|聊天记录|即时通信|电子邮件|证据/.test(context),
    procedureIntents: party ? ['PARTY_IDENTIFICATION'] : [], primaryTask }
}

export function retrievalTaskMatch(text: string, query: string, question?: string) {
  const task = retrievalTaskRelevance(query, question), body = normalize(text)
  const groups = task.primaryTask === 'PARTY_IDENTIFICATION' ? [
    group(3, '被告'), group(3, '明确', '确定', '识别', '姓名', '名称', '住所'),
    group(2, '起诉', '起诉状', '诉讼'), group(1, '原告', '当事人', '身份'),
  ] : task.primaryTask === 'LOAN_FORMATION' ? [
    group(3, '借款合同', '借贷关系', '借贷法律关系', '借款关系'),
    group(4, '成立', '合意', '提供借款', '款项交付', '资金到达', '收到借款', '借贷事实', '借贷行为', '借贷法律关系存在'),
    group(2, '自然人', '借款人', '贷款人', '出借人'), group(1, '证明', '约定', '口头', '书面'),
  ] : task.primaryTask === 'LOAN_REPAYMENT' ? [
    group(3, '借款人', '贷款人', '出借人', '借款期限', '借款合同', '借贷双方'),
    group(4, '返还', '偿还', '还款'), group(3, '期限', '约定', '催告', '提前', '展期'),
    group(2, '应当', '可以', '请求'),
  ] : []
  const matched = groups.map(g => ({ ...g, matched: g.terms.filter(term => body.includes(term)) }))
  const coverage = matched.reduce((sum, g) => sum + (g.matched.length ? g.weight : 0), 0)
    / Math.max(1, groups.reduce((sum, g) => sum + g.weight, 0))
  const sufficient = task.primaryTask === 'PARTY_IDENTIFICATION'
    ? /明确.{0,6}被告|被告.{0,6}(?:姓名|名称|住所|身份)/.test(body) && !!matched[2]?.matched.length
    // A loan subject plus generic 约定/应当 is background, not the queried legal task.
    : !!matched[0]?.matched.length && !!matched[1]?.matched.length
  const directObligation = task.primaryTask === 'LOAN_REPAYMENT'
    && /(?:借款人|贷款人|出借人)[^。；]{0,16}(?:应当|可以|有权|催告)[^。；]{0,20}(?:返还|偿还|还款(?!期限|方式|条件|日期|时间))/.test(body)
  return { task, layered: groups.length > 0, coverage, sufficient, directObligation,
    matchedConcepts: matched.flatMap(g => g.matched) }
}

const genericTerms = new Set(['证据', '条件', '请求', '当事人', '法院', '人民法院', '纠纷', '规定', '记录', '借款', '合同', '个人', '事实', '期限', '双方', '责任'])

/** Bounded BM25 is a tie signal, not an unbounded substitute for question-owned concepts. */
export function rankAuthorityArticle(input: {
  body: string; heading: string; title: string; documentType?: string; query: string; question?: string;
  taskQuery?: string; lexicalTerms: string[]; ftsScore: number
}) {
  const body = normalize(input.body), heading = normalize(input.heading), title = normalize(input.title)
  const concept = authorityConceptMatch(body, input.query, input.question)
  const headingMatch = authorityConceptMatch(heading, input.query, input.question)
  const domain = legalRelationshipAnchors(input.question ?? input.query).some(term => body.includes(term) || heading.includes(term))
  const operation = disputeAnchors(input.question ?? input.query, 'CONTRACT_PERFORMANCE').some(term => body.includes(term))
  const taskMatch = retrievalTaskMatch(body, input.taskQuery ?? input.query, input.question)
  const terms = [...new Set([...input.lexicalTerms, ...taskMatch.task.primaryTask === 'LOAN_REPAYMENT'
    ? authorityExpansion(input.query, input.question) : []])]
  const distinctive = terms.filter(term => body.includes(term)).reduce((sum, term) => sum + (genericTerms.has(term) ? 0.15 : 1), 0)
  const role = concept.intent?.role === 'PROCEDURE' ? Number(title.includes('民事诉讼'))
    : concept.intent?.role === 'EVIDENCE' ? title.includes('证据') ? 1 : heading.includes('证据') ? 0.5 : 0
      : concept.intent?.role === 'LIMITATION' ? Number(heading.includes('诉讼时效'))
        : concept.intent?.role === 'CONTRACT_VARIATION' ? Number(/合同.{0,6}变更/.test(heading)) : 0
  const components = { concept: concept.coverage * 12, heading: headingMatch.coverage * 3, documentRole: role * 2,
    jointMatch: concept.sufficient ? 4 : 0, distinctive: distinctive / (1 + distinctive) * 2,
    relationship: Number(domain) * (concept.intent ? 0.25 : 2), operation: Number(operation) * (concept.intent ? 0.25 : 2),
    fts: Math.max(0, -input.ftsScore) / (1 + Math.abs(input.ftsScore)), authorityType: 0 }
  if (taskMatch.layered) {
    const ownHeading = retrievalTaskMatch(heading, input.taskQuery ?? input.query, input.question)
    components.concept = taskMatch.coverage * 12
    components.heading = ownHeading.coverage * 3
    components.documentRole = (taskMatch.task.primaryTask === 'PARTY_IDENTIFICATION'
      ? Number(title.includes('民事诉讼')) : Number(/民法典|借贷/.test(title))) * 2
    components.jointMatch = taskMatch.sufficient ? 4 : 0
    components.relationship = Number(domain) * 0.25
    components.operation = taskMatch.directObligation ? 4 : 0
    components.authorityType = taskMatch.sufficient && (taskMatch.task.primaryTask === 'PARTY_IDENTIFICATION'
      ? input.documentType === 'STATUTE' : ['STATUTE', 'JUDICIAL_INTERPRETATION'].includes(input.documentType ?? '')) ? 1 : 0
  }
  return { score: Object.values(components).reduce((sum, value) => sum + value, 0),
    components, role: taskMatch.layered ? taskMatch.task.primaryTask : concept.intent?.role,
    matchedConcepts: taskMatch.layered ? taskMatch.matchedConcepts : concept.matchedConcepts, taskMatch }
}
