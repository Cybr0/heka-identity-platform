import { INestApplication } from '@nestjs/common'
import { decode } from 'jsonwebtoken'

import { NotificationGateway } from 'src/common/notification/notification.gateway'
import { sleep } from 'src/utils/timers'

export interface WaitUntilOptions {
  /** Maximum time to wait, in ms. Default: 10000 */
  timeout?: number
  /** Delay between condition checks, in ms. Default: 25 */
  interval?: number
  /** Error message used when the condition is not met in time */
  message?: string
}

/**
 * Polls `condition` until it returns `true`, or throws once `timeout` has elapsed.
 * The condition is always checked once more after the last interval before failing.
 * Errors thrown by `condition` are propagated as is.
 */
export async function waitUntil(
  condition: () => boolean | Promise<boolean>,
  { timeout = 10_000, interval = 25, message }: WaitUntilOptions = {},
): Promise<void> {
  const deadline = Date.now() + timeout
  for (;;) {
    if (await condition()) return
    if (Date.now() >= deadline) {
      throw new Error(message ?? `Condition not met within ${timeout} ms`)
    }
    await sleep(interval)
  }
}

/**
 * Resolves once NotificationGateway has registered a WebSocket for the subject (`sub`) of `authToken`.
 *
 * Opening a WebSocket on the client side completes before the server's async `handleConnection`
 * has validated the token and registered the socket, so notifications sent in between are dropped.
 *
 * Note: the check is keyed by user id only. If a socket for the same user is already registered
 * (e.g. a reconnect before the old socket is closed), this resolves immediately.
 */
export async function waitForNotificationSocket(
  nestApp: INestApplication,
  authToken: string,
  options: WaitUntilOptions = {},
): Promise<void> {
  const payload = decode(authToken, { json: true })
  const userId = payload?.sub
  if (!userId) throw new Error('Auth token has no "sub" claim')

  const gateway = nestApp.get(NotificationGateway)
  await waitUntil(() => gateway['connectedSockets'].has(userId), {
    timeout: 30_000,
    message: `NotificationGateway did not register a WebSocket for user ${userId}`,
    ...options,
  })
}
