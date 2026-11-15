/**
 * Metadata for a record that has no DOI, found through Signposting
 * (https://signposting.org/). The record's landing page names its metadata
 * records with rel="describedby" links, either directly in its Link headers or
 * in a linkset document (rel="linkset", RFC 9264) in application/linkset+json
 * or application/linkset form. The first metadata record Kotahi can read
 * (DataCite JSON, CSL JSON or schema.org JSON-LD) fills the manuscript.
 *
 * Every URL comes from an incoming Offer, so requests are limited: http(s)
 * only, no private, loopback or link-local addresses (checked again on each
 * redirect), a short timeout, a size cap and a small number of requests.
 */
const dns = require('dns').promises
const net = require('net')
const { logger, uuid } = require('@coko/server')
const axios = require('axios')

const TIMEOUT_MS = 10000
const MAX_BYTES = 2 * 1024 * 1024
const MAX_REDIRECTS = 5
const MAX_METADATA_FETCHES = 4

// Metadata formats Kotahi can read, best first
const METADATA_TYPES = [
  'application/vnd.datacite.datacite+json',
  'application/x-datacite+json',
  'application/vnd.citationstyles.csl+json',
  'application/citeproc+json',
  'application/ld+json',
]

const LINKSET_TYPES = ['application/linkset+json', 'application/linkset']

const ORCID_PATTERN = /\d{4}-\d{4}-\d{4}-\d{3}[0-9X]\b/

// #region Link header and linkset parsing

const resolveUrl = (value, base) => {
  try {
    return new URL(value, base).href
  } catch {
    return null
  }
}

/**
 * Parses an RFC 8288 Link header, or an application/linkset document (which
 * uses the same syntax, with anchors and line breaks), into links.
 * @param {string} value
 * @param {string} baseUrl The URL that relative references resolve against
 * @returns {{href: string, rel: string[], type?: string, anchor?: string}[]}
 */
const parseLinkHeader = (value, baseUrl) => {
  const links = []
  if (typeof value !== 'string') return links

  let i = 0
  const skipSpace = () => {
    while (i < value.length && /[\s,]/.test(value[i])) i += 1
  }

  while (i < value.length) {
    skipSpace()
    if (value[i] !== '<') break
    const end = value.indexOf('>', i)
    if (end === -1) break
    const target = value.slice(i + 1, end).trim()
    i = end + 1
    const params = {}

    // ; name [= token | "quoted string"]
    for (;;) {
      while (i < value.length && /\s/.test(value[i])) i += 1
      if (value[i] !== ';') break
      i += 1
      while (i < value.length && /\s/.test(value[i])) i += 1
      const nameMatch = /^[^\s=;,]+/.exec(value.slice(i))
      if (!nameMatch) break
      const name = nameMatch[0].toLowerCase().replace(/\*$/, '')
      i += nameMatch[0].length
      while (i < value.length && /\s/.test(value[i])) i += 1
      let paramValue = ''

      if (value[i] === '=') {
        i += 1
        while (i < value.length && /\s/.test(value[i])) i += 1

        if (value[i] === '"') {
          i += 1
          while (i < value.length && value[i] !== '"') {
            if (value[i] === '\\' && i + 1 < value.length) i += 1
            paramValue += value[i]
            i += 1
          }
          i += 1
        } else {
          const tokenMatch = /^[^;,\s]*/.exec(value.slice(i))
          paramValue = tokenMatch[0]
          i += paramValue.length
        }
      }

      // The first occurrence of a parameter wins (RFC 8288)
      if (!(name in params)) params[name] = paramValue
    }

    const anchor =
      params.anchor !== undefined ? resolveUrl(params.anchor, baseUrl) : null

    const href = resolveUrl(target, anchor || baseUrl)

    if (href && params.rel) {
      links.push({
        href,
        rel: params.rel.toLowerCase().split(/\s+/).filter(Boolean),
        ...(params.type ? { type: params.type.toLowerCase() } : {}),
        ...(anchor ? { anchor } : {}),
      })
    }
  }

  return links
}

/**
 * Parses an application/linkset+json document (RFC 9264) into links.
 * @param {object|string} document
 * @param {string} baseUrl The linkset's URL
 */
const parseLinksetJson = (document, baseUrl) => {
  const json = typeof document === 'string' ? JSON.parse(document) : document
  const links = []

  ;(Array.isArray(json?.linkset) ? json.linkset : []).forEach(context => {
    const anchor = context.anchor ? resolveUrl(context.anchor, baseUrl) : null

    Object.entries(context).forEach(([rel, targets]) => {
      if (rel === 'anchor' || !Array.isArray(targets)) return

      targets.forEach(target => {
        const href = target?.href && resolveUrl(target.href, anchor || baseUrl)
        if (!href) return

        links.push({
          href,
          rel: [rel.toLowerCase()],
          ...(target.type ? { type: String(target.type).toLowerCase() } : {}),
          ...(anchor ? { anchor } : {}),
        })
      })
    })
  })

  return links
}

const normalizeUrl = value => {
  try {
    const url = new URL(value)
    url.hash = ''
    return url.href.replace(/\/+$/, '')
  } catch {
    return value
  }
}

/**
 * The links that are about the record: those whose anchor is the record (a
 * link without an anchor is about the URL it came with). When no link names
 * the record, falls back to the first anchor that has describedby links, as
 * a linkset may name the landing page by another URL.
 */
const linksForRecord = (links, recordUrls) => {
  const wanted = new Set(recordUrls.filter(Boolean).map(normalizeUrl))
  const own = links.filter(l => !l.anchor || wanted.has(normalizeUrl(l.anchor)))

  if (own.some(l => l.rel.includes('describedby'))) return own

  const fallbackAnchor = links.find(l => l.rel.includes('describedby'))?.anchor

  return fallbackAnchor ? links.filter(l => l.anchor === fallbackAnchor) : own
}

// #endregion

// #region Fetching

const isPrivateAddress = address => {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number)

    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    )
  }

  if (net.isIPv6(address)) {
    const lower = address.toLowerCase()
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower)
    if (mapped) return isPrivateAddress(mapped[1])

    return (
      lower === '::' ||
      lower === '::1' ||
      /^f[cd]/.test(lower) ||
      /^fe[89ab]/.test(lower) ||
      /^ff/.test(lower)
    )
  }

  return true
}

/** Throws unless the URL is http(s) on a host with only public addresses */
const assertFetchable = async value => {
  const url = new URL(value)

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`Signposting: refusing ${url.protocol} URL`)
  }

  if (process.env.COAR_SIGNPOSTING_ALLOW_PRIVATE_HOSTS === 'true') return

  const host = url.hostname.replace(/^\[|\]$/g, '')

  const addresses = net.isIP(host)
    ? [{ address: host }]
    : await dns.lookup(host, { all: true, verbatim: true })

  if (!addresses.length || addresses.some(a => isPrivateAddress(a.address))) {
    throw new Error(`Signposting: refusing non-public host ${url.hostname}`)
  }
}

/**
 * GET a URL, following redirects by hand so that each hop is checked.
 * @returns {Promise<{url: string, headers: object, data: string}>}
 */
const fetchUrl = async (startUrl, accept) => {
  let url = startUrl

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    // eslint-disable-next-line no-await-in-loop
    await assertFetchable(url)

    // eslint-disable-next-line no-await-in-loop
    const response = await axios.get(url, {
      headers: { Accept: accept },
      timeout: TIMEOUT_MS,
      maxContentLength: MAX_BYTES,
      maxRedirects: 0,
      responseType: 'text',
      transformResponse: [data => data],
      validateStatus: status => status >= 200 && status < 400,
    })

    const location = response.headers?.location

    if (response.status >= 300 && location) {
      url = resolveUrl(location, url)
      if (!url) throw new Error('Signposting: bad redirect')
    } else if (response.status >= 300) {
      throw new Error(`Signposting: ${response.status} without Location`)
    } else {
      return { url, headers: response.headers ?? {}, data: response.data }
    }
  }

  throw new Error('Signposting: too many redirects')
}

const getHeader = (headers, name) => {
  if (typeof headers?.get === 'function') {
    const value = headers.get(name)
    if (value !== undefined && value !== null) return value
  }

  const key = Object.keys(headers ?? {}).find(k => k.toLowerCase() === name)
  const value = key ? headers[key] : undefined

  return Array.isArray(value) ? value.join(', ') : value
}

const parseJson = data => (typeof data === 'string' ? JSON.parse(data) : data)

// #endregion

// #region Metadata mapping

const toArray = value => {
  if (value === undefined || value === null) return []
  return Array.isArray(value) ? value : [value]
}

const textOf = value => {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return textOf(value[0])
  if (value && typeof value === 'object') return value['@value'] || ''
  return ''
}

const findOrcid = value => {
  const match = toArray(value)
    .map(v => (typeof v === 'object' ? v?.['@id'] || v?.value : v))
    .map(v => (typeof v === 'string' ? ORCID_PATTERN.exec(v) : null))
    .find(Boolean)

  return match ? match[0] : ''
}

/** Splits "Family, Given" or "Given Family" when only a full name is given */
const splitName = name => {
  const full = (name || '').trim()
  if (!full) return { firstName: '', lastName: '' }

  if (full.includes(',')) {
    const [last, ...first] = full.split(',')
    return { firstName: first.join(',').trim(), lastName: last.trim() }
  }

  const parts = full.split(/\s+/)
  const lastName = parts.pop()

  return { firstName: parts.join(' '), lastName }
}

const makeAuthor = ({ firstName, lastName, orcid = '', ror = [] }) => ({
  firstName: firstName || '',
  middleName: '',
  lastName: lastName || '',
  email: '',
  id: uuid(),
  ror,
  orcid,
})

const firstAuthorName = $authors =>
  $authors[0]
    ? `${$authors[0].lastName}, ${$authors[0].firstName}`.replace(/, $/, '')
    : ''

const pad = n => String(n).padStart(2, '0')

/** DataCite JSON, as the DataCite REST API or InvenioRDM exports it */
const mapDatacite = json => {
  const data = json?.data?.attributes ?? json?.attributes ?? json

  const title = textOf(
    toArray(data?.titles).find(t => !t.titleType)?.title ??
      toArray(data?.titles)[0]?.title,
  )

  if (!title) return null

  const descriptions = toArray(data.descriptions)

  const abstract =
    (
      descriptions.find(d => d.descriptionType === 'Abstract') ??
      descriptions[0]
    )?.description ?? ''

  const $authors = toArray(data.creators)
    .filter(c => c.nameType !== 'Organizational')
    .map(c => {
      const names =
        c.givenName || c.familyName
          ? { firstName: c.givenName, lastName: c.familyName }
          : splitName(c.name)

      const orcid = findOrcid(
        toArray(c.nameIdentifiers)
          .filter(n => /orcid/i.test(n?.nameIdentifierScheme ?? 'orcid'))
          .map(n => n.nameIdentifier),
      )

      const ror = toArray(c.affiliation).map(a =>
        typeof a === 'string'
          ? { label: a, value: '' }
          : {
              label: a.name || '',
              value: /ror/i.test(a.affiliationIdentifierScheme ?? '')
                ? a.affiliationIdentifier
                : '',
            },
      )

      return makeAuthor({ ...names, orcid, ror })
    })

  const dates = toArray(data.dates)

  const publishedDate =
    dates.find(d => d.dateType === 'Issued')?.date ??
    (data.publicationYear ? String(data.publicationYear) : '')

  const publisher =
    typeof data.publisher === 'string' ? data.publisher : data.publisher?.name

  return {
    title,
    abstract,
    $authors,
    author: firstAuthorName($authors),
    publishedDate,
    topics: toArray(data.subjects)
      .map(s => (typeof s === 'string' ? s : s.subject))
      .filter(Boolean),
    journal: publisher || '',
    url: data.url || '',
  }
}

/** CSL JSON (application/vnd.citationstyles.csl+json) */
const mapCsl = json => {
  const data = Array.isArray(json) ? json[0] : json
  const title = textOf(data?.title)
  if (!title) return null

  const $authors = toArray(data.author).map(a =>
    makeAuthor({
      ...(a.family || a.given
        ? { firstName: a.given, lastName: a.family }
        : splitName(a.literal)),
      orcid: findOrcid(a.ORCID ?? a.orcid),
    }),
  )

  const [year, month, day] = data.issued?.['date-parts']?.[0] ?? []

  const publishedDate = year
    ? [year, month && pad(month), day && pad(day)].filter(Boolean).join('-')
    : textOf(data.issued?.raw) || ''

  const keywords = data.keyword ?? data.keywords ?? data.categories ?? []

  return {
    title,
    abstract: textOf(data.abstract),
    $authors,
    author: firstAuthorName($authors),
    publishedDate,
    topics: (typeof keywords === 'string'
      ? keywords.split(/\s*[,;]\s*/)
      : toArray(keywords)
    ).filter(Boolean),
    journal: textOf(data['container-title']) || textOf(data.publisher),
    url: data.URL || '',
  }
}

/** schema.org JSON-LD (application/ld+json) */
const mapSchemaOrg = json => {
  const nodes = toArray(json).flatMap(n => [n, ...toArray(n?.['@graph'])])

  const data = nodes.find(
    n => n && typeof n === 'object' && (n.name || n.headline),
  )

  const title = textOf(data?.name) || textOf(data?.headline)
  if (!title) return null

  const people = toArray(data.creator ?? data.author)

  const $authors = people
    .filter(p => toArray(p['@type']).join() !== 'Organization')
    .map(p => {
      const names =
        p.givenName || p.familyName
          ? { firstName: textOf(p.givenName), lastName: textOf(p.familyName) }
          : splitName(textOf(p.name))

      const ror = toArray(p.affiliation).map(a =>
        typeof a === 'string'
          ? { label: a, value: '' }
          : {
              label: textOf(a.name),
              value:
                [a['@id'], a.identifier]
                  .map(textOf)
                  .find(v => /ror\.org/.test(v)) || '',
            },
      )

      return makeAuthor({
        ...names,
        orcid: findOrcid([p['@id'], p.identifier, p.sameAs].flat()),
        ror,
      })
    })

  const keywords = data.keywords ?? []

  return {
    title,
    abstract: textOf(data.description) || textOf(data.abstract),
    $authors,
    author: firstAuthorName($authors),
    publishedDate: textOf(data.datePublished) || textOf(data.dateCreated),
    topics: (typeof keywords === 'string'
      ? keywords.split(/\s*,\s*/)
      : toArray(keywords).map(textOf)
    ).filter(Boolean),
    journal:
      textOf(data.publisher?.name) ||
      textOf(data.isPartOf?.name) ||
      (typeof data.publisher === 'string' ? data.publisher : ''),
    url: textOf(data.url),
  }
}

const mapperFor = type => {
  if (/datacite\+json$/.test(type)) return mapDatacite
  if (/(csl|citeproc)\+json$/.test(type)) return mapCsl
  if (type === 'application/ld+json') return mapSchemaOrg
  return null
}

// #endregion

/**
 * The Signposting links about a record: from its landing page's Link headers
 * and, when those name no metadata record, from its linkset documents.
 * @param {string} recordUrl The landing page
 */
const discoverLinks = async recordUrl => {
  const page = await fetchUrl(recordUrl, 'text/html, */*;q=0.8')
  const recordUrls = [recordUrl, page.url]

  let links = linksForRecord(
    parseLinkHeader(getHeader(page.headers, 'link'), page.url),
    recordUrls,
  )

  if (links.some(l => l.rel.includes('describedby'))) return links

  const linksets = links
    .filter(l => l.rel.includes('linkset'))
    .sort(
      (a, b) =>
        (LINKSET_TYPES.indexOf(a.type) + 1 || 9) -
        (LINKSET_TYPES.indexOf(b.type) + 1 || 9),
    )

  // eslint-disable-next-line no-restricted-syntax
  for (const linkset of linksets.slice(0, 2)) {
    try {
      // A linkset without a type is negotiated, JSON first
      const accept = linkset.type || LINKSET_TYPES.join(', ')
      // eslint-disable-next-line no-await-in-loop
      const doc = await fetchUrl(linkset.href, accept)

      const contentType = String(
        getHeader(doc.headers, 'content-type') || linkset.type || '',
      ).toLowerCase()

      const text = typeof doc.data === 'string' ? doc.data.trim() : ''

      const parsed =
        contentType.includes('linkset+json') ||
        (!contentType.includes('linkset') && /^[{[]/.test(text)) ||
        (doc.data && typeof doc.data === 'object')
          ? parseLinksetJson(doc.data, doc.url)
          : parseLinkHeader(doc.data, doc.url)

      links = [...links, ...linksForRecord(parsed, recordUrls)]

      if (links.some(l => l.rel.includes('describedby'))) return links
    } catch (error) {
      logger.warn(`Signposting: linkset ${linkset.href}: ${error.message}`)
    }
  }

  return links
}

/**
 * Metadata for a record, found through Signposting, in the shape the COAR
 * inbox uses for Crossref and DataCite metadata. Tries each URL in turn and
 * returns null when none leads to a metadata record Kotahi can read.
 * @param {string[]} recordUrls Candidate landing pages, best first
 * @returns {Promise<object|null>}
 */
const getSignpostingMetadata = async recordUrls => {
  if (process.env.COAR_SIGNPOSTING === 'false') return null

  const urls = [...new Set(recordUrls.filter(Boolean))]

  // eslint-disable-next-line no-restricted-syntax
  for (const recordUrl of urls) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const links = await discoverLinks(recordUrl)

      const candidates = links
        .filter(l => l.rel.includes('describedby') && mapperFor(l.type))
        .sort(
          (a, b) =>
            METADATA_TYPES.indexOf(a.type) - METADATA_TYPES.indexOf(b.type),
        )
        .slice(0, MAX_METADATA_FETCHES)

      // eslint-disable-next-line no-restricted-syntax
      for (const link of candidates) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const { data } = await fetchUrl(link.href, link.type)
          const metadata = mapperFor(link.type)(parseJson(data))

          if (metadata) {
            return {
              ...metadata,
              url: metadata.url || recordUrl,
              source: { href: link.href, type: link.type },
            }
          }
        } catch (error) {
          logger.warn(`Signposting: ${link.href}: ${error.message}`)
        }
      }
    } catch (error) {
      logger.warn(`Signposting: ${recordUrl}: ${error.message}`)
    }
  }

  return null
}

module.exports = {
  getSignpostingMetadata,
  isPrivateAddress,
  mapCsl,
  mapDatacite,
  mapSchemaOrg,
  parseLinkHeader,
  parseLinksetJson,
}
