import type en from '../en/chat'
import type { Translation } from '../types'

export default {
  'chat.activity.working': '{agent} đang làm việc…',
  'chat.activity.thinking': 'Đang suy nghĩ',
  'chat.activity.tokens': '↓ {tokens} token',
} satisfies Translation<typeof en>
