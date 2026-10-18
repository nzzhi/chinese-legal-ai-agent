import type { Case } from '../case/caseSchema.js'
import type { ModelClient } from '../llm/modelClient.js'
import type { ModelRouter } from '../llm/modelRouter.js'
import { parseModelJson } from '../llm/modelJson.js'
import { ClassificationError, assertNoLegalCitation } from './classificationError.js'
import { buildDisputeAnalysisMessages } from './classificationPrompt.js'
import {
  disputeAnalysisSchema,
  type DisputedFactAnalysis,
  type DisputeAnalysisResult,
  type Issue,
} from './classificationSchema.js'

export interface DisputeIdentifier {
  analyze(caseInput: Case): Promise<DisputeAnalysisResult>
}

export class ModelDisputeIdentifier implements DisputeIdentifier {
  constructor(
    private readonly modelClient: ModelClient,
    private readonly modelRouter: ModelRouter,
  ) {}

  async analyze(caseInput: Case): Promise<DisputeAnalysisResult> {
    const response = await this.modelClient.chat({
      model: this.modelRouter.getModel('FLASH'),
      messages: buildDisputeAnalysisMessages(caseInput),
      temperature: 0,
    })

    let parsed: unknown
    try {
      parsed = parseModelJson(response.text)
    } catch (error) {
      throw new ClassificationError('INVALID_RESPONSE', 'Dispute analysis model returned invalid JSON', {
        cause: error,
      })
    }

    const result = disputeAnalysisSchema.safeParse(parsed)
    if (!result.success) {
      throw new ClassificationError('INVALID_RESPONSE', 'Dispute analysis failed schema validation', {
        cause: result.error,
      })
    }

    const knownIds = collectKnownFactIds(caseInput)
    const disputedFacts = result.data.disputedFacts.map((dispute) => normalizeDispute(dispute, knownIds))
    const issues = result.data.issues.map((issue) => normalizeIssue(issue, knownIds))

    for (const issue of issues) {
      assertNoLegalCitation(issue.question, 'issue.question')
    }

    return { caseId: caseInput.id, disputedFacts, issues }
  }
}

const unknownPositionSentinels = new Set([
  'UNKNOWN',
  'UNSPECIFIED',
  'UNDEFINED',
  'N/A',
  'NA',
  '未知',
  '不清楚',
  '不确定',
  '未提供',
])

function normalizePosition(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined
  }

  const trimmed = value.trim()
  if (!trimmed || unknownPositionSentinels.has(trimmed.toUpperCase())) {
    return undefined
  }

  return trimmed
}

export function collectKnownFactIds(caseInput: Case): Set<string> {
  return new Set([
    ...caseInput.facts.map((fact) => fact.id),
    ...caseInput.disputedFacts.map((fact) => fact.id),
  ])
}

export function filterKnownFactReferences(ids: readonly string[], knownIds: ReadonlySet<string>): string[] {
  const seen = new Set<string>()
  const references: string[] = []

  for (const id of ids) {
    if (!knownIds.has(id) || seen.has(id)) {
      continue
    }
    seen.add(id)
    references.push(id)
  }

  return references
}

function normalizeDispute(dispute: DisputedFactAnalysis, knownIds: ReadonlySet<string>): DisputedFactAnalysis {
  const normalized: DisputedFactAnalysis = {
    id: dispute.id,
    topic: dispute.topic,
    relatedFactIds: filterKnownFactReferences(dispute.relatedFactIds, knownIds),
  }

  const userPosition = normalizePosition(dispute.userPosition)
  if (userPosition !== undefined) {
    normalized.userPosition = userPosition
  }

  const opposingPosition = normalizePosition(dispute.opposingPosition)
  if (opposingPosition !== undefined) {
    normalized.opposingPosition = opposingPosition
  }

  return normalized
}

function normalizeIssue(issue: Issue, knownIds: ReadonlySet<string>): Issue {
  return {
    id: issue.id,
    question: issue.question,
    importance: issue.importance,
    relatedFactIds: filterKnownFactReferences(issue.relatedFactIds, knownIds),
  }
}
