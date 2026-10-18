import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ModelClientError, OpenAICompatibleModelClient } from '../src/llm/modelClient.js'
import { safeFailureDiagnostic } from '../src/integration/failureDiagnostic.js'

const config = { apiKey: 'PRIVATE_KEY', baseURL: 'https://offline.test' }
const request = { model: 'offline', messages: [{ role: 'user' as const, content: 'PRIVATE_INPUT' }], maxTokens: 16 }
const baseMetadata = {
  choiceCount: 1, messagePresent: true, contentKind: 'STRING' as const, finishReason: 'STOP' as const,
  reasoningContentPresent: false,
}

test('reasoning control is opt-in, serialized exactly, and invalid values fail before HTTP', async () => {
  const bodies: Record<string, unknown>[] = []
  const client = new OpenAICompatibleModelClient(config, { fetch: async (_, init) => {
    bodies.push(JSON.parse(init!.body as string))
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'OK' } }] })
  } })
  await client.chat(request)
  await client.chat({ ...request, reasoningEffort: 'none' })
  assert.equal(bodies[0].reasoning_effort, undefined)
  assert.equal(bodies[1].reasoning_effort, 'none')
  await assert.rejects(client.chat({ ...request, reasoningEffort: 'invalid' as 'none' }), /reasoning/i)
  assert.equal(bodies.length, 2)
})

async function result(payload: unknown) {
  return new OpenAICompatibleModelClient(config, { fetch: async () => Response.json(payload) }).chat(request)
}

async function diagnostic(payload: unknown) {
  try { await result(payload) } catch (error) {
    assert.ok(error instanceof ModelClientError)
    assert.equal(error.code, 'INVALID_RESPONSE')
    return safeFailureDiagnostic(error)
  }
  assert.fail('Expected invalid response')
}

test('Chat Completions extracts string text, finish reason and token usage', async () => {
  assert.deepEqual(await result({ model: 'offline', choices: [{ finish_reason: 'stop', message: { content: 'OK' } }],
    usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } }), {
    text: 'OK', model: 'offline', finishReason: 'STOP',
    usage: { promptTokens: 4, completionTokens: 2, totalTokens: 6 },
  })
})

for (const [label, content, kind] of [
  ['missing', undefined, 'MISSING'], ['null', null, 'NULL'], ['empty', '', 'STRING'], ['whitespace', '  ', 'STRING'],
] as const) {
  test(`HTTP 200 ${label} content is EMPTY_CONTENT with safe metadata`, async () => {
    const message = content === undefined ? {} : { content }
    assert.deepEqual(await diagnostic({ choices: [{ finish_reason: 'stop', message }],
      usage: { prompt_tokens: 4, completion_tokens: 0, total_tokens: 4 } }), {
      failureKind: 'PROVIDER_RESPONSE', responseIssue: 'EMPTY_CONTENT', responseMetadata: {
        ...baseMetadata, contentKind: kind, usage: { promptTokens: 4, completionTokens: 0, totalTokens: 4 },
      },
    })
  })
}

test('output limit with no visible text is distinguished without inferring why it was exhausted', async () => {
  assert.deepEqual(await diagnostic({ choices: [{ finish_reason: 'length', message: {
    content: null, reasoning_content: 'PRIVATE_REASONING',
  } }], usage: { prompt_tokens: 4, completion_tokens: 16, total_tokens: 20 } }), {
    failureKind: 'PROVIDER_RESPONSE', responseIssue: 'OUTPUT_LIMIT_NO_CONTENT', responseMetadata: {
      ...baseMetadata, contentKind: 'NULL', finishReason: 'LENGTH', reasoningContentPresent: true,
      usage: { promptTokens: 4, completionTokens: 16, totalTokens: 20 },
    },
  })
})

for (const [label, payload, expected] of [
  ['null root', null, { choiceCount: 0, messagePresent: false, contentKind: 'MISSING', finishReason: 'MISSING' }],
  ['missing choices', {}, { choiceCount: 0, messagePresent: false, contentKind: 'MISSING', finishReason: 'MISSING' }],
  ['object choices', { choices: {} }, { choiceCount: 0, messagePresent: false, contentKind: 'MISSING', finishReason: 'MISSING' }],
  ['empty choices', { choices: [] }, { choiceCount: 0, messagePresent: false, contentKind: 'MISSING', finishReason: 'MISSING' }],
  ['missing message', { choices: [{ finish_reason: 'stop' }] },
    { choiceCount: 1, messagePresent: false, contentKind: 'MISSING', finishReason: 'STOP' }],
] as const) {
  test(`invalid Chat Completions structure: ${label}`, async () => {
    assert.deepEqual(await diagnostic(payload), {
      failureKind: 'PROVIDER_RESPONSE', responseIssue: 'INVALID_STRUCTURE',
      responseMetadata: { ...expected, reasoningContentPresent: false },
    })
  })
}

for (const [label, content, kind] of [
  ['content parts array', [{ type: 'text', text: 'PRIVATE_TEXT' }], 'ARRAY'],
  ['content object', { text: 'PRIVATE_TEXT' }, 'OTHER'],
] as const) {
  test(`content exists but unsupported by this Chat Completions client: ${label}`, async () => {
    const saved = await diagnostic({ choices: [{ finish_reason: 'stop', message: { content } }] })
    assert.deepEqual(saved, { failureKind: 'PROVIDER_RESPONSE', responseIssue: 'UNSUPPORTED_CONTENT_TYPE',
      responseMetadata: { ...baseMetadata, contentKind: kind } })
    assert.doesNotMatch(JSON.stringify(saved), /PRIVATE_TEXT/)
  })
}

test('unknown finish reason and invalid usage values are reduced to safe metadata', async () => {
  const saved = await diagnostic({ choices: [{ finish_reason: 'PRIVATE_FINISH', message: { content: null } }],
    usage: { prompt_tokens: -1, completion_tokens: 'PRIVATE_USAGE', total_tokens: 5 } })
  assert.deepEqual(saved, { failureKind: 'PROVIDER_RESPONSE', responseIssue: 'EMPTY_CONTENT', responseMetadata: {
    choiceCount: 1, messagePresent: true, contentKind: 'NULL', finishReason: 'OTHER', reasoningContentPresent: false,
    usage: { totalTokens: 5 },
  } })
  assert.doesNotMatch(JSON.stringify(saved), /PRIVATE_/)
})

test('historical MISSING_CONTENT diagnostics remain readable', () => {
  const error = new ModelClientError('INVALID_RESPONSE', 'historical', {
    diagnostic: { failureKind: 'PROVIDER_RESPONSE', responseIssue: 'MISSING_CONTENT' },
  })
  assert.deepEqual(safeFailureDiagnostic(error), { failureKind: 'PROVIDER_RESPONSE', responseIssue: 'MISSING_CONTENT' })
})

test('entailment failure saves bounded configuration, target IDs and reasoning/cache usage without private text', async () => {
  const payload = { choices: [{ finish_reason: 'length', message: { content: '', reasoning_content: 'PRIVATE_REASONING' } }],
    usage: { prompt_tokens: 10, completion_tokens: 16, total_tokens: 26,
      completion_tokens_details: { reasoning_tokens: 16 }, prompt_cache_hit_tokens: 4, prompt_cache_miss_tokens: 6 } }
  const body = JSON.stringify(payload); let captured = ''
  const client = new OpenAICompatibleModelClient(config, { fetch: async () => new Response(body), onResponse: raw => { captured = raw } })
  await assert.rejects(client.chat({ ...request, maxTokens: 50000, retryOnTimeout: false,
    diagnosticContext: { stage: 'ENTAILMENT', targetIds: ['node-1', 'logic-rule-1'] } }), error => {
    const d = safeFailureDiagnostic(error)
    assert.equal(d.failureKind, 'PROVIDER_RESPONSE')
    if (d.failureKind !== 'PROVIDER_RESPONSE') return false
    assert.deepEqual(d.requestMetadata, { stage: 'ENTAILMENT', targetIds: ['node-1', 'logic-rule-1'], model: 'offline', maxTokens: 50000 })
    assert.equal(d.responseIssue, 'OUTPUT_LIMIT_NO_CONTENT')
    assert.equal(d.responseMetadata!.finalAnswerPresent, false); assert.equal(d.responseMetadata!.finalAnswerJsonParsed, false)
    assert.equal(d.responseMetadata!.reasoningContentPresent, true); assert.equal(d.responseMetadata!.reasoningCharacters, 17)
    assert.equal(d.responseMetadata!.contentCharacters, 0); assert.match(d.responseMetadata!.contentHash!, /^[a-f0-9]{64}$/)
    assert.deepEqual(d.responseMetadata!.usage, { promptTokens: 10, completionTokens: 16, totalTokens: 26,
      reasoningTokens: 16, promptCacheHitTokens: 4, promptCacheMissTokens: 6 })
    assert.doesNotMatch(JSON.stringify(d), /PRIVATE_|reasoning_content|messages|authorization/)
    return true
  })
  assert.equal(captured, body, 'explicit controlled observer receives the original body once, without reconstructing it')
})

test('entailment response records syntactic JSON availability and provider reasoning tokens without inferring them', async () => {
  const client = new OpenAICompatibleModelClient(config, { fetch: async () => Response.json({ model: 'offline',
    choices: [{ finish_reason: 'stop', message: { content: '{"checks":[]}', reasoning_content: 'PRIVATE_REASONING' } }],
    usage: { prompt_tokens: 4, completion_tokens: 12, total_tokens: 16 } }) })
  const r = await client.chat({ ...request, diagnosticContext: { stage: 'ENTAILMENT', targetIds: ['node-1'] } })
  assert.equal(r.responseMetadata!.finalAnswerJsonParsed, true)
  assert.equal(r.responseMetadata!.finalAnswerPresent, true)
  assert.equal(r.usage!.reasoningTokens, undefined)
  assert.doesNotMatch(JSON.stringify(r.responseMetadata), /PRIVATE_REASONING/)
})

test('opt-in raw observer preserves invalid JSON while safe diagnostics do not expose its body', async () => {
  let captured = ''
  const client = new OpenAICompatibleModelClient(config, { fetch: async () => new Response('PRIVATE_INVALID_JSON'), onResponse: raw => { captured = raw } })
  await assert.rejects(client.chat(request), error => {
    assert.deepEqual(safeFailureDiagnostic(error), { failureKind: 'PROVIDER_RESPONSE', responseIssue: 'INVALID_JSON' })
    return true
  })
  assert.equal(captured, 'PRIVATE_INVALID_JSON')
})
