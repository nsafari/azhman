import axios from "axios";
import * as cheerio from "cheerio";
import pLimit from "p-limit";
import path from "node:path";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";

interface CrawlOptions {
  startUrl: string;
  outputDir: string;
  maxPages: number;
  concurrency: number;
  delayMs: number;
  timeoutMs: number;
  includeSubdomains: boolean;
  retryCount: number;
  retryBackoffMs: number;
  seedSitemap: boolean;
  downloadReferencedAssets: boolean;
  assetConcurrency: number;
}

interface LinkInfo {
  url: string;
  text: string;
  rel: string;
  isInternal: boolean;
}

interface PageRecord {
  id: string;
  url: string;
  path: string;
  status: number;
  contentType: string;
  lang: string;
  title: string;
  description: string;
  h1: string[];
  textContent: string;
  links: LinkInfo[];
  assets: {
    images: string[];
    scripts: string[];
    stylesheets: string[];
  };
  fetchedAt: string;
  savedHtmlPath: string;
  savedMarkdownPath: string;
}

interface CrawlManifest {
  startUrl: string;
  crawledAt: string;
  totalPages: number;
  options: CrawlOptions;
  pages: Array<Pick<PageRecord, "id" | "url" | "path" | "title" | "lang" | "savedHtmlPath" | "savedMarkdownPath">>;
  brokenLinks: Array<{ from: string; to: string; reason: string }>;
  assetDownload?: AssetDownloadSummary;
}

interface CssReference {
  url: string;
  kind: "import" | "asset";
}

interface DownloadedAssetRecord {
  url: string;
  localPath: string;
  kind: "css" | "asset";
  status: "downloaded" | "failed";
  contentType: string;
  reason?: string;
}

interface AssetDownloadSummary {
  enabled: boolean;
  cssDiscovered: number;
  cssDownloaded: number;
  assetDiscovered: number;
  assetDownloaded: number;
  failed: number;
  assetsManifestPath: string;
  stylesheetMapPath: string;
}

function parseArgs(argv: string[]): CrawlOptions {
  const defaults: CrawlOptions = {
    startUrl: "https://azhman.company/",
    outputDir: "./output",
    maxPages: 200,
    concurrency: 4,
    delayMs: 250,
    timeoutMs: 20000,
    includeSubdomains: false,
    retryCount: 3,
    retryBackoffMs: 700,
    seedSitemap: true,
    downloadReferencedAssets: true,
    assetConcurrency: 8,
  };

  const values: Record<string, string> = {};
  for (const arg of argv) {
    if (!arg.startsWith("--")) {
      continue;
    }

    const [key, rawValue] = arg.slice(2).split("=");
    values[key] = rawValue ?? "true";
  }

  return {
    startUrl: values.startUrl ?? defaults.startUrl,
    outputDir: values.outputDir ?? defaults.outputDir,
    maxPages: Number(values.maxPages ?? defaults.maxPages),
    concurrency: Number(values.concurrency ?? defaults.concurrency),
    delayMs: Number(values.delayMs ?? defaults.delayMs),
    timeoutMs: Number(values.timeoutMs ?? defaults.timeoutMs),
    includeSubdomains: (values.includeSubdomains ?? String(defaults.includeSubdomains)) === "true",
    retryCount: Number(values.retryCount ?? defaults.retryCount),
    retryBackoffMs: Number(values.retryBackoffMs ?? defaults.retryBackoffMs),
    seedSitemap: (values.seedSitemap ?? String(defaults.seedSitemap)) === "true",
    downloadReferencedAssets: (values.downloadReferencedAssets ?? String(defaults.downloadReferencedAssets)) === "true",
    assetConcurrency: Number(values.assetConcurrency ?? defaults.assetConcurrency),
  };
}

function ensureHttpUrl(rawUrl: string): URL {
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported protocol: ${url.protocol}`);
  }
  return url;
}

function normalizePageUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  url.hash = "";
  if (!url.pathname) {
    url.pathname = "/";
  }

  const params = [...url.searchParams.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .filter(([key]) => !key.toLowerCase().startsWith("utm_"));
  url.search = "";
  for (const [key, value] of params) {
    url.searchParams.append(key, value);
  }

  if (url.pathname !== "/" && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.slice(0, -1);
  }

  return url.toString();
}

function normalizeAssetUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  url.hash = "";
  return url.toString();
}

function shouldVisit(target: URL, start: URL, includeSubdomains: boolean): boolean {
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return false;
  }

  if (target.hostname === start.hostname) {
    return true;
  }

  if (!includeSubdomains) {
    return false;
  }

  return target.hostname.endsWith(`.${start.hostname}`);
}

function slugFromUrl(url: string): string {
  const parsed = new URL(url);
  const pathname = parsed.pathname === "/" ? "home" : parsed.pathname.replace(/^\/+|\/+$/g, "").replace(/\//g, "__");
  const query = parsed.search ? `__${parsed.search.slice(1).replace(/[^a-zA-Z0-9]+/g, "_")}` : "";
  const base = `${pathname}${query}`.replace(/[^a-zA-Z0-9_\-]+/g, "_");
  const digest = createHash("sha256").update(url).digest("hex").slice(0, 8);
  return `${base || "page"}__${digest}`;
}

function toMarkdown(page: PageRecord): string {
  const lines: string[] = [];
  lines.push(`# ${page.title || "Untitled"}`);
  lines.push("");
  lines.push(`- URL: ${page.url}`);
  lines.push(`- Lang: ${page.lang || "unknown"}`);
  lines.push(`- Description: ${page.description || ""}`);
  lines.push("");

  if (page.h1.length > 0) {
    lines.push("## H1");
    for (const h1 of page.h1) {
      lines.push(`- ${h1}`);
    }
    lines.push("");
  }

  lines.push("## Extracted Text");
  lines.push("");
  lines.push(page.textContent || "(empty)");
  lines.push("");

  lines.push("## Internal and External Links");
  lines.push("");
  for (const link of page.links) {
    lines.push(`- [${link.text || link.url}](${link.url}) [${link.isInternal ? "internal" : "external"}]`);
  }

  return lines.join("\n");
}

function cleanText(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

function sanitizeSegment(segment: string): string {
  const cleaned = segment.replace(/[^a-zA-Z0-9._-]/g, "_");
  return cleaned.length > 0 ? cleaned : "x";
}

function skipResourceReference(rawRef: string): boolean {
  const ref = rawRef.trim().toLowerCase();
  if (!ref) {
    return true;
  }

  return (
    ref.startsWith("data:") ||
    ref.startsWith("blob:") ||
    ref.startsWith("javascript:") ||
    ref.startsWith("about:")
  );
}

function extensionFromContentType(contentType: string): string | undefined {
  const normalized = contentType.split(";")[0].trim().toLowerCase();
  const map: Record<string, string> = {
    "text/css": ".css",
    "text/plain": ".txt",
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/svg+xml": ".svg",
    "image/x-icon": ".ico",
    "font/woff": ".woff",
    "font/woff2": ".woff2",
    "font/ttf": ".ttf",
    "font/otf": ".otf",
    "application/font-woff": ".woff",
    "application/font-woff2": ".woff2",
    "application/octet-stream": "",
  };

  return map[normalized];
}

function looksLikeCssUrl(rawUrl: string): boolean {
  const pathname = new URL(rawUrl).pathname.toLowerCase();
  return pathname.endsWith(".css") || pathname.includes(".css?");
}

function mirroredRelativePathFromUrl(rawUrl: string, fallbackExtension?: string): string {
  const url = new URL(rawUrl);
  const host = sanitizeSegment(url.hostname);

  const segments = url.pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => sanitizeSegment(segment));

  let filePath = segments.length > 0 ? path.join(...segments) : "index";

  if (url.pathname.endsWith("/")) {
    filePath = path.join(filePath, "index");
  }

  if (!path.extname(filePath) && fallbackExtension) {
    filePath = `${filePath}${fallbackExtension}`;
  }

  if (url.search) {
    const queryHash = createHash("sha1").update(url.search).digest("hex").slice(0, 8);
    const ext = path.extname(filePath);
    const withoutExt = ext ? filePath.slice(0, -ext.length) : filePath;
    filePath = `${withoutExt}__q_${queryHash}${ext}`;
  }

  return path.join("assets-mirror", host, filePath);
}

function extractCssReferences(cssText: string): CssReference[] {
  const refs: CssReference[] = [];

  const importRegex = /@import\s+(?:url\()?\s*["']?([^"')\s]+)["']?\s*\)?/gi;
  let importMatch: RegExpExecArray | null = importRegex.exec(cssText);
  while (importMatch) {
    refs.push({ url: importMatch[1], kind: "import" });
    importMatch = importRegex.exec(cssText);
  }

  const urlRegex = /url\(\s*(["']?)([^"')]+)\1\s*\)/gi;
  let urlMatch: RegExpExecArray | null = urlRegex.exec(cssText);
  while (urlMatch) {
    refs.push({ url: urlMatch[2], kind: "asset" });
    urlMatch = urlRegex.exec(cssText);
  }

  return refs;
}

async function delay(ms: number): Promise<void> {
  if (ms <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function getTextWithRetry(
  url: string,
  options: CrawlOptions,
  acceptHeader = "text/html,application/xhtml+xml,application/xml,text/xml,text/css,*/*;q=0.1",
): Promise<{ status: number; headers: Record<string, unknown>; data: string }> {
  let lastError: unknown = null;
  const attempts = Math.max(1, options.retryCount + 1);

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await axios.get<string>(url, {
        timeout: options.timeoutMs,
        maxRedirects: 5,
        responseType: "text",
        validateStatus: () => true,
        headers: {
          "User-Agent": "AzhmanLocalizationCrawler/1.1 (+https://azhman.company)",
          Accept: acceptHeader,
        },
      });

      if (response.status >= 500 && attempt < attempts - 1) {
        throw new Error(`HTTP ${response.status}`);
      }

      return {
        status: response.status,
        headers: response.headers as Record<string, unknown>,
        data: response.data,
      };
    } catch (error) {
      lastError = error;
      if (attempt < attempts - 1) {
        const wait = options.retryBackoffMs * Math.pow(2, attempt);
        await delay(wait);
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Request failed");
}

async function getBinaryWithRetry(
  url: string,
  options: CrawlOptions,
): Promise<{ status: number; headers: Record<string, unknown>; data: Buffer }> {
  let lastError: unknown = null;
  const attempts = Math.max(1, options.retryCount + 1);

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await axios.get<ArrayBuffer>(url, {
        timeout: options.timeoutMs,
        maxRedirects: 5,
        responseType: "arraybuffer",
        validateStatus: () => true,
        headers: {
          "User-Agent": "AzhmanLocalizationCrawler/1.1 (+https://azhman.company)",
          Accept: "*/*",
        },
      });

      if (response.status >= 500 && attempt < attempts - 1) {
        throw new Error(`HTTP ${response.status}`);
      }

      return {
        status: response.status,
        headers: response.headers as Record<string, unknown>,
        data: Buffer.from(response.data),
      };
    } catch (error) {
      lastError = error;
      if (attempt < attempts - 1) {
        const wait = options.retryBackoffMs * Math.pow(2, attempt);
        await delay(wait);
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Request failed");
}

function extractSitemapUrls(xml: string): string[] {
  const $ = cheerio.load(xml, { xmlMode: true });
  const urls: string[] = [];
  $("urlset > url > loc, sitemapindex > sitemap > loc").each((_index, element) => {
    const loc = cleanText($(element).text());
    if (loc) {
      urls.push(loc);
    }
  });
  return urls;
}

async function fetchSitemapSeedUrls(start: URL, options: CrawlOptions): Promise<string[]> {
  const sitemapCandidates = [`${start.origin}/sitemap.xml`, `${start.origin}/sitemap_index.xml`];
  const found = new Set<string>();

  for (const sitemapUrl of sitemapCandidates) {
    try {
      const response = await getTextWithRetry(sitemapUrl, options, "application/xml,text/xml,*/*;q=0.1");
      if (response.status >= 400) {
        continue;
      }

      const urls = extractSitemapUrls(response.data);
      for (const candidate of urls) {
        try {
          const absolute = new URL(candidate, start);
          if (shouldVisit(absolute, start, options.includeSubdomains)) {
            found.add(normalizePageUrl(absolute.toString()));
          }
        } catch (_error) {
          // Ignore malformed sitemap entries.
        }
      }
    } catch (_error) {
      // Ignore sitemap errors and continue with normal crawling.
    }
  }

  return [...found];
}

async function ensureDirs(
  base: string,
): Promise<{ pagesDir: string; htmlDir: string; markdownDir: string; mirroredAssetsDir: string }> {
  const pagesDir = path.join(base, "pages");
  const htmlDir = path.join(pagesDir, "html");
  const markdownDir = path.join(pagesDir, "markdown");
  const mirroredAssetsDir = path.join(base, "assets-mirror");

  await fs.mkdir(htmlDir, { recursive: true });
  await fs.mkdir(markdownDir, { recursive: true });
  await fs.mkdir(mirroredAssetsDir, { recursive: true });

  return { pagesDir, htmlDir, markdownDir, mirroredAssetsDir };
}

function getAttrValues($: cheerio.CheerioAPI, selector: string, attribute: string): string[] {
  const values = new Set<string>();
  $(selector).each((_index, element) => {
    const value = $(element).attr(attribute);
    if (value) {
      values.add(value.trim());
    }
  });
  return [...values];
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function extractMainText($: cheerio.CheerioAPI): string {
  $("script, style, noscript, svg, canvas").remove();

  const candidates = ["main", "article", "[role='main']", "body"];
  for (const selector of candidates) {
    const node = $(selector).first();
    if (node.length === 0) {
      continue;
    }

    const text = cleanText(node.text());
    if (text.length > 0) {
      return text;
    }
  }

  return "";
}

function resolveResourceUrl(rawUrl: string, baseUrl: string): string | null {
  if (skipResourceReference(rawUrl)) {
    return null;
  }

  try {
    const absolute = new URL(rawUrl, baseUrl);
    if (absolute.protocol !== "http:" && absolute.protocol !== "https:") {
      return null;
    }
    return normalizeAssetUrl(absolute.toString());
  } catch (_error) {
    return null;
  }
}

async function saveMirroredTextAsset(url: string, text: string, outputDir: string): Promise<string> {
  const relativePath = mirroredRelativePathFromUrl(url, ".css");
  const absolutePath = path.join(outputDir, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, text, "utf8");
  return relativePath;
}

async function saveMirroredBinaryAsset(
  url: string,
  buffer: Buffer,
  contentType: string,
  outputDir: string,
): Promise<string> {
  const extension = extensionFromContentType(contentType);
  const relativePath = mirroredRelativePathFromUrl(url, extension);
  const absolutePath = path.join(outputDir, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, buffer);
  return relativePath;
}

async function downloadReferencedAssets(
  pages: PageRecord[],
  options: CrawlOptions,
): Promise<AssetDownloadSummary> {
  const cssQueue: string[] = [];
  const cssSeen = new Set<string>();
  const discoveredCss = new Set<string>();
  const discoveredAssets = new Set<string>();
  const records: DownloadedAssetRecord[] = [];
  const stylesheetMap = new Map<string, string>();

  for (const page of pages) {
    for (const stylesheetHref of page.assets.stylesheets) {
      const absolute = resolveResourceUrl(stylesheetHref, page.url);
      if (!absolute) {
        continue;
      }

      if (!discoveredCss.has(absolute)) {
        discoveredCss.add(absolute);
        cssQueue.push(absolute);
      }
    }
  }

  while (cssQueue.length > 0) {
    const cssUrl = cssQueue.shift();
    if (!cssUrl || cssSeen.has(cssUrl)) {
      continue;
    }

    cssSeen.add(cssUrl);

    try {
      const response = await getTextWithRetry(cssUrl, options, "text/css,*/*;q=0.1");
      const contentType = String(response.headers["content-type"] ?? "");

      if (response.status >= 400) {
        records.push({
          url: cssUrl,
          localPath: "",
          kind: "css",
          status: "failed",
          contentType,
          reason: `HTTP ${response.status}`,
        });
        continue;
      }

      const localPath = await saveMirroredTextAsset(cssUrl, response.data, options.outputDir);
      stylesheetMap.set(cssUrl, localPath);
      records.push({
        url: cssUrl,
        localPath,
        kind: "css",
        status: "downloaded",
        contentType,
      });

      const references = extractCssReferences(response.data);
      for (const ref of references) {
        const absolute = resolveResourceUrl(ref.url, cssUrl);
        if (!absolute) {
          continue;
        }

        if (ref.kind === "import" || looksLikeCssUrl(absolute)) {
          if (!discoveredCss.has(absolute)) {
            discoveredCss.add(absolute);
            cssQueue.push(absolute);
          }
          continue;
        }

        discoveredAssets.add(absolute);
      }
    } catch (error) {
      records.push({
        url: cssUrl,
        localPath: "",
        kind: "css",
        status: "failed",
        contentType: "",
        reason: error instanceof Error ? error.message : "unknown error",
      });
    }
  }

  const assetLimiter = pLimit(Math.max(1, options.assetConcurrency));
  await Promise.all(
    [...discoveredAssets].map((assetUrl) =>
      assetLimiter(async () => {
        try {
          const response = await getBinaryWithRetry(assetUrl, options);
          const contentType = String(response.headers["content-type"] ?? "");

          if (response.status >= 400) {
            records.push({
              url: assetUrl,
              localPath: "",
              kind: "asset",
              status: "failed",
              contentType,
              reason: `HTTP ${response.status}`,
            });
            return;
          }

          const localPath = await saveMirroredBinaryAsset(assetUrl, response.data, contentType, options.outputDir);
          records.push({
            url: assetUrl,
            localPath,
            kind: "asset",
            status: "downloaded",
            contentType,
          });
        } catch (error) {
          records.push({
            url: assetUrl,
            localPath: "",
            kind: "asset",
            status: "failed",
            contentType: "",
            reason: error instanceof Error ? error.message : "unknown error",
          });
        }
      }),
    ),
  );

  const assetsManifestPath = "assets-manifest.json";
  const stylesheetMapPath = "stylesheet-map.json";

  await writeJson(path.join(options.outputDir, assetsManifestPath), {
    generatedAt: new Date().toISOString(),
    total: records.length,
    items: records,
  });

  await writeJson(
    path.join(options.outputDir, stylesheetMapPath),
    Object.fromEntries([...stylesheetMap.entries()].sort(([a], [b]) => a.localeCompare(b))),
  );

  const cssDownloaded = records.filter((item) => item.kind === "css" && item.status === "downloaded").length;
  const assetDownloaded = records.filter((item) => item.kind === "asset" && item.status === "downloaded").length;
  const failed = records.filter((item) => item.status === "failed").length;

  return {
    enabled: true,
    cssDiscovered: discoveredCss.size,
    cssDownloaded,
    assetDiscovered: discoveredAssets.size,
    assetDownloaded,
    failed,
    assetsManifestPath,
    stylesheetMapPath,
  };
}

async function crawl(options: CrawlOptions): Promise<void> {
  const start = ensureHttpUrl(options.startUrl);
  const normalizedStart = normalizePageUrl(start.toString());
  const { htmlDir, markdownDir } = await ensureDirs(options.outputDir);

  const visited = new Set<string>();
  const discovered = new Set<string>([normalizedStart]);
  const queue: string[] = [normalizedStart];
  const pageRecords: PageRecord[] = [];
  const brokenLinks: Array<{ from: string; to: string; reason: string }> = [];

  const limiter = pLimit(options.concurrency);

  if (options.seedSitemap) {
    const sitemapUrls = await fetchSitemapSeedUrls(start, options);
    for (const sitemapUrl of sitemapUrls) {
      if (!discovered.has(sitemapUrl) && discovered.size < options.maxPages * 4) {
        discovered.add(sitemapUrl);
        queue.push(sitemapUrl);
      }
    }
  }

  async function processPage(url: string): Promise<void> {
    if (visited.has(url) || pageRecords.length >= options.maxPages) {
      return;
    }

    visited.add(url);
    await delay(options.delayMs);

    try {
      const response = await getTextWithRetry(url, options);

      const status = response.status;
      const contentType = String(response.headers["content-type"] ?? "");
      if (status >= 400) {
        brokenLinks.push({ from: url, to: url, reason: `HTTP ${status}` });
        return;
      }

      if (!contentType.includes("text/html")) {
        return;
      }

      const html = response.data;
      const $ = cheerio.load(html);

      const links: LinkInfo[] = [];
      $("a[href]").each((_index, element) => {
        const href = $(element).attr("href")?.trim();
        if (!href) {
          return;
        }

        try {
          const absolute = new URL(href, url);
          const normalized = normalizePageUrl(absolute.toString());
          const isInternal = shouldVisit(absolute, start, options.includeSubdomains);
          const link: LinkInfo = {
            url: normalized,
            text: cleanText($(element).text()),
            rel: cleanText($(element).attr("rel") ?? ""),
            isInternal,
          };
          links.push(link);

          if (
            isInternal &&
            !visited.has(normalized) &&
            !discovered.has(normalized) &&
            discovered.size < options.maxPages * 4
          ) {
            discovered.add(normalized);
            queue.push(normalized);
          }
        } catch (_error) {
          // Ignore invalid URLs.
        }
      });

      const slug = slugFromUrl(url);
      const htmlFile = path.join(htmlDir, `${slug}.html`);
      const markdownFile = path.join(markdownDir, `${slug}.md`);

      const title = cleanText($("title").first().text());
      const description = cleanText($("meta[name='description']").attr("content") ?? "");
      const lang = cleanText($("html").attr("lang") ?? "");
      const h1 = $("h1")
        .map((_index, element) => cleanText($(element).text()))
        .get()
        .filter(Boolean);

      const page: PageRecord = {
        id: slug,
        url,
        path: new URL(url).pathname,
        status,
        contentType,
        lang,
        title,
        description,
        h1,
        textContent: extractMainText($),
        links,
        assets: {
          images: getAttrValues($, "img[src]", "src"),
          scripts: getAttrValues($, "script[src]", "src"),
          stylesheets: getAttrValues($, "link[rel='stylesheet'][href]", "href"),
        },
        fetchedAt: new Date().toISOString(),
        savedHtmlPath: path.relative(options.outputDir, htmlFile),
        savedMarkdownPath: path.relative(options.outputDir, markdownFile),
      };

      pageRecords.push(page);
      await fs.writeFile(htmlFile, html, "utf8");
      await fs.writeFile(markdownFile, toMarkdown(page), "utf8");

      console.log(`[crawled ${pageRecords.length}/${options.maxPages}] ${url}`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown error";
      brokenLinks.push({ from: url, to: url, reason });
      console.warn(`[failed] ${url} :: ${reason}`);
    }
  }

  while (queue.length > 0 && pageRecords.length < options.maxPages) {
    const batch: string[] = [];
    while (
      queue.length > 0 &&
      batch.length < options.concurrency &&
      pageRecords.length + batch.length < options.maxPages
    ) {
      const next = queue.shift();
      if (!next || visited.has(next)) {
        continue;
      }
      batch.push(next);
    }

    if (batch.length === 0) {
      continue;
    }

    await Promise.all(batch.map((url) => limiter(() => processPage(url))));
  }

  pageRecords.sort((a, b) => a.url.localeCompare(b.url));

  let assetDownloadSummary: AssetDownloadSummary | undefined;
  if (options.downloadReferencedAssets) {
    assetDownloadSummary = await downloadReferencedAssets(pageRecords, options);
  }

  const manifest: CrawlManifest = {
    startUrl: normalizedStart,
    crawledAt: new Date().toISOString(),
    totalPages: pageRecords.length,
    options,
    pages: pageRecords.map((page) => ({
      id: page.id,
      url: page.url,
      path: page.path,
      title: page.title,
      lang: page.lang,
      savedHtmlPath: page.savedHtmlPath,
      savedMarkdownPath: page.savedMarkdownPath,
    })),
    brokenLinks,
    assetDownload: assetDownloadSummary,
  };

  const linksGraph = pageRecords.map((page) => ({
    source: page.url,
    internalLinks: page.links.filter((link) => link.isInternal).map((link) => link.url),
    externalLinks: page.links.filter((link) => !link.isInternal).map((link) => link.url),
  }));

  await writeJson(path.join(options.outputDir, "manifest.json"), manifest);
  await writeJson(path.join(options.outputDir, "pages.json"), pageRecords);
  await writeJson(path.join(options.outputDir, "links-graph.json"), linksGraph);

  const translationSeed = pageRecords.map((page) => ({
    url: page.url,
    title: page.title,
    description: page.description,
    headings: page.h1,
    textContent: page.textContent,
  }));
  await writeJson(path.join(options.outputDir, "translation-seed.json"), translationSeed);

  console.log(`Crawl complete. Pages: ${pageRecords.length}. Output directory: ${path.resolve(options.outputDir)}`);
  if (assetDownloadSummary) {
    console.log(
      `Downloaded CSS/assets: ${assetDownloadSummary.cssDownloaded}/${assetDownloadSummary.cssDiscovered} CSS, ` +
        `${assetDownloadSummary.assetDownloaded}/${assetDownloadSummary.assetDiscovered} other assets, ` +
        `${assetDownloadSummary.failed} failed.`,
    );
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  await fs.mkdir(options.outputDir, { recursive: true });
  await crawl(options);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
