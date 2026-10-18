import { resolve, join } from 'node:path'
import { buildWorkbenchApp } from '../workbench/server.js'
import { createDemoRuntime, demoStatement } from './runtime.js'

const root = resolve(process.env.DEMO_WORKSPACE_ROOT ?? '.local/portfolio-demo')
const port = Number(process.env.DEMO_PORT ?? 3211)
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('DEMO_PORT must be 1024..65535')
const app = buildWorkbenchApp({ evidenceRoot: join(root, 'workspace'), runtimeFactory: createDemoRuntime(root), executionMode: 'OFFLINE' })
app.get('/api/demo', async () => ({ statement: demoStatement, model: 'AUTHORED_SUBSTITUTE', validity: 'UNKNOWN', paidCalls: 0 }))
await app.listen({ host: '127.0.0.1', port })
console.log(`OFFLINE portfolio demo: http://127.0.0.1:${port} — synthetic input, authored substitute, no paid calls`)
const stop = async () => { await app.close() }
process.once('SIGINT', () => void stop())
process.once('SIGTERM', () => void stop())
