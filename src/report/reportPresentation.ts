/** Conservative presentation flags, never a positive finding of legal applicability.
 * Compare explicit source topics with supplied facts, not speculative search questions.
 */
export function sourceScopeNotice(title: string, factContext: string): string {
  const topics: Array<[RegExp, RegExp, string]> = [
    [/行政诉讼|行政机关|行政行为/, /行政诉讼|行政机关|行政行为/, '行政诉讼'],
    [/刑事|刑罚|定罪/, /刑事|刑罚|定罪/, '刑事事项'],
    [/租赁|租金|承租/, /租赁|租金|承租|房租|租房/, '租赁关系'],
    [/疫情|防控/, /疫情|防控/, '疫情影响'],
    [/受理费|诉讼费/, /受理费|诉讼费/, '诉讼费用'],
    [/民间借贷|借款合同/, /借款|借贷|出借|贷款/, '借贷关系'],
    [/预付式消费|预付费服务/, /预付|消费|服务/, '预付消费'],
  ]
  const mismatches = topics.filter(([source, context]) => source.test(title) && !context.test(factContext))
  return mismatches.length
    ? `主题不匹配：材料涉及${mismatches.map(([, , label]) => label).join('、')}，现有事实未提供对应情境。本报告不将其用作结论依据；这不是对法律适用性的最终判断。`
    : '关联性待审查：检索命中不能证明规则适用于本案，本报告不将其用作结论依据。'
}

export const questionKey = (text: string) => text.replace(/[\p{P}\p{Z}\s]/gu, '').replace(/是什么|是多少|具体/g, '')

/** Only explicit fact-gathering wording is moved; ambiguous questions remain questions. */
export function isFactQuestion(question: string, unknownQuestions: string[]): boolean {
  const key = questionKey(question)
  if (unknownQuestions.some(text => questionKey(text) === key)) return true
  if (/责任|义务|效力|违约|诉讼时效|解除权|应否|能否|可否|是否合法|如何/.test(question)) return false
  return /具体.*(?:身份|名称|内容|类型|日期)|是否(?:已|曾|存在|约定)|是否为\d|何种状态|是否达成一致|有无.*(?:凭证|记录|合同)/.test(question)
}
