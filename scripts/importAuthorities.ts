import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { AuthorityCorpus } from '../src/authority/authorityCorpus.js'
import { importOfficialAuthorities, readAuthoritySeeds, authorityImportErrorChain } from '../src/authority/authorityImporter.js'
import { importAuthoritySnapshotFile } from '../src/authority/authoritySnapshotImporter.js'

const args = process.argv.slice(2)
let manifest = 'config/authority-seeds.json', limit = 12, snapshotManifest: string | undefined
for (let index = 0; index < args.length; index += 2) {
  const flag = args[index], value = args[index + 1]
  if (!value || !['--manifest', '--limit', '--snapshot-manifest'].includes(flag!)) throw new Error('Usage: importAuthorities.ts [--manifest path] [--limit 1..12] OR --snapshot-manifest path')
  if (flag === '--manifest') manifest = value
  else if (flag === '--snapshot-manifest') snapshotManifest = value
  else limit = Number(value)
}
if (snapshotManifest && args.some(arg => ['--manifest', '--limit'].includes(arg))) {
  throw new Error('Local snapshot mode must not be combined with network manifest/budget options')
}
const sources = JSON.parse(readFileSync(resolve('config/authority-sources.json'), 'utf8'))
const dbPath = resolve(process.env.LEGAL_AUTHORITY_DB_PATH ?? '.local/legal-authority/authority.sqlite')
const corpus = new AuthorityCorpus(dbPath, { sources })
try {
  const result = snapshotManifest ? (() => {
    try { return { requests: 0, limit: 0, outcomes: [importAuthoritySnapshotFile(corpus, snapshotManifest)] } }
    catch (error) {
      const errorChain = authorityImportErrorChain(error)
      return { requests: 0, limit: 0, outcomes: [{ status: 'FAILED',
        reason: errorChain[0].message, diagnostic: { stage: 'LOCAL_SNAPSHOT', requests: [], errorChain } }] }
    }
  })() : await importOfficialAuthorities(corpus, readAuthoritySeeds(resolve(manifest)), { sources, limit })
  const savedAt = new Date().toISOString()
  const reportPath = resolve(dirname(dbPath), `import-${savedAt.replace(/[:.]/gu, '-')}.json`)
  mkdirSync(dirname(reportPath), { recursive: true })
  const diagnostic = { savedAt, dbPath, mode: snapshotManifest ? 'LOCAL_SNAPSHOT' : 'BOUNDED_HTTP',
    manifest: resolve(snapshotManifest ?? manifest), ...result }
  writeFileSync(reportPath, JSON.stringify(diagnostic, null, 2), 'utf8')
  console.log(JSON.stringify({ ...diagnostic, reportPath }, null, 2))
  if (result.outcomes.some(item => ['FAILED', 'ACCESS_RESTRICTED', 'NOT_EXECUTED'].includes(item.status))) process.exitCode = 1
} finally { corpus.close() }
