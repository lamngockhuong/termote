import type { BaseKey } from '../types'
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

// Every English message: the source each translation is checked against
export const en = {
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
}

export type Messages = typeof en
export type MessageKey = BaseKey<keyof Messages>
