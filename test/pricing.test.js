import test from 'node:test';
import assert from 'node:assert/strict';
import { HOURLY_CENTS, MAX_HOURS, priceForHour, quote, nextHourPrice } from '../src/pricing.js';

test('tabela de preços: 7, 6, 5, 4', () => {
  assert.deepEqual([...HOURLY_CENTS], [700, 600, 500, 400]);
  assert.equal(MAX_HOURS, 4);
  assert.equal(priceForHour(0), 700);
  assert.equal(priceForHour(3), 400);
  assert.equal(priceForHour(4), null);
});

test('pacote de 1h custa R$ 7', () => {
  const q = quote(0, 1);
  assert.equal(q.ok, true);
  assert.equal(q.amountCents, 700);
  assert.equal(q.totalHoursAfter, 1);
});

test('pacote de 4h custa R$ 22', () => {
  const q = quote(0, 4);
  assert.equal(q.ok, true);
  assert.equal(q.amountCents, 2200);
  assert.deepEqual(q.breakdown.map((b) => b.cents), [700, 600, 500, 400]);
});

test('hora adicional usa o degrau correto', () => {
  assert.equal(nextHourPrice(0), 700);
  assert.equal(nextHourPrice(1), 600);
  assert.equal(quote(1, 1).amountCents, 600);
  assert.equal(quote(2, 1).amountCents, 500);
  assert.equal(quote(3, 1).amountCents, 400);
  assert.equal(quote(2, 2).amountCents, 900);
});

test('não passa de 4 horas', () => {
  const q = quote(3, 2);
  assert.equal(q.ok, false);
  assert.equal(q.code, 'max_hours');
  assert.equal(q.maxExtra, 1);
  assert.equal(quote(4, 1).ok, false);
});

test('quantidade inválida é rejeitada', () => {
  assert.equal(quote(0, 0).ok, false);
  assert.equal(quote(0, -1).ok, false);
  assert.equal(quote(0, 2.7).ok, true);
  assert.equal(quote(0, 2.7).totalHoursAfter, 2);
});
