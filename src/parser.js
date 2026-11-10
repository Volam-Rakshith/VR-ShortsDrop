/*
 * VR ShortsDrop parser. Splits one pasted block (YouTube title/captions/description
 * plus Instagram text, all mixed together) into the fields the page reviews.
 * Works as a plain browser script (window.ClipParser) and under node (require).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ClipParser = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const YT_TITLE_MAX = 100;          // characters
  const YT_DESCRIPTION_MAX_BYTES = 5000;
  const YT_TAGS_MAX_CHARS = 500;     // all tags together
  const IG_CAPTION_MAX = 2200;       // characters

  // A line that starts with one of these labels opens that section.
  const LABELS = [
    { key: 'title', re: /^\s*(?:(?:yt|youtube)\s*)?title\s*:\s*(.*)$/i },
    { key: 'description', re: /^\s*(?:(?:yt|youtube)\s*)?(?:description|desc)\s*:\s*(.*)$/i },
    { key: 'captions', re: /^\s*(?:(?:yt|youtube)\s*)?(?:captions?|subtitles?)\s*:\s*(.*)$/i },
    { key: 'tags', re: /^\s*(?:(?:yt|youtube)\s*)?tags?\s*:\s*(.*)$/i },
    { key: 'instagram', re: /^\s*(?:ig|insta|instagram)(?:\s+(?:caption|title|text|description))?\s*:\s*(.*)$/i },
  ];

  const BLOCK_SEPARATOR = /^\s*(?:-{3,}|={3,})\s*$/;
  const HASHTAG = /#[\p{L}\p{N}_]+/gu;

  function splitBlocks(text) {
    const blocks = [];
    let current = [];
    for (const line of String(text || '').split(/\r?\n/)) {
      if (BLOCK_SEPARATOR.test(line)) {
        blocks.push(current.join('\n'));
        current = [];
      } else {
        current.push(line);
      }
    }
    blocks.push(current.join('\n'));
    return blocks.filter((b) => b.trim() !== '');
  }

  function tidy(text) {
    return String(text).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  function uniqueCI(list) {
    const seen = new Set();
    const out = [];
    for (const value of list) {
      const key = value.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        out.push(value);
      }
    }
    return out;
  }

  function parseBlock(text) {
    const warnings = [];
    const sections = { title: [], description: [], captions: [], tags: [], instagram: [] };
    const loose = [];
    let current = null;

    for (const line of String(text || '').split(/\r?\n/)) {
      let labelled = false;
      for (const { key, re } of LABELS) {
        const match = line.match(re);
        if (match) {
          current = key;
          sections[key].push(match[1]);
          labelled = true;
          break;
        }
      }
      if (labelled) continue;
      // Title and tags are one line each; anything under them is description text.
      if (current === null || current === 'title' || current === 'tags') loose.push(line);
      else sections[current].push(line);
    }

    let looseLines = loose.slice();
    let title = sections.title.map((l) => l.trim()).find((l) => l !== '') || '';
    if (!title) {
      const idx = looseLines.findIndex((l) => l.trim() !== '');
      if (idx >= 0) {
        title = looseLines[idx].trim();
        looseLines = looseLines.slice(idx + 1);
        warnings.push('no Title label: the first line is used as the title');
      }
    }

    title = title.replace(/\s+/g, ' ').trim();
    if (/[<>]/.test(title)) {
      title = title.replace(/[<>]/g, '');
      warnings.push('removed < and > from the title (YouTube refuses them)');
    }
    const titleChars = Array.from(title);
    if (titleChars.length > YT_TITLE_MAX) {
      title = titleChars.slice(0, YT_TITLE_MAX).join('').trim();
      warnings.push(`title cut to ${YT_TITLE_MAX} characters`);
    }
    if (!title) warnings.push('no title found');

    const description = tidy([...sections.description, ...looseLines].join('\n'));
    const instagramCaption = tidy(sections.instagram.join('\n'));
    const youtubeCaptions = tidy(sections.captions.join('\n'));
    if (new TextEncoder().encode(description).length > YT_DESCRIPTION_MAX_BYTES) {
      warnings.push('description is over 5000 bytes (YouTube limit)');
    }
    if (Array.from(instagramCaption).length > IG_CAPTION_MAX) {
      warnings.push('Instagram caption is over 2,200 characters');
    }

    const hashtags = uniqueCI(
      ([title, description, instagramCaption, sections.tags.join(' ')].join(' ').match(HASHTAG) || [])
    );

    const explicitTags = tidy(sections.tags.join(','))
      .split(',')
      .map((t) => t.trim().replace(/^#/, ''))
      .filter(Boolean);
    const candidateTags = uniqueCI([...explicitTags, ...hashtags.map((h) => h.slice(1))]);
    const tags = [];
    let total = 0;
    for (const tag of candidateTags) {
      const cost = tag.length + (tags.length ? 1 : 0);
      if (total + cost > YT_TAGS_MAX_CHARS) {
        warnings.push('some tags dropped: YouTube allows 500 characters of tags in total');
        break;
      }
      tags.push(tag);
      total += cost;
    }

    return { title, description, hashtags, instagramCaption, youtubeCaptions, tags, warnings };
  }

  return {
    LIMITS: { YT_TITLE_MAX, YT_DESCRIPTION_MAX_BYTES, YT_TAGS_MAX_CHARS, IG_CAPTION_MAX },
    splitBlocks,
    parseBlock,
  };
});
