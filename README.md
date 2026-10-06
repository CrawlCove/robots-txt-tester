# crawlcove-robots-txt-tester

A robots.txt tester for the command line: fetch a site's robots.txt, lint it for the mistakes that quietly block a whole site (or do nothing at all), and test exactly which URLs Googlebot, Bingbot or any other crawler may fetch — with the line number that decided each verdict, and a non-zero exit code for CI.

Need to write one instead? Use [crawlcove.com/tools/robots-txt-generator](https://crawlcove.com/tools/robots-txt-generator?utm_source=github&utm_medium=robots-txt-tester).

## Install

```sh
# one-off, nothing installed (Node 18+):
npx github:CrawlCove/robots-txt-tester https://example.com -u /pricing

# global command, from the release tarball:
npm install -g https://github.com/CrawlCove/robots-txt-tester/archive/refs/tags/v1.0.0.tar.gz
robots-txt-tester --version
```

(The tarball form is deliberate: a global `github:` install on npm 10 leaves a dangling symlink. The npm package is coming.)

## Usage

```sh
robots-txt-tester <site> [options]

  -u, --url <path>        URL or path to test (repeatable; default /)
  -a, --agent <token>     user-agent token to test as (repeatable; default *, Googlebot, Bingbot)
  --expect-allowed        fail if any tested URL is blocked for any tested agent
  --no-check-sitemaps     skip HEAD requests to the Sitemap: URLs
  --timeout <ms>          per-request timeout (default 10000)
  --json                  JSON output
  --fail-on <level>       error (default), warning, none
```

Example — the classic "staging robots.txt shipped to production":

```
$ robots-txt-tester https://www.example.com -u / -u /pricing --expect-allowed
https://www.example.com/robots.txt
  HTTP 200, 0.1 KiB, 1 group(s), 0 sitemap(s)
  line 1: User-agent * — 1 rule(s)

  ✗ BLOCKED  *          https://www.example.com/  (line 2)
  ✗ BLOCKED  Googlebot  https://www.example.com/  (line 2)
  ✗ BLOCKED  Bingbot    https://www.example.com/  (line 2)
  ✗ BLOCKED  *          https://www.example.com/pricing  (line 2)
  ...

  ✗ blocks-everything (line 2): Disallow: / under User-agent: * (or Googlebot) blocks the entire site from search engines
  ✗ url-blocked (line 2): https://www.example.com/ is blocked for * by line 2
  ! no-sitemap: no Sitemap: line — adding one lets every crawler find the sitemap without a Search Console submission

7 error(s), 1 warning(s).
```

Put that in a deploy pipeline with `--expect-allowed` and it fails the deploy before search engines notice. Exit codes: `0` clean (or only warnings with the default `--fail-on error`), `1` a failing finding, `2` usage error.

## What each finding means, and the fix

| Finding | Severity | Why it matters | Fix |
|---|---|---|---|
| `fetch-error` | error | If robots.txt cannot be fetched (DNS, TLS, timeout), Google treats the site as "crawl nothing" until it can read it. | Make `/robots.txt` reachable. |
| `server-error` | error | On a 5xx Google pauses crawling for up to 30 days, then assumes there is no robots.txt. | Return 200 with rules, or a 404. |
| `not-text` | error | An HTML/JSON body at `/robots.txt` (a 200 error page, a framework catch-all) is parsed as garbage — usually as "no rules". | Serve a plain-text file. |
| `too-large` | error | Google reads only the first 500 KiB. Rules after that are ignored. | Trim it. |
| `redirected-off-host` | warning | Rules on the redirect target govern that host, not this one. | Serve robots.txt on every host, or make sure the redirect is intended. |
| `blocks-everything` | error | `Disallow: /` under `*` or `Googlebot` removes the whole site from search. Fine on staging, catastrophic in production. | Delete it, or scope it to a specific path. |
| `rule-without-agent` | error | Allow/Disallow before any `User-agent:` line applies to nobody. | Add the `User-agent:` line above it. |
| `unknown-directive` | warning | Typos (`Dissallow`), stray text or non-standard fields are ignored silently. | Fix the spelling. |
| `noindex-directive` | warning | Google stopped honouring `Noindex:` in robots.txt in 2019. | Use `<meta name="robots" content="noindex">` or `X-Robots-Tag` on the page. |
| `crawl-delay` | warning | Google ignores it; Bing and Yandex honour it. Harmless, but it does not do what most people expect. | Set crawl rate in Search Console if Google is the concern. |
| `sitemap-relative` | error | `Sitemap:` must be an absolute URL. | `Sitemap: https://www.example.com/sitemap.xml` |
| `sitemap-not-found` | error | The declared sitemap does not return 200. | Fix the URL or the sitemap. |
| `no-sitemap` | warning | Without a `Sitemap:` line, crawlers you never submit to cannot find the sitemap. | Add one. |
| `duplicate-agent-group` | warning | Google merges duplicate groups; most other crawlers read only the first. | Merge them by hand. |
| `blocks-assets` | warning | Blocking CSS/JS (`/wp-content/`, `/assets/`, `*.js`) stops Googlebot rendering pages, which hurts indexing. | Allow assets. |
| `wp-admin-ajax` | warning | WordPress themes load content through `/wp-admin/admin-ajax.php`; blocking `/wp-admin/` without allowing it can hide content from Google. | Add `Allow: /wp-admin/admin-ajax.php`. |
| `url-blocked` | error | Only with `--expect-allowed`: a URL you said must be crawlable is not. | Read the deciding line. |

## Works with CrawlCove

This checks the rules file. [Crawl Cove](https://crawlcove.com/?utm_source=github&utm_medium=robots-txt-tester), the desktop SEO crawler for Windows and Mac, applies robots.txt the way Googlebot does across a whole-site crawl and shows you every page it kept you out of — plus which of those are in your sitemap or linked from your navigation.

## Related tools

- [crawlcove-js](https://github.com/CrawlCove/seo-crawl-export-js) — `crawlcove-export`, a typed JavaScript/TypeScript library to load, query and convert Crawl Cove exports.
- [crawlcove-sheets](https://github.com/CrawlCove/seo-audit-google-sheets) — Google Sheets add-on that turns a Crawl Cove export into an audit workbook (issues by type, pages by status, title/meta flags).
- [crawlcove-sf-import](https://github.com/CrawlCove/screaming-frog-export-converter) — convert a Screaming Frog export into the Crawl Cove export format, with a report of what carried over.
- [crawlcove-schema-validator](https://github.com/CrawlCove/schema-markup-validator) — validate a page's JSON-LD against Google's required and recommended rich-result properties.
- [crawlcove-hreflang-checker](https://github.com/CrawlCove/hreflang-checker) — check a page's or a sitemap's hreflang tags: codes, self-reference, x-default and return tags.
- [crawlcove-sitemap-validator](https://github.com/CrawlCove/xml-sitemap-validator) — validate an XML sitemap or sitemap index against the protocol and search-engine limits.
- [crawlcove-redirect-chain-checker](https://github.com/CrawlCove/redirect-chain-checker) — follow every hop of a URL’s redirects; flags chains, loops, HTTPS downgrades and meta refreshes.
- [crawlcove-cli](https://github.com/CrawlCove/seo-crawler-cli) — headless whole-site crawl with redirect-chain, broken-link, title and noindex checks.
- [crawlcove-action](https://github.com/CrawlCove/seo-audit-action) — the same checks as a GitHub Action on every PR.
- [crawlcove-mcp](https://github.com/CrawlCove/seo-mcp-server) — crawl data for Claude, Cursor and other AI assistants.
- [crawlcove-export-spec](https://github.com/CrawlCove/seo-crawl-export-spec) — the JSON Schema for Crawl Cove's crawl export.

## License

MIT — see [LICENSE](LICENSE).
