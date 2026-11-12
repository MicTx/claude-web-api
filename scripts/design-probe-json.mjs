export function parseStrictJson(bytes, { rejectPrototypeKeys = false } = {}) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const value = JSON.parse(text);
  let position = 0;
  const whitespace = () => { while (/\s/u.test(text[position] ?? '') && position < text.length) position++; };
  const string = () => {
    const start = position++;
    while (position < text.length) {
      if (text[position] === '\\') position += 2;
      else if (text[position++] === '"') break;
    }
    return JSON.parse(text.slice(start, position));
  };
  const parseValue = depth => {
    if (depth > 16) throw new Error('Invalid JSON');
    whitespace();
    if (text[position] === '{') {
      position++;
      whitespace();
      const keys = new Set();
      while (text[position] !== '}') {
        const key = string();
        if (keys.has(key) || (rejectPrototypeKeys && ['__proto__', 'constructor', 'prototype'].includes(key))) throw new Error('Invalid JSON');
        keys.add(key);
        whitespace();
        position++;
        parseValue(depth + 1);
        whitespace();
        if (text[position] === ',') { position++; whitespace(); } else break;
      }
      position++;
    } else if (text[position] === '[') {
      position++;
      whitespace();
      while (text[position] !== ']') {
        parseValue(depth + 1);
        whitespace();
        if (text[position] === ',') { position++; whitespace(); } else break;
      }
      position++;
    } else if (text[position] === '"') string();
    else while (position < text.length && !/[\s,}\]]/u.test(text[position])) position++;
  };
  parseValue(0);
  return value;
}
