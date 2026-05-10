import type { Command } from '../../commands.js'

const changelog: Command = {
  description: 'View the project changelog',
  name: 'changelog',
  type: 'local-jsx',
  load: () => import('./changelog-ui.js'),
}

export default changelog
