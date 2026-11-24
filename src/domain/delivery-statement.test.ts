import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contradictoryDeliveryLine, exactDeliveryStatement } from './delivery-statement.js';

test('a status belongs to the same explicit item across sentence and row boundaries', () => {
  const item = 'Anchor layout';
  const quote = `Inventory | ${item} not delivered`;
  for (const separator of [' | ', '. ', '! ', '? ', '\n', '\r\n', '… ', ' but ']) {
    const conflict = quote + separator + `${item} delivered`;
    assert.equal(exactDeliveryStatement(conflict, item, 'delivered'), true, conflict);
    assert.equal(contradictoryDeliveryLine(conflict, item), true, conflict);
    const different = quote + separator + 'Supplemental Anchor layout delivered';
    assert.equal(contradictoryDeliveryLine(different, item), false, different);
  }
  assert.equal(contradictoryDeliveryLine(`${quote} ${item} delivered`, item), true);
  assert.equal(contradictoryDeliveryLine('Опись | Схема анкеров не передана. Схема анкеров получена.', 'Схема анкеров'), true);
  assert.equal(contradictoryDeliveryLine('Опись | Схема анкеров не передана. Опись крепежа получена.', 'Схема анкеров'), false);
});

test('an affirmative reference holds if it refers to this item or the antecedent is unclear', () => {
  const item = 'Anchor layout';
  const quote = `Inventory | ${item} not supplied`;
  for (const suffix of ['. It was supplied.', '\nIt was supplied', '. The same item was supplied.',
    '. Confirmation pending. It was supplied.', '. A drawing delivered. It was supplied.']) {
    assert.equal(contradictoryDeliveryLine(quote + suffix, item), true, suffix);
  }
  assert.equal(contradictoryDeliveryLine(quote + '. Seal schedule was received. It was supplied.', item), false);
  assert.equal(contradictoryDeliveryLine(quote, item), false);
});

test('a conjunction inside the exact item belongs to its name until the predicate', () => {
  const item = 'Схема и паспорт';
  const negative = `${item} не переданы`;
  assert.equal(exactDeliveryStatement(negative, item, 'not_delivered'), true);
  assert.equal(exactDeliveryStatement(negative, 'паспорт', 'not_delivered'), false);
  const nearby = `Расчёт передан, а ${negative} и План поставлен`;
  assert.equal(exactDeliveryStatement(nearby, item, 'not_delivered'), true);
  assert.equal(contradictoryDeliveryLine(nearby, item), false);
  assert.equal(contradictoryDeliveryLine(`${negative} и ${item} переданы`, item), true);
  assert.equal(contradictoryDeliveryLine(`${negative}. Они были переданы.`, item), true);
});
