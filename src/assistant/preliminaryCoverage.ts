import { authorityArticleRelevance } from '../authority/authorityCorpus.js'
import { authorityConceptMatch, retrievalTaskMatch } from '../authority/authorityConcepts.js'
import { legalRelationshipAnchors } from '../legalQuery/fallbackGrounding.js'
import type { PreliminaryResult } from './preliminaryWorkflow.js'

const normalize = (s: string) => s.normalize('NFKC').replace(/\s/gu, '').toLowerCase()
const generic = new Set(['法律', '规定', '依据', '责任', '合同', '当事人', '双方', '事实', '条件', '请求'])

/** Conservative topic coverage, never certification of legal applicability or exhaustive research.
 * ponytail: exact planned keywords can miss synonyms; retain the gap rather than certify them.
 */
export function preliminaryCoverage(input: Pick<PreliminaryResult, 'plan' | 'retrievals'>) {
  return input.plan.searches.flatMap((topic, i) => {
    if (topic.sourcePurpose === 'REFERENCE') return []
    const questionId = `preliminary-${i + 1}`
    const keywords = [...new Set(topic.keywords.map(normalize).filter(k => k.length > 1 && !generic.has(k)))]
    const domains = legalRelationshipAnchors(topic.query)
    const sources = input.retrievals.filter(t => t.query.legalQuestionId === questionId && t.query.sourcePurpose !== 'REFERENCE')
      .flatMap(t => t.verifications.flatMap(v => v.status === 'VERIFIED' && v.verifiedSource?.authority
        && v.verifiedSource.legalStatus === 'EFFECTIVE' ? [v.verifiedSource] : []))
    const candidates = sources.map(s => {
      const body = normalize(s.content), missing = keywords.filter(k => !body.includes(k))
      const relevant = authorityArticleRelevance(s.content, topic.query, topic.query, topic.query).relevanceSufficient
      const task = retrievalTaskMatch(s.content, topic.query, topic.query)
      const concept = authorityConceptMatch(s.content, topic.query, topic.query)
      const matched = relevant && (task.layered ? task.sufficient : concept.intent ? concept.sufficient : true)
        && (!domains.length || domains.some(d => body.includes(normalize(d))))
      return { id: s.providerSourceId, missing, matched }
    })
    // One rule must cover the planned concepts together: scattered generic hits are not a specialist rule.
    const sourceIds = [...new Set(candidates.filter(c => c.matched && !c.missing.length && keywords.length).map(c => c.id))]
    const closest = candidates.filter(c => c.matched).sort((a, b) => a.missing.length - b.missing.length)[0]
    const missingKeywords = sourceIds.length ? [] : closest?.missing.length ? closest.missing : keywords
    return [{ questionId, query: topic.query, reason: topic.reason, sourceIds,
      status: sourceIds.length ? 'COVERED' as const : 'INSUFFICIENT' as const, missingKeywords,
      supplementQuery: [...new Set([...domains, ...missingKeywords])].join(' ') || topic.query }]
  })
}
