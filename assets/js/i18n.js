const SUPPORTED_LANGUAGES = ["en", "ar", "fa"];
const RTL_LANGUAGES = new Set(["ar", "fa"]);
const DEFAULT_LANGUAGE = "fa";
const LOCALE_PATH = "assets/locales";
const localeCache = new Map();

let activeLanguage = DEFAULT_LANGUAGE;
let activeLocale = null;
let fallbackLocale = null;

function normalizeLanguage(language) {
  if (!language) {
    return DEFAULT_LANGUAGE;
  }

  const normalized = String(language).toLowerCase().trim();
  return SUPPORTED_LANGUAGES.includes(normalized) ? normalized : DEFAULT_LANGUAGE;
}

function getLanguageFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const lang = params.get("lang");
  if (!lang) {
    return null;
  }

  return normalizeLanguage(lang);
}

function getLanguageFromStorage() {
  try {
    const stored = window.localStorage.getItem("site-language");
    if (!stored) {
      return null;
    }

    return normalizeLanguage(stored);
  } catch (error) {
    return null;
  }
}

async function fetchLocale(language) {
  if (localeCache.has(language)) {
    return localeCache.get(language);
  }

  const localeUrl = `${LOCALE_PATH}/${language}.json`;
  const response = await fetch(localeUrl, { cache: "no-store" });

  if (!response.ok) {
    throw new Error(`Could not load locale file: ${localeUrl}`);
  }

  const json = await response.json();
  localeCache.set(language, json);
  return json;
}

function resolveNestedValue(object, keyPath) {
  return keyPath.split(".").reduce((accumulator, key) => {
    if (accumulator && Object.prototype.hasOwnProperty.call(accumulator, key)) {
      return accumulator[key];
    }

    return undefined;
  }, object);
}

function translate(keyPath) {
  const localizedValue = resolveNestedValue(activeLocale, keyPath);
  if (localizedValue !== undefined) {
    return localizedValue;
  }

  const fallbackValue = resolveNestedValue(fallbackLocale, keyPath);
  if (fallbackValue !== undefined) {
    console.warn(`[i18n] Missing key "${keyPath}" in ${activeLanguage}; using default fallback locale.`);
    return fallbackValue;
  }

  console.warn(`[i18n] Missing key "${keyPath}" in both locale and fallback.`);
  return keyPath;
}

function applyTextNodes() {
  document.querySelectorAll("[data-i18n]").forEach((element) => {
    const keyPath = element.getAttribute("data-i18n");
    element.textContent = translate(keyPath);
  });

  document.querySelectorAll("[data-i18n-placeholder]").forEach((element) => {
    const keyPath = element.getAttribute("data-i18n-placeholder");
    element.setAttribute("placeholder", translate(keyPath));
  });

  document.querySelectorAll("[data-i18n-aria-label]").forEach((element) => {
    const keyPath = element.getAttribute("data-i18n-aria-label");
    element.setAttribute("aria-label", translate(keyPath));
  });
}

function updateMetadata() {
  const pageName = document.body?.dataset?.page || "home";
  const title = translate(`meta.pages.${pageName}.title`);
  const description = translate(`meta.pages.${pageName}.description`);

  document.title = title;

  const descriptionElement = document.querySelector('meta[name="description"]');
  if (descriptionElement) {
    descriptionElement.setAttribute("content", description);
  }
}

function updateDocumentAttributes(language) {
  const isRtl = RTL_LANGUAGES.has(language);
  document.documentElement.lang = language;
  document.documentElement.dir = isRtl ? "rtl" : "ltr";
}

function updateLanguageButtons(language) {
  document.querySelectorAll("[data-lang-switch]").forEach((button) => {
    const isActive = button.getAttribute("data-lang-switch") === language;
    button.setAttribute("aria-pressed", String(isActive));
    button.classList.toggle("is-active", isActive);
  });
}

function updateLocalizedLinks(language) {
  document.querySelectorAll("a[data-localized-link]").forEach((anchor) => {
    const href = anchor.getAttribute("href");
    if (!href) {
      return;
    }

    const nextUrl = new URL(href, window.location.href);
    nextUrl.searchParams.set("lang", language);

    const isSameOrigin = nextUrl.origin === window.location.origin;
    anchor.setAttribute(
      "href",
      isSameOrigin ? `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}` : nextUrl.toString(),
    );
  });
}

function updateUrlWithoutReload(language) {
  const nextUrl = new URL(window.location.href);
  nextUrl.searchParams.set("lang", language);
  window.history.replaceState({}, "", `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`);
}

function persistLanguage(language) {
  try {
    window.localStorage.setItem("site-language", language);
  } catch (error) {
    // Ignore storage errors in private browsing or locked environments.
  }
}

async function hydrateLocale(language) {
  const normalized = normalizeLanguage(language);

  try {
    const locale = await fetchLocale(normalized);
    return { language: normalized, locale };
  } catch (error) {
    console.warn(`[i18n] Locale load failed for ${normalized}. Falling back to default locale.`);
    const locale = await fetchLocale(DEFAULT_LANGUAGE);
    return { language: DEFAULT_LANGUAGE, locale };
  }
}

export async function setLanguage(language, options = {}) {
  const { persist = true } = options;
  const localeResult = await hydrateLocale(language);

  activeLanguage = localeResult.language;
  activeLocale = localeResult.locale;

  applyTextNodes();
  updateMetadata();
  updateDocumentAttributes(activeLanguage);
  updateLanguageButtons(activeLanguage);
  updateLocalizedLinks(activeLanguage);
  updateUrlWithoutReload(activeLanguage);

  if (persist) {
    persistLanguage(activeLanguage);
  }

  document.dispatchEvent(
    new CustomEvent("languagechange", {
      detail: {
        language: activeLanguage,
      },
    }),
  );
}

function detectInitialLanguage() {
  const urlLanguage = getLanguageFromUrl();
  if (urlLanguage) {
    return urlLanguage;
  }

  const storedLanguage = getLanguageFromStorage();
  if (storedLanguage) {
    return storedLanguage;
  }

  return DEFAULT_LANGUAGE;
}

function bindLanguageSwitcher() {
  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    const button = target.closest("[data-lang-switch]");
    if (!button) {
      return;
    }

    const language = button.getAttribute("data-lang-switch");
    if (!language || language === activeLanguage) {
      return;
    }

    void setLanguage(language);
  });
}

export async function initializeI18n() {
  fallbackLocale = await fetchLocale(DEFAULT_LANGUAGE);
  bindLanguageSwitcher();

  const initialLanguage = detectInitialLanguage();
  await setLanguage(initialLanguage, { persist: false });
}
