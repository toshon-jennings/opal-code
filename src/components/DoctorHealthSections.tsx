import figures from 'figures'
import React from 'react'

import { Box, Text } from '../ink.js'
import type { DiagnosticInfo } from '../utils/doctorDiagnostic.js'

type Props = {
  diagnostic: DiagnosticInfo
}

type SystemDependency = DiagnosticInfo['systemDependencies'][number]
type ProviderHealth = DiagnosticInfo['providerHealth'][number]
type LocalHealth = DiagnosticInfo['localLlmHealth'][number]

function statusStyle(status: string): {
  glyph: string
  color?: 'success' | 'warning' | 'error'
} {
  switch (status) {
    case 'ok':
    case 'ready':
      return { glyph: figures.tick, color: 'success' }
    case 'no_models':
    case 'generation_failed':
    case 'unreachable':
      return { glyph: figures.cross, color: 'error' }
    case 'unsupported':
    case 'missing':
      return { glyph: figures.warning, color: 'warning' }
    default:
      return { glyph: figures.info }
  }
}

function HealthSection({
  title,
  emptyLabel,
  items,
  renderItem,
}: {
  title: string
  emptyLabel: string
  items: ReadonlyArray<unknown>
  renderItem: (item: unknown, index: number) => React.ReactNode
}): React.ReactNode {
  if (items.length === 0) {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text bold>{title}</Text>
        <Text dimColor>└ {emptyLabel}</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>{title}</Text>
      {items.map(renderItem)}
    </Box>
  )
}

export function DoctorHealthSections({ diagnostic }: Props): React.ReactNode {
  return (
    <Box flexDirection="column">
      {HealthSection({
        title: 'System Dependencies',
        emptyLabel: 'No dependency checks were run',
        items: diagnostic.systemDependencies,
        renderItem: (dependency, index) => {
          const dep = dependency as SystemDependency
          const { glyph, color } = statusStyle(dep.status)
          return (
            <Text key={`${dep.name}-${index}`}>
              {'└ '}
              <Text color={color}>{glyph} {dep.name}</Text>
              <Text dimColor> ({dep.command})</Text>
              {dep.detail ? <Text dimColor>: {dep.detail}</Text> : null}
            </Text>
          )
        },
      })}

      {HealthSection({
        title: 'Configured Providers',
        emptyLabel: 'No provider profiles or environment provider were found',
        items: diagnostic.providerHealth,
        renderItem: (provider, index) => {
          const item = provider as ProviderHealth
          const { glyph, color } = statusStyle(item.status)
          return (
            <Box key={`${item.source}-${item.label}-${index}`} flexDirection="column">
              <Text>
                {'└ '}
                <Text color={color}>{glyph} {item.label}</Text>
                <Text dimColor> [{item.source}]</Text>
                {item.endpoint ? <Text dimColor> · {item.endpoint}</Text> : null}
                {item.model ? <Text dimColor> · model {item.model}</Text> : null}
              </Text>
              {item.detail ? (
                <Text dimColor>{'  '}└ {item.detail}</Text>
              ) : null}
            </Box>
          )
        },
      })}

      {HealthSection({
        title: 'Local LLM Health',
        emptyLabel: 'No local LLM checks were run',
        items: diagnostic.localLlmHealth,
        renderItem: (service, index) => {
          const item = service as LocalHealth
          const { glyph, color } = statusStyle(item.status)
          return (
            <Box key={`${item.label}-${index}`} flexDirection="column">
              <Text>
                {'└ '}
                <Text color={color}>{glyph} {item.label}</Text>
                <Text dimColor> · {item.endpoint}</Text>
              </Text>
              {item.detail ? (
                <Text dimColor>{'  '}└ {item.detail}</Text>
              ) : null}
            </Box>
          )
        },
      })}
    </Box>
  )
}
