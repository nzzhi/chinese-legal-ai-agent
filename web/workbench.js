let cases = [], selectedKey, current, activeTab = 'evidence', reportAudience = 'user', importIntoCurrent = false, busy = false, loading = false, loadSequence = 0, editingFactId, pollTimer, analysisMode = 'PRELIMINARY', executionMode = 'UNKNOWN'
const caseList = document.querySelector('#case-list'), inspectorContent = document.querySelector('#inspector-content')
const toast = document.querySelector('#toast'), materialDialog = document.querySelector('#material-dialog')
const labels = { MISSING: '未补充', PARTIAL: '部分补充', SATISFIED: '已有材料支持' }
const markers = { MISSING: '☐', PARTIAL: '◐', SATISFIED: '✅' }
const supportLabels = { SUPPORTED: '用户登记材料支持（非真实性认定）', PARTIAL: '部分材料支持', UNKNOWN: '尚无已确认材料支持', UNSUPPORTED: '材料尚不足' }
const fieldNames = { amount: '金额', time: '时间', transactionId: '交易单号', payer: '付款方', recipient: '收款方', result: '交易状态',
  note: '备注', participants: '对话双方', keyQuotes: '关键原文', borrowing: '借款相关原文', repaymentAgreement: '还款约定原文',
  reminder: '催款相关原文', promise: '承诺还款原文', name: '姓名', account: '微信号/账号', phone: '手机号', nickname: '微信昵称', mapping: '对应关系', source: '来源', identityNumber: '身份证号', address: '详细住址' }
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[c])
}
function showExecutionMode(value) {
  executionMode = ['OFFLINE', 'LIVE'].includes(value) ? value : 'UNKNOWN'
  const status = document.querySelector('#execution-status')
  status.textContent = { OFFLINE: 'OFFLINE · 离线模式', LIVE: 'LIVE · 真实模型环境', UNKNOWN: '运行环境未标记' }[executionMode]
  status.dataset.mode = executionMode
  document.querySelector('.disclaimer').textContent = executionMode === 'OFFLINE'
    ? '当前为离线回放／离线替身模式，未进行本轮真实 LIVE 分析。材料原文保存在本机。'
    : '保存报告的生成来源需独立确认；运行环境不代表历史报告来源。用户陈述不等于事实已证明。'
}
function qualityLabel(status) {
  return { REVIEW_REQUIRED: '仍需复核', BLOCKED: '已拦截，不能作为合格报告交付', CHECKED: '本地检查完成，仍需复核' }[status] ?? '尚未评估，不能确认法律质量'
}
function preliminaryStatusHtml(view) {
  const quality = view.preliminary?.quality, status = quality?.status
  const issues = [...new Set((quality?.issues ?? []).map(issue => issue.message))]
  const run = { SAVED: '已完成，报告已保存', RUNNING: '正在分析，当前展示已保存版本', FAILED: '本次运行未完成，当前展示已保存版本' }[view.researchRun?.status] ?? '展示已保存报告'
  return `<div class="report-status"><p>运行状态：${run}</p><p class="report-origin">${executionMode === 'OFFLINE' ? '展示来源：OFFLINE 保存结果回放／离线替身，非本轮真实 LIVE 分析。' : '展示来源：已保存报告。'}此版本原始生成来源未记录，不能确认其为真实 LIVE 结果。</p><p class="quality-label" data-quality="${escapeHtml(status ?? 'UNKNOWN')}"><strong>法律质量：${qualityLabel(status)}</strong></p><details class="quality-details"><summary>法源适用限制与待核实事项${issues.length ? `（${issues.length}类提示）` : ''}</summary><p>原文与效力核验不等于本案适用已确认。以下法律问题仍待系统复核；你可补充报告列明的具体事实和材料。</p>${issues.length ? `<ul>${issues.map(message => `<li>${escapeHtml(message)}</li>`).join('')}</ul>` : '<p>请核对报告中的事实、证据缺口及适用条件。</p>'}</details></div>`
}
function showToast(message) {
  toast.textContent = message; toast.classList.add('visible'); clearTimeout(showToast.timer)
  showToast.timer = setTimeout(() => toast.classList.remove('visible'), 5000)
}
async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'x-evidence-workspace': '1', ...options.headers } })
  const body = await response.json()
  if (!response.ok) throw new Error(body.error ?? '操作失败')
  return body
}
const casePath = () => {
  if (loading || !current || current.key !== selectedKey) throw new Error('案件尚未加载完成，请稍候')
  return `/api/cases/${selectedKey}`
}
const factsSummary = view => (/^\s*(?:【SIMULATED\b|SIMULATED\s*\/\s*DEMO ONLY(?:\s|$))/u.test(view.rawCase ?? '') ? 'SIMULATED · ' : '') + view.case.facts.concat(view.case.disputedFacts).slice(0, 3).map(f => f.content).join('；')
const caseLabel = key => `案件 ${cases.findIndex(c => c.key === key) + 1}`
const localTime = value => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
const materialPath = id => `${casePath()}/materials/${id}`
const post = (path, body) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
function storedMode(key,value) {
  try { if(value)globalThis.localStorage?.setItem(`analysis-mode-${key}`,value);return globalThis.localStorage?.getItem(`analysis-mode-${key}`) }
  catch { return undefined }
}
async function run(operation) {
  if (busy || loading) return
  const controls = [...document.querySelectorAll('button, select, input, textarea')].map(el => [el, el.disabled])
  controls.forEach(([el]) => { el.disabled = true })
  busy = true; document.body.classList.add('workspace-busy')
  try { await operation() } catch (error) { showToast(error.message) }
  finally { busy = false; controls.forEach(([el, disabled]) => { el.disabled = disabled }); document.body.classList.remove('workspace-busy'); document.querySelector('#message-input').disabled = Boolean(current) || loading; document.querySelector('.send-button').disabled = Boolean(current) || loading || controlledAcceptance?.mode==='FULL_CASE_ACCEPTANCE'&&!controlledAcceptance.authorized; if (current) { if (!editingFactId) renderMain(); renderInspector() } }
}
function renderCases() {
  const query = document.querySelector('#case-search').value
  document.querySelector('#mobile-case-select').innerHTML = cases.map(c => `<option value="${c.key}" ${c.key === selectedKey ? 'selected' : ''}>${caseLabel(c.key)} · ${escapeHtml(c.title)}</option>`).join('')
  caseList.innerHTML = cases.filter(c => `${c.caseId}${c.title}`.includes(query)).map(c => `<button class="case-item ${c.key === selectedKey ? 'active' : ''}" data-key="${c.key}" data-short="${cases.indexOf(c) + 1}" aria-label="${caseLabel(c.key)} · ${escapeHtml(c.title)}"><span class="case-id">${caseLabel(c.key)}</span><h3>${escapeHtml(c.title)}</h3><span class="case-status">本地案件材料</span></button>`).join('')
    || '<p class="empty-state">尚无案件。在下方输入案情即可创建。</p>'
}
function newCase() {
  analysisMode = 'PRELIMINARY'; document.querySelector('#analysis-mode').value = analysisMode
  clearTimeout(pollTimer); loadSequence++; selectedKey = undefined; current = undefined; editingFactId = undefined; loading = false
  globalThis.history?.replaceState(null, '', globalThis.location.pathname)
  document.querySelector('#case-number').textContent = '新案件'
  document.querySelector('#case-title').textContent = '输入案情，创建案件'
  document.querySelector('#message-input').disabled = false
  document.querySelector('#message-input').value = ''
  document.querySelector('#message-input').placeholder = '说明双方关系、发生经过、金额、时间和希望解决的问题'
  document.querySelector('.send-button').disabled = controlledAcceptance?.mode==='FULL_CASE_ACCEPTANCE'&&!controlledAcceptance.authorized
  document.querySelector('#run-research').disabled = true
  document.querySelector('#thread').innerHTML = '<article class="workspace-intro"><h2>先描述发生了什么</h2><p>说明双方关系、时间、金额、争议和诉求。创建后会提取事实并转换法律检索术语。可选补充证据，再直接生成初步法律分析。</p><p>不要在这里粘贴模型密钥。案情最多 20000 字。</p></article>'
  for (const tab of ['facts', 'evidence', 'law']) document.querySelector(`[data-tab="${tab}"] span`).textContent = '0'
  renderCases(); renderInspector()
}
async function selectCase(key, mode) {
  clearTimeout(pollTimer)
  const sequence = ++loadSequence
  const changed = key !== selectedKey
  if (changed) { editingFactId = undefined; if (materialDialog.open) materialDialog.close() }
  selectedKey = key; current = undefined; loading = true; renderCases()
  document.querySelector('#case-number').textContent = caseLabel(key)
  document.querySelector('#case-title').textContent = '正在加载所选案件…'
  document.querySelector('#thread').innerHTML = '<p role="status">正在加载所选案件，加载完成前不能编辑或生成报告。</p>'
  document.querySelector('#run-research').disabled = true
  document.querySelector('#message-input').disabled = true
  document.querySelector('#message-input').value = ''
  document.querySelector('.send-button').disabled = true
  renderInspector()
  try {
    analysisMode = controlledAcceptance ? 'STRICT' : mode ?? storedMode(key) ?? (changed ? 'PRELIMINARY' : analysisMode)
    if (changed) reportAudience = analysisMode === 'STRICT' ? 'internal' : 'user'
    document.querySelector('#analysis-mode').value = analysisMode
    const view = await api(`/api/cases/${key}?mode=${analysisMode}`)
    if (selectedKey !== key || sequence !== loadSequence) return
    if (controlledAcceptance?.recovery && view.researchRun?.status !== 'RUNNING') controlledAcceptance = await api('/api/controlled-acceptance')
    current = view; loading = false
    const listed = cases.find(c => c.key === key)
    if (listed) listed.title = factsSummary(view).slice(0, 65)
    globalThis.history?.replaceState(null, '', `#case=${key}`)
    document.querySelector('#case-title').textContent = factsSummary(view).slice(0, 65) || '待补充事实'
    document.querySelector('#case-type').textContent = '案件材料中心'
    renderCases(); renderMain(); renderInspector()
    document.querySelector('#message-input').placeholder = '此案件已保存；使用左上角＋创建另一个案件'
    if (view.researchRun?.status === 'RUNNING') scheduleProgress(key, sequence)
  } catch (error) {
    if (sequence === loadSequence) {
      document.querySelector('#case-title').textContent = '案件加载失败'
      document.querySelector('#thread').innerHTML = '<p role="alert">加载失败，请重新选择案件；当前不能编辑或生成报告。</p>'
    }
    throw error
  } finally { if (sequence === loadSequence) loading = false }
}
function scheduleProgress(key, sequence) {
  pollTimer = setTimeout(async () => {
    if (selectedKey !== key || sequence !== loadSequence) return
    if (busy) { scheduleProgress(key, sequence); return }
    try {
      const status = await api(`/api/cases/${key}/research/status`)
      if (selectedKey !== key || sequence !== loadSequence || !current) return
      current.researchRun = status.researchRun
      const region = document.querySelector('#research-progress')
      if (region) region.innerHTML = researchProgressHtml(current)
      if (status.researchRun?.status === 'RUNNING') scheduleProgress(key, sequence)
      else await selectCase(key)
    } catch (error) { showToast(`读取研究进度失败：${error.message}；重新选择案件可重试。`) }
  }, 1000)
}
function researchProgressHtml(view) {
  const research = view.researchRun
  if (!research) return '尚未启动研究。'
  const elapsed = Math.max(0, Math.floor(((research.finishedAt ? Date.parse(research.finishedAt) : Date.now()) - Date.parse(research.startedAt)) / 1000))
  const questions = research.questions ?? []
  const completed = questions.filter(q => ['COMPLETED', 'REUSED'].includes(q.status)).length
  const quality = view.defaultResearchMode === 'PRELIMINARY' ? `<p class="quality-label" data-quality="${escapeHtml(research.qualityStatus ?? 'UNKNOWN')}">本次法律质量：${qualityLabel(research.qualityStatus)}</p>` : ''
  return `<p role="status">${view.defaultResearchMode === 'PRELIMINARY' ? '运行状态：' : ''}${escapeHtml(research.stage)} · 耗时 ${elapsed} 秒${questions.length ? ` · 已完成 ${completed}/${questions.length} 题` : ''}${research.modelReuseCount ? ` · 复用 ${research.modelReuseCount} 次模型结果` : ''}</p>${quality}${questions.map(q => `<p>${escapeHtml(q.id)}：${escapeHtml(q.stage)}${q.status === 'BLOCKED' ? '（受阻，未计入完成）' : ''}</p>`).join('')}<p>${escapeHtml(research.error ?? '')}</p>${research.status === 'RUNNING' ? '<button data-cancel-research>取消分析</button>' : research.status === 'FAILED' && !controlledAcceptance ? current.defaultResearchMode === 'PRELIMINARY' ? '<p>本次分析未完成，旧报告与材料已保留。可重新生成初步分析。</p>' : '<p>再次启动会精确重验并复用有效快照。需要重新生成模型输出时，可选择下方完整重跑。</p><button data-fresh-research>完整重跑（增加模型调用）</button>' : ''}`
}
function gapsHtml() {
  if (current.defaultResearchMode === 'PRELIMINARY' && !controlledAcceptance) {
    const unread = current.evidence.items.filter(e => e.file && e.file.confirmationStatus !== 'REJECTED' && !e.content)
    const questions = current.preliminary && !current.preliminaryNeedsRefresh ? current.preliminary.analysis.uncertainties : current.case.unknownFacts.map(f => f.question)
    return unread.map(e => `<p>${escapeHtml(e.title)}：尚无可读文字，请补充清晰原件或关键原文。</p>`).join('')
      + questions.map(text => `<p>${escapeHtml(text)}</p>`).join('') || '<p>当前没有突出补充事项，可核对原始记录及最新还款情况。</p>'
  }
  if (current.answerReport?.priorityGaps && !/借款|借给|出借|借条/.test(current.case.facts.map(f => f.content).join('；'))) return current.answerReport.priorityGaps.slice(0, 3).map(g => `<div class="gap-row"><div><strong>${escapeHtml(g.title)}</strong><p>${escapeHtml(g.action)}</p></div></div>`).join('') || '<p>当前没有突出补充事项。</p>'
  return current.assessment.workspaceGaps.map(g => `<div class="gap-row" data-gap-family="${g.family}" data-gap-status="${g.status}"><span aria-label="${labels[g.status]}">${markers[g.status]}</span><div><strong>${escapeHtml(g.title)}${g.status === 'PARTIAL' ? '（部分）' : ''}</strong><p>${labels[g.status]}${g.status === 'SATISFIED' ? '；完整性由用户确认' : ''}</p>${g.status !== 'SATISFIED' ? `<small>待核对：${escapeHtml(g.missingFields.map(k => fieldNames[k] ?? k).join('、'))}</small>` : ''}</div></div>`).join('')
}
const reportStatusLabels = { NOT_STARTED: '尚未研究', PARTIAL: '部分完成', COMPLETE: '完成', READY: '准备信息齐备（仍须核验）', NEEDS_INFORMATION: '待补信息', BLOCKED: '该项暂不可用', MISSING: '尚缺材料' }
function savedReportControls() {
  const latest = current.latestReport, preliminary = current.defaultResearchMode === 'PRELIMINARY'
  if (preliminary) return `<p>${latest ? `已保存报告 · ${escapeHtml(localTime(latest.generatedAt))}` : '完成分析后自动保存可下载报告。'}</p><button data-regenerate-report ${current.researchRun?.status === 'RUNNING' ? 'disabled' : ''}>重新导出当前报告</button>`
  return `<p><strong>当前操作：${caseLabel(selectedKey)} · ${escapeHtml(factsSummary(current).slice(0, 65))}</strong></p><p>当前核心事实：${escapeHtml(factsSummary(current))}</p><p>${latest ? `当前报告：v${latest.version} · ${escapeHtml(localTime(latest.generatedAt))}<br>案件：${reportStatusLabels[latest.workflowStatus]} · 材料：${reportStatusLabels[latest.evidenceReadiness]} · 研究：${reportStatusLabels[latest.researchStatus]}<br>使用已有研究：${latest.researchReuseStatus === 'REUSABLE' ? '是' : '否'}；建议重新研究：${latest.researchNeedsRefresh ? '是' : '否'}` : '尚未保存报告版本。'}</p>${current.researchNeedsRefresh ? '<p role="alert">研究已过期（STALE）：案件事实已变化，旧研究结论不会作为最新版确定结论展示。需显式重新研究后重新评估；本次生成不会自动研究。</p>' : ''}<button data-regenerate-report ${current.researchRun?.status === 'RUNNING' ? 'disabled' : ''}>${preliminary ? '重新导出当前报告' : '生成 / 更新双报告'}</button><p>仅显式点击后保存新版本；不会自动启动法律研究。</p>`
}
function reportLinks() {
  const preliminary = current.defaultResearchMode === 'PRELIMINARY'
  if(preliminary&&!current.preliminaryReport)return '<p>此模式尚无可用的初步报告，请点击生成；其他模式的历史成果仍保留。</p>'
  const kind = preliminary ? 'user' : reportAudience, name = preliminary ? '初步法律分析报告' : kind === 'internal' ? '完整深度研究报告' : '用户分析摘要', latest = current.latestReport
  const switcher = preliminary ? '<p>报告包含案件结论、法律依据、证据对应、争议风险和行动建议。</p>' : `<div class="report-actions" role="group" aria-label="报告视图"><button data-report-audience="user" aria-pressed="${kind === 'user'}">用户分析摘要</button><button data-report-audience="internal" aria-pressed="${kind === 'internal'}">完整深度研究报告</button></div>`
  const url = latest ? `${casePath()}/report-versions/${current.latestReport?.reportVersionId ?? 'latest'}?kind=${kind}` : `${casePath()}/reports/${kind}?view=current`
  const available = kind === 'user' || latest?.internalArtifacts || !latest && current.internalReport
  const preview = kind === 'user' ? current.preliminaryReport ?? current.answerReport : current.internalReport
  const summary = current.conditionalResearch ? `<p>共 ${current.conditionalResearch.questionCount} 个问题，${current.conditionalResearch.acceptedCount} 个已形成条件分析；事实与材料仍须核验。</p>` : ''
  return switcher + summary + (available ? `<div class="report-actions"><a href="${url}" target="_blank" rel="noopener">查看${name}${latest ? ` · v${latest.version}` : ' · 当前预览'}</a><details><summary>下载${name}</summary>${(latest ? ['md', 'json', 'docx', 'pdf'] : ['md']).map(format => `<a href="${url}&format=${format}" target="_blank" rel="noopener" aria-label="下载${name} ${format.toUpperCase()}">${format.toUpperCase()}</a>`).join('')}</details></div>` : '<p>尚无深度研究报告；请先核对事实并启动深度研究。</p>')
    + (current.researchNeedsRefresh ? '<p role="alert">当前输入已变化；保存版本仅供历史查阅，请显式重新生成报告。</p>' : '')
    + (!preliminary && !latest && preview ? `<details><summary>${name}内容预览</summary>${preview.sections.map(s => `<h4>${escapeHtml(s.title)}</h4>${s.blocks.map(b => `<p>${escapeHtml(b.text)}</p>`).join('')}`).join('')}</details>` : '')
    + (latest?.complaintArtifacts && kind === 'user' ? `<div class="report-actions"><a href="${casePath()}/report-versions/${current.latestReport?.reportVersionId ?? 'latest'}?kind=complaint" target="_blank" rel="noopener">查看起诉准备草稿</a><details><summary>下载草稿</summary>${['md', 'docx', 'pdf'].map(format => `<a href="${casePath()}/report-versions/${current.latestReport?.reportVersionId ?? 'latest'}?kind=complaint&format=${format}" target="_blank" rel="noopener">${format.toUpperCase()}</a>`).join('')}</details></div><p>带待补占位的准备草稿，不代表已经满足法院立案要求。</p>` : '')
    + (latest ? `<details><summary>历史报告（只读）</summary>${current.reportVersions.map(v => `<p>v${v.version} · ${escapeHtml(localTime(v.generatedAt))} · ${escapeHtml(reportStatusLabels[v.researchStatus])} <a href="${casePath()}/report-versions/${v.reportVersionId}?kind=user" target="_blank" rel="noopener">用户分析摘要</a>${v.internalArtifacts ? ` <a href="${casePath()}/report-versions/${v.reportVersionId}?kind=internal" target="_blank" rel="noopener">完整深度研究报告</a>` : ' · 旧版未保存内部报告'}</p>`).join('')}</details>` : '')
}
function materialNotice(e) {
  const simulated = /TEST DATA|FIXTURE|模拟/.test(e.content ?? '') || /^SIMULATED\s*\/\s*DEMO ONLY(?:\s|$)/i.test(e.content ?? '') || /^(?:SIMULATED|TEST)[-_ ]/i.test(e.file.filename)
  const reading = e.file.parseStatus === 'UPLOADED' ? '原文件已保存，正文尚未读取。'
    : !e.content ? current.defaultResearchMode === 'PRELIMINARY' ? '未能读取文字，请提供更清晰的图片或登记关键原文；无文字层的 PDF 目前需要登记原文。' : '正文未读取。图片不自动 OCR；无文字层的 PDF 也不能自动读取。请点击“查看原件 / 人工登记”，对照原件录入原文。'
    : e.file.extractionMethod === 'MANUAL_TRANSCRIPTION' ? '原文来自用户人工登记，请对照原件核对；不代表系统已自动识别。'
    : e.file.extractionMethod === 'LOCAL_OCR' ? '图片文字已自动识别，可用于初步分析。请核对金额、日期和姓名；文字识别不证明图片真实性。'
    : current.defaultResearchMode === 'PRELIMINARY' ? '正文已自动读取，可直接分析；内容识别不等于真实性证明。'
    : '正文已读取；字段按明确标签和关键词提取，建议关联仍须用户核对。'
  return `${simulated ? '<p><strong>SIMULATED / DEMO ONLY · 模拟材料，仅用于产品演示和测试</strong></p>' : ''}<p>${reading}</p>`
}
function renderMain() {
  const running = current.researchRun?.status === 'RUNNING'
  const preliminary = current.defaultResearchMode === 'PRELIMINARY' && !controlledAcceptance
  const pending = current.evidence.items.filter(e => e.file?.confirmationStatus === 'PENDING').length
  const button = document.querySelector('#run-research')
  document.querySelector('#analysis-mode').disabled=running || busy || Boolean(controlledAcceptance)
  button.disabled = running || !preliminary && current.continuation.capabilities.some(c => c.capability === 'RESEARCH' && c.status === 'BLOCKED')
  const researchHelp = document.querySelector('#research-help')
  if (researchHelp) researchHelp.innerHTML = running ? '正在分析，可查看进度或取消。' : preliminary ? executionMode === 'OFFLINE' ? 'OFFLINE：新分析使用离线替身，已有报告按保存版本回放。' : '将自动读取支持的材料，生成初步报告。请核对证据与法律适用边界。' : !current.factsConfirmed ? '请先核对下面的事实陈述。<button data-review-facts>去核对事实</button>' : pending ? `还有 ${pending} 份上传材料待核对，请确认或排除。<button data-tab="evidence">去核对材料</button>` : '可以启动研究；一般材料缺口不会阻止。'
  if (researchHelp && controlledAcceptance) researchHelp.textContent = !controlledAcceptance.authorized ? '零付费预检完成；等待本次 LIVE 独立授权。' : controlledAcceptance.used ? '本次授权已使用，不能重复调用。' : controlledAcceptance.paused ? '三个前缀已通过；恢复仍服从最初600秒期限，只补Application。' : controlledAcceptance.mode==='FULL_CASE_ACCEPTANCE' ? '本轮从陈述到六题双报告；TEST DATA不证明真实性。' : '本轮仅执行指定单题；事实和法源快照沿用缓存。'
  button.innerHTML = `<span>${running ? '分析进行中…' : preliminary ? current.preliminary || current.preliminaryNeedsRefresh ? '重新生成初步分析' : '生成初步法律分析' : controlledAcceptance?.paused ? '恢复：仅补 Application' : controlledAcceptance?.mode==='FULL_CASE_ACCEPTANCE' ? '受控执行整案六题' : controlledAcceptance ? `受控执行 ${escapeHtml(controlledAcceptance.questionId)}` : current.actionReport ? '重新研究' : '启动法律研究'}</span>`
  if (controlledAcceptance && (!controlledAcceptance.authorized || controlledAcceptance.used || controlledAcceptance.mode!=='FULL_CASE_ACCEPTANCE'&&current.key !== controlledAcceptance.key)) button.disabled = true
  document.querySelector('#thread').innerHTML = `<article class="workspace-intro"><span class="mock-label">案件已保存 · 材料本地保存</span><h2>案件材料</h2><p>${escapeHtml(factsSummary(current))}</p><p>上传后系统提取内容并提出建议关联。请对照原件确认；确认记录不代表法院认定真实。</p><button class="primary-button" data-upload ${running ? 'disabled' : ''}>上传案件材料</button><p>优先上传与你的案件对应的付款、约定、履行和沟通原始记录，以及已知交易对象的信息。材料可选上传；缺少的信息仍可在研究和草稿中保留待补。</p><p>支持 PNG / JPG / JPEG / PDF / TXT / MD，每份最多 10MB。TXT/MD 需 UTF-8；文字 PDF 可提取正文。${preliminary ? 'PNG/JPG 可使用本机离线中文识别；识别失败时会提示补充文字。扫描 PDF 暂需登记原文。' : '图片、扫描 PDF 不自动 OCR，需对照原件人工登记。'}DOCX / XLSX / CSV 暂不支持。</p></article><section class="workspace-intro" id="fact-review"><h3>核对提取的事实</h3>${current.case.facts.concat(current.case.disputedFacts).map(f => editingFactId === f.id ? `<div class="fact-editor"><p>原事实：${escapeHtml(f.content)}</p><label>修改事实陈述<textarea id="edit-fact-content" rows="3" maxlength="20000">${escapeHtml(f.content)}</textarea></label><button data-save-fact="${escapeHtml(f.id)}">保存事实</button><button data-cancel-fact>取消</button><p>保存后相关材料关联需重新核对；不会自动研究或生成报告。</p></div>` : `<p>${escapeHtml(f.content)} <button data-edit-fact="${escapeHtml(f.id)}" ${running ? 'disabled' : ''}>修改</button> <button data-remove-fact="${escapeHtml(f.id)}" ${running ? 'disabled' : ''}>移除</button></p>`).join('')}<label>补充事实<textarea id="new-fact-content" maxlength="20000"></textarea></label><label>类别<select id="new-fact-category"><option value="EVENT">案件经过</option><option value="PARTY">身份信息</option><option value="CONTRACT">约定</option><option value="PAYMENT">款项</option><option value="COMMUNICATION">沟通</option><option value="DISPUTE">争议或抗辩</option><option value="OTHER">其他</option></select></label><button data-add-fact ${running ? 'disabled' : ''}>保存补充事实</button><p>确认表示提取内容符合你的当前陈述，不表示事实已被证明。修改或补充后需要重新核对；可能影响法律分析的变化会提示重新研究。</p><button data-confirm-facts ${current.factsConfirmed || running ? 'disabled' : ''}>${current.factsConfirmed ? '事实陈述已核对' : '我已核对上述事实陈述'}</button></section><section class="workspace-intro"><h3>现在最需要补什么</h3>${gapsHtml()}</section><section class="workspace-intro" aria-live="polite"><h3>法律研究与报告</h3><p>${preliminary ? '可直接生成初步分析；核对事实与补充材料可在之后进行。' : !current.factsConfirmed ? '下一步：核对并确认提取的事实。' : pending ? `下一步：还有 ${pending} 份待核对材料，请确认或排除。` : running ? '正在研究，材料暂时锁定；完成后可显式重新生成报告。' : '可点击右上角启动法律研究；未补充的材料仍作为证据缺口。'}</p><div id="research-progress">${researchProgressHtml(current)}</div>${savedReportControls()}<p>${!preliminary && current.researchRun?.status === 'SAVED' ? '研究结果已保存；请核对研究与材料边界。' : ''}${preliminary ? '' : escapeHtml(current.answerReport.sections[1]?.blocks[0]?.text ?? '')}</p>${reportLinks()}<p>研究结果保存不代表法律依据充分，请查看报告中的研究边界和证据缺口。</p></section>`
  document.querySelector('[data-tab="evidence"] span').textContent = current.evidence.items.filter(e => e.file).length
  document.querySelector('[data-tab="facts"] span').textContent = current.case.facts.length
  document.querySelector('[data-tab="law"] span').textContent = current.conditionalResearch?.sources.length ?? current.actionReport?.legalBasis.length ?? 0
  if (preliminary) {
    document.querySelector('[data-tab="law"] span').textContent = new Set(current.preliminary?.analysis.findings.flatMap(f => f.citations.map(c => c.sourceId)) ?? []).size
    if (current.preliminaryReport) {
      const saved = current.latestReport?.mode === 'PRELIMINARY'
      const previewUrl = saved ? `${casePath()}/report-versions/${current.latestReport.reportVersionId ?? 'latest'}?kind=user` : `${casePath()}/reports/user`
      document.querySelector('#thread').insertAdjacentHTML('afterbegin', `<article class="workspace-intro"><h2>法律分析报告</h2><div class="report-toolbar" role="group" aria-label="报告预览与下载"><a class="secondary-button" href="${previewUrl}" target="_blank" rel="noopener">查看完整报告</a>${saved ? `<a class="primary-button" href="${previewUrl}&format=pdf" target="_blank" rel="noopener" aria-label="下载初步法律分析报告 PDF">下载 PDF</a>` : ''}</div>${preliminaryStatusHtml(current)}<p>预览与下载报告使用同一份内容。</p><iframe class="case-report-preview" title="初步法律分析报告预览" src="${previewUrl}" sandbox="allow-same-origin allow-popups"></iframe></article>`)
    }
    if (current.preliminaryNeedsRefresh) document.querySelector('#thread').insertAdjacentHTML('afterbegin', '<p role="alert">案情或材料已变化，请重新生成初步分析。保存的旧报告仅供历史查阅。</p>')
  }
}
function renderInspector() {
  document.querySelectorAll('.inspector-tab').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === activeTab); b.setAttribute('aria-selected', String(b.dataset.tab === activeTab))
  })
  if (!current) { inspectorContent.innerHTML = '<p class="empty-state">输入案情创建案件后，这里显示事实和材料状态。</p>'; return }
  if (activeTab === 'facts') {
    inspectorContent.innerHTML = `<section class="inspector-section"><h3>事实与材料关联</h3>${[...current.case.facts, ...current.case.disputedFacts].map(f => {
      const links = current.evidence.links.filter(l => l.factId === f.id && l.status !== 'CANCELLED')
      const certainty = { USER_CLAIM: '用户陈述', DISPUTED: '存在争议', UNKNOWN: '尚待核对', CONFIRMED: '提取时标记已确认（未作证据认定）' }
      const support = current.assessment.factSupports.find(s => s.factId === f.id)?.status ?? 'UNKNOWN'
      return `<div class="fact-row"><span class="fact-index">${escapeHtml(f.id)}</span><div><p>${escapeHtml(f.content)}</p><small>${escapeHtml(certainty[f.certainty])}</small><p>${supportLabels[support]}</p>${links.map(l => `<p>${l.status === 'SUGGESTED' ? '建议关联（未确认）' : '用户确认内容关联'}：${escapeHtml(current.evidence.items.find(e => e.id === l.evidenceId)?.title)}（${l.support === 'PARTIAL' ? '部分支持' : '用户登记支持'}）</p>`).join('') || '<p>尚无材料关联</p>'}</div></div>`
    }).join('')}</section>`
  } else if (activeTab === 'evidence') {
    const uploaded = current.evidence.items.filter(e => e.file)
    inspectorContent.innerHTML = `<section class="inspector-section"><div class="section-head"><h3>案件材料</h3><button data-upload>＋ 上传</button></div>${uploaded.map(e => {
      const links = current.evidence.links.filter(l => l.evidenceId === e.id && l.status !== 'CANCELLED')
      const recheck = links.some(l => l.status === 'SUGGESTED') && e.file.confirmationStatus === 'CONFIRMED'
      const gaps = current.assessment.workspaceGaps.filter(g => g.evidenceIds.includes(e.id))
      return `<div class="source-card" data-evidence-id="${e.id}"><h4>${escapeHtml(e.title)}</h4>${materialNotice(e)}<p>${escapeHtml(current.materialLabels[e.id])}</p>${recheck ? '<p role="alert">材料内容已确认，但当前事实关联已撤销 / 需重新核对。请打开材料撤销确认，再核对关联。</p>' : ''}<p>${escapeHtml(e.file.summary ?? '文件已收到，内容尚未读取')}</p><small>${escapeHtml(e.file.filename)} · ${e.file.fileSize} 字节</small><p>${links.some(l => l.status === 'CONFIRMED') ? '用户确认关联' : '可能支持'}：</p>${links.length ? links.map(l => `<p>${escapeHtml(current.case.facts.concat(current.case.disputedFacts).find(f => f.id === l.factId)?.content)}</p>`).join('') : '<p>尚无事实关联</p>'}<p>支持的材料缺口：${gaps.length ? gaps.map(g => escapeHtml(g.title) + '（' + labels[g.status] + '）').join('、') : '尚无已确认支持'}</p><div class="material-actions"><button data-view="${e.id}">${e.content ? '查看原文 / 核对关联' : '查看原件 / 人工登记'}</button>${e.file.parseStatus === 'UPLOADED' ? `<button data-parse="${e.id}">解析</button>` : ''}<button data-delete="${e.id}">删除</button></div></div>`
    }).join('') || '<p>尚未上传材料。</p>'}<h3>原陈述中的材料登记</h3>${current.evidence.items.filter(e => !e.file).map(e => `<p>${escapeHtml(e.title ?? e.type)}：${uploaded.some(u => u.type === e.type && u.file.confirmationStatus !== 'REJECTED') ? '已有导入材料，见上方内容及关联记录' : '仅登记，原件尚未导入'}</p>`).join('') || '<p>无手工登记材料</p>'}</section>`
  } else if (activeTab === 'report') {
    if (current.latestReport?.mode === 'PRELIMINARY') reportAudience = 'user'
    const reportUrl = current.latestReport ? `${casePath()}/report-versions/${current.latestReport?.reportVersionId ?? 'latest'}?kind=${reportAudience}` : `${casePath()}/reports/${reportAudience}`
    if (current.preliminaryReport) {
      const preliminaryUrl = current.latestReport?.mode === 'PRELIMINARY' ? `${casePath()}/report-versions/${current.latestReport?.reportVersionId ?? 'latest'}?kind=user` : `${casePath()}/reports/user`
      inspectorContent.innerHTML = `<section class="inspector-section"><h3>法律分析报告</h3>${preliminaryStatusHtml(current)}${reportLinks()}<iframe class="case-report-preview" title="用户法律分析报告预览" src="${preliminaryUrl}" sandbox="allow-same-origin allow-popups"></iframe></section>`
    } else inspectorContent.innerHTML = `<section class="inspector-section"><h3>${current.latestReport?.mode === 'PRELIMINARY' ? '初步法律分析报告' : '案件双视图报告'}</h3>${reportLinks()}${reportAudience === 'user' ? `<p class="report-stage">当前分析阶段：${escapeHtml(current.answerReport.stage)}</p><p>案件陈述、材料及研究补充后，显式重新生成可保存成长后的报告。</p><a href="${casePath()}/reports/continuation" target="_blank" rel="noopener">查看当前信息预览（尚未保存为新版本）</a>` : ''}<iframe class="case-report-preview" title="${reportAudience === 'user' ? '用户分析摘要预览' : '完整深度研究报告预览'}" src="${reportUrl}" sandbox="allow-same-origin allow-popups"></iframe><button data-attach-research ${current.researchRun?.status === 'RUNNING' ? 'disabled' : ''}>接入此案件已有研究成果</button><p>接入前核对同一案件与材料快照；不会自动研究或确认材料。保存的报告版本不会随编辑改变；重新生成后查看最新版。</p></section>`
  } else {
    inspectorContent.innerHTML = '<section class="inspector-section legal-context-panel"><h3>相关法律与证据详情</h3><p>法源效力与本案适用仍待系统复核；你可补充具体事实和材料。</p><iframe class="case-report-preview" title="法律依据与证据关系" sandbox="allow-same-origin allow-popups" src="'+casePath()+'/legal-context?mode='+analysisMode+'"></iframe></section>'
  }
}
function openMaterial(id) {
  const e = current.evidence.items.find(e => e.id === id), pending = e.file.confirmationStatus === 'PENDING'
  const links = current.evidence.links.filter(l => l.evidenceId === id)
  materialDialog.dataset.evidenceId = id
  materialDialog.innerHTML = `<form id="material-form" class="dialog-card"><div class="dialog-header"><h2>${escapeHtml(e.title)}</h2><button type="button" data-close aria-label="关闭">×</button></div>${materialNotice(e)}<p>${escapeHtml(current.materialLabels[id])}</p><a href="${materialPath(id)}/original">下载原文件对照核对</a><details><summary>文件校验信息</summary><p>SHA256：${escapeHtml(e.file.hash)}</p></details><h3>提取字段（仅登记原文）</h3>${Object.entries(e.file.fields).map(([k,v]) => `<p><strong>${escapeHtml(fieldNames[k] ?? k)}：</strong>${escapeHtml(v)}</p>`).join('') || '<p>未可靠提取字段</p>'}<p>${escapeHtml(e.file.reviewReasons.join('；'))}</p><label>材料原文 / 人工核对登记<textarea id="material-text" rows="8" ${pending ? '' : 'readonly'}>${escapeHtml(e.content ?? '')}</textarea></label>${pending ? '<label>材料类别<select id="material-type"><option value="PAYMENT_RECORD">微信转账记录</option><option value="CHAT_RECORD">微信聊天记录</option><option value="OTHER">身份/账号或其他材料</option></select></label><button type="button" data-save-text>登记/修正原文并重新提取</button>' : ''}<h3>系统认为这份材料可能支持以下事实：</h3><p>可勾选确认、取消勾选或修改原文及支持程度。事实本身不会自动变成已证明。</p>${current.case.facts.concat(current.case.disputedFacts).map(f => {
    const link = links.find(l => l.factId === f.id), selected = link && link.status !== 'CANCELLED'
    return `<div class="link-editor" data-fact-id="${escapeHtml(f.id)}"><label><input type="checkbox" class="link-enabled" ${selected ? 'checked' : ''} ${pending ? '' : 'disabled'}>${escapeHtml(f.content)}</label><label>对应原文<textarea class="link-quote" rows="2" ${pending ? '' : 'readonly'}>${escapeHtml(link?.quote ?? '')}</textarea></label><label>内容支持程度<select class="link-support" ${pending ? '' : 'disabled'}><option value="PARTIAL">部分支持 / 尚需核对</option><option value="SUPPORTED" ${link?.support === 'SUPPORTED' ? 'selected' : ''}>用户核对后登记完整内容支持</option></select></label></div>`
  }).join('')}<label><input id="context-complete" type="checkbox" ${e.file.contextComplete ? 'checked' : ''} ${pending ? '' : 'disabled'}>我已对照原件核对，上下文完整；上述提取内容可作为案件材料记录</label><p>确认内容不等于真实性鉴定，不等于法院认定真实。</p><div class="dialog-actions">${pending ? '<button type="button" data-reject>标记无关 / 提取错误</button><button type="submit" class="primary-button">确认材料及选中的关联</button>' : '<button type="button" data-reopen>撤销确认 / 修改关联</button>'}</div></form>`
  if (pending) document.querySelector('#material-type').value = ['PAYMENT_RECORD', 'CHAT_RECORD'].includes(e.type) ? e.type : 'OTHER'
  if (!materialDialog.open) materialDialog.showModal()
}
async function refresh() { await selectCase(selectedKey) }
document.addEventListener('click', event => {
  const button = event.target.closest('button')
  if (!button || busy || loading) return
  if (button.dataset.reportAudience) { reportAudience = button.dataset.reportAudience; renderMain(); renderInspector() }
  else if (button.hasAttribute('data-attach-research')) { importIntoCurrent = true; document.querySelector('#research-import').click() }
  else if (button.hasAttribute('data-import')) { importIntoCurrent = false; document.querySelector('#research-import').click() }
  else if (button.hasAttribute('data-regenerate-report')) run(async () => {
    button.disabled = true
    try { await post(`${casePath()}/reports/regenerate`, {mode:analysisMode}); await refresh(); showToast('新报告版本已保存，旧版本保留；未自动启动法律研究') }
    finally { button.disabled = false }
  })
  else if (button.hasAttribute('data-cancel-research')) run(async () => {
    await post(`${casePath()}/research/cancel`, {}); showToast('正在取消；已完成题和材料保留'); await refresh()
  })
  else if (button.hasAttribute('data-fresh-research')) run(async () => {
    await post(`${casePath()}/research`, { fresh: true, mode:analysisMode }); await refresh(); showToast('所选模式完整重跑已启动')
  })
  else if (button.hasAttribute('data-add-fact')) run(async () => {
    await post(`${casePath()}/facts`, { operation: 'ADD', content: document.querySelector('#new-fact-content').value, category: document.querySelector('#new-fact-category').value }); await refresh()
  })
  else if (button.dataset?.editFact) { editingFactId = button.dataset.editFact; renderMain(); document.querySelector('#edit-fact-content').focus() }
  else if (button.hasAttribute('data-cancel-fact')) { editingFactId = undefined; renderMain() }
  else if (button.dataset?.saveFact) run(async () => {
    const fact = current.case.facts.concat(current.case.disputedFacts).find(f => f.id === button.dataset.saveFact)
    const content = document.querySelector('#edit-fact-content').value.trim()
    if (!content) throw new Error('事实内容不能为空')
    if (content === fact.content) { editingFactId = undefined; return }
    await post(`${casePath()}/facts`, { operation: 'UPDATE', factId: fact.id, content, category: fact.category })
    editingFactId = undefined; await refresh()
    showToast('Fact 已变化：相关材料关联需重新核对；请显式重新生成报告。未自动研究或生成报告')
  })
  else if (button.dataset?.removeFact) run(async () => {
    if (!window.confirm('从当前案件移除此事实？旧报告与旧研究记录仍保留。')) return
    await post(`${casePath()}/facts`, { operation: 'DELETE', factId: button.dataset?.removeFact }); await refresh()
  })
  else if (button.hasAttribute('data-review-facts')) document.querySelector('#fact-review')?.scrollIntoView({ behavior: 'smooth' })
  else if (button.hasAttribute('data-confirm-facts')) run(async () => { await post(`${casePath()}/facts/confirm`, {}); await refresh() })
  else if (button.hasAttribute('data-upload')) {
    if (!current) { showToast('请先输入案情创建案件'); return }
    document.querySelector('#material-upload').click()
  } else if (button.dataset.view) openMaterial(button.dataset.view)
  else if (button.dataset.parse) run(async () => { await post(`${materialPath(button.dataset.parse)}/parse`, {}); await refresh() })
  else if (button.dataset.delete) run(async () => { await api(materialPath(button.dataset.delete), { method: 'DELETE' }); await refresh(); showToast('材料已删除，关联与缺口已重新计算') })
  else if (button.hasAttribute('data-close')) materialDialog.close()
  else if (button.hasAttribute('data-save-text')) run(async () => {
    const id = materialDialog.dataset.evidenceId
    await post(`${materialPath(id)}/parse`, { text: document.querySelector('#material-text').value, type: document.querySelector('#material-type').value })
    await refresh(); openMaterial(id); showToast('已登记原文，建议关联重新计算；仍需用户确认')
  })
  else if (button.hasAttribute('data-reject')) run(async () => {
    await post(`${materialPath(materialDialog.dataset.evidenceId)}/decision`, { decision: 'REJECTED', contextComplete: false, links: [] })
    materialDialog.close(); await refresh()
  })
  else if (button.hasAttribute('data-reopen')) run(async () => {
    const id = materialDialog.dataset.evidenceId; await post(`${materialPath(id)}/reopen`, {}); await refresh(); openMaterial(id)
  })
})
materialDialog.addEventListener('submit', event => {
  event.preventDefault(); run(async () => {
    const links = [...materialDialog.querySelectorAll('.link-editor')].filter(row => row.querySelector('.link-enabled').checked).map(row => ({ factId: row.dataset.factId,
      quote: row.querySelector('.link-quote').value, support: row.querySelector('.link-support').value }))
    await post(`${materialPath(materialDialog.dataset.evidenceId)}/decision`, { decision: 'CONFIRMED', contextComplete: document.querySelector('#context-complete').checked, links })
    materialDialog.close(); await refresh(); showToast(current.actionReport ? '材料与关联已确认，缺口已重算；请点击重新生成报告保存新版本' : '材料与关联已保存，核对事实后可启动研究')
  })
})
document.querySelector('#material-upload').addEventListener('change', event => run(async () => {
  const file = event.target.files[0]; event.target.value = ''; if (!file) return
  if (file.size > 10 * 1024 * 1024) throw new Error('每份材料最多10MB')
  const uploaded = await api(`${casePath()}/materials`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream',
    'x-file-name': encodeURIComponent(file.name), 'x-file-mime': file.type }, body: file })
  await refresh()
  try { await post(`${materialPath(uploaded.evidenceId)}/parse`, {}); await refresh() }
  catch (error) { await refresh(); showToast(`文件已保存；解析失败：${error.message}`) }
  if (current.defaultResearchMode === 'PRELIMINARY' && current.evidence.items.find(e => e.id === uploaded.evidenceId)?.content) showToast('材料文字已读取，可直接生成分析报告。')
  else openMaterial(uploaded.evidenceId)
}))
document.querySelector('#research-import').addEventListener('change', event => run(async () => {
  const file = event.target.files[0]; event.target.value = ''; if (!file) return
  if (file.size > 50 * 1024 * 1024) throw new Error('研究 JSON 最大50MB')
  const body = JSON.parse(await file.text())
  if (importIntoCurrent) {
    importIntoCurrent = false
    await post(`${casePath()}/research/import`, body); await refresh(); showToast('已有成果已接入，旧研究归档；请显式重新生成双视图报告。未运行研究')
    return
  }
  const imported = await post('/api/cases/import', body)
  cases = await api('/api/cases'); await selectCase(imported.key); showToast('已有研究已导入，未运行法律研究')
}))
document.querySelector('#new-case').addEventListener('click', () => { if (!busy && !loading) newCase() })
document.querySelector('#import-research').addEventListener('click', () => { importIntoCurrent = false; document.querySelector('#research-import').click() })
document.querySelector('[aria-label="添加附件"]').addEventListener('click', () => {
  if (busy || loading) return
  if (current) document.querySelector('#material-upload').click(); else showToast('请先输入案情创建案件')
})
caseList.addEventListener('click', event => { const item = event.target.closest('[data-key]'); if (item) run(() => selectCase(item.dataset.key)) })
document.querySelector('#case-search').addEventListener('input', renderCases)
document.querySelectorAll('.inspector-tab').forEach(b => b.addEventListener('click', () => { activeTab = b.dataset.tab; renderInspector() }))
document.querySelector('#toggle-inspector').addEventListener('click', () => {
  const open = document.querySelector('#inspector').classList.toggle('open')
  document.querySelector('#toggle-inspector').setAttribute('aria-expanded', String(open))
  if (open) document.querySelector('#close-inspector').focus()
})
document.querySelector('#close-inspector').addEventListener('click', () => {
  document.querySelector('#inspector').classList.remove('open')
  document.querySelector('#toggle-inspector').setAttribute('aria-expanded', 'false')
  document.querySelector('#toggle-inspector').focus()
})
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && document.querySelector('#inspector').classList.contains('open') && !materialDialog.open) document.querySelector('#close-inspector').click()
})
document.querySelector('#mobile-case-select').addEventListener('change', event => run(() => selectCase(event.target.value)))
document.querySelector('#composer').addEventListener('submit', event => {
  event.preventDefault(); if (current) return
  run(async () => {
    const rawCase = document.querySelector('#message-input').value.trim()
    if (!rawCase) throw new Error('请先输入案情')
    showToast('正在提取事实，请稍候…')
    const input = document.querySelector('#message-input')
    input.readOnly = true; document.querySelector('.send-button').disabled = true
    document.querySelector('#case-title').textContent = '正在提取事实，请稍候…'
    try {
      const created = await post('/api/cases', { rawCase, mode:analysisMode })
      storedMode(created.key,analysisMode)
      cases = await api('/api/cases'); await selectCase(created.key,analysisMode); showToast('案件已保存，可按所选模式启动分析')
    } catch (error) {
      document.querySelector('#case-title').textContent = '创建未完成，请查看提示后重试'
      throw error
    } finally { input.readOnly = false; document.querySelector('.send-button').disabled = Boolean(current) }
  })
})
let controlledAcceptance
document.querySelector('#analysis-mode').addEventListener('change', event => {
  analysisMode=event.target.value
  if(current){storedMode(selectedKey,analysisMode);reportAudience=analysisMode==='STRICT'?'internal':'user';void run(refresh)}
})
document.querySelector('#run-research').addEventListener('click', () => run(async () => {
  if (!current) throw new Error('请先输入案情创建案件')
  try { await post(`${casePath()}/research`, controlledAcceptance ? { mode: controlledAcceptance.mode==='FULL_CASE_ACCEPTANCE'?'FULL_CASE_ACCEPTANCE':'SINGLE_QUESTION_ACCEPTANCE' } : {mode:analysisMode}); if (controlledAcceptance) controlledAcceptance.used = true; showToast(controlledAcceptance ? '受控验收已启动；严格通过后保存双报告' : current.defaultResearchMode === 'PRELIMINARY' ? '初步分析已启动，完成后自动保存并导出报告' : '深度研究已启动，完成后自动保存详细报告') }
  finally { await refresh() }
}))
run(async () => {
  const [health, acceptance] = await Promise.all([api('/health'), api('/api/controlled-acceptance')])
  showExecutionMode(health.executionMode)
  controlledAcceptance = acceptance
  if (controlledAcceptance) {
    const notice = document.createElement('p')
    notice.textContent = `TEST DATA · ${controlledAcceptance.mode==='FULL_CASE_ACCEPTANCE'?'整案六题':`受控 ${controlledAcceptance.questionId}`} · 最多${controlledAcceptance.modelHttpMax}模型HTTP / ${controlledAcceptance.totalTokensMax} Token / US$${controlledAcceptance.usdMax} / ${controlledAcceptance.durationMs/1000}秒 · ${controlledAcceptance.executionMode==='OFFLINE_HISTORY_REPLAY'?'离线历史回放，付费HTTP0':controlledAcceptance.authorized ? '已启用本次独立授权' : '零付费预检，未授权 LIVE'}`
    document.querySelector('#thread').before(notice)
    if(controlledAcceptance.mode!=='FULL_CASE_ACCEPTANCE')document.querySelector('.send-button').disabled = true
  }
  cases = await api('/api/cases'); renderCases(); if (cases.length) { const key = globalThis.location?.hash?.slice(6); await selectCase(cases.find(c => c.key === key)?.key ?? cases[0].key) } else {newCase();if(controlledAcceptance?.mode==='FULL_CASE_ACCEPTANCE'){document.querySelector('#message-input').value=controlledAcceptance.rawCase;document.querySelector('.send-button').disabled=!controlledAcceptance.authorized}}
})
