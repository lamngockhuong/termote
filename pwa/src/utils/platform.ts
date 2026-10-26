// Apple platforms (macOS, iPadOS, iOS): Cmd takes the place of Ctrl in
// shortcuts, and Ctrl+Shift+C stays a terminal key
export function isApplePlatform(): boolean {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } }
  const platform = nav.userAgentData?.platform || navigator.platform || ''
  return /mac|iphone|ipad|ipod/i.test(platform)
}
