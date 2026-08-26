/*
 * Copyright (c) 2026 Casual Office. All rights reserved.
 */

/**
 * Font loader.
 *
 * Every font this editor can render is bundled with it. Nothing is fetched
 * from a third-party CDN — not Google Fonts, not anything else. A document
 * opened here makes no request that tells an outside party who is reading it,
 * which matters because the readers are schoolchildren.
 *
 * Practically this means: a family declared by a bundled `@font-face` (the
 * Croscore/Liberation metric-compatible set in fonts.css) is loaded from disk;
 * anything else falls through to `fontResolver`'s CSS fallback stack, which
 * always ends in a generic family, so text still renders in something
 * sensible. Layout stays deterministic offline, on a school network that
 * blocks Google, and in a Tauri webview.
 */

// Families confirmed available, so we ask the browser only once.
const loadedFonts = new Set<string>();

// Callbacks to notify when fonts are loaded
const loadCallbacks = new Set<(fonts: string[]) => void>();

/**
 * Make a font available, if we ship it.
 *
 * @param fontFamily - The font family name to load
 * @returns true if the family is bundled and now ready; false if it is not
 *          ours to provide, in which case the caller's CSS fallback stack
 *          decides what the reader sees.
 */
export async function loadFont(fontFamily: string): Promise<boolean> {
  // Skip font loading in non-browser environments (Node.js, SSR)
  if (typeof document === 'undefined') {
    return false;
  }

  // Normalize font family name
  const normalizedFamily = fontFamily.trim();

  // Already loaded?
  if (loadedFonts.has(normalizedFamily)) {
    return true;
  }

  // Bundled only. If this family is declared by an `@font-face` in fonts.css
  // (Carlito/Caladea/Liberation), load it from the local woff2.
  if ('fonts' in document) {
    const declared = Array.from(document.fonts).some(
      (ff) => ff.family.replace(/['"]/g, '').toLowerCase() === normalizedFamily.toLowerCase()
    );
    if (declared) {
      try {
        await document.fonts.load(`400 16px "${normalizedFamily}"`);
      } catch {
        // ignore — the @font-face is present; canvas/CSS will still use it
      }
      loadedFonts.add(normalizedFamily);
      notifyCallbacks([normalizedFamily]);
      return true;
    }
  }

  // Not one of ours. Say so rather than reaching out for it: the fallback
  // stack from `fontResolver` names the original Office font first (present on
  // most desktops) and ends in a generic family, so the text renders either
  // way.
  return false;
}

/**
 * Make several fonts available. Families we do not bundle are skipped.
 */
export async function loadFonts(families: string[]): Promise<void> {
  // Filter out already loaded fonts
  const toLoad = families.filter((family) => !loadedFonts.has(family.trim()));

  if (toLoad.length === 0) {
    return;
  }

  // Load all fonts in parallel
  await Promise.all(toLoad.map((family) => loadFont(family)));
}

/**
 * Check if a font is loaded
 *
 * @param fontFamily - The font family name to check
 * @returns true if the font is loaded, false otherwise
 */
export function isFontLoaded(fontFamily: string): boolean {
  return loadedFonts.has(fontFamily.trim());
}

/**
 * Whether a font fetch is in flight.
 *
 * Always false: there is no fetch. Fonts come from the bundle, and callers
 * that used this to show a "loading fonts" state have nothing to wait for.
 * Kept so those call sites keep compiling and simply never spin.
 */
export function isLoading(): boolean {
  return false;
}

/**
 * Get list of all loaded fonts
 *
 * @returns Array of loaded font family names
 */
export function getLoadedFonts(): string[] {
  return Array.from(loadedFonts);
}

/**
 * Register a callback to be notified when fonts are loaded
 *
 * @param callback - Function to call when fonts are loaded
 * @returns Cleanup function to remove the callback
 */
export function onFontsLoaded(callback: (fonts: string[]) => void): () => void {
  loadCallbacks.add(callback);

  // Return cleanup function
  return () => {
    loadCallbacks.delete(callback);
  };
}

/**
 * Notify all registered callbacks
 */
function notifyCallbacks(fonts: string[]): void {
  for (const callback of loadCallbacks) {
    try {
      callback(fonts);
    } catch (error) {
      console.warn('Font load callback error:', error);
    }
  }
}

/**
 * Wait for a font to be available using the CSS Font Loading API
 *
 * @param fontFamily - The font family to wait for
 * @param timeout - Maximum time to wait in milliseconds
 * @returns Promise resolving when font is available or timeout
 */
async function waitForFontAvailable(fontFamily: string, timeout: number): Promise<boolean> {
  // Use CSS Font Loading API if available
  if ('fonts' in document) {
    try {
      // Try to wait for the font
      const fontFace = `400 16px "${fontFamily}"`;
      await Promise.race([
        document.fonts.load(fontFace),
        new Promise((resolve) => setTimeout(resolve, timeout)),
      ]);

      return document.fonts.check(fontFace);
    } catch {
      // Fall through to fallback
    }
  }

  // Fallback: just wait a bit
  await new Promise((resolve) => setTimeout(resolve, 100));
  return true;
}

/**
 * Check if a font is available on the system using canvas measurement
 *
 * This uses the technique of comparing text width with the target font
 * vs a known fallback font. If they differ, the font is available.
 *
 * @param fontFamily - The font family name to check
 * @param fallbackFont - Fallback font to compare against
 * @returns true if font is available, false otherwise
 */
export function canRenderFont(fontFamily: string, fallbackFont: string = 'sans-serif'): boolean {
  // Skip if we're not in a browser
  if (typeof document === 'undefined') {
    return false;
  }

  const _canRenderFont = (fontName: string, fallback: string): boolean => {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    if (!ctx) {
      return false;
    }

    ctx.textBaseline = 'top';

    const text = 'abcdefghijklmnopqrstuvwxyz0123456789';

    // Measure with fallback font only
    ctx.font = `72px ${fallback}`;
    const fallbackWidth = ctx.measureText(text).width;

    // Measure with target font (with fallback)
    ctx.font = `72px "${fontName}", ${fallback}`;
    const customWidth = ctx.measureText(text).width;

    // If widths differ, the custom font was used
    return customWidth !== fallbackWidth;
  };

  // Check with primary fallback
  if (_canRenderFont(fontFamily, fallbackFont)) {
    return true;
  }

  // Check with opposite fallback (handles edge case where font name
  // matches the browser's default sans-serif or serif)
  const oppositeFallback = fallbackFont === 'sans-serif' ? 'serif' : 'sans-serif';
  return _canRenderFont(fontFamily, oppositeFallback);
}

/**
 * Load a font from a raw buffer (e.g., embedded in DOCX)
 *
 * @param fontFamily - The font family name
 * @param buffer - Font file buffer (TTF, OTF, WOFF, WOFF2)
 * @param options - Font options
 * @returns Promise resolving when font is loaded
 */
export async function loadFontFromBuffer(
  fontFamily: string,
  buffer: ArrayBuffer,
  options?: {
    weight?: number | string;
    style?: 'normal' | 'italic';
  }
): Promise<boolean> {
  const normalizedFamily = fontFamily.trim();

  // Already loaded?
  if (loadedFonts.has(normalizedFamily)) {
    return true;
  }

  try {
    // Create blob URL
    const blob = new Blob([buffer], { type: 'font/ttf' });
    const url = URL.createObjectURL(blob);

    // Create @font-face CSS
    const style = document.createElement('style');
    style.textContent = `
      @font-face {
        font-family: "${normalizedFamily}";
        src: url(${url}) format('truetype');
        font-weight: ${options?.weight ?? 'normal'};
        font-style: ${options?.style ?? 'normal'};
        font-display: swap;
      }
    `;

    document.head.appendChild(style);

    // Wait for font to be available
    await waitForFontAvailable(normalizedFamily, 3000);

    loadedFonts.add(normalizedFamily);
    notifyCallbacks([normalizedFamily]);

    return true;
  } catch (error) {
    console.warn(`Failed to load font "${normalizedFamily}" from buffer:`, error);
    return false;
  }
}

/**
 * Mapping from common Office/system fonts to Google Fonts equivalents
 *
 * Google Fonts doesn't have exact matches for many Microsoft fonts,
 * but these are close alternatives that work well for document rendering.
 */
export const FONT_MAPPING: Record<string, string> = {
  // Microsoft Office fonts → their OFL substitutes. The first five are
  // bundled and metric-compatible, so those documents lay out exactly. The
  // rest name a substitute we do NOT ship; they resolve through the CSS
  // fallback stack instead, and are kept here only so the font picker can
  // describe what a reader without the original will actually see.
  Calibri: 'Carlito',
  Cambria: 'Caladea',
  Arial: 'Liberation Sans',
  'Times New Roman': 'Liberation Serif',
  'Courier New': 'Liberation Mono',
  Garamond: 'EB Garamond',
  'Book Antiqua': 'EB Garamond',
  Georgia: 'Tinos',
  Verdana: 'Open Sans',
  Tahoma: 'Open Sans',
  'Trebuchet MS': 'Source Sans Pro',
  'Century Gothic': 'Poppins',
  'Franklin Gothic': 'Libre Franklin',
  Palatino: 'EB Garamond',
  'Palatino Linotype': 'EB Garamond',
  'Lucida Sans': 'Open Sans',
  'Segoe UI': 'Open Sans',
  Impact: 'Anton',
  'Comic Sans MS': 'Comic Neue',
  Consolas: 'Inconsolata',
  'Lucida Console': 'Inconsolata',
  Monaco: 'Fira Code',
};

/**
 * Get the Google Fonts equivalent for a font name
 *
 * @param fontName - The original font name from the document
 * @returns The Google Fonts equivalent, or the original name if no mapping exists
 */
export function getGoogleFontEquivalent(fontName: string): string {
  const trimmed = fontName.trim();
  return FONT_MAPPING[trimmed] || trimmed;
}

/**
 * Load a font, automatically mapping to Google Fonts equivalent if needed.
 * If the font needs mapping, also creates a CSS alias so the original font
 * name works in stylesheets.
 *
 * @param fontFamily - The font family name (may be an Office font)
 * @returns Promise resolving to true if font loaded
 */
export async function loadFontWithMapping(fontFamily: string): Promise<boolean> {
  const trimmed = fontFamily.trim();
  const googleFont = getGoogleFontEquivalent(trimmed);

  // Load the Google Font under its own name (no aliasing).
  // The font resolver provides CSS fallback stacks that list both the
  // original DOCX font and the Google equivalent, so the browser will
  // use whichever is available without @font-face aliasing that would
  // hijack Canvas measurements.
  if (googleFont !== trimmed) {
    const result = await loadFont(googleFont);
    if (result) {
      loadedFonts.add(trimmed);
    }
    return result;
  }

  // No mapping needed, load directly
  return loadFont(googleFont);
}

/**
 * Load multiple fonts with automatic mapping to Google Fonts equivalents
 *
 * @param families - Array of font family names
 * @returns Promise resolving when all fonts are loaded
 */
export async function loadFontsWithMapping(families: string[]): Promise<void> {
  // Remove duplicates
  const uniqueFonts = [...new Set(families.map((f) => f.trim()))];
  // Load each font with mapping (creates aliases for Office → Google font mappings)
  await Promise.all(uniqueFonts.map((family) => loadFontWithMapping(family)));
}

/**
 * Preload a list of common document fonts
 *
 * This preloads fonts commonly used in DOCX documents that have
 * Google Fonts equivalents.
 */
export async function preloadCommonFonts(): Promise<void> {
  const commonFonts = [
    'Carlito', // Calibri equivalent
    'Caladea', // Cambria equivalent
    'Arimo', // Arial equivalent
    'Tinos', // Times New Roman equivalent
    'Cousine', // Courier New equivalent
    'EB Garamond', // Garamond equivalent
  ];

  await loadFonts(commonFonts);
}

/**
 * Extract all font families used in a document
 *
 * Uses loose typing to handle any document-like structure.
 *
 * @param document - The parsed document
 * @returns Set of unique font family names
 */
export function extractFontsFromDocument(document: unknown): Set<string> {
  const fonts = new Set<string>();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const doc = document as any;
  if (!doc?.package) return fonts;

  // Extract from document content
  const content = doc.package?.document?.content;
  if (Array.isArray(content)) {
    for (const paragraph of content) {
      if (paragraph?.type === 'paragraph' && Array.isArray(paragraph.content)) {
        for (const run of paragraph.content) {
          if (run?.type === 'run' && run.formatting?.fontFamily) {
            const { ascii, hAnsi } = run.formatting.fontFamily;
            if (ascii) fonts.add(ascii);
            if (hAnsi && hAnsi !== ascii) fonts.add(hAnsi);
          }
        }
      }
    }
  }

  // Extract from styles
  const styles = doc.package?.styles?.styles;
  if (Array.isArray(styles)) {
    for (const style of styles) {
      if (style?.runProperties?.fontFamily) {
        const { ascii, hAnsi } = style.runProperties.fontFamily;
        if (ascii) fonts.add(ascii);
        if (hAnsi && hAnsi !== ascii) fonts.add(hAnsi);
      }
    }
  }

  return fonts;
}

/**
 * Extract fonts from a document and load them from Google Fonts
 *
 * @param document - The parsed document
 * @returns Promise resolving when fonts are loaded
 */
export async function loadDocumentFonts(document: unknown): Promise<void> {
  const fonts = extractFontsFromDocument(document);

  if (fonts.size === 0) {
    return;
  }

  // Loading document fonts
  await loadFontsWithMapping(Array.from(fonts));
}
