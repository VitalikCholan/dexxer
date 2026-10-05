// app/test/favorites.test.ts — favourites: parse, toggle, chips.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { favoritesWritable, parseFavorites, toggleFavorite } from '../src/lib/favorites'

test('parseFavorites: a JSON array of valid symbols, anything else is empty', () => {
  assert.deepEqual(parseFavorites('["BTC","ETH"]'), ['BTC', 'ETH'])
  assert.deepEqual(parseFavorites(null), [])
  assert.deepEqual(parseFavorites('not json'), [])
  assert.deepEqual(parseFavorites('{"a":1}'), [])
  assert.deepEqual(parseFavorites('["BTC", 7, "eth", "TOOLONGSYM", "BTC"]'), ['BTC']) // invalid and duplicate entries dropped
})

test('toggleFavorite: appends in starring order, removes when present', () => {
  assert.deepEqual(toggleFavorite([], 'BTC'), ['BTC'])
  assert.deepEqual(toggleFavorite(['BTC'], 'ETH'), ['BTC', 'ETH'])
  assert.deepEqual(toggleFavorite(['BTC', 'ETH'], 'BTC'), ['ETH'])
})

test('favoritesWritable: only an empty slot or a parsed array may be overwritten', () => {
  assert.equal(favoritesWritable(null), true)
  assert.equal(favoritesWritable('["BTC"]'), true)
  assert.equal(favoritesWritable('[]'), true)
  assert.equal(favoritesWritable('not json'), false)
  assert.equal(favoritesWritable('{"a":1}'), false)
})
