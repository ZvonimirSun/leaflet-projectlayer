import { describe, expect, it } from 'vitest'
import { normalizeProjectLayerError, ProjectLayerError } from '../error'

describe('error normalization', () => {
  it('将调试码映射为稳定公共错误码，并保留调试字段', () => {
    const error = new ProjectLayerError(
      'TOO_MANY_SOURCE_TILES',
      'Source tile limit exceeded for target tile 0/0/0.',
    )

    expect(error.code).toBe('TILE_LIMIT_EXCEEDED')
    expect(error.debugCode).toBe('TOO_MANY_SOURCE_TILES')
    expect(error.debugMessage).toContain('Source tile limit exceeded')
    expect(error.message).toContain('source tile limits were exceeded')
  })

  it('normalize 遇到普通 Error 时会转换为 UNKNOWN_ERROR 并附带调试信息', () => {
    const cause = new Error('upstream failure')
    const error = normalizeProjectLayerError(cause)

    expect(error.code).toBe('UNKNOWN_ERROR')
    expect(error.debugCode).toBe('PIPELINE_NOT_IMPLEMENTED')
    expect(error.debugMessage).toBe('upstream failure')
    expect(error.cause).toBe(cause)
  })

  it('normalize 遇到 ProjectLayerError 时保持引用不变', () => {
    const original = new ProjectLayerError('SOURCE_TILE_LOAD_FAILED', 'Source tile failed to load')

    expect(normalizeProjectLayerError(original)).toBe(original)
  })
})
