import { z } from 'zod'
import type { Case } from '../case/caseSchema.js'
import type { CaseEvidenceInput } from '../caseEvidence/caseEvidence.js'
import type { PreliminaryResult } from '../assistant/preliminaryWorkflow.js'
import { legalSearchQuerySchema } from '../legalQuery/legalQuerySchema.js'
import { candidateLegalSourceSchema } from '../retrieval/retrievalSchema.js'
import { sourceVerificationResultSchema } from '../verification/sourceVerificationSchema.js'
import type { ConditionalResearchReport } from '../report/conditionalResearchReport.js'
import type { PrintableReport } from '../report/userCaseReport.js'
import { renderUserHtml } from '../report/userCaseReport.js'

const strictContextSchema = z.object({ candidateVerifications:z.array(z.object({ query:legalSearchQuerySchema,
  candidate:candidateLegalSourceSchema, result:sourceVerificationResultSchema })).default([]),
  conditionalAnalysis:z.object({ questions:z.array(z.object({ authoritySelections:z.array(z.object({
    authorityId:z.string(), reason:z.string(), selectedForRule:z.boolean() })).default([]) })) }).optional() })
const esc=(value:unknown)=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!))
const link=(value:string|undefined)=>{try{const u=new URL(value!);return u.protocol==='https:'?u.href:undefined}catch{return undefined}}

/** A user-facing projection of recorded retrieval, not an extra model or applicability gate. */
export function renderLegalContext(input:{case:Case; evidence:CaseEvidenceInput; preliminary?:PreliminaryResult;
  research:unknown; mode:'PRELIMINARY'|'STRICT'; conditionalResearch?:ConditionalResearchReport; internalReport?:PrintableReport}) {
  const r=input.preliminary, facts=input.case.facts.concat(input.case.disputedFacts)
  const strict=input.mode==='STRICT'?strictContextSchema.parse(input.research):undefined
  const records=r?r.retrievals.flatMap(t=>t.retrieval.sources.map(candidate=>({candidate,query:t.query,
    result:t.verifications.find(v=>v.candidateSourceId===candidate.sourceId)}))):strict?.candidateVerifications??[]
  const unique=new Map<string,typeof records>()
  for(const record of records){const id=record.candidate.record.providerSourceId;unique.set(id,[...unique.get(id)??[],record])}
  const cited=r?new Set(r.analysis.findings.flatMap(f=>f.citations.map(c=>c.sourceId)))
    :new Set(records.filter(v=>input.conditionalResearch?.sources.some(s=>s.verificationId===v.result?.verificationId)).map(v=>v.candidate.record.providerSourceId))
  const sourceCard=(id:string,entries:typeof records)=>{
    const entry=entries.find(e=>e.result?.status==='VERIFIED')??entries[0], v=entry.result, s=v?.verifiedSource, c=entry.candidate.record
    const uses=r?.analysis.findings.flatMap(f=>f.citations.filter(q=>q.sourceId===id).map(q=>({reason:q.relevance??f.conclusion,factIds:f.factIds})))??[]
    const decisions=strict?.conditionalAnalysis?.questions.flatMap(q=>q.authoritySelections.filter(a=>a.authorityId===id))??[]
    const title=s?.title??c.title, article=s?.authority?.article.articleNumber??c.authority?.article.articleNumber??'公开资料'
    const verified=v?.status==='VERIFIED', effective=verified&&s?.legalStatus==='EFFECTIVE'
    const queries=[...new Set(entries.map(e=>e.query.query))]
    const reasons=[...new Set([...uses.map(u=>u.reason),...decisions.map(d=>d.reason)])]
    const relevantFacts=[...new Set(uses.flatMap(u=>u.factIds))].map(id=>facts.find(f=>f.id===id)?.content).filter(Boolean)
    const url=link(s?.sourceUrl??c.sourceUrl)
    const limits=[...new Set(r?.quality?.issues.filter(issue=>issue.sourceId===id).map(issue=>issue.message)??[])]
    return `<details ${cited.has(id)?'open':''}><summary>${esc(title)} · ${esc(article)}</summary>
      <p>${verified?'来源原文已核实':v?'来源核验未通过，尚不能作为已核实依据':'候选材料尚未核实'} · ${effective?'效力核验：现行有效':'效力状态：尚未确认'}</p>
      ${r?`<aside style="padding:12px;border-left:3px solid #ac7b22;background:#fff4da;color:#493815"><strong>${r.quality?.status==='BLOCKED'?'存在法律质量阻断问题':cited.has(id)?'本案适用：仍需复核':'仅供参考，尚未确认本案适用'}</strong><p>原文核验、效力状态与本案适用是不同问题；须核对地域、对象、施行时间和事实前提。</p>${limits.map(message=>`<p>${esc(message)}</p>`).join('')}</aside>`:''}
      ${url?`<p><a href="${esc(url)}" target="_blank" rel="noopener noreferrer">查看原始公开来源</a></p>`:''}
      <p>核验时间：${esc(v?.checkedAt??'未核验')}；来源获取：${esc(s?.authority?.document.fetchedAt??v?.evidence.fetchedAt??'未记录')}</p>
      <p>检索主题：${esc(queries.join('；'))}</p>
      ${reasons.length?reasons.map(reason=>`<p>${cited.has(id)?'本案适用说明':'用途与取舍记录'}：${esc(reason)}</p>`).join('')
        :`<p>${cited.has(id)?'已用于当前研究，具体适用前提见报告。':'供了解相关法律背景；本次未正式采用，未记录具体未采用原因。'}</p>`}
      ${relevantFacts.length?`<p>依据的案件陈述：${esc(relevantFacts.join('；'))}</p>`:''}
      <h4>${verified?'核实后的完整条文／网页正文':'候选文本（未核实；搜索摘要不等于完整原文）'}</h4><blockquote style="white-space:pre-wrap">${esc(s?.content??c.content)}</blockquote>
      ${!effective?'<p>网页来源核实不等于法律现行有效或适用于本案；案例与解读仅供参考。</p>':''}</details>`
  }
  const adopted=[...unique].filter(([id])=>cited.has(id)), related=[...unique].filter(([id])=>!cited.has(id))
  const evidence=facts.map(f=>{
    const links=input.evidence.links.filter(l=>l.factId===f.id&&l.status!=='CANCELLED'
      &&input.evidence.items.some(e=>e.id===l.evidenceId&&e.file?.confirmationStatus!=='REJECTED'))
    const analyses=r?.analysis.evidenceAnalysis.filter(a=>a.factIds.includes(f.id))??[]
    return `<h4>${esc(f.content)}</h4><p>${links.some(l=>l.status==='CONFIRMED')?'已有用户核对的材料内容关联（非真实性认定）'
      :analyses.length?'AI已关联识别内容，真实性尚待证明':links.length?'有建议材料关联，尚待核对':'仅有案件陈述，尚无材料支持'}</p>
      ${links.map(l=>`<p>材料：${esc(input.evidence.items.find(e=>e.id===l.evidenceId)?.title??'案件材料')}；原文：${esc(l.quote)}</p>`).join('')}
      ${analyses.map(a=>`<p>AI内容对应：${esc(a.quote)}；证明目的：${esc(a.meaning)}；局限：${esc(a.limitation)}</p>`).join('')}`
  }).join('')
  const deep=input.mode==='STRICT'&&input.internalReport?`<details><summary>完整深度研究论证与研究边界</summary>${input.internalReport.sections.map(s=>`<h3>${esc(s.title)}</h3>${s.blocks.map(b=>`<p style="white-space:pre-wrap">${esc(b.text)}</p>`).join('')}`).join('')}</details>`:''
  const body=`<p>${input.mode==='PRELIMINARY'?'这里展示报告已引用与其他相关材料。报告引用不代表本案适用已确认；请分别核对来源效力与下方适用限制。':'这里保留比PDF更丰富的相关材料。相关依据可以帮助了解法律背景，不要求每条都与某个事实一一对应；正式采用、候选与效力边界分别标注。'}</p>
    <h2>${input.mode==='PRELIMINARY'?'报告已引用的依据':'正式采用的依据'}（${adopted.length}）</h2>${adopted.map(([id,entries])=>sourceCard(id,entries)).join('')||(input.mode==='PRELIMINARY'?'<p>当前报告尚未引用依据。</p>':'<p>所选模式尚无正式采用的依据。</p>')}
    <h2>其他相关依据与公开参考（${related.length}）</h2>${related.map(([id,entries])=>sourceCard(id,entries)).join('')||'<p>尚无其他已保存的检索材料。</p>'}
    ${r?.warnings.length?`<details><summary>检索缺口与来源限制</summary>${r.warnings.map(w=>`<p>${esc(w)}</p>`).join('')}</details>`:''}
    <h2>事实与证据关系</h2>${evidence||'<p>尚无案件事实。</p>'}${input.case.unknownFacts.map(f=>`<p>待核实：${esc(f.question)}</p>`).join('')}${deep}`
  const shell=renderUserHtml({title:input.mode==='PRELIMINARY'?'初步分析 · 依据与证据详情':'深度研究 · 依据与证据详情',
    subtitle:'案件相关法律资料',generatedAt:r?.generatedAt??new Date().toISOString(),sections:[],appendix:[]},true)
  return shell.replace('</body>',`<main style="max-width:1000px;margin:auto;padding:20px;line-height:1.8;overflow-wrap:anywhere">${body}</main></body>`)
}
