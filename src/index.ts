import { buildWorkbenchApp } from './workbench/server.js'

const port = Number(process.env.PORT ?? 3210)
const app = buildWorkbenchApp({ evidenceRoot: process.env.EVIDENCE_WORKSPACE_ROOT,
  siteOrigin: process.env.WORKBENCH_SITE_ORIGIN })

try {
  await app.listen({ host: '127.0.0.1', port })
  console.log(`Chinese Legal Research Agent workbench: http://127.0.0.1:${port}`)
} catch (error) {
  app.log.error(error)
  process.exitCode = 1
}
