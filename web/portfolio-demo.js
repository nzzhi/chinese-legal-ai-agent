;(async () => {
  try {
    const response = await fetch('/api/demo')
    if (!response.ok) return
    const demo = await response.json()
    if (typeof demo.statement !== 'string' || demo.model !== 'AUTHORED_SUBSTITUTE') return
    document.querySelector('.mock-label').textContent = '固定合成案例 · 模型替身 · 效力未核'
    document.querySelector('.disclaimer').textContent = 'OFFLINE：合成案情与人工编写替身，零付费调用。法条效力 UNKNOWN；不代表真实模型或法律质量。'
    const button = document.createElement('button')
    button.className = 'secondary-button'
    button.textContent = '填入模拟案情'
    button.type = 'button'
    button.addEventListener('click', () => {
      document.querySelector('#new-case').click()
      document.querySelector('#message-input').value = demo.statement
      document.querySelector('#message-input').focus()
    })
    document.querySelector('.composer').prepend(button)
  } catch { /* Real-model mode has no demo endpoint. */ }
})()
