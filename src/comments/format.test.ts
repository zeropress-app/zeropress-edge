import { describe, expect, it } from 'vitest';
import { formatCommentListItems } from './format';
import type { CommentData } from './types';

function format(content: string, imported: CommentData['imported'] = 1): string {
  return formatCommentListItems([{
    id: 'synthetic-comment', public_id: 1, target_id: 1, parent_public_id: null,
    author_name: 'Reader', author_kind: 'guest', content, status: 'approved',
    imported, created_at: '2026-09-22T00:00:00Z',
  }])[0].content_text;
}

describe('imported comment text', () => {
  it('preserves paragraphs, list breaks, Unicode and a single break after br', () => {
    expect(format('<p>First<br />\nsecond<br class="line">\r\nthird</p><div>© 👩‍💻</div><ul><li>One</li><li>Two</li></ul>'))
      .toBe('First\nsecond\nthird\n\n© 👩‍💻\n\nOne\nTwo');
  });

  it.each([
    ['<p><span title="1 > 0">Example</span></p>', 'Example'],
    ['A<!-- internal > not visible --><em>B</em>C', 'ABC'],
    ['Example<script', 'Example'],
    ['<p>before<script>hidden()</script><style>.hidden { color: red }</style><template>hidden</template>after</p>', 'beforeafter'],
  ])('extracts text from HTML without exposing markup: %s', (input, expected) => {
    expect(format(input)).toBe(expected);
  });

  it.each([
    ['&amp;lt;b&amp;gt;example&amp;lt;/b&amp;gt;', '&lt;b&gt;example&lt;/b&gt;'],
    ['&#38;lt;b&#38;gt;example&#38;lt;/b&#38;gt;', '&lt;b&gt;example&lt;/b&gt;'],
    ['&#x26;amp; &#38;#x3c; &amp;#65;', '&amp; &#x3c; &#65;'],
    ['&lt;img src=x onerror=example&gt;', '<img src=x onerror=example>'],
    ['&copy; &#169; &#x1F60A; &nbsp; &quot; &apos;', '© © 😊   " \''],
    ['&#0; &#xD800; &#1114112;', '\uFFFD \uFFFD \uFFFD'],
  ])('decodes each original entity once: %s', (input, expected) => {
    expect(format(`<p>${input}</p>`)).toBe(expected);
  });

  it('keeps text within deeply nested imported elements', () => {
    expect(format(`${'<span>'.repeat(2000)}Example${'</span>'.repeat(2000)}`)).toBe('Example');
  });

  it.each([0, false, null])('preserves literal markup and entities in native comments with imported=%s', (imported) => {
    const input = '<b>literal</b> &amp; &#65; 👩‍💻';
    expect(format(input, imported)).toBe(input);
  });
});
