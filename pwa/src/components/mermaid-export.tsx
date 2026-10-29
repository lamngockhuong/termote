import { FileDown, Image as ImageIcon, Share } from 'lucide-react'
import { type RefCallback, useState } from 'react'
import { useT } from '../i18n/i18n-context'
import {
  canCopyImage,
  canShareImage,
  copyPng,
  downloadSvg,
  sharePng,
} from '../utils/mermaid-export'
import type { MermaidImage } from '../utils/mermaid-render'
import { IconButton } from './ui/button'

interface Props {
  image: MermaidImage
  // The file name to save as, without its extension
  name: string
  notify: (message: string) => void
  size?: 'sm' | 'md'
  // Given every button: a callback, as an object ref would keep the last one
  buttonRef?: RefCallback<HTMLButtonElement>
}

// Share and Copy image for a note app (a PNG in the diagram's colors), and
// Download SVG; the first two only where the browser offers them.
export function MermaidExport({
  image,
  name,
  notify,
  size = 'md',
  buttonRef,
}: Props) {
  const { t } = useT()
  const [canShare] = useState(canShareImage)
  const [canCopy] = useState(canCopyImage)
  return (
    <>
      {canShare && (
        <IconButton
          ref={buttonRef}
          size={size}
          onClick={() => void sharePng(image, name, notify, t)}
          aria-label={t('files.mermaid.share')}
          title={t('files.mermaid.share')}
        >
          <Share size={14} aria-hidden="true" />
        </IconButton>
      )}
      {canCopy && (
        <IconButton
          ref={buttonRef}
          size={size}
          // Not deferred: the ClipboardItem must be made in the click
          onClick={() => void copyPng(image, notify, t)}
          aria-label={t('files.mermaid.copy')}
          title={t('files.mermaid.copy')}
        >
          <ImageIcon size={14} aria-hidden="true" />
        </IconButton>
      )}
      <IconButton
        ref={buttonRef}
        size={size}
        onClick={() => void downloadSvg(image, name, notify, t)}
        aria-label={t('files.mermaid.download')}
        title={t('files.mermaid.download')}
      >
        <FileDown size={14} aria-hidden="true" />
      </IconButton>
    </>
  )
}
