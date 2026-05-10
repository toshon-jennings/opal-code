import { execa } from 'execa'
import { readFile, realpath } from 'fs/promises'
import { homedir } from 'os'
import { delimiter, join, posix, win32 } from 'path'
import { checkGlobalInstallPermissions } from './autoUpdater.js'
import { isInBundledMode } from './bundledMode.js'
import {
  formatAutoUpdaterDisabledReason,
  getAutoUpdaterDisabledReason,
  getGlobalConfig,
  type InstallMethod,
} from './config.js'
import { getCwd } from './cwd.js'
import { getClaudeConfigHomeDir, isEnvTruthy } from './envUtils.js'
import { execFileNoThrow } from './execFileNoThrow.js'
import { getFsImplementation } from './fsOperations.js'
import {
  getDetectedLocalInstallDir,
  getShellType,
  isRunningFromLocalInstallation,
  localInstallationExists,
} from './localInstaller.js'
import {
  detectApk,
  detectAsdf,
  detectDeb,
  detectHomebrew,
  detectMise,
  detectPacman,
  detectRpm,
  detectWinget,
  getPackageManager,
} from './nativeInstaller/packageManagers.js'
import { getPlatform } from './platform.js'
import { getRipgrepStatus } from './ripgrep.js'
import {
  DEFAULT_ATOMIC_CHAT_BASE_URL,
  DEFAULT_OLLAMA_BASE_URL,
  getAtomicChatChatBaseUrl,
  getOllamaChatBaseUrl,
  listOpenAICompatibleModels,
  probeAtomicChatReadiness,
  probeOllamaGenerationReadiness,
} from './providerDiscovery.js'
import { getProviderProfiles } from './providerProfiles.js'
import { SandboxManager } from './sandbox/sandbox-adapter.js'
import { getManagedFilePath } from './settings/managedPath.js'
import { CUSTOMIZATION_SURFACES } from './settings/types.js'
import {
  findClaudeAlias,
  findValidClaudeAlias,
  getShellConfigPaths,
} from './shellConfig.js'
import { jsonParse } from './slowOperations.js'
import { which } from './which.js'
import { probeRouteReadiness } from '../integrations/discoveryService.js'
import { getRouteLabel, resolveRouteIdFromBaseUrl } from '../integrations/routeMetadata.js'
import { resolveProviderRequest } from '../services/api/providerConfig.js'

function getCliBinaryName(): string {
  return MACRO.PACKAGE_URL === '@anthropic-ai/claude-code'
    ? 'claude'
    : 'opalcode'
}

function getNativeDataDirName(): string {
  return getCliBinaryName()
}

export type InstallationType =
  | 'npm-global'
  | 'npm-local'
  | 'native'
  | 'package-manager'
  | 'development'
  | 'unknown'

export type DiagnosticInfo = {
  installationType: InstallationType
  version: string
  installationPath: string
  invokedBinary: string
  configInstallMethod: InstallMethod | 'not set'
  autoUpdates: string
  hasUpdatePermissions: boolean | null
  multipleInstallations: Array<{ type: string; path: string }>
  warnings: Array<{ issue: string; fix: string }>
  recommendation?: string
  packageManager?: string
  ripgrepStatus: {
    working: boolean
    mode: 'system' | 'builtin' | 'embedded'
    systemPath: string | null
  }
  systemDependencies: Array<{
    name: string
    command: string
    status: 'ok' | 'missing' | 'warning'
    detail?: string
  }>
  providerHealth: Array<{
    label: string
    source: 'saved-profile' | 'active-env'
    endpoint?: string
    model?: string
    status:
      | 'ready'
      | 'unreachable'
      | 'no_models'
      | 'generation_failed'
      | 'unsupported'
    detail?: string
  }>
  localLlmHealth: Array<{
    label: string
    endpoint: string
    status:
      | 'ready'
      | 'unreachable'
      | 'no_models'
      | 'generation_failed'
      | 'unsupported'
    detail?: string
  }>
}

function getNormalizedPaths(): [invokedPath: string, execPath: string] {
  let invokedPath = process.argv[1] || ''
  let execPath = process.execPath || process.argv[0] || ''

  // On Windows, convert backslashes to forward slashes for consistent path matching
  if (getPlatform() === 'windows') {
    invokedPath = invokedPath.split(win32.sep).join(posix.sep)
    execPath = execPath.split(win32.sep).join(posix.sep)
  }

  return [invokedPath, execPath]
}

export async function getCurrentInstallationType(): Promise<InstallationType> {
  if (process.env.NODE_ENV === 'development') {
    return 'development'
  }

  const [invokedPath] = getNormalizedPaths()

  // Check if running in bundled mode first
  if (isInBundledMode()) {
    // Check if this bundled instance was installed by a package manager
    if (
      detectHomebrew() ||
      detectWinget() ||
      detectMise() ||
      detectAsdf() ||
      (await detectPacman()) ||
      (await detectDeb()) ||
      (await detectRpm()) ||
      (await detectApk())
    ) {
      return 'package-manager'
    }
    return 'native'
  }

  // Check if running from local npm installation
  if (isRunningFromLocalInstallation()) {
    return 'npm-local'
  }

  // Check if we're in a typical npm global location
  const npmGlobalPaths = [
    '/usr/local/lib/node_modules',
    '/usr/lib/node_modules',
    '/opt/homebrew/lib/node_modules',
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/.nvm/versions/node/', // nvm installations
  ]

  if (npmGlobalPaths.some(path => invokedPath.includes(path))) {
    return 'npm-global'
  }

  // Also check for npm/nvm in the path even if not in standard locations
  if (invokedPath.includes('/npm/') || invokedPath.includes('/nvm/')) {
    return 'npm-global'
  }

  const npmConfigResult = await execa('npm config get prefix', {
    shell: true,
    reject: false,
  })
  const globalPrefix =
    npmConfigResult.exitCode === 0 ? npmConfigResult.stdout.trim() : null

  if (globalPrefix && invokedPath.startsWith(globalPrefix)) {
    return 'npm-global'
  }

  // If we can't determine, return unknown
  return 'unknown'
}

async function getInstallationPath(): Promise<string> {
  if (process.env.NODE_ENV === 'development') {
    return getCwd()
  }

  // For bundled/native builds, show the binary location
  if (isInBundledMode()) {
    // Try to find the actual binary that was invoked
    try {
      return await realpath(process.execPath)
    } catch {
      // This function doesn't expect errors
    }

    try {
      const path = await which(getCliBinaryName())
      if (path) {
        return path
      }
    } catch {
      // This function doesn't expect errors
    }

    // If we can't find it, check common locations
    try {
      const nativeBinaryPath = join(
        homedir(),
        '.local',
        'bin',
        getCliBinaryName(),
      )
      await getFsImplementation().stat(nativeBinaryPath)
      return nativeBinaryPath
    } catch {
      // Not found
    }
    return 'native'
  }

  // For npm installations, use the path of the executable
  try {
    return process.argv[0] || 'unknown'
  } catch {
    return 'unknown'
  }
}

export function getInvokedBinary(): string {
  try {
    // For bundled/compiled executables, show the actual binary path
    if (isInBundledMode()) {
      return process.execPath || 'unknown'
    }

    // For npm/development, show the script path
    return process.argv[1] || 'unknown'
  } catch {
    return 'unknown'
  }
}

async function detectMultipleInstallations(): Promise<
  Array<{ type: string; path: string }>
> {
  const fs = getFsImplementation()
  const installations: Array<{ type: string; path: string }> = []

  // Check for local installation
  const localPath = await getDetectedLocalInstallDir()
  if (localPath) {
    installations.push({ type: 'npm-local', path: localPath })
  }

  // Check for global npm installation
  const packagesToCheck = ['@anthropic-ai/claude-code']
  if (MACRO.PACKAGE_URL && MACRO.PACKAGE_URL !== '@anthropic-ai/claude-code') {
    packagesToCheck.push(MACRO.PACKAGE_URL)
  }
  const npmResult = await execFileNoThrow('npm', [
    '-g',
    'config',
    'get',
    'prefix',
  ])
  if (npmResult.code === 0 && npmResult.stdout) {
    const npmPrefix = npmResult.stdout.trim()
    const isWindows = getPlatform() === 'windows'

    // First check for active installations via bin/claude
    // Linux / macOS have prefix/bin/claude and prefix/lib/node_modules
    // Windows has prefix/claude and prefix/node_modules
    const globalBinPath = isWindows
      ? join(npmPrefix, getCliBinaryName())
      : join(npmPrefix, 'bin', getCliBinaryName())

    let globalBinExists = false
    try {
      await fs.stat(globalBinPath)
      globalBinExists = true
    } catch {
      // Not found
    }

    if (globalBinExists) {
      // Check if this is actually a Homebrew cask installation, not npm-global
      // When npm is installed via Homebrew, both can exist at /opt/homebrew/bin/claude
      // We need to resolve the symlink to see where it actually points
      let isCurrentHomebrewInstallation = false

      try {
        // Resolve the symlink to get the actual target
        const realPath = await realpath(globalBinPath)

        // If the symlink points to a Caskroom directory, it's a Homebrew cask
        // Only skip it if it's the same Homebrew installation we're currently running from
        if (realPath.includes('/Caskroom/')) {
          isCurrentHomebrewInstallation = detectHomebrew()
        }
      } catch {
        // If we can't resolve the symlink, include it anyway
      }

      if (!isCurrentHomebrewInstallation) {
        installations.push({ type: 'npm-global', path: globalBinPath })
      }
    } else {
      // If no bin/claude exists, check for orphaned packages (no bin/claude symlink)
      for (const packageName of packagesToCheck) {
        const globalPackagePath = isWindows
          ? join(npmPrefix, 'node_modules', packageName)
          : join(npmPrefix, 'lib', 'node_modules', packageName)

        try {
          await fs.stat(globalPackagePath)
          installations.push({
            type: 'npm-global-orphan',
            path: globalPackagePath,
          })
        } catch {
          // Package not found
        }
      }
    }
  }

  // Check for native installation

  // Check common native installation paths
  const nativeBinPath = join(homedir(), '.local', 'bin', getCliBinaryName())
  try {
    await fs.stat(nativeBinPath)
    installations.push({ type: 'native', path: nativeBinPath })
  } catch {
    // Not found
  }

  // Also check if config indicates native installation
  const config = getGlobalConfig()
  if (config.installMethod === 'native') {
    const nativeDataPath = join(
      homedir(),
      '.local',
      'share',
      getNativeDataDirName(),
    )
    try {
      await fs.stat(nativeDataPath)
      if (!installations.some(i => i.type === 'native')) {
        installations.push({ type: 'native', path: nativeDataPath })
      }
    } catch {
      // Not found
    }
  }

  return installations
}

async function detectConfigurationIssues(
  type: InstallationType,
): Promise<Array<{ issue: string; fix: string }>> {
  const warnings: Array<{ issue: string; fix: string }> = []

  // Managed-settings forwards-compat: the schema preprocess silently drops
  // unknown strictPluginOnlyCustomization surface names so one future enum
  // value doesn't null out the entire policy file (settings.ts:101). But
  // admins should KNOW — read the raw file and diff. Runs before the
  // development-mode early return: this is config correctness, not an
  // install-path check, and it's useful to see during dev testing.
  try {
    const raw = await readFile(
      join(getManagedFilePath(), 'managed-settings.json'),
      'utf-8',
    )
    const parsed: unknown = jsonParse(raw)
    const field =
      parsed && typeof parsed === 'object'
        ? (parsed as Record<string, unknown>).strictPluginOnlyCustomization
        : undefined
    if (field !== undefined && typeof field !== 'boolean') {
      if (!Array.isArray(field)) {
        // .catch(undefined) in the schema silently drops this, so the rest
        // of managed settings survive — but the admin typed something
        // wrong (an object, a string, etc.).
        warnings.push({
          issue: `managed-settings.json: strictPluginOnlyCustomization has an invalid value (expected true or an array, got ${typeof field})`,
          fix: `The field is silently ignored (schema .catch rescues it). Set it to true, or an array of: ${CUSTOMIZATION_SURFACES.join(', ')}.`,
        })
      } else {
        const unknown = field.filter(
          x =>
            typeof x === 'string' &&
            !(CUSTOMIZATION_SURFACES as readonly string[]).includes(x),
        )
        if (unknown.length > 0) {
          warnings.push({
            issue: `managed-settings.json: strictPluginOnlyCustomization has ${unknown.length} value(s) this client doesn't recognize: ${unknown.map(String).join(', ')}`,
            fix: `These are silently ignored (forwards-compat). Known surfaces for this version: ${CUSTOMIZATION_SURFACES.join(', ')}. Either remove them, or this client is older than the managed-settings intended.`,
          })
        }
      }
    }
  } catch {
    // ENOENT (no managed settings) / parse error — not this check's concern.
    // Parse errors are surfaced by the settings loader itself.
  }

  const config = getGlobalConfig()

  // Skip most warnings for development mode
  if (type === 'development') {
    return warnings
  }

  // Check if ~/.local/bin is in PATH for native installations
  if (type === 'native') {
    const path = process.env.PATH || ''
    const pathDirectories = path.split(delimiter)
    const homeDir = homedir()
    const localBinPath = join(homeDir, '.local', 'bin')

    // On Windows, convert backslashes to forward slashes for consistent path matching
    let normalizedLocalBinPath = localBinPath
    if (getPlatform() === 'windows') {
      normalizedLocalBinPath = localBinPath.split(win32.sep).join(posix.sep)
    }

    // Check if ~/.local/bin is in PATH (handle both expanded and unexpanded forms)
    // Also handle trailing slashes that users may have in their PATH
    const localBinInPath = pathDirectories.some(dir => {
      let normalizedDir = dir
      if (getPlatform() === 'windows') {
        normalizedDir = dir.split(win32.sep).join(posix.sep)
      }
      // Remove trailing slashes for comparison (handles paths like /home/user/.local/bin/)
      const trimmedDir = normalizedDir.replace(/\/+$/, '')
      const trimmedRawDir = dir.replace(/[/\\]+$/, '')
      return (
        trimmedDir === normalizedLocalBinPath ||
        trimmedRawDir === '~/.local/bin' ||
        trimmedRawDir === '$HOME/.local/bin'
      )
    })

    if (!localBinInPath) {
      const isWindows = getPlatform() === 'windows'
      if (isWindows) {
        // Windows-specific PATH instructions
        const windowsLocalBinPath = localBinPath
          .split(posix.sep)
          .join(win32.sep)
        warnings.push({
          issue: `Native installation exists but ${windowsLocalBinPath} is not in your PATH`,
          fix: `Add it by opening: System Properties → Environment Variables → Edit User PATH → New → Add the path above. Then restart your terminal.`,
        })
      } else {
        // Unix-style PATH instructions
        const shellType = getShellType()
        const configPaths = getShellConfigPaths()
        const configFile = configPaths[shellType as keyof typeof configPaths]
        const displayPath = configFile
          ? configFile.replace(homedir(), '~')
          : 'your shell config file'

        warnings.push({
          issue:
            'Native installation exists but ~/.local/bin is not in your PATH',
          fix: `Run: echo 'export PATH="$HOME/.local/bin:$PATH"' >> ${displayPath} then open a new terminal or run: source ${displayPath}`,
        })
      }
    }
  }

  // Check for configuration mismatches
  // Skip these checks if DISABLE_INSTALLATION_CHECKS is set (e.g., in HFI)
  if (!isEnvTruthy(process.env.DISABLE_INSTALLATION_CHECKS)) {
    if (type === 'npm-local' && config.installMethod !== 'local') {
      warnings.push({
        issue: `Running from local installation but config install method is '${config.installMethod}'`,
        fix: `Consider using native installation: ${getCliBinaryName()} install`,
      })
    }

    if (type === 'native' && config.installMethod !== 'native') {
      warnings.push({
        issue: `Running native installation but config install method is '${config.installMethod}'`,
        fix: `Run ${getCliBinaryName()} install to update configuration`,
      })
    }
  }

  if (type === 'npm-global' && (await localInstallationExists())) {
    warnings.push({
      issue: 'Local installation exists but not being used',
      fix: `Consider using native installation: ${getCliBinaryName()} install`,
    })
  }

  const existingAlias = await findClaudeAlias()
  const validAlias = await findValidClaudeAlias()

  // Check if running local installation but it's not in PATH
  if (type === 'npm-local') {
    // Check if claude is already accessible via PATH
    const whichResult = await which(getCliBinaryName())
    const claudeInPath = !!whichResult

    // Only show warning if claude is NOT in PATH AND no valid alias exists
    if (!claudeInPath && !validAlias) {
      if (existingAlias) {
        // Alias exists but points to invalid target
        warnings.push({
          issue: 'Local installation not accessible',
          fix: `Alias exists but points to invalid target: ${existingAlias}. Update alias: alias ${getCliBinaryName()}="~/.opalcode/local/${getCliBinaryName()}"`,
        })
      } else {
        // No alias exists and not in PATH
        warnings.push({
          issue: 'Local installation not accessible',
          fix: `Create alias: alias ${getCliBinaryName()}="~/.opalcode/local/${getCliBinaryName()}"`,
        })
      }
    }
  }

  return warnings
}

export function detectLinuxGlobPatternWarnings(): Array<{
  issue: string
  fix: string
}> {
  if (getPlatform() !== 'linux') {
    return []
  }

  const warnings: Array<{ issue: string; fix: string }> = []
  const globPatterns = SandboxManager.getLinuxGlobPatternWarnings()

  if (globPatterns.length > 0) {
    // Show first 3 patterns, then indicate if there are more
    const displayPatterns = globPatterns.slice(0, 3).join(', ')
    const remaining = globPatterns.length - 3
    const patternList =
      remaining > 0 ? `${displayPatterns} (${remaining} more)` : displayPatterns

    warnings.push({
      issue: `Glob patterns in sandbox permission rules are not fully supported on Linux`,
      fix: `Found ${globPatterns.length} pattern(s): ${patternList}. On Linux, glob patterns in Edit/Read rules will be ignored.`,
    })
  }

  return warnings
}

async function probeSavedProviderHealth(
  profile: ReturnType<typeof getProviderProfiles>[number],
): Promise<DiagnosticInfo['providerHealth'][number]> {
  const routeId = resolveRouteIdFromBaseUrl(profile.baseUrl)
  const label = profile.name
  const apiKey =
    profile.apiKey ??
    process.env.OPENAI_API_KEY ??
    process.env.GITHUB_TOKEN ??
    process.env.GH_TOKEN ??
    process.env.GEMINI_API_KEY ??
    process.env.MISTRAL_API_KEY

  if (routeId) {
    const readiness = await probeRouteReadiness(routeId, {
      baseUrl: profile.baseUrl,
      model: profile.model,
      apiKey,
      timeoutMs: 8000,
    })
    if (readiness) {
      if (readiness.state === 'ready') {
        return {
          label,
          source: 'saved-profile',
          endpoint: profile.baseUrl,
          model: profile.model,
          status: 'ready',
          detail:
            readiness.models.length > 0
              ? `models available: ${readiness.models.length}`
              : undefined,
        }
      }
      if (readiness.state === 'no_models') {
        return {
          label,
          source: 'saved-profile',
          endpoint: profile.baseUrl,
          model: profile.model,
          status: 'no_models',
          detail: 'the endpoint is reachable but no models were returned',
        }
      }
      if (readiness.state === 'generation_failed') {
        return {
          label,
          source: 'saved-profile',
          endpoint: profile.baseUrl,
          model: profile.model,
          status: 'generation_failed',
          detail: readiness.detail,
        }
      }
      return {
        label,
        source: 'saved-profile',
        endpoint: profile.baseUrl,
        model: profile.model,
        status: 'unreachable',
      }
    }
  }

  const models = await listOpenAICompatibleModels({
    baseUrl: profile.baseUrl,
    apiKey,
  })
  if (models === null) {
    return {
      label,
      source: 'saved-profile',
      endpoint: profile.baseUrl,
      model: profile.model,
      status: 'unreachable',
      detail: 'could not fetch /models',
    }
  }
  if (models.length === 0) {
    return {
      label,
      source: 'saved-profile',
      endpoint: profile.baseUrl,
      model: profile.model,
      status: 'no_models',
      detail: 'the endpoint returned no models',
    }
  }

  return {
    label,
    source: 'saved-profile',
    endpoint: profile.baseUrl,
    model: profile.model,
    status: 'ready',
    detail: `models available: ${models.length}`,
  }
}

async function probeActiveProviderHealth(): Promise<
  DiagnosticInfo['providerHealth'][number] | null
> {
  const request = resolveProviderRequest()
  const routeId = resolveRouteIdFromBaseUrl(request.baseUrl)
  const label = routeId ? getRouteLabel(routeId) ?? request.baseUrl : request.baseUrl
  const apiKey =
    process.env.OPENAI_API_KEY ??
    process.env.GITHUB_TOKEN ??
    process.env.GH_TOKEN ??
    process.env.GEMINI_API_KEY ??
    process.env.MISTRAL_API_KEY

  if (routeId) {
    const readiness = await probeRouteReadiness(routeId, {
      baseUrl: request.baseUrl,
      model: request.requestedModel,
      apiKey,
      timeoutMs: 8000,
    })
    if (readiness) {
      if (readiness.state === 'ready') {
        return {
          label,
          source: 'active-env',
          endpoint: request.baseUrl,
          model: request.requestedModel,
          status: 'ready',
        }
      }
      if (readiness.state === 'no_models') {
        return {
          label,
          source: 'active-env',
          endpoint: request.baseUrl,
          model: request.requestedModel,
          status: 'no_models',
          detail: 'the endpoint is reachable but no models were returned',
        }
      }
      if (readiness.state === 'generation_failed') {
        return {
          label,
          source: 'active-env',
          endpoint: request.baseUrl,
          model: request.requestedModel,
          status: 'generation_failed',
          detail: readiness.detail,
        }
      }
      return {
        label,
        source: 'active-env',
        endpoint: request.baseUrl,
        model: request.requestedModel,
        status: 'unreachable',
      }
    }
  }

  const models = await listOpenAICompatibleModels({
    baseUrl: request.baseUrl,
    apiKey,
  })
  if (models === null) {
    return {
      label,
      source: 'active-env',
      endpoint: request.baseUrl,
      model: request.requestedModel,
      status: 'unsupported',
      detail: 'no direct probe is available for this provider',
    }
  }
  if (models.length === 0) {
    return {
      label,
      source: 'active-env',
      endpoint: request.baseUrl,
      model: request.requestedModel,
      status: 'no_models',
      detail: 'the endpoint returned no models',
    }
  }

  return {
    label,
    source: 'active-env',
    endpoint: request.baseUrl,
    model: request.requestedModel,
    status: 'ready',
    detail: `models available: ${models.length}`,
  }
}

async function getSystemDependencies(): Promise<DiagnosticInfo['systemDependencies']> {
  const rgExecutable = await which('rg')
  const ripgrepStatus = getRipgrepStatus()
  return [
    {
      name: 'ripgrep',
      command: 'rg --version',
      status:
        ripgrepStatus.mode === 'system' && !ripgrepStatus.working
          ? 'missing'
          : 'ok',
      detail:
        rgExecutable ??
        (ripgrepStatus.mode === 'embedded'
          ? 'using bundled ripgrep'
          : ripgrepStatus.mode === 'builtin'
            ? 'using vendored ripgrep'
            : 'rg is not available on PATH'),
    },
  ]
}

async function getProviderHealthChecks(
  config = getGlobalConfig(),
): Promise<DiagnosticInfo['providerHealth']> {
  const savedProfiles = getProviderProfiles(config)
  const savedChecks = await Promise.all(savedProfiles.map(probeSavedProviderHealth))
  const hasConfiguredProviderEnv =
    Boolean(process.env.CLAUDE_CODE_USE_OPENAI) ||
    Boolean(process.env.CLAUDE_CODE_USE_GEMINI) ||
    Boolean(process.env.CLAUDE_CODE_USE_MISTRAL) ||
    Boolean(process.env.CLAUDE_CODE_USE_GITHUB) ||
    Boolean(process.env.CLAUDE_CODE_USE_BEDROCK) ||
    Boolean(process.env.CLAUDE_CODE_USE_VERTEX) ||
    Boolean(process.env.CLAUDE_CODE_USE_FOUNDRY) ||
    Boolean(process.env.OPENAI_BASE_URL) ||
    Boolean(process.env.OPENAI_API_BASE) ||
    Boolean(process.env.OPENAI_MODEL) ||
    Boolean(process.env.OPENAI_API_KEY) ||
    Boolean(process.env.GEMINI_BASE_URL) ||
    Boolean(process.env.GEMINI_MODEL) ||
    Boolean(process.env.GEMINI_API_KEY) ||
    Boolean(process.env.MISTRAL_BASE_URL) ||
    Boolean(process.env.MISTRAL_MODEL) ||
    Boolean(process.env.MISTRAL_API_KEY) ||
    Boolean(process.env.GITHUB_TOKEN) ||
    Boolean(process.env.GH_TOKEN)

  const activeCheck = hasConfiguredProviderEnv
    ? await probeActiveProviderHealth()
    : null
  const checks = activeCheck ? [...savedChecks, activeCheck] : savedChecks
  const seen = new Set<string>()
  return checks.filter(check => {
    const key = `${check.source}:${check.label}:${check.endpoint ?? ''}:${check.model ?? ''}`
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })
}

async function getLocalLlmHealthChecks(): Promise<DiagnosticInfo['localLlmHealth']> {
  const ollama = await probeOllamaGenerationReadiness({
    baseUrl: process.env.OLLAMA_BASE_URL || DEFAULT_OLLAMA_BASE_URL,
    timeoutMs: 8000,
  })
  const atomicChat = await probeAtomicChatReadiness({
    baseUrl: process.env.ATOMIC_CHAT_BASE_URL || DEFAULT_ATOMIC_CHAT_BASE_URL,
  })

  return [
    {
      label: 'Ollama',
      endpoint: getOllamaChatBaseUrl(process.env.OLLAMA_BASE_URL || DEFAULT_OLLAMA_BASE_URL),
      status: ollama.state,
      detail:
        ollama.state === 'ready'
          ? ollama.probeModel
            ? `probe model: ${ollama.probeModel}`
            : 'ready'
          : ollama.state === 'no_models'
            ? 'the server is reachable but no models are installed'
            : ollama.state === 'unreachable'
              ? 'could not reach the Ollama API'
              : ollama.detail,
    },
    {
      label: 'Atomic Chat',
      endpoint: getAtomicChatChatBaseUrl(
        process.env.ATOMIC_CHAT_BASE_URL || DEFAULT_ATOMIC_CHAT_BASE_URL,
      ),
      status: atomicChat.state,
      detail:
        atomicChat.state === 'ready'
          ? atomicChat.models.length > 0
            ? `models available: ${atomicChat.models.length}`
            : 'ready'
          : atomicChat.state === 'no_models'
            ? 'the server is reachable but no models are loaded'
            : 'could not reach the Atomic Chat API',
    },
  ]
}

export async function getDoctorDiagnostic(): Promise<DiagnosticInfo> {
  const installationType = await getCurrentInstallationType()
  const version =
    typeof MACRO !== 'undefined' && MACRO.VERSION ? MACRO.VERSION : 'unknown'
  const installationPath = await getInstallationPath()
  const invokedBinary = getInvokedBinary()
  const multipleInstallations = await detectMultipleInstallations()
  const warnings = await detectConfigurationIssues(installationType)
  const config = getGlobalConfig()

  // Add glob pattern warnings for Linux sandboxing
  warnings.push(...detectLinuxGlobPatternWarnings())

  // Add warnings for leftover npm installations when running native
  if (installationType === 'native') {
    const npmInstalls = multipleInstallations.filter(
      i =>
        i.type === 'npm-global' ||
        i.type === 'npm-global-orphan' ||
        i.type === 'npm-local',
    )

    const isWindows = getPlatform() === 'windows'

    for (const install of npmInstalls) {
      if (install.type === 'npm-global') {
        let uninstallCmd = 'npm -g uninstall @anthropic-ai/claude-code'
        if (
          MACRO.PACKAGE_URL &&
          MACRO.PACKAGE_URL !== '@anthropic-ai/claude-code'
        ) {
          uninstallCmd += ` && npm -g uninstall ${MACRO.PACKAGE_URL}`
        }
        warnings.push({
          issue: `Leftover npm global installation at ${install.path}`,
          fix: `Run: ${uninstallCmd}`,
        })
      } else if (install.type === 'npm-global-orphan') {
        warnings.push({
          issue: `Orphaned npm global package at ${install.path}`,
          fix: isWindows
            ? `Run: rmdir /s /q "${install.path}"`
            : `Run: rm -rf ${install.path}`,
        })
      } else if (install.type === 'npm-local') {
        warnings.push({
          issue: `Leftover npm local installation at ${install.path}`,
          fix: isWindows
            ? `Run: rmdir /s /q "${install.path}"`
            : `Run: rm -rf ${install.path}`,
        })
      }
    }
  }

  // Get config values for display
  const configInstallMethod = config.installMethod || 'not set'

  // Check permissions for global installations
  let hasUpdatePermissions: boolean | null = null
  if (installationType === 'npm-global') {
    const permCheck = await checkGlobalInstallPermissions()
    hasUpdatePermissions = permCheck.hasPermissions

    // Add warning if no permissions
    if (!hasUpdatePermissions && !getAutoUpdaterDisabledReason()) {
      warnings.push({
        issue: 'Insufficient permissions for auto-updates',
        fix: `Do one of: (1) Re-install node without sudo, or (2) Use \`${getCliBinaryName()} install\` for native installation`,
      })
    }
  }

  // Get ripgrep status and configuration
  const ripgrepStatusRaw = getRipgrepStatus()

  // Provide simple ripgrep status info
  const ripgrepStatus = {
    working: ripgrepStatusRaw.working ?? true, // Assume working if not yet tested
    mode: ripgrepStatusRaw.mode,
    systemPath:
      ripgrepStatusRaw.mode === 'system' ? ripgrepStatusRaw.path : null,
  }

  const [systemDependencies, providerHealth, localLlmHealth] =
    await Promise.all([
      getSystemDependencies(),
      getProviderHealthChecks(config),
      getLocalLlmHealthChecks(),
    ])

  // Get package manager info if running from package manager
  const packageManager =
    installationType === 'package-manager'
      ? await getPackageManager()
      : undefined

  const diagnostic: DiagnosticInfo = {
    installationType,
    version,
    installationPath,
    invokedBinary,
    configInstallMethod,
    autoUpdates: (() => {
      const reason = getAutoUpdaterDisabledReason()
      return reason
        ? `disabled (${formatAutoUpdaterDisabledReason(reason)})`
        : 'enabled'
    })(),
    hasUpdatePermissions,
    multipleInstallations,
    warnings,
    packageManager,
    ripgrepStatus,
    systemDependencies,
    providerHealth,
    localLlmHealth,
  }

  return diagnostic
}
