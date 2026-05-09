import { describe, expect, it } from 'bun:test'
import {
  formatCoAuthorTrailer,
  parseCoAuthor,
  stripMatchingQuotes,
  USAGE,
} from './commit-message.js'

describe('commit-message command helpers', () => {
  it('parses quoted co-author names with a plain email', () => {
    expect(parseCoAuthor('"GPT 5.5" noreply@opalcode.dev')).toEqual({
      name: 'GPT 5.5',
      email: 'noreply@opalcode.dev',
    })
  })

  it('parses co-author trailers with angle-bracket emails', () => {
    expect(parseCoAuthor('OpalCode (gpt-5.5) <noreply@opalcode.dev>')).toEqual(
      {
        name: 'OpalCode (gpt-5.5)',
        email: 'noreply@opalcode.dev',
      },
    )
  })

  it('rejects co-author trailers with empty sanitized names', () => {
    expect(parseCoAuthor('"  " noreply@opalcode.dev')).toBeNull()
    expect(parseCoAuthor('"  " <noreply@opalcode.dev>')).toBeNull()
  })

  it('strips one pair of matching quotes from custom attribution text', () => {
    expect(stripMatchingQuotes('"Generated with OpalCode"')).toBe(
      'Generated with OpalCode',
    )
    expect(stripMatchingQuotes("'Generated with OpalCode'")).toBe(
      'Generated with OpalCode',
    )
    expect(stripMatchingQuotes('"Generated with OpalCode')).toBe(
      '"Generated with OpalCode',
    )
  })

  it('formats a sanitized co-author trailer', () => {
    expect(
      formatCoAuthorTrailer('OpalCode <gpt>\n', '<noreply@opalcode.dev>'),
    ).toBe('Co-Authored-By: OpalCode gpt <noreply@opalcode.dev>')
  })

  it('makes set scope explicit with example text', () => {
    expect(USAGE).toContain(
      'Controls only the attribution text appended after /commit messages.',
    )
    expect(USAGE).toContain(
      '/commit-message set "Generated with OpalCode using GPT-5.5"',
    )
    expect(USAGE).not.toContain('/commit-message set-attribution')
  })
})
