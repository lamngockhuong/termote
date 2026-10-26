// The look of a rendered document (a Markdown preview, a Word document):
// headings, lists, quotes, code and tables in the app's tokens
export const LINK = 'text-accent underline underline-offset-2'

export const PROSE = [
  'min-w-0 break-words px-4 py-3 text-[14px] leading-relaxed text-fg',
  '[&_h1]:mt-6 [&_h1]:mb-3 [&_h1]:border-b [&_h1]:border-border [&_h1]:pb-1 [&_h1]:text-[22px] [&_h1]:font-semibold',
  '[&_h2]:mt-6 [&_h2]:mb-3 [&_h2]:border-b [&_h2]:border-border [&_h2]:pb-1 [&_h2]:text-[18px] [&_h2]:font-semibold',
  '[&_h3]:mt-5 [&_h3]:mb-2 [&_h3]:text-[16px] [&_h3]:font-semibold',
  '[&_h4]:mt-4 [&_h4]:mb-2 [&_h4]:font-semibold [&_h5]:mt-4 [&_h5]:font-semibold [&_h6]:mt-4 [&_h6]:font-semibold [&_h6]:text-fg-muted',
  '[&>*:first-child]:mt-0 [&_p]:my-3 [&_ul]:my-3 [&_ol]:my-3 [&_ul]:list-disc [&_ol]:list-decimal [&_li]:ml-5 [&_li>p]:my-1',
  '[&_.contains-task-list]:list-none [&_.task-list-item]:ml-0 [&_.task-list-item_input]:mr-1.5 [&_.task-list-item_input]:align-middle',
  '[&_blockquote]:my-3 [&_blockquote]:border-l-4 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-fg-muted',
  '[&_hr]:my-6 [&_hr]:border-border',
  '[&_details]:my-3 [&_details]:rounded-control [&_details]:border [&_details]:border-border [&_details]:px-3 [&_details]:py-1.5',
  '[&_summary]:cursor-pointer [&_summary]:font-medium [&_details[open]>summary]:mb-2',
  '[&_:not(pre)>code]:rounded [&_:not(pre)>code]:bg-surface-raised [&_:not(pre)>code]:px-1 [&_:not(pre)>code]:font-term [&_:not(pre)>code]:text-[0.9em]',
  '[&_table]:border-collapse [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-border [&_th]:bg-surface [&_th]:px-2 [&_th]:py-1 [&_th]:text-left',
  '[&_.footnotes]:mt-8 [&_.footnotes]:border-t [&_.footnotes]:border-border [&_.footnotes]:pt-2 [&_.footnotes]:text-[13px] [&_sup]:text-[0.75em]',
].join(' ')
