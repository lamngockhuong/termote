// Files shown as an image (files/raw) instead of as text. The name only picks
// the view: the server tells the type from the file's bytes.
export const isImagePath = (path: string) =>
  /\.(png|jpe?g|gif|webp)$/i.test(path)

// An SVG is text: shown as source (or a diff) unless the user picks the image
export const isSvgPath = (path: string) => /\.svg$/i.test(path)
