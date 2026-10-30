declare const __APP_NAME__: string
declare const __APP_VERSION__: string

export const APP_INFO = {
  /* v8 ignore start */
  name: __APP_NAME__ ?? 'Termote',
  version: __APP_VERSION__ ?? '0.0.0',
  /* v8 ignore stop */
  // The wordmark as people read it; `name` is the npm package name
  displayName: 'Termote',
  // i18n-ignore: package metadata; About shows settings.about.description
  description: 'Terminal + Remote — control CLI tools from anywhere',
  author: {
    name: 'Lam Ngoc Khuong',
    url: 'https://khuong.dev',
  },
  repository: 'https://github.com/lamngockhuong/termote',
  license: 'MIT',
  links: {
    docs: 'https://termote.ohnice.app/',
    usageDocs: 'https://termote.ohnice.app/usage/overview/',
    changelog: 'https://github.com/lamngockhuong/termote/releases',
    issues: 'https://github.com/lamngockhuong/termote/issues',
  },
  sponsor: {
    momo: 'https://me.momo.vn/khuong',
    github: 'https://github.com/sponsors/lamngockhuong',
    buyMeACoffee: 'https://buymeacoffee.com/lamngockhuong',
  },
}
