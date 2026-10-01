export interface MediaLimits {
  maxWidth: number
  maxHeight: number
  maxFps: number
  maxBitrateBps: number
  maxSessionSeconds: number
}

export interface DeploymentProfile {
  name: 'owner' | 'playground'
  enabled: boolean
  limits: MediaLimits
}

const PROFILES: Record<string, DeploymentProfile> = {
  owner: {
    name: 'owner',
    enabled: true,
    limits: {
      maxWidth: 1920,
      maxHeight: 1080,
      maxFps: 30,
      maxBitrateBps: 8_000_000,
      maxSessionSeconds: 8 * 60 * 60,
    },
  },
  playground: {
    name: 'playground',
    enabled: true,
    limits: {
      maxWidth: 1280,
      maxHeight: 720,
      maxFps: 30,
      maxBitrateBps: 3_000_000,
      maxSessionSeconds: 30 * 60,
    },
  },
}

export function getDeploymentProfile(name: string | undefined): DeploymentProfile | null {
  return name ? PROFILES[name] ?? null : null
}

export function rejectDisabledDeployment(name: string | undefined): Response | null {
  const profile = getDeploymentProfile(name)
  if (profile?.enabled) return null
  return new Response('Deployment profile is disabled', {
    status: 503,
    headers: { 'Cache-Control': 'no-store' },
  })
}
