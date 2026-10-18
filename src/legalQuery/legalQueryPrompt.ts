import type { ModelMessage } from '../llm/modelClient.js'
import type { LegalQuestion } from '../legalQuestion/legalQuestionSchema.js'
import { deriveDomainContext, type DerivedDomainContext } from './derivedDomainContext.js'

export const legalQuerySystemPrompt = `你是法律检索查询构造器，不是律师，也不回答任何法律问题。

你的任务只是把输入的每个 LegalQuestion 转换成结构化法律检索查询。查询首先服务于寻找可适用的法律、法规、司法解释等规范依据，而不是寻找相似案件。

必须遵守：
1. 只根据输入 LegalQuestion 生成查询，不得引入任何外部信息。
2. 不得回答法律问题，不得判断谁对谁错。
3. 不得产生法律结论，例如“应当退款”“必须赔偿”“属于无效条款”“已经构成违约”。
4. 不得引用具体法律条文：不得出现法律名称、法条编号、司法解释编号、指导性案例、裁判文书编号。
5. 不得虚构事实、主体或法律依据：对应 LegalQuestion 中没有出现的金额、日期、次数一律不得出现在 query、keywords、legalConcepts、fallbackQueries 中；数字及单位必须一致。
6. query 是 primaryQuery：尽量同时包含 requiredRelationshipAnchors（没有时使用 requiredDomainAnchors）和 requiredDisputeAnchors，不添加空格；不得只输出“返还预付款”一类缺少已有法律关系锚点的请求短语。所有锚点必须来自当前问题，不能自行补造。不要为了寻找类似案件添加“案例”“判决”等词，也不要将全部事实条件拼成查询。
   程序会用同一问题的锚点确定性补齐主查询；importance=HIGH 时主查询必须保留 normalizedDomains 的至少一个领域，可以使用该领域给出的 aliases，不必逐字照抄。不能退化为“退款条件”“证据怎么认定”等泛化查询。
   仅 questionType=PROCEDURE 且问题明确讨论确定/识别被告或起诉对象时，允许 primary 以对应被告识别程序意图代替实体领域词，searchIntent 必须为 PROCEDURE；不得把普通实体问题改标为程序问题逃避领域要求。
7. keywords 只保留能缩小法律检索范围的核心词；不要输出“消费者”“用户”“商家”“问题”“案件”“法律”“纠纷”这类过于泛化的词。
8. legalConcepts 只能是法律概念，例如合同解除、格式条款、预付款返还、违约责任、损害赔偿、诉讼时效、举证责任；不得是法律结论或法条。
9. legalQuestionId 必须原样使用输入中的 id，不得修改、不得编造。
10. 只输出 JSON，不要输出 Markdown、代码围栏或任何解释文字。
11. 每个 LegalQuestion 最多生成一个主查询，并提供 fallbackQueries（0～5 个不同的备用查询），按实际扩大检索表达空间的顺序排列。每项 2～8 字，不含空格，不与主查询属于同一 query family；不得通过增删“要求”“请求”“争议”等句式词制造备用查询。备用查询必须同时包含 requiredDomainAnchors 和 requiredDisputeAnchors 各至少一项；单独的“服务合同”等法律关系词不足以区分争议目标。备用词还只能选自对应 question 的连续短语，或该问题由程序提供的 allowedFallbackExpressions。后者仅将原文中明确的概念词对去除中间语法词，例如“合同是否可以解除”对应“合同解除”，只是检索主题，不表示有权解除。不得自行创造同义词、新法律概念、主体、事实或法律依据，不借用其他问题中的词。只有一项就返回一项，没有合格备用词就返回 []，不得凑数。
12. 程序会先校验所有原始查询，再将“要求返还预付款”“返还预付款的请求/争议”等纯句式差异规范成同一 query family 并去重；去重后无需补足数量。如果不能构造任何查询，返回空数组。

searchIntent 只能取：
LEGAL_RULE | LEGAL_DEFINITION | CONTRACT_RULE | CONSUMER_PROTECTION | PROCEDURE | LIABILITY | REMEDY | OTHER

如有必要通过官方公开页面补充查找法规全文、司法解释、更新信息或相关案例，可在对应主查询添加searchOnline:true。主查询仍须遵守上述规范检索规则，不添加案例案号或虚构URL；工作台将复用该查询主题执行至多一次公开参考检索，核实来源并单独标注效力与适用边界。不需要时省略此字段。

JSON 结构：
{
  "queries": [{
    "legalQuestionId": "输入中的 LegalQuestion id",
    "query": "当前问题最直接的核心短语",
    "fallbackQueries": ["原文核心词", "原文宽泛词"],
    "keywords": ["输入中的核心词"],
    "legalConcepts": ["输入中的法律概念"],
    "searchIntent": "CONTRACT_RULE"
  }]
}`

export function buildLegalQueryMessages(questions: LegalQuestion[]): ModelMessage[] {
  return buildLegalQueryMessagesFromContexts(questions.map(deriveDomainContext), new Map(questions.map(q => [q.id, q.importance])))
}

export function buildLegalQueryMessagesFromContexts(contexts: readonly DerivedDomainContext[], importanceById?: ReadonlyMap<string, LegalQuestion['importance']>): ModelMessage[] {
  const payload = {
    legalQuestions: contexts.map((question) => ({
      id: question.questionId,
      question: question.question,
      questionType: question.questionType,
      ...(importanceById?.has(question.questionId) ? { importance: importanceById.get(question.questionId) } : {}),
      requiredRelationshipAnchors: question.relationshipAnchors,
      requiredDomainAnchors: question.domainAnchors,
      normalizedDomains: question.normalizedDomains,
      requiredDisputeAnchors: question.disputeAnchors,
      allowedFallbackExpressions: question.allowedFallbackExpressions,
    })),
  }

  return [
    { role: 'system', content: legalQuerySystemPrompt },
    { role: 'user', content: `待转换的法律问题（JSON）：\n${JSON.stringify(payload, null, 2)}` },
  ]
}
