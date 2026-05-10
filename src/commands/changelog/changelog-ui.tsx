import * as React from 'react'
import { Box, Text, useInput } from '../../ink.js'
import type {
  LocalJSXCommandCall,
  LocalJSXCommandOnDone,
} from '../../types/command.js'

const INITIAL_CHANGELOG = [
  {
    version: '0.1.1',
    changes: [
      'Fix addressing the ASCII art disappearing when the terminal window was resized.',
    ],
  },
  {
    version: '0.1.0',
    changes: ['Initial release.'],
  },
]

function ChangelogViewer({
  onDone,
}: {
  onDone: LocalJSXCommandOnDone
}): React.ReactElement {
  const [index, setIndex] = React.useState(0)
  const entry = INITIAL_CHANGELOG[index]!

  useInput((_input, key) => {
    if (key.escape || key.return) {
      onDone('Changelog dismissed', { display: 'skip' })
      return
    }
    if (key.leftArrow) {
      setIndex(i => Math.max(0, i - 1))
      return
    }
    if (key.rightArrow) {
      setIndex(i => Math.min(INITIAL_CHANGELOG.length - 1, i + 1))
    }
  })

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="permission" paddingX={1}>
      <Text bold>OpalCode {entry.version}</Text>
      <Box marginTop={1} flexDirection="column">
        {entry.changes.map(change => (
          <Text key={change}>- {change}</Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          {index + 1}/{INITIAL_CHANGELOG.length} · ←/→ navigate · Enter/Esc close
        </Text>
      </Box>
    </Box>
  )
}

export const call: LocalJSXCommandCall = async onDone => {
  return <ChangelogViewer onDone={onDone} />
}
