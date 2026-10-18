import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve, sep } from 'node:path'
import { z } from 'zod'
import { WorkspaceError } from '../caseEvidence/workspace.js'
import { AcceptanceBudget, type AcceptanceLimits } from '../integration/acceptanceBudget.js'
import { ControlledModelLedger } from './controlledAcceptance.js'
import { createWorkbenchRuntime, type WorkbenchRuntimeFactory } from './researchRuntime.js'
import { loadModelConfig } from '../config/modelConfig.js'
import { OpenAICompatibleModelClient, type ModelRequest, type ModelResponse } from '../llm/modelClient.js'
import { factExtractionSystemPrompt } from '../extraction/factExtractionPrompt.js'
import { caseClassificationSystemPrompt, disputeAnalysisSystemPrompt } from '../classification/classificationPrompt.js'
import { legalQuestionSystemPrompt } from '../legalQuestion/legalQuestionPrompt.js'
import { legalQuerySystemPrompt } from '../legalQuery/legalQueryPrompt.js'
import { validatedConditionalResearch } from '../report/conditionalResearchReport.js'
import type { ResearchWorkflowResult } from '../integration/researchWorkflow.js'

export const fullCaseLimits: AcceptanceLimits = { queries: 40, verifications: 60, httpRequests: 29, durationMs: 3_600_000 }
export const fullCaseCaps = { 'Fact Extraction': 16_000, Classification: 16_000, 'Dispute Identification': 16_000,
  'Legal Questions': 16_000, 'Search Queries': 16_000, AUTHORITY_APPLICABILITY: 12_000, NORMATIVE_IR: 20_000, ENTAILMENT: 50_000, APPLICATION: 20_000 }
export const fullCasePlanSchema = z.strictObject({ evidenceRoot: z.string(), artifactRoot: z.string(), caseId: z.string(),
  rawCase: z.string().max(20_000), pricingCheckedAt: z.string().datetime(),
  codeFiles: z.array(z.strictObject({ path: z.string(), sha256: z.string() })).min(1) })
export type FullCasePlan = z.infer<typeof fullCasePlanSchema>
export type ReplayModel = (request: ModelRequest, context: { stage: string; questionId?: string }) => Promise<ModelResponse | undefined>

/** One opt-in batch spanning creation, human material review, research and export. Ordinary runtime is unchanged. */
export class FullCaseAcceptance {
  readonly plan: FullCasePlan
  readonly ledger = new ControlledModelLedger({inputTokens:400_000,totalTokens:1_200_000,usd:1.10,calls:29},fullCaseCaps,null)
  private batch?: AcceptanceBudget
  private sequence = 0
  private researchStarted = false
  private finished = false
  private stage = 'Fact Extraction'
  private questionId?: string
  private result?: ResearchWorkflowResult
  private cacheHits = 0
  constructor(plan: unknown, readonly authorized = false, private readonly replay?: ReplayModel, private readonly cache?: ReplayModel) {
    this.plan=fullCasePlanSchema.parse(plan)
    for(const path of [this.plan.evidenceRoot,this.plan.artifactRoot]) if(!resolve(path).startsWith(resolve('output')+sep)) throw new WorkspaceError('整案验收仅允许output隔离目录')
    if(!/^SIMULATED.*TEST DATA/s.test(this.plan.rawCase)) throw new WorkspaceError('验收陈述必须标记SIMULATED/TEST DATA')
  }
  private checkPlan() {
    for(const f of this.plan.codeFiles) if(createHash('sha256').update(readFileSync(f.path)).digest('hex')!==f.sha256) throw new WorkspaceError('整案预检代码指纹已变化',409)
    if(Date.now()-Date.parse(this.plan.pricingCheckedAt)>86_400_000) throw new WorkspaceError('验收费率已过期，需重新核价',409)
    const c=loadModelConfig()
    if(c.baseURL.replace(/\/$/,'')!=='https://api.deepseek.com'||![c.flashModel,c.proModel].every(m=>['deepseek-flash','deepseek-v4-flash'].includes(m))) throw new WorkspaceError('整案预算仅覆盖官方Flash模型',409)
    return c
  }
  metadata() { this.checkPlan(); return {status:'FULL_CASE_ZERO_PAID_READY',mode:'FULL_CASE_ACCEPTANCE',authorized:this.authorized,executionMode:this.replay?'OFFLINE_HISTORY_REPLAY':'LIVE_PRECHECK',
    used:this.researchStarted||existsSync(join(this.plan.artifactRoot,'batch-started.json'))&&!this.batch,rawCase:this.plan.rawCase,
    modelHttpMax:29,totalTokensMax:1_200_000,inputTokensMax:400_000,
    usdMax:1.10,conservativeUSDMax:0.9504,durationMs:fullCaseLimits.durationMs,legalHttpMax:0,retries:0,questionCount:6} }
  acquire(kind:'CREATE'|'RESEARCH', rawCase?:string) {
    this.checkPlan()
    if(this.finished)throw new WorkspaceError('本次整案验收已结束，不能重试',409)
    if(!this.authorized) throw new WorkspaceError('本轮整案只做零付费预检，尚无LIVE授权',409)
    if(kind==='CREATE') {
      if(rawCase!==this.plan.rawCase||this.batch||existsSync(join(this.plan.artifactRoot,'batch-started.json'))) throw new WorkspaceError('只允许本批预检的TEST DATA陈述创建一次',409)
      mkdirSync(this.plan.artifactRoot,{recursive:true,mode:0o700})
      writeFileSync(join(this.plan.artifactRoot,'batch-started.json'),JSON.stringify({at:new Date().toISOString(),mode:this.replay?'OFFLINE_REPLAY':'LIVE',plan:this.plan}),{flag:'wx',mode:0o600})
      this.batch=new AcceptanceBudget(fullCaseLimits)
    } else {
      if(!this.batch||this.researchStarted) throw new WorkspaceError('必须从本批新建案开始，研究只能执行一次',409)
      this.researchStarted=true
    }
    this.batch!.check();return this.batch!
  }
  runtime: WorkbenchRuntimeFactory = (budget,options) => {
    const config=this.checkPlan(), write=(name:string,data:unknown)=>writeFileSync(join(this.plan.artifactRoot,name),JSON.stringify(data,null,2),{flag:'wx',mode:0o600})
    const prompts=new Map([[factExtractionSystemPrompt,'Fact Extraction'],[caseClassificationSystemPrompt,'Classification'],[disputeAnalysisSystemPrompt,'Dispute Identification'],[legalQuestionSystemPrompt,'Legal Questions'],[legalQuerySystemPrompt,'Search Queries']])
    const runtime=createWorkbenchRuntime(budget,{...options,questionConcurrency:1,cacheRoot:undefined,createCaseId:()=>this.plan.caseId,localAuthoritiesOnly:true,
      onNormativeStage:(stage,qid,value)=>{this.stage=stage;this.questionId=qid;options?.onNormativeStage?.(stage,qid,value)
        if(value!==undefined)write(`${qid}-${stage}.json`,value)},
      modelClient:{chat:async original=>{
        const upstream=prompts.get(original.messages[0]?.content)
        if(upstream){this.stage=upstream;this.questionId=undefined}
        const stage=this.stage,questionId=this.questionId,number=++this.sequence
        const request={...original,maxTokens:fullCaseCaps[stage as keyof typeof fullCaseCaps],retryOnTimeout:false}
        write(`model-${number}-request.json`,{...request,signal:undefined,stage,questionId})
        const replayed=await (this.replay??this.cache)?.(request,{stage,questionId})
        if(replayed){if(!this.replay)this.cacheHits++;write(`model-${number}-response.json`,replayed);write(`model-${number}-receipt.json`,{mode:this.replay?'OFFLINE_REPLAY_OR_TEST_DATA':'REAL_CACHE_EXACT_DEPENDENCIES',stage,questionId,newHttp:0});return replayed}
        if(this.replay)throw new Error(`OFFLINE_CACHE_MISS:${stage}/${questionId??'upstream'}; real HTTP forbidden`)
        const call=this.ledger.reserve(stage,request)
        const client=new OpenAICompatibleModelClient(config,{timeoutMs:stage==='ENTAILMENT'?270_000:120_000,
          fetch:budget.networkFetch(fetch),onResponse:body=>writeFileSync(join(this.plan.artifactRoot,`model-${number}-provider.raw.json`),body,{flag:'wx',mode:0o600})})
        try {
          const response=await budget.model(client).chat(request);write(`model-${number}-response.json`,response)
          this.ledger.complete(call,response)
          if(response.finishReason!=='STOP'||!['deepseek-flash','deepseek-v4-flash'].includes(response.model))throw new Error('Incomplete/unknown model response; acceptance stopped')
          return response
        }catch(error){this.ledger.stop();throw error}
        finally{write(`model-${number}-receipt.json`,call)}
      }}})
    const decomposer=runtime.dependencies.legalQuestionDecomposer
    runtime.dependencies.legalQuestionDecomposer={decompose:async source=>{
      const questions=await decomposer.decompose(source)
      if(questions.length!==6)throw new Error('FULL_CASE_QUESTION_COUNT_MISMATCH: stop before queries; do not truncate or invent questions')
      return questions
    }}
    return runtime
  }
  validate(result:ResearchWorkflowResult) {
    this.result=result
    const report=validatedConditionalResearch(result)
    if(result.legalQuestions.length!==6||!report||report.acceptedCount!==6||report.questions.some(q=>q.status!=='CONDITIONAL'))throw new Error('FULL_CASE_INCOMPLETE: six strictly validated conditional analyses required; failures/skips are not PASS')
  }
  finish(error?:unknown) {
    if(!this.batch||this.finished)return
    this.finished=true
    writeFileSync(join(this.plan.artifactRoot,'summary.json'),JSON.stringify({status:error?'BLOCKED':this.result?this.replay?'FULL_CASE_ENGINEERING_PATH_PASSED':'FULL_LOAN_CONTROLLED_LIVE_PASS':'CREATION_ONLY',mode:this.replay?'OFFLINE_REPLAY':'LIVE',
      error:error instanceof Error?error.message:undefined,budget:this.batch.snapshot(),ledger:this.ledger.snapshot(),
      cause:error instanceof Error&&error.cause instanceof Error?{name:error.cause.name,message:error.cause.message,stack:error.cause.stack}:undefined,
      questionCount:this.result?.legalQuestions.length,conditionalCount:this.result?.conditionalAnalysis?.questions.length,
      blocked:this.result?.conditionalAnalysis?.blocked,logicalModelRequests:this.sequence,realCacheHits:this.cacheHits,newModelHttp:this.batch.snapshot().counts.httpRequests,legalHttp:0},null,2),{flag:'wx',mode:0o600})
    this.batch.dispose()
  }
  stop(){this.batch?.cancel()}
}
