const { default: axios } = require('axios')
const { logger, request } = require('@coko/server')

const apiUrl = 'https://api.ror.org/v2/organizations'

// Truncated exponential backoff with jitter: waits of roughly 1s, 2s and 4s
// (plus up to 1s of jitter each), unless the inbox asks for a Retry-After.
const INBOX_MAX_RETRIES = 3
const INBOX_BASE_DELAY_MS = 1000
const INBOX_MAX_JITTER_MS = 1000
const INBOX_MAX_DELAY_MS = 10000

const RETRYABLE_STATUSES = [408, 429, 500, 502, 503, 504]

const getRorOrganisation = async value => {
  const id = value.split('/').pop()

  try {
    const { data } = await axios.get(`${apiUrl}/${id}`, {})

    const rorDisplay =
      data.names?.find(n => n.types.includes('ror_display'))?.value ?? ''

    return rorDisplay
    /* eslint-disable-next-line */
  } catch (error) {
    logger.error('Failed to get organisation for ROR', id)
    return ''
  }
}

/**
 * Bearer tokens for outgoing COAR Notify messages, from the
 * COAR_OUTBOUND_TOKENS environment variable: a JSON object whose keys are
 * either a full inbox URL or an origin (scheme + host, covering every inbox on
 * that host), and whose values are the tokens. For example:
 * {"https://repo.example.org/api/notify-inbox": "s3cret"}
 * @returns {Record<string, string>}
 */
const getOutboundTokens = () => {
  const raw = process.env.COAR_OUTBOUND_TOKENS

  if (!raw || !raw.trim()) return {}

  try {
    const tokens = JSON.parse(raw)

    if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) {
      throw new Error('expected a JSON object')
    }

    return tokens
  } catch (error) {
    logger.error(
      `COAR: COAR_OUTBOUND_TOKENS is not valid (${error.message}), sending without auth tokens`,
    )
    return {}
  }
}

const withoutTrailingSlash = value => value.replace(/\/+$/, '')

/**
 * Finds the bearer token for an inbox URL: an exact match on the inbox URL
 * wins (trailing slashes ignored), otherwise a key matching its origin.
 * @param {string} url The destination inbox URL
 * @returns {string|null}
 */
const getOutboundTokenForInbox = url => {
  const tokens = getOutboundTokens()
  const entries = Object.entries(tokens)

  if (!entries.length || !url) return null

  const target = withoutTrailingSlash(url)

  const exact = entries.find(([key]) => withoutTrailingSlash(key) === target)

  if (exact) return exact[1] || null

  let origin

  try {
    origin = new URL(url).origin
  } catch {
    return null
  }

  const byOrigin = entries.find(([key]) => withoutTrailingSlash(key) === origin)

  return byOrigin ? byOrigin[1] || null : null
}

/**
 * The actor for outgoing COAR Notify messages. When COAR_ACTOR_ID is set, every
 * message Kotahi sends names this one Service as its actor (named by
 * COAR_ACTOR_NAME, default "Kotahi"), instead of the editor, reviewer or group.
 * Receivers such as InvenioRDM only accept messages whose actor id is
 * registered with them, so a fixed id is easier to register.
 * @param {object} actor The actor Kotahi would otherwise send
 * @returns {object}
 */
const getOutboundActor = actor => {
  const id = process.env.COAR_ACTOR_ID?.trim()

  if (!id) return actor

  return {
    id,
    type: 'Service',
    name: process.env.COAR_ACTOR_NAME?.trim() || 'Kotahi',
  }
}

const MAX_ERROR_BODY_LENGTH = 500

/**
 * An error for a failed POST to an inbox that is safe to log: it carries the
 * status and the inbox's answer, but not the request (with its Authorization
 * header) that an AxiosError holds.
 */
class InboxPostError extends Error {
  constructor(url, error) {
    const { response } = error
    let body = response?.data

    if (body && typeof body !== 'string') body = JSON.stringify(body)

    const detail = body
      ? `: ${String(body).slice(0, MAX_ERROR_BODY_LENGTH)}`
      : ''

    super(`POST to ${url} failed: ${error.message}${detail}`)
    this.name = 'InboxPostError'
    this.code = error.code

    if (response) {
      this.response = {
        status: response.status,
        headers: response.headers,
        data: response.data,
      }
    }
  }
}

const isRetryable = error => {
  const status = error.response?.status

  // No response means the request never reached the inbox (e.g. DNS, reset)
  if (!status) return !!error.request

  return RETRYABLE_STATUSES.includes(status)
}

// Retry-After is either a number of seconds or an HTTP date
const getRetryAfterMs = error => {
  const retryAfter = error.response?.headers?.['retry-after']

  if (!retryAfter) return null

  const seconds = Number(retryAfter)

  if (!Number.isNaN(seconds)) return seconds * 1000

  const date = Date.parse(retryAfter)

  return Number.isNaN(date) ? null : Math.max(date - Date.now(), 0)
}

const getRetryDelayMs = (retryCount, error) => {
  const retryAfterMs = getRetryAfterMs(error)

  const delay =
    retryAfterMs ??
    INBOX_BASE_DELAY_MS * 2 ** retryCount + Math.random() * INBOX_MAX_JITTER_MS

  return Math.min(delay, INBOX_MAX_DELAY_MS)
}

const wait = ms =>
  new Promise(resolve => {
    setTimeout(resolve, ms)
  })

/**
 * POSTs a COAR Notify payload to an LDN inbox, retrying transient failures
 * (network errors, 408, 429 and 5xx gateway errors). Retries resend the same
 * payload, so the receiver can deduplicate on its id. Sends a bearer token
 * when COAR_OUTBOUND_TOKENS has one for this inbox.
 * @param {string} url The destination inbox URL
 * @param {object} payload The COAR Notify payload to be sent
 * @returns {Promise<object>}
 */
const postToInbox = async (url, payload) => {
  const data = typeof payload === 'string' ? payload : JSON.stringify(payload)
  const token = getOutboundTokenForInbox(url)

  const headers = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }

  for (let retryCount = 0; ; retryCount += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await request({
        method: 'post',
        url,
        headers,
        data,
      })
    } catch (error) {
      if (retryCount >= INBOX_MAX_RETRIES || !isRetryable(error)) {
        throw new InboxPostError(url, error)
      }

      const delay = getRetryDelayMs(retryCount, error)

      logger.warn(
        `COAR: POST to ${url} failed (${error.response?.status ?? error.code}), retrying in ${Math.round(delay)}ms`,
      )

      // eslint-disable-next-line no-await-in-loop
      await wait(delay)
    }
  }
}

module.exports = {
  getOutboundActor,
  getOutboundTokenForInbox,
  InboxPostError,
  getRorOrganisation,
  postToInbox,
}
