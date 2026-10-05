// app/test/favorites.test.ts — favourites: parse, toggle, chips.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_CHIPS, chipSymbols, parseFavorites, toggleFavorite } from '../src/lib/favorites'

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

test('chipSymbols: favourites in the registry, starring order, at most 5', () => {
  assert.equal(MAX_CHIPS, 5)
  const registry = ['SOL', 'BTC', 'ETH', 'HYPE', 'ZEC', 'A', 'B']
  assert.deepEqual(chipSymbols(['ZEC', 'GONE', 'BTC'], registry), ['ZEC', 'BTC']) // delisted skipped
  assert.deepEqual(chipSymbols(['A', 'B', 'SOL', 'BTC', 'ETH', 'HYPE'], registry), ['A', 'B', 'SOL', 'BTC', 'ETH'])
  assert.deepEqual(chipSymbols([], registry), [])
})
