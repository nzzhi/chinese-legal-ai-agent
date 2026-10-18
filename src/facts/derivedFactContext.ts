import type { Case, Event, Fact } from '../case/caseSchema.js'

export type ContextSource = Readonly<{ kind: 'FACT' | 'EVENT'; id: string }>
export type DerivedValue<T> = Readonly<{ value: T; source: ContextSource }>
type DemandAction = 'PRESENT' | 'ABSENT'
type DemandDirection = 'USER_TO_COUNTERPARTY' | 'COUNTERPARTY_TO_USER' | 'OTHER_ACTOR'
type DemandObject = 'CURRENT_DEBT' | 'OTHER_DEBT'
export type DemandSlot<T extends string> = Readonly<{
  value: T | 'UNKNOWN' | 'CONFLICT'
  evidence: readonly DerivedValue<T | 'UNKNOWN'>[]
}>
export type RepaymentDemandContext = Readonly<{
  asserted: DerivedValue<boolean>
  action: DemandSlot<DemandAction>
  direction: DemandSlot<DemandDirection>
  object: DemandSlot<DemandObject>
}>
type ContextDiagnostic = Readonly<{
  code: 'UNKNOWN_RELATED_FACT_ID' | 'DUPLICATE_RELATED_FACT_ID' | 'DUPLICATE_EVENT_ID'
  source: ContextSource
  relatedFactId?: string
}>
export type DerivedEventContext = Readonly<{
  event: Readonly<Omit<Event, 'relatedFactIds'>> & { readonly relatedFactIds: readonly string[] }
  description: DerivedValue<string>
  normalizedText: DerivedValue<string>
  amounts: readonly DerivedValue<number>[]
  diagnostics: readonly ContextDiagnostic[]
}>
export type DerivedFactContext = Readonly<{
  factId: string
  fact: Readonly<Fact>
  normalizedText: DerivedValue<string>
  amounts: readonly DerivedValue<number>[]
  relatedEvents: readonly DerivedEventContext[]
  repaymentDemand: RepaymentDemandContext
  missing: readonly ('FACT_AMOUNT' | 'RELATED_EVENT' | 'EVENT_AMOUNT')[]
  conflicts: readonly Readonly<{ code: 'DIFFERING_AMOUNTS'; values: readonly DerivedValue<number>[] }>[]
  diagnostics: readonly ContextDiagnostic[]
}>

// F3's character/amount rules, unchanged. This is not semantic normalization.
export const normalizeFactText = (value: string) => value.normalize('NFKC').replace(/\s+/gu, '').replace(/(?<=\d)[,，](?=\d)/gu, '')
export const extractFactAmounts = (value: string) => [...normalizeFactText(value).matchAll(/(\d+(?:\.\d+)?)(万?元)/gu)]
  .map(m => Number(m[1]) * (m[2] === '万元' ? 10_000 : 1))

const derived = <T>(value: T, source: ContextSource): DerivedValue<T> => Object.freeze({ value, source })
const sourcedAmounts = (value: string, source: ContextSource) => Object.freeze(extractFactAmounts(value).map(amount => derived(amount, source)))

// Only REPAYMENT_DEMAND semantics. Other selectors retain their original lexical rules.
const actor = '(?:用户|出借人|贷款人|本人)(?:主张|陈述|称|表示)?(?:其)?'
const recipient = '(?:一个|该)?(?:朋友|对方|借款人)'
const actorContext = '(?:(?!朋友|对方|借款人|[。；]).){0,12}'
const demandAction = '(?:催(?:款|收|讨|债|(?:过|了)?[^。；]{0,12}(?:款|还钱|偿还|归还))|(?:要求|请求|敦促|提醒|通知)[^。；]{0,12}(?:还款|还钱|偿还|归还|返还))'
const actionPattern = new RegExp(demandAction, 'u')
const communication = '(?:联系|联络|沟通|催(?:过|了)?(?:很多次|多次|几次))'
const communicationPattern = new RegExp(`${demandAction}|${communication}`, 'u')
const byUser = new RegExp(`${actor}${actorContext}(?:(?:向|给|对)${recipient})?${actorContext}(?:${demandAction}|${communication})`, 'u')
const otherActor = new RegExp(`^(?:${actor})?${recipient}[^。；]{0,24}(?:${demandAction}|${communication})`, 'u')
const toUser = new RegExp(`${recipient}[^。；]{0,12}(?:用户|出借人|贷款人|本人|我)`, 'u')
const notAsserted = /是否|可能|如果|希望|打算|准备|计划|不详|不清楚|未提供/u
const requestedHelp = /请求(?:系统|帮助|帮忙)|请(?:帮|协助)|想(?:要)?[^。；]{0,8}(?:催|联系)/u
const futureDemand = new RegExp(`(?:明天|将要|将会|以后)[^。；]{0,12}(?:${demandAction}|${communication})`, 'u')
const negated = /(?:从未|未曾|没有|从没|不曾|未|没|不再|停止|否认)[^。；，]{0,12}(?:催|要求|请求|敦促|提醒|通知|联系|联络|沟通)/u
const otherDebt = /无关|(?:另一|其他|另外)[^。；]{0,8}(?:借款|债|款)|货款|房租|工资|物业费|信用卡|(?:代|替)(?:他人|朋友|公司)/u
const currentDebt = /借款|借贷|借给|所借|还款|还钱|这笔债|该笔债|催(?:过|了|讨)?[^。；]{0,12}款/u
const explicitCurrentDebt = /(?:本案|这笔|该笔)[^。；]{0,8}(?:借款|债务|债|款)/u

function demandSlot<T extends string>(evidence: readonly DerivedValue<T | 'UNKNOWN'>[]): DemandSlot<T> {
  const values = new Set(evidence.map(e => e.value).filter(value => value !== 'UNKNOWN'))
  return Object.freeze({ value: values.size > 1 ? 'CONFLICT' : values.values().next().value ?? 'UNKNOWN',
    evidence: Object.freeze([...evidence]) })
}
function sourcedSlot<T extends string>(values: T[], source: ContextSource): DemandSlot<T> {
  const observations: Array<T | 'UNKNOWN'> = values.length ? values : ['UNKNOWN']
  return demandSlot<T>(observations.map(value => derived(value, source)))
}

function readDemand(text: string, source: ContextSource) {
  const actions: DemandAction[] = [], directions: DemandDirection[] = []
  const clauses = text.split(/[。；;，,！？!?]/u).filter(Boolean)
  let demandClauses = 0
  for (const clause of clauses) {
    if (!communicationPattern.test(clause) && !negated.test(clause)) continue
    if (actionPattern.test(clause) || negated.test(clause)) {
      demandClauses++
      actions.push(negated.test(clause) ? 'ABSENT' : 'PRESENT')
    }
    // Determine the leading speaker before matching a nested "用户" substring.
    if (otherActor.test(clause)) directions.push(toUser.test(clause) ? 'COUNTERPARTY_TO_USER' : 'OTHER_ACTOR')
    else if (byUser.test(clause)) directions.push('USER_TO_COUNTERPARTY')
  }
  const objects: DemandObject[] = []
  if (otherDebt.test(text)) {
    objects.push('OTHER_DEBT')
    if (explicitCurrentDebt.test(text)) objects.push('CURRENT_DEBT')
  } else if (currentDebt.test(text)) objects.push('CURRENT_DEBT')
  return { asserted: derived(!notAsserted.test(text) && !futureDemand.test(text) && !requestedHelp.test(text), source),
    communicative: communicationPattern.test(text) || negated.test(text), demandClauses,
    action: sourcedSlot(actions, source), direction: sourcedSlot(directions, source), object: sourcedSlot(objects, source) }
}

function deriveRepaymentDemand(own: ReturnType<typeof readDemand>, events: readonly DerivedEventContext[],
  readings: ReadonlyMap<string, ReturnType<typeof readDemand>>): RepaymentDemandContext {
  const actions = [...own.action.evidence], directions = [...own.direction.evidence], objects = [...own.object.evidence]
  if (own.communicative) for (const event of events) {
    const reading = readDemand(event.normalizedText.value, event.description.source)
    if (!reading.asserted.value) continue
    const communicationIds = [...new Set(event.event.relatedFactIds)].filter(id => readings.get(id)?.communicative)
    // A missing action belongs only to the sole communication Fact of a single demand event.
    // Existing explicit Fact actions can use linked debt context, but never overwrite conflicting slots.
    const attributable = own.action.value !== 'UNKNOWN' && own.direction.value !== 'UNKNOWN'
      || communicationIds.length === 1 && reading.demandClauses === 1
    if (!attributable) continue
    // Multiple demand clauses may expose contradictions, but cannot fill a missing slot.
    const canSupplement = reading.demandClauses <= 1
    if ((canSupplement || own.action.value !== 'UNKNOWN')
      && (own.action.value !== 'UNKNOWN' || reading.direction.value !== 'UNKNOWN'
        || reading.action.value === 'ABSENT' || reading.action.value === 'CONFLICT')) {
      actions.push(...reading.action.evidence)
    }
    if (canSupplement || own.direction.value !== 'UNKNOWN') directions.push(...reading.direction.evidence)
    if (canSupplement || own.object.value !== 'UNKNOWN') objects.push(...reading.object.evidence)
  }
  return Object.freeze({ asserted: own.asserted, action: demandSlot(actions),
    direction: demandSlot(directions), object: demandSlot(objects) })
}

/** Accepts an already validated Case. No source mutation/freezing, ID repair or inference of edges.
 * Sidecars are read-only snapshots; rebuild after changing the source Case.
 * Event provenance is context only, never verification of a Fact.
 */
export function buildDerivedFactContexts(caseData: Case): Readonly<{
  facts: readonly DerivedFactContext[]
  diagnostics: readonly ContextDiagnostic[]
}> {
  const facts = [...caseData.facts, ...caseData.disputedFacts]
  const eventsByFact = new Map(facts.map(f => [f.id, [] as DerivedEventContext[]]))
  const diagnostics: ContextDiagnostic[] = []
  const eventIds = new Set<string>()
  for (const event of caseData.events) {
    const source: ContextSource = Object.freeze({ kind: 'EVENT', id: event.id })
    const eventDiagnostics: ContextDiagnostic[] = []
    if (eventIds.has(event.id)) eventDiagnostics.push(Object.freeze({ code: 'DUPLICATE_EVENT_ID', source }))
    eventIds.add(event.id)
    const relatedIds = new Set<string>()
    for (const id of event.relatedFactIds) {
      if (relatedIds.has(id)) eventDiagnostics.push(Object.freeze({ code: 'DUPLICATE_RELATED_FACT_ID', source, relatedFactId: id }))
      else if (!eventsByFact.has(id)) eventDiagnostics.push(Object.freeze({ code: 'UNKNOWN_RELATED_FACT_ID', source, relatedFactId: id }))
      relatedIds.add(id)
    }
    const context: DerivedEventContext = Object.freeze({ event,
      description: derived(event.description, source), normalizedText: derived(normalizeFactText(event.description), source),
      amounts: sourcedAmounts(event.description, source), diagnostics: Object.freeze(eventDiagnostics) })
    diagnostics.push(...eventDiagnostics)
    // Original events.filter/includes consumed each event once per Fact, even with duplicate edges.
    // Distinct event objects with duplicate IDs must remain distinct for behavior preservation.
    for (const id of relatedIds) eventsByFact.get(id)?.push(context)
  }
  const demandReadings = new Map(facts.map(fact => [fact.id,
    readDemand(normalizeFactText(fact.content), Object.freeze({ kind: 'FACT', id: fact.id }))]))
  return Object.freeze({ diagnostics: Object.freeze(diagnostics), facts: Object.freeze(facts.map(fact => {
    const source: ContextSource = Object.freeze({ kind: 'FACT', id: fact.id })
    const amounts = sourcedAmounts(fact.content, source)
    const relatedEvents = Object.freeze(eventsByFact.get(fact.id)!)
    const eventAmounts = relatedEvents.flatMap(e => e.amounts)
    const values = Object.freeze([...amounts, ...eventAmounts])
    const missing: DerivedFactContext['missing'][number][] = []
    if (!amounts.length) missing.push('FACT_AMOUNT')
    if (!relatedEvents.length) missing.push('RELATED_EVENT')
    else if (!eventAmounts.length) missing.push('EVENT_AMOUNT')
    return Object.freeze({ factId: fact.id, fact, normalizedText: derived(normalizeFactText(fact.content), source),
      amounts, relatedEvents, repaymentDemand: deriveRepaymentDemand(demandReadings.get(fact.id)!, relatedEvents, demandReadings),
      missing: Object.freeze(missing),
      conflicts: Object.freeze(new Set(values.map(v => v.value)).size > 1
        ? [Object.freeze({ code: 'DIFFERING_AMOUNTS' as const, values })] : []),
      diagnostics: Object.freeze(relatedEvents.flatMap(e => e.diagnostics)) })
  })) })
}
