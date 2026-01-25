/**
 * Content script for reMarkable Safari Extension
 * Extracts article content from web pages
 */

(function() {
  'use strict';

  // Listen for messages from the popup or background script
  browser.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'extractArticle') {
      const result = extractArticle();
      sendResponse(result);
      return true;
    }

    if (request.action === 'getPageInfo') {
      sendResponse({
        url: window.location.href,
        title: document.title,
        domain: window.location.hostname
      });
      return true;
    }

    if (request.action === 'getSelectedContent') {
      const selection = window.getSelection();
      if (selection && selection.toString().trim()) {
        sendResponse({
          hasSelection: true,
          content: getSelectionHtml(),
          text: selection.toString()
        });
      } else {
        sendResponse({ hasSelection: false });
      }
      return true;
    }
  });

  /**
   * Extract article content using Readability
   */
  function extractArticle() {
    try {
      // Clone the document to avoid modifying the original
      const documentClone = document.cloneNode(true);
      const reader = new Readability(documentClone);
      const article = reader.parse();

      if (article) {
        return {
          success: true,
          title: article.title || document.title,
          content: article.content,
          textContent: article.textContent,
          byline: article.byline || '',
          siteName: article.siteName || extractSiteName(),
          excerpt: article.excerpt || '',
          url: window.location.href,
          length: article.length,
          images: extractImages(article.content)
        };
      }

      // Fallback: return body content if Readability fails
      return {
        success: true,
        title: document.title,
        content: document.body.innerHTML,
        textContent: document.body.textContent,
        byline: '',
        siteName: extractSiteName(),
        excerpt: '',
        url: window.location.href,
        length: document.body.textContent.length,
        images: extractAllImages()
      };
    } catch (error) {
      console.error('reMarkable Extension: Error extracting article', error);
      return {
        success: false,
        error: error.message,
        url: window.location.href,
        title: document.title
      };
    }
  }

  /**
   * Extract site name from meta tags or domain
   */
  function extractSiteName() {
    const ogSiteName = document.querySelector('meta[property="og:site_name"]');
    if (ogSiteName) {
      return ogSiteName.getAttribute('content');
    }

    const applicationName = document.querySelector('meta[name="application-name"]');
    if (applicationName) {
      return applicationName.getAttribute('content');
    }

    // Use domain as fallback
    return window.location.hostname.replace(/^www\./, '');
  }

  /**
   * Extract images from article HTML
   */
  function extractImages(htmlContent) {
    const images = [];
    const temp = document.createElement('div');
    temp.innerHTML = htmlContent;

    const imgElements = temp.querySelectorAll('img');
    imgElements.forEach((img, index) => {
      const src = img.src || img.getAttribute('data-src') || img.getAttribute('data-lazy-src');
      if (src && !src.startsWith('data:') && src.length < 500) {
        images.push({
          src: src,
          alt: img.alt || '',
          index: index
        });
      }
    });

    return images;
  }

  /**
   * Extract all images from the page
   */
  function extractAllImages() {
    const images = [];
    const imgElements = document.querySelectorAll('img');

    imgElements.forEach((img, index) => {
      const src = img.src || img.getAttribute('data-src');
      if (src && !src.startsWith('data:') && src.length < 500 && img.naturalWidth > 100) {
        images.push({
          src: src,
          alt: img.alt || '',
          width: img.naturalWidth,
          height: img.naturalHeight,
          index: index
        });
      }
    });

    // Sort by size (largest first)
    images.sort((a, b) => (b.width * b.height) - (a.width * a.height));

    return images.slice(0, 20); // Return top 20 images
  }

  /**
   * Get HTML of current selection
   */
  function getSelectionHtml() {
    const selection = window.getSelection();
    if (selection.rangeCount === 0) {
      return '';
    }

    const container = document.createElement('div');
    for (let i = 0; i < selection.rangeCount; i++) {
      container.appendChild(selection.getRangeAt(i).cloneContents());
    }

    return container.innerHTML;
  }

  /**
   * Generate clean HTML document for reMarkable
   */
  function generateCleanHtml(article) {
    const styles = `
      <style>
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
          line-height: 1.6;
          max-width: 800px;
          margin: 0 auto;
          padding: 20px;
          color: #333;
        }
        h1 { font-size: 1.8em; margin-bottom: 0.5em; }
        h2 { font-size: 1.5em; }
        h3 { font-size: 1.3em; }
        p { margin: 1em 0; }
        img { max-width: 100%; height: auto; }
        blockquote {
          border-left: 3px solid #ccc;
          margin: 1em 0;
          padding-left: 1em;
          color: #666;
        }
        pre, code {
          background: #f5f5f5;
          padding: 2px 6px;
          border-radius: 3px;
          font-family: 'SF Mono', Monaco, monospace;
        }
        pre { padding: 1em; overflow-x: auto; }
        a { color: #0066cc; }
        .byline { color: #666; font-size: 0.9em; margin-bottom: 1em; }
        .source { color: #999; font-size: 0.8em; margin-top: 2em; border-top: 1px solid #eee; padding-top: 1em; }
      </style>
    `;

    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(article.title)}</title>
  ${styles}
</head>
<body>
  <h1>${escapeHtml(article.title)}</h1>
  ${article.byline ? `<p class="byline">${escapeHtml(article.byline)}</p>` : ''}
  ${article.content}
  <p class="source">Source: <a href="${escapeHtml(article.url)}">${escapeHtml(article.siteName || article.url)}</a></p>
</body>
</html>`;
  }

  /**
   * Escape HTML special characters
   */
  function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // Export for use in other scripts
  window.remarkableExtension = {
    extractArticle,
    generateCleanHtml,
    extractSiteName,
    getSelectionHtml
  };

})();
