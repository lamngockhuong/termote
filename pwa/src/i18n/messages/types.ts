// A translation of an English area: every key but the _one plural forms,
// which a language with one plural form (Vietnamese) does without. A key
// missing or one English lacks fails tsc.
export type Translation<T> = {
  [K in keyof T as K extends `${string}_one` ? never : K]: string
} & {
  [K in keyof T as K extends `${string}_one` ? K : never]?: string
}

// The key t() takes: a plural form is named without its _one/_other
export type BaseKey<K> = K extends `${infer B}_${'one' | 'other'}` ? B : K
