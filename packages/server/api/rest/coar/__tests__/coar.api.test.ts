import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import { createRequire } from 'module'
import {
  describe,
  beforeAll,
  beforeEach,
  afterEach,
  afterAll,
  it,
  expect,
  vi,
} from 'vitest'
// express comes with @coko/server, which serves the real routes
// eslint-disable-next-line import/no-extraneous-dependencies
import express from 'express'
import { migrationManager, db, config, DbTestUtils } from '@coko/server'

import {
  CoarNotification,
  Form,
  Group,
  Manuscript,
  Token,
} from '../../../../models'

import {
  getOutboundActor,
  postToInbox,
} from '../../../../controllers/coar/utils'

// Outbound HTTP (DOI registration agency, Crossref, the sender's inbox) goes
// through axios. Kotahi and @coko/server each have their own copy, so both get
// a fake adapter rather than reaching the network.
const requireFromHere = createRequire(__filename)

const axiosInstances = [
  requireFromHere('axios'),
  createRequire(requireFromHere.resolve('@coko/server'))('axios'),
]

const ORIGIN_INBOX = 'https://repository.test/inbox'
const DOI = '10.1101/2024.01.01.000001'
const UNKNOWN_DOI = '10.1101/0000.00.00.000000'
const TOKEN = 'test-coar-token'

const crossrefWork = {
  DOI,
  title: ['A preprint about tests'],
  abstract: '<jats:p>An abstract.</jats:p>',
  author: [
    {
      given: 'Ada',
      family: 'Lovelace',
      sequence: 'first',
      affiliation: [
        { name: 'Test University', id: [{ id: 'https://ror.org/test' }] },
      ],
    },
    // Crossref omits these fields for some authors
    { given: 'Grace', family: 'Hopper', sequence: 'additional' },
    {
      given: 'Alan',
      family: 'Turing',
      sequence: 'additional',
      affiliation: [{ name: 'Institute Without ROR' }],
    },
  ],
  published: { 'date-parts': [[2024, 1, 2]] },
  subject: ['Biology'],
  institution: [{ name: 'bioRxiv' }],
  resource: { primary: { URL: 'https://www.biorxiv.org/content/test' } },
}

type SentToOrigin = {
  id?: string
  type: string | string[]
  summary?: string
  actor?: { id: string; type: string; name: string }
}

type AxiosConfig = {
  url: string
  data?: string
  headers?: { get?: (name: string) => unknown; [key: string]: unknown }
}

type InboxFailure = { status: number; headers?: Record<string, string> }

type AxiosResponse = {
  data: unknown
  status: number
  statusText: string
  headers: Record<string, string>
  config: AxiosConfig
}

type CoarPayload = {
  id: string
  object: Record<string, unknown>
  [key: string]: unknown
}

type InboxResult = { status: number; message: string }

let sentToOrigin: SentToOrigin[] = []

// The Authorization header of each request to the origin inbox
let authToOrigin: (string | undefined)[] = []

// Responses the origin inbox gives before it starts accepting notifications
let originInboxFailures: InboxFailure[] = []

const rejectAs = (
  axiosConfig: AxiosConfig,
  { status, headers = {} }: InboxFailure,
): Promise<never> => {
  const { AxiosError } = axiosInstances[1]

  const response = {
    data: 'no available server\n',
    status,
    statusText: String(status),
    headers,
    config: axiosConfig,
    request: {},
  }

  return Promise.reject(
    new AxiosError(
      `Request failed with status code ${status}`,
      AxiosError.ERR_BAD_RESPONSE,
      axiosConfig,
      {},
      response,
    ),
  )
}

const respond = (
  axiosConfig: AxiosConfig,
  status: number,
  data: unknown,
): Promise<AxiosResponse> =>
  Promise.resolve({
    data,
    status,
    statusText: String(status),
    headers: {},
    config: axiosConfig,
  })

const fakeAdapter = (axiosConfig: AxiosConfig): Promise<AxiosResponse> => {
  const { url } = axiosConfig

  if (url.startsWith('https://doi.org/doiRA/')) {
    const doi = url.replace('https://doi.org/doiRA/', '')

    return respond(axiosConfig, 200, [
      doi === UNKNOWN_DOI
        ? { DOI: doi, status: 'DOI does not exist' }
        : { DOI: doi, RA: 'Crossref' },
    ])
  }

  if (url === `https://api.crossref.org/works/doi/${DOI}`) {
    return respond(axiosConfig, 200, { message: crossrefWork })
  }

  if (url === ORIGIN_INBOX) {
    sentToOrigin.push(JSON.parse(axiosConfig.data ?? '{}'))

    const authorization =
      axiosConfig.headers?.get?.('Authorization') ??
      axiosConfig.headers?.Authorization

    authToOrigin.push(authorization ? String(authorization) : undefined)

    const failure = originInboxFailures.shift()

    return failure
      ? rejectAs(axiosConfig, failure)
      : respond(axiosConfig, 201, {})
  }

  return Promise.reject(new Error(`Unexpected outbound request: ${url}`))
}

const buildOffer = (overrides: Record<string, unknown> = {}): CoarPayload => ({
  '@context': [
    'https://www.w3.org/ns/activitystreams',
    'https://purl.org/coar/notify',
  ],
  id: `urn:uuid:${crypto.randomUUID()}`,
  type: ['Offer', 'coar-notify:ReviewAction'],
  actor: { id: 'mailto:author@example.org', name: 'Author', type: 'Person' },
  object: {
    id: 'https://www.biorxiv.org/content/test',
    'ietf:cite-as': `https://doi.org/${DOI}`,
    type: 'sorg:AboutPage',
  },
  origin: {
    id: 'https://repository.test',
    inbox: ORIGIN_INBOX,
    type: 'Service',
  },
  target: {
    id: 'https://kotahi.test',
    inbox: 'https://kotahi.test/api/coar/inbox/coar-group',
    type: 'Service',
  },
  ...overrides,
})

const buildUndo = (offerId: string): CoarPayload =>
  buildOffer({
    type: ['Undo'],
    inReplyTo: offerId,
    object: {
      id: offerId,
      type: ['Offer', 'coar-notify:ReviewAction'],
    },
  })

describe('COAR Notify inbox API', () => {
  let server: Server
  let baseUrl: string
  let originalAdapters: unknown[]
  let group: Group

  const post = async (
    body: unknown,
    {
      groupName = 'coar-group',
      authorization = `Bearer ${TOKEN}`,
    }: { groupName?: string; authorization?: string | null } = {},
  ): Promise<InboxResult> => {
    const response = await fetch(`${baseUrl}/api/coar/inbox/${groupName}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/ld+json',
        ...(authorization ? { Authorization: authorization } : {}),
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })

    return {
      status: response.status,
      message: ((await response.json()) as InboxResult).message,
    }
  }

  const manuscriptsWithDoi = async (): Promise<Manuscript[]> =>
    Manuscript.query().where({ doi: DOI, groupId: group.id })

  beforeAll(async () => {
    await config.init()
    db.init()
    await migrationManager.migrate()

    originalAdapters = axiosInstances.map(a => a.defaults.adapter)
    axiosInstances.forEach(a => {
      a.defaults.adapter = fakeAdapter
    })

    // The COAR controllers read config on load, so import after config.init()
    const { default: registerInbox } = await import('../inbox')

    const app = express()
    app.use(express.json({ type: ['application/json', 'application/ld+json'] }))
    registerInbox(app)

    server = createServer(app)
    await new Promise<void>(resolve => {
      server.listen(0, resolve)
    })
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  beforeEach(async () => {
    sentToOrigin = []
    authToOrigin = []
    originInboxFailures = []

    group = await Group.insert({ name: 'coar-group', isArchived: false })

    await Form.insert({
      groupId: group.id,
      category: 'submission',
      purpose: 'submit',
      structure: {
        name: 'Submission',
        description: null,
        haspopup: 'false',
        popuptitle: null,
        popupdescription: null,
        children: [],
      },
    })

    await Token.generateToken('coar', TOKEN, group.id)
  })

  afterEach(async () => {
    await DbTestUtils.clearDb()
  })

  afterAll(async () => {
    axiosInstances.forEach((a, i) => {
      a.defaults.adapter = originalAdapters[i]
    })

    await new Promise<void>(resolve => {
      server.close(() => resolve())
    })
    await DbTestUtils.clearDb()
    await db.destroy()
  })

  describe('rejections', () => {
    it('rejects an unknown group', async () => {
      const result = await post(buildOffer(), { groupName: 'no-such-group' })

      expect(result).toEqual({ status: 404, message: 'Group not found' })
    })

    it('rejects a group without a COAR token', async () => {
      await Token.deleteByNameAndGroupId('coar', group.id)

      const result = await post(buildOffer())

      expect(result).toEqual({ status: 403, message: 'Unauthorised Request' })
    })

    it.each([
      ['a missing Authorization header', null],
      ['a wrong token', 'Bearer wrong-token'],
      ['a token without the Bearer prefix', TOKEN],
    ])('rejects %s', async (_, authorization) => {
      const result = await post(buildOffer(), { authorization })

      expect(result).toEqual({ status: 403, message: 'Unauthorised Request' })
    })

    it('rejects an empty payload', async () => {
      const result = await post({})

      expect(result).toEqual({ status: 400, message: 'No payload provided' })
    })

    it('rejects an invalid @context', async () => {
      const result = await post(
        buildOffer({ '@context': ['https://example.org'] }),
      )

      expect(result).toEqual({
        status: 400,
        message: 'Property `@context` is invalid',
      })
    })

    it('rejects a DOI that is not registered', async () => {
      const offer = buildOffer()
      offer.object['ietf:cite-as'] = `https://doi.org/${UNKNOWN_DOI}`

      const result = await post(offer)

      expect(result).toEqual({ status: 400, message: 'DOI does not exist' })
    })

    it('stores the rejected payload and flags it to the sender', async () => {
      const offer = buildOffer()

      await post(offer, { authorization: 'Bearer wrong-token' })

      const stored = await CoarNotification.query().where({
        groupId: group.id,
      })

      expect(stored.map(n => n.payload.id)).toContain(offer.id)
      expect(stored.every(n => !n.manuscriptId)).toBe(true)

      expect(sentToOrigin).toHaveLength(1)
      expect(sentToOrigin[0].type).toEqual([
        'Flag',
        'coar-notify:UnprocessableNotification',
      ])
      expect(sentToOrigin[0].summary).toBe('Unauthorised Request')
    })

    describe('with COAR_ACTOR_ID', () => {
      const originalActorId = process.env.COAR_ACTOR_ID

      afterEach(() => {
        if (originalActorId === undefined) {
          delete process.env.COAR_ACTOR_ID
        } else {
          process.env.COAR_ACTOR_ID = originalActorId
        }
      })

      it('names the configured service as the actor of the flag', async () => {
        process.env.COAR_ACTOR_ID = 'https://kotahi.example.org'

        await post(buildOffer(), { authorization: 'Bearer wrong-token' })

        expect(sentToOrigin[0].actor).toEqual({
          id: 'https://kotahi.example.org',
          type: 'Service',
          name: 'Kotahi',
        })
      })

      it('keeps the default actor when it is not set', async () => {
        delete process.env.COAR_ACTOR_ID

        await post(buildOffer(), { authorization: 'Bearer wrong-token' })

        expect(sentToOrigin[0].actor).toMatchObject({
          id: 'https://kotahi.community',
          type: 'Organization',
        })
      })
    })
  })

  describe('offers', () => {
    it('creates a manuscript linked to the offer', async () => {
      const offer = buildOffer()

      const result = await post(offer)

      expect(result).toEqual({
        status: 202,
        message: 'Notification created successfully.',
      })

      const [manuscript] = await manuscriptsWithDoi()
      expect(manuscript.status).toBe('new')
      expect(manuscript.submission.$title).toContain('A preprint about tests')
      expect(
        manuscript.submission.$authors.map(
          (a: { lastName: string; ror: { label: string }[] }) => [
            a.lastName,
            a.ror.map(r => r.label),
          ],
        ),
      ).toEqual([
        ['Lovelace', ['Test University']],
        ['Hopper', []],
        ['Turing', ['Institute Without ROR']],
      ])

      const notification = await CoarNotification.query()
        .whereRaw(`payload->>'id' = ?`, [offer.id])
        .first()

      expect(notification?.manuscriptId).toBe(manuscript.id)
      expect(sentToOrigin).toHaveLength(0)
    })

    it('rejects a second offer for the same DOI', async () => {
      await post(buildOffer())

      const result = await post(buildOffer())

      expect(result).toEqual({
        status: 400,
        message: 'Notification already exists with the same payload.',
      })
      expect(await manuscriptsWithDoi()).toHaveLength(1)
    })

    it('does not let a rejected offer block the DOI', async () => {
      await post(buildOffer(), { authorization: null })

      const result = await post(buildOffer())

      expect(result.status).toBe(202)
      expect(await manuscriptsWithDoi()).toHaveLength(1)
    })

    it('rejects an offer for a manuscript that already exists without one', async () => {
      await Manuscript.query().insert({
        doi: DOI,
        groupId: group.id,
        status: 'new',
        isHidden: false,
        submission: {},
        meta: {},
      })

      const result = await post(buildOffer())

      expect(result).toEqual({
        status: 400,
        message: 'Manuscript already exists with DOI.',
      })
      expect(await manuscriptsWithDoi()).toHaveLength(1)
      expect(sentToOrigin[0].summary).toBe(
        'Manuscript already exists with DOI.',
      )
    })

    it('rolls back the manuscript when storing the notification fails', async () => {
      // Postgres jsonb can't store \u0000, so the insert after the manuscript fails
      const offer = JSON.stringify(buildOffer()).replace(
        '"name":"Author"',
        '"name":"Auth\\u0000or"',
      )

      const result = await post(offer)

      expect(result).toEqual({
        status: 500,
        message: 'Failed to create notification.',
      })
      expect(await manuscriptsWithDoi()).toHaveLength(0)
    })
  })

  describe('undo', () => {
    it('archives the manuscript of the original offer', async () => {
      const offer = buildOffer()
      await post(offer)

      const result = await post(buildUndo(offer.id))

      expect(result).toEqual({
        status: 202,
        message: 'Manuscript archived successfully',
      })

      const [manuscript] = await manuscriptsWithDoi()
      expect(manuscript.isHidden).toBe(true)
    })

    it('rejects an undo for an unknown offer', async () => {
      const result = await post(buildUndo('urn:uuid:unknown'))

      expect(result).toEqual({ status: 404, message: 'Notification not found' })
    })

    it('rejects an undo for an offer that was rejected', async () => {
      const offer = buildOffer()
      await post(offer, { authorization: null })

      const result = await post(buildUndo(offer.id))

      expect(result).toEqual({ status: 404, message: 'Notification not found' })
    })

    it('rejects an undo whose inReplyTo does not match the object', async () => {
      const offer = buildOffer()
      await post(offer)

      const result = await post({
        ...buildUndo(offer.id),
        inReplyTo: 'urn:uuid:something-else',
      })

      expect(result).toEqual({
        status: 400,
        message: 'Property `inReplyTo` does not match `object.id`',
      })
    })
  })

  describe('sending to an inbox', () => {
    type Outcome = { value?: { status: number }; error?: any }

    /** Starts the POST, then runs through every backoff wait */
    const send = async (payload: unknown): Promise<Outcome> => {
      const outcome = postToInbox(ORIGIN_INBOX, payload).then(
        value => ({ value }),
        error => ({ error }),
      )

      await vi.runAllTimersAsync()
      return outcome
    }

    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
      vi.restoreAllMocks()
    })

    it('sends the payload once when the inbox accepts it', async () => {
      const { value } = await send({ id: 'urn:uuid:1', type: 'Announce' })

      expect(value?.status).toBe(201)
      expect(sentToOrigin).toEqual([{ id: 'urn:uuid:1', type: 'Announce' }])
    })

    it('retries a 503 and resends the same payload', async () => {
      originInboxFailures = [{ status: 503 }, { status: 503 }]

      const { value } = await send('{"id":"urn:uuid:2","type":"Announce"}')

      expect(value?.status).toBe(201)
      expect(sentToOrigin).toHaveLength(3)
      expect(new Set(sentToOrigin.map(n => n.id))).toEqual(
        new Set(['urn:uuid:2']),
      )
    })

    it('gives up after three retries', async () => {
      originInboxFailures = Array(4).fill({ status: 503 })

      const { error } = await send({ type: 'Announce' })

      expect(error.response.status).toBe(503)
      expect(sentToOrigin).toHaveLength(4)
    })

    it('does not retry a client error', async () => {
      originInboxFailures = [{ status: 400 }]

      const { error } = await send({ type: 'Announce' })

      expect(error.response.status).toBe(400)
      expect(sentToOrigin).toHaveLength(1)
    })

    it('backs off exponentially between retries', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(0)
      originInboxFailures = Array(3).fill({ status: 502 })

      const outcome = postToInbox(ORIGIN_INBOX, { type: 'Announce' })

      // First attempt goes straight out, then waits of 1s, 2s and 4s
      await vi.advanceTimersByTimeAsync(0)
      expect(sentToOrigin).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(999)
      expect(sentToOrigin).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(sentToOrigin).toHaveLength(2)
      await vi.advanceTimersByTimeAsync(2000)
      expect(sentToOrigin).toHaveLength(3)
      await vi.advanceTimersByTimeAsync(4000)
      expect(sentToOrigin).toHaveLength(4)

      await expect(outcome).resolves.toMatchObject({ status: 201 })
    })

    it('waits as long as Retry-After asks, up to the cap', async () => {
      originInboxFailures = [{ status: 429, headers: { 'retry-after': '5' } }]

      const outcome = postToInbox(ORIGIN_INBOX, { type: 'Announce' })

      await vi.advanceTimersByTimeAsync(4999)
      expect(sentToOrigin).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(sentToOrigin).toHaveLength(2)
      await expect(outcome).resolves.toMatchObject({ status: 201 })

      originInboxFailures = [
        { status: 503, headers: { 'retry-after': '3600' } },
      ]
      sentToOrigin = []

      const capped = postToInbox(ORIGIN_INBOX, { type: 'Announce' })

      await vi.advanceTimersByTimeAsync(10000)
      expect(sentToOrigin).toHaveLength(2)
      await expect(capped).resolves.toMatchObject({ status: 201 })
    })

    it('fails with an error that keeps the inbox answer but not the token', async () => {
      const originalTokens = process.env.COAR_OUTBOUND_TOKENS
      process.env.COAR_OUTBOUND_TOKENS = JSON.stringify({
        [ORIGIN_INBOX]: 'secret-inbox-token',
      })
      originInboxFailures = [{ status: 403 }]

      try {
        const { error } = await send({ type: 'Announce' })

        expect(error.name).toBe('InboxPostError')
        expect(error.response.status).toBe(403)
        expect(error.message).toContain('status code 403')
        expect(error.message).toContain('no available server')
        expect(error.config).toBeUndefined()
        expect(error.request).toBeUndefined()
        expect(JSON.stringify(error)).not.toContain('secret-inbox-token')
        expect(String(error.stack)).not.toContain('secret-inbox-token')
      } finally {
        if (originalTokens === undefined) {
          delete process.env.COAR_OUTBOUND_TOKENS
        } else {
          process.env.COAR_OUTBOUND_TOKENS = originalTokens
        }
      }
    })

    describe('getOutboundActor', () => {
      const person = {
        id: 'https://orcid.org/0000-0000-0000-0001',
        type: 'Person',
        name: 'Editor',
      }
      const original = {
        id: process.env.COAR_ACTOR_ID,
        name: process.env.COAR_ACTOR_NAME,
      }

      afterEach(() => {
        if (original.id === undefined) delete process.env.COAR_ACTOR_ID
        else process.env.COAR_ACTOR_ID = original.id
        if (original.name === undefined) delete process.env.COAR_ACTOR_NAME
        else process.env.COAR_ACTOR_NAME = original.name
      })

      it('returns the given actor when COAR_ACTOR_ID is not set', () => {
        delete process.env.COAR_ACTOR_ID
        expect(getOutboundActor(person)).toBe(person)
      })

      it('ignores a blank COAR_ACTOR_ID', () => {
        process.env.COAR_ACTOR_ID = '  '
        expect(getOutboundActor(person)).toBe(person)
      })

      it('replaces the actor with the configured service', () => {
        process.env.COAR_ACTOR_ID = ' https://kotahi.example.org '
        process.env.COAR_ACTOR_NAME = 'Example Reviews'

        expect(getOutboundActor(person)).toEqual({
          id: 'https://kotahi.example.org',
          type: 'Service',
          name: 'Example Reviews',
        })
      })
    })

    describe('with COAR_OUTBOUND_TOKENS', () => {
      const originalTokens = process.env.COAR_OUTBOUND_TOKENS

      afterEach(() => {
        if (originalTokens === undefined) {
          delete process.env.COAR_OUTBOUND_TOKENS
        } else {
          process.env.COAR_OUTBOUND_TOKENS = originalTokens
        }
      })

      it('sends no Authorization header when no token is configured', async () => {
        delete process.env.COAR_OUTBOUND_TOKENS

        await send({ type: 'Announce' })

        expect(authToOrigin).toEqual([undefined])
      })

      it('sends the bearer token configured for the inbox URL', async () => {
        process.env.COAR_OUTBOUND_TOKENS = JSON.stringify({
          [`${ORIGIN_INBOX}/`]: 'inbox-token',
          'https://repository.test': 'host-token',
        })

        await send({ type: 'Announce' })

        expect(authToOrigin).toEqual(['Bearer inbox-token'])
      })

      it('falls back to a token configured for the inbox host', async () => {
        process.env.COAR_OUTBOUND_TOKENS = JSON.stringify({
          'https://repository.test/': 'host-token',
        })

        await send({ type: 'Announce' })

        expect(authToOrigin).toEqual(['Bearer host-token'])
      })

      it('sends the token again on every retry', async () => {
        process.env.COAR_OUTBOUND_TOKENS = JSON.stringify({
          [ORIGIN_INBOX]: 'inbox-token',
        })
        originInboxFailures = [{ status: 503 }]

        await send({ type: 'Announce' })

        expect(authToOrigin).toEqual([
          'Bearer inbox-token',
          'Bearer inbox-token',
        ])
      })

      it('does not send a token configured for another inbox', async () => {
        process.env.COAR_OUTBOUND_TOKENS = JSON.stringify({
          'https://other.test/inbox': 'other-token',
        })

        await send({ type: 'Announce' })

        expect(authToOrigin).toEqual([undefined])
      })

      it('sends without a token when the setting is not valid JSON', async () => {
        process.env.COAR_OUTBOUND_TOKENS = '{not json'

        const { value } = await send({ type: 'Announce' })

        expect(value?.status).toBe(201)
        expect(authToOrigin).toEqual([undefined])
      })
    })
  })
})
