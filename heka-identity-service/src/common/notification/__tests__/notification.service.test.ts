import { createMock } from '@golevelup/ts-vitest'
import { HttpService } from '@nestjs/axios'

import { MessageDeliveryType, User } from 'common/entities'
import { Logger } from 'common/logger'
import { WebhookEgressService, WebhookTargetPolicyError } from 'common/webhook'

import { NotificationDto } from '../dto'
import { NotificationGateway } from '../notification.gateway'
import { NotificationService } from '../notification.service'

describe('NotificationService', () => {
  let httpService: HttpService
  let post: ReturnType<typeof vi.fn>
  let webhookEgress: WebhookEgressService
  let notificationGateway: NotificationGateway
  let notificationService: NotificationService

  const notification = { type: 'ConnectionStateChanged' } as unknown as NotificationDto

  beforeEach(() => {
    post = vi.fn().mockResolvedValue({ status: 200 })
    httpService = createMock<HttpService>({ axiosRef: { post } } as unknown as Partial<HttpService>)
    webhookEgress = createMock<WebhookEgressService>()
    vi.mocked(webhookEgress.assertCallbackUrlAllowed).mockResolvedValue(undefined)
    notificationGateway = createMock<NotificationGateway>()

    notificationService = new NotificationService(
      httpService,
      webhookEgress,
      notificationGateway,
      { allowHttp: false, allowPrivateAddresses: false, timeoutMs: 10_000 },
      createMock<Logger>({ child: () => createMock<Logger>() }),
    )
  })

  test('posts to the webhook after the URL passes the egress policy', async () => {
    const user = new User({ id: '11', messageDeliveryType: MessageDeliveryType.WebHook, webHook: 'https://hooks.dev' })

    await expect(notificationService.trySendNotification(user, notification)).resolves.toBe(true)

    expect(webhookEgress.assertCallbackUrlAllowed).toHaveBeenCalledWith('https://hooks.dev')
    expect(post).toHaveBeenCalledWith(
      'https://hooks.dev',
      notification,
      expect.objectContaining({ signal: expect.anything() }),
    )
  })

  // A stored URL can become disallowed after it was saved (policy change or new DNS answer),
  // so the check runs again on every send and must happen before the request is issued.
  test('does not post when the stored webhook is rejected by the policy', async () => {
    const user = new User({
      id: '11',
      messageDeliveryType: MessageDeliveryType.WebHook,
      webHook: 'http://169.254.169.254/latest/meta-data',
    })
    vi.mocked(webhookEgress.assertCallbackUrlAllowed).mockRejectedValue(
      new WebhookTargetPolicyError('ADDR', 'Webhook target address is not permitted'),
    )

    await expect(notificationService.trySendNotification(user, notification)).resolves.toBe(false)

    expect(post).not.toHaveBeenCalled()
  })

  test('reports a failed delivery without throwing', async () => {
    const user = new User({ id: '11', messageDeliveryType: MessageDeliveryType.WebHook, webHook: 'https://hooks.dev' })
    post.mockRejectedValue(Object.assign(new Error('canceled'), { code: 'ERR_CANCELED' }))

    await expect(notificationService.trySendNotification(user, notification)).resolves.toBe(false)
  })

  test('uses the WebSocket gateway and skips the egress policy for non-webhook users', async () => {
    const user = new User({ id: '11', messageDeliveryType: MessageDeliveryType.WebSocket })

    await expect(notificationService.trySendNotification(user, notification)).resolves.toBe(true)

    expect(notificationGateway.send).toHaveBeenCalledWith('11', notification)
    expect(webhookEgress.assertCallbackUrlAllowed).not.toHaveBeenCalled()
    expect(post).not.toHaveBeenCalled()
  })
})
