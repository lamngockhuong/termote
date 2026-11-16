import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PromptField } from '../hooks/use-mux-api'
import { PromptForm } from './prompt-form'

const onSend = vi.fn()

function renderForm(fields: PromptField[], busy = false) {
  return render(<PromptForm fields={fields} busy={busy} onSend={onSend} />)
}

const send = async () => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  })
}

const type = (label: string | RegExp, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } })

beforeEach(() => vi.clearAllMocks())

// OpenCode's question tool: one question, its options and other text
const question: PromptField = {
  key: 'q0',
  type: 'string',
  title: 'Color',
  description: 'Which color?',
  options: [
    { value: 'Red', label: 'Red', detail: 'warm' },
    { value: 'Blue', label: 'Blue' },
  ],
  custom: true,
}

describe('PromptForm', () => {
  it('a question is a group of options with its own text, sent as picked', async () => {
    renderForm([question])
    const group = screen.getByRole('group', { name: /Color/ })
    expect(group).toHaveTextContent('Which color?')
    expect(screen.getByText('warm')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: /Blue/ }))
    await send()
    expect(onSend).toHaveBeenCalledWith({ q0: 'Blue' })
  })

  it('other text replaces the option picked, and an option replaces it back', async () => {
    renderForm([question])
    fireEvent.click(screen.getByRole('radio', { name: /Red/ }))
    type('Other answer', 'Green')
    expect(screen.getByRole('radio', { name: 'Other…' })).toBeChecked()
    expect(screen.getByRole('radio', { name: /Red/ })).not.toBeChecked()
    await send()
    expect(onSend).toHaveBeenLastCalledWith({ q0: 'Green' })
    fireEvent.click(screen.getByRole('radio', { name: /Red/ }))
    await send()
    expect(onSend).toHaveBeenLastCalledWith({ q0: 'Red' })
    // Other again, with the text typed before
    fireEvent.click(screen.getByRole('radio', { name: 'Other…' }))
    await send()
    expect(onSend).toHaveBeenLastCalledWith({ q0: 'Green' })
  })

  it('a default that is not an option starts as other text', () => {
    renderForm([{ ...question, default: 'Teal' }])
    expect(screen.getByLabelText('Other answer')).toHaveValue('Teal')
    expect(screen.getByRole('radio', { name: 'Other…' })).toBeChecked()
  })

  it('a field without other text has no Other', () => {
    renderForm([{ ...question, custom: false, default: 'Red' }])
    expect(screen.queryByLabelText('Other answer')).not.toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /Red/ })).toBeChecked()
  })

  it('a multiselect ticks several, adds and drops other text', async () => {
    renderForm([
      {
        key: 'q1',
        type: 'multiselect',
        title: 'Sizes',
        options: [
          { value: 'S', label: 'Small' },
          { value: 'M', label: 'Medium' },
        ],
        custom: true,
        default: ['S'],
      },
    ])
    expect(screen.getByRole('checkbox', { name: 'Small' })).toBeChecked()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Medium' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Small' }))
    const add = screen.getByRole('button', { name: 'Add' })
    expect(add).toBeDisabled()
    type('Other answer', 'XL')
    fireEvent.click(add)
    expect(screen.getByLabelText('Other answer')).toHaveValue('')
    expect(screen.getByRole('checkbox', { name: 'XL' })).toBeChecked()
    // The same text again cannot be added twice
    type('Other answer', 'XL')
    expect(add).toBeDisabled()
    await send()
    expect(onSend).toHaveBeenLastCalledWith({ q1: ['M', 'XL'] })
    fireEvent.click(screen.getByRole('checkbox', { name: 'XL' }))
    await send()
    expect(onSend).toHaveBeenLastCalledWith({ q1: ['M'] })
  })

  it('fields of every kind, each with its own input, sent typed', async () => {
    renderForm([
      {
        key: 'name',
        type: 'string',
        title: 'Name',
        required: true,
        placeholder: 'my-svc',
        default: 'svc',
      },
      { key: 'email', type: 'string', title: 'Email', format: 'email' },
      { key: 'site', type: 'string', format: 'uri' },
      {
        key: 'replicas',
        type: 'integer',
        title: 'Replicas',
        minimum: 1,
        maximum: 5,
        default: 2,
      },
      { key: 'ratio', type: 'number', title: 'Ratio' },
      {
        key: 'public',
        type: 'boolean',
        title: 'Public',
        description: 'Expose it',
      },
    ])
    expect(screen.getByLabelText(/Name/)).toHaveAttribute(
      'placeholder',
      'my-svc',
    )
    expect(screen.getByLabelText(/Name/)).toHaveValue('svc')
    expect(screen.getByText('(required)', { exact: false })).toBeInTheDocument()
    expect(screen.getByLabelText('Email')).toHaveAttribute('type', 'email')
    // A field without a title is named by its key
    expect(screen.getByLabelText('site')).toHaveAttribute('type', 'url')
    const replicas = screen.getByLabelText('Replicas')
    expect(replicas).toHaveAttribute('type', 'number')
    expect(replicas).toHaveAttribute('inputmode', 'numeric')
    expect(replicas).toHaveAttribute('step', '1')
    expect(replicas).toHaveAttribute('min', '1')
    expect(screen.getByLabelText('Ratio')).toHaveAttribute(
      'inputmode',
      'decimal',
    )
    expect(screen.getByLabelText('Ratio')).toHaveAttribute('step', 'any')
    expect(screen.getByLabelText(/Public/)).not.toBeChecked()
    type('Ratio', '0.5')
    fireEvent.click(screen.getByLabelText(/Public/))
    await send()
    expect(onSend).toHaveBeenCalledWith({
      name: 'svc',
      replicas: 2,
      ratio: 0.5,
      public: true,
    })
  })

  it('a required checkbox is marked as other fields are', () => {
    renderForm([
      { key: 'ok', type: 'boolean', title: 'Agree', required: true },
      { key: 'opt', type: 'boolean', title: 'Optional' },
    ])
    expect(screen.getByLabelText(/Agree/)).toHaveAccessibleName(
      /^Agree\s*\(required\)$/,
    )
    expect(screen.getByLabelText('Optional')).toHaveAccessibleName('Optional')
    expect(screen.getByLabelText(/Agree/)).not.toHaveAttribute('aria-invalid')
  })

  it('sums up the fields to fix in a live region once a send fails', async () => {
    renderForm([
      { key: 'name', type: 'string', title: 'Name', required: true },
      { key: 'n', type: 'integer', title: 'N', maximum: 5 },
    ])
    const summary = screen.getByText(
      (_, el) => el?.getAttribute('aria-live') === 'polite',
    )
    expect(summary).toBeEmptyDOMElement()
    type('N', '9')
    await send()
    expect(summary).toHaveTextContent('2 fields need a fix before sending.')
    // Focus still goes to the first field to fix
    expect(screen.getByLabelText(/Name/)).toHaveFocus()
    type(/Name/, 'svc')
    expect(summary).toHaveTextContent('1 field needs a fix before sending.')
    type('N', '3')
    expect(summary).toBeEmptyDOMElement()
    await send()
    expect(onSend).toHaveBeenCalledWith({ name: 'svc', n: 3 })
  })

  it('date fields use the date inputs', () => {
    renderForm([
      { key: 'd', type: 'string', format: 'date' },
      { key: 'dt', type: 'string', format: 'date-time' },
      { key: 'b', type: 'boolean', default: true },
    ])
    expect(screen.getByLabelText('d')).toHaveAttribute('type', 'date')
    expect(screen.getByLabelText('dt')).toHaveAttribute(
      'type',
      'datetime-local',
    )
    expect(screen.getByLabelText('b')).toBeChecked()
  })

  it('shows what is missing or out of range only once a send is tried', async () => {
    renderForm([
      { key: 'name', type: 'string', title: 'Name', required: true },
      { key: 'n', type: 'integer', title: 'N', minimum: 1, maximum: 5 },
      { key: 'x', type: 'number', title: 'X', minimum: 0 },
      { key: 'y', type: 'number', title: 'Y', maximum: 1 },
      {
        key: 'r',
        type: 'multiselect',
        title: 'R',
        options: [
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B' },
          { value: 'c', label: 'C' },
        ],
        minItems: 1,
        maxItems: 2,
      },
      {
        key: 'few',
        type: 'multiselect',
        title: 'Few',
        options: [{ value: 'a', label: 'A1' }],
        minItems: 2,
      },
      {
        key: 'one',
        type: 'multiselect',
        title: 'One',
        options: [
          { value: 'a', label: 'A2' },
          { value: 'b', label: 'B2' },
        ],
        maxItems: 1,
      },
    ])
    type('N', '9')
    type('X', '-1')
    type('Y', '2')
    for (const name of ['A', 'B', 'C', 'A1', 'A2', 'B2'])
      fireEvent.click(screen.getByRole('checkbox', { name }))
    expect(screen.queryByText('This field needs an answer.')).toBeNull()
    await send()
    expect(onSend).not.toHaveBeenCalled()
    expect(screen.getByText('This field needs an answer.')).toBeInTheDocument()
    expect(screen.getByLabelText(/Name/)).toHaveAttribute(
      'aria-invalid',
      'true',
    )
    expect(screen.getByLabelText(/Name/)).toHaveAccessibleDescription(
      'This field needs an answer.',
    )
    // The first field to fix takes the focus
    expect(screen.getByLabelText(/Name/)).toHaveFocus()
    expect(screen.getByText('Enter a number from 1 to 5.')).toBeInTheDocument()
    expect(
      screen.getByText('Enter a number of at least 0.'),
    ).toBeInTheDocument()
    expect(screen.getByText('Enter a number of at most 1.')).toBeInTheDocument()
    expect(screen.getByText('Choose 1 to 2.')).toBeInTheDocument()
    expect(screen.getByText('Choose at least 2.')).toBeInTheDocument()
    expect(screen.getByText('Choose at most 1.')).toBeInTheDocument()
    expect(screen.getByRole('group', { name: /^R/ })).toHaveAttribute(
      'aria-invalid',
      'true',
    )
  })

  it('a group to fix gives its first input the focus; text out of its length is marked', async () => {
    renderForm([
      {
        key: 'r',
        type: 'multiselect',
        title: 'R',
        options: [{ value: 'a', label: '' }],
        required: true,
      },
      { key: 'a', type: 'string', title: 'A', minLength: 3, maxLength: 5 },
      { key: 'b', type: 'string', title: 'B', minLength: 3 },
      { key: 'c', type: 'string', title: 'C', maxLength: 2 },
    ])
    // An option without a label is named by its value
    const a = screen.getByRole('checkbox', { name: 'a' })
    type('A', 'xy')
    type('B', 'xy')
    type('C', 'xyz')
    await send()
    expect(a).toHaveFocus()
    expect(screen.getByText('Enter 3 to 5 characters.')).toBeInTheDocument()
    expect(screen.getByText('Enter at least 3 characters.')).toBeInTheDocument()
    expect(screen.getByText('Enter at most 2 characters.')).toBeInTheDocument()
  })

  it('a condition on a multiselect holds while the value is picked', async () => {
    renderForm([
      {
        key: 'm',
        type: 'multiselect',
        title: 'M',
        options: [
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B' },
        ],
      },
      {
        key: 'x',
        type: 'string',
        title: 'X',
        when: [{ key: 'm', op: 'eq', value: 'a' }],
      },
      {
        key: 'y',
        type: 'string',
        title: 'Y',
        when: [{ key: 'm', op: 'neq', value: 'a' }],
      },
    ])
    expect(screen.queryByLabelText('X')).toBeNull()
    fireEvent.click(screen.getByRole('checkbox', { name: 'B' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'A' }))
    expect(screen.getByLabelText('X')).toBeInTheDocument()
    expect(screen.queryByLabelText('Y')).toBeNull()
  })

  it('refuses a number that is not whole, and text over the limit', async () => {
    renderForm([
      { key: 'n', type: 'integer', title: 'N' },
      { key: 'x', type: 'number', title: 'X' },
      { key: 's', type: 'string', title: 'S' },
    ])
    type('N', '2.5')
    type('S', 'x'.repeat(1025))
    await send()
    expect(onSend).not.toHaveBeenCalled()
    expect(screen.getByText('Enter a whole number.')).toBeInTheDocument()
    expect(
      screen.getByText('Too long: the limit is 1024 bytes.'),
    ).toBeInTheDocument()
  })

  it('a field shows only while its conditions hold, and is sent only then', async () => {
    renderForm([
      { key: 'public', type: 'boolean', title: 'Public' },
      {
        key: 'domain',
        type: 'string',
        title: 'Domain',
        required: true,
        when: [{ key: 'public', op: 'eq', value: true }],
      },
      {
        key: 'reason',
        type: 'string',
        title: 'Reason',
        when: [{ key: 'public', op: 'neq', value: true }],
      },
    ])
    expect(screen.queryByLabelText(/Domain/)).toBeNull()
    type('Reason', 'internal')
    await send()
    expect(onSend).toHaveBeenLastCalledWith({
      public: false,
      reason: 'internal',
    })
    fireEvent.click(screen.getByLabelText('Public'))
    expect(screen.queryByLabelText('Reason')).toBeNull()
    type(/Domain/, 'd.com')
    await send()
    expect(onSend).toHaveBeenLastCalledWith({ public: true, domain: 'd.com' })
  })

  it('locks every input while sending', () => {
    renderForm([question, { key: 'b', type: 'boolean' }], true)
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
    expect(screen.getByRole('radio', { name: /Red/ })).toBeDisabled()
    expect(screen.getByLabelText('Other answer')).toBeDisabled()
    expect(screen.getByLabelText('b')).toBeDisabled()
  })

  it('marks hidden characters in what the agent wrote', () => {
    renderForm([
      {
        key: 'k',
        type: 'string',
        title: 'Pick\u202e',
        placeholder: 'p\u200b',
      },
    ])
    expect(screen.getByLabelText(/Pick/)).toHaveAccessibleName(/U\+202E/)
    expect(screen.getByLabelText(/Pick/).getAttribute('placeholder')).toMatch(
      /U\+200B/,
    )
  })
})
