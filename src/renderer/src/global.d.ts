import type { OpenFutureApi } from '../../shared/protocol'

declare global {
  interface Window {
    openfuture: OpenFutureApi
  }
}

export {}
