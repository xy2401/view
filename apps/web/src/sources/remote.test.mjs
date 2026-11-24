import assert from 'node:assert/strict'
import test from 'node:test'
import { directChild, isSafeDavPath, normalizeRemoteUrl } from './remote.ts'

test('directory addresses keep their encoding and drop fragments', () => {
  const root = normalizeRemoteUrl('https://example.org/私人/100%25?view=1#ignore')
  assert.equal(root, 'https://example.org/%E7%A7%81%E4%BA%BA/100%25/?view=1')
  assert.throws(() => normalizeRemoteUrl('https://user@example.org/private/'))
  assert.throws(() => normalizeRemoteUrl('data:text/plain,notes'))
})

test('autoindex and WebDAV accept only direct children inside the listed directory', () => {
  const directory = new URL('https://example.org/private/')
  for (const href of ['../', '?sort=name', '/private-backup/report', 'nested/report', 'a%2Fb', '//other.test/private/a']) {
    assert.equal(directChild(href, directory), null)
  }
  for (const name of ['照片 100%.png', 'what?#.pdf', 'é音频.mp3', 'a%2Fb.txt']) {
    const href = encodeURIComponent(name)
    assert.equal(directChild(href, directory)?.href, directory.href + href)
  }
  assert.equal(directChild('相册/', directory)?.href, directory.href + '%E7%9B%B8%E5%86%8C/')
  assert.equal(normalizeRemoteUrl(directory.href + 'catalog%252Fa'), directory.href + 'catalog%252Fa/')
})

test('authenticated WebDAV scope excludes ambiguous path encodings', () => {
  for (const segment of ['a%2Fb', 'a%255Cb', '%252e%252e', 'a%2500b', '%25252F']) {
    assert.equal(isSafeDavPath('/private/' + segment + '/'), false)
  }
  assert.equal(isSafeDavPath('/private/' + encodeURIComponent('旅行 100%#?.txt')), true)
})
