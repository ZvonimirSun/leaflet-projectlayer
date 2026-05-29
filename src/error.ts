import type { ProjectLayerDebugCode, ProjectLayerErrorCode, ProjectLayerPublicErrorCode } from './types'

const DEBUG_TO_PUBLIC_ERROR_CODE_MAP: Record<ProjectLayerDebugCode, ProjectLayerPublicErrorCode> = {
  MISSING_MAP_CRS: 'CONFIG_ERROR',
  INVALID_COORDINATE_VALUE: 'CONFIG_ERROR',

  TOO_MANY_SOURCE_TILES: 'TILE_LIMIT_EXCEEDED',
  TOO_MANY_TILE_DEPENDENCIES: 'TILE_LIMIT_EXCEEDED',

  SOURCE_TILE_TIMEOUT: 'TILE_LOAD_ERROR',
  TILE_RENDER_ABORTED: 'UNKNOWN_ERROR',
  SOURCE_TILE_UNSUPPORTED_ELEMENT: 'TILE_LOAD_ERROR',
  SOURCE_TILE_LOAD_FAILED: 'TILE_LOAD_ERROR',

  CANVAS_CONTEXT_UNAVAILABLE: 'RENDER_ERROR',

  PIPELINE_NOT_IMPLEMENTED: 'UNKNOWN_ERROR',
}

const PUBLIC_ERROR_MESSAGE_MAP: Record<ProjectLayerPublicErrorCode, string> = {
  CONFIG_ERROR: 'ProjectLayer configuration is invalid for tile rendering.',
  TILE_LIMIT_EXCEEDED: 'Tile rendering aborted because source tile limits were exceeded.',
  TILE_LOAD_ERROR: 'Tile rendering failed while loading source tiles.',
  RENDER_ERROR: 'Tile rendering failed while drawing output canvas.',
  UNKNOWN_ERROR: 'Tile rendering pipeline failed unexpectedly.',
}

function isDebugCode(code: string): code is ProjectLayerDebugCode {
  return code in DEBUG_TO_PUBLIC_ERROR_CODE_MAP
}

export function mapDebugCodeToPublicErrorCode(debugCode: ProjectLayerDebugCode): ProjectLayerPublicErrorCode {
  return DEBUG_TO_PUBLIC_ERROR_CODE_MAP[debugCode]
}

function resolvePublicErrorMessage(code: ProjectLayerPublicErrorCode): string {
  return PUBLIC_ERROR_MESSAGE_MAP[code]
}

export class ProjectLayerError extends Error {
  readonly code: ProjectLayerErrorCode
  readonly debugCode?: ProjectLayerDebugCode
  readonly debugMessage?: string
  readonly cause?: unknown

  constructor(
    codeOrDebugCode: ProjectLayerPublicErrorCode | ProjectLayerDebugCode,
    message: string,
    options?: {
      debugCode?: ProjectLayerDebugCode
      debugMessage?: string
      cause?: unknown
    },
  ) {
    const resolvedPublicCode = isDebugCode(codeOrDebugCode)
      ? mapDebugCodeToPublicErrorCode(codeOrDebugCode)
      : codeOrDebugCode

    super(resolvePublicErrorMessage(resolvedPublicCode))
    this.name = 'ProjectLayerError'
    this.code = resolvedPublicCode

    if (isDebugCode(codeOrDebugCode)) {
      this.debugCode = codeOrDebugCode
      this.debugMessage = options?.debugMessage ?? message
    }
    else {
      this.debugCode = options?.debugCode
      this.debugMessage = options?.debugMessage
    }

    this.cause = options?.cause
  }
}

export function normalizeProjectLayerError(error: unknown): ProjectLayerError {
  if (error instanceof ProjectLayerError) {
    return error
  }

  if (error instanceof Error) {
    return new ProjectLayerError(
      'UNKNOWN_ERROR',
      'Tile rendering pipeline failed unexpectedly.',
      {
        debugCode: 'PIPELINE_NOT_IMPLEMENTED',
        debugMessage: error.message,
        cause: error,
      },
    )
  }

  return new ProjectLayerError(
    'UNKNOWN_ERROR',
    'Tile rendering pipeline failed unexpectedly.',
    {
      debugCode: 'PIPELINE_NOT_IMPLEMENTED',
      debugMessage: String(error),
      cause: error,
    },
  )
}
