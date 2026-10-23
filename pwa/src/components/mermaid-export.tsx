import { FileDown, Image as ImageIcon, Share } from 'lucide-react'
import { type RefCallback, useState } from 'react'
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
  const [canShare] = useState(canShareImage)
  const [canCopy] = useState(canCopyImage)
  return (
    <>
      {canShare && (
        <IconButton
          ref={buttonRef}
          size={size}
          onClick={() => void sharePng(image, name, notify)}
          aria-label="Share diagram as PNG"
          title="Share diagram as PNG"
        >
          <Share size={14} aria-hidden="true" />
        </IconButton>
      )}
      {canCopy && (
        <IconButton
          ref={buttonRef}
          size={size}
          // Not deferred: the ClipboardItem must be made in the click
          onClick={() => void copyPng(image, notify)}
          aria-label="Copy diagram as image"
          title="Copy diagram as image"
        >
          <ImageIcon size={14} aria-hidden="true" />
        </IconButton>
      )}
      <IconButton
        ref={buttonRef}
        size={size}
        onClick={() => void downloadSvg(image, name, notify)}
        aria-label="Download diagram as SVG"
        title="Download diagram as SVG"
      >
        <FileDown size={14} aria-hidden="true" />
      </IconButton>
    </>
  )
}
