/**
 * robots.txt fetch + lint + URL evaluation. Lint is a pure line-by-line pass
 * over the file (so it can point at line numbers and catch what a parser
 * silently tolerates); evaluation of "may agent X fetch URL Y" is delegated to
 * robots-parser, the same library the Crawl Cove crawler uses, so this tool
 * and the crawler agree.
 */
import robotsParserModule from 'robots-parser'

interface RobotsTxtParser {
  isAllowed(url: string, ua?: string): boolean | undefined
  getMatchingLineNumber(url: string, ua?: string): number
  getSitemaps(): string[]
  getCrawlDelay(ua?: string): number | undefined
}
const robotsParser = robotsParserModule as unknown as (url: string, body: string) => RobotsTxtParser

export type Severity = 'error' | 'warning'
export type FindingCode =
  | 'fetch-error'
  | 'server-error'
  | 'not-text'
  | 'too-large'
  | 'redirected-off-host'
  | 'blocks-everything'
  | 'rule-without-agent'
  | 'unknown-directive'
  | 'noindex-directive'
  | 'crawl-delay'
  | 'sitemap-relative'
  | 'sitemap-not-found'
  | 'no-sitemap'
  | 'duplicate-agent-group'
  | 'blocks-assets'
  | 'wp-admin-ajax'
  | 'url-blocked'

export const SEVERITY: Record<FindingCode, Severity> = {
  'fetch-error': 'error',
  'server-error': 'error',
  'not-text': 'error',
  'too-large': 'error',
  'redirected-off-host': 'warning',
  'blocks-everything': 'error',
  'rule-without-agent': 'error',
  'unknown-directive': 'warning',
  'noindex-directive': 'warning',
  'crawl-delay': 'warning',
  'sitemap-relative': 'error',
  'sitemap-not-found': 'error',
  'no-sitemap': 'warning',
  'duplicate-agent-group': 'warning',
  'blocks-assets': 'warning',
  'wp-admin-ajax': 'warning',
  'url-blocked': 'error'
}

export interface Finding {
  code: FindingCode
  severity: Severity
  message: string
  line?: number
}

export interface UrlVerdict {
  url: string
  agent: string
  allowed: boolean
  /** 1-based line of the rule that decided it, or null when no rule matched (allowed by default). */
  line: number | null
}

export interface RobotsReport {
  robotsUrl: string
  status: number | null
  fetchError: string | null
  bytes: number
  /** Present when the file was fetched and is text. */
  body: string | null
  groups: Array<{ agents: string[]; rules: number; line: number }>
  sitemaps: string[]
  findings: Finding[]
  verdicts: UrlVerdict[]
}

export interface Options {
  timeoutMs: number
  userAgent: string
  /** URLs (absolute or path) to test. Default: "/". */
  urls: string[]
  /** User-agent tokens to test each URL as. */
  agents: string[]
  /** Treat a blocked test URL as a failing finding. */
  expectAllowed: boolean
  /** HEAD each Sitemap: URL (capped at 10). */
  checkSitemaps: boolean
  fetch?: typeof fetch
}

export const DEFAULT_OPTIONS: Options = {
  timeoutMs: 10_000,
  userAgent: 'crawlcove-robots-txt-tester/1.0 (+https://github.com/CrawlCove/robots-txt-tester)',
  urls: ['/'],
  agents: ['*', 'Googlebot', 'Bingbot'],
  expectAllowed: false,
  checkSitemaps: true
}

const MAX_BYTES = 500 * 1024 // Google reads at most 500 KiB
const KNOWN = new Set(['user-agent', 'allow', 'disallow', 'sitemap', 'crawl-delay', 'host', 'clean-param'])
const ASSET_PATTERNS = [/^\/wp-content\/?$/i, /^\/wp-includes\/?$/i, /^\/assets\/?$/i, /^\/static\/?$/i, /^\/_next\/?$/i, /\.css\$?$/i, /\.js\$?$/i, /^\/\*\.css$/i, /^\/\*\.js$/i]

function f(code: FindingCode, message: string, line?: number): Finding {
  return { code, severity: SEVERITY[code], message, ...(line !== undefined ? { line } : {}) }
}

/** Pure: lint the text of a robots.txt. */
export function lint(body: string): { findings: Finding[]; groups: RobotsReport['groups']; sitemaps: Array<{ url: string; line: number }> } {
  const findings: Finding[] = []
  const groups: RobotsReport['groups'] = []
  const sitemaps: Array<{ url: string; line: number }> = []
  const seenAgents = new Map<string, number>()
  let current: RobotsReport['groups'][number] | null = null
  let lastWasAgent = false
  let disallowAllUnderStar = -1
  let hasNoindex = false
  let wpAdminBlockedAt = -1
  let adminAjaxAllowed = false

  const lines = body.replace(/^﻿/, '').split(/\r?\n/)
  lines.forEach((raw, i) => {
    const lineNo = i + 1
    const line = raw.replace(/#.*$/, '').trim()
    if (line === '') return
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line)
    if (!m) {
      findings.push(f('unknown-directive', `"${raw.trim()}" is not a "field: value" line`, lineNo))
      return
    }
    const field = m[1].toLowerCase()
    const value = m[2].trim()

    if (field === 'user-agent') {
      const token = value.toLowerCase()
      if (!lastWasAgent || current === null) {
        current = { agents: [], rules: 0, line: lineNo }
        groups.push(current)
      }
      current.agents.push(value)
      if (seenAgents.has(token)) findings.push(f('duplicate-agent-group', `User-agent "${value}" already has a group at line ${seenAgents.get(token)}; Google merges them, most other crawlers only read the first`, lineNo))
      else seenAgents.set(token, lineNo)
      lastWasAgent = true
      return
    }
    lastWasAgent = false

    if (field === 'sitemap') {
      sitemaps.push({ url: value, line: lineNo })
      if (!/^https?:\/\//i.test(value)) findings.push(f('sitemap-relative', `Sitemap: "${value}" must be an absolute URL`, lineNo))
      return
    }
    if (field === 'allow' || field === 'disallow') {
      if (current === null) {
        findings.push(f('rule-without-agent', `${m[1]}: appears before any User-agent line, so no crawler applies it`, lineNo))
        return
      }
      current.rules += 1
      const forStar = current.agents.some((a) => a === '*' || a.toLowerCase() === 'googlebot')
      if (field === 'disallow' && value === '/' && forStar && disallowAllUnderStar < 0) disallowAllUnderStar = lineNo
      if (field === 'disallow' && forStar && ASSET_PATTERNS.some((p) => p.test(value))) findings.push(f('blocks-assets', `Disallow: ${value} keeps Googlebot from CSS/JS it needs to render pages; Google recommends allowing assets`, lineNo))
      if (field === 'disallow' && /^\/wp-admin\/?$/i.test(value) && forStar) wpAdminBlockedAt = lineNo
      if (field === 'allow' && /admin-ajax\.php/i.test(value)) adminAjaxAllowed = true
      return
    }
    if (field === 'crawl-delay') {
      findings.push(f('crawl-delay', `Crawl-delay is ignored by Google (set crawl rate in Search Console); Bing and Yandex honour it`, lineNo))
      return
    }
    if (field === 'noindex') {
      hasNoindex = true
      findings.push(f('noindex-directive', `Noindex in robots.txt has been unsupported by Google since 2019; use a meta robots tag or X-Robots-Tag on the page`, lineNo))
      return
    }
    if (!KNOWN.has(field)) findings.push(f('unknown-directive', `"${m[1]}" is not a robots.txt directive and is ignored`, lineNo))
  })

  if (disallowAllUnderStar > 0) findings.push(f('blocks-everything', 'Disallow: / under User-agent: * (or Googlebot) blocks the entire site from search engines', disallowAllUnderStar))
  if (wpAdminBlockedAt > 0 && !adminAjaxAllowed) findings.push(f('wp-admin-ajax', 'Disallow: /wp-admin/ without Allow: /wp-admin/admin-ajax.php blocks the endpoint many WordPress themes load content through', wpAdminBlockedAt))
  if (sitemaps.length === 0) findings.push(f('no-sitemap', 'no Sitemap: line — adding one lets every crawler find the sitemap without a Search Console submission'))
  void hasNoindex
  return { findings, groups, sitemaps }
}

/** Fetch + lint + evaluate. `input` may be a site URL or the robots.txt URL itself. */
export async function testRobots(input: string, opts: Options = DEFAULT_OPTIONS): Promise<RobotsReport> {
  const doFetch = opts.fetch ?? fetch
  const site = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`)
  const robotsUrl = `${site.origin}/robots.txt`
  const report: RobotsReport = { robotsUrl, status: null, fetchError: null, bytes: 0, body: null, groups: [], sitemaps: [], findings: [], verdicts: [] }

  let res: Response
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs)
    try {
      res = await doFetch(robotsUrl, { headers: { 'user-agent': opts.userAgent }, signal: controller.signal, redirect: 'follow' })
    } finally {
      clearTimeout(timer)
    }
  } catch (err) {
    const name = err instanceof Error ? err.name : String(err)
    report.fetchError = name === 'AbortError' ? 'TIMEOUT' : (err as Error).message || name
    report.findings.push(f('fetch-error', `${robotsUrl} could not be fetched: ${report.fetchError}. Google treats an unreachable robots.txt as "crawl nothing" until it can be read.`))
    return report
  }
  report.status = res.status
  if (res.url && new URL(res.url).host !== site.host) report.findings.push(f('redirected-off-host', `robots.txt redirected to ${res.url}; Google follows up to 5 hops but the rules then belong to that host`))

  const raw = Buffer.from(await res.arrayBuffer())
  report.bytes = raw.length

  if (res.status === 404 || res.status === 410) {
    report.findings.push(f('no-sitemap', `no robots.txt (HTTP ${res.status}) — every crawler may fetch everything; add one if only to declare your Sitemap`))
    report.body = ''
  } else if (res.status >= 500) {
    report.findings.push(f('server-error', `robots.txt returned HTTP ${res.status}; Google stops crawling the site while robots.txt errors (up to 30 days), then treats it as absent`))
    return report
  } else if (res.status >= 400) {
    report.findings.push(f('fetch-error', `robots.txt returned HTTP ${res.status}; Google treats 4xx other than 404 as "no restrictions" but some crawlers stop`))
    return report
  } else {
    const text = raw.toString('utf8')
    if (/^\s*(<!doctype|<html|<\?xml|{)/i.test(text)) {
      report.findings.push(f('not-text', 'the response is HTML/XML/JSON, not a plain-text robots.txt (an error page served with 200, or a framework catch-all route)'))
      report.body = text
      return report
    }
    if (raw.length > MAX_BYTES) report.findings.push(f('too-large', `${(raw.length / 1024).toFixed(0)} KiB; Google reads only the first 500 KiB and ignores the rest`))
    report.body = text
    const linted = lint(text)
    report.findings.push(...linted.findings)
    report.groups = linted.groups
    report.sitemaps = linted.sitemaps.map((s) => s.url)
  }

  // Evaluate URLs with the same parser the crawler uses.
  const parser = robotsParser(robotsUrl, report.body ?? '')
  for (const u of opts.urls) {
    const abs = /^https?:\/\//i.test(u) ? u : new URL(u, site.origin).toString()
    for (const agent of opts.agents) {
      const allowed = parser.isAllowed(abs, agent) ?? true
      const line = parser.getMatchingLineNumber(abs, agent)
      report.verdicts.push({ url: abs, agent, allowed, line: line > 0 ? line : null })
      if (!allowed && opts.expectAllowed) report.findings.push(f('url-blocked', `${abs} is blocked for ${agent}${line > 0 ? ` by line ${line}` : ''}`, line > 0 ? line : undefined))
    }
  }

  if (opts.checkSitemaps) {
    for (const sm of report.sitemaps.filter((s) => /^https?:\/\//i.test(s)).slice(0, 10)) {
      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), opts.timeoutMs)
        let r: Response
        try {
          r = await doFetch(sm, { method: 'HEAD', headers: { 'user-agent': opts.userAgent }, signal: controller.signal, redirect: 'follow' })
        } finally {
          clearTimeout(timer)
        }
        if (r.status !== 200) report.findings.push(f('sitemap-not-found', `Sitemap: ${sm} returns HTTP ${r.status}`))
      } catch (err) {
        report.findings.push(f('sitemap-not-found', `Sitemap: ${sm} could not be fetched: ${(err as Error).message}`))
      }
    }
  }
  return report
}
