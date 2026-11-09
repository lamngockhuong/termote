import { useT } from '../i18n/i18n-context'
import type { MessageKey } from '../i18n/messages/en'
import type { Translate } from '../i18n/translate'
import { isApplePlatform } from '../utils/platform'
import {
  COMMAND_LABEL,
  SETTING_LABEL,
  VALUE_LABEL,
} from '../utils/setting-labels'
import type { SettingChange, SkipReason } from '../utils/settings-registry'
import { formatChord, isCommandId } from '../utils/shortcuts'
import { visibleUnsafe } from '../utils/unsafe-chars'
import { Button } from './ui/button'
import { Sheet } from './ui/sheet'

const SKIP_LABEL: Record<SkipReason, MessageKey> = {
  unknown: 'settings.diff.skip.unknown',
  invalid: 'settings.diff.skip.invalid',
  device: 'settings.diff.skip.device',
  deviceOnly: 'settings.diff.skip.deviceOnly',
}

function isShortcut(v: unknown): v is { key?: unknown; inTerminal?: unknown } {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

// How a value shows in the table: words for on/off, empty and defaults, a
// chord as this platform writes it, every hidden character as ⟨U+XXXX⟩
export function formatSettingValue(
  row: SettingChange,
  v: unknown,
  t: Translate<MessageKey>,
  apple: boolean,
): string {
  if (v === undefined)
    return row.command ? t('settings.diff.default') : t('settings.diff.unset')
  const word =
    (typeof v === 'string' || typeof v === 'number') &&
    Object.hasOwn(VALUE_LABEL, row.key) &&
    Object.hasOwn(VALUE_LABEL[row.key], String(v))
      ? VALUE_LABEL[row.key][String(v)]
      : undefined
  if (word) return t(word)
  if (row.key === 'pollInterval' && typeof v === 'number')
    return v >= 60
      ? t('settings.pollMinutes', { n: v / 60 })
      : t('settings.pollSeconds', { n: v })
  if (typeof v === 'boolean')
    return t(v ? 'settings.diff.on' : 'settings.diff.off')
  if (typeof v === 'number') return String(v)
  if (typeof v === 'string')
    return v === '' ? t('settings.diff.empty') : visibleUnsafe(v)
  if (Array.isArray(v))
    return v.length
      ? v
          .map((x) => visibleUnsafe(typeof x === 'string' ? x : String(x)))
          .join(', ')
      : t('settings.diff.empty')
  if (row.command && isShortcut(v) && !row.skip) {
    const key =
      v.key === null
        ? t('settings.diff.none')
        : typeof v.key === 'string'
          ? formatChord(v.key, apple)
          : t('settings.diff.default')
    return v.inTerminal === true
      ? `${key} · ${t('settings.diff.inTerminal')}`
      : key
  }
  // Values come from JSON: they stringify
  return visibleUnsafe(JSON.stringify(v))
}

// The name a row shows: the setting as Settings names it, a shortcut by its
// command's title; a key this version does not know as it came, its hidden
// characters marked
export function settingName(
  row: SettingChange,
  t: Translate<MessageKey>,
): string {
  if (row.command !== undefined)
    return isCommandId(row.command)
      ? t('settings.key.shortcut', { command: t(COMMAND_LABEL[row.command]) })
      : visibleUnsafe(row.command)
  return Object.hasOwn(SETTING_LABEL, row.key)
    ? t(SETTING_LABEL[row.key])
    : visibleUnsafe(row.key)
}

interface Props {
  isOpen: boolean
  title: string
  rows: SettingChange[]
  // Applying is off: a newer proposal arrived since this one was opened,
  // or it is gone (expired, the server restarted, a machine opened)
  stale?: 'newer' | 'gone'
  onApply: () => void
  onCancel: () => void
}

// What a proposal or an import would change on this browser: each setting
// now and after, those that cannot apply marked with why. Nothing changes
// until Apply.
export function SettingsDiffDialog({
  isOpen,
  title,
  rows,
  stale,
  onApply,
  onCancel,
}: Props) {
  const { t } = useT()
  const apple = isApplePlatform()
  const applicable = rows.filter((r) => !r.skip).length
  return (
    <Sheet isOpen={isOpen} onClose={onCancel} title={title}>
      <div className="flex flex-col gap-3 p-4">
        <p className="m-0 text-sm text-fg-muted">{t('settings.diff.intro')}</p>
        {stale && (
          <p role="alert" className="m-0 text-sm text-warning">
            {t(stale === 'gone' ? 'settings.diff.gone' : 'settings.diff.stale')}
          </p>
        )}
        {applicable === 0 && (
          <p className="m-0 text-sm text-fg-muted">
            {t('settings.diff.nothing')}
          </p>
        )}
        {rows.length > 0 && (
          <div className="max-h-[50vh] overflow-auto">
            <table className="w-full border-collapse text-left text-[13px]">
              <thead>
                <tr className="text-fg-muted">
                  <th scope="col" className="py-1 pr-2 font-medium">
                    {t('settings.diff.setting')}
                  </th>
                  <th scope="col" className="py-1 pr-2 font-medium">
                    {t('settings.diff.before')}
                  </th>
                  <th scope="col" className="py-1 font-medium">
                    {t('settings.diff.after')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={`${row.key}/${row.command ?? ''}`}
                    data-skip={row.skip}
                    className="border-t border-border align-top"
                  >
                    <th scope="row" className="py-1.5 pr-2 font-normal text-fg">
                      {settingName(row, t)}
                    </th>
                    <td className="py-1.5 pr-2 break-all text-fg-muted">
                      {formatSettingValue(row, row.before, t, apple)}
                    </td>
                    <td className="py-1.5 break-all text-fg">
                      <span className={row.skip ? 'line-through' : ''}>
                        {formatSettingValue(row, row.after, t, apple)}
                      </span>
                      {row.skip && (
                        <span className="block text-[12px] text-warning">
                          {t(SKIP_LABEL[row.skip])}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button onClick={onCancel}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            disabled={!!stale || applicable === 0}
            onClick={onApply}
          >
            {t('settings.diff.apply')}
          </Button>
        </div>
      </div>
    </Sheet>
  )
}
