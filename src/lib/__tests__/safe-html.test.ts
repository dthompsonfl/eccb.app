import { describe, it, expect } from 'vitest';
import { sanitizeHtml } from '../safe-html';

describe('sanitizeHtml', () => {
  it('should allow safe tags', () => {
    const input = '<h1>Title</h1><p>Paragraph with <strong>bold</strong> and <em>italic</em>.</p>';
    const output = sanitizeHtml(input);
    expect(output).toBe(input);
  });

  it('should strip script tags', () => {
    const input = '<div>Safe</div><script>alert("XSS")</script>';
    const output = sanitizeHtml(input);
    expect(output).toBe('<div>Safe</div>');
  });

  it('should strip event handlers', () => {
    const input = '<img src="x" onerror="alert(1)">';
    const output = sanitizeHtml(input);
    expect(output).toBe('<img src="x">');
  });

  it('should strip javascript URIs', () => {
    const input = '<a href="javascript:alert(1)">Click me</a>';
    const output = sanitizeHtml(input);
    expect(output).toBe('<a>Click me</a>');
  });

  it('should allow safe attributes', () => {
    const input = '<a href="https://example.com" title="Example">Link</a>';
    const output = sanitizeHtml(input);
    expect(output).toBe(input);
  });

  it('should strip style attributes (not in whitelist)', () => {
    const input = '<div style="color: red;">Red text</div>';
    const output = sanitizeHtml(input);
    expect(output).toBe('<div>Red text</div>');
  });

  it('should handle nested malicious tags', () => {
    const input = '<div><p><script>alert(1)</script></p></div>';
    const output = sanitizeHtml(input);
    expect(output).toBe('<div><p></p></div>');
  });
});
