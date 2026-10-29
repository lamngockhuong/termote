import type { Messages } from '../en'
import type { Translation } from '../types'
import chat from './chat'
import common from './common'
import dialogs from './dialogs'
import errors from './errors'
import files from './files'
import help from './help'
import settings from './settings'
import shell from './shell'
import tasks from './tasks'
import tour from './tour'
import welcome from './welcome'

// Every Vietnamese message; tsc checks it has each English key
export const vi = {
  ...chat,
  ...common,
  ...dialogs,
  ...errors,
  ...files,
  ...help,
  ...settings,
  ...shell,
  ...tasks,
  ...tour,
  ...welcome,
} satisfies Translation<Messages>
