import assert from 'node:assert/strict';
import { test } from 'node:test';
import { packageCommonGrounded, packageNonDeliveryGrounded } from './package-observation.js';
import type { ObservationInput } from './contracts.js';

const item = 'Теплотехнический расчёт';
const input = (quote: string): Omit<ObservationInput, 'evidence'> => ({
  quote, deliveryStatement: { status: 'not_delivered', item },
  package: { role: { value: 'inventory', quote: 'Опись' } },
});

test('package non-delivery requires the referenced item to govern the negative predicate', () => {
  assert.equal(packageNonDeliveryGrounded(input('Опись | Теплотехнический расчёт передан | Паспорт не передан'), false), false);
  assert.equal(packageNonDeliveryGrounded(input('Опись | Теплотехнический расчёт передан, а Паспорт не передан'), false), false);
  assert.equal(packageNonDeliveryGrounded(input('Опись | Теплотехнический расчёт — не передан'), false), true);
  assert.equal(packageNonDeliveryGrounded(input('Опись | не передан Теплотехнический расчёт'), false), true);
  assert.equal(packageNonDeliveryGrounded(input('Опись | не передан Теплотехнический расчёт'), true), false);
  assert.equal(packageNonDeliveryGrounded(input('Опись | не передан Теплотехнический расчёт'), false,
    'Опись | не передан Теплотехнический расчёт | Теплотехнический расчёт передан'), false);
  assert.equal(packageNonDeliveryGrounded(input('Опись | Теплотехнический расчёт не передан'), false,
    'Опись | Теплотехнический расчёт не передан, но теплотехнический расчёт передан'), false);
  assert.equal(packageNonDeliveryGrounded(input('Опись | Теплотехнический расчёт не передан'), false,
    'Опись | Теплотехнический расчёт не передан и передан'), false);
  assert.equal(packageNonDeliveryGrounded(input('Опись | Теплотехнический расчёт не передан'), false,
    'Опись | Теплотехнический расчёт не передан, но Паспорт передан'), true);
});

test('common materials require a positive statement that covers the entire building', () => {
  assert.equal(packageCommonGrounded('Specification | applies to all facades'), true);
  assert.equal(packageCommonGrounded('Does not apply to all facades'), false);
  assert.equal(packageCommonGrounded('For all facades except the curved bay'), false);
  assert.equal(packageCommonGrounded('List of all facades'), false);
});
