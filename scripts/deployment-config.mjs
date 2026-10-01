import { access, readFile, writeFile, mkdir } from 'node:fs/promises'
import { constants } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const publicConfig = resolve(projectRoot, 'wrangler.jsonc')
const opsDirectory = process.env.STREAMLINE_OPS_DIR

export const sourceWranglerConfig = opsDirectory
  ? resolve(projectRoot, opsDirectory, 'wrangler.jsonc')
  : publicConfig

export async function readDeploymentConfig() {
  try {
    await access(sourceWranglerConfig, constants.R_OK)
  } catch {
    throw new Error(`Wrangler configuration not found: ${sourceWranglerConfig}`)
  }
  return JSON.parse(await readFile(sourceWranglerConfig, 'utf8'))
}

export async function writeDeploymentHosts() {
  const config = await readDeploymentConfig()
  const origins = [config.vars?.ALLOWED_ORIGINS]
  for (const profile of Object.values(config.env ?? {})) origins.push(profile.vars?.ALLOWED_ORIGINS)
  const hosts = [...new Set(origins.filter((origin) => typeof origin === 'string').map((origin) => new URL(origin).hostname))]
  if (hosts.length === 0) throw new Error('Wrangler configuration must define at least one ALLOWED_ORIGINS value')

  const generatedDirectory = resolve(projectRoot, 'src/generated')
  await mkdir(generatedDirectory, { recursive: true })
  await writeFile(
    resolve(generatedDirectory, 'deployment-hosts.ts'),
    `// Generated from the active Wrangler configuration. Do not commit.\nexport const deploymentRelayHosts = ${JSON.stringify(hosts)} as const\n`,
  )
}
