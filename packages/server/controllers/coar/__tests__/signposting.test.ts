import {
  isPrivateAddress,
  mapCsl,
  mapDatacite,
  mapSchemaOrg,
  parseLinkHeader,
  parseLinksetJson,
} from '../signposting'

const RECORD = 'https://repository.test/records/abc'

describe('Signposting', () => {
  describe('parseLinkHeader', () => {
    it('reads several links with quoted and token parameters', () => {
      const header = [
        '<https://doi.org/10.5281/zenodo.1> ; rel="cite-as"',
        '</api/records/abc>;rel=describedby;type="application/ld+json"',
        '<https://example.org/a,b> ; rel="item license" ; title="a, \\"b\\""',
      ].join(', ')

      expect(parseLinkHeader(header, RECORD)).toEqual([
        { href: 'https://doi.org/10.5281/zenodo.1', rel: ['cite-as'] },
        {
          href: 'https://repository.test/api/records/abc',
          rel: ['describedby'],
          type: 'application/ld+json',
        },
        { href: 'https://example.org/a,b', rel: ['item', 'license'] },
      ])
    })

    it('reads an application/linkset document with anchors over several lines', () => {
      const linkset = [
        `<${RECORD}/export/csl>`,
        '   ; rel="describedby"',
        '   ; type="application/vnd.citationstyles.csl+json"',
        `   ; anchor="${RECORD}",`,
        '<content> ; rel="collection" ; anchor="/api/records/abc/files/x"',
      ].join('\n')

      expect(parseLinkHeader(linkset, 'https://repository.test/ls')).toEqual([
        {
          href: `${RECORD}/export/csl`,
          rel: ['describedby'],
          type: 'application/vnd.citationstyles.csl+json',
          anchor: RECORD,
        },
        {
          href: 'https://repository.test/api/records/abc/files/content',
          rel: ['collection'],
          anchor: 'https://repository.test/api/records/abc/files/x',
        },
      ])
    })

    it('ignores links without rel and garbage', () => {
      expect(parseLinkHeader('<https://a.test/>; type="x"', RECORD)).toEqual([])
      expect(parseLinkHeader('not a link header', RECORD)).toEqual([])
      expect(parseLinkHeader(undefined, RECORD)).toEqual([])
    })
  })

  describe('parseLinksetJson', () => {
    it('reads every context and target', () => {
      expect(
        parseLinksetJson(
          JSON.stringify({
            linkset: [
              {
                anchor: RECORD,
                describedby: [
                  { href: '/api/records/abc', type: 'Application/LD+JSON' },
                ],
                'cite-as': [{ href: 'https://doi.org/10.5281/zenodo.1' }],
              },
            ],
          }),
          'https://repository.test/api/records/abc',
        ),
      ).toEqual([
        {
          href: 'https://repository.test/api/records/abc',
          rel: ['describedby'],
          type: 'application/ld+json',
          anchor: RECORD,
        },
        {
          href: 'https://doi.org/10.5281/zenodo.1',
          rel: ['cite-as'],
          anchor: RECORD,
        },
      ])
    })
  })

  describe('isPrivateAddress', () => {
    it.each([
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      'fd00::1',
      'fe80::1',
      '::ffff:127.0.0.1',
    ])('refuses %s', address => {
      expect(isPrivateAddress(address)).toBe(true)
    })

    it.each(['137.184.73.156', '8.8.8.8', '2606:4700:4700::1111'])(
      'allows %s',
      address => {
        expect(isPrivateAddress(address)).toBe(false)
      },
    )
  })

  describe('metadata mapping', () => {
    it('returns null when a record has no title', () => {
      expect(mapDatacite({ titles: [] })).toBeNull()
      expect(mapCsl({})).toBeNull()
      expect(mapSchemaOrg({ '@type': 'Dataset' })).toBeNull()
    })

    it('reads DataCite JSON as the DataCite API wraps it', () => {
      const metadata = mapDatacite({
        data: {
          attributes: {
            titles: [{ title: 'Wrapped' }],
            creators: [{ name: 'Hopper, Grace' }],
            publisher: { name: 'Zenodo' },
            publicationYear: 2025,
          },
        },
      })

      expect(metadata).toMatchObject({
        title: 'Wrapped',
        journal: 'Zenodo',
        publishedDate: '2025',
        author: 'Hopper, Grace',
      })
    })

    it('reads CSL JSON given as an array, with literal names and keywords', () => {
      expect(
        mapCsl([
          {
            title: 'Array',
            author: [{ literal: 'Ada Lovelace' }],
            keyword: 'one, two',
            issued: { 'date-parts': [[2024]] },
          },
        ]),
      ).toMatchObject({
        title: 'Array',
        author: 'Lovelace, Ada',
        topics: ['one', 'two'],
        publishedDate: '2024',
      })
    })

    it('reads schema.org JSON-LD from a @graph', () => {
      expect(
        mapSchemaOrg({
          '@graph': [
            { '@type': 'WebPage' },
            {
              '@type': 'ScholarlyArticle',
              headline: 'In a graph',
              author: { '@type': 'Person', name: 'Alan Turing' },
              publisher: { name: 'Repo' },
            },
          ],
        }),
      ).toMatchObject({
        title: 'In a graph',
        author: 'Turing, Alan',
        journal: 'Repo',
      })
    })
  })
})
