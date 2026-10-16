// DataApi selection: always the HTTP implementation against the same-origin
// backend (TASK-11 integration 9; the backend web adapter now exists). No
// build-time switching — environment values live in configs/, not env vars.

import { createHttpDataApi } from './http'
import type { DataApi } from './types'

export function createDataApi(): DataApi {
  return createHttpDataApi()
}

let current: DataApi | null = null

export function useDataApi(): DataApi {
  if (!current) current = createDataApi()
  return current
}

/** Tests: swap the instance (e.g. the in-memory mock in ./mock). */
export function setDataApi(api: DataApi | null): void {
  current = api
}

export type * from './types'
