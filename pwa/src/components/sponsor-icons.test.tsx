import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MomoIcon, GithubSponsorsIcon, BuyMeACoffeeIcon } from './sponsor-icons'

describe('MomoIcon', () => {
  it('renders svg with default size', () => {
    const { container } = render(<MomoIcon />)
    const svg = container.querySelector('svg')
    expect(svg).toBeInTheDocument()
    expect(svg).toHaveAttribute('width', '16')
    expect(svg).toHaveAttribute('height', '16')
  })

  it('renders with custom size', () => {
    const { container } = render(<MomoIcon size={32} />)
    const svg = container.querySelector('svg')
    expect(svg).toHaveAttribute('width', '32')
    expect(svg).toHaveAttribute('height', '32')
  })

  it('applies className prop', () => {
    const { container } = render(<MomoIcon className="text-red-500" />)
    const svg = container.querySelector('svg')
    expect(svg).toHaveClass('text-red-500')
  })
})

describe('GithubSponsorsIcon', () => {
  it('renders svg with default size', () => {
    const { container } = render(<GithubSponsorsIcon />)
    const svg = container.querySelector('svg')
    expect(svg).toBeInTheDocument()
    expect(svg).toHaveAttribute('width', '16')
    expect(svg).toHaveAttribute('height', '16')
  })

  it('renders with custom size', () => {
    const { container } = render(<GithubSponsorsIcon size={24} />)
    const svg = container.querySelector('svg')
    expect(svg).toHaveAttribute('width', '24')
    expect(svg).toHaveAttribute('height', '24')
  })

  it('applies className prop', () => {
    const { container } = render(<GithubSponsorsIcon className="text-pink-500" />)
    const svg = container.querySelector('svg')
    expect(svg).toHaveClass('text-pink-500')
  })
})

describe('BuyMeACoffeeIcon', () => {
  it('renders svg with default size', () => {
    const { container } = render(<BuyMeACoffeeIcon />)
    const svg = container.querySelector('svg')
    expect(svg).toBeInTheDocument()
    expect(svg).toHaveAttribute('width', '16')
    expect(svg).toHaveAttribute('height', '16')
  })

  it('renders with custom size', () => {
    const { container } = render(<BuyMeACoffeeIcon size={48} />)
    const svg = container.querySelector('svg')
    expect(svg).toHaveAttribute('width', '48')
    expect(svg).toHaveAttribute('height', '48')
  })

  it('applies className prop', () => {
    const { container } = render(<BuyMeACoffeeIcon className="text-yellow-400" />)
    const svg = container.querySelector('svg')
    expect(svg).toHaveClass('text-yellow-400')
  })
})
