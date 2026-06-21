'use strict';

function digestMessage(text: string, maxLen = 250): string {
  if (!text) return '';
  return text
    .replace(/([a-zA-Z]:)?[/\\][a-zA-Z0-9_/\\.\-]{4,}/g, '<path>')
    .replace(/\b[A-Z0-9]{12,}\b/g, '<token>')
    .replace(/\s+/g, ' ')
    .slice(0, maxLen)
    .trim();
}

module.exports = { digestMessage };
