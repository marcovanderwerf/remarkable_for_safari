/**
 * Readability - Extract clean article content from web pages
 * Based on Mozilla's Readability algorithm
 * https://github.com/mozilla/readability
 */

class Readability {
  constructor(doc, options = {}) {
    this._doc = doc;
    this._articleTitle = "";
    this._articleByline = "";
    this._articleContent = null;

    this.DEFAULT_CHAR_THRESHOLD = 500;
    this.FLAG_STRIP_UNLIKELYS = 0x1;
    this.FLAG_WEIGHT_CLASSES = 0x2;
    this.FLAG_CLEAN_CONDITIONALLY = 0x4;

    this._flags = this.FLAG_STRIP_UNLIKELYS | this.FLAG_WEIGHT_CLASSES | this.FLAG_CLEAN_CONDITIONALLY;

    this.REGEXPS = {
      unlikelyCandidates: /-ad-|ai2html|banner|breadcrumbs|combx|comment|community|cover-wrap|disqus|extra|footer|gdpr|header|legends|menu|related|remark|replies|rss|shoutbox|sidebar|skyscraper|social|sponsor|supplemental|ad-break|agegate|pagination|pager|popup|yom-hierarchical-ads|cookie|consent|subscribe|newsletter|paywall/i,
      okMaybeItsACandidate: /and|article|body|column|content|main|shadow/i,
      positive: /article|body|content|entry|hentry|h-entry|main|page|pagination|post|text|blog|story/i,
      negative: /hidden|^hid$| hid$| hid |^hid |banner|combx|comment|com-|contact|foot|footer|footnote|gdpr|masthead|media|meta|outbrain|promo|related|scroll|share|shoutbox|sidebar|skyscraper|sponsor|shopping|tags|tool|widget|cookie|consent|subscribe/i,
      extraneous: /print|archive|comment|discuss|e[\-]?mail|share|reply|all|login|sign|single|utility/i,
      byline: /byline|author|dateline|writtenby|p-author/i,
      replaceFonts: /<(\/?)font[^>]*>/gi,
      normalize: /\s{2,}/g,
      videos: /\/\/(www\.)?((dailymotion|youtube|youtube-nocookie|player\.vimeo|v\.qq)\.com|(archive|upload\.wikimedia)\.org|player\.twitch\.tv)/i,
      shareElements: /(\b|_)(share|sharedaddy)(\b|_)/i,
      nextLink: /(next|weiter|continue|>([^\|]|$)|»([^\|]|$))/i,
      prevLink: /(prev|earl|old|new|<|«)/i,
      tokenize: /\W+/g,
      whitespace: /^\s*$/,
      hasContent: /\S$/,
      hashUrl: /^#.+/,
      srcsetUrl: /(\S+)(\s+[\d.]+[xw])?(\s*(?:,|$))/g,
      b64DataUrl: /^data:\s*([^\s;,]+)\s*;\s*base64\s*,/i,
      jsonLdArticleTypes: /^Article|AdvertiserContentArticle|NewsArticle|AnalysisNewsArticle|AskPublicNewsArticle|BackgroundNewsArticle|OpinionNewsArticle|ReportageNewsArticle|ReviewNewsArticle|Report|SatiricalArticle|ScholarlyArticle|MedicalScholarlyArticle|SocialMediaPosting|BlogPosting|LiveBlogPosting|DiscussionForumPosting|TechArticle|APIReference$/,
    };

    this.DIV_TO_P_ELEMS = new Set(["BLOCKQUOTE", "DL", "DIV", "IMG", "OL", "P", "PRE", "TABLE", "UL"]);
    this.ALTER_TO_DIV_EXCEPTIONS = ["DIV", "ARTICLE", "SECTION", "P"];
    this.PRESENTATIONAL_ATTRIBUTES = ["align", "background", "bgcolor", "border", "cellpadding", "cellspacing", "frame", "hspace", "rules", "style", "valign", "vspace"];
    this.DEPRECATED_SIZE_ATTRIBUTE_ELEMS = ["TABLE", "TH", "TD", "HR", "PRE"];
    this.PHRASING_ELEMS = ["ABBR", "AUDIO", "B", "BDO", "BR", "BUTTON", "CITE", "CODE", "DATA", "DATALIST", "DFN", "EM", "EMBED", "I", "IMG", "INPUT", "KBD", "LABEL", "MARK", "MATH", "METER", "NOSCRIPT", "OBJECT", "OUTPUT", "PROGRESS", "Q", "RUBY", "SAMP", "SCRIPT", "SELECT", "SMALL", "SPAN", "STRONG", "SUB", "SUP", "TEXTAREA", "TIME", "VAR", "WBR"];
  }

  parse() {
    // Remove scripts and styles
    this._removeScripts(this._doc);
    this._prepDocument();

    // Get article title
    this._articleTitle = this._getArticleTitle();

    // Get article metadata
    const metadata = this._getArticleMetadata();
    this._articleByline = metadata.byline || "";

    // Grab the article content
    let articleContent = this._grabArticle();

    if (!articleContent) {
      return null;
    }

    // Post-process the content
    this._postProcessContent(articleContent);

    return {
      title: this._articleTitle,
      byline: this._articleByline,
      content: articleContent.innerHTML,
      textContent: articleContent.textContent,
      length: articleContent.textContent.length,
      excerpt: metadata.excerpt || "",
      siteName: metadata.siteName || ""
    };
  }

  _removeScripts(doc) {
    this._removeNodes(this._getAllNodesWithTag(doc, ["script", "noscript", "style"]));
  }

  _prepDocument() {
    // Remove all style tags
    this._removeNodes(this._getAllNodesWithTag(this._doc, ["style"]));

    // Replace font tags with spans
    if (this._doc.body) {
      this._replaceBrs(this._doc.body);
    }
  }

  _getArticleTitle() {
    let curTitle = "";
    let origTitle = "";

    try {
      curTitle = origTitle = this._doc.title.trim();

      if (typeof curTitle !== "string") {
        curTitle = origTitle = this._getInnerText(this._doc.getElementsByTagName("title")[0]);
      }
    } catch (e) {
      // Ignore errors
    }

    // Try to get title from h1 elements
    const h1s = this._doc.getElementsByTagName("h1");
    if (h1s.length === 1) {
      curTitle = this._getInnerText(h1s[0]);
    }

    // Try to get title from meta tags
    const metaTitle = this._doc.querySelector('meta[property="og:title"]');
    if (metaTitle) {
      curTitle = metaTitle.getAttribute("content");
    }

    return curTitle.trim();
  }

  _getArticleMetadata() {
    const metadata = {
      title: "",
      byline: "",
      excerpt: "",
      siteName: ""
    };

    // Try Open Graph and Twitter meta tags
    const propertyPattern = /\s*(dc|dcterm|og|twitter)\s*:\s*(author|creator|description|title|site_name)\s*/gi;
    const namePattern = /^\s*(?:(dc|dcterm|og|twitter|weibo:(article|webpage))\s*[\.:]\s*)?(author|creator|description|title|site_name)\s*$/i;

    this._forEachNode(this._doc.getElementsByTagName("meta"), (element) => {
      const elementName = element.getAttribute("name");
      const elementProperty = element.getAttribute("property");
      const content = element.getAttribute("content");

      if (!content) return;

      let matches = null;
      let name = null;

      if (elementProperty) {
        matches = elementProperty.match(propertyPattern);
        if (matches) {
          name = elementProperty.toLowerCase().replace(/\s/g, "");
        }
      }
      if (!matches && elementName) {
        matches = elementName.match(namePattern);
        if (matches) {
          name = elementName;
        }
      }

      if (matches) {
        name = name.toLowerCase().replace(/\s/g, "");
        if (name.includes("author") || name.includes("creator")) {
          metadata.byline = content;
        } else if (name.includes("description")) {
          metadata.excerpt = content;
        } else if (name.includes("site_name")) {
          metadata.siteName = content;
        } else if (name.includes("title")) {
          metadata.title = content;
        }
      }
    });

    return metadata;
  }

  _grabArticle() {
    const page = this._doc.body;
    if (!page) {
      return null;
    }

    // Clone the document to avoid modifying the original
    const documentClone = this._doc.cloneNode(true);
    const body = documentClone.body;

    // Look for specific article containers
    const articleSelectors = [
      "article",
      "[role='main']",
      "main",
      ".post-content",
      ".article-content",
      ".entry-content",
      ".content-body",
      "#article-body",
      ".story-body"
    ];

    for (const selector of articleSelectors) {
      const element = body.querySelector(selector);
      if (element && element.textContent.length > this.DEFAULT_CHAR_THRESHOLD) {
        return this._cleanArticleContent(element.cloneNode(true));
      }
    }

    // Fall back to scoring algorithm
    const candidates = this._getCandidates(body);
    if (candidates.length === 0) {
      return null;
    }

    // Get the top candidate
    const topCandidate = candidates[0];
    return this._cleanArticleContent(topCandidate.element.cloneNode(true));
  }

  _getCandidates(body) {
    const candidates = [];
    const elementsToScore = body.querySelectorAll("p, pre, article, div, section");

    this._forEachNode(elementsToScore, (element) => {
      const innerText = this._getInnerText(element);

      if (innerText.length < 25) return;

      const ancestors = this._getNodeAncestors(element, 3);
      if (ancestors.length === 0) return;

      let contentScore = 0;

      // Add a point for the paragraph itself
      contentScore += 1;

      // Add points for commas
      contentScore += innerText.split(",").length;

      // Add points for text length (max 3 points)
      contentScore += Math.min(Math.floor(innerText.length / 100), 3);

      // Score ancestors
      this._forEachNode(ancestors, (ancestor, level) => {
        if (!ancestor.tagName) return;

        if (!ancestor._readabilityScore) {
          ancestor._readabilityScore = this._initializeNode(ancestor);
        }

        const scoreDivider = level === 0 ? 1 : level === 1 ? 2 : level * 3;
        ancestor._readabilityScore += contentScore / scoreDivider;
      });
    });

    // Collect candidates
    const allElements = body.getElementsByTagName("*");
    this._forEachNode(allElements, (element) => {
      if (element._readabilityScore) {
        candidates.push({
          element: element,
          score: element._readabilityScore
        });
      }
    });

    // Sort by score
    candidates.sort((a, b) => b.score - a.score);

    return candidates;
  }

  _initializeNode(node) {
    let score = 0;
    switch (node.tagName) {
      case "DIV":
        score += 5;
        break;
      case "PRE":
      case "TD":
      case "BLOCKQUOTE":
        score += 3;
        break;
      case "ADDRESS":
      case "OL":
      case "UL":
      case "DL":
      case "DD":
      case "DT":
      case "LI":
      case "FORM":
        score -= 3;
        break;
      case "H1":
      case "H2":
      case "H3":
      case "H4":
      case "H5":
      case "H6":
      case "TH":
        score -= 5;
        break;
    }
    return score + this._getClassWeight(node);
  }

  _getClassWeight(element) {
    let weight = 0;
    if (element.className) {
      if (this.REGEXPS.negative.test(element.className)) weight -= 25;
      if (this.REGEXPS.positive.test(element.className)) weight += 25;
    }
    if (element.id) {
      if (this.REGEXPS.negative.test(element.id)) weight -= 25;
      if (this.REGEXPS.positive.test(element.id)) weight += 25;
    }
    return weight;
  }

  _cleanArticleContent(articleContent) {
    // Remove unwanted elements
    const unwantedSelectors = [
      "script", "style", "link", "noscript", "iframe:not([src*='youtube']):not([src*='vimeo'])",
      ".ad", ".ads", ".advertisement", "[class*='social']", "[class*='share']",
      ".comments", "#comments", ".related", ".recommended",
      "nav", "header:not(article header)", "footer:not(article footer)",
      "aside", ".sidebar", "[role='complementary']",
      ".newsletter", ".subscribe", ".subscription",
      "[class*='cookie']", "[class*='consent']", "[class*='gdpr']",
      "[class*='popup']", "[class*='modal']", ".paywall"
    ];

    for (const selector of unwantedSelectors) {
      try {
        this._removeNodes(articleContent.querySelectorAll(selector));
      } catch (e) {
        // Ignore invalid selectors
      }
    }

    // Clean attributes
    const cleanElements = articleContent.getElementsByTagName("*");
    this._forEachNode(cleanElements, (element) => {
      // Remove onclick and other event handlers
      for (let i = element.attributes.length - 1; i >= 0; i--) {
        const attr = element.attributes[i];
        if (attr.name.startsWith("on") ||
            (attr.name === "class" && this.REGEXPS.negative.test(attr.value))) {
          element.removeAttribute(attr.name);
        }
      }
    });

    return articleContent;
  }

  _postProcessContent(articleContent) {
    // Fix relative URLs
    this._fixRelativeUrls(articleContent);

    // Clean up empty elements
    this._cleanEmptyElements(articleContent);
  }

  _fixRelativeUrls(articleContent) {
    const baseUrl = this._doc.baseURI;
    const docUrl = this._doc.documentURI;

    const toAbsoluteURI = (uri) => {
      if (!uri) return "";
      try {
        return new URL(uri, baseUrl).href;
      } catch (e) {
        return uri;
      }
    };

    const links = articleContent.getElementsByTagName("a");
    this._forEachNode(links, (link) => {
      const href = link.getAttribute("href");
      if (href) {
        link.setAttribute("href", toAbsoluteURI(href));
      }
    });

    const images = articleContent.getElementsByTagName("img");
    this._forEachNode(images, (img) => {
      const src = img.getAttribute("src");
      if (src) {
        img.setAttribute("src", toAbsoluteURI(src));
      }
      const srcset = img.getAttribute("srcset");
      if (srcset) {
        const newSrcset = srcset.replace(this.REGEXPS.srcsetUrl, (match, url, descriptor) => {
          return toAbsoluteURI(url) + (descriptor || "") + " ";
        });
        img.setAttribute("srcset", newSrcset.trim());
      }
    });
  }

  _cleanEmptyElements(element) {
    const children = element.children;
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i];
      if (child.children) {
        this._cleanEmptyElements(child);
      }
      if (!child.textContent.trim() &&
          !child.querySelector("img, video, audio, iframe, embed, object")) {
        child.remove();
      }
    }
  }

  // Helper methods
  _removeNodes(nodeList, filterFn) {
    this._forEachNode(nodeList, (node) => {
      if (!filterFn || filterFn(node)) {
        node.parentNode && node.parentNode.removeChild(node);
      }
    });
  }

  _forEachNode(nodeList, fn) {
    Array.prototype.forEach.call(nodeList, fn);
  }

  _getAllNodesWithTag(node, tagNames) {
    const result = [];
    for (const tag of tagNames) {
      result.push(...node.getElementsByTagName(tag));
    }
    return result;
  }

  _getInnerText(element, normalizeSpaces = true) {
    const textContent = element.textContent.trim();
    return normalizeSpaces ? textContent.replace(this.REGEXPS.normalize, " ") : textContent;
  }

  _replaceBrs(element) {
    this._forEachNode(element.querySelectorAll("br"), (br) => {
      let next = br.nextSibling;
      let replaced = false;
      while ((next = this._nextElement(next)) && next.tagName === "BR") {
        replaced = true;
        const brToRemove = next;
        next = next.nextSibling;
        brToRemove.parentNode.removeChild(brToRemove);
      }

      if (replaced) {
        const p = this._doc.createElement("p");
        br.parentNode.replaceChild(p, br);

        next = p.nextSibling;
        while (next) {
          if (next.tagName === "BR") {
            const nextSibling = next.nextSibling;
            const nextBr = this._nextElement(nextSibling);
            if (nextBr && nextBr.tagName === "BR") {
              break;
            }
          }

          const sibling = next.nextSibling;
          p.appendChild(next);
          next = sibling;
        }
      }
    });
  }

  _nextElement(node) {
    let next = node;
    while (next && next.nodeType !== Node.ELEMENT_NODE && this.REGEXPS.whitespace.test(next.textContent)) {
      next = next.nextSibling;
    }
    return next;
  }

  _getNodeAncestors(node, maxDepth = 0) {
    const ancestors = [];
    let parent = node.parentElement;
    let depth = 0;
    while (parent && (maxDepth === 0 || depth < maxDepth)) {
      ancestors.push(parent);
      parent = parent.parentElement;
      depth++;
    }
    return ancestors;
  }
}

// Make available globally
if (typeof window !== 'undefined') {
  window.Readability = Readability;
}
