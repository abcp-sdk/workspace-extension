import { describe, expect, it } from 'vitest'
import { CATALOG, tr } from '../src/i18n.js'

describe('workspace i18n', () => {
  it('renders English by default', () => {
    expect(tr('en', 'startedJob', { jobId: 'j1' })).toBe('Started job j1.')
    expect(tr('', 'noJobs')).toBe('No jobs.')
  })

  it('renders Chinese for a zh locale (incl. region subtags)', () => {
    expect(tr('zh', 'startedJob', { jobId: 'j1' })).toBe('已启动任务 j1。')
    expect(tr('zh-CN', 'killedJob', { jobId: 'j9' })).toBe('已终止任务 j9。')
    expect(tr('zh-Hans', 'noJobs')).toBe('没有任务。')
  })

  it('falls back to English for an unknown locale', () => {
    expect(tr('de', 'noJobs')).toBe('No jobs.')
  })

  it('interpolates all placeholders in each locale', () => {
    const en = tr('en', 'uploaded', { path: 'a.txt', code: 'c1', mime: 'text/plain', bytes: 3 })
    const zh = tr('zh', 'uploaded', { path: 'a.txt', code: 'c1', mime: 'text/plain', bytes: 3 })
    expect(en).toBe("Uploaded 'a.txt' as file:c1 (text/plain, 3 bytes).")
    expect(zh).toBe("已上传 'a.txt' 为 file:c1（text/plain，3 字节）。")
  })

  it('every catalog entry carries the en + zh columns', () => {
    for (const [key, entry] of Object.entries(CATALOG)) {
      expect(entry.en, `${key}.en`).toBeTypeOf('string')
      expect(entry.zh, `${key}.zh`).toBeTypeOf('string')
      expect(entry.en.length, `${key}.en non-empty`).toBeGreaterThan(0)
      expect(entry.zh.length, `${key}.zh non-empty`).toBeGreaterThan(0)
    }
  })
})
