require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { createObjectCsvWriter } = require("csv-writer");

const BASE_URL = process.env.BASE_URL || "https://excelcommunityliving.website";
const COURSES_URL = `${BASE_URL.replace(/\/$/, "")}/courses/`;

/** First URL for the course archive (Tutor LMS filter + pagination). Override with COURSES_LIST_URL in .env */
function getCourseListStartUrl() {
  const raw = (process.env.COURSES_LIST_URL || "").trim();
  if (raw) return raw;
  return `${BASE_URL.replace(/\/$/, "")}/courses/?course_per_page=12&show_pagination=1&current_page=1`;
}

/** Set current_page on the listing URL (Tutor AJAX / some themes). */
function mergeCurrentPageInCoursesUrl(listUrl, pageNum) {
  try {
    const u = new URL(listUrl);
    u.searchParams.set("current_page", String(pageNum));
    return u.toString();
  } catch {
    const sep = listUrl.includes("?") ? "&" : "?";
    return `${listUrl}${sep}current_page=${pageNum}`;
  }
}

/**
 * WordPress course archives usually paginate as /courses/page/N/ (path), not ?current_page=N.
 * Tutor still accepts filter query params on those URLs. Falls back to query-only merge for non-/courses paths.
 */
function mergeCourseListingPageUrl(listUrl, pageNum) {
  let u;
  try {
    u = new URL(listUrl);
  } catch {
    return mergeCurrentPageInCoursesUrl(listUrl, pageNum);
  }

  let pathname = u.pathname.replace(/\/+$/, "");
  pathname = pathname.replace(/\/page\/\d+$/i, "");
  const isCoursesArchive = /\/courses$/i.test(pathname);

  if (!isCoursesArchive) {
    return mergeCurrentPageInCoursesUrl(listUrl, pageNum);
  }

  const params = u.searchParams;
  if (pageNum <= 1) {
    u.pathname = `${pathname}/`;
    params.set("current_page", "1");
    u.search = params.toString();
    return u.toString();
  }

  u.pathname = `${pathname}/page/${pageNum}/`;
  params.delete("current_page");
  u.search = params.toString();
  return u.toString();
}
const OUTPUT_DIR = path.join(__dirname, "output");
const TXT_OUTPUT = path.join(OUTPUT_DIR, "video-links.txt");
const JSON_OUTPUT = path.join(OUTPUT_DIR, "video-links.json");
const CSV_OUTPUT = path.join(OUTPUT_DIR, "video-links.csv");

const DIRECT_MEDIA_PATTERNS = [/\.(mp4|m3u8|webm|mov|m4v)(\?|$)/i];
const YOUTUBE_PATTERNS = [
  /^https?:\/\/(www\.)?youtube\.com\/watch\?v=[^&\s]+/i,
  /^https?:\/\/(www\.)?youtube\.com\/embed\/[A-Za-z0-9_-]{6,}/i,
  /^https?:\/\/youtu\.be\/[A-Za-z0-9_-]{6,}/i
];
const VIMEO_PATTERNS = [
  /^https?:\/\/(www\.)?vimeo\.com\/\d+/i,
  /^https?:\/\/player\.vimeo\.com\/video\/\d+/i
];
const OTHER_PLATFORM_PATTERNS = [
  /^https?:\/\/[^/]*wistia[^/]*\/.+/i,
  /^https?:\/\/[^/]*bunnycdn[^/]*\/.+/i,
  /^https?:\/\/[^/]*cloudfront\.net\/.+/i,
  /^https?:\/\/[^/]*jwplayer[^/]*\/.+/i
];

const PROGRESS_BUTTONS = [
  "Next",
  "Continue",
  "Complete Lesson",
  "Mark Complete",
  "Finish",
  "Proceed",
  "Start Learning",
  "Resume",
  "Start"
];

const ENROLL_BUTTONS = [
  "Enroll Course",
  "Enroll",
  "Enroll Now",
  "Take This Course",
  "Take this course",
  "Get Enrolled",
  "Join now",
  "Join Now",
  "Join the course",
  "Subscribe",
  "Free enroll",
  "Free Enroll",
  "Register",
  "Try for Free",
  "Try for free",
  "Get Started",
  "Buy Now",
  "Add to cart",
  "Add To Cart"
];

/** Where Tutor shows enroll / curriculum CTAs (avoid header/footer false positives). */
const TUTOR_COURSE_CHROME =
  ".tutor-course-single-sidebar, .tutor-course-details-page, .tutor-course-entry-box, .tutor-course-details-header, main";
const MAX_COURSE_STEPS = 160;
const DEFAULT_TIMEOUT = 25000;
const CLICK_RETRY = 4;

const allPairs = [];
const allUniqueUrls = new Set();

function isPotentialMediaUrl(url) {
  if (!url || typeof url !== "string") return false;
  const clean = url.trim();
  if (!/^https?:\/\//i.test(clean)) return false;
  if (/blank\.mp4(\?|$)/i.test(clean)) return false;
  if (/\.(css|js|json|svg|png|jpg|jpeg|gif|webp|ico)(\?|$)/i.test(clean)) return false;
  if (/\/api\/|youtubei\/v1|widgetapi|www-player\.css|doubleclick|gstatic/i.test(clean)) return false;
  return (
    DIRECT_MEDIA_PATTERNS.some((pattern) => pattern.test(clean)) ||
    YOUTUBE_PATTERNS.some((pattern) => pattern.test(clean)) ||
    VIMEO_PATTERNS.some((pattern) => pattern.test(clean)) ||
    OTHER_PLATFORM_PATTERNS.some((pattern) => pattern.test(clean))
  );
}

function normalizeMediaUrl(url) {
  if (!url) return "";
  return url
    .replace(/&amp;/g, "&")
    .replace(/\\u0026/g, "&")
    .replace(/\\\//g, "/")
    .replace(/\\u003d/g, "=")
    .replace(/\\$/, "")
    .trim();
}

function canonicalizeMediaUrl(url) {
  const cleaned = normalizeMediaUrl(url);
  if (!cleaned) return "";

  try {
    const parsed = new URL(cleaned);
    const host = parsed.hostname.toLowerCase();

    // YouTube: embed/short URLs -> standard watch URL.
    if (host.includes("youtube.com") || host === "youtu.be") {
      let videoId = "";

      if (host === "youtu.be") {
        videoId = parsed.pathname.replace(/^\/+/, "").split("/")[0] || "";
      } else if (parsed.pathname.startsWith("/embed/")) {
        videoId = parsed.pathname.split("/embed/")[1]?.split("/")[0] || "";
      } else if (parsed.pathname === "/watch") {
        videoId = parsed.searchParams.get("v") || "";
      }

      if (videoId) {
        return `https://www.youtube.com/watch?v=${videoId}`;
      }
    }

    // Vimeo: player URL -> standard vimeo URL.
    if (host.includes("vimeo.com")) {
      const playerMatch = parsed.pathname.match(/\/video\/(\d+)/i);
      if (playerMatch?.[1]) {
        return `https://vimeo.com/${playerMatch[1]}`;
      }
      const directMatch = parsed.pathname.match(/^\/(\d+)/);
      if (directMatch?.[1]) {
        return `https://vimeo.com/${directMatch[1]}`;
      }
    }
  } catch {
    // Keep original cleaned URL if parsing fails.
  }

  return cleaned;
}

function ensureOutputFiles() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  if (!fs.existsSync(TXT_OUTPUT)) {
    fs.writeFileSync(TXT_OUTPUT, "", "utf8");
  }
  if (!fs.existsSync(JSON_OUTPUT)) {
    fs.writeFileSync(JSON_OUTPUT, "[]", "utf8");
  }
}

/** Full wipe of output/ and in-memory aggregates so each run starts clean. */
function resetOutputDirectory() {
  if (process.env.SKIP_OUTPUT_RESET === "1") {
    console.log("SKIP_OUTPUT_RESET=1: leaving output/ as-is.");
    return;
  }
  if (fs.existsSync(OUTPUT_DIR)) {
    fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  allPairs.length = 0;
  allUniqueUrls.clear();
  console.log("Reset output/ for a fresh run.");
}

function sanitizeCourseName(name) {
  if (!name) return "Untitled Course";
  return name.replace(/\s+/g, " ").trim();
}

/** Safe folder name under output/ (Windows-friendly). */
function sanitizeFolderName(name) {
  const base = sanitizeCourseName(name);
  return (
    base
      .replace(/[<>:"/\\|?*]/g, "_")
      .replace(/\s+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^\.+/, "")
      .slice(0, 120) || "Untitled_Course"
  );
}

/** Safe base name for a lesson .txt file. */
function sanitizeFileBase(title) {
  const base = sanitizeCourseName(title || "lesson");
  return (
    base
      .replace(/[<>:"/\\|?*]/g, "_")
      .replace(/\s+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^\.+/, "")
      .slice(0, 100) || "lesson"
  );
}

function lessonSlugFromUrl(lessonPageUrl) {
  try {
    const parts = new URL(lessonPageUrl).pathname.split("/").filter(Boolean);
    return parts[parts.length - 1] || "lesson";
  } catch {
    return "lesson";
  }
}

async function safeGoto(page, url, label = "page", retries = 3) {
  let lastError;
  for (let i = 1; i <= retries; i += 1) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT });
      await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
      return;
    } catch (error) {
      lastError = error;
      console.log(`Navigation retry ${i}/${retries} failed for ${label}: ${error.message}`);
      await page.waitForTimeout(1200 * i);
    }
  }
  throw new Error(`Failed to navigate to ${label}: ${lastError ? lastError.message : "unknown"}`);
}

async function autoScroll(page, rounds = 7) {
  for (let i = 0; i < rounds; i += 1) {
    await page.evaluate(() => {
      window.scrollBy(0, Math.max(500, window.innerHeight * 0.9));
    });
    await page.waitForTimeout(400);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
}

async function clickVisibleLocator(locator, actionName) {
  const count = await locator.count();
  for (let i = 0; i < count; i += 1) {
    const item = locator.nth(i);
    if (await item.isVisible().catch(() => false)) {
      console.log(`Clicking ${actionName}...`);
      await item.scrollIntoViewIfNeeded().catch(() => {});
      await item.click({ timeout: 5000 });
      return true;
    }
  }
  return false;
}

async function tryClickByText(page, labels, purpose, retries = CLICK_RETRY) {
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    for (const label of labels) {
      const roleLocator = page.getByRole("button", { name: new RegExp(`^\\s*${escapeRegex(label)}\\s*$`, "i") });
      if (await clickVisibleLocator(roleLocator, label).catch(() => false)) return true;

      const looseRole = page.getByRole("button", { name: new RegExp(escapeRegex(label), "i") });
      if (await clickVisibleLocator(looseRole, label).catch(() => false)) return true;

      const links = page.getByRole("link", { name: new RegExp(escapeRegex(label), "i") });
      if (await clickVisibleLocator(links, label).catch(() => false)) return true;

      const genericLocator = page.locator(
        `button:has-text("${label}"), a:has-text("${label}"), [role="button"]:has-text("${label}"), input[type="submit"][value*="${label}"]`
      );
      if (await clickVisibleLocator(genericLocator, label).catch(() => false)) return true;
    }
    await page.waitForTimeout(700 * attempt);
  }
  console.log(`No clickable target found for ${purpose}`);
  return false;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function extractUrlsFromFrame(frame) {
  return frame
    .evaluate(() => {
      const urls = new Set();

      const toAbsolute = (value) => {
        try {
          return new URL(value, window.location.href).href;
        } catch {
          return value;
        }
      };

      const add = (value) => {
        if (!value || typeof value !== "string") return;
        const trimmed = value.trim();
        if (!trimmed) return;
        urls.add(toAbsolute(trimmed));
      };

      document.querySelectorAll("video").forEach((video) => add(video.getAttribute("src")));
      document.querySelectorAll("video source").forEach((source) => add(source.getAttribute("src")));
      document.querySelectorAll("iframe").forEach((iframe) => add(iframe.getAttribute("src")));
      document.querySelectorAll("a").forEach((anchor) => add(anchor.getAttribute("href")));
      document.querySelectorAll("script[src]").forEach((script) => add(script.getAttribute("src")));

      const walker = document.createTreeWalker(document.documentElement || document.body, NodeFilter.SHOW_TEXT);
      const regex = /(https?:\/\/[^\s"'<>]+)/gi;
      while (walker.nextNode()) {
        const text = walker.currentNode.nodeValue || "";
        const matches = text.match(regex);
        if (matches) {
          matches.forEach((url) => add(url));
        }
      }

      return Array.from(urls);
    })
    .catch(() => []);
}

async function extractUrlsFromPageAndFrames(page) {
  const frameUrls = [];
  const frames = page.frames();
  for (const frame of frames) {
    const urls = await extractUrlsFromFrame(frame);
    frameUrls.push(...urls);
  }
  return frameUrls;
}

async function pickVisibleInput(page, selectors) {
  for (const selector of selectors) {
    const loc = page.locator(selector);
    const count = await loc.count();
    for (let i = 0; i < count; i += 1) {
      const candidate = loc.nth(i);
      const visible = await candidate.isVisible().catch(() => false);
      if (!visible) continue;
      const editable = await candidate.isEditable().catch(() => false);
      if (editable) return candidate;
    }
  }
  return null;
}

function persistOutputs() {
  const jsonData = JSON.stringify(allPairs, null, 2);
  fs.writeFileSync(JSON_OUTPUT, jsonData, "utf8");
}

async function persistCsv() {
  const csvWriter = createObjectCsvWriter({
    path: CSV_OUTPUT,
    header: [
      { id: "course", title: "course" },
      { id: "url", title: "url" }
    ]
  });
  await csvWriter.writeRecords(allPairs);
}

function appendTxtByCourse(courseName, urls) {
  if (!urls.length) return;
  const lines = [`${courseName}:`, ...urls, ""];
  fs.appendFileSync(TXT_OUTPUT, `${lines.join("\n")}\n`, "utf8");
}

async function isWorkingMediaUrl(url) {
  try {
    if (/blank\.mp4(\?|$)/i.test(url)) return false;
    const response = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) return false;

    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    if (contentType.includes("video") || contentType.includes("mpegurl") || contentType.includes("octet-stream")) {
      return true;
    }
    if (/youtube|vimeo|wistia|bunnycdn|cloudfront|jwplayer/i.test(url)) {
      return true;
    }
    if (DIRECT_MEDIA_PATTERNS.some((p) => p.test(url))) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

async function filterWorkingMediaUrls(urls) {
  const valid = [];
  for (const raw of urls) {
    const canonical = canonicalizeMediaUrl(raw);
    if (!isPotentialMediaUrl(canonical)) continue;
    if (/blank\.mp4(\?|$)/i.test(canonical)) continue;
    if (await isWorkingMediaUrl(canonical)) {
      valid.push(canonical);
    }
  }
  return Array.from(new Set(valid));
}

function setupNetworkCapture(page, addCourseUrl) {
  page.on("request", (request) => {
    const url = request.url();
    if (isPotentialMediaUrl(url)) {
      addCourseUrl(url);
    }
  });

  page.on("response", async (response) => {
    const url = response.url();
    if (isPotentialMediaUrl(url)) {
      addCourseUrl(url);
    }

    try {
      const headers = response.headers();
      const contentType = headers["content-type"] || "";
      if (!/json|javascript|text|mpegurl/i.test(contentType)) return;

      const body = await response.text();
      if (!body || body.length > 600000) return;

      const matches = body.match(/https?:\/\/[^\s"'<>\\]+/g) || [];
      for (const candidate of matches) {
        if (isPotentialMediaUrl(candidate)) {
          addCourseUrl(candidate);
        }
      }
    } catch {
      // Ignore response parsing failures.
    }
  });
}

async function login(page) {
  const email = process.env.EMAIL;
  const password = process.env.PASSWORD;
  if (!email || !password) {
    throw new Error("Missing EMAIL or PASSWORD in environment variables.");
  }

  await safeGoto(page, COURSES_URL, "courses listing");

  // Force login form visibility by opening a concrete course detail page.
  let candidateCourseUrl = null;
  try {
    candidateCourseUrl = await page.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll('a[href*="/courses/"]'));
      const picked = anchors
        .map((a) => a.href)
        .find((href) => href && /\/courses\/[^/?#]+\/?$/.test(href));
      return picked || null;
    });
  } catch {
    candidateCourseUrl = null;
  }

  if (!candidateCourseUrl) {
    candidateCourseUrl = `${BASE_URL.replace(/\/$/, "")}/courses/monitoring-the-future-study-drug-use1975-2024/`;
  }
  await safeGoto(page, candidateCourseUrl, "course login page");

  const emailSelectors = [
    'input[type="email"]',
    'input[name="email"]',
    'input[name="username"]',
    'input[placeholder*="Email" i]',
    'input[placeholder*="Username" i]'
  ];
  const passSelectors = ['input[type="password"]', 'input[name="password"]', 'input[placeholder*="Password" i]'];

  const emailField = await pickVisibleInput(page, emailSelectors);
  const passField = await pickVisibleInput(page, passSelectors);

  if (!emailField || !passField) {
    throw new Error("Login fields not found.");
  }

  await emailField.fill(email);
  await passField.fill(password);

  // Keep me signed in if checkbox exists.
  const remember = page.locator('input[type="checkbox"], input[name*="remember" i]').first();
  if (await remember.count()) {
    const isChecked = await remember.isChecked().catch(() => false);
    if (!isChecked) await remember.check().catch(() => {});
  }

  const submitTargets = [
    page.getByRole("button", { name: /sign in|log in|login/i }),
    page.getByRole("link", { name: /sign in|log in|login/i }),
    page.locator('button[type="submit"], input[type="submit"]')
  ];

  let submitted = false;
  for (const target of submitTargets) {
    if (await clickVisibleLocator(target, "Sign In").catch(() => false)) {
      submitted = true;
      break;
    }
  }
  if (!submitted) {
    await passField.press("Enter");
  }

  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(2000);
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});

  const stillSignIn = await page.locator('text=/Sign In/i').count();
  if (stillSignIn > 0) {
    // One more attempt by going dashboard.
    await safeGoto(page, `${BASE_URL.replace(/\/$/, "")}/dashboard/`, "dashboard");
  }
  console.log("Logged in successfully");
}

async function detectCourseListingTotalPages(page) {
  return page
    .evaluate(() => {
      const text = document.body?.innerText || "";
      const m = text.match(/Page\s+\d+\s+of\s+(\d+)/i);
      if (m) return Math.min(50, parseInt(m[1], 10));

      let max = 1;
      document
        .querySelectorAll(
          ".tutor-pagination a, .tutor-pagination button, .tutor-unstyled-pagination a, .tutor-unstyled-pagination button, .tutor-pagination-hierarchical a, .tutor-pagination-hierarchical button"
        )
        .forEach((el) => {
          const n = parseInt((el.textContent || "").trim(), 10);
          if (Number.isFinite(n) && n >= 1 && n <= 50 && n > max) max = n;
        });
      return max;
    })
    .catch(() => 1);
}

async function collectCourseLinksFromDom(page) {
  return page.evaluate(() => {
    const root = document.querySelector(".tutor-course-filter-loop-container") || document.body;
    const candidates = new Set();
    root.querySelectorAll('a[href*="/courses/"]').forEach((a) => {
      const href = a.href || "";
      if (!href) return;
      if (!/\/courses\/[^/?#]+\/?$/.test(href)) return;
      if (href.includes("/lessons/")) return;
      if (href.includes("/course-category/")) return;
      candidates.add(href);
    });
    return Array.from(candidates);
  });
}

/**
 * Discovers all course detail URLs. Uses explicit `current_page` navigation (1..N) so we do not
 * depend on the AJAX "Next" chevron alone (which often stopped after one page and led to ~10 courses).
 */
async function collectCourseLinks(page) {
  const allCourseLinks = new Set();
  const startUrl = getCourseListStartUrl();
  await safeGoto(page, startUrl, "courses listing (start URL)");
  await page.locator(".tutor-course-filter-loop-container").waitFor({ state: "attached", timeout: 25000 }).catch(() => {});

  const totalPages = Math.max(1, await detectCourseListingTotalPages(page));
  console.log(`Course listing: ${totalPages} page(s) to scan`);

  for (let p = 1; p <= totalPages; p += 1) {
    if (p > 1) {
      console.log(`Waiting a few seconds before loading page ${p}...`);
      await page.waitForTimeout(3000 + Math.random() * 2000); // 3-5 second delay
    }
    const pageUrl = mergeCourseListingPageUrl(startUrl, p);
    await safeGoto(page, pageUrl, `courses listing page ${p}/${totalPages}`);
    await page.locator(".tutor-course-filter-loop-container").waitFor({ state: "attached", timeout: 25000 }).catch(() => {});
    await autoScroll(page, 8);
    const links = await collectCourseLinksFromDom(page);
    links.forEach((link) => allCourseLinks.add(link));
    console.log(`Collected ${links.length} course links on listing page ${p}/${totalPages} (total unique: ${allCourseLinks.size})`);
  }

  return Array.from(allCourseLinks);
}

async function extractCourseName(page, fallbackUrl) {
  const titleLocators = [
    page.locator("h1").first(),
    page.locator(".tutor-course-details-title").first(),
    page.locator(".entry-title").first()
  ];
  for (const loc of titleLocators) {
    if (await loc.count()) {
      const text = (await loc.textContent()) || "";
      if (text.trim()) return sanitizeCourseName(text);
    }
  }
  try {
    const pathname = new URL(fallbackUrl).pathname.split("/").filter(Boolean).pop();
    return sanitizeCourseName((pathname || "Untitled Course").replace(/-/g, " "));
  } catch {
    return "Untitled Course";
  }
}

async function hasVisibleTutorEnrollCta(page) {
  const scoped = page.locator(TUTOR_COURSE_CHROME);
  const tutorEnroll = scoped.locator(
    "a.tutor-btn-enroll, .tutor-course-sidebar-card a.tutor-btn-enroll, .tutor-course-entry-box a.tutor-btn-enroll, form.tutor-enroll-form button[type='submit'], form.tutor-enroll-form input[type='submit'], a[href*='add-to-cart'], button[name='add-to-cart']"
  );
  const count = await tutorEnroll.count();
  for (let i = 0; i < count; i += 1) {
    if (await tutorEnroll.nth(i).isVisible().catch(() => false)) return true;
  }
  return false;
}

/** Tutor / Woo enroll controls before generic label matching. Returns true if a click was performed. */
async function clickTutorEnrollCta(page) {
  const scoped = page.locator(TUTOR_COURSE_CHROME);
  const chains = [
    scoped.locator("a.tutor-btn-enroll"),
    scoped.locator("form.tutor-enroll-form button[type='submit']"),
    scoped.locator("form.tutor-enroll-form input[type='submit']"),
    scoped.locator("a[href*='add-to-cart']"),
    scoped.locator("button[name='add-to-cart']"),
    scoped.getByRole("link", { name: /enroll|join|subscribe|get started|try for free|add to cart|buy now/i })
  ];
  for (const loc of chains) {
    if (await clickVisibleLocator(loc, "Tutor/Woo enroll").catch(() => false)) {
      console.log("Enrollment: clicked Tutor/Woo enroll control.");
      return true;
    }
  }
  return false;
}

async function isAlreadyEnrolledOrAccessible(page) {
  const scoped = page.locator(TUTOR_COURSE_CHROME);
  const enrollStill = await scoped
    .locator("a.tutor-btn-enroll, form.tutor-enroll-form button[type='submit']")
    .first()
    .isVisible()
    .catch(() => false);
  if (enrollStill) return false;

  const indicators = [
    scoped.getByText(/already enrolled/i),
    scoped.getByRole("button", { name: /start learning|continue|resume|go to course/i }),
    scoped.getByRole("link", { name: /start learning|continue|resume|go to course/i })
  ];
  for (const ind of indicators) {
    if (await ind.first().isVisible().catch(() => false)) return true;
  }
  return false;
}

async function hasVisibleEnrollCta(page) {
  if (await hasVisibleTutorEnrollCta(page)) return true;

  const scoped = page.locator(TUTOR_COURSE_CHROME);
  for (const label of ENROLL_BUTTONS) {
    const pattern = new RegExp(escapeRegex(label), "i");
    const btn = scoped.getByRole("button", { name: pattern });
    if (await btn.first().isVisible().catch(() => false)) return true;
    const link = scoped.getByRole("link", { name: pattern });
    if (await link.first().isVisible().catch(() => false)) return true;
    const generic = scoped.locator(`button:has-text("${label}"), a:has-text("${label}")`);
    if (await generic.first().isVisible().catch(() => false)) return true;
  }
  return false;
}

async function waitForCourseAccessOrNoEnrollCta(page) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (await isAlreadyEnrolledOrAccessible(page)) return;
    if (!(await hasVisibleEnrollCta(page))) return;
    await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(450);
  }
}

async function maybeEnroll(page) {
  if (await isAlreadyEnrolledOrAccessible(page)) {
    console.log("Enrollment: already enrolled or course is accessible (scoped Start/Continue/Resume).");
    return;
  }

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let clicked = await clickTutorEnrollCta(page);
    if (!clicked) {
      clicked = await tryClickByText(page, ENROLL_BUTTONS, "enroll", 1);
    }
    if (clicked) {
      await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
      console.log(`Enrollment: enroll click attempt ${attempt}.`);
    }

    await waitForCourseAccessOrNoEnrollCta(page);

    if (await isAlreadyEnrolledOrAccessible(page)) {
      console.log("Enrollment: confirmed after enroll action.");
      return;
    }

    if (!(await hasVisibleEnrollCta(page))) {
      console.log("Enrollment: no visible enroll control left in course chrome; continuing.");
      return;
    }

    await autoScroll(page, 2);
  }

  console.log("Enrollment: could not confirm after retries; continuing anyway.");
}

async function courseCompletionDetected(page) {
  const completionSignals = [
    page.getByText(/course completed|completed|100%/i),
    page.locator('[class*="complete" i], [class*="completed" i]'),
    page.locator('[aria-valuenow="100"]')
  ];
  for (const signal of completionSignals) {
    if (await signal.count().catch(() => 0)) return true;
  }
  return false;
}

function normalizePageUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    u.hash = "";
    return u.toString().replace(/\/$/, "");
  } catch {
    return (rawUrl || "").replace(/#.*$/, "").replace(/\/$/, "");
  }
}

async function extractLessonTitle(page, fallbackUrl) {
  const locators = [
    page.locator(".tutor-course-topic-title, .tutor-lesson-title, .tutor-segment-title, .tutor-lesson-content h2").first(),
    page.locator("h1").first(),
    page.locator(".entry-title").first()
  ];
  for (const loc of locators) {
    if (await loc.count()) {
      const text = ((await loc.textContent()) || "").trim();
      if (text) return sanitizeCourseName(text);
    }
  }
  try {
    const parts = new URL(fallbackUrl).pathname.split("/").filter(Boolean);
    const slug = parts[parts.length - 1] || "lesson";
    return sanitizeCourseName(slug.replace(/-/g, " "));
  } catch {
    return "Untitled Lesson";
  }
}

/**
 * Tutor spotlight pages include curriculum/progress in the same innerText blob as the lesson.
 * For text-only lessons, keep the slice between the first "Mark as Complete" and the nav row "Previous".
 * Falls back to fullText if markers are missing or the slice is too short (matches buildLessonFileBody threshold).
 */
function sliceTutorLessonBody(fullText, minLen = 25) {
  const raw = fullText == null ? "" : String(fullText);
  const combined = raw.replace(/\r\n/g, "\n");
  const startMarker = "Mark as Complete";
  const i = combined.indexOf(startMarker);
  if (i === -1) return raw;

  let after = combined.slice(i + startMarker.length);
  const lines = after.split("\n");
  let sliced = "";
  let found = false;
  for (let k = 0; k < lines.length; k += 1) {
    if (lines[k].trim() === "Previous") {
      sliced = lines.slice(0, k).join("\n");
      found = true;
      break;
    }
  }
  if (!found) {
    const m = after.match(/\n\s*Previous\s*(?:\n|$)/);
    if (m && m.index !== undefined) {
      sliced = after.slice(0, m.index);
      found = true;
    }
  }
  if (!found) return raw;

  const out = sliced
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (out.length >= minLen) return out;
  return raw;
}

/** Readable lesson body text (excludes nav/script noise). */
async function extractReadableLessonText(page, opts = {}) {
  const { tutorBodySlice = false } = opts;
  const combined = await page
    .evaluate(() => {
      const selectors = [
        ".tutor-lesson-content",
        ".tutor-course-topic-single-content",
        ".tutor-quiz-single-wrap",
        "article .entry-content",
        "#content .entry-content",
        "main article",
        "[role='main']"
      ];
      const seen = new Set();
      let combined = "";
      const junkSelectors = [
        "script", "style", "header", "nav", "footer", "aside", "iframe",
        ".wp-block-navigation", ".tutor-course-filter", ".tutor-course-sidebar",
        ".tutor-single-course-sidebar", ".tutor-lesson-sidebar", ".tutor-course-single-sidebar",
        ".sidebar", "#sidebar", "meta", "form",
        ".tutor-topbar", ".tutor-lesson-topbar", ".tutor-pagination", 
        ".tutor-next-previous-pagination", ".tutor-course-topic-list", 
        ".tutor-course-content-list", ".tutor-progress-bar", 
        ".tutor-lesson-progress", ".tutor-segment-progress", 
        ".tutor-course-details-header", ".tutor-lesson-footer",
        ".tutor-course-topic-title", ".tutor-lesson-title", ".tutor-segment-title", ".tutor-course-title"
      ].join(", ");

      const processClone = (clone) => {
        clone.querySelectorAll(junkSelectors).forEach((n) => n.remove());
        clone.querySelectorAll("strong, b").forEach(el => {
          const t = el.innerText || el.textContent || "";
          if (t.trim()) el.innerText = `**${t.trim()}**`;
        });
        return (clone.innerText || "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
      };

      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (!el) continue;
        const clone = el.cloneNode(true);
        const text = processClone(clone);
        const key = text.slice(0, 120);
        if (text.length > 30 && !seen.has(key)) {
          seen.add(key);
          combined += (combined ? "\n\n---\n\n" : "") + text;
        }
      }
      if (!combined.trim()) {
        const main = document.querySelector("main") || document.querySelector("#content") || document.body;
        if (main) {
          const clone = main.cloneNode(true);
          combined = processClone(clone);
        }
      }
      return combined.slice(0, 500000);
    })
    .catch(() => "");
  if (!tutorBodySlice) return combined;
  return sliceTutorLessonBody(combined);
}

/** Direct media hints from DOM (video, source, common embed iframes). */
async function collectDomMediaHints(page) {
  return page
    .evaluate(() => {
      const out = [];
      document.querySelectorAll("video[src], video source[src]").forEach((n) => {
        const s = n.getAttribute("src");
        if (s) out.push(s);
      });
      document.querySelectorAll("iframe[src]").forEach((n) => {
        const s = n.getAttribute("src") || "";
        if (/youtube|youtu\.be|vimeo|player\.|wistia|cloudfront|bunny|jwplayer|\.mp4|m3u8/i.test(s)) {
          out.push(s);
        }
      });
      return out;
    })
    .catch(() => []);
}

async function gatherLessonVideoUrls(page) {
  const raw = new Set();
  const fromDom = await collectDomMediaHints(page);
  fromDom.forEach((u) => raw.add(u));
  const fromFrames = await extractUrlsFromPageAndFrames(page);
  fromFrames.forEach((u) => raw.add(u));
  const canonical = Array.from(raw).map((u) => canonicalizeMediaUrl(u)).filter(Boolean);
  const filtered = canonical.filter((u) => isPotentialMediaUrl(u));
  return filterWorkingMediaUrls(filtered);
}

function buildLessonFileBody(lessonTitle, textBody, videoUrls) {
  const textTrim = (textBody || "").trim();
  const hasText = textTrim.length >= 25;
  const hasVideo = videoUrls.length > 0;

  let out = "";

  if (hasVideo && !hasText) {
    out += "Video URL:\n";
    videoUrls.forEach((u) => {
      out += `${u}\n`;
    });
    return out.trim();
  }

  if (hasText && !hasVideo) {
    out += textTrim;
    return out.trim();
  }

  if (hasText && hasVideo) {
    out += textTrim;
    out += "\n\nVideo URL(s):\n";
    videoUrls.forEach((u) => {
      out += `${u}\n`;
    });
    return out.trim();
  }

  if (hasVideo) {
    out += "Video URL:\n";
    videoUrls.forEach((u) => {
      out += `${u}\n`;
    });
    return out.trim();
  }

  out += textTrim || "(No extractable text or verified video URL for this lesson.)";
  return out.trim();
}

function isJunkLessonTitleBase(titleBase) {
  if (titleBase == null || typeof titleBase !== "string") return true;
  const b = titleBase.trim().toLowerCase();
  if (!b) return true;
  const collapsed = b.replace(/_/g, "");
  if (/^inserteditlink$/i.test(collapsed)) return true;
  if (/^untitled(_lesson)?$/i.test(b)) return true;
  return false;
}

function displayLessonTitleForBody(rawTitle, lessonPageUrl) {
  const base = sanitizeFileBase(rawTitle);
  if (isJunkLessonTitleBase(base)) {
    try {
      const parts = new URL(lessonPageUrl).pathname.split("/").filter(Boolean);
      const slug = parts[parts.length - 1] || "lesson";
      return sanitizeCourseName(slug.replace(/-/g, " "));
    } catch {
      return "Untitled Lesson";
    }
  }
  return rawTitle;
}

function resolveLessonDestPath(courseDir, lessonTitle, lessonPageUrl, titleSlugClaimMap, lessonCounterRef) {
  lessonCounterRef.n += 1;
  const num = lessonCounterRef.n;
  const slug = sanitizeFileBase(lessonSlugFromUrl(lessonPageUrl));
  return path.join(courseDir, `${num}_${slug}.txt`);
}

function cleanExtractedText(rawText) {
  let text = rawText || "";
  
  // Cut everything before and including the Progress percentage (e.g., "(0%)")
  const progressMatch = text.match(/Your Progress:[\s\S]*?\(\d+%\)/i);
  if (progressMatch) {
    const startIndex = progressMatch.index + progressMatch[0].length;
    text = text.slice(startIndex);
  }

  // Find the end markers: "Previous", "Next", "X% Complete"
  const endMarkers = [
    /\n\s*Previous\s*(?:\n|$)/i,
    /\n\s*Next\s*(?:\n|$)/i,
    /\n\s*\d+% Complete\s*(?:\n|$)/i
  ];

  let earliestEndIndex = text.length;
  for (const marker of endMarkers) {
    const match = text.match(marker);
    if (match && match.index < earliestEndIndex) {
      earliestEndIndex = match.index;
    }
  }

  text = text.slice(0, earliestEndIndex);

  // Filter out missing info placeholders like [Address Not Provided] or <phone>
  text = text.split('\n').filter(line => {
    const trimmed = line.trim();
    if (/^\[.*?Not Provided\]$/i.test(trimmed)) {
      return false;
    }
    if (/^<phone>$/i.test(trimmed)) {
      return false;
    }
    return true;
  }).join('\n');

  // Strip excessive leading tabs from lines
  text = text.split('\n').map(line => line.replace(/^\t+/, '')).join('\n');

  return text.trim();
}

async function saveLessonArtifact(courseName, page, lessonPageUrl, mergeState, preCollectedTexts) {
  const { courseDir } = mergeState;
  
  const slug = sanitizeFileBase(lessonSlugFromUrl(lessonPageUrl));

  const pdfLinks = await page.evaluate(() => {
    const links = [];
    document.querySelectorAll('a[href]').forEach(a => {
      if (a.href.toLowerCase().endsWith('.pdf') || a.href.toLowerCase().includes('.pdf?')) {
        links.push(a.href);
      }
    });
    document.querySelectorAll('iframe[src]').forEach(f => {
      if (f.src.toLowerCase().endsWith('.pdf') || f.src.toLowerCase().includes('.pdf?')) {
        links.push(f.src);
      }
    });
    return Array.from(new Set(links));
  });

  let videoUrls = [];
  try {
    videoUrls = await gatherLessonVideoUrls(page);
  } catch {
    videoUrls = [];
  }

  const hasVideo = videoUrls.length > 0;
  const hasPdf = pdfLinks.length > 0;

  if (hasVideo || hasPdf) {
    // Both videos and PDFs act as separators for the text buffer
    mergeState.flushText();
  }

  if (hasPdf) {
    let pdfSaved = false;
    for (let i = 0; i < pdfLinks.length; i++) {
      const pdfUrl = pdfLinks[i];
      try {
        const res = await fetch(pdfUrl);
        if (res.ok) {
          if (!pdfSaved) {
            mergeState.globalCounter++;
            pdfSaved = true;
          }
          const buffer = await res.arrayBuffer();
          const pdfDest = pdfLinks.length === 1 
            ? path.join(courseDir, `${mergeState.globalCounter}_${slug}.pdf`)
            : path.join(courseDir, `${mergeState.globalCounter}_${slug}_${i+1}.pdf`);
          fs.writeFileSync(pdfDest, Buffer.from(buffer));
          console.log(`Downloaded PDF: ${pdfDest}`);
        }
      } catch (e) {
        console.log(`Failed to download PDF: ${pdfUrl} - ${e.message}`);
      }
    }
  }

  if (hasVideo) {
    mergeState.globalCounter++;
    const filename = `${mergeState.globalCounter}_${slug}_video.txt`;
    const destPath = path.join(courseDir, filename);
    
    // Contain ONLY the video URL/link
    const videoContent = videoUrls.join('\n');
    fs.writeFileSync(destPath, videoContent + "\n", "utf8");
    console.log(`Saved video file: ${destPath}`);
    
    mergeState.videoCounter++;
  }

  if (!hasVideo && !hasPdf) {
    // Use pre-collected slide texts if available, otherwise extract from current page
    let combinedBody;
    if (preCollectedTexts && preCollectedTexts.length > 0) {
      // Deduplicate slide texts and combine
      const uniqueSlides = [];
      const slideSeen = new Set();
      for (let t of preCollectedTexts) {
        // Strip repeating course title from the top of the slide
        if (t.startsWith(courseName)) {
          t = t.substring(courseName.length).trim();
        }
        const key = t.slice(0, 300).trim();
        if (key && !slideSeen.has(key)) {
          slideSeen.add(key);
          uniqueSlides.push(t);
        }
      }
      combinedBody = uniqueSlides.join('\n\n');
    } else {
      const isQuizPage = (await page.locator(".tutor-quiz-single-wrap").count()) > 0;
      const tutorBodySlice = !isQuizPage;
      let textBody = await extractReadableLessonText(page, { tutorBodySlice });
      textBody = cleanExtractedText(textBody);
      if (textBody.startsWith(courseName)) {
        textBody = textBody.substring(courseName.length).trim();
      }
      combinedBody = textBody;
    }

    // Add the course name once at the very top of the lesson if it's not already there
    const body = combinedBody.trim() || "(No extractable text)";
    const finalBody = `${courseName}\n\n${body}`;
    
    // Deduplicate: skip if identical content was already scraped
    const contentKey = finalBody.slice(0, 300).trim();
    if (body !== "(No extractable text)" && !mergeState.seenContent.has(contentKey)) {
      mergeState.seenContent.add(contentKey);
      mergeState.currentTextBody.push(finalBody);
    }
  }
}

async function collectLessonLinks(page) {
  return page
    .evaluate(() => {
      const toAbs = (href) => {
        if (!href) return "";
        try {
          return new URL(href, window.location.href).href;
        } catch {
          return href;
        }
      };
      const ordered = [];
      const seen = new Set();
      const push = (href) => {
        const abs = toAbs(href);
        if (!abs || !abs.includes("/lessons/")) return;
        if (seen.has(abs)) return;
        seen.add(abs);
        ordered.push(abs);
      };

      const curriculumRoots = document.querySelectorAll(
        ".tutor-course-topic-list, .tutor-course-content-list, .tutor-course-single-content, [class*='topic-item'], .tutor-course-curriculum, .tutor-course-spotlight-wrapper"
      );
      curriculumRoots.forEach((root) => {
        root.querySelectorAll('a[href*="/lessons/"]').forEach((a) => push(a.href));
      });

      document.querySelectorAll('a[href*="/lessons/"]').forEach((a) => push(a.href));

      const lessonAttrs = document.querySelectorAll("[data-lesson_url], [data-lesson-url]");
      lessonAttrs.forEach((el) => {
        const href = el.getAttribute("data-lesson_url") || el.getAttribute("data-lesson-url") || "";
        push(href);
      });

      return ordered;
    })
    .catch(() => []);
}

async function processCourse(context, url, index, total) {
  const page = await context.newPage();
  const perCourseUrls = new Set();

  const addCourseUrl = (rawUrl) => {
    const canonical = canonicalizeMediaUrl(rawUrl);
    if (!isPotentialMediaUrl(canonical)) return;
    if (allUniqueUrls.has(canonical)) return;
    allUniqueUrls.add(canonical);
    perCourseUrls.add(canonical);
    console.log(`Found video URL: ${canonical}`);
  };

  setupNetworkCapture(page, addCourseUrl);

  try {
    console.log(`Processing course: [${index + 1}/${total}] ${url}`);
    await safeGoto(page, url, "course page");
    await autoScroll(page, 6);

    const courseName = await extractCourseName(page, url);
    console.log(`Processing course: ${courseName}`);

    // Create course folder immediately so one folder exists per course in the crawl, even if no lesson .txt is written later.
    const courseOutDir = path.join(OUTPUT_DIR, sanitizeFolderName(courseName));
    fs.mkdirSync(courseOutDir, { recursive: true });

    await maybeEnroll(page);
    await waitForCourseAccessOrNoEnrollCta(page);
    await safeGoto(page, url, "course page after enroll");
    console.log("Enrollment: reloaded course URL after enroll attempt.");

    await tryClickByText(page, ["Start Learning", "Continue", "Resume", "Begin", "Go to Course"], "start lesson", 2);

    // Build a lesson queue so we explicitly iterate each lesson URL instead of relying only on "Next" clicks.
    const lessonQueue = [];
    const queuedLessons = new Set();
    const visitedLessons = new Set();

    const queueLesson = (lessonUrl) => {
      const normalized = normalizePageUrl(lessonUrl);
      if (!normalized.includes("/lessons/")) return;
      if (queuedLessons.has(normalized) || visitedLessons.has(normalized)) return;
      queuedLessons.add(normalized);
      lessonQueue.push(normalized);
    };

    const seedLessons = await collectLessonLinks(page);
    seedLessons.forEach(queueLesson);
    queueLesson(page.url());

    const mergeState = {
      courseDir: courseOutDir,
      globalCounter: 0,
      textPartCounter: 1,
      videoCounter: 1,
      lessonIndex: 0,
      currentTextBody: [],
      seenContent: new Set(),
      flushText: function() {
        if (this.currentTextBody.length > 0) {
          this.globalCounter++;
          const filename = `${this.globalCounter}_part_${this.textPartCounter}.txt`;
          const destPath = path.join(this.courseDir, filename);
          const sep = "\n\n\n\n";
          fs.writeFileSync(destPath, this.currentTextBody.join(sep) + "\n", "utf8");
          console.log(`Saved merged text file: ${destPath}`);
          
          this.currentTextBody = [];
          this.textPartCounter++;
        }
      }
    };

    let noProgressCycles = 0;
    try {
    while (visitedLessons.size < MAX_COURSE_STEPS) {
      // If queue is empty, try to reveal more lessons via scrolling/progress button.
      if (lessonQueue.length === 0) {
        const clicked = await tryClickByText(page, PROGRESS_BUTTONS, "course progress", 1);
        await autoScroll(page, 2);
        const extraLessons = await collectLessonLinks(page);
        extraLessons.forEach(queueLesson);
        queueLesson(page.url());

        if (!clicked && lessonQueue.length === 0) {
          noProgressCycles += 1;
          if (noProgressCycles >= 3) break;
        } else {
          noProgressCycles = 0;
        }
        continue;
      }

      const lessonUrl = lessonQueue.shift();
      if (!lessonUrl || visitedLessons.has(lessonUrl)) continue;

      console.log(`Visiting lesson: ${lessonUrl}`);
      await safeGoto(page, lessonUrl, "lesson page");
      visitedLessons.add(lessonUrl);
      await autoScroll(page, 3);

      // Collect text from each slide BEFORE clicking Next
      const slideTexts = [];
      const captureSlideText = async () => {
        try {
          const isQuizPage = (await page.locator(".tutor-quiz-single-wrap").count()) > 0;
          const tutorBodySlice = !isQuizPage;
          let textBody = await extractReadableLessonText(page, { tutorBodySlice });
          textBody = cleanExtractedText(textBody);
          if (textBody.trim().length >= 25) {
            slideTexts.push(textBody.trim());
          }
        } catch {}
      };

      // Capture initial slide text
      await captureSlideText();

      // Capture URLs and attempt to complete/proceed within each lesson.
      for (let step = 0; step < 8; step += 1) {
        const discovered = await extractUrlsFromPageAndFrames(page);
        for (const u of discovered) {
          addCourseUrl(u);
        }

        const discoveredLessons = await collectLessonLinks(page);
        discoveredLessons.forEach(queueLesson);

        if (await courseCompletionDetected(page)) {
          console.log("Course completed");
          break;
        }

        const currentBeforeClick = normalizePageUrl(page.url());
        const clicked = await tryClickByText(page, PROGRESS_BUTTONS, "lesson progress", 1);
        if (!clicked) break;

        await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(900);
        await autoScroll(page, 2);

        // Capture text from the new slide after clicking
        await captureSlideText();

        const currentAfterClick = normalizePageUrl(page.url());
        if (currentAfterClick !== currentBeforeClick) {
          queueLesson(currentAfterClick);
          break; // Stop treating this as a slide if we navigated to a new lesson!
        }
      }

      try {
        await saveLessonArtifact(courseName, page, lessonUrl, mergeState, slideTexts);
      } catch (err) {
        console.log(`Lesson file save failed (${lessonUrl}): ${err.message}`);
      }
    }
    } finally {
      // Flush any remaining accumulated text lessons (even on crash)
      mergeState.flushText();
    }

    // Final pass on the current page to avoid missing late-loaded media.
    const finalDiscovered = await extractUrlsFromPageAndFrames(page);
    for (const u of finalDiscovered) {
      addCourseUrl(u);
    }

    const courseUrls = await filterWorkingMediaUrls(Array.from(perCourseUrls));
    if (courseUrls.length > 0) {
      fs.writeFileSync(path.join(courseOutDir, "link.txt"), `${courseUrls.join("\n")}\n`, "utf8");
      console.log(`Wrote link.txt with ${courseUrls.length} URL(s).`);
    }
    appendTxtByCourse(courseName, courseUrls);
    for (const urlItem of courseUrls) {
      allPairs.push({ course: courseName, url: urlItem });
    }
    persistOutputs();
    await persistCsv();
    console.log("Saved results");
  } catch (error) {
    console.log(`Course failed but continuing: ${url} -> ${error.message}`);
  } finally {
    await page.close().catch(() => {});
  }
}

async function run() {
  resetOutputDirectory();
  ensureOutputFiles();

  const browser = await chromium.launch({
    headless: false,
    slowMo: process.argv.includes("--debug") ? 300 : 50
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 }
  });
  const page = await context.newPage();
  page.setDefaultTimeout(DEFAULT_TIMEOUT);

  try {
    await login(page);
    const courseLinks = await collectCourseLinks(page);
    console.log(`Found ${courseLinks.length} courses`);

    let uniqueCourseLinks = Array.from(new Set(courseLinks));
    uniqueCourseLinks = uniqueCourseLinks.filter(u => /implementing.*community.*fall.*prevention/i.test(u) || /how.*plan.*workplace.*emergencies/i.test(u));
    
    for (let i = 0; i < uniqueCourseLinks.length; i += 1) {
      if (i > 0) {
        console.log(`Waiting 5 seconds before starting the next course...`);
        await page.waitForTimeout(5000);
      }
      await processCourse(context, uniqueCourseLinks[i], i, uniqueCourseLinks.length);
    }

    console.log("All done.");
  } catch (error) {
    console.error(`Fatal error: ${error.message}`);
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

run();
